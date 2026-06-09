'use strict';

const fs = require('fs');
const path = require('path');

let apiDoc;
try {
  apiDoc = fs.readFileSync(path.join(__dirname, '..', 'docs/tools/接口文档-Web API.md'), 'utf8');
} catch (readErr) {
  console.error('Failed to read API doc: ' + readErr.message);
  process.exit(1);
}
const docEndpoints = [];
const re = /^###\s+(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)/gm;
let m;
while ((m = re.exec(apiDoc)) !== null) {
  docEndpoints.push(m[2].split('?')[0].replace(/\/\{[^}]+\}/g, ''));
}

const { buildAllRoutes } = require(path.join(__dirname, '..', 'src/web/dashboard/routes'));
const CACHE_TTL = { overview: 30000, agents: 30000, skills: 30000, sessions: 30000, workflow: 30000, config: 60000, changelog: 60000, audit: 60000 };

class MockServer {
  _getCached(k, t, fn) { return fn(); }
}

const methodNames = [
  '_getOverview', '_getAgents', '_getSkills', '_getSessions', '_getWorkflow',
  '_getConfig', '_getChangelog', '_getAudit', '_getMemory', '_getWorkflowTemplates',
  '_getCompliance', '_getHealth', '_getLiveness', '_getReadiness', '_getVersion',
  '_getFrameworkStatus', '_getFrameworkArchitecture', '_getFrameworkFeatures',
  '_getPanoramaMetadata', '_getPerformanceStats', '_getCheckpoints', '_getLearnings',
  '_getDeviations', '_getCodeReviews', '_getAgentLifecycleList', '_getAgentRuntimeStats',
  '_getAgentResourcePool', '_getAgentMonitorDashboard', '_getAgentDeploymentEnvironments',
  '_getAgentStateList', '_getAgentWorkflowStats', '_getAgentSandboxList',
  '_getAgentPacksList', '_getAgentPacksInstalled', '_getAgentPacksStats',
  '_getSubagentStats', '_getSubagentActive', '_getSubagentBudgetReport', '_getSubagentModelStats',
  '_getDeepeningStats', '_getQualityStats', '_getTokenBudgetStats', '_getAffinityStats',
  '_getDeepeningDashboard', '_getDeepeningMetrics', '_getDeepeningCacheStats',
  '_getDeepeningConvergence', '_getDeepeningReport', '_getDeepeningPipeline',
  '_getDeepeningHealth', '_getDeepeningEvents', '_getDeepeningTemplates',
  '_getDeepeningBenchmarkStats', '_getDeepeningStateMachine', '_getDeepeningErrors',
  '_getDeepeningSnapshots', '_getDeepeningNotifications', '_getDeepeningCircuitBreaker',
  '_getDeepeningTaskQueue', '_getDeepeningResources', '_getDeepeningAudit',
  '_getDeepeningConfig', '_getDeepeningHealthMonitor', '_getDeepeningDependencies',
  '_getDeepeningThrottle', '_getDeepeningValidator', '_getDeepeningLocks',
  '_getDeepeningEventReplay', '_getDeepeningPriorityQueue', '_getDeepeningMetricsAggregator',
  '_getDeepeningRateLimiter', '_getDeepeningSnapshotStore', '_getDeepeningBackpressure',
  '_getDeepeningConnectionPool', '_getDeepeningRetryPolicy', '_getDeepeningServiceRegistry',
  '_getDeepeningLoadBalancer', '_getDeepeningTimeoutManager', '_getDeepeningGracefulShutdown',
  '_getDeepeningFeatureFlags', '_getDeepeningTaskScheduler', '_getDeepeningDataPipeline',
  '_getDeepeningStateManager', '_getDeepeningEventBus', '_getDeepeningConfigManager',
  '_getDeepeningResourceManager', '_getDeepeningAuditTrail', '_getDeepeningRegistryStats',
  '_getSkillLayerStats', '_getSkillDedupReport', '_getSkillContextEstimate',
  '_getSkillImprovementPending', '_getSkillImprovementStats', '_getSkillCreationList',
  '_getSkillCreationStats', '_getSkillCuratorStats', '_getNudgeStats',
  '_getDocFreshnessStats', '_getDocFreshnessStale', '_getDocFreshnessIndex',
  '_validateDocFreshness', '_getAntipatternRules', '_getCollaborationModes',
  '_getCollaborationStats', '_getCollaborationHistory', '_getChannelStats',
  '_getPairChatStats', '_getPairChatSessions', '_getChatChainStats',
  '_getChatChainChains', '_getOutputFusionStats', '_getIntentStats', '_getIntentSchemas',
  '_getSqliteStats', '_getSqliteFts', '_getMemoryEntries', '_getMemoryUsage',
  '_getMemoryVerification', '_getStaleMemories', '_getAffinityLearnerStats',
  '_getAffinityRecords', '_getThoughtsStats', '_getThoughtsList', '_getEmbeddingStats',
  '_getThoughtRetrieverStats', '_getModelSelectorStats', '_getMcpStatus', '_getMcpTools',
  '_getCommandRouterStats', '_getCommandRouterCommands', '_getProgrammableHookStats',
  '_getProgrammableHooks', '_getHookMonitorData', '_getSlowHooks', '_getHookSuccessRates',
  '_getContextCompressionStats', '_getContextCompressionStrategies',
  '_getAutoVersionStats', '_getAutoVersionRecent', '_getPreviousSessionContext',
  '_getGeneratorVerifierStats', '_getGeneratorVerifierHistory',
  '_getIsolatedContextStats', '_getIsolatedContextActive', '_getPlanStats',
  '_getPlanActive', '_getUserProfile', '_getDesignStats',
];
methodNames.forEach(name => {
  MockServer.prototype[name] = function() { return name.includes('Framework') ? Promise.resolve({}) : {}; };
});
MockServer.prototype._rt = function() { return null; };
MockServer.prototype._approvalGate = {
  getPending: () => [], getPendingCount: () => 0, getHistory: () => [], getStats: () => ({}),
};

const routes = Object.keys(buildAllRoutes(new MockServer(), CACHE_TTL));

const POST_ROUTES = [
  '/api/design/audit', '/api/design/presets', '/api/design/companies',
  '/api/design/generate-md', '/api/design/contrast-check', '/api/design/accessibility-audit',
  '/api/design/generate-css', '/api/design/section/tokens', '/api/design/section/css',
  '/api/design/section/variants', '/api/design/section/validate', '/api/design/section/presets',
  '/api/skill-improvement/apply', '/api/skill-improvement/reject', '/api/skill-improvement/record',
  '/api/skill-creation/create', '/api/nudge/evaluate',
  '/api/sqlite/knowledge', '/api/memory/add', '/api/memory/remove',
  '/api/goal/create', '/api/goal/pause', '/api/goal/resume', '/api/goal/cancel', '/api/goal/progress',
  '/api/mcp/connect', '/api/mcp/call-tool',
  '/api/affinity/record', '/api/affinity/recommendations',
  '/api/antipattern/detect',
];

const allCodeRoutes = [...routes, ...POST_ROUTES];

console.log('Code routes: ' + allCodeRoutes.length + ' (GET: ' + routes.length + ', POST: ' + POST_ROUTES.length + ')');
console.log('Doc endpoints: ' + docEndpoints.length);

const inCodeNotDoc = allCodeRoutes.filter(r => !docEndpoints.includes(r));
const inDocNotCode = docEndpoints.filter(r => !allCodeRoutes.includes(r));

console.log('\nIn code but not in doc (' + inCodeNotDoc.length + '):');
inCodeNotDoc.forEach(r => console.log('  + ' + r));

console.log('\nIn doc but not in code (' + inDocNotCode.length + '):');
inDocNotCode.forEach(r => console.log('  - ' + r));

if (inCodeNotDoc.length === 0 && inDocNotCode.length === 0) {
  console.log('\nAPI documentation is fully synchronized with code!');
}
