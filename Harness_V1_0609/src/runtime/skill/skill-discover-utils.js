'use strict';

const fs = require('fs');
const path = require('path');
const { generateSkillSummary, HARNESS_DIR, MARKDOWN_EXT, estimateTokens, parseArray } = require('../../utils/constants');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const { scanMarkdownDirSync, scanMarkdownDirAsync, parseMarkdownFile, parseMarkdownFileAsync } = require('../../utils/fs-utils');
const { isPathWithinDir } = require('../../utils/path-utils');

const TAG_MIN_PART_LENGTH = 2;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  'has', 'had', 'not', 'this', 'that', 'which', 'who', 'whom', 'its',
  'all', 'no', 'nor', 'so', 'if', 'than', 'too', 'very', 'can', 'will',
  'just', 'should', 'now', 'also', 'been', 'being', 'do', 'does', 'did',
  'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'then',
  'there', 'these', 'they', 'we', 'what', 'when', 'where', 'how', 'each',
  'every', 'both', 'few', 'many', 'much', 'any', 'into', 'over', 'after',
  'before', 'between', 'under', 'again', 'further', 'once', 'here',
  'about', 'up', 'out', 'off', 'down',
]);

/**
 * @module runtime/skill/skill-discover-utils
 * 从技能ID中提取标签（按-和_分隔）
 * @param {string} skillId - 技能ID
 * @returns {string[]} 提取的标签列表
 */
function extractTagsFromSkillName(skillId) {
  const tags = [];
  const parts = skillId.split(/[-_]/);
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower.length >= TAG_MIN_PART_LENGTH) {
      tags.push(lower);
    }
  }
  return tags;
}

/**
 * 从触发条件中提取标签（优先提取引号内容，否则按单词分割并过滤停用词）
 * @param {string[]} conditions - 触发条件数组
 * @returns {string[]} 提取的标签列表
 */
function extractTagsFromTriggerConditions(conditions) {
  const tags = [];
  if (!Array.isArray(conditions)) return tags;
  for (const cond of conditions) {
    if (typeof cond !== 'string') continue;
    const quoted = [];
    const regex = /[""\u201c\u201d]([^""\u201c\u201d]+)[""\u201c\u201d]/g;
    let m;
    while ((m = regex.exec(cond)) !== null) {
      if (m[1] && m[1].length >= TAG_MIN_PART_LENGTH) {
        quoted.push(m[1].toLowerCase());
      }
    }
    if (quoted.length > 0) {
      tags.push(...quoted);
      continue;
    }
    const words = cond.split(/\s+/);
    for (const word of words) {
      const lower = word.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
      if (lower.length >= TAG_MIN_PART_LENGTH && !STOP_WORDS.has(lower)) {
        tags.push(lower);
      }
    }
  }
  return tags;
}

/**
 * 从适用Agent列表中提取标签（Agent名及其子部分）
 * @param {string[]} agents - Agent名称数组
 * @returns {string[]} 提取的标签列表
 */
function extractTagsFromApplicableAgents(agents) {
  const tags = [];
  if (!Array.isArray(agents)) return tags;
  for (const agent of agents) {
    if (typeof agent !== 'string') continue;
    const lower = agent.toLowerCase();
    tags.push(lower);
    const parts = lower.split(/[-_]/);
    for (const part of parts) {
      if (part.length >= TAG_MIN_PART_LENGTH && part !== lower) {
        tags.push(part);
      }
    }
  }
  return tags;
}

/**
 * 综合提取技能标签（frontmatter标签+技能名+触发条件+适用Agent+阶段）
 * @param {string} file - 文件名（含.md后缀）
 * @param {Object} fm - 解析后的frontmatter对象
 * @returns {string[]} 去重后的标签列表
 */
function extractTags(file, fm) {
  const tagSet = new Set();

  const frontmatterTags = parseArray(fm.tags);
  for (const t of frontmatterTags) {
    tagSet.add(t.toLowerCase());
  }

  const skillId = file.replace(MARKDOWN_EXT, '');
  const nameTags = extractTagsFromSkillName(skillId);
  for (const t of nameTags) {
    tagSet.add(t);
  }

  const triggerTags = extractTagsFromTriggerConditions(parseArray(fm.trigger_conditions));
  for (const t of triggerTags) {
    tagSet.add(t);
  }

  const agentTags = extractTagsFromApplicableAgents(parseArray(fm.applicable_agents));
  for (const t of agentTags) {
    tagSet.add(t);
  }

  if (fm.phase && typeof fm.phase === 'string') {
    tagSet.add(fm.phase.toLowerCase());
  }

  return Array.from(tagSet);
}

/**
 * 同步扫描技能目录下的Markdown文件
 * @param {string} skillsDir - 技能目录路径
 * @param {string} moduleLabel - 模块标签（用于日志）
 * @param {EventEmitter} [emitter] - 事件发射器（用于错误事件）
 * @returns {string[]|null} 文件名列表，目录不存在或出错时返回null
 */
function scanSkillFilesSync(skillsDir, moduleLabel, emitter) {
  if (!fs.existsSync(skillsDir)) return null;

  let files;
  try {
    files = scanMarkdownDirSync(skillsDir);
  } catch (err) {
    debug(moduleLabel, 'discover readdir', err);
    if (emitter) emitError(emitter, 'discover-error', err, { phase: 'readdir' });
    return null;
  }

  return files;
}

/**
 * 异步扫描技能目录下的Markdown文件
 * @param {string} skillsDir - 技能目录路径
 * @param {string} moduleLabel - 模块标签（用于日志）
 * @param {EventEmitter} [emitter] - 事件发射器（用于错误事件）
 * @returns {Promise<string[]|null>} 文件名列表，目录不存在或出错时返回null
 */
async function scanSkillFilesAsync(skillsDir, moduleLabel, emitter) {
  try {
    await fs.promises.access(skillsDir);
  } catch (err) {
    debug(moduleLabel, 'discoverAsync: skills dir not accessible', err && err.message ? err.message : String(err));
    return null;
  }

  let files;
  try {
    files = await scanMarkdownDirAsync(skillsDir);
  } catch (err) {
    debug(moduleLabel, 'discoverAsync readdir', err);
    if (emitter) emitError(emitter, 'discover-error', err, { phase: 'readdir' });
    return null;
  }

  return files;
}

/**
 * 同步解析技能Markdown文件，提取内容和frontmatter
 * @param {string} filePath - 文件绝对路径
 * @returns {{ content: string, fm: Object }} 解析结果
 */
function parseSkillFileSync(filePath) {
  const parsed = parseMarkdownFile(filePath);
  if (!parsed) return { content: '', fm: null };
  const { content, frontmatter: fm } = parsed;
  return { content, fm };
}

/**
 * 异步解析技能Markdown文件，提取内容和frontmatter
 * @param {string} filePath - 文件绝对路径
 * @returns {Promise<{ content: string, fm: Object }>} 解析结果
 */
async function parseSkillFileAsync(filePath) {
  const parsed = await parseMarkdownFileAsync(filePath);
  if (!parsed) return { content: '', fm: null };
  const { content, frontmatter: fm } = parsed;
  return { content, fm };
}

/**
 * 构建技能基础条目对象（L1摘要层）
 * @param {string} file - 文件名（含.md后缀）
 * @param {Object} fm - 解析后的frontmatter对象
 * @param {string} content - 文件完整内容
 * @param {string} filePath - 文件绝对路径
 * @param {number} [summaryMaxLength] - 摘要最大长度
 * @returns {{ skill_id: string, name: string, summary: string, phase: string, priority: number, enforcement: string, applicable_agents: Array, infrastructure: boolean, tags: string[], _filePath: string, _fullContentLength: number }} 技能条目
 */
function buildBaseSkillEntry(file, fm, content, filePath, summaryMaxLength) {
  const skillId = file.replace(MARKDOWN_EXT, '');
  const isInfra = fm.component_id !== undefined || fm.type === 'infrastructure';
  const summary = fm.summary || generateSkillSummary(fm, content, summaryMaxLength);
  const resolvedId = isInfra ? fm.component_id : (fm.skill_id || skillId);
  const tags = extractTags(file, fm);

  return {
    skill_id: resolvedId,
    name: fm.name || skillId,
    summary,
    phase: fm.phase || '',
    priority: Number.isFinite(parseInt(fm.priority, 10)) ? parseInt(fm.priority, 10) : 0,
    enforcement: fm.enforcement || 'recommended',
    applicable_agents: [],
    infrastructure: isInfra,
    tags,
    _filePath: filePath,
    _fullContentLength: content.length,
  };
}

/**
 * 获取技能目录路径
 * @param {string} projectRoot - 项目根目录
 * @returns {string} 技能目录绝对路径
 */
function getSkillsDir(projectRoot) {
  return path.join(projectRoot, HARNESS_DIR, 'skills');
}

/**
 * 解析技能资源文件路径，默认指向references/index.md
 * @param {string} skillFilePath - 技能文件绝对路径
 * @param {string} [resourcePath] - 资源相对路径
 * @returns {string} 资源文件绝对路径
 */
function resolveResourcePath(skillFilePath, resourcePath) {
  const skillDir = path.dirname(skillFilePath);
  if (resourcePath) {
    return path.join(skillDir, resourcePath);
  }
  return path.join(skillDir, 'references', 'index.md');
}

/**
 * 构建L3资源层条目对象
 * @param {string} skillId - 技能ID
 * @param {string} [resourcePath] - 资源相对路径
 * @param {string} content - 资源文件内容
 * @returns {{ skill_id: string, resourcePath: string, content: string, loadedAt: number, tokenEstimate: number }} L3条目
 */
function buildL3Entry(skillId, resourcePath, content) {
  return {
    skill_id: skillId,
    resourcePath: resourcePath || 'references/index.md',
    content,
    loadedAt: Date.now(),
    tokenEstimate: estimateTokens(content),
  };
}

/**
 * Scan for broken symlinks in the skills directory
 * @param {string} skillsDir - Path to skills directory
 * @param {object} [options] - Options
 * @param {string} [options.rootDir] - Root directory for path traversal protection
 * @param {number} [options.depth] - Current recursion depth (internal)
 * @param {number} [options.maxDepth=10] - Maximum recursion depth
 * @returns {Array<{path: string, target: string, type: string}>}
 */
function detectBrokenSymlinks(skillsDir, options = {}) {
  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? 10;
  const rootDir = options.rootDir || skillsDir;
  if (depth > maxDepth) return [];
  if (rootDir && typeof isPathWithinDir === 'function' && !isPathWithinDir(skillsDir, rootDir)) {
    return [];
  }

  const broken = [];
  if (!fs.existsSync(skillsDir)) return broken;

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(skillsDir, entry.name);

    try {
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath);
        const resolvedTarget = path.resolve(path.dirname(fullPath), target);
        if (!fs.existsSync(resolvedTarget)) {
          broken.push({ path: fullPath, target, type: 'broken-symlink' });
        }
      }
    } catch (_e) {
      // lstat/readlink failure indicates a broken symlink on some platforms
      broken.push({ path: fullPath, target: '(unreadable)', type: 'broken-symlink' });
    }

    // Recurse into subdirectories
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      try {
        const subStat = fs.lstatSync(fullPath);
        if (subStat.isDirectory()) {
          broken.push(...detectBrokenSymlinks(fullPath, { ...options, depth: depth + 1 }));
        }
      } catch (_e) { debug('skill-discover-utils', 'detectBrokenSymlinks:skip-dir', _e && _e.message ? _e.message : String(_e)); }
    }
  }

  return broken;
}

module.exports = {
  scanSkillFilesSync,
  scanSkillFilesAsync,
  parseSkillFileSync,
  parseSkillFileAsync,
  buildBaseSkillEntry,
  getSkillsDir,
  resolveResourcePath,
  buildL3Entry,
  extractTags,
  extractTagsFromSkillName,
  extractTagsFromTriggerConditions,
  extractTagsFromApplicableAgents,
  detectBrokenSymlinks,
};
