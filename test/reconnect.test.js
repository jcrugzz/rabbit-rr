var Rabbit = require('..');
var exec = require('child_process')
var assume = require('assume');

describe.skip('reconnect test case', function () {

  it('should properly reconnect when rabbit goes down', function (done) {

    var conn = new Rabbit();
    var oConn = new Rabbit();

    var req = conn.socket('REQ')
      .connect('whatever_whatever_man')
      .on('connect', function () {
        console.log('req connect');
      })
      .send({ what: 'foo' }, function (err, msg) {

      });

  });

});
