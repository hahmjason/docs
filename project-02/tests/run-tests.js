#!/usr/bin/env node
/* Node 테스트 러너 (의존성 없음): node tests/run-tests.js */
'use strict';
var path = require('path');
var base = path.join(__dirname, '..');
function req(p) { return require(path.join(base, p)); }
var M = {
  D: req('data/campus-data.js'), PH: req('data/photo-catalog.js'), E: req('js/engine.js'), W: req('js/weather.js'),
  C: req('js/context.js'), MT: req('js/photo-matcher.js'), T: req('js/timetable.js')
};
var defineSpecs = require('./specs.js');
var tests = [];
defineSpecs({ test: function (name, fn) { tests.push({ name: name, fn: fn }); } }, M);

var passed = 0, failed = 0;
(async function () {
  for (var i = 0; i < tests.length; i++) {
    var t = tests[i], t0 = Date.now();
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.name + ' (' + (Date.now() - t0) + 'ms)');
    } catch (e) {
      failed++;
      console.log('  ✗ ' + t.name + '\n      ' + (e && e.message));
    }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed, ' + tests.length + ' total');
  process.exit(failed ? 1 : 0);
})();
