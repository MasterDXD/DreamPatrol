'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { safeJsonParse } = require('../../utils/safe-parse');
const { scanMarkdownDirSync } = require('../../utils/fs-utils');
const { getHarnessConfigPath, HARNESS_DIR, UTF8_ENCODING } = require('../../utils/constants');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { ensureArray } = require('../../utils/safe-execute');

/**
 * @module runtime/causal/causal-config-validator
 * 因果配置验证器。模式校验、依赖检查、一致性验证，
 * 支持依赖图构建、循环检测和配置漂移检测。
 *
 * @classdesc 因果配置验证器，验证因果链配置的完整性和一致性
 */
class ConfigCausalValidator extends EventEmitter {
  /**
   * 创建ConfigCausalValidator实例。
   * @param {string} projectRoot - 项目根目录路径
   */
  constructor(projectRoot) {
    super();
    this._root = projectRoot;
    this._configPath = getHarnessConfigPath(projectRoot);
    this._skillsDir = path.join(projectRoot, HARNESS_DIR, 'skills');
    this._agentsDir = path.join(projectRoot, HARNESS_DIR, 'agents');
    this._rulesDir = path.join(projectRoot, HARNESS_DIR, 'rules');
    this._dependencyGraph = null;
    this._lastValidation = null;
    this._configSnapshot = null;
    this._driftDetected = false;
    this._sourceCodeGraph = null;
  }

  /**
   * 构建完整的依赖图，包含技能、Agent、规则、Hook、MCP和源代码节点及边。
   * @returns {{ skills: object, agents: object, rules: object, hooks: object, mcp: object, sourceCode: object, errors: Array }} 依赖图
   */
  buildDependencyGraph() {
    this.guardShutdown();
    const graph = { skills: {}, agents: {}, rules: {}, hooks: {}, mcp: {}, errors: [] };
    const config = this._loadConfig();
    if (!config) {
      graph.errors.push({ type: 'config_missing', message: 'config.json not found or invalid' });
      return graph;
    }
    graph.skills = this._buildSkillNodes(config);
    graph.agents = this._buildAgentNodes(config);
    graph.rules = this._buildRuleNodes();
    graph.hooks = this._buildHookNodes(config);
    graph.mcp = this._buildMcpNodes(config);
    this._buildEdges(graph, config);
    graph.sourceCode = this._buildSourceCodeNodes();
    this._buildSourceCodeEdges(graph);
    this._sourceCodeGraph = graph.sourceCode;
    this._dependencyGraph = graph;
    return graph;
  }

  _loadConfig() {
    try {
      if (!fs.existsSync(this._configPath)) return null;
      const content = fs.readFileSync(this._configPath, UTF8_ENCODING);
      return safeJsonParse(content, null, 'ConfigCausalValidator');
    } catch (e) {
      debug('ConfigCausalValidator', 'loadConfig', e && e.message ? e.message : String(e));
      return null;
    }
  }

  _buildSkillNodes(config) {
    const nodes = {};
    const registry = config.skill_registry ?? {};
    const entries = Array.isArray(registry) ? registry : Object.values(registry);
    const skills = entries.flat ? entries : Object.values(registry);
    const skillList = ensureArray(skills);
    for (const skill of skillList) {
      if (!skill || !skill.skill_id) continue;
      nodes[skill.skill_id] = {
        id: skill.skill_id,
        phase: skill.phase,
        enforcement: skill.enforcement,
        dependsOn: skill.depends_on ?? [],
        dependsOnSet: new Set(skill.depends_on ?? []),
        blocks: skill.blocks ?? [],
        applicableAgents: skill.applicable_agents ?? [],
        applicableAgentsSet: new Set(skill.applicable_agents ?? []),
        fileExists: fs.existsSync(path.join(this._skillsDir, skill.skill_id + '.md')),
        specificationBindings: skill.specification_bindings ?? [],
      };
    }
    return nodes;
  }

  _buildAgentNodes(config) {
    const nodes = {};
    const agents = config.agent_permissions ?? {};
    for (const [agentId, perms] of Object.entries(agents)) {
      nodes[agentId] = {
        id: agentId,
        allowedTools: perms.allowed_tools ?? [],
        restrictedOps: perms.restricted_operations ?? [],
        fileExists: fs.existsSync(path.join(this._agentsDir, agentId + '.md')),
      };
    }
    return nodes;
  }

  _buildRuleNodes() {
    const nodes = {};
    if (!fs.existsSync(this._rulesDir)) return nodes;
    const files = scanMarkdownDirSync(this._rulesDir);
    for (const file of files) {
      const name = file.replace('.md', '');
      nodes[name] = { id: name, fileExists: true };
    }
    return nodes;
  }

  _buildHookNodes(config) {
    const nodes = {};
    const hooks = config.hooks ?? {};
    for (const [hookPoint, hookConfig] of Object.entries(hooks)) {
      nodes[hookPoint] = {
        id: hookPoint,
        handlers: Array.isArray(hookConfig) ? hookConfig : hookConfig.handlers ?? [],
      };
    }
    return nodes;
  }

  _buildMcpNodes(config) {
    const nodes = {};
    const servers = config.mcp_servers ?? {};
    for (const [name, serverConfig] of Object.entries(servers)) {
      nodes[name] = {
        id: name,
        enabled: serverConfig.enabled !== false,
        type: serverConfig.type ?? 'stdio',
      };
    }
    return nodes;
  }

  _buildEdges(graph, _config) {
    for (const [skillId, skill] of Object.entries(graph.skills ?? {})) {
      for (const dep of skill.dependsOn) {
        if (!graph.skills[dep]) {
          graph.errors.push({ type: 'missing_dependency', source: skillId, target: dep, message: `Skill ${skillId} depends on non-existent skill ${dep}` });
        }
      }
      for (const agent of skill.applicableAgents) {
        if (!graph.agents[agent]) {
          graph.errors.push({ type: 'missing_agent_reference', source: skillId, target: agent, message: `Skill ${skillId} references non-existent agent ${agent}` });
        }
      }
      if (!skill.fileExists) {
        graph.errors.push({ type: 'missing_skill_file', source: skillId, message: `Skill ${skillId} has no corresponding .md file` });
      }
    }
    for (const [agentId, agent] of Object.entries(graph.agents ?? {})) {
      if (!agent.fileExists) {
        graph.errors.push({ type: 'missing_agent_file', source: agentId, message: `Agent ${agentId} has no corresponding .md file` });
      }
    }
  }

  /**
   * 执行配置验证，检查依赖完整性、缺失文件、规格绑定和循环依赖。
   * @returns {{ valid: boolean, errors: Array, warnings: Array, stats: object }} 验证结果
   */
  validate() {
    this.guardShutdown();
    if (!this._dependencyGraph) {
      this.buildDependencyGraph();
    }
    const graph = this._dependencyGraph;
    const result = {
      valid: graph.errors.length === 0,
      errors: graph.errors,
      warnings: [],
      stats: {
        skills: Object.keys(graph.skills ?? {}).length,
        agents: Object.keys(graph.agents ?? {}).length,
        rules: Object.keys(graph.rules ?? {}).length,
        hooks: Object.keys(graph.hooks ?? {}).length,
        mcpServers: Object.keys(graph.mcp ?? {}).length,
        errorCount: graph.errors.length,
      },
    };
    for (const [skillId, skill] of Object.entries(graph.skills ?? {})) {
      if (skill.dependsOn.length > 3) {
        result.warnings.push({ type: 'high_dependency_count', source: skillId, message: `Skill ${skillId} has ${skill.dependsOn.length} dependencies` });
      }
    }
    const srcCode = graph.sourceCode ?? {};
    for (const skId in (graph.skills ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(graph.skills, skId)) continue;
      const sBindings = graph.skills[skId].specificationBindings ?? [];
      for (let bi = 0; bi < sBindings.length; bi++) {
        if (!srcCode[sBindings[bi]]) {
          result.warnings.push({ type: 'missing_spec_binding', source: skId, message: 'Skill ' + skId + ' has specification binding to non-existent source code: ' + sBindings[bi] });
        }
      }
    }
    const cycles = this.detectCircularDependencies();
    if (cycles.length > 0) {
      result.warnings.push({ type: 'circular_dependencies', message: `Found ${cycles.length} circular dependency cycle(s)`, cycles });
    }
    this._lastValidation = result;
    return result;
  }

  /**
   * 检测技能依赖图中的循环依赖。
   * @returns {Array<Array<string>>} 循环依赖路径列表
   */
  detectCircularDependencies() {
    this.guardShutdown();
    if (!this._dependencyGraph) this.buildDependencyGraph();
    const graph = this._dependencyGraph;
    const cycles = [];
    const visited = new Set();
    const recursionStack = new Set();

    const dfs = function(nodeId, trail) {
      visited.add(nodeId);
      recursionStack.add(nodeId);
      const skill = graph.skills[nodeId];
      if (skill) {
        for (const dep of skill.dependsOn) {
          if (!graph.skills[dep]) continue;
          if (!visited.has(dep)) {
            dfs(dep, trail.concat(nodeId));
          } else if (recursionStack.has(dep)) {
            if (dep === nodeId) {
              cycles.push([nodeId, nodeId]);
            } else {
              const cycleStart = trail.indexOf(dep);
              if (cycleStart >= 0) {
                const cycle = trail.slice(cycleStart).concat(nodeId, dep);
                cycles.push(cycle);
              }
            }
          }
        }
      }
      recursionStack.delete(nodeId);
    };

    for (const skillId of Object.keys(graph.skills)) {
      if (!visited.has(skillId)) {
        dfs(skillId, []);
      }
    }
    return cycles;
  }

  /**
   * 对当前配置创建快照，用于后续漂移检测。
   * @returns {boolean} 快照是否成功创建
   */
  snapshotConfig() {
    this.guardShutdown();
    const config = this._loadConfig();
    if (!config) return false;
    this._configSnapshot = JSON.stringify(config);
    this._driftDetected = false;
    return true;
  }

  /**
   * 检测配置是否相对于快照发生了漂移。
   * @returns {{ drifted: boolean, added?: string[], removed?: string[], reason: string }} 漂移检测结果
   */
  detectConfigDrift() {
    this.guardShutdown();
    const currentConfig = this._loadConfig();
    if (!currentConfig) return { drifted: false, reason: 'no_config' };
    if (!this._configSnapshot) {
      this._configSnapshot = JSON.stringify(currentConfig);
      return { drifted: false, reason: 'first_snapshot' };
    }
    const currentStr = JSON.stringify(currentConfig);
    if (currentStr !== this._configSnapshot) {
      this._driftDetected = true;
      const oldKeys = new Set(Object.keys(safeJsonParse(this._configSnapshot, {})));
      const newKeys = new Set(Object.keys(currentConfig));
      const added = [...newKeys].filter(k => !oldKeys.has(k));
      const removed = [...oldKeys].filter(k => !newKeys.has(k));
      return { drifted: true, added, removed, reason: 'config_changed' };
    }
    return { drifted: false, reason: 'unchanged' };
  }

  /**
   * 查询是否已检测到配置漂移。
   * @returns {boolean} 是否存在配置漂移
   */
  isDriftDetected() {
    if (!this.isHealthy()) return false;
    return this._driftDetected;
  }

  /**
   * 分析指定节点变更的影响范围，返回受影响的下游节点列表。
   * @param {string} nodeId - 节点ID
   * @param {string} nodeType - 节点类型（skill/agent/sourceCode）
   * @returns {Array<{id: string, type: string, relation: string}>} 受影响节点列表
   */
  getImpactAnalysis(nodeId, nodeType) {
    this.guardShutdown();
    if (!this._dependencyGraph) this.buildDependencyGraph();
    const graph = this._dependencyGraph;
    if (nodeType === 'skill') return this._impactFromSkill(nodeId, graph);
    if (nodeType === 'agent') return this._impactFromAgent(nodeId, graph);
    if (nodeType === 'sourceCode') return this._impactFromSourceCode(nodeId, graph);
    return [];
  }

  _impactFromSkill(nodeId, graph) {
    const impacted = [];
    for (const [id, skill] of Object.entries(graph.skills ?? {})) {
      if (skill.dependsOnSet.has(nodeId)) {
        impacted.push({ id, type: 'skill', relation: 'depends_on' });
      }
      if (skill.applicableAgentsSet.has(nodeId)) {
        impacted.push({ id, type: 'skill', relation: 'used_by_agent' });
      }
    }
    return impacted;
  }

  _impactFromAgent(nodeId, graph) {
    const impacted = [];
    for (const [id, skill] of Object.entries(graph.skills ?? {})) {
      if (skill.applicableAgentsSet.has(nodeId)) {
        impacted.push({ id, type: 'skill', relation: 'uses_agent' });
      }
    }
    return impacted;
  }

  _impactFromSourceCode(nodeId, graph) {
    const impacted = [];
    const codeNodes = graph.sourceCode ?? {};
    for (const codeId in codeNodes) {
      if (!Object.prototype.hasOwnProperty.call(codeNodes, codeId)) continue;
      if (codeNodes[codeId].dependsOnSet && codeNodes[codeId].dependsOnSet.has(nodeId)) {
        impacted.push({ id: codeId, type: 'sourceCode', relation: 'imports' });
      }
    }
    const skills = graph.skills ?? {};
    for (const skillId in skills) {
      if (!Object.prototype.hasOwnProperty.call(skills, skillId)) continue;
      if (skills[skillId].specificationBindings && skills[skillId].specificationBindings.indexOf(nodeId) !== -1) {
        impacted.push({ id: skillId, type: 'skill', relation: 'spec_bound' });
      }
    }
    return impacted;
  }

  /**
   * 获取最近一次验证结果。
   * @returns {object|null} 验证结果，未执行过验证时返回null
   */
  getLastValidation() {
    if (!this.isHealthy()) return null;
    if (!this._lastValidation) return null;
    try {
      return JSON.parse(JSON.stringify(this._lastValidation));
    } catch (err) {
      debug('CausalConfigValidator', 'getLastValidation', err && err.message ? err.message : String(err));
      return null;
    }
  }

  /**
   * 获取已构建的依赖图对象。
   * @returns {object|null} 依赖图，未构建时返回null
   */
  getDependencyGraph() {
    if (!this.isHealthy()) return null;
    if (!this._dependencyGraph) return null;
    try {
      return JSON.parse(JSON.stringify(this._dependencyGraph));
    } catch (err) {
      debug('CausalConfigValidator', 'getDependencyGraph', err && err.message ? err.message : String(err));
      return null;
    }
  }

  /**
   * 获取验证器统计信息。
   * @returns {{ status: string, skills?: number, agents?: number, rules?: number, hooks?: number, mcpServers?: number, errors?: number }} 统计数据
   */
  getStats() {
    try { this.guardShutdown(); } catch (_e) { debug('CausalConfigValidator', 'getStats:guardShutdown', _e && _e.message ? _e.message : String(_e)); return { status: 'shut_down' }; }
    if (!this._dependencyGraph) return { status: 'not_built' };
    const g = this._dependencyGraph;
    return {
      status: 'built',
      skills: Object.keys(g.skills ?? {}).length,
      agents: Object.keys(g.agents ?? {}).length,
      rules: Object.keys(g.rules ?? {}).length,
      hooks: Object.keys(g.hooks ?? {}).length,
      mcpServers: Object.keys(g.mcp ?? {}).length,
      errors: (g.errors ?? []).length,
    };
  }

  _onShutdown() {
    this._dependencyGraph = null;
    this._lastValidation = null;
    this._configSnapshot = null;
    this._driftDetected = false;
    this._sourceCodeGraph = null;
    this.removeAllListeners();
  }

  /**
   * 检查验证器是否健康（项目根目录已设置）。
   * @returns {boolean} 健康状态
   */
  isHealthy() {
    return !this._shutDown && this._root !== null;
  }
}

ConfigCausalValidator.prototype._buildSourceCodeNodes = function _buildSourceCodeNodes() {
  const nodes = {};
  const srcDir = path.join(this._root, 'src');
  if (!fs.existsSync(srcDir)) return nodes;
  try {
    const entries = this._scanJsFiles(srcDir);
    for (let i = 0; i < entries.length; i++) {
      const filePath = entries[i];
      const relPath = path.relative(this._root, filePath).replace(/\\/g, '/');
      const imports = this._extractImports(filePath);
      const exports = this._extractExports(filePath);
      nodes[relPath] = {
        id: relPath,
        exports: exports,
        imports: imports,
        dependsOnSet: new Set(imports),
        specificationBindings: [],
      };
    }
  } catch (_e) {
    debug('ConfigCausalValidator', '_buildSourceCodeNodes', _e);
  }
  return nodes;
};

ConfigCausalValidator.prototype._buildSourceCodeEdges = function _buildSourceCodeEdges(graph) {
  const srcCode = graph.sourceCode ?? {};
  const skills = graph.skills ?? {};
  for (const skillId in skills) {
    if (!Object.prototype.hasOwnProperty.call(skills, skillId)) continue;
    const bindings = skills[skillId].specificationBindings ?? [];
    for (const binding of bindings) {
      if (srcCode[binding] && srcCode[binding].specificationBindings.indexOf(skillId) === -1) {
        srcCode[binding].specificationBindings.push(skillId);
      }
    }
  }
  for (const id in srcCode) {
    if (!Object.prototype.hasOwnProperty.call(srcCode, id)) continue;
    const node = srcCode[id];
    const resolvedImports = [];
    for (const imp of node.imports ?? []) {
      const resolved = this._resolveImport(imp, id, srcCode);
      if (resolved && srcCode[resolved]) {
        resolvedImports.push(resolved);
        if (!srcCode[resolved].dependedOnBy) srcCode[resolved].dependedOnBy = [];
        srcCode[resolved].dependedOnBy.push(id);
      }
    }
    node.resolvedImports = resolvedImports;
  }
};

ConfigCausalValidator.prototype._scanJsFiles = function _scanJsFiles(dir, depth) {
  if ((depth ?? 0) >= 20) return [];
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        results.push(...this._scanJsFiles(fullPath, (depth ?? 0) + 1));
      } else if (entry.isFile() && /\.js$/.test(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch (_e) {
    debug('ConfigCausalValidator', 'scanJsFiles', _e);
  }
  return results;
};

ConfigCausalValidator.prototype._extractImports = function _extractImports(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const strings = [];
    let processed = raw.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, function(m) {
      strings.push(m);
      return '__STR_' + (strings.length - 1) + '__';
    });
    processed = processed.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (let i = 0; i < strings.length; i++) {
      processed = processed.replace('__STR_' + i + '__', strings[i]);
    }
    const imports = [];
    const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = requireRegex.exec(processed)) !== null) {
      imports.push(match[1]);
    }
    return imports;
  } catch (_e) {
    debug('ConfigCausalValidator', '_extractImports', _e);
    return [];
  }
};

ConfigCausalValidator.prototype._extractExports = function _extractExports(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const exports = [];
    const classRegex = /class\s+(\w+)/g;
    let match;
    while ((match = classRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }
    const moduleExportsRegex = /module\.exports\s*=\s*(\w+)/g;
    while ((match = moduleExportsRegex.exec(content)) !== null) {
      if (exports.indexOf(match[1]) === -1) exports.push(match[1]);
    }
    const exportsAssignRegex = /exports\.(\w+)\s*=/g;
    while ((match = exportsAssignRegex.exec(content)) !== null) {
      if (exports.indexOf(match[1]) === -1) exports.push(match[1]);
    }
    return exports;
  } catch (_e) {
    debug('ConfigCausalValidator', '_extractExports', _e);
    return [];
  }
};

ConfigCausalValidator.prototype._resolveImport = function _resolveImport(importPath, fromFile, srcCode) {
  if (!importPath.startsWith('.')) return null;
  const fromDir = path.dirname(fromFile);
  const resolved = path.normalize(path.join(fromDir, importPath)).replace(/\\/g, '/');
  if (srcCode[resolved]) return resolved;
  if (srcCode[resolved + '.js']) return resolved + '.js';
  if (srcCode[resolved + '/index.js']) return resolved + '/index.js';
  return null;
};

/**
 * 获取源代码依赖图。
 * @returns {object|null} 源代码依赖图，未构建时返回null
 */
ConfigCausalValidator.prototype.getSourceCodeGraph = function getSourceCodeGraph() {
  if (!this.isHealthy()) return null;
  if (!this._sourceCodeGraph) return null;
  try { return JSON.parse(JSON.stringify(this._sourceCodeGraph)); } catch (err) { debug('CausalConfigValidator', 'getSourceCodeGraph', err && err.message ? err.message : String(err)); return null; }
};
module.exports = withShutdown(ConfigCausalValidator);
