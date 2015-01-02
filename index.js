
var EE = require('events').EventEmitter;
var util = require('util');
var amqp = require('amqplib/callback_api');
var Socket = require('./socket');

module.exports = Rabbit;

function Rabbit(options) {
  if (!(this instanceof Rabbit)) return new Rabbit(options);
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

Rabbit.prototype.connect = function () {
  amqp.connect(this.url, this.options, this._onConnect.bind(this));
  return this;
};

Rabbit.prototype._onConnect = function (err, conn) {
  if (err) return this.emit('error', err);

  this.connected = true;
  this.connection = conn;
  this.emit('connect', this.connection);

  this.connection.on('error', this.emit.bind(this, 'error'));

  // TODO: Maybe support the creation of multiple channels in the future
  this.connection.createChannel(this._onChannel.bind(this));

};

Rabbit.prototype._onChannel = function (err, ch) {
  if (err) return this.emit('error', err);
  this.channel = ch;
  this.emit('ready', ch)
};

Rabbit.prototype.socket = function (type) {
  return new Socket(type, this);
};

