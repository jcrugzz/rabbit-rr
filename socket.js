
var EE = require('events').EventEmitter;
var util = require('util');
var debug = require('diagnostics')('rabbit-rr:socket');
var uuid = require('uuid');

module.exports = {
  req: ReqSocket,
  rep: RepSocket
};

util.inherits(Socket, EE);

function Socket (rabbit, options) {
  EE.call(this);
  this.rabbit = rabbit;
  this.options = options || {};

  this.channel = undefined;
  this.isConnected = false;

  this.ready = false;
  this.deferredConnection = false;

  if(!this.rabbit.ready) {
    this.rabbit.once('ready', this._setup.bind(this));
  } else {
    this._setup(this.rabbit.channel);
  }
}


Socket.prototype._setup = function (channel) {
  this._setChannel(channel);
  this.ready = true;
  this.emit('ready');
  if (this.deferredConnection) {
    var queueName = this.deferredConnection.queueName;
    return void this.connect(queueName);
  }
};

Socket.prototype._setChannel = function (channel) {
  debug('channel is set on the %s socket instance', this.type);
  this.channel = channel;
  if (this.options.prefetch) {
    debug('set prefetch');
    this.channel.prefetch(this.options.prefetch);
  }

  this.channel.on('error', this.emit.bind(this, 'error')); // TODO: Do we have to cleanup anything?

  this.channel.on('close', this.emit.bind(this, 'close'));
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

RepSocket.prototype.connect = function (source) {
  if (!this.ready) {
    this.deferredConnection = { queueName: source };
    return this;
  }

  if (this.consumers[source]) {
    process.nextTick(callback.bind(this, source));
    return this;
  }

  var self = this;
  this.channel.assertQueue(source, { durable: this.options.persistent }, function (err, ok) {
    if (err) return void self.emit('error', err);
    self.channel.consume(source, self._consume.bind(self), { noAck: false });
    self.consumers[source] = ok.consumerTag;
    self.emit('connect', source);
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
    debug('rep socket reply being executed %j', arguments);
    if (err) {
      self.emit('application error', err);
      data = { error: true, message: err.message };
    }

    var replyTo = msg.properties.replyTo;

    // Remark: Replies are never persistent because the queue is ephemeral and dies with the socket.
    var options = {
      deliveryMode: true,
      expiration: self.options.expiration,
      correlationId: id
    };

    var res = self.channel.sendToQueue(replyTo, self.pack(data), options);

    // Ack the message after its processed to let rabbit know whats up
    // Note that doing this last means messages which kill the receiver will be trapped in the queue
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

  this._deferredSends = [];

  if (this.ready && this.channel)
    this._setupConsumer();
  else
    this.once('ready', this._setupConsumer.bind(this));
}

ReqSocket.prototype._sendDeferredMessages = function () {
  this.isConnected = true;

  for (var i = 0; i < this._deferredSends.length; i++) {
    var message = this._deferredSends[i];
    this._sendNow(message.message, message.id);
  }

  this._deferredSends = [];
};

ReqSocket.prototype._setupConsumer = function () {
  var self = this;
  //
  // Remark: We create an ephemeral reply queue here to receive messages on
  //
  this.channel.assertQueue('', { exclusive: true, autoDelete: true }, function (err, ok) {
    if (err) { return void self.emit('error', err); }
    self.replyTo = ok.queue;
    self.channel.consume(ok.queue, self._consume.bind(self), { noAck: false, exclusive: true });
  });
};

ReqSocket.prototype._consume = function (msg) {
  if (msg === null) return debug('Req socket msg received is null');
  debug('Req socket received reply over ephemeral queue %s %j', this.replyTo, msg);
  this._handleReceipt(msg);
  this.channel.ack(msg);
};

ReqSocket.prototype._handleReceipt = function (msg) {
  var id = msg.properties.correlationId;
  var fn = this.callbacks[id];

  // This means that we can fire and forget messages. Is this an intentional feature, or should
  // this indicate that something went wrong?
  if (!fn) return debug('missing callback for %s', id);

  var message = this.parse(msg.content);

  if (message.error && message.message) {
    var error = new Error(message.message);
    fn(error);
    delete this.callbacks[id];
  }
  fn(null, message);
  delete this.callbacks[id];
};

ReqSocket.prototype.connect = function (destination) {
  if (!this.ready) {
    this.deferredConnection = { queueName: destination };
    return this;
  }
  var self = this;

  this.channel.assertQueue(destination,
    { durable: this.options.persistent }, function (err, ok) {
      if (err) return void self.emit('error', err);
      self.queues.push(ok.queue);
      self._sendDeferredMessages();
      self.emit('connect');
    });

  return this;
};

ReqSocket.prototype.id = function () {
  return uuid();
};

ReqSocket.prototype._roundRobin = function () {
  if (this.rx >= this.queues.length) this.rx = 0;
  return this.queues[this.rx++];
};

ReqSocket.prototype._sendNow = function (message, id) {
  var queue = this._roundRobin();
  if (!queue) return debug('No queue on send with message %j', message);
  // we have no queues

  debug('req socket sending message %j to queue %s with replyTo %s ', message, queue, this.replyTo);
  var options = {
    replyTo: this.replyTo,
    deliveryMode: true,
    correlationId: id,
    expiration: this.options.expiration,
    persistent: this.options.persistent
  };

  this.channel.sendToQueue(queue, this.pack(message), options);
};

ReqSocket.prototype.send = function (message, callback) {
  var id = callback.id = this.id();
  this.callbacks[id] = callback;


  if (!this.isConnected) {
    this._deferredSends.push({ message: message, id: id });
    return this;
  }

  this._sendNow(message, id);

  return this;
};


