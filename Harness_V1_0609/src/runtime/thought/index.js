'use strict';

/**
 * @module runtime/thought/index
 * Thought subsystem exports — Memory, dream, knowledge, and provider modules
 * @deprecated 孤立模块 - 未被任何文件引用，计划在下一版本移除
 */

module.exports = {
  BrainMemory: require('./brain-memory'),
  DreamBridge: require('./dream-bridge'),
  DreamEngine: require('./dream-engine'),
  DreamOutcomes: require('./dream-outcomes'),
  DreamPhasePipeline: require('./dream-phase-pipeline'),
  DreamScheduler: require('./dream-scheduler'),
  LlmWiki: require('./llm-wiki'),
  MemoryNudge: require('./memory-nudge'),
  MemoryPipeline: require('./memory-pipeline'),
  MemoryPrefetcher: require('./memory-prefetcher'),
  MemoryStore: require('./memory-store'),
  MemorySyncCoordinator: require('./memory-sync-coordinator'),
  ThoughtDeduplicator: require('./thought-deduplicator'),
  ThoughtDiamond: require('./thought-diamond'),
  ThoughtExtractor: require('./thought-extractor'),
  ThoughtMemoryStore: require('./thought-memory-store'),
  ThoughtRetrieverCycle: require('./thought-retriever-cycle'),
  UnifiedMemoryRecaller: require('./unified-memory-recaller'),
  Provider: require('./provider'),
};
