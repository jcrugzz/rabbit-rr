
var EE = require('events').EventEmitter;
var util = require('util');
var debug = require('diagnostics')('rabbit-rr:socket');
var uuid = require('uuid');

var noop = function () {};

var TYPES = ['req', 'rep', 'REQ', 'REP'];

var SOCKETS = TYPES.reduce(function (acc, type) {
  acc[type] = type.toLowerCase() === 'req'
    ? ReqSocket
    : RepSocket;

  return acc;
}, {});

module.exports = SOCKETS;

util.inherits(Socket, EE);

function Socket (rabbit, options) {
  EE.call(this);
  this.rabbit = rabbit;
  this.options = options || {};

  // Only try and defer connect because send makes things way complicated right
  // now
  this.channel = undefined;
  // Operations called potentially before a channel exists
  this.operations = this.methods.reduce(function(acc, method) {
    acc[method] = [];
    return acc;
  }, {});
  //
  // So we can probably still grab the methods off the prototype even af
  //
  this.ready = false;

  if(!this.rabbit.ready) {
    this._deferMethods();
    this.rabbit.once('ready', this._setup.bind(this));
  } else {
    this._setChannel(this.rabbit.channel);
  }
}

Socket.prototype._deferMethods = function () {
  var self = this;
  this.methods.forEach(function(method) {
    self[method] = function () {
      self._operation(method, arguments);
      return self;
    }
  });
};

Socket.prototype._operation = function (method, args) {
  if (this.channel && this.ready && method === 'connect') {
    return this[method].apply(this, args);
  }
  this.operations[method].push({ method: method, args: args });
};

Socket.prototype._setup = function (channel) {
  this._setChannel(channel);
  this._runDeferred('connect');
  this.emit('ready');
  this.ready = true;
};

Socket.prototype._runDeferred = function (method) {
  delete this[method];
  var op;
  while((op = this.operations[method].shift())) {
   debug('running deferred operation %s with args %j', op.method, op.args);
   this[op.method].apply(this, op.args)
  }
};

Socket.prototype._setChannel = function (channel) {
  debug('channel is set on the %s socket instance', this.type);
  this.channel = channel;

  this.channel.on('error', this.emit.bind(this, 'error'));
  //
  // TODO: Do we have to cleanup anything?
  //
  this.channel.on('close', this.emit.bind(this, 'close'));
  //
  // These aren't strictly necessary but could be interesting to look at maybe?
  //
  this.channel.on('drain', this.emit.bind(this, 'drain'));
  this.channel.on('readable', this.emit.bind(this, 'readable'));
};

Socket.prototype.close =
Socket.prototype.end = function () {
  this.channel.close();
};

Socket.prototype.parse = function (content) {
  var message;

  try { message = JSON.parse(content); }
  catch (ex) { console.log(ex); message = undefined; }

  if (!message) this.emit('parse error', content);
  return message;
};

Socket.prototype.pack = function (message) {
  if (Buffer.isBuffer(message)) return message;
  if (typeof message === 'string') return new Buffer(message, 'utf8');
  else return new Buffer(JSON.stringify(message), 'utf8');
};

//
// Specific sockets and methods
//
util.inherits(RepSocket, Socket);

function RepSocket() {
  this.type = 'REP';
  this.methods = ['connect'];
  Socket.apply(this, arguments);

  this.consumers = {};
}

RepSocket.prototype.connect = function (source, callback) {
  var self = this;
  if (this.consumers[source]) {
    return process.nextTick(callback || noop);
  }

  this.channel.assertQueue(source, { durable: this.options.persistent }, function (err, ok) {
    if (err) return callback ? callback(err) : self.emit('error', err);
    self.channel.consume(source, self._consume.bind(self), { noAck: false });
    self.consumers[source] = ok.consumerTag;
    self.emit('connect', source);
    callback && callback();
  });

  return this;
};

RepSocket.prototype._consume = function (msg) {
  var self = this;
  debug('Rep socket received message %j', msg);
  if (msg === null) return;

  var id = msg.properties.correlationId;
  var payload = this.parse(msg.content);
  if (!payload) return debug('unparsable payload');

  this.emit('message', payload, reply);

  function reply(err, data) {
    debug('rep socket reply being executed');
    if (err) {
      //
      // Remark: This is something weird TBH as it shouldn't happen
      // But we should keep with callback convention and send errors back in some way
      // jsut in case.
      //
      self.emit('application error', err);
      data = { success: false, message: err.message };
    }

    var replyTo = msg.properties.replyTo;
    //
    // Remark: Replies are never persistent because the queue is ephemeral and dies
    // with the socket. Note, maybe we can make a different topology than this
    // but this seems reasonable and is simple
    //
    var options = {
      deliveryMode: true,
      expiration: self.options.expiration,
      correlationId: id
    };

    var res = self.channel.sendToQueue(replyTo, self.pack(data), options);
    //
    // Remark: We ack the message after its processed to let rabbit know whats up
    //
    self.channel.ack(msg);

    return res;
  }

};

util.inherits(ReqSocket, Socket);

function ReqSocket () {
  this.type = 'REQ';
  this.methods = ['connect', 'send'];
  Socket.apply(this, arguments);

  this.replyTo = undefined;
  this.rx = 0;
  this.queues = [];
  this.callbacks = {};

  if (this.ready && this.channel)
    this._setupConsumer();
  else
    this.once('ready', this._setupConsumer.bind(this));
}

ReqSocket.prototype._setupConsumer = function () {
  var self = this;
  //
  // Remark: We create an ephemeral reply queue here to receive messages on
  //
  this.channel.assertQueue('', {exclusive: true, autoDelete: true }, function (err, ok) {
    if (err) { return self.emit('error', err); }
    self.replyTo = ok.queue;
    self._canMaybeSend();
    self.channel.consume(ok.queue, self._consume.bind(self), { noAck: false, exclusive: true });
  });
};

ReqSocket.prototype._canMaybeSend = function () {
  debug('canMaybeSend called');
  if (!this.replyTo || !this.queues.length) return;
  this._runDeferred('send');
};

ReqSocket.prototype._consume = function (msg) {
  if (msg === null) return;
  debug('Req socket received reply over ephemeral queue %s %j', this.replyTo, msg);
  this.reply(msg);
  this.channel.ack(msg);
};

ReqSocket.prototype.reply = function (msg) {
  var id = msg.properties.correlationId;
  var fn = this.callbacks[id];
  if (!fn) return debug('missing callback for %s', id);

  var message = this.parse(msg.content);
  //
  // Remark: since we can't really error should we just respond with the message?
  //
  fn(null, message);
  delete this.callbacks[id];
};

ReqSocket.prototype.connect = function (destination, callback) {
  var self = this;

  this.channel.assertQueue(destination,
    { durable: this.options.persistent }, function (err, ok) {
    if (err) return callback ? callback(err) : self.emit('error', err);
    self.queues.push(ok.queue);
    self._canMaybeSend();
    self.emit('connect');
    callback && callback();
  });

  return this;
};

ReqSocket.prototype.id = function () {
  return uuid();
};

//
// Remark: Im assuming object serialization here but in the future this could
// be more flexible
//
ReqSocket.prototype.send = function (message, callback) {
  //
  // Remark: Simple round-robin without array mutation
  // if we have more than one queue to send to
  //
  if (this.rx >= this.queues.length) this.rx = 0;
  var queue = this.queues[this.rx++];

  //
  // Remark: maybe queue messages to send here?
  // In practice ill see if the current defer logic breaks and
  // add that here if necessary
  //
  if (!queue) return debug('No queue on send with message %j', message);
  var id = callback.id = this.id();
  this.callbacks[id] = callback;

  debug('req socket sending message %j to queue %s with replyTo %s ', message, queue, this.replyTo);
  var options = {
    replyTo: this.replyTo,
    deliveryMode: true,
    correlationId: id,
    expiration: this.options.expiration,
    persistent: this.options.persistent
  };

  this.channel.sendToQueue(queue, this.pack(message), options);

  return this;
};


