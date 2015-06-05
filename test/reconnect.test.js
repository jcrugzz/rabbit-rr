var Rabbit = require('..');
var exec = require('child_process')
var assume = require('assume');

describe('reconnect test case', function () {
  var conn = new Rabbit();
  var oConn = new Rabbit();

  var req = conn.socket('REQ')
    .connect('whatever_whatever_man')
    .on('connect', function () {
      console.log('req connect');
    })
    .send({ what: 'foo' }, function (err, msg) {

    });

  var rep =

});
