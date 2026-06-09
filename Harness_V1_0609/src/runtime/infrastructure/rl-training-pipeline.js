'use strict';

/** @module runtime/infrastructure/rl-training-pipeline */

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const debug = require('../../utils/debug-logger')('RLTrainingPipeline');
const { DeepeningError } = require('../../errors');
const { generateId } = require('../../utils/unique-id');

const RUN_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

const DEFAULT_ATROPOS_URL = 'http://127.0.0.1:8000';
const DEFAULT_TINKER_URL = 'http://127.0.0.1:8001';
const MAX_TRAJECTORIES = 10000;
const MAX_REWARD_HISTORY = 1000;
const TRAINING_TIMEOUT = 3600000;
const CHECKPOINT_INTERVAL = 100;
const HTTP_TIMEOUT_MS = 30000;
const MAX_HTTP_RESPONSE_SIZE = 10 * 1024 * 1024;
const MAX_ENVIRONMENTS = 100;
const MAX_RUNS = 50;

/**
 * RLTrainingPipeline — Hermes RL-style reinforcement learning training pipeline adapter.
 * Manages the RL training lifecycle: trajectory collection → reward computation →
 * training execution → model deployment. Bridges Harness's Node.js runtime with the
 * Hermes RL Python training infrastructure (Atropos + Tinker) via MCP protocol and
 * subprocess management.
 *
 * @classdesc 强化学习训练管线。训练运行生命周期管理
 * @extends EventEmitter
 */
class RLTrainingPipeline extends EventEmitter {
  /**
   * Create an RLTrainingPipeline instance.
   * @param {Object} [options] - Configuration options
   * @param {string} [options.atroposUrl='http://127.0.0.1:8000'] - Atropos trajectory server URL
   * @param {string} [options.tinkerUrl='http://127.0.0.1:8001'] - Tinker training service URL
   * @param {Object} [options.mcpClient] - Reference to existing MCPClient for BrowserUse MCP mode
   * @param {string} [options.mcpServerName='hermes-rl'] - Name of Hermes RL MCP server
   * @param {number} [options.maxTrajectories=10000] - Max stored trajectories
   * @param {number} [options.maxRewardHistory=1000] - Max reward computation history
   * @param {number} [options.trainingTimeout=3600000] - Max training run duration in ms
   * @param {number} [options.checkpointInterval=100] - Checkpoint every N steps
   */
  constructor(options) {
    super();
    const opts = options ?? {};
    this._atroposUrl = opts.atroposUrl ?? DEFAULT_ATROPOS_URL;
    this._tinkerUrl = opts.tinkerUrl ?? DEFAULT_TINKER_URL;
    this._mcpClient = opts.mcpClient ?? null;
    this._mcpServerName = opts.mcpServerName ?? 'hermes-rl';
    this._maxTrajectories = (typeof opts.maxTrajectories === 'number' && Number.isFinite(opts.maxTrajectories)) ? opts.maxTrajectories : MAX_TRAJECTORIES;
    this._maxRewardHistory = (typeof opts.maxRewardHistory === 'number' && Number.isFinite(opts.maxRewardHistory)) ? opts.maxRewardHistory : MAX_REWARD_HISTORY;
    this._trainingTimeout = (typeof opts.trainingTimeout === 'number' && Number.isFinite(opts.trainingTimeout)) ? opts.trainingTimeout : TRAINING_TIMEOUT;
    this._checkpointInterval = (typeof opts.checkpointInterval === 'number' && Number.isFinite(opts.checkpointInterval)) ? opts.checkpointInterval : CHECKPOINT_INTERVAL;
    this._trajectories = new Map();
    this._rewardHistory = [];
    this._environments = new Map();
    this._runs = new Map();
    this._activeRunId = null;
    this._stats = {
      totalTrajectories: 0,
      totalRewardsComputed: 0,
      totalTrainingRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      totalTrainingTimeMs: 0,
      bestRewardScore: -Infinity,
    };
    this._childProcess = null;
    this._config = null;
  }

  /**
   * List available RL environments.
   * MCP mode: calls rl_list_environments tool on the MCP server.
   * Direct mode: HTTP GET to {atropusUrl}/api/environments.
   * Results are cached in _environments.
   * @returns {Promise<Array<{name: string, description: string, configSchema: Object}>>} Available environments
   */
  async listEnvironments() {
    this.guardShutdown();
    if (this._mcpClient) {
      const result = await this._mcpClient.callTool(
        'mcp_' + this._mcpServerName + '_rl_list_environments',
        {},
      );
      const envs = this._extractMcpResult(result);
      if (Array.isArray(envs)) {
        for (const env of envs) {
          if (env && env.name) this._environments.set(env.name, env);
        }
        while (this._environments.size > MAX_ENVIRONMENTS) {
          const oldestKey = this._environments.keys().next().value;
          this._environments.delete(oldestKey);
        }
      }
      return envs;
    }
    const data = await this._httpRequest(this._atropusUrl + '/api/environments', 'GET');
    const envs = Array.isArray(data) ? data : [];
    for (const env of envs) {
      if (env && env.name) this._environments.set(env.name, env);
    }
    while (this._environments.size > MAX_ENVIRONMENTS) {
      const oldestKey = this._environments.keys().next().value;
      this._environments.delete(oldestKey);
    }
    return envs;
  }

  /**
   * Select and load an RL environment.
   * @param {string} envName - Environment name to select
   * @returns {Promise<Object>} Configuration with configurable/locked fields
   * @throws {DeepeningError} Environment not found or selection failed
   */
  async selectEnvironment(envName) {
    this.guardShutdown();
    if (!envName || typeof envName !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'envName must be a non-empty string');
    }
    if (this._mcpClient) {
      const result = await this._mcpClient.callTool(
        'mcp_' + this._mcpServerName + '_rl_select_env',
        { envName },
      );
      return this._extractMcpResult(result);
    }
    return this._httpRequest(
      this._atropusUrl + '/api/environments/' + encodeURIComponent(envName) + '/select',
      'POST',
    );
  }

  /**
   * Get current training configuration.
   * @returns {Promise<{configurable: Object, locked: Object, current: Object}>} Training configuration
   */
  async getConfig() {
    this.guardShutdown();
    if (this._mcpClient) {
      const result = await this._mcpClient.callTool(
        'mcp_' + this._mcpServerName + '_rl_get_config',
        {},
      );
      const config = this._extractMcpResult(result);
      if (config) { this._config = config; }
      return config;
    }
    const config = await this._httpRequest(this._tinkerUrl + '/api/config', 'GET');
    if (config) { this._config = config; }
    return config;
  }

  /**
   * Modify training parameters.
   * @param {Object} changes - Key-value pairs of configuration changes
   * @returns {Promise<Object>} Updated configuration
   * @throws {DeepeningError} Changes must be a non-empty object
   */
  async editConfig(changes) {
    this.guardShutdown();
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
      throw new DeepeningError('INVALID_INPUT', 'changes must be an object with at least one key');
    }
    if (this._mcpClient) {
      const result = await this._mcpClient.callTool(
        'mcp_' + this._mcpServerName + '_rl_edit_config',
        { changes },
      );
      const config = this._extractMcpResult(result);
      if (config) {
        this._config = config;
        this.emit('config-updated', { config });
      }
      return config;
    }
    const config = await this._httpRequest(this._tinkerUrl + '/api/config', 'PATCH', changes);
    this._config = config;
    this.emit('config-updated', { config });
    return config;
  }

  /**
   * Start a training run.
   * @param {Object} [options] - Training options
   * @returns {Promise<{runId: string, status: string}>} Run identifier and initial status
   * @throws {DeepeningError} Active run exists or no environment selected
   */
  async startTraining(options) {
    this.guardShutdown();
    if (this._activeRunId) {
      throw new DeepeningError('INVALID_STATE', 'A training run is already active: ' + this._activeRunId);
    }
    if (this._environments.size === 0) {
      throw new DeepeningError('INVALID_STATE', 'No environment selected; call selectEnvironment first');
    }
    const runId = generateId('rl-run-');
    const now = Date.now();
    this._runs.set(runId, {
      runId,
      status: RUN_STATES.PENDING,
      startTime: now,
      options: options ?? {},
    });
    this._evictOldRuns();
    this._stats.totalTrainingRuns++;

    if (this._mcpClient) {
      try {
        const result = await this._mcpClient.callTool(
          'mcp_' + this._mcpServerName + '_rl_start_training',
          { runId, ...(options ?? {}) },
        );
        const trainingResult = this._extractMcpResult(result);
        const run = this._runs.get(runId);
        if (run) {
          run.status = RUN_STATES.RUNNING;
          run.mcpData = trainingResult;
        }
      } catch (err) {
        const run = this._runs.get(runId);
        if (run) run.status = RUN_STATES.FAILED;
        this._stats.failedRuns++;
        throw err;
      }
    } else {
      try {
        await this._spawnTrainingProcess(runId, options);
        const run = this._runs.get(runId);
        if (run) run.status = RUN_STATES.RUNNING;
      } catch (err) {
        const run = this._runs.get(runId);
        if (run) run.status = RUN_STATES.FAILED;
        this._stats.failedRuns++;
        throw err;
      }
    }

    if (this._shutDown) { const _run = this._runs.get(runId); if (_run) { _run.status = RUN_STATES.STOPPED; _run.endTime = Date.now(); } return { runId: null, status: 'aborted', error: 'Shut down during training start' }; }

    this._activeRunId = runId;
    this.emit('training-started', { runId, status: RUN_STATES.RUNNING });
    return { runId, status: RUN_STATES.RUNNING };
  }

  _evictOldRuns() {
    while (this._runs.size > MAX_RUNS) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [key, val] of this._runs) {
        if (val.status === RUN_STATES.COMPLETED || val.status === RUN_STATES.FAILED || val.status === RUN_STATES.STOPPED) {
          if (val.startTime < oldestTime) {
            oldestTime = val.startTime;
            oldestKey = key;
          }
        }
      }
      if (oldestKey) {
        this._runs.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  /**
   * Monitor training progress.
   * @param {string} runId - Training run identifier
   * @returns {Promise<{status: string, step: number, totalSteps: number, metrics: Object, wandbUrl: string}>} Training status
   */
  async checkStatus(runId) {
    this.guardShutdown();
    if (!runId || typeof runId !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'runId must be a non-empty string');
    }
    if (this._mcpClient) {
      const result = await this._mcpClient.callTool(
        'mcp_' + this._mcpServerName + '_rl_check_status',
        { runId },
      );
      return this._extractMcpResult(result);
    }
    return this._httpRequest(
      this._tinkerUrl + '/api/runs/' + encodeURIComponent(runId) + '/status',
      'GET',
    );
  }

  /**
   * Stop a training run.
   * @param {string} runId - Training run identifier
   * @returns {Promise<Object>} Stop confirmation
   */
  async stopTraining(runId) {
    this.guardShutdown();
    if (!runId || typeof runId !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'runId must be a non-empty string');
    }
    if (this._mcpClient) {
      const _result = await this._mcpClient.callTool(
        'mcp_' + this._mcpServerName + '_rl_stop_training',
        { runId },
      );
    } else {
      await this._httpRequest(
        this._tinkerUrl + '/api/runs/' + encodeURIComponent(runId) + '/stop',
        'POST',
      );
    }
    const run = this._runs.get(runId);
    if (run) {
      run.status = RUN_STATES.STOPPED;
      run.endTime = Date.now();
    }
    if (this._activeRunId === runId) {
      this._activeRunId = null;
    }
    this._killChildProcess();
    this.emit('training-stopped', { runId });
    return { runId, status: RUN_STATES.STOPPED };
  }

  /**
   * Get final training results.
   * @param {string} runId - Training run identifier
   * @returns {Promise<{metrics: Object, modelWeightsPath: string, loraAdapterPath: string, runDurationMs: number}>} Training results
   */
  async getResults(runId) {
    this.guardShutdown();
    if (!runId || typeof runId !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'runId must be a non-empty string');
    }
    let results;
    if (this._mcpClient) {
      const result = await this._mcpClient.callTool(
        'mcp_' + this._mcpServerName + '_rl_get_results',
        { runId },
      );
      results = this._extractMcpResult(result);
    } else {
      results = await this._httpRequest(
        this._tinkerUrl + '/api/runs/' + encodeURIComponent(runId) + '/results',
        'GET',
      );
    }
    this._notifyGovernorTrainingResult(runId, results);
    return results;
  }

  /**
   * List all training runs.
   * @returns {Promise<Array>} Array of run state objects
   */
  async listRuns() {
    this.guardShutdown();
    return Array.from(this._runs.values()).map(r => ({ ...r }));
  }

  /**
   * Quick inference test against a trained model.
   * @param {string} modelPath - Path to the trained model
   * @param {string} prompt - Input prompt for inference
   * @returns {Promise<{response: string, tokensUsed: number, latencyMs: number}>} Inference result
   * @throws {DeepeningError} modelPath or prompt invalid
   */
  async inference(modelPath, prompt) {
    this.guardShutdown();
    if (!modelPath || typeof modelPath !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'modelPath must be a non-empty string');
    }
    if (!prompt || typeof prompt !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'prompt must be a non-empty string');
    }
    if (this._mcpClient) {
      const result = await this._mcpClient.callTool(
        'mcp_' + this._mcpServerName + '_rl_inference',
        { modelPath, prompt },
      );
      return this._extractMcpResult(result);
    }
    return this._httpRequest(this._tinkerUrl + '/api/inference', 'POST', { modelPath, prompt });
  }

  /**
   * Collect a trajectory from a Harness session.
   * Converts Harness session format to RL trajectory format by extracting
   * (observation, action, reward, nextObservation) tuples from CausalDataBus entries,
   * using QualityScorer total as reward signal, with terminal flag for session boundaries.
   * @param {Object} sessionData - Session data with sessionId and actions array
   * @param {string} sessionData.sessionId - Session identifier
   * @param {Array} sessionData.actions - Array of action entries
   * @returns {Promise<{trajectoryId: string, tupleCount: number}>} Trajectory identifier and tuple count
   * @throws {DeepeningError} sessionData missing required fields
   */
  async collectTrajectory(sessionData) {
    this.guardShutdown();
    if (!sessionData || typeof sessionData !== 'object') {
      throw new DeepeningError('INVALID_INPUT', 'sessionData must be an object');
    }
    if (!sessionData.sessionId || typeof sessionData.sessionId !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'sessionData.sessionId must be a non-empty string');
    }
    if (!Array.isArray(sessionData.actions)) {
      throw new DeepeningError('INVALID_INPUT', 'sessionData.actions must be an array');
    }

    const trajectoryId = generateId('traj-');
    const tuples = [];
    const actions = sessionData.actions;

    for (let i = 0; i < actions.length; i++) {
      const entry = actions[i];
      const observation = entry.observation ?? entry.state ?? null;
      const action = entry.action ?? entry.toolCall ?? null;
      const reward = Number.isFinite(entry.reward)
        ? entry.reward
        : (Number.isFinite(entry.qualityScore) ? entry.qualityScore : 0);
      const nextObservation = i < actions.length - 1
        ? (actions[i + 1].observation ?? actions[i + 1].state ?? null)
        : null;
      const terminal = i === actions.length - 1;

      tuples.push({ observation, action, reward, nextObservation, terminal });
    }

    if (this._trajectories.size >= this._maxTrajectories) {
      const oldestKey = this._trajectories.keys().next().value;
      this._trajectories.delete(oldestKey);
    }

    this._trajectories.set(trajectoryId, {
      trajectoryId,
      sessionId: sessionData.sessionId,
      tuples,
      collectedAt: new Date().toISOString(),
    });

    this._stats.totalTrajectories++;
    if (this._shutDown) return { trajectory: null, error: 'Shut down during collection' };
    this.emit('trajectory-collected', { trajectoryId, tupleCount: tuples.length });
    return { trajectoryId, tupleCount: tuples.length };
  }

  /**
   * Compute reward for a trajectory.
   * If rewardFunction is provided, calls it with trajectory data.
   * Otherwise uses default reward: QualityScorer total (0-1) + bonus for self-healing + penalty for errors.
   * @param {string} trajectoryId - Trajectory identifier
   * @param {Function} [rewardFunction] - Optional custom reward function
   * @returns {Promise<{trajectoryId: string, reward: number, components: Object}>} Reward computation result
   * @throws {DeepeningError} Trajectory not found
   */
  async computeReward(trajectoryId, rewardFunction) {
    this.guardShutdown();
    if (!trajectoryId || typeof trajectoryId !== 'string') {
      throw new DeepeningError('INVALID_INPUT', 'trajectoryId must be a non-empty string');
    }
    const trajectory = this._trajectories.get(trajectoryId);
    if (!trajectory) {
      throw new DeepeningError('RESOURCE_NOT_FOUND', 'Trajectory not found: ' + trajectoryId);
    }

    let reward;
    let components;

    if (typeof rewardFunction === 'function') {
      reward = rewardFunction(trajectory);
      components = { custom: reward };
    } else {
      const tuples = trajectory.tuples;
      let qualitySum = 0;
      let selfHealingBonus = 0;
      let errorPenalty = 0;
      let count = 0;

      for (const tuple of tuples) {
        if (Number.isFinite(tuple.reward)) {
          qualitySum += tuple.reward;
          count++;
        }
        if (tuple.action && typeof tuple.action === 'object' && tuple.action.selfHealing) {
          selfHealingBonus += 0.1;
        }
        if (tuple.action && typeof tuple.action === 'object' && tuple.action.error) {
          errorPenalty -= 0.05;
        }
      }

      const baseReward = count > 0 ? qualitySum / count : 0;
      reward = Math.max(0, Math.min(1, baseReward + selfHealingBonus + errorPenalty));
      components = { quality: baseReward, selfHealingBonus, errorPenalty };
    }

    if (this._rewardHistory.length >= this._maxRewardHistory) {
      this._rewardHistory.shift();
    }

    const result = { trajectoryId, reward, components, computedAt: new Date().toISOString() };
    this._rewardHistory.push(result);
    this._stats.totalRewardsComputed++;
    if (reward > this._stats.bestRewardScore) {
      this._stats.bestRewardScore = reward;
    }
    if (this._shutDown) return { reward: 0, error: 'Shut down during reward computation' };
    this.emit('reward-computed', result);
    return { trajectoryId, reward, components };
  }

  /**
   * Attach a SelfEvolutionGovernor instance for bidirectional feedback.
   * When RL training completes, results are forwarded to the governor as observations.
   * @param {Object} governor - SelfEvolutionGovernor instance
   * @returns {RLTrainingPipeline} This instance for chaining
   */
  attachGovernor(governor) {
    this.guardShutdown();
    this._governor = governor;
    return this;
  }

  /**
   * Get pipeline statistics.
   * @returns {Object} Statistics object
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * Check if the pipeline is healthy (not shut down).
   * @returns {boolean} Health status
   */
  isHealthy() {
    return !this._shutDown;
  }

  _onShutdown() {
    if (this._activeRunId) {
      const activeRunId = this._activeRunId;
      this.stopTraining(activeRunId).catch(err => {
        debug('RLTrainingPipeline', 'shutdown:stopTraining', err && err.message ? err.message : String(err));
      });
    }
    this._killChildProcess();
    this._governor = null;
    this._trajectories.clear();
    this._rewardHistory.length = 0;
    this._environments.clear();
    this._runs.clear();
    this._stats = {
      totalTrajectories: 0,
      totalRewardsComputed: 0,
      totalTrainingRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      totalTrainingTimeMs: 0,
      bestRewardScore: -Infinity,
    };
    this._config = null;
    this._mcpClient = null;
    this._childProcess = null;
    this._activeRunId = null;
    this.removeAllListeners();
  }

  _killChildProcess() {
    if (this._childProcess) {
      safeCall(() => {
        if (this._childProcess.stdin) {
          this._childProcess.stdin.removeAllListeners();
          this._childProcess.stdin.end();
        }
        if (this._childProcess.stdout) this._childProcess.stdout.removeAllListeners();
        if (this._childProcess.stderr) this._childProcess.stderr.removeAllListeners();
        this._childProcess.removeAllListeners();
        if (!this._childProcess.killed) {
          this._childProcess.kill();
        }
      }, 'RLTrainingPipeline', 'killChildProcess');
      this._childProcess = null;
    }
  }

  async _spawnTrainingProcess(runId, options) {
    const opts = options ?? {};
    return new Promise((resolve, reject) => {
      let settled = false;
      const args = [
        '-m', 'atropos.train',
        '--atropus-url', this._atropusUrl,
        '--tinker-url', this._tinkerUrl,
        '--run-id', runId,
        '--checkpoint-interval', String(this._checkpointInterval),
      ];
      if (opts.wandbProject) {
        args.push('--wandb-project', opts.wandbProject);
      }
      if (opts.wandbEntity) {
        args.push('--wandb-entity', opts.wandbEntity);
      }
      if (opts.configOverrides) {
        args.push('--config-overrides', JSON.stringify(opts.configOverrides));
      }

      try {
        const proc = spawn('python', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this._childProcess = proc;

        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            this._killChildProcess();
            reject(new DeepeningError('TIMEOUT', 'Training process spawn timed out'));
          }
        }, 30000);
        if (timeout && typeof timeout.unref === 'function') timeout.unref();

        proc.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            try { proc.kill(); } catch (_) { debug('proc.kill failed during error handler:', _ && _.message ? _.message : String(_)); }
            reject(new DeepeningError('CONNECTION_FAILED', 'Failed to spawn training process: ' + (err && err.message ? err.message : String(err))));
          }
        });

        proc.stderr.on('data', (data) => {
          debug('training-spawn', 'stderr', data.toString().slice(0, 500));
        });

        proc.stdout.on('data', (data) => {
          const str = data.toString();
          if (str.includes('READY') && !settled) {
            clearTimeout(timeout);
            settled = true;
            resolve();
          }
        });

        proc.on('exit', (code) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            const run = this._runs.get(runId);
            if (run) {
              if (code === 0) {
                run.status = RUN_STATES.COMPLETED;
                this._stats.successfulRuns++;
              } else {
                run.status = RUN_STATES.FAILED;
                this._stats.failedRuns++;
              }
              run.endTime = Date.now();
              run.exitCode = code;
              this._stats.totalTrainingTimeMs += (run.endTime - run.startTime);
            }
            if (this._activeRunId === runId) {
              this._activeRunId = null;
            }
            this._childProcess = null;
            this.emit('training-exit', { runId, code });
            reject(new DeepeningError('CONNECTION_FAILED', 'Training process exited before READY with code ' + code));
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(new DeepeningError('CONNECTION_FAILED', 'Failed to spawn training process: ' + (err && err.message ? err.message : String(err))));
        }
      }
    });
  }

  /**
   * Notify attached SelfEvolutionGovernor of training results as an observation signal.
   * This bridges the RL training pipeline into the governor's observation→agenda→proposal loop.
   * @param {string} runId - Training run identifier
   * @param {Object} results - Training results (metrics, modelWeightsPath, etc.)
   * @private
   */
  _notifyGovernorTrainingResult(runId, results) {
    if (!this._governor || typeof this._governor.triggerEventHeartbeat !== 'function') return;
    try {
      const rewardScore = results && results.metrics && Number.isFinite(results.metrics.reward)
        ? results.metrics.reward : null;
      if (rewardScore !== null && rewardScore < 0) {
        this._governor.triggerEventHeartbeat('quality-regression', {
          source: 'rl-training-pipeline',
          runId,
          rewardScore,
          modelWeightsPath: results && results.modelWeightsPath,
        });
      }
    } catch (err) {
      debug('notifyGovernor', err && err.message ? err.message : String(err));
    }
  }

  _extractMcpResult(mcpResponse) {
    if (!mcpResponse) return null;
    if (mcpResponse.result && typeof mcpResponse.result === 'object') {
      const content = mcpResponse.result.content;
      if (Array.isArray(content) && content.length > 0) {
        const textItem = content.find(function(c) { return c && c.type === 'text'; });
        if (textItem && textItem.text) {
          try { return JSON.parse(textItem.text); } catch (_e) { debug('parseTextItem', _e && _e.message ? _e.message : String(_e)); return textItem.text; }
        }
        return content[0];
      }
      return mcpResponse.result;
    }
    return mcpResponse;
  }

  _httpRequest(url, method, body) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch (e) {
        return reject(new DeepeningError('INVALID_INPUT', 'Invalid URL: ' + (e && e.message ? e.message : String(e))));
      }

      const isHttps = parsedUrl.protocol === 'https:';
      const lib = isHttps ? https : http;
      const bodyStr = body ? JSON.stringify(body) : null;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.path,
        method: method || 'GET',
        headers: {},
      };
      if (bodyStr) {
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = lib.request(options, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (!settled) {
            settled = true;
            reject(new DeepeningError('CONNECTION_FAILED', 'HTTP ' + res.statusCode + ' from ' + method + ' ' + url));
          }
          res.resume();
          return;
        }
        let data = '';
        let responseSize = 0;
        res.on('data', (chunk) => {
          responseSize += chunk.length;
          if (responseSize > MAX_HTTP_RESPONSE_SIZE) {
            req.destroy();
            if (!settled) {
              settled = true;
              reject(new DeepeningError('CAPACITY_EXCEEDED', 'Response exceeds maximum size'));
            }
            return;
          }
          data += chunk;
        });
        res.on('end', () => {
          if (settled) return;
          settled = true;
          if (data) {
            try { resolve(JSON.parse(data)); }
            catch (_) { debug('RLTrainingPipeline', '_httpRequest:jsonParse', _ && _.message ? _.message : String(_)); resolve(data); }
          } else {
            resolve(null);
          }
        });
        res.on('error', (err) => {
          if (!settled) {
            settled = true;
            reject(new DeepeningError('CONNECTION_FAILED', err && err.message ? err.message : String(err)));
          }
        });
      });

      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(new DeepeningError('CONNECTION_FAILED', err && err.message ? err.message : String(err)));
        }
      });

      req.setTimeout(HTTP_TIMEOUT_MS, () => {
        if (!settled) {
          settled = true;
          req.destroy();
          reject(new DeepeningError('TIMEOUT', 'HTTP request timeout after ' + HTTP_TIMEOUT_MS + 'ms'));
        }
      });

      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

module.exports = withShutdown(RLTrainingPipeline);
Object.assign(module.exports, {
  RUN_STATES,
  DEFAULT_ATROPOS_URL,
  DEFAULT_TINKER_URL,
  MAX_TRAJECTORIES,
  MAX_REWARD_HISTORY,
  TRAINING_TIMEOUT,
  CHECKPOINT_INTERVAL,
});
