/**
 * @module dynamic-agent-spawner
 * @description 动态Agent生成器 — 融合Claude Code扩展功能的动态Agent创建机制。
 * 支持从自然语言任务描述自动生成Agent配置，填补Harness框架在
 * 动态Agent创建方面的空白。提供模板匹配、任务分类和配置推导能力。
 */
'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');

const AGENT_TEMPLATES = {
  code_reviewer: {
    role: 'code-reviewer',
    capabilities: ['code-review', 'security-audit', 'quality-assessment'],
    modelTier: 'medium',
    maxTokens: 50000,
    triggerMode: 'fire_and_forget',
    description: '代码审查Agent，自动审查代码质量、安全性和最佳实践',
  },
  test_runner: {
    role: 'test-runner',
    capabilities: ['test-execution', 'coverage-analysis', 'regression-detection'],
    modelTier: 'small',
    maxTokens: 30000,
    triggerMode: 'fire_and_forget',
    description: '测试执行Agent，运行测试并分析覆盖率',
  },
  doc_writer: {
    role: 'doc-writer',
    capabilities: ['documentation', 'api-docs', 'markdown'],
    modelTier: 'small',
    maxTokens: 40000,
    triggerMode: 'fire_and_forget',
    description: '文档编写Agent，生成和维护项目文档',
  },
  debugger: {
    role: 'debugger',
    capabilities: ['debugging', 'error-analysis', 'fix-suggestion'],
    modelTier: 'large',
    maxTokens: 80000,
    triggerMode: 'fire_and_forget',
    description: '调试Agent，分析错误并提供修复建议',
  },
  researcher: {
    role: 'researcher',
    capabilities: ['research', 'analysis', 'summarization'],
    modelTier: 'large',
    maxTokens: 100000,
    triggerMode: 'fire_and_forget',
    description: '研究Agent，搜索和分析信息',
  },
  deployer: {
    role: 'deployer',
    capabilities: ['deployment', 'ci-cd', 'infrastructure'],
    modelTier: 'medium',
    maxTokens: 40000,
    triggerMode: 'fire_and_forget',
    description: '部署Agent，管理CI/CD和基础设施',
  },
};

// Task keyword to template mapping
const TASK_KEYWORD_MAP = {
  code_reviewer: ['review', '审查', 'code review', '代码审查', '质量检查', 'quality check'],
  test_runner: ['test', '测试', 'coverage', '覆盖率', 'regression', '回归'],
  doc_writer: ['doc', '文档', 'document', 'readme', 'api doc', '注释', 'comment'],
  debugger: ['debug', '调试', 'error', '错误', 'bug', 'fix', '修复', 'crash', '崩溃'],
  researcher: ['research', '研究', 'analyze', '分析', 'search', '搜索', 'investigate', '调查'],
  deployer: ['deploy', '部署', 'release', '发布', 'ci/cd', 'pipeline', 'infrastructure', '基础设施'],
};

const SPAWN_MODES = {
  WORKER: 'worker',    // 临时工模式：单次执行，隔离上下文，仅返回摘要
  TEAM: 'team',        // 团队模式：多轮协作，共享上下文，持久状态
};

const DEFAULT_CONFIG = {
  maxSpawnedAgents: 20,
  defaultSpawnMode: SPAWN_MODES.WORKER,
  defaultTokenBudget: 50000,
  defaultTimeoutMs: 300000,
  maxRetries: 1,
};

class DynamicAgentSpawner extends EventEmitter {
  constructor(agentRuntime, config) {
    super();
    this._agentRuntime = agentRuntime;
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._spawnedAgents = new Map();  // agentId -> spawn info
    this._stats = {
      totalSpawned: 0,
      totalCompleted: 0,
      totalFailed: 0,
      byTemplate: {},
      byMode: { worker: 0, team: 0 },
    };
  }

  // Spawn an agent from a natural language task description
  spawnFromTask(taskDescription, options) {
    this.guardShutdown();
    if (!taskDescription || typeof taskDescription !== 'string') {
      throw new Error('taskDescription must be a non-empty string');
    }

    const template = this._matchTemplate(taskDescription);
    const spawnMode = (options && options.spawnMode) || this._config.defaultSpawnMode;
    const agentConfig = this._buildAgentConfig(template, taskDescription, spawnMode, options);

    if (this._spawnedAgents.size >= this._config.maxSpawnedAgents) {
      this.emit('spawn-limit-reached', { max: this._config.maxSpawnedAgents });
      throw new Error('Maximum spawned agents reached');
    }

    const agentId = (options && options.agentId) || this._generateAgentId(template.role);
    const spawnInfo = {
      agentId,
      taskDescription,
      templateKey: template._templateKey || 'custom',
      role: template.role,
      spawnMode,
      config: agentConfig,
      spawnedAt: new Date().toISOString(),
      status: 'spawned',
    };

    this._spawnedAgents.set(agentId, spawnInfo);
    this._stats.totalSpawned++;
    this._stats.byMode[spawnMode] = (this._stats.byMode[spawnMode] ?? 0) + 1;
    const templateKey = spawnInfo.templateKey;
    this._stats.byTemplate[templateKey] = (this._stats.byTemplate[templateKey] ?? 0) + 1;

    this.emit('agent-spawned', { agentId, role: template.role, spawnMode, taskDescription: taskDescription.substring(0, 100) });
    return spawnInfo;
  }

  // Match a task description to the best agent template
  _matchTemplate(taskDescription) {
    const lower = taskDescription.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const [templateKey, keywords] of Object.entries(TASK_KEYWORD_MAP)) {
      let score = 0;
      for (const keyword of keywords) {
        if (lower.includes(keyword)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = templateKey;
      }
    }

    if (bestMatch && AGENT_TEMPLATES[bestMatch]) {
      const template = Object.assign({}, AGENT_TEMPLATES[bestMatch], {
        capabilities: [...(AGENT_TEMPLATES[bestMatch].capabilities ?? [])],
      });
      template._templateKey = bestMatch;
      return template;
    }

    // Default fallback: researcher template
    const fallback = Object.assign({}, AGENT_TEMPLATES.researcher, {
      capabilities: [...(AGENT_TEMPLATES.researcher.capabilities ?? [])],
    });
    fallback._templateKey = 'researcher';
    return fallback;
  }

  // Build agent config from template and options
  _buildAgentConfig(template, taskDescription, spawnMode, options) {
    const config = {
      role: template.role,
      capabilities: template.capabilities,
      modelTier: (options && options.modelTier) || template.modelTier,
      maxTokens: (options && options.maxTokens) || template.maxTokens || this._config.defaultTokenBudget,
      triggerMode: template.triggerMode,
      spawnMode,
      task: taskDescription,
      timeout: (options && options.timeout) || this._config.defaultTimeoutMs,
    };

    if (spawnMode === SPAWN_MODES.WORKER) {
      config.isolatedContext = true;
      config.returnSummary = true;
    } else {
      config.isolatedContext = false;
      config.returnSummary = false;
      config.persistent = true;
    }

    return config;
  }

  _generateAgentId(role) {
    return 'dynamic-' + role + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);
  }

  // Mark an agent as completed
  completeAgent(agentId, result) {
    this.guardShutdown();
    const info = this._spawnedAgents.get(agentId);
    if (!info) return false;
    info.status = 'completed';
    info.completedAt = new Date().toISOString();
    info.result = result;
    this._stats.totalCompleted++;
    this.emit('agent-completed', { agentId, role: info.role });
    return true;
  }

  // Mark an agent as failed
  failAgent(agentId, error) {
    this.guardShutdown();
    const info = this._spawnedAgents.get(agentId);
    if (!info) return false;
    info.status = 'failed';
    info.failedAt = new Date().toISOString();
    info.error = error;
    this._stats.totalFailed++;
    this.emit('agent-failed', { agentId, role: info.role, error: String(error) });
    return true;
  }

  // Get spawned agent info
  getSpawnedAgent(agentId) {
    if (this._shutDown) return null;
    return this._spawnedAgents.get(agentId) ?? null;
  }

  // List all spawned agents
  listSpawnedAgents() {
    if (this._shutDown) return [];
    const result = [];
    this._spawnedAgents.forEach(function(info, id) {
      result.push({ agentId: id, role: info.role, spawnMode: info.spawnMode, status: info.status, spawnedAt: info.spawnedAt });
    });
    return result;
  }

  // Get available templates
  getTemplates() {
    if (this._shutDown) return {};
    // 深拷贝每个模板，防止嵌套对象共享引用
    const templates = {};
    for (const key of Object.keys(AGENT_TEMPLATES)) {
      templates[key] = Object.assign({}, AGENT_TEMPLATES[key], {
        capabilities: [...(AGENT_TEMPLATES[key].capabilities ?? [])],
      });
    }
    return templates;
  }

  // Register a custom template
  registerTemplate(templateKey, template) {
    this.guardShutdown();
    if (!templateKey || typeof templateKey !== 'string') throw new Error('templateKey must be a non-empty string');
    if (!template.role) throw new Error('Template must have a role');
    AGENT_TEMPLATES[templateKey] = Object.assign({
      capabilities: [],
      modelTier: 'medium',
      maxTokens: 50000,
      triggerMode: 'fire_and_forget',
      description: '',
    }, template);
    this.emit('template-registered', { templateKey, role: template.role });
  }

  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { totalSpawned: 0, totalCompleted: 0, totalFailed: 0, byTemplate: {}, byMode: {} };
    }
    return Object.assign({}, this._stats, { activeAgents: this._spawnedAgents.size });
  }

  _onShutdown() {
    this._spawnedAgents.clear();
    this.removeAllListeners();
  }
}

withShutdown(DynamicAgentSpawner);

module.exports = { DynamicAgentSpawner, SPAWN_MODES, AGENT_TEMPLATES };
