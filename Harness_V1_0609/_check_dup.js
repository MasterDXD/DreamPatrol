'use strict';
const fs = require('fs');
const path = require('path');

function scan(dir) {
  const results = [];
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, f.name);
    if (f.isDirectory() && !f.name.startsWith('.') && f.name !== 'node_modules') {
      results.push(...scan(fp));
    } else if (f.isFile() && f.name.endsWith('.js')) {
      const c = fs.readFileSync(fp, 'utf8');
      const lines = c.split('\n');
      const reqs = {};
      lines.forEach(function(l, i) {
        const m = l.match(/require\(['"]([^'"]+)['"]\)/);
        if (m) {
          const r = m[1];
          if (reqs[r]) {
            results.push(fp + ':' + (i + 1) + ' duplicate require of ' + r + ' (first at line ' + reqs[r] + ')');
          } else {
            reqs[r] = i + 1;
          }
        }
      });
    }
  }
  return results;
}

const r = scan('src');
if (r.length === 0) {
  console.log('No duplicate requires found');
} else {
  r.forEach(function(x) { console.log(x); });
}
