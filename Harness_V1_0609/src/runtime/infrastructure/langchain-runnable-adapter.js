'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { debug } = require('../../utils/debug-logger');
const BoundedMap = require('../../utils/bounded-map');

/**
 * LangChainRunnableAdapter - Bidirectional LangChain ecosystem integration
 *
 * Extends the existing MCPToolAdapter (one-way: MCP -> LangChain) with:
 * 1. Import and execute LangChain RunnableSequence within Harness
 * 2. Wrap Harness pipelines as LangChain-compatible Runnables
 * 3. Convert between Harness StateGraph and LangGraph StateGraph formats
 *
 * @module runtime/infrastructure/langchain-runnable-adapter
 */
class LangChainRunnableAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this._maxRunnables = options.maxRunnables ?? 50;
    this._importedRunnables = new BoundedMap(this._maxRunnables);
    this._exportedRunnables = new BoundedMap(this._maxRunnables);
    this._pipelineExecutor = options.pipelineExecutor ?? null;
    this._stateGraphFactory = options.stateGraphFactory ?? null;
  }

  /**
   * Import a LangChain Runnable for execution within Harness
   * @param {string} runnableId - Unique identifier for this runnable
   * @param {object} runnable - LangChain Runnable (RunnableSequence, RunnableLambda, etc.)
   * @param {object} options - {inputSchema, outputSchema, description}
   * @returns {{runnableId: string, imported: boolean}}
   */
  importRunnable(runnableId, runnable, options = {}) {
    this.guardShutdown();
    if (!runnableId || typeof runnableId !== 'string') {
      throw new Error('LangChainRunnableAdapter: runnableId must be a non-empty string');
    }
    if (!runnable || typeof runnable.invoke !== 'function') {
      throw new Error('LangChainRunnableAdapter: runnable must have an invoke() method');
    }

    this._importedRunnables.set(runnableId, {
      runnable,
      inputSchema: options.inputSchema ?? null,
      outputSchema: options.outputSchema ?? null,
      description: options.description || `Imported LangChain Runnable: ${runnableId}`,
      importedAt: new Date().toISOString(),
      invocationCount: 0,
      lastError: null,
    });

    this.emit('runnable:imported', { runnableId });

    return { runnableId, imported: true };
  }

  /**
   * Execute an imported LangChain Runnable
   * @param {string} runnableId - Runnable identifier
   * @param {object} input - Input data
   * @param {object} options - {timeout, metadata}
   * @returns {Promise<object>} - Runnable output
   */
  async executeRunnable(runnableId, input, options = {}) {
    this.guardShutdown();
    const entry = this._importedRunnables.get(runnableId);
    if (!entry) {
      throw new Error(`LangChainRunnableAdapter: runnable "${runnableId}" not found`);
    }

    const timeout = options.timeout ?? 30000;
    const startTime = Date.now();

    try {
      // Execute with timeout
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Runnable "${runnableId}" timed out after ${timeout}ms`)), timeout);
      });
      try {
        const result = await Promise.race([
          entry.runnable.invoke(input, { metadata: options.metadata ?? {} }),
          timeoutPromise,
        ]);
        clearTimeout(timeoutId);

        if (this._shutDown) return { output: result, metadata: { runnableId, durationMs: Date.now() - startTime, invocationCount: entry.invocationCount, interrupted: true } };

        entry.invocationCount++;
        entry.lastError = null;

        this.emit('runnable:executed', { runnableId, durationMs: Date.now() - startTime });

        return {
          output: result,
          metadata: {
            runnableId,
            durationMs: Date.now() - startTime,
            invocationCount: entry.invocationCount,
          },
        };
      } catch (error) {
        clearTimeout(timeoutId);
        entry.lastError = error && error.message ? error.message : String(error);
        throw error;
      }
    } catch (error) {
      entry.lastError = error && error.message ? error.message : String(error);
      throw error;
    }
  }

  /**
   * Export a Harness pipeline as a LangChain-compatible Runnable
   * @param {string} pipelineId - Pipeline identifier
   * @param {object} pipeline - Harness pipeline (PipelineExecutor, StateGraph, etc.)
   * @param {object} options - {description, inputMapping, outputMapping}
   * @returns {{runnable: object, exported: boolean}}
   */
  exportAsRunnable(pipelineId, pipeline, options = {}) {
    this.guardShutdown();
    if (!pipelineId || typeof pipelineId !== 'string') {
      throw new Error('LangChainRunnableAdapter: pipelineId must be a non-empty string');
    }

    const adapter = this;
    const inputMapping = options.inputMapping ?? null;
    const outputMapping = options.outputMapping ?? null;

    // Create a LangChain-compatible Runnable interface
    const runnable = {
      // Core LangChain Runnable interface
      async invoke(input, _runOptions = {}) {
        if (adapter._shutDown) throw new Error(`Pipeline "${pipelineId}" adapter is shut down`);
        const mappedInput = inputMapping
          ? adapter._applyMapping(input, inputMapping)
          : input;

        let result;
        if (typeof pipeline.execute === 'function') {
          result = await pipeline.execute(mappedInput);
        } else if (typeof pipeline.run === 'function') {
          result = await pipeline.run(mappedInput);
        } else {
          throw new Error(`Pipeline "${pipelineId}" has no execute() or run() method`);
        }

        return outputMapping
          ? adapter._applyMapping(result, outputMapping)
          : result;
      },

      // Batch execution (LangChain Runnable interface)
      async batch(inputs, runOptions = {}) {
        const results = await Promise.allSettled(inputs.map(i => runnable.invoke(i, runOptions)));
        return results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason && r.reason.message ? r.reason.message : String(r.reason) });
      },

      // Stream execution (simplified - yields final result)
      async *stream(input, runOptions = {}) {
        const result = await runnable.invoke(input, runOptions);
        yield result;
      },

      // Runnable metadata
      lc_runnable: true,
      lc_identifier: [pipelineId],
      description: options.description || `Harness Pipeline: ${pipelineId}`,
    };

    this._exportedRunnables.set(pipelineId, {
      pipeline,
      runnable,
      exportedAt: new Date().toISOString(),
    });

    this.emit('runnable:exported', { pipelineId });

    return { runnable, exported: true };
  }

  /**
   * Convert a Harness StateGraph to LangGraph-compatible format
   * @param {object} stateGraph - Harness StateGraph instance
   * @returns {{nodes: Array, edges: Array, config: object}}
   */
  convertToLangGraphFormat(stateGraph) {
    this.guardShutdown();
    if (!stateGraph) {
      throw new Error('LangChainRunnableAdapter: stateGraph is required');
    }

    if (typeof stateGraph.getNodes !== 'function' && typeof stateGraph.getEdges !== 'function') {
      throw new Error('LangChainRunnableAdapter: stateGraph must have getNodes() or getEdges() methods');
    }

    const nodes = [];
    const edges = [];

    // Extract nodes from StateGraph
    if (typeof stateGraph.getNodes === 'function') {
      const graphNodes = stateGraph.getNodes();
      for (const node of graphNodes) {
        nodes.push({
          id: node.id || node.name,
          type: node.type || 'function',
          metadata: node.metadata ?? {},
        });
      }
    }

    // Extract edges from StateGraph
    if (typeof stateGraph.getEdges === 'function') {
      const graphEdges = stateGraph.getEdges();
      for (const edge of graphEdges) {
        edges.push({
          source: edge.from || edge.source,
          target: edge.to || edge.target,
          type: edge.type || 'sequential',
          condition: edge.condition ?? null,
        });
      }
    }

    return {
      nodes,
      edges,
      config: {
        id: stateGraph.id || 'converted-graph',
        name: stateGraph.name || 'Converted StateGraph',
        sourceFormat: 'harness-state-graph',
        targetFormat: 'langgraph',
        convertedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * List imported runnables
   * @returns {Array<{runnableId: string, description: string, invocationCount: number}>}
   */
  listImportedRunnables() {
    this.guardShutdown();
    const result = [];
    for (const [id, entry] of this._importedRunnables) {
      result.push({
        runnableId: id,
        description: entry.description || '',
        invocationCount: entry.invocationCount ?? 0,
        lastError: entry.lastError,
      });
    }
    return result;
  }

  /**
   * List exported runnables
   * @returns {Array<{pipelineId: string, exportedAt: string}>}
   */
  listExportedRunnables() {
    this.guardShutdown();
    const result = [];
    for (const [id, entry] of this._exportedRunnables) {
      result.push({ pipelineId: id, exportedAt: entry.exportedAt || '' });
    }
    return result;
  }

  // --- Private methods ---

  _applyMapping(data, mapping) {
    if (!mapping || typeof mapping !== 'object') return data;
    const result = {};
    for (const [key, sourcePath] of Object.entries(mapping)) {
      result[key] = this._getNestedValue(data, sourcePath);
    }
    return result;
  }

  _getNestedValue(obj, path) {
    if (!obj || typeof path !== 'string') return undefined;
    return path.split('.').reduce((o, k) => o?.[k], obj);
  }

  _onShutdown() {
    this.removeAllListeners();
    try { this._importedRunnables.shutdown(); } catch (_e) { debug('LangChainRunnableAdapter', '_onShutdown:importedRunnables', _e && _e.message ? _e.message : String(_e)); }
    try { this._exportedRunnables.shutdown(); } catch (_e) { debug('LangChainRunnableAdapter', '_onShutdown:exportedRunnables', _e && _e.message ? _e.message : String(_e)); }
    this._importedRunnables = null;
    this._exportedRunnables = null;
    this._pipelineExecutor = null;
    this._stateGraphFactory = null;
  }
}

module.exports = withShutdown(LangChainRunnableAdapter);
