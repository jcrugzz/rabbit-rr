
var EE = require('events').EventEmitter;
var util = require('util');

var TYPES = ['req', 'rep', 'REQ', 'REP'];

module.exports = Socket;

util.inherits(Socket, EE);

function Socket (type, rabbit) {
  EE.call(this);
  this.rabbit = rabbit;
  this.type = type;

  this.methods = ['connect', 'send'];
  this.channel = undefined;
  // Operations called potentiall before a channel exists
  this.operations = [];
  //
  // So we can probably still grab the methods off the prototype even af
  //
  this.ready = false;

  if (!~TYPES.indexOf(this.type)) {
    var error = new Error('Invalid socket type');
    return process.nextTick(this.emit.bind(this, 'error', error));
  }

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

  this.ready = true;
};

Socket.prototype._setChannel = function (channel) {
  this.channel = channel;
};

Socket.prototype._onChannel = function (ch) {
  this.channel = ch;
  this.emit('channel', ch);
};

Socket.prototype.connect = function (destination, options) {

};


