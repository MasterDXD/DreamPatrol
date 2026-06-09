'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CANONICAL_SOURCE = path.join(ROOT, '.trae', 'rules', 'project_rules.md');

const TARGETS = [
  {
    name: 'Windsurf',
    outputPath: path.join(ROOT, '.windsurfrules'),
    editorName: 'Windsurf',
    frontMatter: null,
  },
  {
    name: 'Cursor',
    outputPath: path.join(ROOT, '.cursor', 'rules', 'harness-engineering.mdc'),
    editorName: 'Cursor',
    frontMatter: '---\ndescription: Harness Engineering 多Agent框架核心规则\nglobs:\nalwaysApply: true\n---\n',
  },
  {
    name: 'Trae',
    outputPath: path.join(ROOT, '.trae', 'rules', 'project_rules.md'),
    editorName: 'Trae',
    frontMatter: null,
  },
];

/**
 * @param {string} sourceContent - 源规则内容
 * @param {string} editorName - 目标编辑器名称
 * @param {string|null} frontMatter - 可选的 YAML frontmatter 内容
 * @returns {string} 生成的内容文本
 */
function generateContent(sourceContent, editorName, frontMatter) {
  let content = sourceContent;

  let currentVersion = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    currentVersion = pkg.version || '0.0.0';
  } catch (_err) {
    console.warn('WARNING: Failed to read package.json, using default version 0.0.0');
  }

  content = content.replace(
    /^# Harness Engineering 多Agent框架 v[\d.]+ — .+编辑器项目规则/,
    `# Harness Engineering 多Agent框架 v${currentVersion} — ${editorName}编辑器项目规则`,
  );

  content = content.replace(
    /在\w+编辑器中，你作为用户与AI协作/g,
    `在${editorName}编辑器中，你作为用户与AI协作`,
  );

  if (frontMatter) {
    content = frontMatter + '\n' + content;
  }

  return content;
}

/**
 * 将规范源文件同步到所有目标编辑器规则文件
 */
function sync() {
  if (!fs.existsSync(CANONICAL_SOURCE)) {
    console.error(`ERROR: Canonical source not found: ${CANONICAL_SOURCE}`);
    process.exit(1);
  }

  const sourceContent = fs.readFileSync(CANONICAL_SOURCE, 'utf8');
  let updated = 0;
  let skipped = 0;

  for (const target of TARGETS) {
    const generated = generateContent(sourceContent, target.editorName, target.frontMatter);

    const outputDir = path.dirname(target.outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    let existingContent = '';
    if (fs.existsSync(target.outputPath)) {
      existingContent = fs.readFileSync(target.outputPath, 'utf8');
    }

    if (existingContent === generated) {
      console.log(`  SKIP  ${target.name}: ${path.relative(ROOT, target.outputPath)} (up-to-date)`);
      skipped++;
      continue;
    }

    fs.writeFileSync(target.outputPath, generated, 'utf8');
    console.log(`  WRITE ${target.name}: ${path.relative(ROOT, target.outputPath)}`);
    updated++;
  }

  console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
}

sync();
