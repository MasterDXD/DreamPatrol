const fs = require('fs');
const path = require('path');

const file = path.join('g:', 'DreamPatrol', 'Files', 'dimilinks-image-demo.html');
const html = fs.readFileSync(file, 'utf8');

// Extract <script> content
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.log('NO SCRIPT FOUND');
  process.exit(1);
}

const code = m[1];
fs.writeFileSync(path.join('g:', 'DreamPatrol', 'extracted.js'), code);

try {
  // Just parse, do not execute (since code references DOM)
  new Function(code);
  console.log('SYNTAX OK, length:', code.length);
} catch (e) {
  console.log('SYNTAX ERROR:', e.message);
  process.exit(1);
}
