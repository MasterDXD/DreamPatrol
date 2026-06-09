'use strict';

/** @module runtime/infrastructure/git-worktree-manager
 * Git工作树管理器。被 DeriveExecutor 引用，用于派生分支的隔离环境管理。
 */

const { EventEmitter } = require('events');
const { execFile, execFileSync } = require('child_process');
const { debug } = require('../../utils/debug-logger');
const { withShutdown } = require('../../utils/shutdown-mixin');
const safeAssign = require('../../utils/safe-assign');

const DEFAULT_OPTIONS = {
  maxWorktrees: 10,
  worktreePrefix: 'harness-agent-',
  autoCleanup: true,
  cleanupTimeoutMs: 30 * 60 * 1000,
};

/**
 * @classdesc Git工作树管理器。创建/移除隔离Git worktree供Agent并行工作
 */
class GitWorktreeManager extends EventEmitter {
  /**
   * 创建 GitWorktreeManager 实例。
   * @param {Object} [options] - 配置选项
   * @param {string} [options.worktreePrefix='harness-agent-'] - 工作树前缀
   * @param {boolean} [options.autoCleanup=true] - 是否自动清理过期工作树
   * @param {number} [options.cleanupTimeoutMs=1800000] - 清理超时时间（毫秒）
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._config = safeAssign({}, DEFAULT_OPTIONS, opts);
    this._worktrees = new Map();
    this._stats = { created: 0, removed: 0, errors: 0, activePeak: 0 };
  }

  _execGit(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error('git ' + args.join(' ') + ' failed: ' + (stderr || (err && err.message ? err.message : String(err)))));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /**
   * 为指定Agent创建隔离的Git worktree和分支。
   * @param {string} agentId - Agent标识符
   * @param {string} [branchName] - 分支名称，默认为worktree前缀+agentId
   * @returns {Promise<Object|null>} worktree条目对象，达到上限或创建失败时返回null
   */
  async create(agentId, branchName) {
    this.guardShutdown();
    if (this._worktrees.size >= this._config.maxWorktrees) {
      debug('GitWorktreeManager', 'create', 'Max worktrees limit reached: ' + this._config.maxWorktrees);
      return null;
    }
    const worktreeId = this._config.worktreePrefix + agentId;
    if (this._worktrees.has(worktreeId)) {
      return this._worktrees.get(worktreeId);
    }
    const branch = branchName || worktreeId;
    try {
      await this._execGit(['worktree', 'add', worktreeId, '-b', branch]);
      const entry = {
        id: worktreeId,
        agentId,
        branch,
        createdAt: Date.now(),
        status: 'active',
      };
      this._worktrees.set(worktreeId, entry);
      this._stats.created++;
      this._stats.activePeak = Math.max(this._stats.activePeak, this._worktrees.size);
      this.emit('worktree:created', { worktreeId, agentId, branch });
      return entry;
    } catch (err) {
      debug('GitWorktreeManager', 'create', err && err.message ? err.message : String(err));
      this._stats.errors++;
      return null;
    }
  }

  /**
   * 移除指定worktree并删除对应分支。
   * @param {string} worktreeId - worktree标识符
   * @returns {Promise<boolean>} 移除成功返回true，不存在或失败返回false
   */
  async remove(worktreeId) {
    this.guardShutdown();
    const entry = this._worktrees.get(worktreeId);
    if (!entry) return false;
    try {
      await this._execGit(['worktree', 'remove', worktreeId, '--force']);
      try { await this._execGit(['branch', '-D', entry.branch]); } catch (_e) { debug('GitWorktreeManager', 'remove:branch', _e && _e.message ? _e.message : String(_e)); }
      this._worktrees.delete(worktreeId);
      this._stats.removed++;
      this.emit('worktree:removed', { worktreeId, agentId: entry.agentId });
      return true;
    } catch (err) {
      debug('GitWorktreeManager', 'remove', err && err.message ? err.message : String(err));
      this._stats.errors++;
      return false;
    }
  }

  /**
   * 列出所有Git worktree，解析 `git worktree list --porcelain` 输出。
   * @returns {Promise<Array<Object>>} worktree列表，每项包含path和branch字段
   */
  async list() {
    try {
      const output = await this._execGit(['worktree', 'list', '--porcelain']);
      const worktrees = [];
      const lines = output.split('\n');
      let current = {};
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          if (current.path) worktrees.push(current);
          current = { path: line.substring(9) };
        } else if (line.startsWith('branch ')) {
          current.branch = line.substring(7);
        } else if (line === '') {
          if (current.path) worktrees.push(current);
          current = {};
        }
      }
      if (current.path) worktrees.push(current);
      return worktrees;
    } catch (err) {
      debug('GitWorktreeManager', 'list', err && err.message ? err.message : String(err));
      return [];
    }
  }

  /** 获取所有状态为active的worktree条目列表 @returns {Array<Object>} */
  getActiveWorktrees() {
    return [...this._worktrees.values()].filter(w => w.status === 'active');
  }

  /** 根据Agent ID查找其对应的worktree条目 @param {string} agentId @returns {Object|null} */
  getWorktreeForAgent(agentId) {
    const worktreeId = this._config.worktreePrefix + agentId;
    return this._worktrees.get(worktreeId) ?? null;
  }

  /**
   * 批量移除所有已注册的worktree。
   * @returns {Promise<Array<{worktreeId: string, removed: boolean}>>} 每个worktree的移除结果
   */
  async cleanupAll() {
    const ids = [...this._worktrees.keys()];
    const results = [];
    for (const id of ids) {
      const removed = await this.remove(id);
      results.push({ worktreeId: id, removed });
    }
    return results;
  }

  /** 获取worktree管理器运行统计 @returns {Object} 包含active/created/removed/errors/activePeak字段 */
  getStats() {
    return {
      active: this._worktrees.size,
      created: this._stats.created,
      removed: this._stats.removed,
      errors: this._stats.errors,
      activePeak: this._stats.activePeak,
      maxWorktrees: this._config.maxWorktrees,
    };
  }

  /** 检查管理器健康状态，错误数低于50时为健康 @returns {boolean} */
  isHealthy() {
    return this._stats.errors < 50;
  }

  _onShutdown() {
    if (this._config.autoCleanup && this._worktrees.size > 0) {
      debug('GitWorktreeManager', '_onShutdown', 'Auto-cleanup ' + this._worktrees.size + ' worktrees');
      for (const [id, entry] of this._worktrees) {
        try {
          execFileSync('git', ['worktree', 'remove', id, '--force'], { cwd: process.cwd(), timeout: 10000, stdio: 'pipe' });
          try { execFileSync('git', ['branch', '-D', entry.branch], { cwd: process.cwd(), timeout: 10000, stdio: 'pipe' }); } catch (_e) { debug('GitWorktreeManager', '_onShutdown:branch', _e && _e.message ? _e.message : String(_e)); }
        } catch (_e) { debug('GitWorktreeManager', '_onShutdown:remove', _e && _e.message ? _e.message : String(_e)); }
      }
    }
    this._worktrees.clear();
    this._stats = { created: 0, removed: 0, errors: 0, activePeak: 0 };
    this.removeAllListeners();
  }
}

module.exports = { GitWorktreeManager: withShutdown(GitWorktreeManager) };
