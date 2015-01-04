# rabbit-rr

[![build status](https://img.shields.io/travis/jcrugzz/rabbit-rr/master.svg?style=flat-square)](http://travis-ci.org/jcrugzz/rabbit-rr)[![Coverage Status](https://img.shields.io/coveralls/jcrugzz/rabbit-rr/master.svg?style=flat-square)](https://coveralls.io/r/jcrugzz/rabbit-rr)

A simple rabbitmq module based on [`amqplib`][amqplib] and inspired by
[`rabbit.js`][rabbit.js] meant to provide a simple callback interface for using
a req/rep pattern. This is ideal when doing concurrent operations that require
the return callback to be properly associated with the data that was sent (and
the result then returned)

[amqplib]: https://github.com/squaremo/amqp.node
[rabbit.js]: https://github.com/squaremo/rabbit.js
