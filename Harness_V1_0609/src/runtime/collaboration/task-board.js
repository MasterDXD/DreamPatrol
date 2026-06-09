'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');
const EventEmitter = require('events');

const TASK_BOARD_STATES = {
  OPEN: 'open',
  CLAIMED: 'claimed',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const DELEGATION_MODES = {
  MANUAL: 'manual',
  AUTO_ASSIGN: 'auto-assign',
  CLAIM_BASED: 'claim-based',
  BID_BASED: 'bid-based',
};

const DEFAULT_OPTIONS = {
  maxTasks: 200,
  maxTaskHistory: 100,
  delegationMode: DELEGATION_MODES.CLAIM_BASED,
  taskTimeoutMs: 600000,
  autoAssignFn: null,
  bidEvaluationFn: null,
};

const MAX_BIDS_PER_TASK = 50;

class TaskBoard extends EventEmitter {
  constructor(options) {
    super();
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._tasks = new BoundedMap(this._options.maxTasks);
    this._taskHistory = new BoundedArray(this._options.maxTaskHistory);
    this._agentCapabilities = new BoundedMap(50);
    this._stats = {
      tasksCreated: 0,
      tasksClaimed: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksCancelled: 0,
      byAgent: {},
      byPriority: {},
    };
  }

  createTask(taskDef) {
    if (!taskDef || !taskDef.description) {
      return { success: false, error: 'Task must have a description' };
    }
    const taskId = 'task-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const task = {
      id: taskId,
      description: taskDef.description,
      goal: taskDef.goal ?? taskDef.description,
      backstory: taskDef.backstory ?? '',
      requiredCapabilities: taskDef.requiredCapabilities ?? [],
      priority: taskDef.priority ?? 0,
      context: taskDef.context ?? {},
      deliverables: taskDef.deliverables ?? [],
      assignedTo: null,
      claimedAt: null,
      state: TASK_BOARD_STATES.OPEN,
      result: null,
      error: null,
      bids: [],
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      deadline: taskDef.deadline ?? null,
    };
    this._tasks.set(taskId, task);
    this._stats.tasksCreated++;
    this._stats.byPriority[task.priority] = (this._stats.byPriority[task.priority] ?? 0) + 1;
    this.emit('task-created', { taskId, description: task.description, priority: task.priority });
    if (this._options.delegationMode === DELEGATION_MODES.AUTO_ASSIGN) {
      this._autoAssign(taskId);
    }
    return { success: true, taskId };
  }

  claimTask(taskId, agentId) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    if (task.state !== TASK_BOARD_STATES.OPEN) {
      return { success: false, error: 'Task is not open, current state: ' + task.state };
    }
    if (!this._checkCapabilities(agentId, task.requiredCapabilities)) {
      return { success: false, error: 'Agent does not have required capabilities' };
    }
    task.assignedTo = agentId;
    task.claimedAt = Date.now();
    task.state = TASK_BOARD_STATES.CLAIMED;
    this._stats.tasksClaimed++;
    if (!this._stats.byAgent[agentId]) this._stats.byAgent[agentId] = { claimed: 0, completed: 0, failed: 0 };
    this._stats.byAgent[agentId].claimed++;
    this.emit('task-claimed', { taskId, agentId });
    return { success: true };
  }

  startTask(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    if (task.state !== TASK_BOARD_STATES.CLAIMED) {
      return { success: false, error: 'Task must be claimed first' };
    }
    task.state = TASK_BOARD_STATES.IN_PROGRESS;
    task.startedAt = Date.now();
    this._setTaskTimeout(taskId);
    this.emit('task-started', { taskId, agentId: task.assignedTo });
    return { success: true };
  }

  completeTask(taskId, result) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    if (task.state !== TASK_BOARD_STATES.IN_PROGRESS) {
      return { success: false, error: 'Task is not in progress' };
    }
    if (task._timeoutTimer) clearTimeout(task._timeoutTimer);
    task.state = TASK_BOARD_STATES.COMPLETED;
    task.result = result ?? {};
    task.completedAt = Date.now();
    this._stats.tasksCompleted++;
    if (task.assignedTo && this._stats.byAgent[task.assignedTo]) {
      this._stats.byAgent[task.assignedTo].completed++;
    }
    this._taskHistory.push(Object.assign({}, task));
    this._tasks.delete(taskId);
    this.emit('task-completed', { taskId, agentId: task.assignedTo, result });
    return { success: true };
  }

  failTask(taskId, error) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    if (task._timeoutTimer) clearTimeout(task._timeoutTimer);
    task.state = TASK_BOARD_STATES.FAILED;
    task.error = error ?? 'Unknown error';
    task.completedAt = Date.now();
    this._stats.tasksFailed++;
    if (task.assignedTo && this._stats.byAgent[task.assignedTo]) {
      this._stats.byAgent[task.assignedTo].failed++;
    }
    this._taskHistory.push(Object.assign({}, task));
    this._tasks.delete(taskId);
    this.emit('task-failed', { taskId, agentId: task.assignedTo, error: task.error });
    return { success: true };
  }

  cancelTask(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    if (task._timeoutTimer) clearTimeout(task._timeoutTimer);
    task.state = TASK_BOARD_STATES.CANCELLED;
    task.completedAt = Date.now();
    this._stats.tasksCancelled++;
    this._taskHistory.push(Object.assign({}, task));
    this._tasks.delete(taskId);
    this.emit('task-cancelled', { taskId });
    return { success: true };
  }

  submitBid(taskId, agentId, bid) {
    const task = this._tasks.get(taskId);
    if (!task) return { success: false, error: 'Task not found' };
    if (task.state !== TASK_BOARD_STATES.OPEN) {
      return { success: false, error: 'Task is not open for bidding' };
    }
    if (task.bids.length >= MAX_BIDS_PER_TASK) task.bids.shift();
    task.bids.push({
      agentId,
      confidence: bid.confidence ?? 0.5,
      estimatedTime: bid.estimatedTime ?? null,
      reasoning: bid.reasoning ?? '',
      timestamp: Date.now(),
    });
    this.emit('bid-submitted', { taskId, agentId });
    if (this._options.delegationMode === DELEGATION_MODES.BID_BASED && this._options.bidEvaluationFn) {
      const winner = this._options.bidEvaluationFn(task.bids);
      if (winner) {
        return this.claimTask(taskId, winner);
      }
    }
    return { success: true };
  }

  getOpenTasks() {
    const result = [];
    for (const [, task] of this._tasks) {
      if (task.state === TASK_BOARD_STATES.OPEN) {
        result.push({
          id: task.id,
          description: task.description,
          priority: task.priority,
          requiredCapabilities: task.requiredCapabilities,
          createdAt: task.createdAt,
          deadline: task.deadline,
          bidCount: task.bids.length,
        });
      }
    }
    return result.sort(function(a, b) { return b.priority - a.priority; });
  }

  getAgentTasks(agentId) {
    const result = [];
    for (const [, task] of this._tasks) {
      if (task.assignedTo === agentId) {
        result.push({
          id: task.id,
          description: task.description,
          state: task.state,
          priority: task.priority,
          claimedAt: task.claimedAt,
          startedAt: task.startedAt,
        });
      }
    }
    return result;
  }

  registerCapabilities(agentId, capabilities) {
    this._agentCapabilities.set(agentId, capabilities ?? []);
    return { success: true };
  }

  _checkCapabilities(agentId, requiredCapabilities) {
    if (!requiredCapabilities || requiredCapabilities.length === 0) return true;
    const agentCaps = this._agentCapabilities.get(agentId);
    if (!agentCaps) return false;
    return requiredCapabilities.every(function(cap) { return agentCaps.includes(cap); });
  }

  _autoAssign(taskId) {
    const task = this._tasks.get(taskId);
    if (!task || task.state !== TASK_BOARD_STATES.OPEN) return;
    if (this._options.autoAssignFn) {
      const agentId = this._options.autoAssignFn(task, this._agentCapabilities);
      if (agentId) this.claimTask(taskId, agentId);
    }
  }

  _setTaskTimeout(taskId) {
    const task = this._tasks.get(taskId);
    if (!task || !this._options.taskTimeoutMs) return;
    task._timeoutTimer = setTimeout(() => {
      if (this._shutDown) return;
      if (this._tasks.has(taskId)) {
        this.failTask(taskId, 'Task timed out');
      }
    }, this._options.taskTimeoutMs);
  }

  getStats() {
    return {
      tasksCreated: this._stats.tasksCreated,
      tasksClaimed: this._stats.tasksClaimed,
      tasksCompleted: this._stats.tasksCompleted,
      tasksFailed: this._stats.tasksFailed,
      tasksCancelled: this._stats.tasksCancelled,
      openTasks: this.getOpenTasks().length,
      byAgent: Object.fromEntries(Object.entries(this._stats.byAgent).map(([k, v]) => [k, { ...v }])),
      byPriority: Object.fromEntries(Object.entries(this._stats.byPriority).map(([k, v]) => [k, { ...v }])),
    };
  }

  _onShutdown() {
    for (const [, task] of this._tasks) {
      if (task._timeoutTimer) clearTimeout(task._timeoutTimer);
    }
    this._tasks.shutdown();
    this._taskHistory.shutdown();
    this._agentCapabilities.shutdown();
  }
}

module.exports = withShutdown(TaskBoard);
module.exports.TASK_BOARD_STATES = TASK_BOARD_STATES;
module.exports.DELEGATION_MODES = DELEGATION_MODES;
