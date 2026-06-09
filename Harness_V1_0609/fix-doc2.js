const fs = require('fs');
const path = 'e:\\Harness_V1_0429\\docs\\architecture\\项目全面技术梳理报告.md';
const buf = fs.readFileSync(path);
let text = buf.toString('utf8');

const replacements = [
  ['52 模块延迟加载', '94 模块延迟加载'],
  ['68 个 Deepening 模块从 `false` 变为', '68 个 Deepening 注册项从 `false` 变为'],
  ['68 lazy + 4 true', '68 lazy + 4 true（注：52 为 deepening/ 目录文件数，72 为 Registry 注册项数）'],
  ['PhaseOrchstrtr', 'PhaseOrchestrator'],
];

for (const [search, replace] of replacements) {
  if (text.includes(search)) {
    text = text.split(search).join(replace);
    console.log(`Replaced: "${search}" → "${replace}"`);
  } else {
    console.log(`Not found: "${search}"`);
  }
}

fs.writeFileSync(path, text, 'utf8');
console.log('Done');
