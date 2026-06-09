/**
 * @module runtime/model/compute-accelerator
 * @description CPU-GPU协作抽象计算层核心模块，提供统一计算加速接口。
 * 包含ComputeBackend抽象基类、CpuBackend纯JavaScript实现、GpuBackend GPU加速与回退机制，
 * 以及ComputeAccelerator主调度器，支持后端自动选择、特性标志控制和运行时后端切换。
 */
'use strict';

const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { mergeConfig } = require('../../utils/safe-assign');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * @constant {Object} DEFAULT_CONFIG
 * @description ComputeAccelerator默认配置项。
 * @property {string} defaultBackend - 默认计算后端，可选 'cpu'、'gpu'、'auto'
 * @property {Object|null} gpuBridge - 外部GPU桥接对象，如WebGPU/Node-CUDA适配器
 * @property {Object|null} featureFlags - 特性标志，支持运行时切换后端行为
 * @property {string[]} gpuPriorityOps - GPU优先操作列表，这些操作在GPU可用时优先使用GPU
 * @property {number} statsInterval - 统计信息采集间隔（毫秒），0表示不定期采集
 */
const MAX_OPERATION_TYPES = 50;

const DEFAULT_CONFIG = {
  defaultBackend: 'auto',
  gpuBridge: null,
  featureFlags: null,
  gpuPriorityOps: ['cosineSimilarity', 'batchCosineSimilarity', 'matrixMultiply', 'monteCarloSimulate'],
  statsInterval: 0,
};

/**
 * 计算后端抽象基类，定义CPU-GPU协作计算的统一接口。
 * 所有具体后端（CpuBackend、GpuBackend）必须继承此类并实现全部方法。
 *
 * @abstract
 * @classdesc 计算后端抽象基类，定义统一计算接口规范
 */
class ComputeBackend {
  /**
   * 创建ComputeBackend实例，初始化统计信息。
   */
  constructor() {
    this._initialized = false;
    this._stats = {
      operations: 0,
      totalLatencyMs: 0,
    };
  }

  /**
   * 初始化后端，分配资源并标记为已初始化状态。
   * @async
   * @returns {Promise<void>}
   */
  async init() {
    this._initialized = true;
  }

  /**
   * 关闭后端，释放资源并重置统计信息。
   * @async
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._initialized = false;
    this._stats = { operations: 0, totalLatencyMs: 0 };
  }

  /**
   * 计算两个向量的余弦相似度。
   * @async
   * @param {number[]} vecA - 向量A
   * @param {number[]} vecB - 向量B
   * @returns {Promise<number>} 余弦相似度，范围 [-1, 1]
   */
  async cosineSimilarity(_vecA, _vecB) {
    throw new Error('cosineSimilarity not implemented');
  }

  /**
   * 批量计算查询向量与多个候选向量的余弦相似度。
   * @async
   * @param {number[]} queryVec - 查询向量
   * @param {Array<number[]>} vectors - 候选向量数组
   * @returns {Promise<number[]>} 余弦相似度数组，与候选向量一一对应
   */
  async batchCosineSimilarity(_queryVec, _vectors) {
    throw new Error('batchCosineSimilarity not implemented');
  }

  /**
   * 矩阵乘法，计算矩阵A与矩阵B的乘积。
   * @async
   * @param {number[][]} a - 矩阵A（M×K）
   * @param {number[][]} b - 矩阵B（K×N）
   * @param {Object} dims - 维度信息 {m, k, n}
   * @returns {Promise<number[][]} 结果矩阵（M×N）
   */
  async matrixMultiply(_a, _b, _dims) {
    throw new Error('matrixMultiply not implemented');
  }

  /**
   * 蒙特卡洛模拟，串行或并行执行随机模拟迭代。
   * @async
   * @param {Object} config - 模拟配置
   * @param {number} config.iterations - 模拟迭代次数
   * @param {number} config.timeSteps - 每次迭代的时间步数
   * @param {number} config.variables - 随机变量数量
   * @param {Function} config.simulateStep - 单步模拟函数
   * @returns {Promise<Object>} 模拟结果，包含均值、方差、样本数组等
   */
  async monteCarloSimulate(_config) {
    throw new Error('monteCarloSimulate not implemented');
  }

  /**
   * 文本嵌入，将文本转换为指定维度的向量。
   * @async
   * @param {string} text - 待嵌入的文本
   * @param {number} dimensions - 输出向量维度
   * @returns {Promise<number[]>} 嵌入向量
   */
  async embed(_text, _dimensions) {
    throw new Error('embed not implemented');
  }

  /**
   * 注意力评分，基于位置、重要性和时效性计算注意力权重。
   * @async
   * @param {Object} query - 查询对象，含importance和recency属性
   * @param {Object} key - 键对象，含importance和recency属性
   * @param {number} position - 当前位置索引
   * @param {number} total - 总位置数
   * @returns {Promise<number>} 注意力评分，范围 [0, 1]
   */
  async attentionScore(_query, _key, _position, _total) {
    throw new Error('attentionScore not implemented');
  }

  /**
   * 检查后端是否可用。
   * @returns {boolean} 后端是否可用
   */
  isAvailable() {
    return this._initialized;
  }

  /**
   * 返回后端类型标识字符串。
   * @returns {string} 后端类型
   */
  getBackendType() {
    return 'unknown';
  }

  /**
   * 返回后端运行统计信息。
   * @returns {Object} 统计信息对象
   */
  getStats() {
    return {
      backendType: this.getBackendType(),
      initialized: this._initialized,
      operations: this._stats.operations,
      avgLatencyMs: this._stats.operations > 0
        ? this._stats.totalLatencyMs / this._stats.operations
        : 0,
    };
  }

  /**
   * 记录一次操作的耗时统计。
   * @param {number} elapsedMs - 操作耗时（毫秒）
   * @protected
   */
  _recordOp(elapsedMs) {
    this._stats.operations++;
    this._stats.totalLatencyMs += elapsedMs;
  }
}

/**
 * CPU计算后端，使用纯JavaScript数值计算实现所有计算接口。
 * 始终可用，作为GPU不可用时的回退方案。
 *
 * @extends ComputeBackend
 * @classdesc CPU计算后端，使用主线程执行计算密集型任务
 */
class CpuBackend extends ComputeBackend {
  /**
   * 创建CpuBackend实例。
   */
  constructor() {
    super();
  }

  /**
   * 计算两个向量的余弦相似度，使用标准点积与范数公式。
   * 向量长度不一致或为零时返回0。
   *
   * @async
   * @param {number[]} vecA - 向量A
   * @param {number[]} vecB - 向量B
   * @returns {Promise<number>} 余弦相似度，范围 [-1, 1]；无效输入返回0
   */
  async cosineSimilarity(vecA, vecB) {
    const start = Date.now();
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) {
      this._recordOp(Date.now() - start);
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    const result = (!Number.isFinite(denominator) || denominator === 0) ? 0 : dotProduct / denominator;
    this._recordOp(Date.now() - start);
    return result;
  }

  /**
   * 批量计算查询向量与多个候选向量的余弦相似度，循环调用cosineSimilarity。
   *
   * @async
   * @param {number[]} queryVec - 查询向量
   * @param {Array<number[]>} vectors - 候选向量数组
   * @returns {Promise<number[]>} 余弦相似度数组
   */
  async batchCosineSimilarity(queryVec, vectors) {
    const start = Date.now();
    if (!Array.isArray(vectors)) {
      this._recordOp(Date.now() - start);
      return [];
    }

    const results = [];
    for (let i = 0; i < vectors.length; i++) {
      const sim = await this.cosineSimilarity(queryVec, vectors[i]);
      results.push(sim);
    }

    this._recordOp(Date.now() - start);
    return results;
  }

  _safeMatrixVal(matrix, row, col) {
    return (matrix[row] && typeof matrix[row][col] === 'number') ? matrix[row][col] : 0;
  }

  _parseMatrixDims(a, b, dims) {
    const m = (dims && Number.isFinite(dims.m) && dims.m > 0) ? dims.m : (a ? a.length : 0);
    const k = (dims && Number.isFinite(dims.k) && dims.k > 0) ? dims.k : (a && a[0] ? a[0].length : 0);
    const n = (dims && Number.isFinite(dims.n) && dims.n > 0) ? dims.n : (b && b[0] ? b[0].length : 0);
    return { m, k, n };
  }

  /**
   * 矩阵乘法，使用三重循环实现M×K与K×N矩阵的乘积。
   *
   * @async
   * @param {number[][]} a - 矩阵A（M×K）
   * @param {number[][]} b - 矩阵B（K×N）
   * @param {Object} dims - 维度信息 {m, k, n}
   * @returns {Promise<number[][]>} 结果矩阵（M×N）
   */
  async matrixMultiply(a, b, dims) {
    const start = Date.now();
    const { m, k, n } = this._parseMatrixDims(a, b, dims);

    if (m === 0 || k === 0 || n === 0) {
      this._recordOp(Date.now() - start);
      return [];
    }

    const result = new Array(m);
    for (let i = 0; i < m; i++) {
      result[i] = new Array(n).fill(0);
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let p = 0; p < k; p++) {
          sum += this._safeMatrixVal(a, i, p) * this._safeMatrixVal(b, p, j);
        }
        result[i][j] = sum;
      }
    }

    this._recordOp(Date.now() - start);
    return result;
  }

  /**
   * 蒙特卡洛模拟，串行迭代执行随机模拟。
   * config需包含iterations、timeSteps、variables和simulateStep函数。
   *
   * @async
   * @param {Object} config - 模拟配置
   * @param {number} config.iterations - 模拟迭代次数
   * @param {number} config.timeSteps - 每次迭代的时间步数
   * @param {number} config.variables - 随机变量数量
   * @param {Function} config.simulateStep - 单步模拟函数(step, state) => newState
   * @returns {Promise<Object>} 模拟结果，含mean、variance、samples、iterations
   */
  async monteCarloSimulate(config) {
    const start = Date.now();
    const iterations = (config && typeof config.iterations === 'number' && Number.isFinite(config.iterations) && config.iterations > 0) ? config.iterations : 1000;
    const timeSteps = (config && typeof config.timeSteps === 'number' && Number.isFinite(config.timeSteps) && config.timeSteps > 0) ? config.timeSteps : 10;
    const variables = (config && typeof config.variables === 'number' && Number.isFinite(config.variables) && config.variables > 0) ? config.variables : 1;
    const simulateStep = (config && typeof config.simulateStep === 'function') ? config.simulateStep : null;

    const samples = new Array(iterations);

    for (let i = 0; i < iterations; i++) {
      let state = new Array(variables).fill(0);
      if (simulateStep) {
        for (let t = 0; t < timeSteps; t++) {
          state = simulateStep(t, state);
        }
      }
      samples[i] = state;
    }

    const finalValues = samples.map(s => (Array.isArray(s) ? s[0] : s));
    const sum = finalValues.reduce((acc, v) => acc + (typeof v === 'number' && Number.isFinite(v) ? v : 0), 0);
    const mean = iterations > 0 ? sum / iterations : 0;
    const variance = iterations > 0 ? finalValues.reduce((acc, v) => {
      const diff = (typeof v === 'number' && Number.isFinite(v) ? v : 0) - mean;
      return acc + diff * diff;
    }, 0) / iterations : 0;

    this._recordOp(Date.now() - start);
    return { mean, variance, samples, iterations };
  }

  /**
   * 文本嵌入，使用哈希嵌入算法生成确定性向量。
   * 算法与EmbeddingService._embedLocal一致：字符哈希种子 + 二元组特征 + L2归一化。
   *
   * @async
   * @param {string} text - 待嵌入的文本
   * @param {number} dimensions - 输出向量维度
   * @returns {Promise<number[]>} 归一化后的嵌入向量；无效输入返回空数组
   */
  async embed(text, dimensions) {
    const start = Date.now();
    const dims = typeof dimensions === 'number' && Number.isFinite(dimensions) && dimensions > 0 ? dimensions : 128;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      this._recordOp(Date.now() - start);
      return [];
    }

    const vector = new Array(dims);
    const normalized = text.toLowerCase().replace(/[^\w\s\u4e00-\u9fff]/g, ' ').trim();
    if (!normalized) return vector.fill(0);
    const chars = normalized.split('');

    let seed = 0;
    for (let i = 0; i < chars.length; i++) {
      seed = ((seed << 5) - seed + chars[i].charCodeAt(0)) | 0;
    }

    for (let i = 0; i < dims; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      vector[i] = (seed / 0x7fffffff) * 2 - 1;
    }

    const bigrams = new Set();
    for (let i = 0; i < normalized.length - 1; i++) {
      if (bigrams.size >= 5000) break;
      bigrams.add(normalized.substring(i, i + 2));
    }

    for (const bigram of bigrams) {
      let hash = 0;
      for (let i = 0; i < bigram.length; i++) {
        hash = ((hash << 5) - hash + bigram.charCodeAt(i)) | 0;
      }
      const idx = Math.abs(hash) % dims;
      vector[idx] += 0.3;
      const secondaryIdx = Math.abs(hash * 31 + 7) % dims;
      if (secondaryIdx !== idx) {
        vector[secondaryIdx] += 0.15;
      }
    }

    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    if (Number.isFinite(norm) && norm > 0) {
      for (let i = 0; i < dims; i++) {
        vector[i] /= norm;
      }
    }

    this._recordOp(Date.now() - start);
    return vector;
  }

  _safeNum(val) {
    return typeof val === 'number' && Number.isFinite(val) ? val : 0;
  }

  _extractScoreProps(obj) {
    if (!obj || typeof obj !== 'object') return { importance: 0, recency: 0 };
    return {
      importance: this._safeNum(obj.importance),
      recency: this._safeNum(obj.recency),
    };
  }

  /**
   * 注意力评分，使用 sin(π*pos/total) * importance * recency 公式。
   * 综合位置、重要性和时效性三维度计算注意力权重。
   *
   * @async
   * @param {Object} query - 查询对象
   * @param {number} query.importance - 查询重要性分数
   * @param {number} query.recency - 查询时效性分数
   * @param {Object} key - 键对象
   * @param {number} key.importance - 键重要性分数
   * @param {number} key.recency - 键时效性分数
   * @param {number} position - 当前位置索引
   * @param {number} total - 总位置数
   * @returns {Promise<number>} 注意力评分，范围 [0, 1]
   */
  async attentionScore(query, key, position, total) {
    const start = Date.now();
    const totalPositions = this._safeNum(total) > 0 ? total : 1;
    const pos = this._safeNum(position) >= 0 ? position : 0;

    const qProps = this._extractScoreProps(query);
    const kProps = this._extractScoreProps(key);

    const importance = (qProps.importance + kProps.importance) / 2;
    const recency = (qProps.recency + kProps.recency) / 2;

    const positionalWeight = totalPositions === 1 ? 1.0 : Math.sin(Math.PI * pos / totalPositions);
    const score = positionalWeight * importance * recency;
    const result = Math.max(0, Math.min(1, Number.isFinite(score) ? score : 0));

    this._recordOp(Date.now() - start);
    return result;
  }

  /**
   * CPU后端始终可用。
   * @returns {boolean} 始终返回 true
   */
  isAvailable() {
    return true;
  }

  /**
   * 返回CPU后端类型标识。
   * @returns {string} 'cpu'
   */
  getBackendType() {
    return 'cpu';
  }
}

/**
 * GPU计算后端，通过外部GPU桥接对象实现加速计算。
 * 当GPU桥接不可用时，自动回退到内部CpuBackend实例执行。
 *
 * @extends ComputeBackend
 * @classdesc GPU计算后端，利用硬件加速执行大规模矩阵运算
 */
class GpuBackend extends ComputeBackend {
  /**
   * 创建GpuBackend实例。
   * @param {Object|null} [gpuBridge=null] - 外部GPU桥接对象，如WebGPU/Node-CUDA适配器
   */
  constructor(gpuBridge) {
    super();
    this._gpuBridge = gpuBridge ?? null;
    this._cpuFallback = new CpuBackend();
    this._gpuHits = 0;
    this._gpuMisses = 0;
  }

  /**
   * 初始化GPU后端，同时初始化内部CPU回退后端。
   * @async
   * @returns {Promise<void>}
   */
  async init() {
    await this._cpuFallback.init();
    this._initialized = true;
    debug('ComputeAccelerator', 'GpuBackend.init', 'initialized, gpuBridge=' + (this._gpuBridge ? 'present' : 'absent'));
  }

  /**
   * 关闭GPU后端，同时关闭内部CPU回退后端。
   * @async
   * @returns {Promise<void>}
   */
  async shutdown() {
    await this._cpuFallback.shutdown();
    this._initialized = false;
    this._gpuHits = 0;
    this._gpuMisses = 0;
  }

  /**
   * 检查GPU桥接是否可用。
   * @returns {boolean} gpuBridge存在且已初始化时返回true
   */
  isAvailable() {
    return this._gpuBridge != null && typeof this._gpuBridge === 'object' && this._gpuBridge.initialized !== false;
  }

  /**
   * 返回后端类型标识，GPU可用时返回'gpu'，否则返回'gpu-fallback-cpu'。
   * @returns {string} 后端类型字符串
   */
  getBackendType() {
    return this.isAvailable() ? 'gpu' : 'gpu-fallback-cpu';
  }

  /**
   * 计算两个向量的余弦相似度。GPU不可用时回退到CPU。
   * @async
   * @param {number[]} vecA - 向量A
   * @param {number[]} vecB - 向量B
   * @returns {Promise<number>} 余弦相似度
   */
  async cosineSimilarity(vecA, vecB) {
    if (!this.isAvailable()) {
      this._gpuMisses++;
      return this._cpuFallback.cosineSimilarity(vecA, vecB);
    }
    this._gpuHits++;
    const start = Date.now();
    if (typeof this._gpuBridge.cosineSimilarity === 'function') {
      const result = await this._gpuBridge.cosineSimilarity(vecA, vecB);
      this._recordOp(Date.now() - start);
      return result;
    }
    this._gpuMisses++;
    this._gpuHits--;
    return this._cpuFallback.cosineSimilarity(vecA, vecB);
  }

  /**
   * 批量计算余弦相似度。GPU不可用时回退到CPU。
   * @async
   * @param {number[]} queryVec - 查询向量
   * @param {Array<number[]>} vectors - 候选向量数组
   * @returns {Promise<number[]>} 余弦相似度数组
   */
  async batchCosineSimilarity(queryVec, vectors) {
    if (!this.isAvailable()) {
      this._gpuMisses++;
      return this._cpuFallback.batchCosineSimilarity(queryVec, vectors);
    }
    this._gpuHits++;
    const start = Date.now();
    if (typeof this._gpuBridge.batchCosineSimilarity === 'function') {
      const result = await this._gpuBridge.batchCosineSimilarity(queryVec, vectors);
      this._recordOp(Date.now() - start);
      return result;
    }
    this._gpuMisses++;
    this._gpuHits--;
    return this._cpuFallback.batchCosineSimilarity(queryVec, vectors);
  }

  /**
   * 矩阵乘法。GPU不可用时回退到CPU。
   * @async
   * @param {number[][]} a - 矩阵A
   * @param {number[][]} b - 矩阵B
   * @param {Object} dims - 维度信息
   * @returns {Promise<number[][]} 结果矩阵
   */
  async matrixMultiply(a, b, dims) {
    if (!this.isAvailable()) {
      this._gpuMisses++;
      return this._cpuFallback.matrixMultiply(a, b, dims);
    }
    this._gpuHits++;
    const start = Date.now();
    if (typeof this._gpuBridge.matrixMultiply === 'function') {
      const result = await this._gpuBridge.matrixMultiply(a, b, dims);
      this._recordOp(Date.now() - start);
      return result;
    }
    this._gpuMisses++;
    this._gpuHits--;
    return this._cpuFallback.matrixMultiply(a, b, dims);
  }

  /**
   * 蒙特卡洛模拟。GPU不可用时回退到CPU。
   * @async
   * @param {Object} config - 模拟配置
   * @returns {Promise<Object>} 模拟结果
   */
  async monteCarloSimulate(config) {
    if (!this.isAvailable()) {
      this._gpuMisses++;
      return this._cpuFallback.monteCarloSimulate(config);
    }
    this._gpuHits++;
    const start = Date.now();
    if (typeof this._gpuBridge.monteCarloSimulate === 'function') {
      const result = await this._gpuBridge.monteCarloSimulate(config);
      this._recordOp(Date.now() - start);
      return result;
    }
    this._gpuMisses++;
    this._gpuHits--;
    return this._cpuFallback.monteCarloSimulate(config);
  }

  /**
   * 文本嵌入。GPU不可用时回退到CPU。
   * @async
   * @param {string} text - 待嵌入的文本
   * @param {number} dimensions - 输出向量维度
   * @returns {Promise<number[]>} 嵌入向量
   */
  async embed(text, dimensions) {
    if (!this.isAvailable()) {
      this._gpuMisses++;
      return this._cpuFallback.embed(text, dimensions);
    }
    this._gpuHits++;
    const start = Date.now();
    if (typeof this._gpuBridge.embed === 'function') {
      const result = await this._gpuBridge.embed(text, dimensions);
      this._recordOp(Date.now() - start);
      return result;
    }
    this._gpuMisses++;
    this._gpuHits--;
    return this._cpuFallback.embed(text, dimensions);
  }

  /**
   * 注意力评分。GPU不可用时回退到CPU。
   * @async
   * @param {Object} query - 查询对象
   * @param {Object} key - 键对象
   * @param {number} position - 位置索引
   * @param {number} total - 总位置数
   * @returns {Promise<number>} 注意力评分
   */
  async attentionScore(query, key, position, total) {
    if (!this.isAvailable()) {
      this._gpuMisses++;
      return this._cpuFallback.attentionScore(query, key, position, total);
    }
    this._gpuHits++;
    const start = Date.now();
    if (typeof this._gpuBridge.attentionScore === 'function') {
      const result = await this._gpuBridge.attentionScore(query, key, position, total);
      this._recordOp(Date.now() - start);
      return result;
    }
    this._gpuMisses++;
    this._gpuHits--;
    return this._cpuFallback.attentionScore(query, key, position, total);
  }

  /**
   * 返回GPU后端统计信息，包含GPU命中/未命中计数。
   * @returns {Object} 统计信息对象
   */
  getStats() {
    return mergeConfig(super.getStats(), {
      gpuHits: this._gpuHits,
      gpuMisses: this._gpuMisses,
      gpuBridgePresent: this._gpuBridge != null,
    });
  }
}

/**
 * 计算加速器主类，提供统一的计算加速调度接口。
 * 支持CPU/GPU后端自动选择、特性标志控制、运行时后端切换和自定义后端注册。
 * 通过withShutdown混入优雅关闭能力。
 * @classdesc 计算加速器。CPU/GPU后端、矩阵运算加速
 *
 * @extends EventEmitter
 * @emits 'backend-switched' 当活跃后端切换时触发，载荷为 {from: string, to: string}
 * @emits 'operation-completed' 当操作完成时触发，载荷为 {operation: string, backend: string, latencyMs: number}
 * @emits 'operation-failed' 当操作失败时触发，载荷为 {operation: string, backend: string, error: Error}
 * @emits 'gpu-fallback' 当GPU回退到CPU时触发，载荷为 {operation: string, reason: string}
 */
class ComputeAccelerator extends EventEmitter {
  /**
   * 创建ComputeAccelerator实例。
   * @param {Object} [options={}] - 配置选项，与DEFAULT_CONFIG合并
   * @param {string} [options.defaultBackend='auto'] - 默认计算后端，可选 'cpu'、'gpu'、'auto'
   * @param {Object|null} [options.gpuBridge=null] - 外部GPU桥接对象
   * @param {Object|null} [options.featureFlags=null] - 特性标志
   * @param {string[]} [options.gpuPriorityOps] - GPU优先操作列表
   * @param {number} [options.statsInterval=0] - 统计信息采集间隔
   */
  constructor(options) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    this._backends = new Map();
    /** 计算后端Map最大容量 */
    this._maxBackends = 20;
    this._activeBackendName = null;
    this._activeBackend = null;
    this._featureFlags = this._config.featureFlags ?? {};
    this._gpuAvailable = null;
    this._stats = {
      totalOperations: 0,
      totalLatencyMs: 0,
      operationsByType: {},
      backendSwitches: 0,
    };

    this._backends.set('cpu', new CpuBackend());
    this._backends.set('gpu', new GpuBackend(this._config.gpuBridge));
  }

  /**
   * 初始化计算加速器，创建并初始化后端实例。
   * auto模式下自动检测GPU可用性并选择最优后端。
   *
   * @async
   * @returns {Promise<void>}
   * @example
   * const accel = new ComputeAccelerator();
   * await accel.init({ backends: ['local'], maxConcurrency: 4 });
   * const result = await accel.execute({ type: 'inference', model: 'gpt-4', input: 'Hello' });
   * await accel.shutdown();
   */
  async init() {
    this.guardShutdown();
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    try {
      return await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _doInit() {
    for (const [name, backend] of this._backends) {
      await backend.init();
      debug('ComputeAccelerator', 'init', 'backend ' + name + ' initialized');
    }

    const mode = this._config.defaultBackend;
    if (mode === 'auto') {
      const gpuBackend = this._backends.get('gpu');
      this._gpuAvailable = gpuBackend ? gpuBackend.isAvailable() : false;
      this._activeBackendName = this._gpuAvailable ? 'gpu' : 'cpu';
      debug('ComputeAccelerator', 'init', 'auto mode detected GPU: ' + this._gpuAvailable);
    } else if (this._backends.has(mode)) {
      this._activeBackendName = mode;
    } else {
      this._activeBackendName = 'cpu';
      debug('ComputeAccelerator', 'init', 'unknown backend ' + mode + ', falling back to cpu');
    }

    this._activeBackend = this._backends.get(this._activeBackendName) ?? null;
    debug('ComputeAccelerator', 'init', 'active backend: ' + this._activeBackendName);

    if (this._config.statsInterval > 0) {
      this._statsTimer = setInterval(() => {
        if (this._shutDown) return;
        try { this.emit('stats', this.getStats()); } catch (e) { debug('ComputeAccelerator', 'statsTimer', e.message); }
      }, this._config.statsInterval);
      if (this._statsTimer && typeof this._statsTimer.unref === 'function') this._statsTimer.unref();
    }
  }

  /**
   * 统一执行入口，根据operation类型路由到对应后端方法。
   * 支持的操作：cosineSimilarity、batchCosineSimilarity、matrixMultiply、
   * monteCarloSimulate、embed、attentionScore。
   *
   * @async
   * @param {string} operation - 操作类型名称
   * @param {Object} params - 操作参数对象，各操作所需参数不同
   * @returns {Promise<*>} 操作结果
   * @throws {Error} 未知操作类型时抛出
   */
  async execute(operation, params) {
    this.guardShutdown();
    const backend = this._selectBackend(operation);
    const backendName = this._getBackendName(backend);
    const start = Date.now();

    try {
      const method = backend[operation];
      if (typeof method !== 'function') {
        throw new Error('Unknown operation: ' + (operation ?? 'undefined'));
      }

      const result = await this._invokeBackendMethod(backend, operation, params);
      const elapsed = Date.now() - start;
      this._recordOperation(operation, backendName, elapsed);
      this.emit('operation-completed', { operation, backend: backendName, latencyMs: elapsed });
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      this._recordOperation(operation, backendName, elapsed);
      this.emit('operation-failed', { operation, backend: backendName, error: err });
      throw err;
    }
  }

  executeSync(operation, params) {
    this.guardShutdown();
    const backend = this._selectBackend(operation);
    const backendName = this._getBackendName(backend);
    const start = Date.now();
    try {
      const result = this._invokeBackendMethodSync(backend, operation, params);
      const elapsed = Date.now() - start;
      this._recordOperation(operation, backendName, elapsed);
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      this._recordOperation(operation, backendName, elapsed);
      throw err;
    }
  }

  /**
   * 在指定后端上执行操作。
   *
   * @async
   * @param {string} operation - 操作类型名称
   * @param {Object} params - 操作参数对象
   * @param {string} backendHint - 后端提示，可选 'cpu' 或 'gpu'
   * @returns {Promise<*>} 操作结果
   */
  async executeOnBackend(operation, params, backendHint) {
    this.guardShutdown();
    const backend = this._backends.get(backendHint) || this._activeBackend;
    const backendName = this._getBackendName(backend);
    const start = Date.now();

    try {
      const result = await this._invokeBackendMethod(backend, operation, params);
      if (this._shutDown) return result;
      const elapsed = Date.now() - start;
      this._recordOperation(operation, backendName, elapsed);
      this.emit('operation-completed', { operation, backend: backendName, latencyMs: elapsed });
      return result;
    } catch (err) {
      if (this._shutDown) throw err;
      const elapsed = Date.now() - start;
      this._recordOperation(operation, backendName, elapsed);
      this.emit('operation-failed', { operation, backend: backendName, error: err });
      throw err;
    }
  }

  /**
   * 返回当前活跃后端实例。
   * @returns {ComputeBackend|null} 当前活跃后端
   */
  getActiveBackend() {
    return this._activeBackend;
  }

  /**
   * 注册自定义后端，替换或新增指定名称的后端实例。
   * @param {string} name - 后端名称
   * @param {ComputeBackend} backend - 后端实例，必须继承ComputeBackend
   * @throws {Error} 名称或后端实例无效时抛出
   */
  registerBackend(name, backend) {
    this.guardShutdown();
    if (!name || typeof name !== 'string') {
      throw new Error('Backend name must be a non-empty string');
    }
    if (!backend || typeof backend !== 'object') {
      throw new Error('Backend must be an object');
    }

    if (this._backends.size >= this._maxBackends) {
      const oldestKey = this._backends.keys().next().value;
      this._backends.delete(oldestKey);
    }
    this._backends.set(name, backend);

    if (backend._initialized !== true) {
      debug('ComputeAccelerator', 'registerBackend', 'backend ' + name + ' not initialized, consider calling init()');
    }

    debug('ComputeAccelerator', 'registerBackend', 'registered backend: ' + name);
  }

  /**
   * 设置特性标志，支持运行时切换后端行为。
   * @param {Object} flags - 特性标志对象，如 { 'gpu-acceleration': false }
   */
  setFeatureFlags(flags) {
    this.guardShutdown();
    this._featureFlags = mergeConfig(this._featureFlags, flags);
    debug('ComputeAccelerator', 'setFeatureFlags', 'updated flags: ' + JSON.stringify(this._featureFlags));

    if (flags['gpu-acceleration'] === false && this._activeBackendName === 'gpu') {
      const previousName = this._activeBackendName;
      this._activeBackendName = 'cpu';
      this._activeBackend = this._backends.get('cpu');
      this._stats.backendSwitches++;
      this.emit('backend-switched', { from: previousName, to: 'cpu' });
      this.emit('gpu-fallback', { operation: '*', reason: 'gpu-acceleration disabled by feature flag' });
      debug('ComputeAccelerator', 'setFeatureFlags', 'switched to cpu due to gpu-acceleration=false');
    } else if (flags['gpu-acceleration'] === true && this._gpuAvailable && this._activeBackendName === 'cpu') {
      const previousName = this._activeBackendName;
      this._activeBackendName = 'gpu';
      this._activeBackend = this._backends.get('gpu') ?? null;
      this._stats.backendSwitches++;
      this.emit('backend-switched', { from: previousName, to: 'gpu' });
      debug('ComputeAccelerator', 'setFeatureFlags', 'switched to gpu due to gpu-acceleration=true');
    }
  }

  /**
   * 返回聚合统计信息，包含全局统计和各后端统计。
   * @returns {Object} 聚合统计信息对象
   */
  getStats() {
    const backendStats = {};
    for (const [name, backend] of this._backends) {
      backendStats[name] = backend.getStats();
    }

    return {
      activeBackend: this._activeBackendName,
      totalOperations: this._stats.totalOperations,
      totalLatencyMs: this._stats.totalLatencyMs,
      avgLatencyMs: this._stats.totalOperations > 0
        ? this._stats.totalLatencyMs / this._stats.totalOperations
        : 0,
      operationsByType: mergeConfig({}, this._stats.operationsByType),
      backendSwitches: this._stats.backendSwitches,
      featureFlags: mergeConfig({}, this._featureFlags),
      backends: backendStats,
    };
  }

  /**
   * 根据操作类型和当前状态选择最优后端。
   * - 如果featureFlags中gpu-acceleration为false，强制CPU
   * - 如果操作在GPU优先列表中且GPU可用，选GPU
   * - 其他操作默认CPU
   * - auto模式首次执行时检测GPU可用性并缓存
   *
   * @param {string} operation - 操作类型名称
   * @returns {ComputeBackend} 选中的后端实例
   * @protected
   */
  _selectBackend(operation) {
    if (this._featureFlags['gpu-acceleration'] === false) {
      return this._backends.get('cpu');
    }

    const gpuPriorityOps = this._config.gpuPriorityOps;
    const isGpuPriority = Array.isArray(gpuPriorityOps) && gpuPriorityOps.includes(operation);

    if (isGpuPriority) {
      const gpuBackend = this._backends.get('gpu');
      if (gpuBackend && gpuBackend.isAvailable()) {
        if (this._gpuAvailable === null) {
          this._gpuAvailable = true;
        }
        return gpuBackend;
      }

      if (this._activeBackendName === 'gpu') {
        this.emit('gpu-fallback', { operation, reason: 'GPU backend not available for operation' });
      }
    }

    return this._activeBackend;
  }

  /**
   * 根据后端实例查找其注册名称。
   * @param {ComputeBackend} backend - 后端实例
   * @returns {string} 后端名称
   * @private
   */
  _getBackendName(backend) {
    for (const [name, b] of this._backends) {
      if (b === backend) return name;
    }
    return 'unknown';
  }

  /**
   * 调用后端方法，根据操作类型映射参数。
   * @param {ComputeBackend} backend - 后端实例
   * @param {string} operation - 操作类型名称
   * @param {Object} params - 操作参数对象
   * @returns {Promise<*>} 操作结果
   * @private
   */
  async _invokeBackendMethod(backend, operation, params) {
    switch (operation) {
      case 'cosineSimilarity':
        return backend.cosineSimilarity(params.vecA, params.vecB);
      case 'batchCosineSimilarity':
        return backend.batchCosineSimilarity(params.queryVec, params.vectors);
      case 'matrixMultiply':
        return backend.matrixMultiply(params.a, params.b, params.dims);
      case 'monteCarloSimulate':
        return backend.monteCarloSimulate(params.config);
      case 'embed':
        return backend.embed(params.text, params.dimensions);
      case 'attentionScore':
        return backend.attentionScore(params.query, params.key, params.position, params.total);
      default: {
        const method = backend[operation];
        if (typeof method === 'function') {
          return method.call(backend, params);
        }
        throw new Error('Unknown operation: ' + (operation ?? 'undefined'));
      }
    }
  }

  _invokeBackendMethodSync(backend, operation, params) {
    switch (operation) {
      case 'cosineSimilarity':
        return this._syncCosineSimilarity(params.vecA, params.vecB);
      case 'attentionScore':
        return this._syncAttentionScore(params.query, params.key, params.position, params.total);
      default: {
        const method = backend[operation];
        if (typeof method === 'function') {
          const result = method.call(backend, params);
          if (result && typeof result.then === 'function') {
            debug('ComputeAccelerator', 'executeSync-async-fallback', operation);
            return null;
          }
          return result;
        }
        throw new Error('Unknown operation: ' + (operation ?? 'undefined'));
      }
    }
  }

  _syncCosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (!Number.isFinite(denominator) || denominator === 0) return 0;
    return dotProduct / denominator;
  }

  _syncAttentionScore(query, key, position, total) {
    if (!query || typeof query !== 'object') return 0;
    const totalPositions = typeof total === 'number' && Number.isFinite(total) && total > 0 ? total : 1;
    const pos = typeof position === 'number' && Number.isFinite(position) && position >= 0 ? position : 0;
    const importance = typeof query.importance === 'number' && Number.isFinite(query.importance) ? query.importance : 0;
    const recency = typeof query.recency === 'number' && Number.isFinite(query.recency) ? query.recency : 0;
    const positionalWeight = totalPositions === 1 ? 1.0 : Math.sin(Math.PI * pos / totalPositions);
    const attentionWeight = positionalWeight * importance * recency;
    const result = Math.max(0, Math.min(1, attentionWeight));
    return Number.isFinite(result) ? result : 0;
  }

  /**
   * 记录操作统计信息。
   * @param {string} operation - 操作类型名称
   * @param {string} backendName - 后端名称
   * @param {number} elapsedMs - 操作耗时（毫秒）
   * @private
   */
  _recordOperation(operation, backendName, elapsedMs) {
    this._stats.totalOperations++;
    this._stats.totalLatencyMs += elapsedMs;

    if (!this._stats.operationsByType[operation]) {
      if (Object.keys(this._stats.operationsByType).length >= MAX_OPERATION_TYPES) return;
      this._stats.operationsByType[operation] = { count: 0, totalLatencyMs: 0, backends: {} };
    }
    const opStats = this._stats.operationsByType[operation];
    opStats.count++;
    opStats.totalLatencyMs += elapsedMs;

    if (!opStats.backends[backendName]) {
      opStats.backends[backendName] = 0;
    }
    opStats.backends[backendName]++;
  }

  /**
   * 优雅关闭回调，由withShutdown混入在进程关闭时自动调用。
   * @private
   */
  _onShutdown() {
    const shutdownPromises = [];
    for (const [name, backend] of this._backends) {
      try {
        if (typeof backend.shutdown === 'function') {
          const result = backend.shutdown();
          if (result && typeof result.then === 'function') {
            shutdownPromises.push(result.catch(function(err) {
              debug('ComputeAccelerator', '_onShutdown', 'backend ' + name + ' error: ' + (err && err.message ? err.message : String(err)));
            }));
          }
        }
      } catch (err) {
        debug('ComputeAccelerator', '_onShutdown', 'backend ' + name + ' error: ' + (err && err.message ? err.message : String(err)));
      }
    }
    this._backends.clear();
    this._activeBackend = null;
    this._activeBackendName = null;
    this._gpuAvailable = null;
    this._initPromise = null;
    this._stats = { totalOperations: 0, totalLatencyMs: 0, operationsByType: {}, backendSwitches: 0 };
    this._featureFlags = {};
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
    this.removeAllListeners();
    debug('ComputeAccelerator', '_onShutdown', 'cleaned up');
    if (shutdownPromises.length > 0) {
      return Promise.allSettled(shutdownPromises).then(function(results) {
        for (const r of results) {
          if (r.status === 'rejected') debug('ComputeAccelerator', 'shutdownError', r.reason && r.reason.message ? r.reason.message : String(r.reason));
        }
      });
    }
  }
}

/**
 * 默认配置的静态引用，便于外部通过类名访问。
 * @static
 * @type {Object}
 */
ComputeAccelerator.DEFAULT_CONFIG = DEFAULT_CONFIG;

/**
 * ComputeBackend基类的静态引用，便于外部继承扩展。
 * @static
 * @type {Function}
 */
ComputeAccelerator.ComputeBackend = ComputeBackend;

/**
 * CpuBackend的静态引用，便于外部直接使用。
 * @static
 * @type {Function}
 */
ComputeAccelerator.CpuBackend = CpuBackend;

/**
 * GpuBackend的静态引用，便于外部直接使用。
 * @static
 * @type {Function}
 */
ComputeAccelerator.GpuBackend = GpuBackend;

module.exports = withShutdown(ComputeAccelerator);
