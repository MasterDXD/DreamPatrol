'use strict';
const fs = require('fs');
const path = require('path');

let iconv;
try {
  iconv = require('iconv-lite');
} catch (_) {
  console.error('[diag-changelog] iconv-lite 未安装。请运行 npm install iconv-lite 后重试。');
  process.exit(1);
}

const FILE = path.join(__dirname, '..', 'CHANGELOG.md');
const rawBytes = fs.readFileSync(FILE);

/**
 * @param {string} label - 验证标签（用于日志输出）
 * @param {string} text - 待验证的文本内容
 * @returns {{ garbledLines: number, fffdCount: number, count2877: number, count3228: number }} 文本质量统计
 */
function verify(label, text) {
  const lines = text.split('\n');
  const garbledLines = lines.filter(l => l.includes('\uFFFD')).length;
  const fffdCount = (text.match(/\uFFFD/g) ?? []).length;
  const count2877 = (text.match(/2877/g) ?? []).length;
  const count3228 = (text.match(/3228/g) ?? []).length;
  console.log('[' + label + '] Lines:' + lines.length + ' Garbled:' + garbledLines + ' FFFD:' + fffdCount + ' 2877:' + count2877 + ' 3228:' + count3228);
  return { garbledLines, fffdCount, count2877, count3228 };
}

console.log('=== Current state ===');
verify('Current', rawBytes.toString('utf-8'));

console.log('\n=== GBK decode approach ===');
const gbkDecoded = iconv.decode(rawBytes, 'gbk');
verify('GBK-raw', gbkDecoded);

const gbkCleaned = gbkDecoded.replace(/\u951F\u65A4\u62F7/g, '\uFFFD');
verify('GBK-cleaned', gbkCleaned);

const gbkUtf8 = Buffer.from(gbkCleaned, 'utf-8').toString('utf-8');
verify('GBK->UTF8', gbkUtf8);

console.log('\n=== Sample lines from GBK approach ===');
const gbkLines = gbkCleaned.split('\n');
const sampleIdx = [0, 2, 400, 413, 445, 96, 130];
for (const idx of sampleIdx) {
  if (idx < gbkLines.length) {
    console.log('L' + (idx + 1) + ': ' + gbkLines[idx].substring(0, 120));
  }
}

console.log('\n=== Character-level approach ===');
const utf8Text = rawBytes.toString('utf-8');
let charLevel = '';
let recoveredCount = 0;
for (let i = 0; i < utf8Text.length; i++) {
  const ch = utf8Text[i];
  const cp = ch.codePointAt(0);
  if (cp >= 0x80 && cp <= 0x7FF) {
    const utf8Bytes = Buffer.from(ch, 'utf-8');
    const gbkChar = iconv.decode(utf8Bytes, 'gbk');
    charLevel += gbkChar;
    recoveredCount++;
  } else if (cp >= 0x800 && cp <= 0xFFFF) {
    const utf8Bytes = Buffer.from(String.fromCodePoint(cp), 'utf-8');
    const gbkChar = iconv.decode(utf8Bytes, 'gbk');
    charLevel += gbkChar;
    recoveredCount++;
  } else {
    charLevel += ch;
  }
}
console.log('Recovered 2-byte chars:', recoveredCount);
verify('CharLevel', charLevel);

console.log('\n=== Sample lines from CharLevel approach ===');
const clLines = charLevel.split('\n');
for (const idx of sampleIdx) {
  if (idx < clLines.length) {
    console.log('L' + (idx + 1) + ': ' + clLines[idx].substring(0, 120));
  }
}

console.log('\n=== Hybrid: GBK decode + preserve correct UTF-8 CJK ===');
const _hybrid = '';
const _pos = 0;
const utf8Chars = [];
for (let i = 0; i < utf8Text.length; i++) {
  const cp = utf8Text.codePointAt(i);
  utf8Chars.push({ cp, idx: i });
  if (cp > 0xFFFF) i++;
}

const _gbkIdx = 0;
const gbkChars = [];
for (let i = 0; i < gbkDecoded.length; i++) {
  const cp = gbkDecoded.codePointAt(i);
  gbkChars.push({ cp, idx: i });
  if (cp > 0xFFFF) i++;
}

console.log('UTF-8 char count:', utf8Chars.length);
console.log('GBK char count:', gbkChars.length);

console.log('\n=== Check: are the 184 correct CJK chars in UTF-8 also correct in GBK? ===');
let cjkMatchCount = 0;
const _cjkMismatchCount = 0;
const cjkRange = /^[\u4E00-\u9FFF\u3400-\u4DBF]$/;
for (let i = 0; i < utf8Text.length; i++) {
  const cp = utf8Text.codePointAt(i);
  if (cjkRange.test(String.fromCodePoint(cp))) {
    cjkMatchCount++;
  }
}
console.log('CJK chars in UTF-8:', cjkMatchCount);

let cjkInGbk = 0;
for (let i = 0; i < gbkDecoded.length; i++) {
  const cp = gbkDecoded.codePointAt(i);
  if (cjkRange.test(String.fromCodePoint(cp))) {
    cjkInGbk++;
  }
}
console.log('CJK chars in GBK:', cjkInGbk);
