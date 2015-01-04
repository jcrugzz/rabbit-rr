var Rabbit = require('..');
var assume = require('assume');

describe('Simple request/reply', function () {

  it('should succeed', function (done) {

    var rabbit = new Rabbit()
      .on('ready', function () {
        console.log('rabbit ready');
      });

    var req = rabbit.socket('REQ')
      .on('error', console.error.bind(console))
      .on('ready', function () {
        console.log('REQ socket ready');
      })
      .connect('made_up_queue')
      .on('connect', function () {
        console.log('REQ has connected');
      })
      .send({foo: 'bar'}, function (_, msg) {
        assume(msg).is.an('object');
        assume(msg.reply).is.ok();
        assume(msg.reply).equals('wooo');
        done();
      });

    var rep = rabbit.socket('REP')
      .on('error', function (err) {
        done(err);
      })
      .on('ready', function () {
        console.log('REP socket ready');
      })
      .connect('made_up_queue')
      .on('connect', function () {
        console.log('REP has connected');
      })
      .on('message', function (msg, reply) {
        assume(msg).is.an('object');
        assume(reply).is.a('function');
        assume(msg.foo).is.ok();
        assume(msg.foo).equals('bar');
        reply(undefined, {reply: 'wooo'});
      });
  });
});
