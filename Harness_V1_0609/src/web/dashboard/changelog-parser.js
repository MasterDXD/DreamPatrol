'use strict';

/**
 * @module dashboard/changelog-parser
 * @description 变更日志解析模块，提供版本匹配、段落搜索、迭代元数据解析和条目结构化提取功能
 */

const C = require('./constants');
const DANGEROUS_KEYS = require('../../utils/constants').DANGEROUS_KEYS;
const RE_CHANGELOG_VERSION_SRC = C.RE_CHANGELOG_VERSION_SRC;
const RE_CHANGELOG_SECTION_SRC = C.RE_CHANGELOG_SECTION_SRC;
const RE_ITERATION_META_SRC = C.RE_ITERATION_META_SRC;
const RE_CHANGELOG_ITEM_BOLD = C.RE_CHANGELOG_ITEM_BOLD;
const RE_CHANGELOG_MODULE = C.RE_CHANGELOG_MODULE;
const RE_CHANGELOG_METHOD = C.RE_CHANGELOG_METHOD;
const RE_CHANGELOG_VALUE = C.RE_CHANGELOG_VALUE;

/** @constant {RegExp} 全局版本号正则 */
const _reVersionGlobal = new RegExp(RE_CHANGELOG_VERSION_SRC, 'g');
/** @constant {RegExp} 全局段落正则 */
const _reSectionGlobal = new RegExp(RE_CHANGELOG_SECTION_SRC, 'g');
/** @constant {RegExp} 全局迭代元数据正则 */
const _reMetaGlobal = new RegExp(RE_ITERATION_META_SRC, 'g');

/**
 * 检查版本条目是否匹配关键词
 * @param {object} v - 版本条目对象
 * @param {string} keyword - 搜索关键词
 * @returns {boolean} 是否匹配
 */
function versionMatchesKeyword(v, keyword) {
  if ((v.version || '').toLowerCase().includes(keyword)) return true;
  if ((v.date || '').includes(keyword)) return true;
  if (sectionsMatchKeyword(v.sections ?? {}, keyword)) return true;
  const meta = v.meta ?? {};
  if ((meta.responsible || '').toLowerCase().includes(keyword)) return true;
  if ((meta.reviewer || '').toLowerCase().includes(keyword)) return true;
  return false;
}

/**
 * 检查段落集合中是否包含关键词
 * @param {object} sections - 段落对象，键为段落名，值为条目数组
 * @param {string} keyword - 搜索关键词
 * @returns {boolean} 是否匹配
 */
function sectionsMatchKeyword(sections, keyword) {
  for (const secName of Object.keys(sections)) {
    if (secName.includes(keyword)) return true;
    for (const item of sections[secName]) {
      if (itemMatchesKeyword(item, keyword)) return true;
    }
  }
  return false;
}

/**
 * 检查单个条目是否匹配关键词
 * @param {object} item - 条目对象
 * @param {string} keyword - 搜索关键词
 * @returns {boolean} 是否匹配
 */
function itemMatchesKeyword(item, keyword) {
  if ((item.title || '').toLowerCase().includes(keyword)) return true;
  if ((item.raw || '').toLowerCase().includes(keyword)) return true;
  if ((item.module || '').toLowerCase().includes(keyword)) return true;
  if ((item.value || '').toLowerCase().includes(keyword)) return true;
  if (item.subItems && item.subItems.some(function(s) { return String(s).toLowerCase().includes(keyword); })) return true;
  return false;
}

/**
 * 解析迭代元数据（HTML注释中的key-value对）
 * @param {string} body - 变更日志文本
 * @returns {{iterationRound: number, cumulativeIterations: number, startTime: string, endTime: string, durationHours: number, tokenTotal: number, tokenBreakdown: object, responsible: string, reviewer: string}} 迭代元数据
 */
function parseIterationMeta(body) {
  const meta = {
    iterationRound: 0,
    cumulativeIterations: 0,
    startTime: '',
    endTime: '',
    durationHours: 0,
    tokenTotal: 0,
    tokenBreakdown: {},
    responsible: '',
    reviewer: '',
  };

  const META_PARSERS = {
    iteration_round: (v) => { const n = parseInt(v, 10); meta.iterationRound = Number.isFinite(n) ? n : 0; },
    cumulative_iterations: (v) => { const n = parseInt(v, 10); meta.cumulativeIterations = Number.isFinite(n) ? n : 0; },
    start_time: (v) => { meta.startTime = v; },
    end_time: (v) => { meta.endTime = v; },
    duration_hours: (v) => { const n = parseFloat(v); meta.durationHours = Number.isFinite(n) ? n : 0; },
    token_total: (v) => { const n = parseInt(v, 10); meta.tokenTotal = Number.isFinite(n) ? n : 0; },
    token_breakdown: (v) => { meta.tokenBreakdown = parseTokenBreakdown(v); },
    responsible: (v) => { meta.responsible = v; },
    reviewer: (v) => { meta.reviewer = v; },
  };

  _reMetaGlobal.lastIndex = 0;
  const reMeta = _reMetaGlobal;
  let m;
  while ((m = reMeta.exec(body)) !== null) {
    if (m[0].length === 0) { reMeta.lastIndex++; continue; }
    const parser = META_PARSERS[m[1]];
    if (parser) parser(m[2].trim());
  }

  return meta;
}

/**
 * 解析Token分布字符串（逗号分隔的key-value对，如"input-100,output-200"）
 * @param {string} val - Token分布字符串
 * @returns {Object<string, number>} Token分布键值对
 */
function parseTokenBreakdown(val) {
  const result = Object.create(null);
  if (!val || typeof val !== 'string') return result;
  if (val.length > 1024) val = val.slice(0, 1024);
  const parts = val.split(',');
  const limit = Math.min(parts.length, 50);
  for (let i = 0; i < limit; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    const lastDash = part.lastIndexOf('-');
    if (lastDash > 0 && lastDash < part.length - 1) {
      const key = part.slice(0, lastDash).trim();
      const valueStr = part.slice(lastDash + 1).trim();
      if (DANGEROUS_KEYS.has(key)) continue;
      if (!/^[a-zA-Z0-9_-]+$/.test(key)) continue;
      const num = parseInt(valueStr, 10);
      if (isNaN(num) || num < 0) continue;
      result[key] = num;
    }
  }
  return result;
}

/**
 * 解析单个变更日志条目，提取标题、模块、实现方式和业务价值
 * @param {string} text - 条目原始文本
 * @returns {{raw: string, title: string, module: string, method: string, value: string, files: Array, subItems: Array}} 结构化条目
 */
function parseChangelogItem(text) {
  const item = {
    raw: text.replace(/^- /, ''),
    title: '',
    module: '',
    method: '',
    value: '',
    files: [],
    subItems: [],
  };

  const boldMatch = RE_CHANGELOG_ITEM_BOLD.exec(text);
  if (boldMatch) {
    item.title = boldMatch[1];
  }

  const modMatch = RE_CHANGELOG_MODULE.exec(text);
  if (modMatch) {
    item.module = modMatch[1];
  }

  const methodMatch = RE_CHANGELOG_METHOD.exec(text);
  if (methodMatch) {
    item.method = methodMatch[1];
  }

  const valueMatch = RE_CHANGELOG_VALUE.exec(text);
  if (valueMatch) {
    item.value = valueMatch[1];
  }

  return item;
}

module.exports = {
  versionMatchesKeyword,
  sectionsMatchKeyword,
  itemMatchesKeyword,
  parseIterationMeta,
  parseTokenBreakdown,
  parseChangelogItem,
};
