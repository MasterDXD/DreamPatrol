'use strict';

/**
 * @module dashboard/data-providers/framework-data
 * @description Dashboard框架状态数据提供模块，扫描模块加载状态、依赖关系和资源配置
 */

const path = require('path');
const fs = require('fs');
const { safeJsonParse } = require('../../../utils/safe-parse');
const { debug } = require('../../../utils/debug-logger');
const { CORE_MODULES, MODULE_DEPENDENCY_ORDER, EXPECTED_RUNTIME_MODULE_COUNT } = require('./framework-modules');
const { getHarnessConfigPath, HARNESS_DIR, UTF8_ENCODING, MARKDOWN_EXT } = require('../../../utils/constants');

/** @constant {object|null} 模块状态缓存 */
let _cachedModuleStatus = null;
/** @constant {number} 模块状态缓存时间戳 */
let _cachedModuleStatusTime = 0;
/** @constant {number} 模块状态缓存TTL（毫秒） */
const MODULE_STATUS_TTL = 30000;

/**
 * 扫描核心模块加载状态，带30秒TTL缓存
 * @returns {Array<{name: string, loaded: boolean, hasExport?: boolean, type?: string, error?: string}>} 模块状态列表
 * @private
 */
function _scanModuleStatus() {
  const now = Date.now();
  if (_cachedModuleStatus && (now - _cachedModuleStatusTime) < MODULE_STATUS_TTL) return _cachedModuleStatus;
  _cachedModuleStatus = CORE_MODULES.map(function(mod) {
    try {
      require.resolve(mod.path);
      return { name: mod.name, loaded: true, hasExport: true, type: 'detected' };
    } catch {
      return { name: mod.name, loaded: false, error: 'Module not found' };
    }
  });
  _cachedModuleStatusTime = now;
  return _cachedModuleStatus;
}

/**
 * 加载Harness框架配置文件
 * @param {string} root - 项目根目录
 * @returns {Promise<object>} 框架配置对象
 * @private
 */
async function _loadFrameworkConfig(root) {
  try {
    const configPath = getHarnessConfigPath(root);
    const configContent = await fs.promises.readFile(configPath, UTF8_ENCODING);
    return safeJsonParse(configContent, {}, 'FrameworkData');
  } catch { return {}; }
}

/**
 * 扫描Harness资源目录（agents/skills/rules）的文件数量
 * @param {string} root - 项目根目录
 * @param {Function} scanMarkdownDir - Markdown目录扫描函数
 * @returns {Promise<{agents: object, skills: object, rules: object}>} 资源扫描结果
 * @private
 */
function _scanResources(root, scanMarkdownDir) {
  const agentsDir = path.join(root, HARNESS_DIR, 'agents');
  const skillsDir = path.join(root, HARNESS_DIR, 'skills');
  const rulesDir = path.join(root, HARNESS_DIR, 'rules');
  return Promise.allSettled([
    scanMarkdownDir(agentsDir),
    scanMarkdownDir(skillsDir),
    scanMarkdownDir(rulesDir),
  ]).then(function(results) {
    return {
      agents: results[0].status === 'fulfilled' ? results[0].value : [],
      skills: results[1].status === 'fulfilled' ? results[1].value : [],
      rules: results[2].status === 'fulfilled' ? results[2].value : [],
    };
  }).catch(err => {
    debug('FrameworkData', 'load', err && err.message ? err.message : String(err));
    return { agents: [], skills: [], rules: [] };
  });
}

/**
 * 检查模块依赖关系，找出已加载模块的缺失依赖
 * @param {Array<{name: string, loaded: boolean}>} moduleStatus - 模块状态列表
 * @returns {Array<{module: string, missingDependency: string}>} 依赖问题列表
 * @private
 */
function _checkDependencies(moduleStatus) {
  const moduleMap = {};
  moduleStatus.forEach(function(m) { moduleMap[m.name] = m; });
  const dependencyIssues = [];
  MODULE_DEPENDENCY_ORDER.forEach(function(entry) {
    const name = entry[0];
    const deps = entry[1];
    const mod = moduleMap[name];
    if (!mod || !mod.loaded) return;
    deps.forEach(function(depName) {
      const dep = moduleMap[depName];
      if (dep && !dep.loaded) {
        dependencyIssues.push({ module: name, missingDependency: depName });
      }
    });
  });
  return dependencyIssues;
}

/**
 * 构建运行时信息，统计模块数量和完整性
 * @param {object|null} runtime - 运行时实例
 * @returns {{initialized: boolean, standaloneMode: boolean, moduleCount: number, expectedModules: number, completeness: number}} 运行时信息
 * @private
 */
function _buildRuntimeInfo(runtime) {
  const runtimeModules = runtime ? Object.keys(runtime).filter(function(k) { return k !== 'destroy'; }).length : 0;
  const expectedRuntimeModules = runtime ? EXPECTED_RUNTIME_MODULE_COUNT : 0;
  const isStandaloneMode = !runtime;
  return {
    initialized: !!runtime || isStandaloneMode,
    standaloneMode: isStandaloneMode,
    moduleCount: runtimeModules,
    expectedModules: expectedRuntimeModules,
    completeness: runtime && expectedRuntimeModules ? Math.round((runtimeModules / expectedRuntimeModules) * 100) : 0,
  };
}

/**
 * 获取框架完整状态，包括模块加载、依赖关系、运行时信息和资源配置
 * @param {string} root - 项目根目录
 * @param {Function} rt - 运行时模块获取函数
 * @param {Function} getVersion - 版本获取函数
 * @param {Function} getHealth - 健康检查函数
 * @param {object|null} runtime - 运行时实例
 * @param {Function} scanMarkdownDir - Markdown目录扫描函数
 * @returns {Promise<{status: string, version: string, health: object, modules: object, runtime: object, resources: object, timestamp: string}>} 框架状态
 */
async function getFrameworkStatus(root, rt, getVersion, getHealth, runtime, scanMarkdownDir) {
  const config = await _loadFrameworkConfig(root);
  const version = await getVersion();
  const health = getHealth();
  const moduleStatus = _scanModuleStatus();
  const allLoaded = moduleStatus.every(function(m) { return m.loaded; });
  const loadedCount = moduleStatus.filter(function(m) { return m.loaded; }).length;
  const failedModules = moduleStatus.filter(function(m) { return !m.loaded; });
  const dependencyIssues = _checkDependencies(moduleStatus);
  const resources = await _scanResources(root, scanMarkdownDir);

  return {
    status: allLoaded ? 'healthy' : 'degraded',
    version: version,
    health: health,
    modules: {
      total: moduleStatus.length,
      loaded: loadedCount,
      allLoaded: allLoaded,
      failedModules: failedModules.map(function(m) { return m.name; }),
      details: moduleStatus,
      dependencyIssues: dependencyIssues,
      dependencyOrderValid: dependencyIssues.length === 0,
    },
    runtime: _buildRuntimeInfo(runtime),
    resources: {
      agentsDir: resources.agents.exists,
      skillsDir: resources.skills.exists,
      rulesDir: resources.rules.exists,
      agentFiles: resources.agents.count,
      skillFiles: resources.skills.count,
      ruleFiles: resources.rules.count,
      configLoaded: Object.keys(config).length > 0,
      configValid: !!(config.version && config.project_name && config.skill_registry),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * 将框架状态获取方法混入DashboardServer原型
 * @param {Function} DashboardServer - DashboardServer类
 */
function applyFrameworkMixin(DashboardServer) {
  DashboardServer.prototype._getFrameworkStatus = async function() {
    return getFrameworkStatus(
      this.root, this._rt.bind(this),
      this._getVersion.bind(this), this._getHealth.bind(this),
      this._runtime, this.constructor._scanMarkdownDir || _scanMarkdownDirFallback,
    );
  };
}

/**
 * Markdown目录扫描的降级实现，使用fs.readdir
 * @param {string} dirPath - 目录路径
 * @returns {Promise<{exists: boolean, count: number}>} 扫描结果
 * @private
 */
function _scanMarkdownDirFallback(dirPath) {
  return new Promise(function(resolve) {
    fs.readdir(dirPath, function(err, files) {
      if (err) return resolve({ exists: false, count: 0 });
      const mdFiles = files.filter(function(f) { return f.endsWith(MARKDOWN_EXT); });
      resolve({ exists: true, count: mdFiles.length });
    });
  });
}

module.exports = { applyFrameworkMixin, getFrameworkStatus };
