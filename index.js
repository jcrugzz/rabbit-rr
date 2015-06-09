
var EE = require('events').EventEmitter;
var util = require('util');
var Back = require('back');
var url = require('url');
var amqp = require('amqplib/callback_api');
var sockets = require('./socket');
var debug = require('diagnostics')('rabbit-rr:rabbit');

var extend = util._extend;

var backoff = {
  retries: 5,
  minDelay: 10,
  maxDelay: 10000
};

var DEFAULTS = {
  keepAlive: true
};

module.exports = Rabbit;

function Rabbit(options) {
  if (!(this instanceof Rabbit)) return new Rabbit(options);
  EE.call(this);
  options = options || {};

  if (typeof options === 'string') {
    this.url = options;
    options = {};
  }

  this.options = extend(DEFAULTS, options);
  this.url = this.url || options.url || 'amqp://localhost';
  this.parsed = url.parse(this.url);
  this.parsed.query = this.parsed.query || {};

  //
  // This heartbeat is in seconds
  //
  this.heartbeat = options.heartbeat || 5;
  this.connected = false;
  this._backoff = options.backoff || backoff;

  if (this.heartbeat) this.parsed.query.heartbeat = this.heartbeat;

  this.url = url.format(this.parsed);

  this.connect();

}

util.inherits(Rabbit, EE);

Rabbit.prototype.connect = function () {
  amqp.connect(this.url, this.options, this._onConnect.bind(this));
  return this;
};

Rabbit.prototype._onConnect = function (err, conn) {
  if (err) return this.emit('error', err);
  debug('connection established');
  this.connection = conn;
  this.emit('connect', this.connection);

  // Proxy events that might matter
  ['close', 'blocked', 'unblocked'].forEach(function (ev) {
    this.connection.on(ev, this.emit.bind(this, ev));
  }, this);

  this.connection.on('error', this._onError.bind(this, 'connection'));
  //
  // TODO: Maybe support the creation of multiple channels in the future
  // but for now we only need one. This is required when creating multiple
  // sockets from the same rabbit-rr instance in the same process if we want
  // them to have different channels. But strictly separate channels are only
  // used for multiplexing purposes so we can technically intermingle without
  // issue.
  //
  this.connection.createChannel(this._onChannel.bind(this));

};

//
// Try and reconnect on error. We override an in progress reconnection in the
// case where its a connection.
//
Rabbit.prototype._onError = function (type, err) {
  var self = this;
  debug('Error occurred on %s: %s', type, err);
  this.connected = false;
  if (this.reconnecting && type !== 'connection') return;
  if (this.reconnecting && this.attempt) {
    this.attempt.close();
    this.attempt = null;
  }
  this.emit('disconnect');

  this.reconnecting = true;
  var back = this.attempt || new Back(this._backoff);
  return back.backoff(function (fail) {
    if (fail) {
      this.attempt = null;
      self.reconnecting = false;
      return self.emit('error', err);
    }
    if (type === 'connection') self.connect();
    else self.connection.createChannel(self._onChannel.bind(self));
  });
};

Rabbit.prototype._onChannel = function (err, ch) {
  if (err) return this._onError('channel', err);
  debug('channel created')
  this.channel = ch;
  this.reconnecting = false;
  this.connected = true;
  this.attempt = null;

  this.channel.on('error', this._onError.bind(this, 'channel'));
  this.channel.on('close', this.emit.bind(this, 'channel close'));
  this.emit('ready', ch);

};

Rabbit.prototype.socket = function (type, options) {
  var Socket = sockets[type.toLowerCase()];
  if (!Socket) {
    var error = new Error('Invalid socket type');
    return process.nextTick(this.emit.bind(this, 'error', error));
  }
  return new Socket(this, options);
};

Rabbit.prototype.close = function () {
  this.connection.close();
};

