'use strict';

/**
 * @module dashboard/data-providers/core-query-data
 * @description DashboardServer核心查询数据提供者mixin。
 * 提取自server.js中独立的GET数据提供者方法，包括Changelog、Audit、Memory、
 * Checkpoints、Learnings、Deviations、CodeReviews等。
 */

const path = require('path');
const { debug } = require('../../../utils/debug-logger');
const { _apiError } = require('../utils');
const C = require('../constants');

const VALID_DEVIATION_STATUSES = C.VALID_DEVIATION_STATUSES;
const VALID_REVIEW_STATUSES = C.VALID_REVIEW_STATUSES;
const RE_CHANGELOG_VERSION_SRC = C.RE_CHANGELOG_VERSION_SRC;
const RE_CHANGELOG_SECTION_SRC = C.RE_CHANGELOG_SECTION_SRC;
const MAX_AGENT_HISTORY = C.MAX_AGENT_HISTORY;
const MAX_API_LIST_ITEMS = C.MAX_API_LIST_ITEMS;

const RE_CHANGELOG_VERSION = new RegExp(RE_CHANGELOG_VERSION_SRC, 'g');
const RE_CHANGELOG_SECTION = new RegExp(RE_CHANGELOG_SECTION_SRC, 'g');

/**
 * 混入Changelog相关方法
 * @param {Function} DashboardServer - DashboardServer类
 * @param {Object} ChangelogParser - Changelog解析器
 */
function _applyChangelogMixin(DashboardServer, ChangelogParser) {
  DashboardServer.prototype._getChangelog = async function() {
    const changelogPath = path.join(this.root, 'CHANGELOG.md');
    const content = await this._readFileCached(changelogPath);
    if (!content) return [];
    if (content.length > C.MAX_CHANGELOG_INPUT_LENGTH) {
      debug('Dashboard', 'parseChangelog', 'Changelog exceeds max input length: ' + content.length);
      return [];
    }

    const versions = [];
    RE_CHANGELOG_VERSION.lastIndex = 0;
    let match;

    while ((match = RE_CHANGELOG_VERSION.exec(content)) !== null) {
      if (match[0].length === 0) { RE_CHANGELOG_VERSION.lastIndex++; continue; }
      const version = match[1];
      const date = match[2] || '';
      const body = match[3].trim();

      const meta = ChangelogParser.parseIterationMeta(body);

      const sections = this._parseChangelogSections(body);
      versions.push({
        version: version,
        date: date,
        meta: meta,
        sections: sections,
      });
    }

    return versions;
  };

  DashboardServer.prototype._parseChangelogSections = function(body) {
    const sections = {};
    RE_CHANGELOG_SECTION.lastIndex = 0;
    let secMatch;
    while ((secMatch = RE_CHANGELOG_SECTION.exec(body)) !== null) {
      if (secMatch[0].length === 0) { RE_CHANGELOG_SECTION.lastIndex++; continue; }
      const sectionTitle = secMatch[1];
      const sectionBody = secMatch[2].trim();
      const items = [];
      const lines = sectionBody.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const trimmed = lines[li].trim();
        if (trimmed.startsWith('- **')) {
          const item = ChangelogParser.parseChangelogItem(trimmed);
          items.push(item);
        } else if (trimmed.startsWith('- ') && items.length > 0) {
          const lastItem = items[items.length - 1];
          if (lastItem && lastItem.subItems) lastItem.subItems.push(trimmed.replace(/^- /, ''));
        }
      }
      sections[sectionTitle] = items;
    }
    return sections;
  };

  DashboardServer.prototype._searchChangelog = async function(params) {
    const versions = await this._getCached('changelog', C.CACHE_TTL.changelog, () => this._getChangelog());
    const keyword = (params.get('keyword') ?? '').toLowerCase();
    const category = params.get('category') ?? '';
    const sinceRaw = params.get('since') ?? '';
    const untilRaw = params.get('until') ?? '';
    const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
    const since = DATE_PATTERN.test(sinceRaw) ? sinceRaw : '';
    const until = DATE_PATTERN.test(untilRaw) ? untilRaw : '';
    const page = Math.max(1, this._parseIntParam(params, 'page', 1));
    const pageSize = Math.min(C.MAX_PAGE_SIZE, Math.max(1, this._parseIntParam(params, 'pageSize', 10)));

    let results = versions;

    if (keyword) {
      results = results.filter(v => ChangelogParser.versionMatchesKeyword(v, keyword));
    }

    if (category) {
      results = results.filter(v => {
        const sections = v.sections ?? {};
        return Object.keys(sections).some(k => k === category && sections[k].length > 0);
      });
    }

    if (since) {
      results = results.filter(v => (v.date || '') >= since);
    }

    if (until) {
      results = results.filter(v => (v.date || '') <= until);
    }

    const total = results.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const paged = results.slice(start, start + pageSize);

    return {
      total: total,
      page: page,
      pageSize: pageSize,
      totalPages: totalPages,
      items: paged,
    };
  };
}

/**
 * 混入Audit/Memory/Checkpoints/Learnings/Deviations/CodeReviews方法
 * @param {Function} DashboardServer - DashboardServer类
 */
function _applyCoreDataMixin(DashboardServer) {
  DashboardServer.prototype._getAudit = async function() {
    const sessions = await this._getSessions();
    const actions = [];

    for (let si = 0; si < sessions.length; si++) {
      const session = sessions[si];
      if (session.agentHistory) {
        for (let ai = 0; ai < session.agentHistory.length; ai++) {
          const entry = session.agentHistory[ai];
          if (!entry) continue;
          actions.push({
            timestamp: entry.timestamp,
            ts: (function() { const timestamp = new Date(entry.timestamp).getTime(); return isNaN(timestamp) ? 0 : timestamp; })(),
            agentId: entry.agent ?? 'unknown',
            action: entry.action ?? 'unknown',
            target: entry.target ?? entry.skillId ?? '',
            result: entry.result ?? 'allowed',
            details: entry.details ?? '',
          });
        }
      }
    }

    actions.sort(function(a, b) { return b.ts - a.ts; });
    for (let i = 0; i < actions.length; i++) delete actions[i].ts;
    return actions.slice(0, MAX_AGENT_HISTORY);
  };

  DashboardServer.prototype._getMemory = function() {
    let stats = {};
    let knowledge = [];
    let summaries = [];
    try { stats = this._memoryStore.getStats(); } catch (_e) { debug('server', '_getMemory', 'getStats failed:', _e && _e.message ? _e.message : String(_e)); stats = {}; }
    try { knowledge = this._memoryStore.queryKnowledge({}) ?? []; } catch (_e) { debug('server', '_getMemory', 'queryKnowledge failed:', _e && _e.message ? _e.message : String(_e)); knowledge = []; }
    try { summaries = this._memoryStore.querySummaries({}) ?? []; } catch (_e) { debug('server', '_getMemory', 'querySummaries failed:', _e && _e.message ? _e.message : String(_e)); summaries = []; }
    return {
      stats,
      recentKnowledge: knowledge.slice(-20),
      recentSummaries: summaries.slice(-10),
    };
  };

  DashboardServer.prototype._getCheckpoints = function(params) {
    const sessionId = params ? (params.get('sessionId') ?? '') : '';
    if (sessionId && !/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
      return _apiError('Invalid sessionId format', 400);
    }
    let checkpoints = [];
    try { checkpoints = this._checkpointManager.list(sessionId || undefined) ?? []; } catch (_e) { debug('server', '_getCheckpoints', 'list failed:', _e && _e.message ? _e.message : String(_e)); checkpoints = []; }
    return {
      sessionId: sessionId || null,
      count: checkpoints.length,
      checkpoints: checkpoints.slice(0, MAX_API_LIST_ITEMS),
    };
  };

  DashboardServer.prototype._getLearnings = function(params) {
    const skillId = params ? (params.get('skillId') ?? '') : '';
    if (skillId && !/^[a-zA-Z0-9_-]{1,64}$/.test(skillId)) {
      return _apiError('Invalid skillId format', 400);
    }
    let learnings = [];
    try {
      learnings = skillId
        ? this._skillImprover.getLearnings(skillId)
        : this._skillImprover.getLearnings();
    } catch (_e) { debug('server', '_getLearnings', 'getLearnings failed:', _e && _e.message ? _e.message : String(_e)); learnings = []; }
    let stats = {};
    try { stats = this._skillImprover.getStats(); } catch (_e) { debug('server', '_getLearnings', 'getStats failed:', _e && _e.message ? _e.message : String(_e)); stats = {}; }
    return {
      stats,
      skillId: skillId || null,
      count: learnings.length,
      learnings: learnings.slice(0, MAX_API_LIST_ITEMS),
    };
  };

  DashboardServer.prototype._getWorkflowTemplates = function() {
    const templates = this._workflowTemplate.list();
    return {
      count: templates.length,
      templates,
    };
  };

  DashboardServer.prototype._getCompliance = function() {
    return this._getCached('compliance', C.CACHE_TTL.compliance, async () => {
      await this._complianceChecker.checkProject();
      return this._complianceChecker.getSummary();
    });
  };

  DashboardServer.prototype._getDeviations = function(params) {
    const status = params ? params.get('status') : null;
    if (status && !VALID_DEVIATION_STATUSES.has(status)) {
      return _apiError('Invalid status filter', 400);
    }
    let stats = {};
    try { stats = this._deviationApproval.getStats(); } catch (_) { debug('server', '_getDeviations', 'getStats failed:', _ && _.message ? _.message : String(_)); stats = { total: 0, byStatus: {}, bySeverity: {} }; }

    let allDeviations;
    try {
      if (status === 'pending') {
        allDeviations = this._deviationApproval.getPending();
      } else if (status === 'approved') {
        allDeviations = this._deviationApproval.getApproved();
      } else if (status === 'rejected') {
        allDeviations = this._deviationApproval.getRejected();
      } else {
        allDeviations = [
          ...this._deviationApproval.getPending(),
          ...this._deviationApproval.getApproved(),
          ...this._deviationApproval.getRejected(),
        ];
      }
    } catch (_e) { debug('server', '_getDeviations', 'list failed:', _e && _e.message ? _e.message : String(_e)); allDeviations = []; }

    const mapped = allDeviations.map(function(d) {
      return {
        id: d.id,
        description: d.reason || '',
        rule: d.ruleId || '',
        requester: d.requestedBy || '',
        approver: d.reviewedBy || '',
        reason: d.proposedAlternative || '',
        status: d.status,
        severity: d.severity || '',
        createdAt: d.requestedAt || '',
        expiresAt: d.expiresAt || '',
      };
    });

    if (status) {
      return { total: mapped.length, byStatus: stats.byStatus, deviations: mapped };
    }
    return {
      total: stats.total,
      byStatus: stats.byStatus,
      bySeverity: stats.bySeverity,
      deviations: mapped,
    };
  };

  DashboardServer.prototype._getCodeReviews = function(params) {
    const status = params ? params.get('status') : null;
    if (status && !VALID_REVIEW_STATUSES.has(status)) {
      return _apiError('Invalid status filter', 400);
    }
    let stats = {};
    try { stats = this._codeReviewCheck.getStats(); } catch (_e) { debug('server', '_getCodeReviews', 'getStats failed:', _e && _e.message ? _e.message : String(_e)); stats = { total: 0, byStatus: {}, byVerdict: {} }; }

    let allReviews;
    try {
      if (status && VALID_REVIEW_STATUSES.has(status)) {
        allReviews = this._codeReviewCheck.getReviewsByStatus(status);
      } else {
        allReviews = Array.from(VALID_REVIEW_STATUSES).reduce(function(acc, s) {
          return acc.concat(this._codeReviewCheck.getReviewsByStatus(s));
        }.bind(this), []);
      }
    } catch (_e) { debug('server', '_getCodeReviews', 'list failed:', _e && _e.message ? _e.message : String(_e)); allReviews = []; }

    const mapped = allReviews.map(function(r) {
      return {
        id: r.id,
        title: r.description || '',
        filePath: Array.isArray(r.targetFiles) ? r.targetFiles.join(', ') : (r.targetFiles || ''),
        reviewer: r.reviewer || '',
        status: r.status,
        verdict: r.verdict || '',
        createdAt: r.createdAt || '',
      };
    });

    if (status) {
      return { total: mapped.length, byStatus: stats.byStatus, reviews: mapped };
    }
    return {
      total: stats.total,
      byStatus: stats.byStatus,
      byVerdict: stats.byVerdict,
      reviews: mapped,
    };
  };
}

/**
 * 将核心查询数据方法混入DashboardServer原型
 * @param {Function} DashboardServer - DashboardServer类
 * @param {Object} deps - 依赖注入
 * @param {Function} deps.ChangelogParser - Changelog解析器
 */
function applyCoreQueryDataMixin(DashboardServer, deps) {
  _applyChangelogMixin(DashboardServer, deps.ChangelogParser);
  _applyCoreDataMixin(DashboardServer);
}

module.exports = { applyCoreQueryDataMixin };
