'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { debug } = require('../../utils/debug-logger');
const { sanitize: sanitizeData, writeAtomic } = require('../../utils/debounced-persister');
const { validateProjectRoot, HARNESS_DIR, MARKDOWN_EXT } = require('../../utils/constants');
const { ensureDirSync, ensureDirAsync, loadJsonSync, loadJsonAsync, scanMarkdownDirSync } = require('../../utils/fs-utils');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');

const PACKS_DIR = HARNESS_DIR + '/agent-packs';
const INSTALLED_FILE = 'installed.json';

const REQUIRED_PACK_FIELDS = ['id', 'name', 'version', 'description'];
const VALID_PACK_COMPONENTS = ['agent.md', 'command.md', 'skills'];

function _readJson(filePath) {
  return loadJsonSync(filePath, sanitizeData);
}

function _writeJson(filePath, data) {
  try {
    writeAtomic(filePath, data);
    return true;
  } catch (err) {
    debug('AgentPackManager', 'writeJson', err && err.message ? err.message : String(err));
    return false;
  }
}

/**
 * @module runtime/agent/agent-pack-manager
 * @classdesc Agent包管理器（AgentPackManager）。能力打包、依赖解析、版本兼容，
 * 管理Agent能力包的安装、卸载和版本追踪，支持包完整性校验和冲突检测。
 *
 * AgentPackManager — Agent能力包管理器
 * 管理Agent能力包的安装、卸载和版本追踪。每个包包含agent定义、command定义和skill模板，
 * 安装时自动部署到.harness/agents/、.harness/commands/、.harness/skills/目录。
 * 维护已安装包注册表，支持包完整性校验和冲突检测。
 * @extends EventEmitter
 * @emits AgentPackManager#pack-installed
 * @emits AgentPackManager#pack-uninstalled
 * @emits AgentPackManager#pack-updated
 */
const MAX_INSTALLED = 100;

class AgentPackManager extends EventEmitter {
  /**
   * 创建AgentPackManager实例并初始化目录路径。
   * @param {string} projectRoot - 项目根目录路径
   */
  constructor(projectRoot) {
    super();
    validateProjectRoot(projectRoot, 'AgentPackManager');
    this.root = projectRoot;
    this._packsDir = path.join(projectRoot, PACKS_DIR);
    this._installedFile = path.join(this._packsDir, INSTALLED_FILE);
    this._agentsDir = path.join(projectRoot, HARNESS_DIR, 'agents');
    this._commandsDir = path.join(projectRoot, HARNESS_DIR, 'commands');
    this._skillsDir = path.join(projectRoot, HARNESS_DIR, 'skills');
    this._installed = null;
    this._packsCache = null;
  }

  _loadInstalled() {
    if (this._installed === null) {
      this._installed = _readJson(this._installedFile) ?? [];
    }
    return this._installed;
  }

  _saveInstalled() {
    const result = _writeJson(this._installedFile, this._installed ?? []);
    if (!result) {
      debug('AgentPackManager', '_saveInstalled', 'WARNING: Failed to persist installed packs to disk');
    }
    return result;
  }

  /**
   * 同步扫描包目录，发现所有可用包并标记已安装状态。
   * @returns {AgentPackManager} this（支持链式调用）
   */
  discover() {
    this.guardShutdown();
    this._packsCache = {};
    if (!fs.existsSync(this._packsDir)) {
      safeCall(() => ensureDirSync(this._packsDir), 'AgentPackManager', 'mkdir');
      return this;
    }

    let entries;
    try { entries = fs.readdirSync(this._packsDir, { withFileTypes: true }); } catch (e) {
      debug('AgentPackManager', 'discover', e && e.message ? e.message : String(e));
      return this;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const packDir = path.join(this._packsDir, entry.name);
      const manifest = _readJson(path.join(packDir, 'pack.json'));

      if (!manifest || !manifest.id) {
        debug('AgentPackManager', 'discover', `Skipping invalid pack: ${entry.name}`);
        continue;
      }

      this._packsCache[manifest.id] = {
        manifest,
        dir: packDir,
        components: this._scanComponents(packDir),
        installed: false,
      };
    }

    const installed = this._loadInstalled();
    for (const entry of installed) {
      if (this._packsCache[entry.id]) {
        this._packsCache[entry.id].installed = true;
        this._packsCache[entry.id].installedAt = entry.installedAt;
        this._packsCache[entry.id].installedVersion = entry.version;
      }
    }

    return this;
  }

  /**
   * 异步扫描包目录，发现所有可用包并标记已安装状态。
   * @returns {Promise<AgentPackManager>} this（支持链式调用）
   */
  async discoverAsync() {
    this.guardShutdown();
    this._packsCache = {};
    try {
      await fs.promises.access(this._packsDir);
    } catch (err) {
      debug('AgentPackManager', 'discoverAsync: access failed', err && err.message ? err.message : String(err));
      try { await ensureDirAsync(this._packsDir); } catch (mkdirErr) { debug('AgentPackManager', 'mkdirAsync failed', mkdirErr && mkdirErr.message ? mkdirErr.message : String(mkdirErr)); }
      return this;
    }

    let entries;
    try {
      entries = await fs.promises.readdir(this._packsDir, { withFileTypes: true });
    } catch (err) {
      debug('AgentPackManager', 'discoverAsync: readdir failed', err && err.message ? err.message : String(err));
      return this;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      await this._processPackEntryAsync(entry);
    }

    try {
      this._installed = await loadJsonAsync(this._installedFile, sanitizeData) ?? [];
    } catch (err) {
      debug('AgentPackManager', 'discoverAsync: loadInstalled failed', err && err.message ? err.message : String(err));
      this._installed = [];
    }
    this._markInstalled();

    return this;
  }

  async _processPackEntryAsync(entry) {
    const packDir = path.join(this._packsDir, entry.name);
    let manifest;
    try {
      manifest = await loadJsonAsync(path.join(packDir, 'pack.json'), sanitizeData);
    } catch (err) {
      debug('AgentPackManager', 'discoverAsync: loadManifest failed', `${entry.name}: ${err && err.message ? err.message : String(err)}`);
      return;
    }

    if (!manifest || !manifest.id) {
      debug('AgentPackManager', 'discoverAsync', `Skipping invalid pack: ${entry.name}`);
      return;
    }

    let components;
    try {
      components = await this._scanComponentsAsync(packDir);
    } catch (err) {
      debug('AgentPackManager', 'discoverAsync: scanComponents failed', `${entry.name}: ${err && err.message ? err.message : String(err)}`);
      components = {};
    }

    this._packsCache[manifest.id] = {
      manifest,
      dir: packDir,
      components,
      installed: false,
    };
  }

  _markInstalled() {
    for (const entry of this._installed) {
      if (this._packsCache[entry.id]) {
        this._packsCache[entry.id].installed = true;
        this._packsCache[entry.id].installedAt = entry.installedAt;
        this._packsCache[entry.id].installedVersion = entry.version;
      }
    }
  }

  _scanComponents(packDir) {
    const components = {};
    for (const comp of VALID_PACK_COMPONENTS) {
      const compPath = path.join(packDir, comp);
      if (fs.existsSync(compPath)) {
        let stat;
        try { stat = fs.statSync(compPath); } catch (_e) { continue; }
        if (stat.isDirectory()) {
          const files = scanMarkdownDirSync(compPath);
          components[comp] = files;
        } else {
          components[comp] = true;
        }
      }
    }
    return components;
  }

  async _scanComponentsAsync(packDir) {
    const components = {};
    for (const comp of VALID_PACK_COMPONENTS) {
      const compPath = path.join(packDir, comp);
      try {
        const stat = await fs.promises.stat(compPath);
        if (stat.isDirectory()) {
          const files = (await fs.promises.readdir(compPath)).filter(f => f.endsWith(MARKDOWN_EXT));
          components[comp] = files;
        } else {
          components[comp] = true;
        }
      } catch (e) {
        debug('AgentPackManager', '_scanComponentsAsync', comp, e && e.message ? e.message : String(e));
      }
    }
    return components;
  }

  _ensureDiscovered() {
    if (this._packsCache === null) {
      this.discover();
    }
  }

  /**
   * 列出所有已发现的包及其基本信息。
   * @returns {Object[]} 包信息数组 [{id, name, version, description, author, category, tags, components, installed, installedAt, installedVersion}]
   */
  list() {
    this._ensureDiscovered();
    const packs = [];
    for (const [id, info] of Object.entries(this._packsCache)) {
      packs.push({
        id,
        name: info.manifest.name,
        version: info.manifest.version,
        description: info.manifest.description,
        author: info.manifest.author || '',
        category: info.manifest.category || '',
        tags: info.manifest.tags ?? [],
        components: info.components,
        installed: info.installed,
        installedAt: info.installedAt ?? null,
        installedVersion: info.installedVersion ?? null,
      });
    }
    return packs;
  }

  /**
   * 列出所有已安装的包。
   * @returns {Object[]} 已安装包数组 [{id, name, version, installedAt}]
   */
  listInstalled() {
    this._ensureDiscovered();
    const installed = [];
    for (const [id, info] of Object.entries(this._packsCache)) {
      if (info.installed) {
        installed.push({
          id,
          name: info.manifest.name,
          version: info.manifest.version,
          installedAt: info.installedAt,
        });
      }
    }
    return installed;
  }

  /**
   * 获取指定包的详细信息。
   * @param {string} packId - 包标识
   * @returns {Object|null} 包详情 {manifest, components, installed, installedAt, installedVersion}，不存在时返回null
   */
  getPackInfo(packId) {
    this._ensureDiscovered();
    const info = this._packsCache[packId];
    if (!info) return null;

    return {
      manifest: info.manifest,
      components: info.components,
      installed: info.installed,
      installedAt: info.installedAt ?? null,
      installedVersion: info.installedVersion ?? null,
    };
  }

  /**
   * 验证指定包的完整性和格式规范。
   * @param {string} packId - 包标识
   * @returns {Object} 验证结果 {valid, errors, packId, name, version}
   */
  validatePack(packId) {
    this._ensureDiscovered();
    const info = this._packsCache[packId];
    if (!info) return { valid: false, reason: `Pack not found: ${packId}` };

    const m = info.manifest;
    const errors = REQUIRED_PACK_FIELDS.filter(f => !m[f]).map(f => `Missing required field: ${f}`);

    if (m.version && !/^\d+\.\d+\.\d+/.test(m.version)) {
      errors.push(`Invalid version format: ${m.version} (expected SemVer)`);
    }

    if (m.dependencies && Array.isArray(m.dependencies)) {
      for (const dep of m.dependencies) {
        if (!dep.id) {
          errors.push('Dependency missing id field');
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      packId,
      name: m.name,
      version: m.version,
    };
  }

  /**
   * 安装指定包，校验完整性、解析依赖并部署组件到对应目录。
   * @param {string} packId - 包标识
   * @returns {Object} 安装结果 {success, packId?, version?, installedAt?, reason?, validation?}
   */
  install(packId) {
    this.guardShutdown();
    this._ensureDiscovered();
    if (!packId || typeof packId !== 'string') return { success: false, reason: 'Invalid packId' };
    const info = this._packsCache[packId];
    if (!info) return { success: false, reason: `Pack not found: ${packId}` };

    if (info.installed) {
      return { success: false, reason: `Pack already installed: ${packId} v${info.manifest.version}` };
    }

    const validation = this.validatePack(packId);
    if (!validation.valid) {
      return { success: false, reason: `Pack validation failed: ${validation.errors.join('; ')}`, validation };
    }

    if (Array.isArray(info.manifest.dependencies) && info.manifest.dependencies.length > 0) {
      for (const dep of info.manifest.dependencies) {
        const depInfo = this._packsCache[dep.id];
        if (!depInfo || !depInfo.installed) {
          return { success: false, reason: `Dependency not installed: ${dep.id}` };
        }
        if (dep.version) {
          const installedVer = depInfo.installedVersion || depInfo.manifest.version;
          if (!this._satisfiesVersion(installedVer, dep.version)) {
            return { success: false, reason: `Dependency version mismatch: ${dep.id} requires ${dep.version}, installed ${installedVer}` };
          }
        }
      }
    }

    this._installComponents(info);

    const now = new Date().toISOString();
    if (this._installed.length >= MAX_INSTALLED) this._installed.shift();
    this._installed.push({
      id: packId,
      version: info.manifest.version,
      installedAt: now,
    });
    this._saveInstalled();

    info.installed = true;
    info.installedAt = now;
    info.installedVersion = info.manifest.version;

    this.emit('pack-installed', { packId, version: info.manifest.version, installedAt: now });

    return { success: true, packId, version: info.manifest.version, installedAt: now };
  }

  /**
   * 卸载指定包，检查反向依赖并移除已部署的组件文件。
   * @param {string} packId - 包标识
   * @returns {Object} 卸载结果 {success, packId?, reason?}
   */
  uninstall(packId) {
    this.guardShutdown();
    this._ensureDiscovered();
    if (!packId || typeof packId !== 'string') return { success: false, reason: 'Invalid packId' };
    const info = this._packsCache[packId];
    if (!info) return { success: false, reason: `Pack not found: ${packId}` };

    if (!info.installed) {
      return { success: false, reason: `Pack not installed: ${packId}` };
    }

    for (const [id, otherInfo] of Object.entries(this._packsCache)) {
      if (id !== packId && otherInfo.installed) {
        const deps = otherInfo.manifest.dependencies ?? [];
        if (deps.some(d => d.id === packId)) {
          return { success: false, reason: `Cannot uninstall: ${otherInfo.manifest.name} depends on ${info.manifest.name}` };
        }
      }
    }

    this._uninstallComponents(info);

    this._installed = this._installed.filter(e => e.id !== packId);
    this._saveInstalled();

    info.installed = false;
    info.installedAt = null;
    info.installedVersion = null;

    this.emit('pack-uninstalled', { packId });

    return { success: true, packId };
  }

  _installComponents(info) {
    const agentsDir = this._agentsDir;
    const commandsDir = this._commandsDir;
    const skillsDir = this._skillsDir;

    if (info.components['agent.md']) {
      const src = path.join(info.dir, 'agent.md');
      const dest = path.join(agentsDir, `${info.manifest.id}-agent.md`);
      safeCall(() => { ensureDirSync(agentsDir); fs.copyFileSync(src, dest); }, 'AgentPackManager', 'installAgent');
    }

    if (info.components['command.md']) {
      const src = path.join(info.dir, 'command.md');
      const dest = path.join(commandsDir, `${info.manifest.id}.md`);
      safeCall(() => { ensureDirSync(commandsDir); fs.copyFileSync(src, dest); }, 'AgentPackManager', 'installCommand');
    }

    if (info.components['skills']) {
      const skills = info.components['skills'];
      if (Array.isArray(skills) && skills.length > 0) {
        safeCall(() => ensureDirSync(skillsDir), 'AgentPackManager', 'mkdirSkills');
        for (const skillFile of skills) {
          const src = path.join(info.dir, 'skills', skillFile);
          const dest = path.join(skillsDir, skillFile);
          safeCall(() => fs.copyFileSync(src, dest), 'AgentPackManager', 'copySkill');
        }
      }
    }
  }

  _uninstallComponents(info) {
    const agentsDir = this._agentsDir;
    const commandsDir = this._commandsDir;
    const skillsDir = this._skillsDir;

    if (info.components['agent.md']) {
      const dest = path.join(agentsDir, `${info.manifest.id}-agent.md`);
      safeCall(() => { if (fs.existsSync(dest)) fs.unlinkSync(dest); }, 'AgentPackManager', 'unlinkAgent');
    }

    if (info.components['command.md']) {
      const dest = path.join(commandsDir, `${info.manifest.id}.md`);
      safeCall(() => { if (fs.existsSync(dest)) fs.unlinkSync(dest); }, 'AgentPackManager', 'unlinkCommand');
    }

    if (info.components['skills']) {
      const skills = info.components['skills'];
      if (Array.isArray(skills) && skills.length > 0) {
        for (const skillFile of skills) {
          const dest = path.join(skillsDir, skillFile);
          safeCall(() => { if (fs.existsSync(dest)) fs.unlinkSync(dest); }, 'AgentPackManager', 'unlinkSkill');
        }
      }
    }
  }

  _satisfiesVersion(installed, required) {
    const prefix = required.match(/^[\^~>=<]+/);
    const prefixStr = prefix ? prefix[0] : '';
    const reqClean = required.replace(/^[\^~>=<]+/, '');
    const reqParts = reqClean.split('.').map(p => { const n = parseInt(p, 10); return Number.isFinite(n) ? n : 0; });
    const instParts = installed.split('.').map(p => { const n = parseInt(p, 10); return Number.isFinite(n) ? n : 0; });

    if (prefixStr.startsWith('>=')) {
      return this._compareVersions(instParts, reqParts) >= 0;
    }
    if (prefixStr.startsWith('>')) {
      return this._compareVersions(instParts, reqParts) > 0;
    }
    if (prefixStr.startsWith('<=')) {
      return this._compareVersions(instParts, reqParts) <= 0;
    }
    if (prefixStr.startsWith('<')) {
      return this._compareVersions(instParts, reqParts) < 0;
    }
    if (prefixStr.startsWith('~')) {
      if (this._compareVersions(instParts, reqParts) < 0) return false;
      return instParts[0] === reqParts[0] && instParts[1] === reqParts[1];
    }
    if (prefixStr.startsWith('^')) {
      if (this._compareVersions(instParts, reqParts) < 0) return false;
      return instParts[0] === reqParts[0];
    }
    return this._compareVersions(instParts, reqParts) === 0;
  }

  _compareVersions(instParts, reqParts) {
    for (let i = 0; i < Math.max(instParts.length, reqParts.length); i++) {
      const v = instParts[i] ?? 0;
      const r = reqParts[i] ?? 0;
      if (v > r) return 1;
      if (v < r) return -1;
    }
    return 0;
  }

  /**
   * 重新安装指定包，先卸载再重新发现并安装。
   * @param {string} packId - 包标识
   * @returns {Object} 安装结果 {success, packId?, reason?}
   */
  reinstall(packId) {
    this.guardShutdown();
    const uninstallResult = this.uninstall(packId);
    if (!uninstallResult.success) {
      return { success: false, reason: `Uninstall failed: ${uninstallResult.reason}` };
    }
    this._packsCache = null;
    this._installed = null;
    this.discover();
    return this.install(packId);
  }

  /**
   * 获取包管理器的统计信息。
   * @returns {Object} 统计数据 {totalPacks, installedPacks, availablePacks, categories, authors}
   */
  getStats() {
    this._ensureDiscovered();
    const total = Object.keys(this._packsCache).length;
    let installed = 0;
    const categories = {};
    const authors = {};

    for (const [, info] of Object.entries(this._packsCache)) {
      if (info.installed) installed++;

      const cat = info.manifest.category ?? 'uncategorized';
      categories[cat] = (categories[cat] ?? 0) + 1;

      const author = info.manifest.author ?? 'unknown';
      authors[author] = (authors[author] ?? 0) + 1;
    }

    return {
      totalPacks: total,
      installedPacks: installed,
      availablePacks: total - installed,
      categories,
      authors,
    };
  }

  _onShutdown() {
    this._packsCache = null;
    this._installed = null;
    this.removeAllListeners();
  }

  /**
   * 检查包目录是否可读，判断管理器健康状态。
   * @returns {boolean} 是否健康
   */
  isHealthy() {
    try {
      fs.accessSync(this._packsDir, fs.constants.R_OK);
      return true;
    } catch (e) {
      debug('AgentPackManager', 'isHealthy', e && e.message ? e.message : String(e));
      return false;
    }
  }
}

module.exports = withShutdown(AgentPackManager);
