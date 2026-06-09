'use strict';

const { timestampId } = require('../utils/unique-id');
const { isNonEmptyString } = require('../utils/constants');

const ERROR_CODES = {
  UNKNOWN: 'UNKNOWN',
  INIT_FAILED: 'INIT_FAILED',
  CONFIG_INVALID: 'CONFIG_INVALID',
  INVALID_INPUT: 'INVALID_INPUT',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_PHASE_INVALID: 'SESSION_PHASE_INVALID',
  SESSION_BUDGET_EXCEEDED: 'SESSION_BUDGET_EXCEEDED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PERMISSION_SKILL_NOT_ALLOWED: 'PERMISSION_SKILL_NOT_ALLOWED',
  PERMISSION_FILE_PROTECTED: 'PERMISSION_FILE_PROTECTED',
  PERMISSION_LOCK_CONFLICT: 'PERMISSION_LOCK_CONFLICT',
  TDD_VIOLATION: 'TDD_VIOLATION',
  TDD_NO_TEST: 'TDD_NO_TEST',
  TDD_COVERAGE_LOW: 'TDD_COVERAGE_LOW',
  TDD_PHASE_INVALID: 'TDD_PHASE_INVALID',
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_UNHEALTHY: 'AGENT_UNHEALTHY',
  AGENT_TIMEOUT: 'AGENT_TIMEOUT',
  AGENT_CAPACITY_EXCEEDED: 'AGENT_CAPACITY_EXCEEDED',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  SKILL_DEPENDENCY_MISSING: 'SKILL_DEPENDENCY_MISSING',
  PIPELINE_TIMEOUT: 'PIPELINE_TIMEOUT',
  PIPELINE_BLOCKED: 'PIPELINE_BLOCKED',
  PIPELINE_EXECUTION_ERROR: 'PIPELINE_EXECUTION_ERROR',
  DEEPENING_CIRCUIT_OPEN: 'DEEPENING_CIRCUIT_OPEN',
  DEEPENING_RATE_LIMITED: 'DEEPENING_RATE_LIMITED',
  DEEPENING_CONVERGENCE_FAILED: 'DEEPENING_CONVERGENCE_FAILED',
  HOOK_EXECUTION_ERROR: 'HOOK_EXECUTION_ERROR',
  HOOK_BLOCKED: 'HOOK_BLOCKED',
  COMMAND_NOT_FOUND: 'COMMAND_NOT_FOUND',
  COMMAND_AMBIGUOUS: 'COMMAND_AMBIGUOUS',
  STORAGE_ERROR: 'STORAGE_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  TIMEOUT: 'TIMEOUT',
  SHUTDOWN: 'SHUTDOWN',
  SHUTDOWN_IN_PROGRESS: 'SHUTDOWN_IN_PROGRESS',
  RESOURCE_EXHAUSTED: 'RESOURCE_EXHAUSTED',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  INVALID_STATE: 'INVALID_STATE',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  SECURITY_VIOLATION: 'SECURITY_VIOLATION',
  DEPENDENCY_CYCLE: 'DEPENDENCY_CYCLE',
  PLUGIN_ERROR: 'PLUGIN_ERROR',
  SNAPSHOT_ERROR: 'SNAPSHOT_ERROR',
  AUDIT_ERROR: 'AUDIT_ERROR',
  RETRY_EXHAUSTED: 'RETRY_EXHAUSTED',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  LOAD_BALANCER_ERROR: 'LOAD_BALANCER_ERROR',
  DATA_PIPELINE_ERROR: 'DATA_PIPELINE_ERROR',
  NOTIFIER_ERROR: 'NOTIFIER_ERROR',
  EVENT_BUS_ERROR: 'EVENT_BUS_ERROR',
  STATE_MACHINE_ERROR: 'STATE_MACHINE_ERROR',
  TASK_SCHEDULER_ERROR: 'TASK_SCHEDULER_ERROR',
  METRICS_ERROR: 'METRICS_ERROR',
  BACKPRESSURE_ERROR: 'BACKPRESSURE_ERROR',
  PRIORITY_QUEUE_ERROR: 'PRIORITY_QUEUE_ERROR',
  SNAPSHOT_STORE_ERROR: 'SNAPSHOT_STORE_ERROR',
  CAUSAL_VIOLATION: 'CAUSAL_VIOLATION',
  CAUSAL_INPUT_MISSING: 'CAUSAL_INPUT_MISSING',
  CAUSAL_INVARIANT_FAILED: 'CAUSAL_INVARIANT_FAILED',
  CAUSAL_OUTPUT_INVALID: 'CAUSAL_OUTPUT_INVALID',
  MCP_ERROR: 'MCP_ERROR',
  DUPLICATE_STEP: 'DUPLICATE_STEP',
  SPRINT_ALREADY_RUNNING: 'SPRINT_ALREADY_RUNNING',
  MISSING_FIELDS: 'MISSING_FIELDS',
  CANCELLED: 'CANCELLED',
  INVALID_EXECUTION_MODE: 'INVALID_EXECUTION_MODE',
  MODE_SWITCH_DISABLED: 'MODE_SWITCH_DISABLED',
  INVALID_CALLBACK: 'INVALID_CALLBACK',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  DEEPENING_CIRCUIT_BREAKER_OPEN: 'DEEPENING_CIRCUIT_BREAKER_OPEN',
  ACQUIRE_FAILED: 'ACQUIRE_FAILED',
  INVALID_PLUGIN: 'INVALID_PLUGIN',
  DUPLICATE_PLUGIN: 'DUPLICATE_PLUGIN',
  PLUGIN_INIT_FAILED: 'PLUGIN_INIT_FAILED',
  INVALID_TOOL_TYPE: 'INVALID_TOOL_TYPE',
  INIT_TIMEOUT: 'INIT_TIMEOUT',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  POOL_SHUTDOWN: 'POOL_SHUTDOWN',
  POOL_EXHAUSTED: 'POOL_EXHAUSTED',
  FACTORY_ERROR: 'FACTORY_ERROR',
};

const ERROR_SEVERITY = {
  UNKNOWN: 'error',
  INIT_FAILED: 'critical',
  CONFIG_INVALID: 'critical',
  INVALID_INPUT: 'warn',
  SESSION_NOT_FOUND: 'warn',
  SESSION_EXPIRED: 'warn',
  SESSION_PHASE_INVALID: 'warn',
  SESSION_BUDGET_EXCEEDED: 'warn',
  PERMISSION_DENIED: 'error',
  PERMISSION_SKILL_NOT_ALLOWED: 'warn',
  PERMISSION_FILE_PROTECTED: 'error',
  PERMISSION_LOCK_CONFLICT: 'warn',
  TDD_VIOLATION: 'error',
  TDD_NO_TEST: 'error',
  TDD_COVERAGE_LOW: 'warn',
  TDD_PHASE_INVALID: 'warn',
  EVIDENCE_INSUFFICIENT: 'warn',
  AGENT_NOT_FOUND: 'warn',
  AGENT_UNHEALTHY: 'error',
  AGENT_TIMEOUT: 'error',
  AGENT_CAPACITY_EXCEEDED: 'warn',
  SKILL_NOT_FOUND: 'warn',
  SKILL_DEPENDENCY_MISSING: 'error',
  PIPELINE_TIMEOUT: 'error',
  PIPELINE_BLOCKED: 'warn',
  PIPELINE_EXECUTION_ERROR: 'error',
  DEEPENING_CIRCUIT_OPEN: 'warn',
  DEEPENING_RATE_LIMITED: 'warn',
  DEEPENING_CONVERGENCE_FAILED: 'warn',
  HOOK_EXECUTION_ERROR: 'error',
  HOOK_BLOCKED: 'warn',
  COMMAND_NOT_FOUND: 'info',
  COMMAND_AMBIGUOUS: 'info',
  STORAGE_ERROR: 'error',
  VALIDATION_ERROR: 'warn',
  TIMEOUT: 'error',
  SHUTDOWN: 'warn',
  SHUTDOWN_IN_PROGRESS: 'warn',
  RESOURCE_EXHAUSTED: 'error',
  RESOURCE_NOT_FOUND: 'warn',
  INVALID_STATE: 'error',
  CAPACITY_EXCEEDED: 'warn',
  CONNECTION_FAILED: 'error',
  SECURITY_VIOLATION: 'critical',
  DEPENDENCY_CYCLE: 'error',
  PLUGIN_ERROR: 'error',
  SNAPSHOT_ERROR: 'error',
  AUDIT_ERROR: 'error',
  RETRY_EXHAUSTED: 'warn',
  LOCK_TIMEOUT: 'warn',
  LOAD_BALANCER_ERROR: 'error',
  DATA_PIPELINE_ERROR: 'error',
  NOTIFIER_ERROR: 'error',
  EVENT_BUS_ERROR: 'error',
  STATE_MACHINE_ERROR: 'error',
  TASK_SCHEDULER_ERROR: 'error',
  METRICS_ERROR: 'warn',
  BACKPRESSURE_ERROR: 'warn',
  PRIORITY_QUEUE_ERROR: 'error',
  SNAPSHOT_STORE_ERROR: 'error',
  CAUSAL_VIOLATION: 'error',
  CAUSAL_INPUT_MISSING: 'error',
  CAUSAL_INVARIANT_FAILED: 'error',
  CAUSAL_OUTPUT_INVALID: 'error',
  MCP_ERROR: 'error',
  DUPLICATE_STEP: 'warn',
  SPRINT_ALREADY_RUNNING: 'warn',
  MISSING_FIELDS: 'warn',
  CANCELLED: 'info',
  INVALID_EXECUTION_MODE: 'warn',
  MODE_SWITCH_DISABLED: 'warn',
  INVALID_CALLBACK: 'warn',
  LIMIT_EXCEEDED: 'warn',
  MISSING_PARAMETER: 'warn',
  DEEPENING_CIRCUIT_BREAKER_OPEN: 'warn',
  ACQUIRE_FAILED: 'warn',
  INVALID_PLUGIN: 'warn',
  DUPLICATE_PLUGIN: 'warn',
  PLUGIN_INIT_FAILED: 'error',
  INVALID_TOOL_TYPE: 'warn',
  INIT_TIMEOUT: 'error',
  BUDGET_EXCEEDED: 'error',
  POOL_SHUTDOWN: 'error',
  POOL_EXHAUSTED: 'error',
  FACTORY_ERROR: 'error',
};

const HTTP_STATUS_MAP = {
  UNKNOWN: 500,
  INIT_FAILED: 500,
  CONFIG_INVALID: 500,
  INVALID_INPUT: 400,
  SESSION_NOT_FOUND: 404,
  SESSION_EXPIRED: 410,
  SESSION_PHASE_INVALID: 409,
  SESSION_BUDGET_EXCEEDED: 429,
  PERMISSION_DENIED: 403,
  PERMISSION_SKILL_NOT_ALLOWED: 403,
  PERMISSION_FILE_PROTECTED: 403,
  PERMISSION_LOCK_CONFLICT: 409,
  TDD_VIOLATION: 409,
  TDD_NO_TEST: 409,
  TDD_COVERAGE_LOW: 409,
  TDD_PHASE_INVALID: 409,
  EVIDENCE_INSUFFICIENT: 422,
  AGENT_NOT_FOUND: 404,
  AGENT_UNHEALTHY: 503,
  AGENT_TIMEOUT: 504,
  AGENT_CAPACITY_EXCEEDED: 503,
  SKILL_NOT_FOUND: 404,
  SKILL_DEPENDENCY_MISSING: 424,
  PIPELINE_TIMEOUT: 504,
  PIPELINE_BLOCKED: 403,
  PIPELINE_EXECUTION_ERROR: 500,
  DEEPENING_CIRCUIT_OPEN: 503,
  DEEPENING_RATE_LIMITED: 429,
  DEEPENING_CONVERGENCE_FAILED: 422,
  HOOK_EXECUTION_ERROR: 500,
  HOOK_BLOCKED: 403,
  COMMAND_NOT_FOUND: 404,
  COMMAND_AMBIGUOUS: 409,
  STORAGE_ERROR: 500,
  VALIDATION_ERROR: 400,
  TIMEOUT: 504,
  SHUTDOWN: 503,
  SHUTDOWN_IN_PROGRESS: 503,
  RESOURCE_EXHAUSTED: 503,
  RESOURCE_NOT_FOUND: 404,
  INVALID_STATE: 409,
  CAPACITY_EXCEEDED: 503,
  CONNECTION_FAILED: 502,
  SECURITY_VIOLATION: 403,
  DEPENDENCY_CYCLE: 409,
  PLUGIN_ERROR: 500,
  SNAPSHOT_ERROR: 500,
  AUDIT_ERROR: 500,
  RETRY_EXHAUSTED: 429,
  LOCK_TIMEOUT: 408,
  LOAD_BALANCER_ERROR: 500,
  DATA_PIPELINE_ERROR: 500,
  NOTIFIER_ERROR: 500,
  EVENT_BUS_ERROR: 500,
  STATE_MACHINE_ERROR: 409,
  TASK_SCHEDULER_ERROR: 500,
  METRICS_ERROR: 500,
  BACKPRESSURE_ERROR: 503,
  PRIORITY_QUEUE_ERROR: 500,
  SNAPSHOT_STORE_ERROR: 500,
  CAUSAL_VIOLATION: 409,
  CAUSAL_INPUT_MISSING: 424,
  CAUSAL_INVARIANT_FAILED: 422,
  CAUSAL_OUTPUT_INVALID: 422,
  MCP_ERROR: 502,
  DUPLICATE_STEP: 409,
  SPRINT_ALREADY_RUNNING: 409,
  MISSING_FIELDS: 400,
  CANCELLED: 499,
  INVALID_EXECUTION_MODE: 400,
  MODE_SWITCH_DISABLED: 409,
  INVALID_CALLBACK: 400,
  LIMIT_EXCEEDED: 429,
  MISSING_PARAMETER: 400,
  DEEPENING_CIRCUIT_BREAKER_OPEN: 503,
  ACQUIRE_FAILED: 429,
  INVALID_PLUGIN: 400,
  DUPLICATE_PLUGIN: 409,
  PLUGIN_INIT_FAILED: 500,
  INVALID_TOOL_TYPE: 400,
  INIT_TIMEOUT: 504,
  BUDGET_EXCEEDED: 429,
  POOL_SHUTDOWN: 503,
  POOL_EXHAUSTED: 503,
  FACTORY_ERROR: 500,
};

const RETRYABLE_CODES = new Set([
  'AGENT_TIMEOUT', 'PIPELINE_TIMEOUT', 'TIMEOUT',
  'DEEPENING_CIRCUIT_OPEN', 'DEEPENING_RATE_LIMITED',
  'AGENT_CAPACITY_EXCEEDED', 'SHUTDOWN_IN_PROGRESS',
]);

/**
 * @module errors
 * Base error class for the Harness framework.
 * Provides structured error information including error code, severity, HTTP status, and retryability.
 *
 * @class HarnessError
 * @extends {Error}
 * @param {string} code - Error code from ERROR_CODES (e.g. 'AGENT_TIMEOUT', 'SESSION_NOT_FOUND')
 * @param {string} message - Human-readable error description
 * @param {object} [context] - Additional context data attached to the error
 *
 * @property {string} code - Error code identifier
 * @property {string} errorId - Unique error identifier (format: err_timestamp_random)
 * @property {string} severity - Severity level: 'critical' | 'error' | 'warn' | 'info'
 * @property {number} httpStatus - Mapped HTTP status code
 * @property {string} timestamp - ISO format timestamp
 * @property {object} context - Additional context data
 */
class HarnessError extends Error {
  constructor(code, message, context) {
    if (!isNonEmptyString(code)) {
      if (process.env.NODE_ENV !== 'production') {
        throw new TypeError('HarnessError code must be a non-empty string, got: ' + String(code));
      }
      code = 'UNKNOWN';
    }
    if (!isNonEmptyString(message)) {
      message = 'An unknown error occurred';
    }
    super(message);
    this.name = 'HarnessError';
    this.code = code;
    this.errorId = timestampId();
    this.severity = ERROR_SEVERITY[code] ?? 'error';
    this.httpStatus = HTTP_STATUS_MAP[code] ?? 500;
    this.timestamp = new Date().toISOString();
    this.context = (context && typeof context === 'object' && context !== null && !Array.isArray(context)) ? context : {};
    if (this.context.cause instanceof Error) {
      this.cause = this.context.cause;
    }
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    const safeContext = { ...this.context };
    delete safeContext.originalStack;
    delete safeContext.cause;
    return {
      error: true,
      errorId: this.errorId,
      code: this.code,
      message: this.message,
      severity: this.severity,
      httpStatus: this.httpStatus,
      timestamp: this.timestamp,
      context: safeContext,
    };
  }

  isRetryable() {
    return RETRYABLE_CODES.has(this.code);
  }

  toString() {
    return this.name + ': [' + this.code + '] ' + this.message;
  }
}

/** Error thrown by session lifecycle operations (create, transition, expire, etc.) */
class SessionError extends HarnessError {
  constructor(code, message, context) {
    super(code, message, context);
    this.name = 'SessionError';
  }
}

/** Error thrown when permission or access control checks fail */
class PermissionError extends HarnessError {
  constructor(code, message, context) {
    super(code, message, context);
    this.name = 'PermissionError';
  }
}

/** Error thrown when TDD gate violations are detected (RED-GREEN-REFACTOR violations, coverage below threshold) */
class TDDGateError extends HarnessError {
  constructor(code, message, context) {
    super(code, message, context);
    this.name = 'TDDGateError';
  }
}

/** Error thrown by agent runtime operations (execution, deployment, monitoring, sandbox) */
class AgentError extends HarnessError {
  constructor(code, message, context) {
    super(code, message, context);
    this.name = 'AgentError';
  }
}

/** Error thrown by deepening reasoning modules (circuit breaker, convergence, validation) */
class DeepeningError extends HarnessError {
  constructor(code, message, context) {
    super(code, message, context);
    this.name = 'DeepeningError';
  }
}

/** Error thrown when causal consistency constraints are violated */
class CausalViolationError extends HarnessError {
  constructor(code, message, context) {
    super(code, message, context);
    this.name = 'CausalViolationError';
  }
}

/** Error thrown by pipeline execution (orchestration failures, stage errors) */
class PipelineError extends HarnessError {
  constructor(code, message, context) {
    super(code, message, context);
    this.name = 'PipelineError';
  }
}

/** Error thrown by programmable hook executor (timeout, handler failure, validation) */
class HookError extends HarnessError {
  constructor(code, message, context) {
    super(code, message, context);
    this.name = 'HookError';
  }
}

function fromError(err) {
  if (err instanceof HarnessError) return err;
  if (!err || typeof err !== 'object') {
    return new HarnessError('UNKNOWN', String(err ?? 'An unknown error occurred'));
  }
  const SYSTEM_ERROR_MAP = {
    ENOENT: 'RESOURCE_NOT_FOUND',
    EACCES: 'PERMISSION_DENIED',
    ECONNREFUSED: 'CONNECTION_FAILED',
    ETIMEDOUT: 'TIMEOUT',
    ENOTFOUND: 'CONNECTION_FAILED',
    EADDRINUSE: 'CONNECTION_FAILED',
  };
  const code = SYSTEM_ERROR_MAP[err.code] || err.code || 'UNKNOWN';
  const message = err.message || 'An unknown error occurred';
  const context = { originalName: err.name };
  if (process.env.NODE_ENV !== 'production') {
    context.originalStack = err.stack;
  }
  const harnessErr = new HarnessError(code, message, context);
  harnessErr.cause = err;
  return harnessErr;
}

HarnessError.SessionError = SessionError;
HarnessError.PermissionError = PermissionError;
HarnessError.TDDGateError = TDDGateError;
HarnessError.AgentError = AgentError;
HarnessError.DeepeningError = DeepeningError;
HarnessError.CausalViolationError = CausalViolationError;
HarnessError.PipelineError = PipelineError;
HarnessError.HookError = HookError;
HarnessError.fromError = fromError;

module.exports = {
  HarnessError,
  SessionError,
  PermissionError,
  TDDGateError,
  AgentError,
  DeepeningError,
  CausalViolationError,
  PipelineError,
  HookError,
  ERROR_CODES,
  ERROR_SEVERITY,
  HTTP_STATUS_MAP,
};
