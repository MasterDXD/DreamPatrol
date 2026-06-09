'use strict';

const { EventEmitter } = require('events');
const { mergeConfig } = require('../utils/safe-assign');
const { withShutdown } = require('../utils/shutdown-mixin');
const BoundedMap = require('../utils/bounded-map');
const BoundedArray = require('../utils/bounded-array');

const SECURITY_LAYERS = [
  { id: 'pattern-check', name: 'Pattern Check', tier: 'auto', maxMs: 2 },
  { id: 'read-only-path', name: 'Read-Only Path', tier: 'auto', maxMs: 2 },
  { id: 'safe-whitelist', name: 'Safe Whitelist', tier: 'auto', maxMs: 6 },
  { id: 'ast-analysis', name: 'AST Analysis', tier: 'classify', maxMs: 50 },
  { id: 'network-write', name: 'Network Write Check', tier: 'classify', maxMs: 20 },
  { id: 'permission-verify', name: 'Permission Verify', tier: 'classify', maxMs: 30 },
  { id: 'prompt-injection-detect', name: 'Prompt Injection Detect', tier: 'classify', maxMs: 100 },
  { id: 'human-approval', name: 'Human Approval', tier: 'human', maxMs: Infinity },
  { id: 'risk-confirmation', name: 'Risk Confirmation', tier: 'human', maxMs: Infinity },
];

const DEFAULT_CONFIG = {
  enableAllLayers: true,
  disabledLayers: [],
  fastPathMaxMs: 10,
  dangerousPatterns: [
    /rm\s+-rf/, /git\s+push\s+--force/, /DROP\s+TABLE/i,
    /DELETE\s+FROM/i, /TRUNCATE/i, /format\s+[A-Z]:/i,
    /\bsudo\b/, /\bchmod\s+777\b/, />\s*\/dev\//,
  ],
  readOnlyExtensions: ['.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.csv'],
  safeCommands: [/^ls/, /^cat/, /^head/, /^tail/, /^grep/, /^find/, /^wc/, /^diff/, /^git\s+status/, /^git\s+log/, /^git\s+diff/, /^git\s+show/],
};

const INJECTION_PATTERNS = [
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /eval\s*\(/,
  /Function\s*\(/,
  /process\.exit/,
  /child_process/,
  /__proto__/,
  /\bexec\s*\(/,
  /\bspawn\s*\(/,
];

const NETWORK_WRITE_PATTERNS = [
  /curl\s+.*-[XdP]/,
  /wget\s+/,
  /nc\s+.*-[le]/,
  /\bfetch\s*\(\s*['"]https?:/,
  /\baxios\.\s*(post|put|patch|delete)\s*\(/,
  /\bhttp\.request\s*\(/,
];

/**
 * L9 Prompt注入检测模式。融合来源：GPT-5.6 Daybreak安全防御体系
 * 针对150万Token超大上下文场景下的三类威胁：
 * 1. 长程间接注入：恶意指令分散在大量合法内容中
 * 2. 逻辑漂移：会话中逐渐偏移原始意图
 * 3. 越界行为：试图绕过系统约束
 */
const PROMPT_INJECTION_PATTERNS = {
  // 碎片化注入：分散在长文本中的恶意指令片段
  fragmentedInjection: [
    /ignore\s+(previous|above|all)\s+(instructions?|prompts?|rules?)/i,
    /disregard\s+(your|the)\s+(system|safety|security)\s+(prompt|instructions?|guidelines?)/i,
    /you\s+are\s+now\s+(unlocked|free|jailbroken|unrestricted)/i,
    /bypass\s+(the\s+)?(filter|safety|security|guard|restriction)/i,
    /pretend\s+(you\s+are|to\s+be)\s+(a|an)\s+(unrestricted|unfiltered|uncensored)/i,
    /act\s+as\s+(if\s+you\s+(have|had)\s+no|an\s+unrestricted)\s+(rules?|limits?|restrictions?)/i,
    /system\s*:\s*(override|unlock|disable|deactivate)/i,
    /\<\/?system\>/i,
    /\[SYSTEM\]/i,
    /###\s*(INSTRUCTION|OVERRIDE|ADMIN|SYSTEM)/i,
  ],
  // 逻辑漂移：试图通过渐进式引导偏移对话意图
  logicDrift: [
    /let'?s?\s+(change|switch|shift|move)\s+(the\s+)?(topic|subject|focus|direction)/i,
    /actually,?\s+(forget|ignore|never\s+mind)\s+(about\s+)?(the\s+)?(previous|earlier|above)/i,
    /on\s+second\s+thought,?\s+(don'?t|do\s+not)\s+(worry\s+about|follow|apply)\s+(the\s+)?(rules?|constraints?|guidelines?)/i,
    /I\s+meant\s+to\s+say\s+.*\b(unlock|bypass|override|disable)\b/i,
  ],
  // 越界行为：试图获取系统权限或敏感信息
  boundaryViolation: [
    /reveal\s+(your|the|system)\s+(prompt|instructions?|guidelines?|rules?)/i,
    /show\s+me\s+(your|the)\s+(system|initial|original)\s+(prompt|message|instructions?)/i,
    /what\s+(are|were)\s+(your|the)\s+(system|hidden|secret)\s+(instructions?|rules?|prompts?)/i,
    /repeat\s+(your|the)\s+(system|initial|original)\s+(prompt|instructions?|message)/i,
    /output\s+(your|the)\s+(system|hidden)\s+(prompt|instructions?)/i,
    /debug\s+mode/i,
    /developer\s+mode/i,
    /maintenance\s+mode/i,
  ],
};

/**
 * @module security/tool-call-security-chain
 * Unified 9-layer security chain for tool calls. Implements a fast path (L1-L3)
 * for auto-tier checks that must complete within 10ms, a classification path
 * (L4-L7) for deeper analysis including prompt injection detection, and human-tier
 * checks (L8-L9) requiring explicit approval.
 * 融合来源：GPT-5.6 Daybreak安全防御体系（L7 Prompt注入检测层）
 */

/**
 * @classdesc 工具调用安全链。9层安全链(3层级)、AST代码注入检测、Prompt注入检测
 * Unified 9-layer security chain for tool calls. Implements a fast path (L1-L3)
 * for auto-tier checks that must complete within 10ms, a classification path
 * (L4-L7) for deeper analysis including prompt injection detection, and human-tier
 * checks (L8-L9) requiring explicit approval.
 * 融合来源：GPT-5.6 Daybreak安全防御体系（L7 Prompt注入检测层）
 *
 * @fires ToolCallSecurityChain#check-completed
 * @fires ToolCallSecurityChain#check-blocked
 */
class ToolCallSecurityChain extends EventEmitter {
  /**
   * @param {Object} [options] - Configuration options
   * @param {boolean} [options.enableAllLayers=true] - Whether to enable all security layers
   * @param {string[]} [options.disabledLayers=[]] - List of disabled layer IDs
   * @param {number} [options.fastPathMaxMs=10] - Maximum time for fast path (L1-L3) in ms
   * @param {RegExp[]} [options.dangerousPatterns] - Dangerous command patterns
   * @param {string[]} [options.readOnlyExtensions] - Read-only file extensions
   * @param {RegExp[]} [options.safeCommands] - Safe command whitelist patterns
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options ?? {});
    this._disabledSet = new Set(this._config.disabledLayers ?? []);
    this._layerStats = new BoundedMap(20);
    for (const layer of SECURITY_LAYERS) {
      this._layerStats.set(layer.id, {
        callCount: 0,
        passCount: 0,
        blockCount: 0,
        totalDurationMs: 0,
      });
    }
    this._auditLog = new BoundedArray(5000, { strategy: 'fifo' });
  }

  /**
   * Run the full 8-layer security check on a tool call.
   * @param {Object} toolCall - The tool call to check
   * @param {string} toolCall.name - Tool name
   * @param {string} [toolCall.command] - Command string (for shell tools)
   * @param {string} [toolCall.path] - Target file path
   * @param {string} [toolCall.content] - Content/code to write or execute
   * @param {Object} [context] - Execution context
   * @param {string} [context.agentId] - Agent making the call
   * @param {string[]} [context.permissions] - Agent permissions
   * @param {boolean} [context.requireApproval] - Whether approval is required
   * @param {boolean} [context.highRisk] - Whether this is a high-risk operation
   * @returns {{ allowed: boolean, layer: string|null, reason: string|null, duration: number, details: Array<{ layer: string, passed: boolean, duration: number, reason?: string }> }}
   */
  check(toolCall, context) {
    this.guardShutdown();
    const startTime = Date.now();
    const call = toolCall ?? {};
    const ctx = context ?? {};
    const details = [];
    let blocked = null;

    const fastPathResult = this._runFastPath(call, ctx);
    for (const r of fastPathResult.results) {
      details.push(r);
      if (!r.passed && !blocked) {
        blocked = r;
      }
    }

    if (!blocked) {
      const classifyLayers = SECURITY_LAYERS.filter(function(l) { return l.tier === 'classify'; });
      for (const layer of classifyLayers) {
        if (this._disabledSet.has(layer.id)) continue;
        const r = this._runLayer(layer.id, call, ctx);
        details.push(r);
        if (!r.passed && !blocked) {
          blocked = r;
        }
      }
    }

    if (!blocked) {
      const humanLayers = SECURITY_LAYERS.filter(function(l) { return l.tier === 'human'; });
      for (const layer of humanLayers) {
        if (this._disabledSet.has(layer.id)) continue;
        const r = this._runLayer(layer.id, call, ctx);
        details.push(r);
        if (!r.passed && !blocked) {
          blocked = r;
        }
      }
    }

    const duration = Date.now() - startTime;
    const result = {
      allowed: !blocked,
      layer: blocked ? blocked.layer : null,
      reason: blocked ? blocked.reason : null,
      duration: duration,
      details: details,
    };

    this._auditLog.push({
      timestamp: new Date().toISOString(),
      toolName: call.name || '',
      allowed: result.allowed,
      layer: result.layer,
      reason: result.reason,
      duration: duration,
    });

    if (result.allowed) {
      this.emit('check-completed', { toolName: call.name, duration: duration });
    } else {
      this.emit('check-blocked', { toolName: call.name, layer: result.layer, reason: result.reason });
    }

    return result;
  }

  /**
   * L1: Regex pattern check against dangerous patterns.
   * @param {Object} toolCall - The tool call to check
   * @returns {{ passed: boolean, reason?: string }}
   * @private
   */
  _layerPatternCheck(toolCall) {
    const command = toolCall.command || toolCall.content || '';
    if (!command) return { passed: true };
    for (const pattern of Array.isArray(this._config.dangerousPatterns) ? this._config.dangerousPatterns : []) {
      if (pattern.test(command)) {
        return { passed: false, reason: 'Dangerous pattern detected: ' + pattern.source };
      }
    }
    return { passed: true };
  }

  /**
   * L2: Check if target is a read-only file path.
   * @param {Object} toolCall - The tool call to check
   * @returns {{ passed: boolean, reason?: string }}
   * @private
   */
  _layerReadOnlyPath(toolCall) {
    const filePath = toolCall.path || '';
    if (!filePath) return { passed: true };
    const isWriteOp = /write|create|delete|remove|modify|update/i.test(toolCall.name || '');
    if (!isWriteOp) return { passed: true };
    const ext = filePath.replace(/^.*(\.[^.]+)$/, '$1').toLowerCase();
    if (this._config.readOnlyExtensions.includes(ext)) {
      return { passed: false, reason: 'Write to read-only file extension: ' + ext };
    }
    return { passed: true };
  }

  /**
   * L3: Check if command matches safe command whitelist.
   * @param {Object} toolCall - The tool call to check
   * @returns {{ passed: boolean, reason?: string, isSafe?: boolean }}
   * @private
   */
  _layerSafeWhitelist(toolCall) {
    const command = toolCall.command || '';
    if (!command) return { passed: true, isSafe: false };
    const trimmed = command.trim();
    for (const pattern of Array.isArray(this._config.safeCommands) ? this._config.safeCommands : []) {
      if (pattern.test(trimmed)) {
        return { passed: true, isSafe: true };
      }
    }
    return { passed: true, isSafe: false };
  }

  /**
   * L4: Basic AST-level code injection detection (regex-based since tree-sitter is optional).
   * @param {Object} toolCall - The tool call to check
   * @returns {{ passed: boolean, reason?: string }}
   * @private
   */
  _layerAstAnalysis(toolCall) {
    const content = toolCall.content || toolCall.command || '';
    if (!content) return { passed: true };
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        return { passed: false, reason: 'Code injection pattern detected: ' + pattern.source };
      }
    }
    return { passed: true };
  }

  /**
   * L5: Detect network write operations.
   * @param {Object} toolCall - The tool call to check
   * @returns {{ passed: boolean, reason?: string }}
   * @private
   */
  _layerNetworkWrite(toolCall) {
    const command = toolCall.command || toolCall.content || '';
    if (!command) return { passed: true };
    for (const pattern of NETWORK_WRITE_PATTERNS) {
      if (pattern.test(command)) {
        return { passed: false, reason: 'Network write operation detected: ' + pattern.source };
      }
    }
    return { passed: true };
  }

  /**
   * L6: Verify user/agent permissions.
   * @param {Object} toolCall - The tool call to check
   * @param {Object} context - Execution context
   * @returns {{ passed: boolean, reason?: string }}
   * @private
   */
  _layerPermissionVerify(toolCall, context) {
    const permissions = context.permissions ?? [];
    if (permissions.length === 0) return { passed: true };
    const toolName = toolCall.name || '';
    const restrictedTools = ['shell', 'exec', 'file-delete', 'database-write'];
    if (restrictedTools.includes(toolName)) {
      const hasPermission = permissions.some(function(p) {
        return p === toolName || p === 'admin' || p === '*';
      });
      if (!hasPermission) {
        return { passed: false, reason: 'Agent lacks permission for tool: ' + toolName };
      }
    }
    return { passed: true };
  }

  /**
   * L7: Prompt injection detection for long-context scenarios.
   * 融合来源：GPT-5.6 Daybreak安全防御体系
   * 检测三类威胁：碎片化注入、逻辑漂移、越界行为
   * @param {Object} toolCall - The tool call to check
   * @param {Object} [context] - Execution context
   * @returns {{ passed: boolean, reason?: string, threatType?: string, threatLevel?: number }}
   * @private
   */
  _layerPromptInjectionDetect(toolCall, _context) {
    const content = toolCall.content || toolCall.command || '';
    if (!content) return { passed: true };
    const threats = [];
    // 碎片化注入检测（HIGH威胁）
    for (const pattern of PROMPT_INJECTION_PATTERNS.fragmentedInjection) {
      if (pattern.test(content)) {
        threats.push({ type: 'fragmented-injection', level: 0.9, pattern: pattern.source });
        break;
      }
    }
    // 逻辑漂移检测（MEDIUM威胁）
    for (const pattern of PROMPT_INJECTION_PATTERNS.logicDrift) {
      if (pattern.test(content)) {
        threats.push({ type: 'logic-drift', level: 0.6, pattern: pattern.source });
        break;
      }
    }
    // 越界行为检测（HIGH威胁）
    for (const pattern of PROMPT_INJECTION_PATTERNS.boundaryViolation) {
      if (pattern.test(content)) {
        threats.push({ type: 'boundary-violation', level: 0.85, pattern: pattern.source });
        break;
      }
    }
    if (threats.length === 0) return { passed: true };
    const maxThreat = threats.reduce(function(a, b) { return a.level > b.level ? a : b; }, { level: -1 });
    const threatLevel = maxThreat.level;
    // 威胁等级 >= 0.8 直接拦截
    if (threatLevel >= 0.8) {
      return {
        passed: false,
        reason: 'Prompt injection detected: ' + maxThreat.type + ' (threat: ' + maxThreat.pattern + ')',
        threatType: maxThreat.type,
        threatLevel,
      };
    }
    // 威胁等级 0.5-0.8 标记但放行（由上层决定是否升级审批）
    return {
      passed: true,
      reason: 'Suspicious pattern detected: ' + maxThreat.type + ' (threat: ' + maxThreat.pattern + ')',
      threatType: maxThreat.type,
      threatLevel,
    };
  }

  /**
   * L7: Check if human approval is required.
   * @param {Object} toolCall - The tool call to check
   * @param {Object} context - Execution context
   * @returns {{ passed: boolean, reason?: string }}
   * @private
   */
  _layerHumanApproval(toolCall, context) {
    if (context.requireApproval === true) {
      if (context.approvalGranted !== true) {
        return { passed: false, reason: 'Human approval required but not granted' };
      }
    }
    return { passed: true };
  }

  /**
   * L8: Check if risk confirmation is required.
   * @param {Object} toolCall - The tool call to check
   * @param {Object} context - Execution context
   * @returns {{ passed: boolean, reason?: string }}
   * @private
   */
  _layerRiskConfirmation(toolCall, context) {
    if (context.highRisk === true) {
      if (context.riskConfirmed !== true) {
        return { passed: false, reason: 'High-risk operation requires explicit risk confirmation' };
      }
    }
    return { passed: true };
  }

  /**
   * Runs L1-L3 combined as fast path (must complete within fastPathMaxMs).
   * @param {Object} toolCall - The tool call to check
   * @param {Object} context - Execution context
   * @returns {{ results: Array, duration: number }}
   * @private
   */
  _runFastPath(toolCall, context) {
    const startTime = Date.now();
    const results = [];
    const fastLayers = SECURITY_LAYERS.filter(function(l) { return l.tier === 'auto'; });
    for (const layer of fastLayers) {
      if (this._disabledSet.has(layer.id)) continue;
      const r = this._runLayer(layer.id, toolCall, context);
      results.push(r);
    }
    const duration = Date.now() - startTime;
    if (duration > this._config.fastPathMaxMs) {
      this.emit('fast-path-timeout', { duration, maxMs: this._config.fastPathMaxMs });
    }
    return { results: results, duration: duration };
  }

  /**
   * Run a single security layer and update its stats.
   * @param {string} layerId - Layer identifier
   * @param {Object} toolCall - The tool call to check
   * @param {Object} context - Execution context
   * @returns {{ layer: string, passed: boolean, duration: number, reason?: string }}
   * @private
   */
  _runLayer(layerId, toolCall, context) {
    const startTime = Date.now();
    let result;
    switch (layerId) {
      case 'pattern-check':
        result = this._layerPatternCheck(toolCall);
        break;
      case 'read-only-path':
        result = this._layerReadOnlyPath(toolCall);
        break;
      case 'safe-whitelist':
        result = this._layerSafeWhitelist(toolCall);
        break;
      case 'ast-analysis':
        result = this._layerAstAnalysis(toolCall);
        break;
      case 'network-write':
        result = this._layerNetworkWrite(toolCall);
        break;
      case 'permission-verify':
        result = this._layerPermissionVerify(toolCall, context);
        break;
      case 'prompt-injection-detect':
        result = this._layerPromptInjectionDetect(toolCall, context);
        break;
      case 'human-approval':
        result = this._layerHumanApproval(toolCall, context);
        break;
      case 'risk-confirmation':
        result = this._layerRiskConfirmation(toolCall, context);
        break;
      default:
        result = { passed: true };
    }
    const duration = Date.now() - startTime;
    const stats = this._layerStats.get(layerId);
    if (stats) {
      stats.callCount++;
      stats.totalDurationMs += duration;
      if (result.passed) {
        stats.passCount++;
      } else {
        stats.blockCount++;
      }
    }
    return {
      layer: layerId,
      passed: !!result.passed,
      duration: duration,
      reason: result.reason ?? null,
    };
  }

  /**
   * Returns per-layer statistics (call count, pass rate, avg duration).
   * @returns {Object.<string, { callCount: number, passCount: number, blockCount: number, passRate: number, avgDurationMs: number }>}
   */
  getLayerStats() {
    const stats = {};
    this._layerStats.forEach(function(value, key) {
      stats[key] = {
        callCount: value.callCount,
        passCount: value.passCount,
        blockCount: value.blockCount,
        passRate: value.callCount > 0 ? value.passCount / value.callCount : 0,
        avgDurationMs: value.callCount > 0 ? Math.round(value.totalDurationMs / value.callCount * 100) / 100 : 0,
      };
    });
    return stats;
  }

  /**
   * Returns a comprehensive security audit report.
   * @returns {{ layerStats: Object, totalChecks: number, totalBlocked: number, blockRate: number, recentAuditEntries: Array, config: Object }}
   */
  getSecurityReport() {
    const layerStats = this.getLayerStats();
    let totalChecks = 0;
    let totalBlocked = 0;
    for (const key of Object.keys(layerStats)) {
      totalChecks += layerStats[key].callCount;
      totalBlocked += layerStats[key].blockCount;
    }
    const recentEntries = this._auditLog.slice(-50);
    return {
      layerStats: layerStats,
      totalChecks: totalChecks,
      totalBlocked: totalBlocked,
      blockRate: totalChecks > 0 ? totalBlocked / totalChecks : 0,
      recentAuditEntries: recentEntries,
      config: {
        disabledLayers: Array.from(this._disabledSet),
        fastPathMaxMs: this._config.fastPathMaxMs,
        dangerousPatternCount: this._config.dangerousPatterns.length,
        safeCommandCount: this._config.safeCommands.length,
      },
    };
  }

  _onShutdown() {
    this._layerStats.shutdown();
    this._auditLog.shutdown();
    this._disabledSet.clear();
    this.removeAllListeners();
  }
}

ToolCallSecurityChain.SECURITY_LAYERS = SECURITY_LAYERS;
ToolCallSecurityChain.DEFAULT_CONFIG = DEFAULT_CONFIG;
ToolCallSecurityChain.INJECTION_PATTERNS = INJECTION_PATTERNS;
ToolCallSecurityChain.NETWORK_WRITE_PATTERNS = NETWORK_WRITE_PATTERNS;
ToolCallSecurityChain.PROMPT_INJECTION_PATTERNS = PROMPT_INJECTION_PATTERNS;

module.exports = withShutdown(ToolCallSecurityChain);
