/**
 * @module utils
 * @description 工具模块统一入口，汇聚所有工具子模块的导出。
 * 提供数据结构、安全执行、文件操作、缓存、国际化、日志等通用工具能力。
 * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除
 */

'use strict';

const BoundedArray = require('./bounded-array');
const BoundedMap = require('./bounded-map');
const capacityConfig = require('./capacity-config');
const configValidator = require('./config-validator');
const constants = require('./constants');
const DebouncedPersister = require('./debounced-persister');
const { createPersister } = DebouncedPersister;
const debugLogger = require('./debug-logger');
const deepClone = require('./deep-clone');
const fsUtils = require('./fs-utils');
const i18n = require('./i18n');
const KeyedDebouncer = require('./keyed-debouncer');
const LRUCache = require('./lru-cache');
const JsonStoreRestorer = require('./json-store-restorer');
const MinHeap = require('./min-heap');
const networkUtils = require('./network-utils');
const ParamValidator = require('./param-validator');
const pathUtils = require('./path-utils');
const RingBuffer = require('./ring-buffer');
const safeAssign = require('./safe-assign');
const { mergeConfig, validateConfigSchema } = safeAssign;
const safeExecute = require('./safe-execute');
const safeParse = require('./safe-parse');
const { safeJsonParse } = safeParse;
const sanitizer = require('./sanitizer');
const stableStringify = require('./stable-stringify');
const stateCompare = require('./state-compare');
const StructuredLogger = require('./structured-logger');
const shutdownMixin = require('./shutdown-mixin');
const TTLCache = require('./ttl-cache');
const uniqueId = require('./unique-id');

module.exports = {
  BoundedArray,
  BoundedMap,
  CapacityConfig: capacityConfig,
  ConfigValidator: configValidator,
  Constants: constants,
  DebouncedPersister,
  createPersister,
  debug: debugLogger,
  deepClone,
  FsUtils: fsUtils,
  i18n,
  KeyedDebouncer,
  JsonStoreRestorer,
  LRUCache,
  MinHeap,
  NetworkUtils: networkUtils,
  ParamValidator,
  PathUtils: pathUtils,
  RingBuffer,
  safeAssign,
  mergeConfig,
  validateConfigSchema,
  safeExecute,
  safeParse,
  safeJsonParse,
  Sanitizer: sanitizer,
  stableStringify,
  StateCompare: stateCompare,
  StructuredLogger,
  ShutdownMixin: shutdownMixin,
  TTLCache,
  UniqueId: uniqueId,
};
