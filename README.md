# rabbit-rr

[![build status](https://img.shields.io/travis/jcrugzz/rabbit-rr/master.svg?style=flat-square)](http://travis-ci.org/jcrugzz/rabbit-rr)[![Coverage Status](https://img.shields.io/coveralls/jcrugzz/rabbit-rr/master.svg?style=flat-square)](https://coveralls.io/r/jcrugzz/rabbit-rr)

A simple rabbitmq module based on [`amqplib`][amqplib] and inspired by
[`rabbit.js`][rabbit.js] meant to provide a simple callback interface for using
a req/rep pattern. This is ideal when doing concurrent operations that require
the return callback to be properly associated with the data that was sent (and
the result then returned)

## Goal:

The purpose of this module is to hide all of the dirty async startup needed when
connecting to rabbit. When initializing a constructor, we establish a `connection` to rabbit and
begin creating a `channel` WITH that `connection`. This channel and connection
is used with any socket created with the rabbit instance. We take care of
deferring the function calls of `connect` and `send` (`send` is only for the `REQ` socket) so
that you have a clean and simple API to use. Each `Rabbit` and `Socket` instance
is an `EventEmitter` with various events associated for gaining insight into the
inner workings. The main event to worry about though is the `message` event on
the `REP` socket which emits any message received from a `REQ` socket with
a callback to reply to it. Please see the example below to understand my
ramblings.

## Example:

Below shows a simple use case

```js

var Rabbit = require('rabbit-rr');

//
// Remark: This constructor accepts an object or URL string with the
// options you want to pass into `amqplib` to connect (e.g ssl options)
//
var rabbit = new Rabbit()
  .on('ready', function () {
    console.log('We are conected to Rabbit!');
  });

//
// Creates a socket to handle sending requests to Rabbit,
// options are accepted as a second argument
//
var req = rabbit.socket('REQ')
  .on('error', console.error.bind(console))
  .on('ready', function () {
    // Called when channel has been assigned
    console.log('REQ socket Ready!');
  })
  // Connect to the specified Queue, accepts an optional callback
  .connect('made_up_queue')
  .on('connect', function () {
    console.log('REQ has connected to queue');
  })
  // We assume and parse payloads as objects
  .send({ foo: 'bar' }, function (_, msg) {
    console.log('received msg %j', msg);
  });

var rep = rabbit.socket('REP')
  .on('error', console.error.bind(console))
  .on('ready', function () {

    console.log('REP socket ready');
  })
  .connect('made_up_queue')
  .on('connect', function () {
    console.log('REP has connected');
  })
  // Listen for messages from requester
  .on('message', function (msg, reply) {
    // Reply to them with a particular payload
    // We assume object payloads everywhere
    reply(undefined, { reply: 'wooo' });
  });
```

[amqplib]: https://github.com/squaremo/amqp.node
[rabbit.js]: https://github.com/squaremo/rabbit.js
