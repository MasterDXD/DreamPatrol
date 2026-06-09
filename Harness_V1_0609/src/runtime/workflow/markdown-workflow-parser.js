'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');

/**
 * MarkdownWorkflowParser - WAT Model implementation
 * Parses markdown skill files into executable StateGraph definitions
 * with explicit tool bindings, enabling deterministic execution without LLM interpretation.
 *
 * WAT = Write-Automate-Track: markdown IS the program
 *
 * @module runtime/workflow/markdown-workflow-parser
 */
class MarkdownWorkflowParser extends EventEmitter {
  constructor(options) {
    const opts = options ?? {};
    super();
    this._maxSteps = opts.maxSteps ?? 50;
    this._maxWorkflows = opts.maxWorkflows ?? 100;
    this._parsedWorkflows = new BoundedMap(this._maxWorkflows);
    this._toolRegistry = opts.toolRegistry ?? null;
    this._stateGraphFactory = opts.stateGraphFactory ?? null;
  }

  /**
   * Parse a markdown skill file into a StateGraph definition
   * @param {object} skillData - Parsed skill data (from skill-discover-utils)
   * @param {string} skillData.skill_id - Skill identifier
   * @param {string} skillData.name - Skill name
   * @param {Array} skillData.steps - Step definitions from frontmatter
   * @param {string} skillData.body - Markdown body with ## Steps section
   * @returns {{graphDef: object, nodes: Array, edges: Array, tools: Array}}
   */
  parseToGraph(skillData) {
    this.guardShutdown();
    if (!skillData || !skillData.skill_id) {
      throw new Error('MarkdownWorkflowParser: skillData with skill_id is required');
    }

    const nodes = [];
    const edges = [];
    const tools = [];

    // Parse steps from frontmatter or body
    const steps = this._extractSteps(skillData);
    if (!steps || steps.length === 0) {
      return { graphDef: null, nodes: [], edges: [], tools: [] };
    }

    if (steps.length > this._maxSteps) {
      throw new Error(`MarkdownWorkflowParser: too many steps (${steps.length}), max is ${this._maxSteps}`);
    }

    // Convert each step to a graph node with tool binding
    this._buildNodesAndEdges(steps, nodes, edges, tools);

    // Add START and END nodes
    if (nodes.length > 0) {
      edges.unshift({ from: '__START__', to: nodes[0].id, type: 'sequential' });
      edges.push({ from: nodes[nodes.length - 1].id, to: '__END__', type: 'sequential' });
    }

    const graphDef = {
      id: `wat-${skillData.skill_id}`,
      name: skillData.name || skillData.skill_id,
      type: 'wat-workflow',
      source: 'markdown',
      nodes,
      edges,
      tools,
      metadata: {
        parsedAt: new Date().toISOString(),
        stepCount: steps.length,
        skillId: skillData.skill_id,
      },
    };

    // Check for cycles in edges
    const edgeTargets = new Set(edges.filter(e => e.type === 'sequential').map(e => e.to));
    // Simple check: if __END__ is not reachable from __START__, warn
    if (nodes.length > 0 && !edgeTargets.has('__END__')) {
      graphDef.metadata.cycleWarning = true;
    }

    // Cache parsed workflow
    this._parsedWorkflows.set(skillData.skill_id, graphDef);

    this.emit('workflow:parsed', { skillId: skillData.skill_id, stepCount: steps.length });

    return graphDef;
  }

  /**
   * Build an executable StateGraph from a parsed workflow definition
   * @param {object} graphDef - Graph definition from parseToGraph()
   * @returns {object} StateGraph instance
   */
  buildStateGraph(graphDef) {
    this.guardShutdown();
    if (!graphDef || !Array.isArray(graphDef.nodes) || !Array.isArray(graphDef.edges)) {
      throw new Error('MarkdownWorkflowParser: graphDef must have nodes and edges arrays');
    }
    if (!this._stateGraphFactory) {
      return null;
    }

    const graph = this._stateGraphFactory.create({
      id: graphDef.id,
      name: graphDef.name,
    });

    // Add nodes
    for (const node of graphDef.nodes) {
      graph.addNode(node.id, node.handler, { metadata: node.metadata });
    }

    // Add edges
    for (const edge of graphDef.edges) {
      if (edge.type === 'conditional') {
        graph.addConditionalEdge(edge.from, edge.condition, edge.mapping);
      } else {
        graph.addEdge(edge.from, edge.to);
      }
    }

    return graph;
  }

  /**
   * Get a cached parsed workflow
   * @param {string} skillId
   * @returns {object|null}
   */
  getParsedWorkflow(skillId) {
    this.guardShutdown();
    return this._parsedWorkflows.get(skillId) ?? null;
  }

  /**
   * List all cached parsed workflows
   * @returns {Array<{skillId: string, stepCount: number, parsedAt: string}>}
   */
  listParsedWorkflows() {
    this.guardShutdown();
    const result = [];
    for (const [key, def] of this._parsedWorkflows) {
      result.push({
        skillId: key,
        stepCount: def.metadata?.stepCount ?? 0,
        parsedAt: def.metadata?.parsedAt ?? '',
      });
    }
    return result;
  }

  // --- Private methods ---

  /**
   * Build graph nodes and edges from steps
   * @private
   */
  _buildNodesAndEdges(steps, nodes, edges, tools) {
    let prevNodeId = null;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const nodeId = `step_${i}_${this._sanitizeNodeId(step.name || step.description || `step${i}`)}`;

      // Resolve tool binding
      const toolBinding = this._resolveToolBinding(step);
      if (toolBinding) tools.push(toolBinding);

      nodes.push({
        id: nodeId,
        type: 'function',
        metadata: {
          stepIndex: i,
          stepName: step.name || `Step ${i + 1}`,
          description: step.description || '',
          toolBinding: toolBinding ? toolBinding.toolId : null,
          inputSchema: (step.input || step.inputs) ?? null,
          outputSchema: (step.output || step.outputs) ?? null,
        },
        handler: this._createStepHandler(step, toolBinding),
      });

      // Sequential edge from previous step
      if (prevNodeId) {
        edges.push({ from: prevNodeId, to: nodeId, type: 'sequential' });
      }

      // Conditional edges
      if (step.condition || step.branch) {
        const branches = this._parseConditionalEdges(step, nodeId, steps, i);
        edges.push(...branches);
      }

      prevNodeId = nodeId;
    }
  }

  /**
   * Extract steps from skill data (frontmatter steps or body ## Steps section)
   * @private
   */
  _extractSteps(skillData) {
    // Priority 1: frontmatter steps array
    if (Array.isArray(skillData.steps) && skillData.steps.length > 0) {
      return skillData.steps.filter(s => s && (s.name || s.description));
    }

    // Priority 2: parse ## Steps section from body
    if (skillData.body && typeof skillData.body === 'string') {
      return this._parseStepsFromBody(skillData.body);
    }

    return [];
  }

  /**
   * Parse steps from markdown body ## Steps section
   * @private
   */
  _parseStepsFromBody(body) {
    const steps = [];
    const stepsMatch = body.match(/##\s*(?:执行步骤|Steps?|步骤)\s*\n([\s\S]*?)(?=\n##\s|$)/i);
    if (!stepsMatch) return steps;

    const stepsText = stepsMatch[1];
    // Split by numbered step pattern, capture step number and content
    const stepBlocks = stepsText.split(/(?=^\s*\d+\.\s)/m);
    for (const block of stepBlocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const headerMatch = trimmed.match(/^\s*(\d+)\.\s+(.+?)(?:\n([\s\S]*))?$/);
      if (headerMatch) {
        const name = headerMatch[2].replace(/[:：].*$/, '').trim();
        const description = headerMatch[3] ? headerMatch[3].trim() : name;
        steps.push({
          index: parseInt(headerMatch[1], 10) - 1,
          name,
          description,
        });
      }
    }
    return steps;
  }

  /**
   * Resolve tool binding for a step
   * @private
   */
  _resolveToolBinding(step) {
    if (!step.tool && !step.toolId && !step.action) return null;

    const toolId = step.tool || step.toolId || step.action;
    return {
      toolId,
      method: step.method ?? null,
      inputMapping: (step.inputMapping || step.input_map) ?? null,
      outputMapping: (step.outputMapping || step.output_map) ?? null,
    };
  }

  /**
   * Parse conditional edges from a step
   * @private
   */
  _parseConditionalEdges(step, nodeId, steps, currentIndex) {
    const edges = [];
    if (step.branch && typeof step.branch === 'object') {
      for (const [condition, target] of Object.entries(step.branch)) {
        edges.push({
          from: nodeId,
          to: typeof target === 'string' ? target : `step_${currentIndex + 1}`,
          type: 'conditional',
          condition,
        });
      }
    }
    return edges;
  }

  /**
   * Create a step handler function
   * @private
   */
  _createStepHandler(step, toolBinding) {
    const applyMapping = this._applyMapping.bind(this);
    return async function stepHandler(state) {
      if (toolBinding && toolBinding.toolId) {
        // WAT model: deterministic tool invocation
        const _input = toolBinding.inputMapping
          ? applyMapping(state, toolBinding.inputMapping)
          : state;
        return { ...state, _lastStep: step.name, _lastTool: toolBinding.toolId };
      }
      // Fallback: pass-through (LLM will interpret)
      return { ...state, _lastStep: step.name };
    };
  }

  /**
   * Apply input/output mapping
   * @private
   */
  _applyMapping(state, mapping) {
    if (!mapping || typeof mapping !== 'object') return state;
    const result = {};
    for (const [key, sourcePath] of Object.entries(mapping)) {
      result[key] = this._getNestedValue(state, sourcePath);
    }
    return result;
  }

  /**
   * Get nested value from object by dot-separated path
   * @private
   */
  _getNestedValue(obj, path) {
    if (!obj || typeof path !== 'string') return undefined;
    return path.split('.').reduce((o, k) => o?.[k], obj);
  }

  /**
   * Sanitize a string for use as a node ID
   * @private
   */
  _sanitizeNodeId(name) {
    const sanitized = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
    return sanitized || 'unnamed';
  }

  _onShutdown() {
    this.removeAllListeners();
    try { this._parsedWorkflows.shutdown(); } catch (_e) { debug('MarkdownWorkflowParser', '_onShutdown:parsedWorkflows', _e && _e.message ? _e.message : String(_e)); }
    this._parsedWorkflows = null;
    this._toolRegistry = null;
    this._stateGraphFactory = null;
  }
}

module.exports = withShutdown(MarkdownWorkflowParser);
