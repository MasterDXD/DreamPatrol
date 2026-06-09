'use strict';
const fs = require('fs');
const path = require('path');
const srcDir = path.join(__dirname, '..', 'src');
const errors = [];
let loaded = 0;
/**
 * @param {string} dir - 要遍历的目录绝对路径
 */
function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) { walkDir(fullPath); }
    else if (entry.name.endsWith('.js') && !fullPath.includes('public') && !fullPath.includes('test')) {
      try { require(fullPath); loaded++; }
      catch (e) { errors.push({ file: path.relative(__dirname, fullPath), error: (e && e.message ? e.message : String(e)) }); }
    }
  }
}
walkDir(srcDir);
console.log('Loaded: ' + loaded + '/' + (loaded + errors.length));
if (errors.length > 0) {
  console.log('Errors:');
  errors.forEach(function(e) { console.log('  ' + e.file + ': ' + e.error); });
} else {
  console.log('All modules loaded successfully');
}
