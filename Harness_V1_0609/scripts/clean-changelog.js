#!/usr/bin/env node
'use strict';

/**
 * CHANGELOG.md 清理脚本
 *
 * 功能：
 * 1. 移除所有仅含"阶段转换"或"会话创建"内容的 0.0.x 版本段落
 * 2. 保留所有 2.x 版本段落
 * 3. 移除重复版本号（保留首次出现）
 * 4. 修复非标准版本后缀（移除 b 后缀，如 2.7.92b → 2.7.92）
 * 5. 移除版本标题中的 ?? 标记
 * 6. 修改前创建备份 CHANGELOG.md.bak
 * 7. 打印清理摘要
 */

const fs = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.resolve(__dirname, '..', 'CHANGELOG.md');
const BACKUP_PATH = CHANGELOG_PATH + '.bak';

// --- 统计 ---
const stats = {
  removedNoiseSections: 0,
  removedNoiseLines: 0,
  duplicateVersionsRemoved: 0,
  bSuffixFixed: [],
  questionMarksFixed: [],
  originalLines: 0,
  finalLines: 0,
  originalSize: 0,
  finalSize: 0,
};

function main() {
  // 读取文件
  if (!fs.existsSync(CHANGELOG_PATH)) {
    console.error(`错误: 找不到 ${CHANGELOG_PATH}`);
    process.exit(1);
  }

  const original = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
  stats.originalSize = Buffer.byteLength(original, 'utf-8');
  const lines = original.split('\n');
  stats.originalLines = lines.length;

  // 创建备份
  fs.writeFileSync(BACKUP_PATH, original, 'utf-8');
  console.log(`备份已创建: ${BACKUP_PATH}`);

  // 第一步：解析为版本段落
  const sections = parseSections(lines);

  // 第二步：移除仅含噪声内容的 0.0.x 段落
  const afterNoiseRemoval = removeNoiseSections(sections);

  // 第三步：修复版本标题中的 b 后缀和 ?? 标记
  const afterFixes = fixVersionTitles(afterNoiseRemoval);

  // 第四步：移除重复版本号（保留首次出现）
  const afterDedup = removeDuplicateVersions(afterFixes);

  // 第五步：重新组装并清理多余空行
  const result = reassemble(afterDedup);

  stats.finalSize = Buffer.byteLength(result, 'utf-8');

  // 写入文件
  fs.writeFileSync(CHANGELOG_PATH, result, 'utf-8');
  stats.finalLines = result.split('\n').length;

  // 打印摘要
  printSummary();
}

/**
 * 将文件行解析为段落列表
 * 每个段落 = { header: string (## [version]...), lines: string[] }
 * 文件头部（第一个 ## 之前的内容）作为特殊段落
 */
function parseSections(lines) {
  const sections = [];
  let currentHeader = null;
  let currentLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^## \[/);

    if (headerMatch) {
      // 保存前一个段落
      if (currentHeader !== null) {
        sections.push({ header: currentHeader, lines: currentLines });
      } else if (currentLines.length > 0) {
        // 文件头部内容（## 之前的部分）
        sections.push({ header: null, lines: currentLines });
      }
      currentHeader = line;
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // 保存最后一个段落
  if (currentHeader !== null) {
    sections.push({ header: currentHeader, lines: currentLines });
  } else if (currentLines.length > 0) {
    sections.push({ header: null, lines: currentLines });
  }

  return sections;
}

/**
 * 判断段落是否为仅含噪声内容的 0.0.x 版本
 * 噪声内容 = 只包含 "阶段转换" 或 "会话创建" 的条目
 */
function isNoiseOnlySection(section) {
  if (!section.header) return false;

  // 检查是否为 0.0.x 版本
  const versionMatch = section.header.match(/^## \[0\.0\.\d+\]/);
  if (!versionMatch) return false;

  // 检查段落内容是否只包含阶段转换或会话创建
  const contentLines = section.lines.filter(l => l.trim().length > 0);

  // 空段落也视为噪声
  if (contentLines.length === 0) return true;

  // 检查所有非空、非注释行是否为噪声
  for (const line of contentLines) {
    const trimmed = line.trim();
    // 跳过 HTML 注释
    if (trimmed.startsWith('<!--')) continue;
    // 跳过 ### 标题（如 "### 变更"、"### 新增"）
    if (trimmed.startsWith('### ')) continue;
    // 跳过空行
    if (trimmed === '') continue;

    // 检查是否为噪声内容行
    // 匹配: - **阶段转换:** xxx 或 - **会话创建:** xxx
    // 也匹配截断的变体如 - **阶段转换: phase-bu**\nu**
    if (/^- \*\*阶段转换:/.test(trimmed)) continue;
    if (/^- \*\*会话创建:/.test(trimmed)) continue;
    // 截断残留行：如 "u**" 来自 "phase-bu**" 的断裂
    if (/^[a-z]*\*\*$/.test(trimmed)) continue;

    // 如果有其他内容，则不是纯噪声段落
    return false;
  }

  return true;
}

/**
 * 移除噪声段落
 */
function removeNoiseSections(sections) {
  const result = [];
  for (const section of sections) {
    if (isNoiseOnlySection(section)) {
      stats.removedNoiseSections++;
      stats.removedNoiseLines += 1 + section.lines.length; // header + content lines
    } else {
      result.push(section);
    }
  }
  return result;
}

/**
 * 修复版本标题中的 b 后缀和 ?? 标记
 */
function fixVersionTitles(sections) {
  return sections.map(section => {
    if (!section.header) return section;

    let newHeader = section.header;

    // 修复 b 后缀: ## [2.7.92b] → ## [2.7.92]
    const bSuffixMatch = newHeader.match(/^## \[(\d+\.\d+\.\d+)b\]/);
    if (bSuffixMatch) {
      const oldVersion = bSuffixMatch[1] + 'b';
      const newVersion = bSuffixMatch[1];
      newHeader = newHeader.replace(`[${oldVersion}]`, `[${newVersion}]`);
      stats.bSuffixFixed.push({ from: oldVersion, to: newVersion });
    }

    // 移除 ?? 标记: "?? Bug修复重构" → "Bug修复重构"
    const qmMatch = newHeader.match(/^(## \[[^\]]+\].*?)\s*\?\?\s*/);
    if (qmMatch) {
      const before = newHeader;
      // 移除所有 ?? 及其后的空格
      newHeader = newHeader.replace(/\s*\?\?\s*/g, ' ').replace(/\s+$/, '');
      stats.questionMarksFixed.push({ from: before, to: newHeader });
    }

    if (newHeader !== section.header) {
      return { ...section, header: newHeader };
    }
    return section;
  });
}

/**
 * 移除重复版本号，保留首次出现
 */
function removeDuplicateVersions(sections) {
  const seen = new Set();
  const result = [];

  for (const section of sections) {
    if (!section.header) {
      result.push(section);
      continue;
    }

    const versionMatch = section.header.match(/^## \[([^\]]+)\]/);
    if (!versionMatch) {
      result.push(section);
      continue;
    }

    const version = versionMatch[1];
    if (seen.has(version)) {
      stats.duplicateVersionsRemoved++;
      stats.removedNoiseLines += 1 + section.lines.length;
    } else {
      seen.add(version);
      result.push(section);
    }
  }

  return result;
}

/**
 * 重新组装为最终文本
 */
function reassemble(sections) {
  const parts = [];

  for (const section of sections) {
    if (section.header === null) {
      // 文件头部
      parts.push(section.lines.join('\n'));
    } else {
      parts.push(section.header + '\n' + section.lines.join('\n'));
    }
  }

  let result = parts.join('\n');

  // 清理多余空行：3个以上连续空行压缩为2个
  result = result.replace(/\n{4,}/g, '\n\n\n');

  // 确保文件末尾有换行
  if (!result.endsWith('\n')) {
    result += '\n';
  }

  return result;
}

/**
 * 打印清理摘要
 */
function printSummary() {
  const savedBytes = stats.originalSize - stats.finalSize;
  const savedPercent = ((savedBytes / stats.originalSize) * 100).toFixed(1);
  const savedLines = stats.originalLines - stats.finalLines;

  console.log('\n========== CHANGELOG 清理摘要 ==========\n');

  console.log(`原始文件: ${stats.originalLines} 行, ${formatBytes(stats.originalSize)}`);
  console.log(`清理后:   ${stats.finalLines} 行, ${formatBytes(stats.finalSize)}`);
  console.log(`节省:     ${savedLines} 行, ${formatBytes(savedBytes)} (${savedPercent}%)\n`);

  console.log(`移除噪声段落 (0.0.x 仅含阶段转换/会话创建): ${stats.removedNoiseSections} 个`);
  console.log(`移除重复版本段落: ${stats.duplicateVersionsRemoved} 个`);
  console.log(`总移除段落: ${stats.removedNoiseSections + stats.duplicateVersionsRemoved} 个\n`);

  if (stats.bSuffixFixed.length > 0) {
    console.log('修复 b 后缀版本:');
    for (const fix of stats.bSuffixFixed) {
      console.log(`  ${fix.from} → ${fix.to}`);
    }
    console.log();
  }

  if (stats.questionMarksFixed.length > 0) {
    console.log('移除版本标题 ?? 标记:');
    for (const fix of stats.questionMarksFixed) {
      console.log(`  ${fix.from}`);
      console.log(`  → ${fix.to}`);
    }
    console.log();
  }

  console.log(`备份文件: ${BACKUP_PATH}`);
  console.log('\n========== 清理完成 ==========');
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

main();
