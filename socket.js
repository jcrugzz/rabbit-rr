
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

  this._deferredConnections = [];

  //
  // When we disconnect we gotta re-defer methods and setup reconnection to our
  // queues post
  //
  this.reconnecting = false;
  this.rabbit.on('reconnect', function () {
    this.reconnecting = true;
    this.initialize();
  }.bind(this));

  this.initialize();
}

Socket.prototype.initialize = function () {
  this.channel = undefined;

  this.ready = false;

  if (!this.rabbit.connected) {
    debug('set up ready listener for %s', this.type);

    //
    // Reduce the number of listeners that can be assigned so we ensure this
    // only happens once when there are many potential reconnect events that
    // trigger this block
    //
    if (this.rabbit.listeners('__ready__').length >= 1) return;
    this.rabbit.once('__ready__', this._setup.bind(this));
  } else {
    this._setup(this.rabbit.channel);
  }

};

Socket.prototype._setup = function (channel) {
  debug('%s socket setup', this.type);
  this._setChannel(channel);
  this.ready = true;
  this.emit('ready');
  if (!this._deferredConnections.length) return;

  debug('Running deferred connects %s', this._deferredConnections);
  this.connectAll(this._deferredConnections);

  //
  // Reset array after connecting
  //
  this._deferredConnections = [];

};

Socket.prototype.connectAll = function (queues) {
  //
  // Connect to call queues that were deferred
  //
  for (var i = 0; i < queues.length; i++) {
    this.connect(queues[i]);
  }
};

Socket.prototype._setChannel = function (channel) {
  debug('channel is set on the %s socket instance', this.type);
  this.channel = channel;
  if (this.options.prefetch) {
    debug('set prefetch');
    this.channel.prefetch(this.options.prefetch);
  }

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
  catch (ex) {
    debug('json parse exception %s', ex);
    message = undefined;
  }

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

  this.consumers = {};

  //
  // Handle reconnecting
  //
  this.on('ready', function () {
    if (!this.reconnecting) { return; }
    var sources = Object.keys(this.consumers);
    debug('Rep on Ready reconnect %j', sources);
    this.consumers = {};
    this.connectAll(sources);
  }.bind(this));

  Socket.apply(this, arguments);

}

RepSocket.prototype.connect = function (source) {
  debug('REP socket connect called %s', source)
  if (!this.ready) {
    debug('rep socket defer connection %s', source);
    this._deferredConnections.push(source);
    return this;
  }

  if (this.consumers[source]) {
    return this;
  }
  debug('rep socket executing connect %s', source);
  var self = this;
  this.channel.assertQueue(source, { durable: this.options.persistent }, function (err, ok) {
    debug('REP socket connected %s', source);
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
    debug('rep socket reply being executed %j', msg);
    if (err) {
      self.emit('application error', err);
      data = { __error: true, message: err.message };
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
    // Note that doing this step last means messages which kill the receiver will be trapped in the queue
    self.channel.ack(msg);

    return res;
  }

};

util.inherits(ReqSocket, Socket);

function ReqSocket () {
  this.type = 'REQ';
  this.methods = ['connect', 'send'];

  Socket.apply(this, arguments);

  this.rabbit.on('reconnect', function () {
    this._isConnected = false;
    this._responseQueueIsConnected = false;
  }.bind(this));

  this._readyCalled = false;
  this._replyTo = undefined;
  this._rx = 0;
  this._callbacks = {};

  this._deferredSends = [];
  this._dests = [];
  this._queues = [];


  if (this.ready && this.channel) {
    debug('%s channel ready, setting up response queue', this.type);
    this._onReady();
  } else {
    debug('%s channel waiting on ready', this.type);
    this.on('ready', this._onReady.bind(this));
  }

};

ReqSocket.prototype._canSend = function () {
  return this._isConnected && this._responseQueueIsConnected;
};

ReqSocket.prototype._trySendDeferredMessages = function () {
  if (!this._canSend()) return;

  for (var i = 0; i < this._deferredSends.length; i++) {
    var message = this._deferredSends[i];
    this._sendNow(message.message, message.id);
  }

  this._deferredSends = [];
};

//
// When we are reconnecting we need to reconnect to our queues on the new
// channel
//
ReqSocket.prototype._onReady = function () {
  debug('req socket on ready')
  if (!this.reconnecting) return this._setupResponseQueue();

  this._setupResponseQueue()
  //
  // We might want to do something about the callbacks here as well since they
  // will never get responses. Do we assume them as done or use some sort of
  // timeout mechanism?
  //
  var dests = this._dests;
  this._queues = [];
  this._dests = [];
  debug('reconnecting to %j', dests);
  this.connectAll(dests);
};
ReqSocket.prototype._setupResponseQueue = function () {
  debug('setup consumer req');
  var self = this;
  // Messages sent by the responder will be delivered on this queue
  this.channel.assertQueue('', { exclusive: true, autoDelete: true }, function (err, ok) {
    if (err) { return void self.emit('error', err); }
    self._replyTo = ok.queue;
    debug('reply queue asserted %s %j', err, ok);
    self.channel.consume(ok.queue, self._consume.bind(self), { noAck: false, exclusive: true });
    self._responseQueueIsConnected = true;
    self._trySendDeferredMessages();
  });
};

ReqSocket.prototype._consume = function (msg) {
  if (msg === null) return debug('Req socket msg received is null');
  debug('Req socket received reply over ephemeral queue %s', this._replyTo);
  this._handleReceipt(msg);
  this.channel.ack(msg);
};

ReqSocket.prototype._handleReceipt = function (msg) {
  var id = msg.properties.correlationId;
  var fn = this._callbacks[id];

  // This means that we can fire and forget messages. Is this an intentional feature, or should
  // this indicate that something went wrong?
  if (!fn) return debug('missing callback for %s', id);

  var message = this.parse(msg.content);

  delete this._callbacks[id];

  //
  // Remark: since we can't really error should we just respond with the message?
  //
  if (message.__error && message.message) {
    var error = new Error(message.message);
    return fn(error);
  }

  fn(null, message);
};

ReqSocket.prototype.connect = function (destination) {
  debug('req socket connect called %s', destination);
  if (!this.ready) {
    debug('deferring connect %s', destination);
    this._deferredConnections.push(destination);
    return this;
  }
  debug('executing connect %s', destination);
  var self = this;
  this._dests.push(destination);
  this.channel.assertQueue(destination,
    { durable: this.options.persistent }, function (err, ok) {
      debug('req socket send queue connected %s', destination);
      if (err) return void self.emit('error', err);
      self._queues.push(ok.queue);
      self._isConnected = true;
      self._trySendDeferredMessages();
      self.emit('connect');
    });

  return this;
};

ReqSocket.prototype.id = function () {
  return uuid();
};

ReqSocket.prototype._roundRobin = function () {
  if (this._rx >= this._queues.length) this._rx = 0;
  return this._queues[this._rx++];
};

ReqSocket.prototype._sendNow = function (message, id) {
  var queue = this._roundRobin();
  if (!queue) return debug('No queue on send with message %j', message);

  debug('req socket sending message %j to queue %s with replyTo %s ', message, queue, this._replyTo);
  var options = {
    replyTo: this._replyTo,
    deliveryMode: true,
    correlationId: id,
    expiration: this.options.expiration,
    persistent: this.options.persistent
  };

  this.channel.sendToQueue(queue, this.pack(message), options);
};

ReqSocket.prototype.send = function (message, callback) {
  var id = callback.id = this.id();
  this._callbacks[id] = callback;

  if (!this._canSend()) {
    this._deferredSends.push({ message: message, id: id });
    return this;
  }

  this._sendNow(message, id);

  return this;
};

