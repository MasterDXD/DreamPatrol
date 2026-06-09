'use strict';
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

const testDir = path.join(__dirname, '..', 'test', 'deepening');
const files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();

for (const file of files) {
  const r = cp.spawnSync('node', ['--test', path.join('test', 'deepening', file)], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const output = r.stdout + r.stderr;
  const failMatch = output.match(/ℹ fail (\d+)/);
  const passMatch = output.match(/ℹ pass (\d+)/);
  const fail = failMatch ? parseInt(failMatch[1]) : 0;
  const pass = passMatch ? parseInt(passMatch[1]) : 0;
  if (fail > 0) {
    console.log(`FAIL: ${file} - pass:${pass} fail:${fail}`);
  }
}
console.log('Done.');
