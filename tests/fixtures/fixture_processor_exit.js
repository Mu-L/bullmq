/**
 * A processor file to be used in tests.
 *
 */
'use strict';

const delay = require('./delay');

module.exports = function (/*job*/) {
  return delay(200).then(() => {
    delay(100).then(() => {
      process.exit(0);
    });
  });
};
