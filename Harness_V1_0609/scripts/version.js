'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const CONFIG_JSON = path.join(ROOT, '.harness', 'config.json');
const CHANGELOG_MD = path.join(ROOT, 'CHANGELOG.md');

const VALID_BUMP_TYPES = ['major', 'minor', 'patch'];
const VALID_CATEGORIES = ['新增', '变更', '修复', '移除'];

/**
 * @param {string} filePath - JSON文件的绝对路径
 * @returns {object} 解析后的JSON对象
 */
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error('Failed to read/parse JSON: ' + filePath, err.message);
    process.exit(1);
  }
}

/**
 * @param {string} filePath - JSON文件的绝对路径
 * @param {object} data - 要写入的JSON对象
 */
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/**
 * @param {string} current - 当前语义化版本号（如 "1.2.3"）
 * @param {'major'|'minor'|'patch'} type - 版本递增类型
 * @returns {string} 递增后的新版本号
 */
function bumpVersion(current, type) {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some(function(p) { return !Number.isFinite(p); })) {
    throw new Error('Invalid semver: ' + current);
  }
  if (type === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (type === 'minor') { parts[1]++; parts[2] = 0; }
  else if (type === 'patch') { parts[2]++; }
  return parts.join('.');
}

/**
 * @returns {string} 当天日期，格式为 YYYY-MM-DD
 */
function today() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/**
 * @param {string[]} argv - 命令行参数数组（通常为 process.argv）
 * @returns {object} 解析后的参数对象，_ 属性存放位置参数，其余为 --key 形式的命名参数
 */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

/**
 * @returns {{ valid: boolean, errors: string[], pkgVersion: string, cfgVersion: string, changelogVersions: string[] }} 版本一致性校验结果
 */
function validateVersionConsistency() {
  const pkg = readJSON(PACKAGE_JSON);
  const cfg = readJSON(CONFIG_JSON);
  const errors = [];

  if (pkg.version !== cfg.version) {
    errors.push('package.json version (' + pkg.version + ') != .harness/config.json version (' + cfg.version + ')');
  }

  let changelogContent;
  try {
    changelogContent = fs.readFileSync(CHANGELOG_MD, 'utf-8');
  } catch (readErr) {
    errors.push('CHANGELOG.md read failed: ' + (readErr && readErr.message ? readErr.message : String(readErr)));
    return { valid: false, errors: errors, pkgVersion: pkg.version, cfgVersion: cfg.version, changelogVersions: [] };
  }
  const versionHeaders = changelogContent.match(/## \[(\d+\.\d+\.\d+)\]/g) ?? [];
  const changelogVersions = versionHeaders.map(h => h.match(/\[(\d+\.\d+\.\d+)\]/)?.[1]).filter(Boolean);

  if (changelogVersions.length === 0) {
    errors.push('CHANGELOG.md has no version entries');
  }

  if (changelogVersions.length > 0 && changelogVersions[0] !== pkg.version) {
    errors.push('CHANGELOG.md latest version (' + changelogVersions[0] + ') != package.json version (' + pkg.version + ')');
  }

  return { valid: errors.length === 0, errors: errors, pkgVersion: pkg.version, cfgVersion: cfg.version, changelogVersions: changelogVersions };
}

function _buildMetaComment(meta) {
  if (!meta) return '';
  let result = '\n';
  const fields = [
    ['iterationRound', meta.iterationRound],
    ['cumulativeIterations', meta.cumulativeIterations],
    ['startTime', meta.startTime],
    ['endTime', meta.endTime],
    ['durationHours', meta.durationHours],
    ['tokenTotal', meta.tokenTotal],
    ['tokenBreakdown', meta.tokenBreakdown],
    ['responsible', meta.responsible],
    ['reviewer', meta.reviewer],
  ];
  for (const [key, value] of fields) {
    if (value !== undefined) result += '<!-- ' + key + ': ' + String(value).replace(/-->/g, '--&gt;') + ' -->\n';
  }
  return result;
}

function _buildCategoryItems(items) {
  let result = '\n';
  for (const item of items) {
    result += '- **' + item.title + '**';
    if (item.module) result += '（模块：' + item.module;
    if (item.method) result += ' / 实现方式：' + item.method;
    if (item.value) result += ' / 业务价值：' + item.value;
    if (item.module) result += '）';
    result += '\n';
    if (item.subItems && item.subItems.length > 0) {
      for (const sub of item.subItems) result += '  - ' + sub + '\n';
    }
    if (item.files && item.files.length > 0) {
      result += '  - 修改文件：`' + item.files.join('`, `') + '`\n';
    }
  }
  return result;
}

/**
 * @param {string} version - 版本号
 * @param {string} date - 发布日期（YYYY-MM-DD）
 * @param {object} entries - 变更条目，包含 meta 及各分类数组
 */
function addChangelogEntry(version, date, entries) {
  let content;
  try {
    content = fs.readFileSync(CHANGELOG_MD, 'utf-8');
  } catch (readErr) {
    throw new Error('CHANGELOG.md not found or unreadable: ' + readErr.message);
  }

  const insertionPoint = content.indexOf('---');
  if (insertionPoint === -1) {
    throw new Error('CHANGELOG.md missing "---" separator');
  }

  const header = content.slice(0, insertionPoint).trim();

  let newEntry = '\n## [' + version + '] - ' + date + '\n';
  newEntry += _buildMetaComment(entries.meta);

  const categoryOrder = ['新增', '变更', '修复', '移除'];
  for (const cat of categoryOrder) {
    const items = entries[cat];
    if (items && items.length > 0) {
      newEntry += '\n### ' + cat + _buildCategoryItems(items);
    }
  }

  newEntry += '\n---\n';

  content = header + '\n\n' + newEntry + content.slice(insertionPoint + 3);
  fs.writeFileSync(CHANGELOG_MD, content, 'utf-8');
}

/**
 * @param {object} args - 解析后的命令行参数
 */
function cmdBump(args) {
  const bumpType = args._[0];
  if (!VALID_BUMP_TYPES.includes(bumpType)) {
    console.error('Usage: node scripts/version.js bump <major|minor|patch> [--date YYYY-MM-DD] [--meta-json \'{"iterationRound":12}\']');
    process.exit(1);
  }

  const pkg = readJSON(PACKAGE_JSON);
  const cfg = readJSON(CONFIG_JSON);
  const oldVersion = pkg.version;
  const newVersion = bumpVersion(oldVersion, bumpType);
  const date = args.date || today();

  console.log('Bumping version: ' + oldVersion + ' → ' + newVersion + ' (' + bumpType + ')');

  pkg.version = newVersion;
  writeJSON(PACKAGE_JSON, pkg);
  console.log('  Updated package.json');

  cfg.version = newVersion;
  writeJSON(CONFIG_JSON, cfg);
  console.log('  Updated .harness/config.json');

  let meta = null;
  if (args['meta-json']) {
    try {
      meta = JSON.parse(args['meta-json']);
    } catch (_e) {
      console.error('  Warning: Invalid --meta-json, skipping metadata');
    }
  }

  const entries = { meta: meta, 新增: [], 变更: [], 修复: [], 移除: [] };
  addChangelogEntry(newVersion, date, entries);
  console.log('  Added CHANGELOG.md entry for v' + newVersion);

  console.log('\nVersion bump complete. Edit CHANGELOG.md to add change details under v' + newVersion + '.');
}

/**
 * 校验 package.json、config.json 和 CHANGELOG.md 之间的版本一致性
 */
function cmdCheck() {
  const result = validateVersionConsistency();
  if (result.valid) {
    console.log('✓ Version consistency check passed');
    console.log('  package.json: v' + result.pkgVersion);
    console.log('  .harness/config.json: v' + result.cfgVersion);
    console.log('  CHANGELOG.md: ' + result.changelogVersions.length + ' versions (latest: v' + result.changelogVersions[0] + ')');
  } else {
    console.error('✗ Version consistency check FAILED:');
    for (const err of result.errors) {
      console.error('  - ' + err);
    }
    process.exit(1);
  }
}

/**
 * @param {object} args - 命令行参数，需包含 version、summary、category、agent、files 等
 */
function cmdRecord(args) {
  const version = args.version;
  const category = args.category || '变更';
  const summary = args.summary || '';
  const agent = args.agent || '未知';
  const files = args.files ? args.files.split(',') : [];

  if (!version) {
    console.error('Usage: node scripts/version.js record --version X.Y.Z --summary "desc" [--category 新增|变更|修复|移除] [--agent name] [--files a.js,b.js]');
    process.exit(1);
  }

  if (!VALID_CATEGORIES.includes(category)) {
    console.error('Invalid category: ' + category + '. Must be one of: ' + VALID_CATEGORIES.join(', '));
    process.exit(1);
  }

  const ChangelogArchive = require(path.join(ROOT, 'src', 'web', 'changelog-archive'));
  const archive = new ChangelogArchive(ROOT);

  const result = archive.record({
    version: version,
    date: today(),
    changes: [{ category: category, summary: summary }],
    summary: summary,
    category: category,
    files: files,
    agent: agent,
    phase: '',
  });

  if (result.success) {
    console.log('✓ Recorded v' + version + ' to archive (id: ' + result.id + ')');
  } else {
    console.error('✗ Failed to record: ' + result.error);
    process.exit(1);
  }
}

/**
 * 列出变更日志归档的统计信息和完整性校验结果
 */
function cmdList() {
  const ChangelogArchive = require(path.join(ROOT, 'src', 'web', 'changelog-archive'));
  const archive = new ChangelogArchive(ROOT);

  const stats = archive.getStats();
  console.log('Archive statistics:');
  console.log('  Total records: ' + stats.total);
  console.log('  By category: ' + JSON.stringify(stats.byCategory));
  console.log('  By agent: ' + JSON.stringify(stats.byAgent));
  console.log('  By month: ' + JSON.stringify(stats.byMonth));

  const integrity = archive.verifyIntegrity();
  console.log('\nIntegrity check:');
  console.log('  Index valid: ' + integrity.indexValid);
  console.log('  Records valid: ' + integrity.recordsValid);
  console.log('  Records tampered: ' + integrity.recordsTampered);
}

const args = parseArgs(process.argv);
const command = args._[0];
args._.shift();

switch (command) {
  case 'bump': cmdBump(args); break;
  case 'check': cmdCheck(args); break;
  case 'record': cmdRecord(args); break;
  case 'list': cmdList(args); break;
  default:
    console.log('Harness Engineering Version Manager');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/version.js bump <major|minor|patch> [--date YYYY-MM-DD] [--meta-json \'{"iterationRound":12}\']');
    console.log('  node scripts/version.js check');
    console.log('  node scripts/version.js record --version X.Y.Z --summary "desc" [--category 新增|变更|修复|移除] [--agent name] [--files a.js,b.js]');
    console.log('  node scripts/version.js list');
    process.exit(0);
}
