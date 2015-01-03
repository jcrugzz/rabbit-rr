
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

  this.methods = ['connect', 'send'];
  this.channel = undefined;
  // Operations called potentially before a channel exists
  this.operations = [];
  //
  // So we can probably still grab the methods off the prototype even af
  //
  this.ready = false;

  if(!this.rabbit.ready) {
    this._deferMethods();
    this.rabbit.once('ready', this._runDeferred.bind(this));
  } else {
    this._setChannel(this.rabbit.channel);
  }
}

Socket.prototype._deferMethods = function () {
  var self = this;
  this.methods.forEach(function(method) {
    self[method] = function () {
      self._operation(method, arguments);
    }
  });
};

Socket.prototype._operation = function (method, args) {
  if (this.channel && this.ready) {
    return this[method].apply(this, args);
  }
  this.operations.push({ method: method, args: args });
};

Socket.prototype._runDeferred = function (channel) {
  this._setChannel(channel);
  this.methods.forEach(function(method) {
    //
    // Remark: By deleting the method it should properly go back to the prototype
    // version
    //
    delete this[method];
  }, this);

  this.operations.forEach(function(op) {
    this[op.method].apply(this, op.args);
  }, this);

  this.emit('ready');
  this.ready = true;
};

Socket.prototype._setChannel = function (channel) {
  this.channel = channel;
};

Socket.prototype.parse = function (content) {
  var message;

  try { JSON.parse(content); }
  catch (ex) { message = undefined; }

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
  Socket.call(this);

  this.consumers = {};
}

RepSocket.prototype.connect = function (source, callback) {
  var self = this;
  if (this.consumers[source]) {
    return process.nextTick(callback || noop);
  }

  this.channel.assertQueue(source, { durable: this.options.persistent }, function (err, ok) {
    if (err) return callback ? callback(err) : self.emit('error', err);
    this.channel.consume(source, this._consume.bind(this), { noAck: false });
    this.consumers[source] = ok.consumerTag;
    callback && callback();
  });
};

RepSocket.prototype._consume = function (msg) {
  var self = this;
  if (msg === null) return;

  var id = msg.properties.correlationId;
  var payload = this.parse(msg.content);
  if (!payload) return;

  this.emit('message', payload, reply);

  function reply(err, data) {
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
  Socket.call(this);
  this.replyTo = undefined;
  this.rx = 0;
  this.queues = [];
  this.callbacks = {};
  // Remember what
  this.type = {};

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
    self.replyQ = ok.queue;

    self.channel.consume(ok.queue, this._consume.bind(this), { noAck:false, exclusive: true });
  });
};

ReqSocket.prototype._consume = function (msg) {
  if (msg !== null) {
    this.reply(msg);
    //
    // Remark:I guess we have to pre-ack since the queue is ephemeral but
    // I do want more durability here
    //
    return this.channel.ack(msg);
  }
};

ReqSocket.prototype.reply = function (msg) {
  var id = msg.properties.correlationId;
  var fn = this.callbacks[id];
  if (!fn) return debug('missing callback for %s', id);
  //
  // TODO: Support more than this and maybe try / catch for safety
  //
  var message = JSON.parse(msg.content);
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
    self.emit('connect', ok.queue);
    callback && callback();
  });
};

ReqSocket.prototype.id = function () {
  return uuid();
};

//
// Remark: Im assuming object serialization here but in the future this could
// be more flexible
//
ReqSocket.prototype.send = function (message, callback) {
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


