'use strict';

const { errorMessage } = require('../../utils/safe-execute');

/**
 * @module runtime/workflow/workflow-compiler
 * @classdesc 工作流编译器 — 将 AI 生成的自然语言调度指令编译为 DynamicWorkflowEngine 可执行的 DSL。
 *
 * 编译管线：
 * 1. 解析（Parse）— 将自然语言/JSON/DSL 文本解析为中间表示
 * 2. 验证（Validate）— 检查节点/边的完整性和一致性
 * 3. 优化（Optimize）— 合并冗余节点、推断缺失边
 * 4. 编译（Compile）— 生成最终 DSL 对象
 *
 * 支持的输入格式：
 * - JSON DSL（结构化调度脚本）
 * - 简化 DSL（仅节点列表，自动推断边）
 * - 自然语言提示（通过关键词提取）
 */
class WorkflowCompiler {
  /**
   * @param {Object} [options={}] 配置
   * @param {boolean} [options.autoInferEdges=true] 自动推断缺失的边
   * @param {boolean} [options.strictValidation=true] 严格验证模式
   * @param {number} [options.maxNodes=500] 最大节点数
   */
  constructor(options) {
    const opts = options && typeof options === 'object' ? options : {};
    this._autoInferEdges = opts.autoInferEdges !== false;
    this._strictValidation = opts.strictValidation !== false;
    this._maxNodes = typeof opts.maxNodes === 'number' && opts.maxNodes > 0 ? opts.maxNodes : 500;
    this._compiledCount = 0;
  }

  /**
   * 编译输入为 DSL 对象。
   * @param {string|Object} input - JSON DSL 字符串、DSL 对象、或自然语言提示
   * @returns {{ dsl: Object|null, errors: string[], warnings: string[] }}
   */
  compile(input) {
    const errors = [];
    const warnings = [];

    // Step 1: Parse
    let parsed = null;
    if (typeof input === 'string') {
      parsed = this._parseString(input, errors);
    } else if (input && typeof input === 'object') {
      parsed = input;
    } else {
      errors.push('Input must be a string or object');
      return { dsl: null, errors, warnings };
    }

    if (!parsed || errors.length > 0) {
      return { dsl: null, errors, warnings };
    }

    // Step 2: Validate
    this._validate(parsed, errors, warnings);
    if (this._strictValidation && errors.length > 0) {
      return { dsl: null, errors, warnings };
    }

    // Step 3: Optimize
    const optimized = this._optimize(parsed, warnings);

    // Step 4: Compile
    const dsl = this._compileToDSL(optimized);

    this._compiledCount++;
    return { dsl, errors, warnings };
  }

  /**
   * 解析字符串输入。
   * @param {string} input - 输入字符串
   * @param {string[]} errors - 错误收集器
   * @returns {Object|null} 解析结果
   * @private
   */
  _parseString(input, errors) {
    const trimmed = input.trim();

    // Try JSON parse
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch (err) {
        errors.push('JSON parse error: ' + errorMessage(err));
        return null;
      }
    }

    // Try natural language extraction
    return this._parseNaturalLanguage(trimmed, errors);
  }

  /**
   * 从自然语言提示中提取工作流结构。
   * @param {string} text - 自然语言文本
   * @param {string[]} errors - 错误收集器
   * @returns {Object|null} 提取的 DSL
   * @private
   */
  _parseNaturalLanguage(text, errors) {
    const nodes = [];

    // Extract task steps from common patterns
    const stepPatterns = [
      /(?:step\s*\d+|第\s*\d+\s*步|首先|然后|接着|最后|next|then|first|finally)[：:]\s*(.+)/gi,
      /(\d+)\.\s*(.+)/g,
    ];

    let stepIndex = 0;
    for (const pattern of stepPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const description = (match[2] || match[1] || '').trim();
        if (description.length > 0) {
          const nodeId = 'step-' + stepIndex;
          nodes.push({
            id: nodeId,
            type: 'task',
            task: description,
            depends: stepIndex > 0 ? ['step-' + (stepIndex - 1)] : [],
          });
          stepIndex++;
        }
      }
    }

    // Extract parallel patterns
    const parallelMatch = text.match(/(?:并行|parallel|同时|concurrently)[：:]\s*(.+)/i);
    if (parallelMatch) {
      const parallelTasks = parallelMatch[1].split(/[,，;；]/).map(s => s.trim()).filter(s => s.length > 0);
      if (parallelTasks.length > 0) {
        const fanOutId = 'parallel-' + stepIndex;
        nodes.push({
          id: fanOutId,
          type: 'parallel',
          task: 'Parallel execution',
          agents: parallelTasks,
          depends: nodes.length > 0 ? [nodes[nodes.length - 1].id] : [],
        });
        stepIndex++;
      }
    }

    // Extract verification patterns
    const verifyMatch = text.match(/(?:验证|verify|审查|review|检查|check)[：:]\s*(.+)/i);
    if (verifyMatch) {
      nodes.push({
        id: 'verify-' + stepIndex,
        type: 'verification',
        task: verifyMatch[1].trim(),
        agents: ['reviewer', 'verifier'],
        mode: 'adversarial',
        depends: nodes.length > 0 ? [nodes[nodes.length - 1].id] : [],
      });
      stepIndex++;
    }

    if (nodes.length === 0) {
      errors.push('Could not extract workflow structure from natural language input');
      return null;
    }

    return { name: 'nl-workflow', nodes };
  }

  /**
   * 验证 DSL 结构。
   * @param {Object} dsl - DSL 对象
   * @param {string[]} errors - 错误收集器
   * @param {string[]} warnings - 警告收集器
   * @private
   */
  // eslint-disable-next-line complexity
  _validate(dsl, errors, warnings) {
    if (!dsl.nodes || !Array.isArray(dsl.nodes) || dsl.nodes.length === 0) {
      errors.push('DSL must have a non-empty nodes array');
      return;
    }

    if (dsl.nodes.length > this._maxNodes) {
      errors.push('Exceeds max nodes: ' + this._maxNodes);
    }

    // Check node IDs are unique
    const nodeIds = new Set();
    for (const node of dsl.nodes) {
      if (!node.id || typeof node.id !== 'string') {
        errors.push('Node missing valid id: ' + JSON.stringify(node));
        continue;
      }
      if (nodeIds.has(node.id)) {
        errors.push('Duplicate node id: ' + node.id);
      }
      nodeIds.add(node.id);
    }

    // Check edge references
    if (Array.isArray(dsl.edges)) {
      for (const edge of dsl.edges) {
        if (!edge.from || !nodeIds.has(edge.from)) {
          warnings.push('Edge references unknown source node: ' + edge.from);
        }
        if (!edge.to || !nodeIds.has(edge.to)) {
          warnings.push('Edge references unknown target node: ' + edge.to);
        }
      }
    }

    // Check depends references
    for (const node of dsl.nodes) {
      if (Array.isArray(node.depends)) {
        for (const dep of node.depends) {
          if (!nodeIds.has(dep)) {
            warnings.push('Node ' + node.id + ' depends on unknown node: ' + dep);
          }
        }
      }
    }

    // Check verification nodes have at least 2 agents
    for (const node of dsl.nodes) {
      if (node.type === 'verification' && (!node.agents || node.agents.length < 2)) {
        warnings.push('Verification node ' + node.id + ' should have at least 2 agents for adversarial review');
      }
    }
  }

  /**
   * 优化 DSL — 自动推断边、合并冗余。
   * @param {Object} dsl - DSL 对象
   * @param {string[]} warnings - 警告收集器
   * @returns {Object} 优化后的 DSL
   * @private
   */
  _optimize(dsl, _warnings) {
    const optimized = {
      name: dsl.name || 'unnamed-workflow',
      nodes: dsl.nodes.map(n => ({ ...n, depends: Array.isArray(n.depends) ? n.depends.slice() : [] })),
      edges: Array.isArray(dsl.edges) ? dsl.edges.map(e => ({ ...e })) : [],
      checkpoints: Array.isArray(dsl.checkpoints) ? dsl.checkpoints.slice() : [],
      tokenBudget: dsl.tokenBudget,
    };

    // Auto-infer edges from depends
    if (this._autoInferEdges) {
      const existingEdges = new Set(optimized.edges.map(e => e.from + ':' + e.to));
      for (const node of optimized.nodes) {
        if (Array.isArray(node.depends)) {
          for (const dep of node.depends) {
            const edgeKey = dep + ':' + node.id;
            if (!existingEdges.has(edgeKey)) {
              optimized.edges.push({ from: dep, to: node.id, type: 'sequential' });
              existingEdges.add(edgeKey);
            }
          }
        }
      }
    }

    // Auto-add checkpoints for verification nodes
    for (const node of optimized.nodes) {
      if (node.type === 'verification' && !optimized.checkpoints.includes(node.id)) {
        optimized.checkpoints.push(node.id);
      }
    }

    return optimized;
  }

  /**
   * 编译优化后的中间表示为最终 DSL。
   * @param {Object} optimized - 优化后的 DSL
   * @returns {Object} 最终 DSL
   * @private
   */
  _compileToDSL(optimized) {
    return {
      name: optimized.name,
      nodes: optimized.nodes,
      edges: optimized.edges,
      checkpoints: optimized.checkpoints,
      tokenBudget: optimized.tokenBudget,
    };
  }

  /**
   * 获取编译统计。
   * @returns {{ compiledCount: number }}
   */
  getStats() {
    return { compiledCount: this._compiledCount };
  }
}

module.exports = WorkflowCompiler;
