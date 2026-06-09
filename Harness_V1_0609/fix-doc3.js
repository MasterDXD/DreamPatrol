const fs = require('fs');
const path = 'e:\\Harness_V1_0429\\docs\\architecture\\项目全面技术梳理报告.md';
const buf = fs.readFileSync(path);

// Search for "52 " (as ASCII bytes) near "Lazy Exports"
const searchStr = '52 ';
const searchBuf = Buffer.from(searchStr);

// Find all occurrences of "52 " in the file
let positions = [];
let pos = 0;
while (true) {
  pos = buf.indexOf(searchBuf, pos);
  if (pos === -1) break;
  // Check surrounding context
  const before = buf.slice(Math.max(0, pos - 30), pos).toString('utf8');
  const after = buf.slice(pos, pos + 30).toString('utf8');
  if (before.includes('Lazy') || after.includes('延迟加载')) {
    console.log(`Found "52 " at byte ${pos}, context: ...${before}|${after}...`);
    positions.push(pos);
  }
  pos++;
}

// Replace "52 " with "94 " at those positions
if (positions.length > 0) {
  let result = Buffer.from(buf);
  // Replace from end to start to preserve positions
  for (let i = positions.length - 1; i >= 0; i--) {
    const p = positions[i];
    result = Buffer.concat([
      result.slice(0, p),
      Buffer.from('94 '),
      result.slice(p + 3)
    ]);
  }
  fs.writeFileSync(path, result);
  console.log(`Replaced ${positions.length} occurrences of "52 " → "94 " in Lazy Exports context`);
}

// Also fix "Orchstrtr" → "Orchestrator"
const orchBuf = Buffer.from('Orchstrtr');
const orchReplace = Buffer.from('Orchestrator');
let orchPos = 0;
let orchCount = 0;
let result2 = fs.readFileSync(path);
while (true) {
  orchPos = result2.indexOf(orchBuf, orchPos);
  if (orchPos === -1) break;
  result2 = Buffer.concat([
    result2.slice(0, orchPos),
    orchReplace,
    result2.slice(orchPos + orchBuf.length)
  ]);
  orchCount++;
  orchPos += orchReplace.length;
}
if (orchCount > 0) {
  fs.writeFileSync(path, result2);
  console.log(`Replaced ${orchCount} occurrences of "Orchstrtr" → "Orchestrator"`);
}

// Fix "68 个 Deepening 模块从" → "68 个 Deepening 注册项从"
// This is harder because of Chinese chars, let's search for "68 " near "Deepening"
const search68 = Buffer.from('68 ');
let pos68 = 0;
let result3 = fs.readFileSync(path);
let found68 = [];
while (true) {
  pos68 = result3.indexOf(search68, pos68);
  if (pos68 === -1) break;
  const after = result3.slice(pos68, pos68 + 60).toString('utf8');
  if (after.includes('Deepening') && after.includes('false')) {
    found68.push(pos68);
    console.log(`Found "68 " near Deepening at byte ${pos68}: ${after.substring(0, 50)}`);
  }
  pos68++;
}

console.log('Done');
