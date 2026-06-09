'use strict';

/**
 * @module dashboard/data-providers/core-data
 * @description Dashboard核心数据提供模块，提供概览、Agent、技能、会话和工作流数据的异步获取与聚合
 */

const { safeJsonParse } = require('../../../utils/safe-parse');
const { FRONTMATTER_TRUE, parseArray, DEFAULT_TOKEN_BUDGET, SESSION_STATUS_ACTIVE, DEFAULT_ENFORCEMENT , HARNESS_DIR, MARKDOWN_EXT, JSON_EXT} = require('../../../utils/constants');
const debug = require('../../../utils/debug-logger')('CoreData');
const path = require('path');

/**
 * 递归验证对象嵌套深度
 * @param {*} obj - 待验证对象
 * @param {number} maxDepth - 最大深度
 * @returns {boolean} 是否在允许范围内
 * @private
 */
function _validateObjectDepth(obj, maxDepth, currentDepth) {
  if (currentDepth == null) currentDepth = 0;
  if (currentDepth > maxDepth) return false;
  if (!obj || typeof obj !== 'object') return true;
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (!_validateObjectDepth(obj[key], maxDepth, currentDepth + 1)) return false;
    }
  }
  return true;
}

/**
 * 获取项目概览数据，聚合配置、会话、Agent和技能统计
 * @param {object} server - DashboardServer实例
 * @returns {Promise<{project: string, version: string, agentCount: number, skillCount: number, totalSessions: number, activeSessions: number, tokensUsed: number, tokenBudget: number, tokenRatio: number, tddEnabled: boolean, coverageThreshold: number}>} 概览数据
 */
async function getOverview(server) {
  const config = await server._getConfig();
  const sessions = await server._getSessions();
  const agents = await server._getAgents();
  const skills = await server._getSkills();

  const activeSessions = sessions.filter(function(s) { return s.status === SESSION_STATUS_ACTIVE; });
  const totalTokens = sessions.reduce(function(sum, s) { return sum + (typeof s.tokensUsed === 'number' && Number.isFinite(s.tokensUsed) ? s.tokensUsed : 0); }, 0);
  const budget = typeof config.token_budget === 'number' && Number.isFinite(config.token_budget) ? config.token_budget : DEFAULT_TOKEN_BUDGET;

  const tddConfig = (config.gate_config && config.gate_config.tdd_gate) ?? config.tdd_config ?? {};
  const rawCovThreshold = typeof tddConfig.test_coverage_threshold === 'number' && Number.isFinite(tddConfig.test_coverage_threshold) ? tddConfig.test_coverage_threshold : 0;
  const coverageThreshold = rawCovThreshold <= 1 && rawCovThreshold > 0 ? Math.round(rawCovThreshold * 100) : rawCovThreshold;

  return {
    project: config.project_name ?? '\u591aAgent\u6846\u67b6\u9879\u76ee',
    version: config.version ?? '0.0.0',
    agentCount: agents.length,
    skillCount: skills.length,
    totalSessions: sessions.length,
    activeSessions: activeSessions.length,
    tokensUsed: totalTokens,
    tokenBudget: budget,
    tokenRatio: budget > 0 ? totalTokens / budget : 0,
    tddEnabled: tddConfig.enabled ?? false,
    coverageThreshold: coverageThreshold,
  };
}

/**
 * 获取Agent列表，从.harness/agents/目录解析Markdown Frontmatter
 * @param {object} server - DashboardServer实例
 * @returns {Promise<Array<{id: string, role: string, skills: string[], autoRoute: boolean, tddEnforced: boolean, enforcement: string, collaboratesWith: string[], manages: string[]}>>} Agent列表
 */
async function getAgents(server) {
  const agentsDir = path.join(server.root, HARNESS_DIR, 'agents');
  const files = await server._readDirCached(agentsDir, MARKDOWN_EXT);
  const agents = [];
  const rt = server._runtime;
  let agentStatuses = {};
  if (rt && rt.agentMonitor && typeof rt.agentMonitor.getAllStatuses === 'function') {
    try { agentStatuses = rt.agentMonitor.getAllStatuses() ?? {}; } catch (_e) { agentStatuses = {}; }
  }

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(agentsDir, files[i]);
    const fm = await server._getCachedFrontmatter(filePath);
    if (!fm) continue;
    const agentId = files[i].replace(MARKDOWN_EXT, '');
    agents.push({
      id: agentId,
      name: fm.name || fm.role || agentId,
      role: fm.role || agentId,
      status: agentStatuses[agentId] || 'idle',
      running: agentStatuses[agentId] === 'active' || agentStatuses[agentId] === 'running',
      skills: parseArray(fm.available_skills),
      autoRoute: fm.auto_route === FRONTMATTER_TRUE,
      tddEnforced: fm.tdd_enforced === FRONTMATTER_TRUE,
      enforcement: fm.enforcement || DEFAULT_ENFORCEMENT,
      collaboratesWith: parseArray(fm.collaborates_with),
      manages: parseArray(fm.manages),
    });
  }

  return agents;
}

/**
 * 获取技能列表，从.harness/skills/目录解析Markdown Frontmatter
 * @param {object} server - DashboardServer实例
 * @returns {Promise<Array<{id: string, name: string, phase: string, priority: number, enforcement: string, autoTrigger: boolean, dependsOn: string[], applicableAgents: string[], infrastructure: boolean, verified: boolean, stability: string, usageCount: number, successRate: number}>>} 技能列表
 */
async function getSkills(server) {
  const skillsDir = path.join(server.root, HARNESS_DIR, 'skills');
  const files = await server._readDirCached(skillsDir, MARKDOWN_EXT);
  const skills = [];

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(skillsDir, files[i]);
    const fm = await server._getCachedFrontmatter(filePath);
    if (!fm) continue;

    const isInfra = fm.infrastructure === FRONTMATTER_TRUE;
    const skillId = isInfra ? (fm.component_id || files[i].replace(MARKDOWN_EXT, '')) : (fm.skill_id || files[i].replace(MARKDOWN_EXT, ''));

    skills.push({
      id: skillId,
      name: fm.name || skillId,
      phase: fm.phase || '',
      priority: Number.isFinite(parseInt(fm.priority, 10)) ? parseInt(fm.priority, 10) : 0,
      enforcement: fm.enforcement || DEFAULT_ENFORCEMENT,
      autoTrigger: fm.auto_trigger === FRONTMATTER_TRUE,
      dependsOn: parseArray(fm.depends_on),
      applicableAgents: parseArray(fm.applicable_agents),
      infrastructure: isInfra,
      verified: fm.verified === FRONTMATTER_TRUE || fm.verified === true,
      stability: fm.stability || 'unverified',
      usageCount: Number.isFinite(parseInt(fm.usage_count, 10)) ? parseInt(fm.usage_count, 10) : 0,
      successRate: Number.isFinite(parseFloat(fm.success_rate)) ? parseFloat(fm.success_rate) : 0,
    });
  }

  return skills;
}

/**
 * 获取会话列表，从.harness/sessions/目录解析JSON文件
 * @param {object} server - DashboardServer实例
 * @returns {Promise<Array<object>>} 会话列表
 */
async function getSessions(server) {
  const sessionsDir = path.join(server.root, HARNESS_DIR, 'sessions');
  const files = await server._readDirCached(sessionsDir, JSON_EXT);
  const sessions = [];

  for (let i = 0; i < files.length; i++) {
    const content = await server._readFileCached(path.join(sessionsDir, files[i]));
    if (!content) continue;
    try {
      const s = safeJsonParse(content, null, 'CoreData');
      if (!_validateObjectDepth(s, 10)) continue;
      if (s.deepeningState && s.deepeningState.totalIterations !== undefined) {
        s.iterationCount = s.deepeningState.totalIterations;
      }
      sessions.push(s);
    } catch (err) {
      debug('CoreData', 'sessionParseError', err);
    }
  }

  return sessions;
}

/**
 * 获取工作流数据，聚合六阶段流程、技能完成状态和Agent分配信息
 * @param {object} server - DashboardServer实例
 * @param {object} CACHE_TTL - 缓存TTL配置
 * @returns {Promise<{phases: Array, currentPhase: string|null, completedSkills: string[], phaseBudgetAllocation: object}>} 工作流数据
 */
async function getWorkflow(server, CACHE_TTL) {
  const config = await server._getCached('config', CACHE_TTL.config, function() { return server._getConfig(); });
  const sessions = await server._getCached('sessions', CACHE_TTL.sessions, function() { return server._getSessions(); });
  const agents = await server._getCached('agents', CACHE_TTL.agents, function() { return server._getAgents(); });
  const skills = await server._getCached('skills', CACHE_TTL.skills, function() { return server._getSkills(); });
  const activeSession = sessions.find(function(s) { return s.status === SESSION_STATUS_ACTIVE; }) || (sessions.length > 0 ? sessions[sessions.length - 1] : null);

  const phases = [
    { id: 'brainstorming', name: '\u9700\u6c42\u63a2\u7d22', index: 0 },
    { id: 'requirement-analysis', name: '\u9700\u6c42\u5206\u6790\u4e0e\u89c4\u5212', index: 1 },
    { id: 'architecture-design', name: '\u67b6\u6784\u8bbe\u8ba1', index: 2 },
    { id: 'module-development', name: '\u6a21\u5757\u5f00\u53d1', index: 3 },
    { id: 'integration-testing', name: '\u96c6\u6210\u6d4b\u8bd5', index: 4 },
    { id: 'deployment', name: '\u90e8\u7f72\u4e0a\u7ebf', index: 5 },
  ];

  const currentPhaseIndex = activeSession
    ? phases.findIndex(function(p) { return p.id === activeSession.currentPhase; })
    : -1;

  const completedSkillsList = activeSession ? activeSession.completedSkills ?? [] : [];

  for (let pi = 0; pi < phases.length; pi++) {
    const phase = phases[pi];
    phase.status = phase.index < currentPhaseIndex ? 'completed'
      : phase.index === currentPhaseIndex ? 'active'
      : 'pending';

    const phaseSkills = skills.filter(function(s) { return s.phase === phase.id && !s.infrastructure; });

    if (activeSession && phase.index <= currentPhaseIndex) {
      const phaseSkillIds = phaseSkills.map(function(s) { return s.id; });
      phase.completedSkills = completedSkillsList.filter(function(s) { return phaseSkillIds.includes(s); });
    }

    const completedSet = new Set(Array.isArray(completedSkillsList) ? completedSkillsList : []);

    phase.skills = phaseSkills.map(function(s) {
      return {
        id: s.id,
        name: s.name,
        enforcement: s.enforcement,
        priority: s.priority,
        autoTrigger: s.autoTrigger,
        dependsOn: s.dependsOn,
        completed: completedSet.has(s.id),
        applicableAgents: s.applicableAgents,
      };
    });

    const agentIds = new Set();
    phaseSkills.forEach(function(s) {
      (s.applicableAgents ?? []).forEach(function(a) { agentIds.add(a); });
    });
    phase.agents = agents
      .filter(function(a) { return agentIds.has(a.id); })
      .map(function(a) {
        return {
          id: a.id,
          role: a.role,
          autoRoute: a.autoRoute,
          tddEnforced: a.tddEnforced,
          skillCount: a.skills.filter(function(sk) { return phaseSkills.some(function(ps) { return ps.id === sk; }); }).length,
        };
      });

    const budgetAlloc = (config.phase_budget_allocation ?? {})[phase.id];
    phase.budgetPercent = budgetAlloc ? Math.round(budgetAlloc * 100) : 0;
  }

  return {
    phases: phases,
    currentPhase: activeSession ? activeSession.currentPhase : null,
    completedSkills: completedSkillsList,
    phaseBudgetAllocation: config.phase_budget_allocation ?? {},
  };
}

module.exports = { getOverview, getAgents, getSkills, getSessions, getWorkflow };
