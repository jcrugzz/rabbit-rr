
var EE = require('events').EventEmitter;
var util = require('util');
var amqp = require('amqplib/callback_api');
var sockets = require('./socket');

module.exports = Rabbit;

function Rabbit(options) {
  if (!(this instanceof Rabbit)) return new Rabbit(options);
  EE.call(this);
  options = options || {};

  if (typeof options === 'string') {
    this.url = options;
    options = {};
  }

  this.options = options;
  this.url = this.url || options.url;
  this.connected = false;
  this.ready = false;
  this.connect();

}

util.inherits(Rabbit, EE);

Rabbit.prototype.connect = function () {
  amqp.connect(this.url, this.options, this._onConnect.bind(this));
  return this;
};

Rabbit.prototype._onConnect = function (err, conn) {
  if (err) return this.emit('error', err);

  this.connected = true;
  this.connection = conn;
  this.emit('connect', this.connection);

  // Proxy events that might matter
  ['close', 'blocked', 'unblocked', 'error'].forEach(function (ev) {
    this.connection.on(ev, this.emit.bind(this, ev));
  }, this);

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

Rabbit.prototype._onChannel = function (err, ch) {
  if (err) return this.emit('error', err);
  this.channel = ch;
  this.emit('ready', ch);


};

Rabbit.prototype.socket = function (type, options) {
  var Socket = sockets[type];
  if (!Socket) {
    var error = new Error('Invalid socket type');
    return process.nextTick(this.emit.bind(this, 'error', error));
  }
  return new Socket(this, options);
};

Rabbit.prototype.close = function () {
  this.connection.close();
};

