#!/usr/bin/env node
'use strict';

/**
 * mark-deprecated.js — 扫描 src/ 目录，找出未被任何其他源文件 require 的孤立模块，
 * 并为其添加 @deprecated JSDoc 标记。
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── 不标记为 deprecated 的文件（入口点或动态加载） ───
const PROTECTED_FILES = new Set([
  'src/index.js',
  'src/harness-cli.js',
]);
const PROTECTED_DIRS = [
  path.join(SRC_DIR, 'web') + path.sep,
  path.join(SRC_DIR, 'gate') + path.sep,
];

function isProtected(relPath) {
  if (PROTECTED_FILES.has(relPath)) return true;
  const absPath = path.join(PROJECT_ROOT, relPath);
  for (const dir of PROTECTED_DIRS) {
    if (absPath.startsWith(dir)) return true;
  }
  return false;
}

// ─── 1. 递归收集 src/ 下所有 .js 文件 ───
function collectJsFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

// ─── 2. 将绝对路径转为项目相对路径 ───
function toRel(absPath) {
  return path.relative(PROJECT_ROOT, absPath).replace(/\\/g, '/');
}

// ─── 3. 从文件内容提取 require 路径 ───
function extractRequirePaths(content, filePath) {
  const requires = new Set();
  // 匹配 require('...') 和 require("...")
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const reqPath = match[1];
    // 仅处理相对路径 require
    if (reqPath.startsWith('.')) {
      const dir = path.dirname(filePath);
      const resolved = path.resolve(dir, reqPath);
      // 尝试 .js 后缀
      const candidates = [resolved + '.js', resolved];
      if (resolved.endsWith(path.sep + 'index') || resolved.endsWith('/index')) {
        candidates.push(path.join(resolved, 'index.js'));
      }
      // 也尝试目录下的 index.js
      candidates.push(resolved + path.sep + 'index.js');
      for (const c of candidates) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          requires.add(c);
          break;
        }
      }
    }
  }
  return requires;
}

// ─── 4. 检查模块名是否在动态注册文件中出现 ───
function checkDynamicRegistration(moduleName, dynamicContents) {
  for (const content of dynamicContents) {
    if (content.includes(moduleName)) return true;
  }
  return false;
}

// ─── 5. 添加 @deprecated 标记 ───
function addDeprecatedTag(content, moduleRelPath) {
  const moduleName = moduleRelPath.replace(/^src\//, '').replace(/\.js$/, '');
  const deprecatedLine = ' * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除';

  // 检查是否已有 @deprecated
  if (content.includes('@deprecated')) return content;

  // 查找文件顶部的 @module JSDoc 注释块
  const moduleCommentRe = /\/\*\*[\s\S]*?@module[\s\S]*?\*\//;
  const match = content.match(moduleCommentRe);

  if (match) {
    // 在已有的 @module JSDoc 块中，在 */ 之前插入 @deprecated
    const commentBlock = match[0];
    const newCommentBlock = commentBlock.replace(/\s*\*\/\s*$/, '\n' + deprecatedLine + '\n */');
    return content.replace(commentBlock, newCommentBlock);
  }

  // 没有 @module 注释块，在文件顶部添加
  const newBlock = '/**\n * @module ' + moduleName + '\n' + deprecatedLine + '\n */\n';
  return newBlock + content;
}

// ─── 主流程 ───
function main() {
  console.log('=== 孤立模块扫描与 @deprecated 标记工具 ===\n');

  // 收集所有 .js 文件
  const allFiles = collectJsFiles(SRC_DIR);
  console.log('扫描到 %d 个 .js 文件\n', allFiles.length);

  // 读取所有文件内容
  const fileContents = new Map();
  for (const fp of allFiles) {
    fileContents.set(fp, fs.readFileSync(fp, 'utf-8'));
  }

  // 读取动态注册文件
  const dynamicFiles = [
    path.join(SRC_DIR, 'index.js'),
    path.join(SRC_DIR, 'runtime', 'infrastructure', 'module-initializer.js'),
  ];
  const dynamicContents = [];
  for (const df of dynamicFiles) {
    if (fs.existsSync(df)) {
      dynamicContents.push(fs.readFileSync(df, 'utf-8'));
    }
  }

  // 构建 require 关系图：被谁 require
  const requiredBy = new Map(); // absPath -> Set<absPath>
  for (const [fp, content] of fileContents) {
    const reqs = extractRequirePaths(content, fp);
    for (const req of reqs) {
      if (!requiredBy.has(req)) requiredBy.set(req, new Set());
      requiredBy.get(req).add(fp);
    }
  }

  // 分类
  const alive = [];         // 被 require 的文件
  const dynamicAlive = [];  // 未被 require 但在动态注册中出现
  const dead = [];          // 孤立模块

  for (const fp of allFiles) {
    const relPath = toRel(fp);
    const moduleName = relPath.replace(/^src\//, '').replace(/\.js$/, '');

    // 受保护的文件跳过
    if (isProtected(relPath)) {
      alive.push({ path: relPath, reason: '受保护（入口点/动态加载）' });
      continue;
    }

    const refs = requiredBy.get(fp);
    if (refs && refs.size > 0) {
      // 被 require 了
      alive.push({ path: relPath, reason: '被 ' + refs.size + ' 个文件引用' });
    } else if (checkDynamicRegistration(moduleName, dynamicContents)) {
      // 动态注册
      dynamicAlive.push({ path: relPath, reason: '在 index.js 或 module-initializer.js 中动态注册' });
    } else {
      dead.push({ path: relPath, reason: '无引用，无动态注册' });
    }
  }

  // 添加 @deprecated 标记
  let markedCount = 0;
  for (const item of dead) {
    const absPath = path.join(PROJECT_ROOT, item.path);
    const content = fs.readFileSync(absPath, 'utf-8');
    const newContent = addDeprecatedTag(content, item.path);
    if (newContent !== content) {
      fs.writeFileSync(absPath, newContent, 'utf-8');
      markedCount++;
      console.log('  [DEPRECATED] %s', item.path);
    } else {
      console.log('  [SKIP] %s (已有 @deprecated)', item.path);
    }
  }

  // 打印汇总
  console.log('\n=== 汇总报告 ===');
  console.log('扫描文件总数:       %d', allFiles.length);
  console.log('正常引用（存活）:   %d', alive.length);
  console.log('动态注册（存活）:   %d', dynamicAlive.length);
  console.log('标记 @deprecated:   %d (本次新增 %d)', dead.length, markedCount);

  if (dynamicAlive.length > 0) {
    console.log('\n--- 动态注册存活模块 ---');
    for (const item of dynamicAlive) {
      console.log('  %s', item.path);
    }
  }

  if (dead.length > 0) {
    console.log('\n--- 已标记 @deprecated 的孤立模块 ---');
    for (const item of dead) {
      console.log('  %s', item.path);
    }
  }
}

main();
