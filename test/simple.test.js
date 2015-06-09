var Rabbit = require('..');
var async = require('async');
var assume = require('assume');

describe('Simple request/reply', function () {
  this.timeout(30000);
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
      .on('connect', function () {
        console.log('REQ has connected');
      })
      .connect('made_up_queue')
      .send({foo: 'bar'}, function (err, msg) {
        assume(err).does.not.exist();
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
      .on('connect', function () {
        console.log('REP has connected');
      })
      .connect('made_up_queue')
      .on('message', function (msg, reply) {
        assume(msg).is.an('object');
        assume(msg.foo).is.ok();
        assume(msg.foo).equals('bar');
        reply(undefined, {reply: 'wooo'});
      });
  });

  it('should work when prefetch is passed as an option and throttle requests processed', function (done) {
    var count = 0;
    var receipts = {
      first: false,
      second: false
    };

    function isDone() {
      if (receipts.first && receipts.second) done();
    }
    var rabbit = new Rabbit()
      .on('error', function (err) {
        console.error(err);
        console.log(err.stack);
        done(err);
      });

    var oRab = new Rabbit()
      .on('error', done);

    var req = rabbit.socket('REQ')
      .on('error', done)
      .on('ready', function () {
        console.log('req ready');
      })
      .connect('super_new_queue')
      .send({ test: 'what' }, function(err, message) {
        assume(err).to.not.exist();
        assume(message.first).is.ok();
        isDone();
      })
      .send({ test: 'huh' }, function (err, message) {
        assume(err).to.not.exist();
        assume(message.second).is.ok();
        isDone();
      });


    var rep = oRab.socket('REP', { prefetch: 1 })
      .on('error', done)
      .on('ready', function () {
        console.log('rep ready');
      })
      .connect('super_new_queue')
      .on('message', function (msg, reply) {
        if (count++ === 0) {
          receipts.first = true;
          assume(receipts.second).to.equal(false);
          return setTimeout(function () {
            reply(undefined, { first: true });
          }, 1000);
        }
        assume(count).to.eql(2);
        assume(receipts.first).to.equal(true);
        receipts.second = true;
        return reply(undefined, { second: true });
      });
  });

  it('should handle a large number of messages and reply to them all', function (done) {
    var sent = 0;
    var received = 0;
    var replied = 0;

    var total = 10000;

    var rab = new Rabbit()
      .on('error', done);

    var o = new Rabbit()
      .on('error', done);

    var req = rab.socket('REQ')
      .connect('throughput_queue');

    var rep = o.socket('REP')
      .connect('throughput_queue')
      .on('message', function (msg, reply) {
        ++received;
        setImmediate(function () {
          reply(undefined, { recv: received });
        });
      });

    async.whilst(
      function () { return sent++ < total; },
      function (callback) {
        req.send({ sent: sent }, function (err, msg) {
          ++replied;
          if (err) { return callback(err); }
          callback();
        });
      }, done);
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
