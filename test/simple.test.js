var Rabbit = require('..');
var assume = require('assume');

describe('Simple request/reply', function () {

  it('should succeed', function (done) {
    var rabbit = new Rabbit()
      .on('ready', function () {
        console.log('rabbit ready');
      });

    var req = rabbit.socket('REQ')
      .on('error', function (err) {
        assume(err).does.not.exist();
        done(err);
      })
      .on('ready', function () {
        console.log('REQ socket ready');
      })
      .connect('made_up_queue')
      .on('connect', function () {
        console.log('REQ has connected');
      })
      .send({foo: 'bar'}, function (err, msg) {
        assume(err).does.not.exist()
        assume(msg).is.an('object');
        assume(msg.reply).is.ok();
        assume(msg.reply).equals('wooo');
        done();
      });

    var rep = rabbit.socket('REP')
      .on('error', function (err) {
        assume(err).does.not.exist();
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
        assume(msg.foo).is.ok();
        assume(msg.foo).equals('bar');
        reply(undefined, {reply: 'wooo'});
      });
  });

  it('should handle concurrent messages with different connections', function (done) {
    var count = 0;

    function isDone() {
      if (++count === 2) done();
    }
    var rabbit = new Rabbit()
      .on('error', function (err) {
        console.error(err);
        console.dir(err.message);
        done(err);
      })

    var otherRabbit = new Rabbit()
      .on('error', function (err) {
        console.error(err);
        console.dir(err.message);
        done(err);
      });

    var req = rabbit.socket('REQ')
      .on('error', done)
      .on('ready', function () {
        console.log('REQ socket ready');
      })
      .connect('nnew_made_up_queue')
      .on('connect', function () {
        console.log('REQ has connected');
      })
      .send({foo: 'bar'}, function (err, msg) {
        assume(msg).is.an('object');
        assume(msg.reply).is.ok();
        assume(msg.reply).equals('wooo');
        isDone();
      })
      .send({foo: 'bar'}, function (err, msg) {
        assume(msg).is.an('object');
        assume(msg.reply).is.ok();
        assume(msg.reply).equals('wooo');
        isDone();
     });

    var rep = otherRabbit.socket('REP')
      .on('error', function (err) {
        console.dir(err);
        console.dir(err.message);
        done(err);
      })
      .on('ready', function () {
        console.log('REP socket ready');
      })
      .connect('nnew_made_up_queue')
      .on('connect', function () {
        console.log('REP has connected');
      })
      .on('message', function (msg, reply) {
        assume(reply).is.a('function');
        assume(msg).is.an('object');
        assume(msg.foo).is.ok();
        assume(msg.foo).equals('bar');
        reply(undefined, {reply: 'wooo'});
      });
  });
});
