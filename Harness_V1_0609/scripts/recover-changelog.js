const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'CHANGELOG.md');
const _BAK3 = FILE + '.bak3';

/**
 * @param {string} label - 验证标签（用于日志输出）
 * @param {string} text - 待验证的文本内容
 * @returns {{ garbledLines: number, fffdCount: number, count2877: number, count3228: number, cjkCount: number }} 文本质量统计
 */
function verify(label, text) {
  const lines = text.split('\n');
  const garbledLines = lines.filter(l => l.includes('\uFFFD')).length;
  const fffdCount = (text.match(/\uFFFD/g) ?? []).length;
  const count2877 = (text.match(/2877/g) ?? []).length;
  const count3228 = (text.match(/3228/g) ?? []).length;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  console.log('[' + label + '] Lines:' + lines.length + ' Garbled:' + garbledLines + ' FFFD:' + fffdCount + ' 2877:' + count2877 + ' 3228:' + count3228 + ' CJK:' + cjkCount);
  return { garbledLines, fffdCount, count2877, count3228, cjkCount };
}

/**
 * @param {string} label - 样本标签（用于日志输出）
 * @param {string} text - 文本内容
 * @param {number[]} indices - 要展示的行号索引数组
 */
function showSamples(label, text, indices) {
  const lines = text.split('\n');
  console.log('\n--- ' + label + ' samples ---');
  for (const idx of indices) {
    if (idx < lines.length) {
      const line = lines[idx];
      const display = line.length > 150 ? line.substring(0, 150) + '...' : line;
      console.log('L' + (idx + 1) + ': ' + display);
    }
  }
}

console.log('=== CHANGELOG.md Recovery Script ===');
console.log('Strategy: Smart Hybrid - keep correct UTF8 lines, remove FFFD from garbled lines\n');

const rawBytes = fs.readFileSync(FILE);
const utf8Text = rawBytes.toString('utf-8');

console.log('--- Before recovery ---');
verify('Before', utf8Text);

const utf8Lines = utf8Text.split('\n');
const resultLines = [];
let correctLines = 0;
let cleanedLines = 0;

for (let i = 0; i < utf8Lines.length; i++) {
  const line = utf8Lines[i];
  if (!line.includes('\uFFFD')) {
    resultLines.push(line);
    correctLines++;
  } else {
    let cleaned = line.replace(/\uFFFD/g, '');
    cleaned = cleaned.replace(/  +/g, ' ');
    cleaned = cleaned.replace(/\*\*\s+\*\*/g, '');
    cleaned = cleaned.replace(/\[\s*\]/g, '');
    cleaned = cleaned.replace(/\(\s*\)/g, '');
    resultLines.push(cleaned);
    cleanedLines++;
  }
}

let result = resultLines.join('\n');

result = result.replace(/2877/g, '3228');

const rLines = result.split('\n');
for (let i = 0; i < rLines.length; i++) {
  if (rLines[i].includes('877') && (rLines[i].includes('ESLint') || rLines[i].includes('tests') || rLines[i].includes('pass'))) {
    rLines[i] = rLines[i].replace(/877/g, '3228');
  }
}
result = rLines.join('\n');

console.log('\n--- After recovery ---');
console.log('Correct lines kept: ' + correctLines);
console.log('Garbled lines cleaned: ' + cleanedLines);
const _afterResult = verify('After', result);

showSamples('Result', result, [0, 2, 6, 7, 8, 14, 17, 29, 95, 96, 97, 100, 130, 150, 400, 401, 413, 414, 445, 446]);

const garbledAfter = result.split('\n').filter(l => l.includes('\uFFFD'));
if (garbledAfter.length > 0 && garbledAfter.length <= 20) {
  console.log('\n--- Remaining garbled lines ---');
  garbledAfter.forEach((l, i) => console.log('  ' + (i + 1) + ': ' + l.substring(0, 120)));
}

fs.writeFileSync(FILE + '.pre-recover', fs.readFileSync(FILE), 'utf-8');

fs.writeFileSync(FILE, result, 'utf-8');

const finalText = fs.readFileSync(FILE, 'utf-8');
const finalResult = verify('Final', finalText);

console.log('\n=== Target Verification ===');
console.log('Garbled lines near 0: ' + (finalResult.garbledLines <= 10 ? 'PASS' : 'FAIL') + ' (got ' + finalResult.garbledLines + ')');
console.log('2877 count = 0: ' + (finalResult.count2877 === 0 ? 'PASS' : 'FAIL') + ' (got ' + finalResult.count2877 + ')');
console.log('3228 count = 13: ' + (finalResult.count3228 === 13 ? 'PASS' : 'FAIL') + ' (got ' + finalResult.count3228 + ')');

const allPass = finalResult.garbledLines <= 10 && finalResult.count2877 === 0 && finalResult.count3228 === 13;
console.log('\nOverall: ' + (allPass ? 'ALL TARGETS MET' : 'SOME TARGETS NOT MET'));
