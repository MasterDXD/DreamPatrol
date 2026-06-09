/**
 * Harness Engineering 多Agent框架 - TypeScript 类型定义
 * 
 * 稳定性标记：
 * @stable - 核心API，保证向后兼容（create, SkillRouter, SessionManager, TDDGate, RBACEnforcer, EventBus 等）
 * @experimental - 实验性API，可能变更（MoeGatingRouter, DeepeningOrchestrator, EnsembleOrchestrator 等）
 * @module harness-engineering
 */

export type Enforcement = 'strict' | 'recommended' | 'optional';

export interface SkillDef {
  skill_id: string;
  name: string;
  applicable_agents: string[];
  trigger: string;
  auto_trigger: boolean;
  phase: string;
  priority: number;
  trigger_conditions: string[];
  depends_on: string[];
  blocks: string[];
  enforcement: Enforcement;
  infrastructure: boolean;
}

export interface MatchContext {
  userMessage: string;
  agent: string;
  completedSkills?: string[];
}

export declare class SkillRouter {
  constructor(projectRoot: string);
  skills: SkillDef[];
  registry: Record<string, SkillDef>;
  discover(): SkillDef[];
  match(context: MatchContext): SkillDef[];
  resolveConflict(matches: SkillDef[]): SkillDef | null;
  checkDependencies(skillId: string, completedSkills: string[]): { satisfied: boolean; missing: string[] };
  getSkill(skillId: string): SkillDef | null;
}

export interface Session {
  id: string;
  currentPhase: string;
  completedSkills: string[];
  tokensUsed: number;
  status: 'active' | 'completed' | 'expired';
  createdAt: string;
  lastActivityAt: string;
  agentHistory: AgentAction[];
}

export interface AgentAction {
  agent: string;
  action: string;
  timestamp: string;
}

export interface BudgetStatus {
  warning80: boolean;
  warning95: boolean;
  exhausted: boolean;
  ratio: number;
}

export declare class SessionManager {
  constructor(projectRoot: string);
  sessions: Record<string, Session>;
  create(sessionId?: string): Session;
  get(sessionId: string): Session | null;
  advancePhase(sessionId: string, newPhase: string): Session;
  completeSkill(sessionId: string, skillId: string): Session;
  addTokenUsage(sessionId: string, tokens: number): void;
  checkBudget(sessionId: string): BudgetStatus;
  flush(): void;
  static generateSessionId(): string;
  static VALID_PHASES: string[];
  static SESSION_ID_PATTERN: RegExp;
  static MAX_SESSIONS: number;
  static SESSION_TTL_MS: number;
  static DEBOUNCE_MS: number;
}

export declare class PhaseOrchestrator {
  getPhases(): string[];
  canTransition(from: string, to: string): boolean;
  isForwardTransition(from: string, to: string): boolean;
  isBackwardTransition(from: string, to: string): boolean;
  validateRollback(from: string, to: string, completedSkills: string[]): { allowed: boolean; requiresApproval?: boolean; phasesToRollback?: string[]; skillsToInvalidate?: string[]; reason?: string };
  getRequiredSkills(phase: string): string[];
  isPhaseComplete(phase: string, completedSkills: string[], strictSkillIds?: string[]): boolean;
  getNextPhase(currentPhase: string): string | null;
  getPhaseIndex(phase: string): number;
  attachCausalDataBus(bus: CausalDataBus): PhaseOrchestrator;
  static PHASES: string[];
  static PHASE_SKILLS: Record<string, string[]>;
}

export interface AgentPermissions {
  role: string;
  skills: string[];
  auto_route: boolean;
  tdd_enforced: boolean;
  collaborates_with: string[];
  manages: string[];
}

export interface SkillEnforcementDef {
  skill_id: string;
  enforcement: Enforcement;
  depends_on: string[];
  applicable_agents: string[];
  phase: string;
  priority: number;
}

export declare class RBACEnforcer {
  constructor(projectRoot: string);
  agents: Record<string, AgentPermissions>;
  skills: Record<string, SkillEnforcementDef>;
  load(): void;
  canExecute(agentId: string, skillId: string): boolean;
  startWatching(): void;
  stopWatching(): void;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation?: boolean;
}

export declare class PermissionGuard {
  constructor(projectRoot: string);
  checkFileWrite(filePath: string, agentId: string): PermissionResult;
  checkFileDelete(filePath: string, agentId: string): PermissionResult;
  checkFileRead(filePath: string, agentId: string): PermissionResult;
  acquireLock(filePath: string, agentId: string): boolean;
  releaseLock(filePath: string, agentId: string): boolean;
  getLockHolder(filePath: string): string | null;
  checkCommand(command: string, agentId: string): PermissionResult;
  enforceFileWrite(filePath: string, agentId: string): true;
  enforceCommand(command: string, agentId: string): true;
  setConfirmationExpiry(ms: number): PermissionGuard;
  recordConfirmation(agentId: string, action: string, target: string): boolean;
  isConfirmationValid(agentId: string, action: string, target: string): boolean;
  static validateSessionId(sessionId: string): boolean;
  static SESSION_ID_PATTERN: RegExp;
}

export interface AuditLogEntry {
  timestamp: string;
  agent: string;
  action: string;
  target: string;
  result: string;
  reason: string;
  details: string;
}

export interface AuditStats {
  total: number;
  allowed: number;
  denied: number;
  byAgent: Record<string, number>;
}

export declare class AuditLogger {
  constructor(projectRoot?: string, options?: { maxEntries?: number });
  entries: AuditLogEntry[];
  log(event: Partial<AuditLogEntry>): void;
  query(filter: Partial<Pick<AuditLogEntry, 'agent' | 'action' | 'result' | 'target'>>): AuditLogEntry[];
  getRecent(count?: number): AuditLogEntry[];
  getStats(): AuditStats;
  clear(): void;
  export(): string;
  static MAX_LOG_ENTRIES: number;
}

export interface TDDCheckResult {
  passed: boolean;
  reason: string;
  phase: 'RED' | 'GREEN' | 'REFACTOR' | 'VIOLATION' | 'EMPTY' | 'UNKNOWN';
}

export interface TDDCoverageResult {
  passed: boolean;
  reason?: string;
  coverage: number;
  threshold: number;
}

export declare class TDDGate {
  constructor();
  check(context: {
    implFile: string;
    testFile: string;
    testExists: boolean;
    implExists: boolean;
    testResult?: 'pass' | 'fail';
  }): TDDCheckResult;
  checkCoverage(context: { coverage: number; threshold?: number }): TDDCoverageResult;
  enforceCheck(context: {
    implFile: string;
    testFile: string;
    testExists: boolean;
    implExists: boolean;
    testResult?: 'pass' | 'fail';
  }): TDDCheckResult;
  enforceCoverage(context: { coverage: number; threshold?: number }): TDDCoverageResult;
  isHealthy(): boolean;
  shutdown(): void;
}

export interface EvidenceItem {
  type: string;
  content: string;
}

export interface VerifyResult {
  verified: boolean;
  missing: string[];
  report: string;
  evidenceCount: number;
  requiredCount: number;
}

export declare class EvidenceVerifier {
  constructor(options?: { verificationThreshold?: number; typeScoreWeight?: number; qualityScoreWeight?: number; evidenceRequirements?: Record<string, string[]> });
  verify(context: {
    claim: string;
    evidence: EvidenceItem[];
    requiredTypes?: string[];
  }): VerifyResult;
  getRequiredEvidenceTypes(skillId: string): string[];
  setEvidenceRequirements(requirements: Record<string, string[]>): void;
  setVerificationThreshold(threshold: number): void;
  static EVIDENCE_REQUIREMENTS: Record<string, string[]>;
}

export interface ComplianceViolation {
  ruleId: string;
  level: 'error' | 'warn' | 'info';
  description: string;
  file: string;
  message: string;
  timestamp: string;
}

export interface ComplianceSummary {
  total: number;
  errors: number;
  warnings: number;
  infos: number;
  errorFiles: string[];
  warningFiles: string[];
  compliant: boolean;
}

export declare class FrameworkComplianceChecker {
  constructor(projectRoot: string, options?: { exemptions?: Record<string, string[]> });
  checkFile(filePath: string): ComplianceViolation[];
  checkDirectory(dirPath: string): ComplianceViolation[];
  checkProject(): ComplianceViolation[];
  checkNamingConvention(type: 'file' | 'class' | 'method' | 'constant' | 'event' | 'error-code', name: string): boolean;
  checkDependency(moduleName: string): boolean;
  getResults(): ComplianceViolation[];
  getSummary(): ComplianceSummary;
  addExemption(ruleId: string, filePath: string): void;
  removeExemption(ruleId: string, filePath: string): void;
  getExemptions(): Record<string, string[]>;
  static RULE_LEVELS: { ERROR: string; WARN: string; INFO: string };
  static NAMING_RULES: Record<string, { id: string; level: string; description: string }>;
  static STRUCTURE_RULES: Record<string, { id: string; level: string; description: string }>;
  static SECURITY_RULES: Record<string, { id: string; level: string; description: string }>;
  static PERSISTENCE_RULES: Record<string, { id: string; level: string; description: string }>;
  static API_RULES: Record<string, { id: string; level: string; description: string }>;
  static ERROR_RULES: Record<string, { id: string; level: string; description: string }>;
  static APPROVED_SRC_DIRS: string[];
}

export interface DeviationData {
  id: string;
  ruleId: string;
  file: string;
  reason: string;
  proposedAlternative: string;
  severity: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
}

export declare class DeviationApproval {
  constructor(projectRoot: string, options?: { maxDeviations?: number; defaultTtlDays?: number });
  request(data: { ruleId: string; file: string; reason: string; proposedAlternative?: string; severity?: string; requestedBy?: string; ttlDays?: number }): DeviationData;
  approve(deviationId: string, reviewer: string, comment?: string): DeviationData | null;
  reject(deviationId: string, reviewer: string, comment?: string): DeviationData | null;
  revoke(deviationId: string, revoker: string, reason?: string): DeviationData | null;
  isApproved(ruleId: string, filePath: string): boolean;
  getPending(): DeviationData[];
  getApproved(): DeviationData[];
  getRejected(): DeviationData[];
  getByRule(ruleId: string): DeviationData[];
  getByFile(filePath: string): DeviationData[];
  getStats(): { total: number; byStatus: Record<string, number>; bySeverity: Record<string, number> };
  flush(): void;
  static DEVIATION_STATUS: Record<string, string>;
  static DEVIATION_SEVERITY: Record<string, string>;
}

export interface ReviewChecklistItem {
  category: string;
  ruleId: string;
  description: string;
  severity: string;
  auto: boolean;
}

export interface ReviewFinding {
  category: string;
  ruleId: string;
  severity: string;
  violations: Array<{ file: string; message: string }>;
  passed: boolean;
}

export interface ReviewData {
  id: string;
  targetFiles: string[];
  reviewer: string;
  author: string;
  description: string;
  status: 'pending' | 'in_progress' | 'approved' | 'rejected' | 'needs_changes';
  createdAt: string;
  updatedAt: string;
  checklist: ReviewChecklistItem[];
  findings: ReviewFinding[];
  verdict: 'pass' | 'pass-with-warnings' | 'fail' | null;
}

export declare class CodeReviewFrameworkCheck {
  constructor(projectRoot: string, options?: { maxReviews?: number });
  createReview(data: { targetFiles: string[]; reviewer?: string; author?: string; description?: string }): ReviewData;
  runChecklist(reviewId: string): ReviewData | null;
  approveReview(reviewId: string, approver: string, comment?: string): ReviewData | null;
  requestChanges(reviewId: string, requester: string, comment?: string): ReviewData | null;
  rejectReview(reviewId: string, rejecter: string, comment?: string): ReviewData | null;
  getReview(reviewId: string): ReviewData | null;
  getReviewsByStatus(status: string): ReviewData[];
  getReviewsByAuthor(author: string): ReviewData[];
  getStats(): { total: number; byStatus: Record<string, number>; byVerdict: Record<string, number> };
  flush(): void;
  static REVIEW_STATUS: Record<string, string>;
  static REVIEW_CATEGORIES: Record<string, string>;
}

export interface DesignAuditIssue {
  ruleId: string;
  severity: 'high' | 'medium' | 'low';
  count: number;
  message: string;
  fix: string;
  matches: string[];
}

export interface DesignAuditResult {
  score: number;
  issues: DesignAuditIssue[];
  summary: string;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface DesignCritiqueFeedback {
  area: string;
  severity: string;
  issues: number;
  recommendation: string;
}

export interface DesignCritiqueResult {
  overallScore: number;
  grade: string;
  feedback: DesignCritiqueFeedback[];
  summary: string;
}

export interface CompanyDesignLanguage {
  name: string;
  style: string;
  colors: { primary: string; bg: string; surface: string; text: string };
  borderRadius: string;
  spacing: string;
  motion: string;
  suitable: string;
}

export declare class DesignSkillEngine {
  constructor(projectRoot: string);
  audit(source: string, type?: string): DesignAuditResult;
  polish(source: string): string;
  getTypographyScale(): Record<string, { size: string; lineHeight: string; weight: number; tracking: string }>;
  getSpacingScale(): Record<string, string>;
  getColorSystem(name?: string): Record<string, Record<string, string>> | Record<string, string> | null;
  getMotionPreset(name?: string): Record<string, { duration: number; easing: string }> | { duration: number; easing: string } | null;
  getDesignVariance(level?: string): Record<string, { variance: string; description: string }> | { variance: string; description: string } | null;
  getCompanyDesignLanguage(company?: string | null): Record<string, CompanyDesignLanguage> | CompanyDesignLanguage | null;
  getIconCollections(): string[];
  generateDesignMd(options?: { company?: string; variance?: string; motionIntensity?: number }): string;
  critique(source: string, focusArea?: string): DesignCritiqueResult;
  normalize(source: string): string;
  generateMotionCSS(preset?: string): string;
  searchIcons(query: string, collection?: string): Array<{ collection: string; query: string; status: string; usage: string }>;
  getStats(): { antiPatternRules: number; typographyLevels: number; spacingTokens: number; colorSystems: number; motionPresets: number; varianceLevels: number; iconCollections: number; companyDesignLanguages: number };
  static ANTI_PATTERNS: Record<string, { id: string; severity: string; pattern: RegExp; message: string; fix: string }>;
  static TYPOGRAPHY_SCALE: Record<string, { size: string; lineHeight: string; weight: number; tracking: string }>;
  static SPACING_SCALE: Record<string, string>;
  static COLOR_SYSTEMS: Record<string, Record<string, string>>;
  static MOTION_PRESETS: Record<string, { duration: number; easing: string }>;
  static DESIGN_VARIANCE_LEVELS: Record<string, { variance: string; description: string }>;
  static ICON_COLLECTIONS: string[];
  static COMPANY_DESIGN_LANGUAGES: Record<string, CompanyDesignLanguage>;
}

export declare class HarnessError extends Error {
  code: string;
  context?: object;
  constructor(code: string, message: string, context?: object);
}

export declare class SessionError extends HarnessError {
  constructor(code: string, message: string, context?: object);
}

export declare class PermissionError extends HarnessError {
  constructor(code: string, message: string, context?: object);
}

export declare class TDDGateError extends HarnessError {
  constructor(code: string, message: string, context?: object);
}

export interface KnowledgeEntry {
  id: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummary {
  sessionId: string;
  phase: string;
  completedSkills: string[];
  keyDecisions: string[];
  lessonsLearned: string[];
  artifacts: string[];
  tokensUsed: number;
  summarizedAt: string;
}

export declare class MemoryStore {
  constructor(projectRoot: string);
  addKnowledge(entry: { category: string; content: string; title?: string; tags?: string[]; source?: string }): KnowledgeEntry | null;
  queryKnowledge(filter: { category?: string; tag?: string; query?: string; source?: string }): KnowledgeEntry[];
  getKnowledge(id: string): KnowledgeEntry | null;
  updateKnowledge(id: string, updates: { content?: string; title?: string; tags?: string[] }): KnowledgeEntry | null;
  removeKnowledge(id: string): boolean;
  saveSessionSummary(sessionId: string, summary: Partial<SessionSummary>): SessionSummary | null;
  getSessionSummary(sessionId: string): SessionSummary | null;
  querySummaries(filter: { phase?: string; skill?: string; query?: string }): SessionSummary[];
  getStats(): { knowledgeCount: number; summaryCount: number; categories: Record<string, number> };
  static MAX_KNOWLEDGE_ENTRIES: number;
  static MAX_SESSION_SUMMARIES: number;
}

export interface AgentResult {
  agentId: string;
  skillId: string;
  result: unknown;
  timestamp: string;
}

export declare class AgentChannel {
  publishResult(agentId: string, skillId: string, result: unknown): AgentResult;
  getResult(agentId: string, skillId: string): AgentResult | null;
  getResultsBySkill(skillId: string): AgentResult[];
  getResultsByAgent(agentId: string): AgentResult[];
  getUpstreamResults(skillId: string, dependsOn: string[]): AgentResult[];
  setShared(key: string, value: unknown, agentId: string): void;
  getShared(key: string): unknown;
  getSharedKeys(): string[];
  removeShared(key: string): boolean;
  broadcast(agentId: string, message: unknown): void;
  getStats(): { resultCount: number; sharedKeyCount: number };
  clear(): void;
}

export interface DAGNode {
  id: string;
  phase: string;
  agent: string;
  skill: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export declare class WorkflowDAG {
  addNode(id: string, config: { phase?: string; agent?: string; skill?: string; deepening?: unknown }): boolean;
  addEdge(from: string, to: string): boolean;
  removeEdge(from: string, to: string): boolean;
  getReadyNodes(): { ready: DAGNode[]; dependencyFailed: string[] };
  markDependencyFailed(nodeIds: string[]): string[];
  startNode(id: string): boolean;
  completeNode(id: string, result?: unknown): boolean;
  failNode(id: string, error?: string): boolean;
  isComplete(): boolean;
  hasFailures(): boolean;
  getFailedNodes(): DAGNode[];
  topologicalSort(): string[] | null;
  getNode(id: string): DAGNode | null;
  getAllNodes(): DAGNode[];
  getEdges(): Array<{ from: string; to: string }>;
  getStats(): { total: number; pending: number; running: number; completed: number; failed: number };
  addDeepeningNode(parentId: string, deepeningConfig?: Record<string, unknown>): string | null;
  getDeepeningNodes(parentId?: string): DAGNode[];
  getDeepeningChain(parentId: string): DAGNode[];
  getDeepeningStats(): { totalDeepeningNodes: number; totalDeepenedTasks: number; totalIterations: number; avgIterationsPerTask: number };
  shutdown(): void;
  isHealthy(): boolean;
  static fromWorkflowDef(definition: { steps: Array<{ id: string; phase?: string; agent?: string; skill?: string; needs?: string[] }> }): WorkflowDAG;
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  phase: string;
  completedSkills: string[];
  tokensUsed: number;
  agentHistory: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export declare class CheckpointManager {
  constructor(projectRoot: string);
  create(sessionId: string, data: { phase?: string; completedSkills?: string[]; tokensUsed?: number; agentHistory?: Array<Record<string, unknown>>; metadata?: Record<string, unknown> }): Checkpoint | null;
  get(checkpointId: string): Checkpoint | null;
  list(sessionId?: string): Checkpoint[];
  restore(checkpointId: string): { phase: string; completedSkills: string[]; tokensUsed: number; agentHistory: Array<Record<string, unknown>>; metadata: Record<string, unknown>; restoredFrom: string; restoredAt: string } | null;
  remove(checkpointId: string): boolean;
  getLatest(sessionId: string): Checkpoint | null;
  static MAX_CHECKPOINTS: number;
}

export interface RetryResult {
  success: boolean;
  result?: unknown;
  attempts: number;
  escalatedTo?: 'retry' | 'replan' | 'decompose';
  error?: string;
  errors?: Array<{ attempt: number; error: string; timestamp: string }>;
  partialResults?: RetryResult[];
}

export declare class RetryEngine {
  constructor(options?: { maxRetries?: number; backoffBaseMs?: number });
  execute(task: { id?: string; execute: (context: { taskId: string; level: string; attempt: number; errors: Array<Record<string, unknown>> }) => Promise<unknown>; replan?: (errors: Array<Record<string, unknown>>) => Promise<{ execute: () => Promise<unknown> } | null>; decompose?: (errors: Array<Record<string, unknown>>) => Promise<Array<{ id?: string; execute: () => Promise<unknown> }>> }): Promise<RetryResult>;
  getAttempt(taskId: string): Record<string, unknown> | null;
  static ESCALATION_LEVELS: { RETRY: 'retry'; REPLAN: 'replan'; DECOMPOSE: 'decompose' };
  static DEFAULT_MAX_RETRIES: number;
}

export interface SkillLearning {
  id: string;
  skillId: string;
  phase: string;
  approach: string;
  whatWorked: string[];
  whatFailed: string[];
  tips: string[];
  context: string;
  agentId: string;
  createdAt: string;
}

export declare class SkillImprover {
  constructor(projectRoot: string);
  recordLearning(entry: { skillId: string; phase?: string; approach?: string; whatWorked?: string[]; whatFailed?: string[]; tips?: string[]; context?: string; agentId?: string }): SkillLearning | null;
  getLearnings(skillId?: string): SkillLearning[];
  getTips(skillId: string): string[];
  getAvoidances(skillId: string): string[];
  getStats(): { total: number; bySkill: Record<string, number> };
  static MAX_LEARNINGS: number;
}

export declare class ConcurrencyController {
  constructor(maxConcurrent?: number);
  acquire(taskId: string, metadata?: Record<string, unknown>): Promise<boolean>;
  release(taskId: string): boolean;
  run<T>(taskId: string, fn: () => Promise<T>, metadata?: Record<string, unknown>): Promise<T>;
  isRunning(taskId: string): boolean;
  getRunningTasks(): Array<{ taskId: string; startedAt: number; duration: number; metadata: Record<string, unknown> }>;
  getStats(): { maxConcurrent: number; runningCount: number; queuedCount: number; availableSlots: number };
  clear(): void;
  static DEFAULT_MAX_CONCURRENT: number;
}

export interface ReviewResult {
  consensus: boolean;
  rounds: number;
  details: Array<{ round: number; reviewerA: { approved: boolean; feedback: string; suggestions: string[] }; reviewerB: { approved: boolean; feedback: string; suggestions: string[] } }>;
  finalFeedback: string;
  error?: string;
}

export declare class AdversarialReview {
  constructor(options?: { maxRounds?: number });
  review(subject: unknown, reviewerA: (subject: unknown, context: Record<string, unknown>) => Promise<{ approved: boolean; feedback?: string; suggestions?: string[] }>, reviewerB: (subject: unknown, context: Record<string, unknown>) => Promise<{ approved: boolean; feedback?: string; suggestions?: string[] }>): Promise<ReviewResult>;
  static DEFAULT_MAX_ROUNDS: number;
}

export declare class PlatformCoordinator {
  registerPlatform(platformId: string, sender: (message: unknown) => Promise<unknown>): boolean;
  unregisterPlatform(platformId: string): boolean;
  addRoute(fromPlatform: string, toPlatform: string, filter?: (message: unknown) => boolean): boolean;
  send(platformId: string, message: unknown): Promise<{ success: boolean; result?: unknown; error?: string }>;
  broadcast(message: unknown, excludePlatform?: string): Promise<Array<{ platformId: string; success: boolean; result?: unknown; error?: string }>>;
  getPlatforms(): string[];
  getRoutes(): Array<{ from: string; to: string; filter: ((message: unknown) => boolean) | null }>;
  getStats(): { platformCount: number; routeCount: number };
}

export interface WorkflowTemplateDef {
  name: string;
  description: string;
  version: string;
  steps: Array<{ id: string; goal?: string; context?: string; needs?: string[]; phase?: string; agent?: string; skill?: string }>;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export declare class WorkflowTemplate {
  constructor(projectRoot: string);
  create(name: string, definition: { description?: string; version?: string; steps: Array<{ id: string; goal?: string; context?: string; needs?: string[] }>; variables?: string[] }): WorkflowTemplateDef | null;
  get(name: string): WorkflowTemplateDef | null;
  list(): WorkflowTemplateDef[];
  instantiate(name: string, variables: Record<string, string>): { templateName: string; steps: Array<Record<string, unknown>>; instantiatedAt: string } | null;
  remove(name: string): boolean;
}

export interface MemoryVerificationStats {
  total: number;
  verified: number;
  stale: number;
  verificationRate: number;
}

export interface HarnessInstance {
  router: SkillRouter;
  session: SessionManager;
  orchestrator: PhaseOrchestrator;
  enforcer: RBACEnforcer;
  guard: PermissionGuard;
  logger: AuditLogger;
  tddGate: TDDGate;
  verifier: EvidenceVerifier;
  eventBus: EventBus;
  pluginManager: PluginManager;
  healthChecker: HealthChecker;
  structuredLog: StructuredLogger;
  memoryStore: MemoryStore;
  agentChannel: AgentChannel;
  checkpointManager: CheckpointManager;
  retryEngine: RetryEngine;
  skillImprover: SkillImprover;
  concurrencyController: ConcurrencyController;
  adversarialReview: AdversarialReview;
  platformCoordinator: PlatformCoordinator;
  workflowTemplate: WorkflowTemplate;
  recurrentDeepening: RecurrentDeepeningScheduler;
  adaptiveDepth: AdaptiveDepthController;
  ltiInjector: LTIContextInjector;
  multiAgentRouter: MultiAgentRouter;
  outputFusion: OutputFusion;
  iterativeRefinement: IterativeRefinement;
  progressiveDeepening: ProgressiveDeepening;
  deepeningOrchestrator: DeepeningOrchestrator;
  qualityScorer: QualityScorer;
  tokenAwareDeepening: TokenAwareDeepening;
  affinityLearner: AffinityLearner;
  convergenceDetector: ConvergenceDetector;
  projectRoot: string;
  goalExecutor: GoalExecutor;
  phaseContextInjector: PhaseContextInjector;
  causalDataBus: CausalDataBus;
  causalMemoryStore: CausalMemoryStore;
  configCausalValidator: ConfigCausalValidator;
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
  destroy(): void;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  skillEnforcements: Record<string, { enforcement: string; priority: number; phase: string }>;
  config: Record<string, unknown> | null;
  securityFindings: Array<{ path: string; type: string; key: string; valuePreview: string }>;
}

export declare class BoundedArray<T = unknown> {
  constructor(maxSize: number, options?: { strategy?: 'fifo' | 'lru'; onEvict?: (item: T) => void });
  readonly length: number;
  push(item: T): number;
  touch(index: number): boolean;
  slice(start?: number, end?: number): T[];
  filter(fn: (item: T) => boolean): T[];
  map<U>(fn: (item: T) => U): U[];
  forEach(fn: (item: T) => void): void;
  reduce<U>(fn: (acc: U, item: T) => U, initial: U): U;
  find(fn: (item: T) => boolean): T | undefined;
  some(fn: (item: T) => boolean): boolean;
  every(fn: (item: T) => boolean): boolean;
  includes(item: T): boolean;
  indexOf(item: T): number;
  get(index: number): T | undefined;
  toArray(): T[];
  clear(): void;
  entries(): IterableIterator<[number, T]>;
  static from<T>(iterable: Iterable<T>, maxSize: number): BoundedArray<T>;
  static DEFAULT_MAX: number;
}

export interface EventEntry {
  event: string;
  data: unknown;
  timestamp: string;
}

export declare class EventBus {
  constructor(options?: { maxListeners?: number; maxHistory?: number; maxMiddleware?: number });
  use(fn: (event: string, data: unknown) => void): EventBus;
  emit(event: string, data?: unknown): boolean;
  getHistory(eventFilter?: string): EventEntry[];
  clearHistory(): void;
  onceAsync(event: string, timeoutMs?: number): Promise<unknown>;
  removeAllListeners(event?: string): EventBus;
  static DEFAULT_MAX_HISTORY: number;
}

export interface PluginContext {
  eventBus: EventBus;
}

export interface Plugin {
  id: string;
  init?(ctx: PluginContext): void;
  destroy?(ctx: PluginContext): void;
}

export declare class PluginManager {
  register(plugin: Plugin): PluginManager;
  unregister(pluginId: string): boolean;
  getPlugin(pluginId: string): Plugin | null;
  listPlugins(): string[];
  registerHook(hookName: string, handler: (...args: unknown[]) => unknown): PluginManager;
  executeHook(hookName: string, data: unknown): unknown;
  getHooks(hookName?: string): Record<string, string[]> | string[];
  destroy(): void;
}

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'error' | 'unknown';
  message?: string;
  duration?: number;
}

export declare class HealthChecker {
  register(name: string, checkFn: () => HealthCheckResult | Promise<HealthCheckResult>): HealthChecker;
  check(name: string): Promise<HealthCheckResult>;
  checkAll(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; checks: Record<string, HealthCheckResult>; timestamp: string }>;
  unregister(name: string): boolean;
  listChecks(): string[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface LogEntry {
  level: LogLevel;
  message: string;
  module: string;
  timestamp: string;
  meta: Record<string, unknown>;
}

export declare class StructuredLogger {
  constructor(options?: { level?: LogLevel; maxEntries?: number; module?: string });
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(module: string): StructuredLogger;
  query(filter?: { level?: LogLevel; module?: string; since?: string; limit?: number }): LogEntry[];
  getRecent(count?: number): LogEntry[];
  clear(): void;
  export(): string;
  getStats(): { total: number; byLevel: Record<string, number>; byModule: Record<string, number> };
  static LOG_LEVELS: Record<LogLevel, number>;
}

export interface ChangelogArchiveEntry {
  id: string;
  version: string;
  changes: Record<string, string[]>;
  summary: string;
  category?: string;
  agent?: string;
  timestamp: string;
  hash: string;
}

export interface ChangelogSearchResult {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  items: ChangelogArchiveEntry[];
}

export interface ChangelogStats {
  totalVersions: number;
  totalChanges: number;
  byCategory: Record<string, number>;
  byAgent: Record<string, number>;
  earliestDate: string | null;
  latestDate: string | null;
}

export interface IntegrityResult {
  indexValid: boolean;
  recordsValid: number;
  recordsTampered: number;
  recordsMissing: number;
}

export declare class ChangelogArchive {
  constructor(projectRoot: string);
  record(entry: { version: string; changes: Record<string, string[]>; summary: string; category?: string; agent?: string }): { success: boolean; id?: string; hash?: string; error?: string };
  get(id: string): ChangelogArchiveEntry | null;
  search(params: { keyword?: string; category?: string; since?: string; until?: string; page?: number; pageSize?: number }): ChangelogSearchResult;
  getStats(): ChangelogStats;
  verifyIntegrity(): IntegrityResult;
}

export declare class DashboardServer {
  constructor(projectRoot: string, port?: number, harness?: Record<string, unknown>);
  start(): Promise<DashboardServer>;
  stop(): void;
}

export interface AgentState {
  id: string;
  state: string;
  config: Record<string, unknown>;
  version: string;
  dependencies: string[];
  createdAt: string;
  lastActivityAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  errorInfo: { message: string; code: string; timestamp: string } | null;
  taskCount: number;
  metadata: Record<string, unknown>;
  allocatedResources?: { memoryMB?: number; cpuPercent?: number };
}

export declare class AgentRuntime {
  constructor(projectRoot: string, options?: Record<string, unknown>);
  register(agentId: string, config: Record<string, unknown>): AgentState;
  unregister(agentId: string): boolean;
  get(agentId: string): AgentState | null;
  getStatus(agentId: string): { id: string; state: string; taskCount: number; allocatedResources?: Record<string, unknown> } | null;
  transition(agentId: string, newState: string): AgentState;
  allocateResources(agentId: string, resources: { memoryMB?: number; cpuPercent?: number }): AgentState;
  releaseResources(agentId: string): void;
  checkDependencies(agentId: string): { satisfied: boolean; missing: string[]; unavailable: Array<{ id: string; state: string }> };
  setVersion(agentId: string, version: string): AgentState;
  incrementTaskCount(agentId: string): number;
  setError(agentId: string, errorInfo: { message: string; code?: string }): void;
  getResourcePool(): { totalMemoryMB: number; usedMemoryMB: number; totalCpuPercent: number; usedCpuPercent: number };
  listAgents(filter?: { state?: string; version?: string }): AgentState[];
  getStats(): { totalAgents: number; stateCounts: Record<string, number>; resourcePool: Record<string, number>; resourceUtilization: { memoryPercent: number; cpuPercent: number } };
  flush(): void;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class AgentLifecycleController {
  constructor(runtime?: AgentRuntime, stateManager?: AgentStateManager, sandbox?: AgentSandbox);
  create(agentId: string, config: Record<string, unknown>): AgentState;
  start(agentId: string): AgentState;
  pause(agentId: string): AgentState;
  resume(agentId: string): AgentState;
  stop(agentId: string, options?: { force?: boolean }): AgentState;
  destroy(agentId: string): boolean;
  restart(agentId: string): AgentState;
  getStatus(agentId: string): { id: string; state: string; version: string; startedAt: string | null; stoppedAt: string | null; taskCount: number; errorInfo: unknown; lastActivityAt: string } | null;
  getOperationHistory(agentId?: string, limit?: number): Array<Record<string, unknown>>;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class AgentSandbox {
  constructor(projectRoot: string, options?: Record<string, unknown>);
  prepare(agentId: string, config: Record<string, unknown>): { agentId: string; level: string; ready: boolean; policy: Record<string, unknown>; environment: Record<string, string>; restrictions: Array<Record<string, string>>; violationCount: number; maxViolations: number };
  cleanup(agentId: string): boolean;
  checkAccess(agentId: string, resource: string, action: string): { allowed: boolean; reason: string };
  validatePath(agentId: string, filePath: string): { valid: boolean; reason?: string; resolved?: string };
  setCustomPolicy(agentId: string, policyOverrides: Record<string, unknown>): void;
  getSandbox(agentId: string): Record<string, unknown> | null;
  getPolicy(agentId: string): Record<string, unknown> | null;
  getAccessLog(agentId?: string, options?: Record<string, unknown>): Array<Record<string, unknown>>;
  getStats(): { totalSandboxes: number; levelCounts: Record<string, number>; totalViolations: number; totalAccessLogs: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export interface AntipatternDetection {
  id: string;
  name: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
  recommendation: string;
  agentId: string;
  timestamp: string;
}

export interface AntipatternRule {
  id: string;
  name: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
}

export declare class AgentMonitor {
  constructor(projectRoot: string, options?: Record<string, unknown>);
  registerAgent(agentId: string, options?: Record<string, unknown>): Record<string, unknown>;
  unregisterAgent(agentId: string): void;
  recordMetric(agentId: string, type: string, value: number, metadata?: Record<string, unknown>): void;
  recordMetrics(agentId: string, metrics: Record<string, number>): void;
  logEvent(agentId: string, level: string, message: string, data?: Record<string, unknown>): void;
  getMetrics(agentId: string, options?: Record<string, unknown>): Record<string, unknown> | null;
  getLogs(agentId: string, options?: Record<string, unknown>): Array<Record<string, unknown>>;
  getAlerts(options?: Record<string, unknown>): Array<Record<string, unknown>>;
  startCollection(agentId: string): void;
  stopCollection(agentId: string): void;
  setThreshold(metricName: string, warning: number, critical: number): void;
  getThresholds(): Record<string, { warning: number; critical: number }>;
  getDashboardData(): Record<string, unknown>;
  detectAntipatterns(agentId: string, behaviorContext: {
    newFileCount?: number;
    addedLines?: number;
    newAbstractions?: number;
    searchCount?: number;
    uniqueSearchTargets?: number;
    claimedComplete?: boolean;
    verificationRan?: boolean;
    retryCount?: number;
    filesModified?: number;
    taskRelatedFiles?: number;
  }): AntipatternDetection[];
  getAntipatternRules(): AntipatternRule[];
  getStats(): { monitoredAgents: number; totalAlerts: number; activeCollections: number; totalLogEntries: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class AgentDeployment {
  constructor(projectRoot: string, options?: Record<string, unknown>);
  deploy(agentId: string, targetEnv: string, options?: Record<string, unknown>): Record<string, unknown>;
  rollback(deploymentId: string, options?: Record<string, unknown>): Record<string, unknown>;
  getDeployment(deploymentId: string): Record<string, unknown> | null;
  listDeployments(filter?: Record<string, unknown>): Array<Record<string, unknown>>;
  getEnvironmentState(env: string): Record<string, unknown> | null;
  lockEnvironment(env: string): void;
  unlockEnvironment(env: string): void;
  registerVersion(agentId: string, version: string, info?: Record<string, unknown>): void;
  getVersionHistory(agentId: string): Array<Record<string, unknown>>;
  flush(): void;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class AgentStateManager {
  constructor(projectRoot: string, options?: Record<string, unknown>);
  saveState(agentId: string, stateData: Record<string, unknown>, options?: { immediate?: boolean }): Record<string, unknown>;
  loadState(agentId: string): Record<string, unknown> | null;
  deleteState(agentId: string): boolean;
  hasState(agentId: string): boolean;
  createSnapshot(agentId: string, label?: string): Record<string, unknown>;
  restoreSnapshot(agentId: string, snapshotId: string): Record<string, unknown>;
  listSnapshots(agentId: string): Array<Record<string, unknown>>;
  deleteSnapshot(agentId: string, snapshotId: string): boolean;
  syncState(agentId: string, remoteData: Record<string, unknown>): Record<string, unknown>;
  listAgents(): string[];
  getStateInfo(agentId: string): Record<string, unknown> | null;
  getStats(): { totalAgents: number; totalDataSize: number; totalSnapshots: number; averageDataSize: number };
  flush(): void;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class AgentWorkflowIntegration {
  constructor(projectRoot: string, options?: Record<string, unknown>);
  registerAdapter(agentId: string, adapter: Record<string, unknown>): Record<string, unknown>;
  unregisterAdapter(agentId: string): boolean;
  getAdapter(agentId: string): Record<string, unknown> | null;
  submitTask(task: Record<string, unknown>): Record<string, unknown>;
  cancelTask(taskId: string): Record<string, unknown>;
  getTask(taskId: string): Record<string, unknown> | null;
  listTasks(filter?: Record<string, unknown>): Array<Record<string, unknown>>;
  subscribeEvent(agentId: string, eventType: string, handler?: Function): Record<string, unknown>;
  emitEvent(eventType: string, data?: Record<string, unknown>): void;
  addSchedule(agentId: string, scheduleConfig: Record<string, unknown>): Record<string, unknown>;
  removeSchedule(scheduleId: string): boolean;
  submitFeedback(taskId: string, feedback: Record<string, unknown>): Record<string, unknown>;
  getFeedbackHistory(filter?: Record<string, unknown>): Array<Record<string, unknown>>;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class AgentError extends HarnessError {
  constructor(code: string, message: string, context?: object);
}

export declare class DeepeningError extends HarnessError {
  constructor(code: string, message: string, context?: object);
}

export declare class CausalViolationError extends HarnessError {
  constructor(code: string, message: string, context?: Record<string, unknown>);
}

export declare class PipelineError extends HarnessError {
  constructor(code: string, message: string, context?: Record<string, unknown>);
}

export declare class HookError extends HarnessError {
  constructor(code: string, message: string, context?: Record<string, unknown>);
}

export declare const ERROR_CODES: Record<string, string>;
export declare const ERROR_SEVERITY: Record<string, 'critical' | 'error' | 'warn' | 'info'>;
export declare const HTTP_STATUS_MAP: Record<string, number>;

export declare class RecurrentDeepeningScheduler {
  constructor(options?: { maxIterations?: number; convergenceThreshold?: number; minImprovement?: number });
  execute(agent: { execute: (task: Record<string, unknown>) => Promise<unknown> }, task: Record<string, unknown>, evaluator?: (result: unknown, task: Record<string, unknown>) => Promise<number>): Promise<{ success: boolean; result: unknown; iterations: number; converged: boolean; qualityScore: number; qualityScores: number[]; error?: string }>;
  getHistory(executionId: string): Record<string, unknown> | null;
  getStats(): { activeExecutions: number; maxIterations: number; convergenceThreshold: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class AdaptiveDepthController {
  constructor(options?: { quickThreshold?: number; standardThreshold?: number; deepThreshold?: number; maxDepth?: number });
  assessComplexity(task: Record<string, unknown> | null): { level: string; depth: number; score: number; signals: Record<string, number> };
  getRecommendedDepth(task: Record<string, unknown>): number;
  getRecommendedLevel(task: Record<string, unknown>): string;
  getStats(): { totalAssessments: number; config: Record<string, unknown> };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class LTIContextInjector {
  constructor(options?: { mode?: string; maxHistory?: number });
  registerOriginalContext(taskId: string, context: Record<string, unknown>): void;
  inject(taskId: string, currentTask: Record<string, unknown>, iteration: number): Record<string, unknown>;
  getOriginalContext(taskId: string): Record<string, unknown> | null;
  getInjectionHistory(taskId: string): Array<Record<string, unknown>>;
  unregisterContext(taskId: string): boolean;
  getStats(): { registeredContexts: number; totalInjections: number; mode: string };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class MultiAgentRouter {
  constructor(options?: { topK?: number; minAffinity?: number; maxHistory?: number });
  registerAgent(agentId: string, capabilities: { strengths: string[]; scope?: string; tier?: string; modelTier?: string }): boolean;
  unregisterAgent(agentId: string): boolean;
  getCapabilitiesForAgent(agentId: string): { strengths: string[]; scope: string; tier: string; modelTier: string } | null;
  suggestCollaborationMode(task: Record<string, unknown>, availableAgents?: string[]): 'solo' | 'hierarchical' | 'pipeline' | 'parallel' | 'generator-verifier';
  selectModelForTask(agentId: string, taskComplexity?: number): 'high' | 'medium' | 'low' | 'default';
  route(task: Record<string, unknown> | null, availableAgents?: string[]): { agents: Array<{ agentId: string; score: number; capabilities: Record<string, unknown> }>; affinities: Record<string, number>; taskTypes: string[]; routingId: string; timestamp: string };
  updateAffinity(agentId: string, taskType: string, delta: number): void;
  getAffinity(agentId: string, taskType: string): number;
  getRoutingHistory(limit?: number): Array<Record<string, unknown>>;
  getStats(): { totalRoutings: number; topK: number; minAffinity: number; knownAgents: number; dynamicAgents: number; learnedAffinities: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class OutputFusion {
  constructor(options?: { defaultStrategy?: string; maxHistory?: number });
  fuse(results: Array<{ agentId: string; output: unknown; confidence?: number }>, strategy?: string, options?: Record<string, unknown>): Promise<{ fused: unknown; strategy: string; confidence: number; metadata: Record<string, unknown> }>;
  getStats(): { totalFusions: number; defaultStrategy: string; strategyCounts: Record<string, number> };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class IterativeRefinement {
  constructor(options?: { maxRefinements?: number; qualityThreshold?: number });
  refine(executor: { execute: (task: Record<string, unknown>) => Promise<unknown> }, task: Record<string, unknown>, reviewer?: (result: unknown, task: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<{ success: boolean; output: unknown; rounds: number; converged: boolean; qualityScore?: number; roundDetails: Array<Record<string, unknown>>; error?: string }>;
  getHistory(refinementId: string): Record<string, unknown> | null;
  getStats(): { activeRefinements: number; maxRefinements: number; qualityThreshold: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class ProgressiveDeepening {
  constructor(options?: { defaultLevel?: string; levelOverrides?: Record<string, unknown>; maxHistory?: number });
  execute(agent: { execute: (task: Record<string, unknown>) => Promise<unknown> }, task: Record<string, unknown>, depthLevel?: string, options?: { reviewer?: Function; adversarialReviewer?: Record<string, unknown>; reviewerA?: Function; reviewerB?: Function }): Promise<{ success: boolean; result: unknown; level: string; iterations: number; bestQualityScore: number; reviews: Array<Record<string, unknown>>; adversarialResult: Record<string, unknown> | null; duration: number; error?: string }>;
  getLevelConfig(level: string): Record<string, unknown>;
  getAvailableLevels(): string[];
  getStats(): { totalExecutions: number; levelCounts: Record<string, number>; defaultLevel: string };
  shutdown(): void;
  isHealthy(): boolean;
}

export function validateConfig(projectRoot: string): ValidationResult;
export declare class DeepeningOrchestrator {
  constructor(options?: { defaultDepthLevel?: string; maxIterations?: number; convergenceThreshold?: number; topK?: number; fusionStrategy?: string; tokenBudgetRatio?: number; enableLTI?: boolean; enableAdaptiveDepth?: boolean; enableMultiAgent?: boolean });
  execute(task: Record<string, unknown>, agents: Record<string, unknown> | Array<Record<string, unknown>>, options?: Record<string, unknown>): Promise<{ success: boolean; result: unknown; executionId: string; depthLevel: string; iterations: number; bestScore: number; agentsUsed: string[]; totalAgentCalls: number; duration: number; steps: Array<Record<string, unknown>>; error?: string }>;
  getExecutionLog(limit?: number): Array<Record<string, unknown>>;
  getStats(): { totalExecutions: number; levelCounts: Record<string, number>; averageScore: number; config: Record<string, unknown> };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class QualityScorer {
  constructor(options?: { weights?: Record<string, number>; thresholds?: Record<string, number>; maxHistory?: number });
  score(result: unknown, task?: Record<string, unknown>): { total: number; dimensions: Record<string, number>; grade: string; taskId?: string; timestamp: string };
  getHistory(limit?: number): Array<Record<string, unknown>>;
  getStats(): { totalScores: number; averageScore: number; gradeDistribution: Record<string, number> };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class TokenAwareDeepening {
  constructor(options?: { budgetRatio?: number; minBudgetRemaining?: number; iterationTokenCost?: number; maxHistory?: number });
  calculateMaxIterations(tokenManager: Record<string, unknown>, sessionId: string): { maxIterations: number; reason: string; remainingBudget?: number; deepeningBudget?: number; remainingRatio?: number };
  canAffordIteration(tokenManager: Record<string, unknown>, sessionId: string, iterationCost?: number): { canAfford: boolean; reason: string; deepeningBudget?: number; iterationCost?: number };
  recordIterationCost(sessionId: string, iteration: number, tokensUsed: number, qualityScore: number): Record<string, unknown>;
  getEfficiencyReport(sessionId?: string): { totalRecords: number; averageEfficiency: number; totalTokensUsed: number; averageQuality?: number; tokensPerQualityPoint?: number };
  recommendDepth(tokenManager: Record<string, unknown>, sessionId: string, taskComplexity?: number): { recommendedLevel: string; maxIterations: number; budgetInfo: Record<string, unknown>; complexity: number };
  getHistory(limit?: number): Array<Record<string, unknown>>;
  getStats(): { totalRecords: number; budgetRatio: number; minBudgetRemaining: number; iterationTokenCost: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class AffinityLearner {
  constructor(options?: { learningRate?: number; decayFactor?: number; minSamples?: number; maxRecords?: number });
  recordExecution(agentId: string, taskType: string, qualityScore: number, duration?: number): void;
  getAffinity(agentId: string, taskType: string): { score: number; confidence: string; samples: number };
  getRecommendations(taskType: string, agentIds: string[]): Array<{ agentId: string; score: number; confidence: string; samples: number }>;
  decay(): void;
  getAgentPerformance(agentId: string): Record<string, { score: number; samples: number; averageScore: number }>;
  getStats(): { totalAffinities: number; totalRecords: number; knownAgents: number; knownTaskTypes: number; learningRate: number; decayFactor: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class ConvergenceDetector {
  constructor(options?: { qualityThreshold?: number; minImprovementRate?: number; stabilityWindow?: number; stabilityVariance?: number; coverageThreshold?: number; dimensionBalanceThreshold?: number; maxIterations?: number });
  check(executionId: string, iterationData: { iteration?: number; qualityScore?: number; dimensions?: Record<string, number> }): { converged: boolean; reason: string; signals: Record<string, { value: number; passed: boolean }>; iteration: number; recommendation: string };
  reset(executionId: string): boolean;
  getStats(): { activeExecutions: number; config: Record<string, unknown> };
  shutdown(): void;
  isHealthy(): boolean;
}

export interface PhaseContext {
  phase: string;
  coreIdentity: string;
  rules: Array<{ name: string; content: string }>;
  agents: Array<{ name: string; content: string }>;
  phaseSkills: string[];
  estimatedTokens: number;
}

export declare class PhaseContextInjector {
  constructor(projectRoot: string);
  injectForPhase(phase: string): PhaseContext;
  getCurrentPhase(): string | null;
  getEstimatedTokens(): number;
  clearCache(): void;
  shutdown(): void;
  isHealthy(): boolean;
}

export interface ScenarioDefinition {
  name: string;
  given?: Record<string, string>;
  when?: string;
  then?: Record<string, string>;
}

export interface SkillInterface {
  skillId: string;
  causalInputs: Array<string | { name: string; required?: boolean }>;
  causalOutputs: string[];
  invariants: string[];
  scenarios: ScenarioDefinition[];
  version: number;
}

export interface CausalChainEntry {
  skillId: string;
  timestamp: number;
  data: Record<string, unknown>;
  interfaceVersion: number;
  causalId: string;
  validatedOutputs?: Record<string, boolean>;
}

export interface ParallelConflict {
  key: string;
  sources: [string, string];
  values: [unknown, unknown];
}

export interface MergeResult {
  merged: Record<string, unknown>;
  conflicts: ParallelConflict[];
  strategy: string;
}

export declare class CausalDataBus {
  constructor(options?: { root?: string });
  defineSkillInterface(skillId: string, definition: { causalInputs?: Array<string | { name: string; required?: boolean }>; causalOutputs?: string[]; invariants?: string[]; scenarios?: ScenarioDefinition[]; version?: number }): SkillInterface;
  getSkillInterface(skillId: string): SkillInterface | null;
  getDefinedInterfaces(): SkillInterface[];
  validateInputs(skillId: string, context: Record<string, unknown>): { valid: boolean; missing: string[]; reason: string };
  enforceValidateInputs(skillId: string, context: Record<string, unknown>): { valid: boolean; missing: string[]; reason: string };
  publishOutput(skillId: string, outputData: Record<string, unknown>): boolean;
  enforcePublishOutput(skillId: string, outputData: Record<string, unknown>, inputContext?: Record<string, unknown>): boolean;
  consumeInputs(skillId: string): Record<string, unknown>;
  validateScenario(skillId: string, scenarioName: string, context: Record<string, unknown>): { valid: boolean; scenarioName: string; issues: Array<{ field: string; expected: string; actual: string }>; reason: string };
  checkScenarioCoverage(skillId: string, testedScenarios: string[]): { coverage: number; untested: string[]; total: number; tested: number };
  getCausalChain(limit?: number): CausalChainEntry[];
  getStats(): { chainLength: number; interfaceCount: number; pendingOutputCount: number; totalScenarios: number; walSequence: number; walEnabled: boolean };
  detectConflicts(data1: Record<string, unknown>, data2: Record<string, unknown>): Array<{ key: string; value1: unknown; value2: unknown }>;
  detectParallelConflicts(skillIds: string[]): { hasConflicts: boolean; conflicts: ParallelConflict[]; overlappingKeys: string[] };
  mergeParallelOutputs(skillIds: string[], strategy?: 'last-wins' | 'first-wins' | 'deepest-wins' | 'union'): MergeResult;
  registerConflictResolver(name: string, resolverFn: (key: string, values: unknown[]) => unknown): boolean;
  rollbackToSequence(targetSequence: number): void;
  rollbackToTimestamp(targetTimestamp: number): void;
  shutdown(): void;
  isHealthy(): boolean;
  static MERGE_STRATEGIES: { LAST_WINS: 'last-wins'; FIRST_WINS: 'first-wins'; DEEPEST_WINS: 'deepest-wins'; UNION: 'union' };
}

export interface CausalMemoryEntry {
  id: string;
  cause: string;
  effect: string;
  context: string;
  confidence: number;
  temporalScope: string;
  category: string;
  tags: string[];
  source: string;
  createdAt: number;
  updatedAt: number;
  verifiedAt: number | null;
  similarity?: number;
  decayedConfidence?: number;
}

export interface CausalConflict {
  entryA: { id: string; cause: string; effect: string; confidence: number };
  entryB: { id: string; cause: string; effect: string; confidence: number };
  causeSimilarity: number;
  effectSimilarity: number;
}

export declare class CausalMemoryStore {
  constructor(sqliteStore?: unknown, options?: { root?: string; maxMemories?: number; ttlMs?: number });
  addCausalMemory(entry: { cause: string; effect: string; context?: string; confidence?: number; temporalScope?: string; category?: string; tags?: string[]; source?: string; target?: string }): { success: boolean; id?: string; error?: string };
  addCausalMemories(entries: Array<{ cause: string; effect: string; context?: string; confidence?: number }>): { success: boolean; count: number; results: Array<{ success: boolean; id?: string }> };
  getCausalMemories(filter?: { category?: string; source?: string; minConfidence?: number }): CausalMemoryEntry[];
  searchByCausalSimilarity(queryContext: string, options?: { limit?: number; threshold?: number }): CausalMemoryEntry[];
  traceCausalChain(effectKeyword: string, options?: { maxDepth?: number }): CausalMemoryEntry[];
  detectCausalConflicts(): CausalConflict[];
  getMemoriesWithDecay(filter?: { category?: string; source?: string; minConfidence?: number }): CausalMemoryEntry[];
  removeCausalMemory(id: string): boolean;
  verifyMemory(id: string): boolean;
  getStats(): { totalMemories: number; avgConfidence: number; verifiedMemories: number; degradedMemories: number; similarityIndexSize: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare namespace AR {
  const VERSION: number;
  const FIELDS: {
    PREVIOUS_RESULT: string;
    PREVIOUS_SCORE: string;
    QUALITY_HISTORY: string;
    FEEDBACK: string;
    PREVIOUS_OUTPUT: string;
    FOCUS_AREAS: string;
    ORIGINAL_GOAL: string;
    ITERATION: string;
    MAX_ITERATIONS: string;
    ITERATION_SUMMARY: string;
    SOURCE: string;
  };
  const SOURCE_IDS: {
    ORCHESTRATOR: string;
    REFINEMENT: string;
    RECURRENT: string;
  };
  function inject(target: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown>;
  function extract(target: Record<string, unknown>): Record<string, unknown> | null;
  function merge(target: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown>;
  function validate(target: Record<string, unknown>): { valid: boolean; warnings: string[] };
  function compatibilityCheck(target: Record<string, unknown>, requiredVersion?: number): { compatible: boolean; reason: string; contextVersion?: number; requiredVersion?: number; missingFields?: string[]; warning?: string };
  function strip(target: Record<string, unknown>): Record<string, unknown>;
}

export declare class CausalConsistencyChecker {
  constructor(options?: { causalDataBus?: CausalDataBus; causalMemoryStore?: CausalMemoryStore; configCausalValidator?: unknown; maxDepth?: number });
  attachCausalDataBus(bus: CausalDataBus): void;
  attachCausalMemoryStore(store: CausalMemoryStore): void;
  attachConfigCausalValidator(validator: unknown): void;
  checkRuntimeVsStatic(): { consistent: boolean; issues: Array<{ type: string; skillId?: string; description: string; severity: string }> };
  checkMemoryVsRuntime(): Promise<{ consistent: boolean; issues: Array<{ type: string; skillId?: string; outputName?: string; description: string; severity: string }> }>;
  checkFullConsistency(): Promise<{ consistent: boolean; totalIssues: number; highIssues: number; mediumIssues: number; lowIssues: number; issues: Array<{ type: string; severity: string; description: string }>; runtimeVsStatic: boolean; memoryVsRuntime: boolean }>;
  shutdown(): void;
}

export declare class GeneratorVerifier {
  constructor(options?: { maxIterations?: number; convergenceThreshold?: number });
  verifyCorrectness(context: { skillId: string; output: string; requirements?: string[]; evidence?: Array<{ type: string; content: string }> }): { passed: boolean; overallScore: number; dimensions: Record<string, { weight: number; score: number; issues: Array<{ severity: string; description: string }> }> };
  executeVerificationLoop(context: { generateFn: () => unknown; verifyFn: (output: unknown) => { passed: boolean; score: number }; maxIterations?: number }): { converged: boolean; iterations: number; bestScore: number };
  shutdown(): void;
}

export interface DependencyGraphNode {
  id: string;
  phase: string;
  enforcement: string;
  dependsOn: string[];
  blocks: string[];
  applicableAgents: string[];
  fileExists: boolean;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: Array<{ type: string; message: string }>;
  warnings: Array<{ type: string; source?: string; message: string; cycles?: string[][] }>;
  stats: { skills: number; agents: number; rules: number; hooks: number; mcpServers: number; errorCount: number };
}

export interface ConfigDriftResult {
  drifted: boolean;
  reason: string;
  added?: string[];
  removed?: string[];
}

export declare class ConfigCausalValidator {
  constructor(projectRoot: string);
  buildDependencyGraph(): { skills: Record<string, DependencyGraphNode>; agents: Record<string, unknown>; rules: Record<string, unknown>; hooks: Record<string, unknown>; mcp: Record<string, unknown>; errors: Array<{ type: string; message: string }> };
  validate(): ConfigValidationResult;
  detectCircularDependencies(): string[][];
  snapshotConfig(): boolean;
  detectConfigDrift(): ConfigDriftResult;
  isDriftDetected(): boolean;
  getLastValidation(): ConfigValidationResult | null;
}

export interface GoalData {
  goalId: string;
  objective: string;
  status: string;
  priority: string;
  currentIteration: number;
  maxIterations: number;
  subtasks: Array<{ id: string; objective: string; status: string }>;
  qualityHistory: number[];
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export declare class GoalExecutor {
  constructor(options?: { maxConcurrentGoals?: number; autoDecompose?: boolean; iterationTimeout?: number; persistInterval?: number; goalTTL?: number });
  createGoal(objective: string, options?: { priority?: string; maxIterations?: number; metadata?: Record<string, unknown> }): { success: boolean; goalId: string; status: string };
  execute(goalId: string, executeFn: (goal: GoalData, iteration: number) => Promise<unknown>, options?: Record<string, unknown>): Promise<{ success: boolean; goalId?: string; result?: unknown; iterations?: number; qualityHistory?: number[]; duration?: number; error?: string; status?: string }>;
  cancelGoal(goalId: string): boolean;
  pauseGoal(goalId: string): boolean;
  resumeGoal(goalId: string): boolean;
  getGoal(goalId: string): GoalData | undefined;
  attachSubagentExecutor(executor: unknown): GoalExecutor;
  attachThoughtRetrieverCycle(trc: unknown): GoalExecutor;
  attachCausalDataBus(bus: CausalDataBus): GoalExecutor;
  shutdown(): void;
  isHealthy(): boolean;
}

export function validateAgentId(agentId: string): { valid: boolean; reason?: string };

export interface DocFreshnessStats {
  totalDocs: number;
  staleDocs: number;
  freshDocs: number;
  totalReferences: number;
  freshnessRate: number;
  watching: boolean;
}

export interface StaleDocInfo {
  path: string;
  reason: string | null;
  lastVerifiedAt: number;
  references: string[];
}

export declare class DocFreshnessGuard {
  constructor(options?: { projectRoot?: string });
  attachProjectRoot(projectRoot: string): DocFreshnessGuard;
  startWatching(): void;
  stopWatching(): void;
  handleCodeChange(filePath: string, changeType: string): StaleDocInfo[];
  getStaleDocs(): StaleDocInfo[];
  markDocVerified(docPath: string): boolean;
  getDocIndex(): Array<{ path: string; referenceCount: number; stale: boolean; staleReason: string | null; lastVerifiedAt: number }>;
  getFreshnessStats(): DocFreshnessStats;
  validateFreshness(): { valid: boolean; newlyStale: number; totalStale: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export function create(projectRoot: string, options?: { strictValidation?: boolean }): HarnessInstance;

export declare class SubagentExecutor {
  constructor(options?: { maxSubagents?: number; timeout?: number });
  spawn(config: { agentId: string; task: string; capabilities?: string[] }): { subagentId: string; status: string };
  cancel(subagentId: string): boolean;
  getResult(subagentId: string): unknown;
  listActive(): Array<{ subagentId: string; agentId: string; status: string; startedAt: number }>;
  shutdown(): void;
  isHealthy(): boolean;
}

export interface PipelineStage {
  name: string;
  handler: Function;
  timeout?: number;
}

export interface PipelineRunResult {
  success: boolean;
  iterations: number;
  bestScore: number;
  qualityHistory: number[];
}

export declare class DeepeningPipeline {
  constructor(config?: Record<string, unknown>);
  initialize(): boolean;
  run(task: Record<string, unknown>, agents: Record<string, unknown> | Array<Record<string, unknown>>): Promise<PipelineRunResult>;
  addStage(stage: PipelineStage): void;
  getModule(name: string): Record<string, unknown> | null;
  generateReport(type: string): Record<string, unknown>;
  getStats(): { initialized: boolean; moduleCount: number; modules: string[]; pipelineRuns: number; healthy: boolean; shutDown: boolean };
  shutdown(): void;
  isHealthy(): boolean;
  static PIPELINE_STAGES: { INIT: string; CACHE_CHECK: string; ITERATIVE_EXECUTION: string; COMPLETE: string };
}

export interface SkillGraphNode {
  skillId: string;
  metadata: Record<string, unknown>;
}

export interface SkillGraphEdge {
  from: string;
  to: string;
  type: 'dependency' | 'blocking' | 'semantic' | 'causal';
  weight: number;
}

export declare class SkillGraph {
  constructor(config?: { maxNodes?: number; maxEdges?: number; semanticMatchThreshold?: number });
  addNode(skillId: string, metadata?: Record<string, unknown>): boolean;
  addEdge(fromId: string, toId: string, edgeType: string, weight?: number): boolean;
  buildFromSkills(skills: SkillDef[]): void;
  topologicalSort(): string[] | null;
  hasCycle(): boolean;
  getDependents(skillId: string): string[];
  getDependencies(skillId: string): string[];
  getImpactAnalysis(skillId: string): { affectedNodes: string[]; dependencyChain: string[][] };
  getStats(): { nodeCount: number; edgeCount: number; edgeTypeCounts: Record<string, number> };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class LayerBoundaryGuard {
  constructor(options?: { enforcement?: Enforcement; layers?: string[] });
  checkViolation(sourceFile: string, targetFile: string): { violation: boolean; sourceLayer: string; targetLayer: string; reason?: string };
  checkFile(filePath: string): Array<{ target: string; sourceLayer: string; targetLayer: string; reason: string }>;
  getLayerForFile(filePath: string): string | null;
  getStats(): { totalChecks: number; violations: number; layerCounts: Record<string, number> };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class ArchitectureBoundaryEnforcer {
  constructor(options?: { enforcement?: Enforcement; constraintMatrix?: Record<string, string[]> });
  defineConstraint(fromModule: string, allowedTargets: string[]): void;
  checkImport(sourceModule: string, targetModule: string): { allowed: boolean; reason?: string };
  checkFile(filePath: string): Array<{ source: string; target: string; allowed: boolean; reason: string }>;
  getConstraintMatrix(): Record<string, string[]>;
  getStats(): { totalChecks: number; violations: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class CodeDriftDetector {
  constructor(options?: { violationGrowthThreshold?: number; couplingThreshold?: number; layerImbalanceThreshold?: number });
  recordSnapshot(snapshot: { violations: number; couplingScore: number; layerDistribution: Record<string, number> }): void;
  detectDrift(): { drifted: boolean; signals: Array<{ type: string; severity: string; description: string; trend: string }> };
  getHistory(): Array<{ timestamp: string; violations: number; couplingScore: number }>;
  getStats(): { snapshots: number; driftDetections: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class ContextCompressionEngine {
  constructor(options?: { maxTokens?: number; keepRatio?: number });
  classify(items: Array<{ content: string; priority?: number }>): { keep: unknown[]; summarize: unknown[]; discard: unknown[] };
  compress(context: Record<string, unknown>, tokenBudget: number): { compressed: Record<string, unknown>; originalTokens: number; compressedTokens: number; ratio: number };
  getStats(): { totalCompressions: number; averageRatio: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class SqliteStore {
  constructor(dbPath: string, options?: { walMode?: boolean; busyTimeout?: number });
  open(): void;
  close(): void;
  addKnowledge(entry: { category: string; title: string; content: string; tags?: string[]; source?: string }): Record<string, unknown> | null;
  getKnowledge(id: string): Record<string, unknown> | null;
  searchKnowledge(query: string, options?: { category?: string; limit?: number }): Record<string, unknown>[];
  addSkillLearning(entry: { skillId: string; phase?: string; approach?: string; whatWorked?: string[]; whatFailed?: string[]; tips?: string[] }): Record<string, unknown> | null;
  getSkillLearnings(skillId: string): Record<string, unknown>[];
  getSkillTips(skillId: string): string[];
  getSkillAvoidances(skillId: string): string[];
  decayMemoryImportance(): void;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class MCPClient {
  constructor(options?: { projectRoot?: string; maxResponseSize?: number });
  connect(config: { name: string; type: 'stdio' | 'http'; command?: string; args?: string[]; url?: string }): { serverId: string; status: string };
  disconnect(serverId: string): boolean;
  listTools(serverId: string): Promise<Array<{ name: string; description: string }>>;
  callTool(serverId: string, toolName: string, args?: Record<string, unknown>): Promise<unknown>;
  listServers(): Array<{ serverId: string; name: string; status: string }>;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class ProgrammableHookExecutor {
  constructor(options?: { timeout?: number });
  registerHook(hookName: string, handler: (context: Record<string, unknown>) => Record<string, unknown> | void, options?: { priority?: number; blocking?: boolean }): boolean;
  removeHook(hookName: string, handlerId: string): boolean;
  execute(hookName: string, context: Record<string, unknown>): Promise<{ executed: number; blocked: boolean; errors: Array<{ handlerId: string; error: string }> }>;
  getHooks(hookName?: string): Record<string, Array<{ handlerId: string; priority: number; blocking: boolean }>>;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class CommandRouter {
  constructor(projectRoot: string);
  discover(): void;
  match(input: string): { command: string; args: Record<string, unknown>; confidence: number } | null;
  listCommands(): Array<{ name: string; aliases: string[]; description: string; skillChain: string[] }>;
  shutdown(): void;
  isHealthy(): boolean;
}

export interface SimulateAction {
  name: string;
  effects: Map<string, { operator: string; value: number }> | Record<string, unknown>;
  probability: number;
  preconditions?: Record<string, unknown>;
}

export interface SimulateOptions {
  initialState: Map<string, number>;
  actions: SimulateAction[];
  maxDepth?: number;
  maxBranches?: number;
  confidenceThreshold?: number;
}

export interface SimulationBranch {
  id: string;
  states: Map<string, number>[];
  confidence: number;
  depth: number;
}

export interface SimulationSummary {
  totalBranches: number;
  avgConfidence: number;
  maxDepth: number;
  topOutcome: Map<string, number>;
}

export interface SimulationResult {
  branches: SimulationBranch[];
  summary: SimulationSummary;
}

export declare class SimulationEngine {
  constructor(options?: Record<string, unknown>);
  simulate(options: SimulateOptions): Promise<SimulationResult>;
  getSimulation(simulationId: string): Record<string, unknown> | null;
  listSimulations(limit?: number): SimulationSummary[];
  counterfactual(actualState: Record<string, unknown>, actualAction: SimulateAction, alternativeAction: SimulateAction, depth?: number): { actualOutcome: unknown; counterfactualOutcome: unknown; divergence: Record<string, unknown>; insight: string };
  forwardPredict(cause: { description: string; variables?: Map<string, number> | Record<string, number>; context?: Record<string, unknown> }, depth?: number): Promise<{ predictions: Array<Record<string, unknown>>; consensusConfidence: number }>;
  attachCausalMemoryStore(store: unknown): SimulationEngine;
  attachCausalDataBus(bus: CausalDataBus): SimulationEngine;
  generateReport(simulationId: string): string | null;
  getStats(): { simulationsTotal: number; counterfactualsTotal: number; forwardPredictionsTotal: number; avgBranchCount: number; avgConfidence: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export interface PredictorScenarioDefinition {
  name: string;
  description: string;
  variables: string[];
  constraints?: object;
}

export interface MonteCarloOptions {
  iterations?: number;
  timeSteps?: number;
  confidenceLevel?: number;
}

export interface MonteCarloResult {
  scenarios: object[];
  statistics: object;
  riskMetrics: object;
}

export declare class ScenarioPredictor {
  constructor();
  defineScenario(options: PredictorScenarioDefinition): string;
  getScenario(scenarioId: string): Record<string, unknown> | null;
  listScenarios(): Array<Record<string, unknown>>;
  removeScenario(scenarioId: string): boolean;
  runMonteCarlo(scenarioId: string, options?: MonteCarloOptions): Promise<MonteCarloResult>;
  getMonteCarloResult(runId: string): Record<string, unknown> | null;
  listMonteCarloResults(scenarioId: string, limit?: number): Array<Record<string, unknown>>;
  compareScenarios(scenarioId1: string, scenarioId2: string, metric: string): Record<string, unknown>;
  sensitivityAnalysis(scenarioId: string, targetVariable: string): Record<string, unknown>;
  generatePredictionReport(scenarioId: string, runId: string): string;
  attachComputeAccelerator(accelerator: unknown): ScenarioPredictor;
  getStats(): { scenariosTotal: number; monteCarloRunsTotal: number; avgIterations: number; avgConfidence: number };
  shutdown(): void;
  isHealthy(): boolean;
}

export interface WorldLineConfig {
  initialState: Map<string, number>;
  description?: string;
}

export interface WorldLineMergeResult {
  success: boolean;
  mergedLineId: string;
  probability: number;
}

export declare class WorldLineManager {
  constructor();
  createWorldLine(config: WorldLineConfig): string;
  getWorldLine(worldLineId: string): Record<string, unknown> | null;
  listWorldLines(status?: string): Array<Record<string, unknown>>;
  removeWorldLine(worldLineId: string): boolean;
  branchFrom(worldLineId: string, branchName: string, divergencePoint: { step: number; action: string; reason: string }): Record<string, unknown>;
  mergeWorldLines(sourceId: string, targetId: string, strategy?: string): WorldLineMergeResult;
  getBranchTree(worldLineId: string): { root: Record<string, unknown> | null; children: Array<Record<string, unknown>> };
  advanceStep(worldLineId: string, action: { name: string; effects: object; probability: number }, result: { success: boolean; actualEffects: object; confidence: number }): Record<string, unknown>;
  rollbackToStep(worldLineId: string, stepIndex: number): Record<string, unknown> | null;
  getStateAtStep(worldLineId: string, stepIndex: number): Record<string, unknown> | null;
  computeProbability(worldLineId: string): { probability: number; pathLength: number; confidenceInterval: { lower: number; upper: number } };
  compareWorldLines(lineId1: string, lineId2: string): { variableDifferences: Map<string, { line1: unknown; line2: unknown; delta: number }>; probabilityRatio: number; divergenceStep: number | null };
  generateTimeline(worldLineId: string): string;
  getStats(): { worldLinesTotal: number; activeLines: number; maxDepth: number; avgBranchFactor: number; totalSteps: number };
  shutdown(): void;
  isHealthy(): boolean;
  static MERGE_STRATEGIES: { UNION: 'union'; INTERSECTION: 'intersection'; WEIGHTED_AVERAGE: 'weighted-average'; LATEST_WINS: 'latest-wins' };
  static MAX_WORLD_LINES: number;
}

export interface PairChatOptions {
  agentA: string;
  agentB: string;
  topic?: string;
}

export interface CrossValidationOptions {
  agentA: string;
  agentB: string;
  artifact: string;
  artifactType: string;
  mode: string;
  validationCriteria?: object[];
}

export interface ChatRound {
  from: string;
  to: string;
  content: string;
}

export interface CrossValidationRound {
  from: string;
  to: string;
  hallucinationCorrections?: object[];
  criteriaResults?: object[];
}

export interface CrossValidationReport {
  sessionId: string;
  rounds: number;
  hallucinationsFound: number;
  criteriaPassed: number;
  criteriaTotal: number;
}

export declare class PairChat {
  constructor(options?: Record<string, unknown>);
  startSession(options: PairChatOptions): { sessionId: string };
  startCrossValidation(options: CrossValidationOptions): { sessionId: string };
  addRound(sessionId: string, round: ChatRound): void;
  addCrossValidationRound(sessionId: string, round: CrossValidationRound): void;
  getCrossValidationReport(sessionId: string): CrossValidationReport;
  getSession(sessionId: string): Record<string, unknown> | null;
  getSessionSummary(sessionId: string): Record<string, unknown> | null;
  destroySession(sessionId: string): boolean;
  getCrossValidationStats(): { totalCrossValidations: number; totalHallucinationCorrections: number; totalValidationCriteriaPassed: number; totalValidationCriteriaFailed: number; avgHallucinationCorrectionsPerSession: number };
  getStats(): { activeSessions: number; totalSessions: number; timedOutSessions: number; totalRounds: number; totalCorrections: number; avgCorrectionsPerSession: string | number; avgRoundsPerSession: string | number; crossValidation: Record<string, unknown> };
  shutdown(): void;
  static CHAT_ROLES: { PROPOSER: string; REVIEWER: string };
  static CONSENSUS_STATES: { REACHED: string; PENDING: string; FAILED: string };
  static CROSS_VALIDATION_MODES: { UNIDIRECTIONAL: string; BIDIRECTIONAL: string };
  static HALLUCINATION_SEVERITY: { LOW: string; MEDIUM: string; HIGH: string; CRITICAL: string };
}

export interface ChainOptions {
  name: string;
  description?: string;
}

export interface ChainTask {
  name: string;
  agent: string;
  dependencies?: string[];
}

export interface ArtifactData {
  name: string;
  type: string;
  phase: string;
  content?: string;
}

export interface ArtifactFlowResult {
  artifacts: ArtifactData[];
  phases: string[];
}

export declare class ChatChain {
  constructor(options?: Record<string, unknown>);
  createChain(options: ChainOptions): { chainId: string };
  addTask(chainId: string, task: ChainTask): void;
  registerArtifact(chainId: string, artifact: ArtifactData): void;
  getArtifactFlow(chainId: string): ArtifactFlowResult;
  startTask(chainId: string, taskId: string): Record<string, unknown>;
  completeTask(chainId: string, taskId: string, result?: Record<string, unknown>): Record<string, unknown>;
  failTask(chainId: string, taskId: string, error?: string): Record<string, unknown>;
  retryTask(chainId: string, taskId: string): Record<string, unknown>;
  skipTask(chainId: string, taskId: string, reason?: string): Record<string, unknown>;
  getPhaseArtifacts(chainId: string, phase: string): Array<Record<string, unknown>> | null;
  getArtifact(chainId: string, artifactId: string): Record<string, unknown> | null;
  getLatestArtifactByName(chainId: string, name: string): Record<string, unknown> | null;
  getChain(chainId: string): Record<string, unknown> | null;
  getChainProgress(chainId: string): Record<string, unknown> | null;
  getStats(): { totalChains: number; completedChains: number; failedChains: number; totalTasks: number; completedTasks: number; activeChains: number; taskCompletionRate: string | number; chainCompletionRate: string | number; totalArtifacts: number };
  shutdown(): void;
  static TASK_STATUS: Record<string, string>;
  static ATOMIC_TASK_CHAINS: Record<string, Array<Record<string, unknown>>>;
}

export interface ProjectOptions {
  name: string;
  description?: string;
  agentCount?: number;
}

export interface PhaseStats {
  fileCount?: number;
  hallucinationCorrections?: number;
  artifactCount?: number;
  tokenUsage?: { input?: number; output?: number; total?: number };
}

export interface ProjectReport {
  projectId: string;
  projectName: string;
  status: string;
  totalDurationMs: number;
  estimatedCost: number;
  totalFiles: number;
  totalHallucinationCorrections: number;
  tokenUsage: { input: number; output: number; total: number };
  phaseBreakdown: Record<string, PhaseStats & { durationMs: number; estimatedCost: number }>;
}

export declare class DevMetricsCollector {
  constructor(options?: Record<string, unknown>);
  startProject(options: ProjectOptions): { projectId: string };
  startPhase(projectId: string, phaseName: string): void;
  completePhase(projectId: string, phaseName: string, stats?: PhaseStats): void;
  recordHallucinationCorrection(projectId: string, phase: string, count: number): void;
  recordTokenUsage(projectId: string, phase: string, tokenUsage: { input?: number; output?: number; total?: number }): Record<string, unknown>;
  recordFileCount(projectId: string, phase: string, count: number): Record<string, unknown>;
  completeProject(projectId: string): void;
  generateReport(projectId: string): ProjectReport;
  getProject(projectId: string): Record<string, unknown> | null;
  getGlobalStats(): { totalProjects: number; completedProjects: number; avgDurationSeconds: number; avgCost: number; avgFiles: number; avgHallucinationCorrections: number; totalHallucinationCorrections: number };
  getHistory(limit?: number): Array<Record<string, unknown>>;
  estimateTokens(text: string): number;
  shutdown(): void;
  static METRIC_TYPES: Record<string, string>;
}

export interface DreamNote {
  category: string;
  content: string;
  confidence: number;
  timestamp: number;
}

export interface DreamResult {
  notes: DreamNote[];
  patterns: string[];
  suggestions: string[];
}

export declare class DreamEngine {
  constructor(options?: Record<string, unknown>);
  dream(sessionData: object): DreamResult;
  processSession(session: object): DreamNote[];
  getNotes(category?: string, minConfidence?: number): DreamNote[];
  getRelevantNotes(context: string): DreamNote[];
  syncNotesToStores(minConfidence?: number): { synced: number; errors: number };
  attachSqliteStore(sqliteStore: object | null): void;
  attachThoughtMemoryStore(thoughtMemoryStore: object | null): void;
  attachEmbeddingService(embeddingService: object | null): void;
  attachBrainMemory(brainMemory: object | null): void;
  attachMemoryStore(memoryStore: object | null): void;
  getStats(): object;
  isHealthy(): boolean;
  shutdown(): void;
  static DEFAULT_CONFIG: object;
  static NOTE_CATEGORIES: Record<string, string>;
  static PATTERN_TYPES: Record<string, string>;
}

export interface PipelineConfig {
  syncIntervalMs?: number;
  prefetchEnabled?: boolean;
}

export interface RecallResult {
  items: object[];
  source: string;
  confidence: number;
}

export declare class MemoryPipeline {
  constructor(options?: PipelineConfig);
  attachComponent(name: string, component: object): void;
  initialize(): Promise<void>;
  recall(query: string, options?: object): Promise<RecallResult>;
  sync(): Promise<void>;
  prefetch(signals: object[]): void;
  attachExternalProvider(name: string, provider: object, options?: Record<string, unknown>): void;
  detachExternalProvider(name: string): void;
  onPhaseChange(phaseInfo: object): void;
  onIntentParsed(intentResult: object): void;
  onTaskAssigned(taskInfo: object): void;
  onUserInteraction(interactionInfo: object): void;
  getStats(): object;
  isHealthy(): boolean;
  shutdown(): Promise<void>;
  static PIPELINE_STAGES: Record<string, string>;
  static DEFAULT_PIPELINE_CONFIG: object;
}

export interface EnsembleConfig {
  mode: 'bagging' | 'boosting' | 'stacking';
  agents: object[];
  weights?: number[];
}

export interface EnsembleResult {
  output: any;
  confidence: number;
  mode: string;
  agentCount: number;
}

export declare class EnsembleOrchestrator {
  constructor(options?: { maxRounds?: number; earlyStopPatience?: number; qualityThreshold?: number; bootstrapRatio?: number; featureSampleRatio?: number; learningRate?: number });
  execute(task: object, agents: object[], executeFn: (agent: object, task: object) => Promise<EnsembleResult>, options?: { mode?: string }): Promise<EnsembleResult>;
  setContributionTracker(tracker: object): void;
  getStats(): object;
  shutdown(): void;
  isHealthy(): boolean;
  static ENSEMBLE_MODES: { BAGGING: 'bagging'; BOOSTING: 'boosting'; STACKING: 'stacking' };
}

export interface CompilerManifest {
  files: string[];
  dependencies: Map<string, string[]>;
  entryPoints: string[];
}

export interface ClusterResult {
  clusters: Map<string, string[]>;
  centroids: Map<string, number[]>;
}

export interface GraphQuery {
  pattern: string;
  maxDepth?: number;
  minSimilarity?: number;
}

export declare class GraphifyCompiler {
  constructor(config?: Record<string, unknown>);
  compile(sources: string[]): CompilerManifest;
  compileIncremental(projectRoot: string, changedFiles: string[]): Promise<{ success: boolean; reprocessedFiles?: number; nodeCount: number; edgeCount: number; error?: string }>;
  cluster(options?: object): ClusterResult;
  query(q: GraphQuery): object[];
  getNode(nodeId: string): Record<string, unknown> | null;
  getEdges(nodeId: string): Array<Record<string, unknown>>;
  getCluster(clusterId: string): Record<string, unknown> | null;
  getReport(): string | null;
  getStats(): object;
  getCostReport(): { totalTokens: number; totalCalls: number; stages: Record<string, unknown> };
  getManifest(): { version: number; createdAt: string | null; updatedAt: string | null; fileHashes: Record<string, string> };
  shutdown(): void;
  isHealthy(): boolean;
  static PIPELINE_STAGES: string[];
}

// === Runtime - Model Subsystem ===
export class TokenManager {
  constructor(options?: Record<string, unknown>);
  checkBudget(tokens: number): boolean;
  recordUsage(category: string, tokens: number): void;
  getStats(): Record<string, unknown>;
}

export class EmbeddingService {
  constructor(options?: Record<string, unknown>);
  embed(text: string): Promise<number[]>;
  similarity(a: number[], b: number[]): number;
}

export class ModelSelector {
  constructor(options?: Record<string, unknown>);
  select(task: string): Record<string, unknown>;
  getStats(): Record<string, unknown>;
}

// === Runtime - Quality Subsystem ===
export class SelfReflection {
  constructor(options?: Record<string, unknown>);
  reflect(output: string, context?: Record<string, unknown>): Record<string, unknown>;
}

export class FeedbackCredibility {
  constructor(options?: Record<string, unknown>);
  assess(source: string, feedback: string): number;
}

export class AiCodeTrustScorer {
  constructor(options?: Record<string, unknown>);
  score(code: string, source?: string): Record<string, unknown>;
  getTrend(source: string): Record<string, unknown>;
}

export class ComprehensionDebtTracker {
  constructor(options?: Record<string, unknown>);
  track(type: string, severity: string): void;
  getScore(): number;
  resolve(id: string): boolean;
}

export class DeliveryEfficiencyMeter {
  constructor(options?: Record<string, unknown>);
  record(stage: string, durationMs: number): void;
  getMetrics(): Record<string, unknown>;
}

export class SelfEvolutionGovernor {
  constructor(options?: Record<string, unknown>);
  isAllowed(operation: string): boolean;
  getStats(): Record<string, unknown>;
}

// === Runtime - Agent Subsystem ===
export class AgentPackManager {
  constructor(options?: Record<string, unknown>);
  pack(agentId: string): Record<string, unknown>;
  deploy(pack: Record<string, unknown>): boolean;
}

export class AgentDebugLoop {
  constructor(options?: Record<string, unknown>);
  run(testCommand: string, maxIterations?: number): Promise<Record<string, unknown>>;
}

export declare class MoeGatingRouter {
  constructor(options?: Record<string, unknown>);
  route(task: Record<string, unknown>, agents: string[]): string;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

export declare class ContextMapper {
  constructor(options?: Record<string, unknown>);
  map(context: Record<string, unknown>): Record<string, unknown>;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

// === Runtime - Collaboration Subsystem ===
export class AgentDiversityManager {
  constructor(options?: Record<string, unknown>);
  assess(agentIds: string[]): Record<string, unknown>;
  recommendMode(diversityScore: number): string;
}

export class AgentContributionTracker {
  constructor(options?: Record<string, unknown>);
  record(agentId: string, contribution: Record<string, unknown>): void;
  getTopContributors(limit?: number): Record<string, unknown>[];
}

export class CollaborationModeRouter {
  constructor(options?: Record<string, unknown>);
  route(task: Record<string, unknown>, agents: string[]): string;
  checkAntiPatterns(mode: string): string[];
}

// === Runtime - Thought Subsystem ===
export class DreamScheduler {
  constructor(options?: Record<string, unknown>);
  schedule(intervalMs: number): void;
  triggerManual(): Promise<Record<string, unknown>>;
}

// === Gate Subsystem ===
export class ErrorPreventionGuard {
  constructor(options?: Record<string, unknown>);
  check(code: string): string[];
  registerPattern(pattern: Record<string, unknown>): void;
}

export class OutputConcisenessGuard {
  constructor(options?: Record<string, unknown>);
  check(output: string): Record<string, unknown>;
}

export class KarpathyEnhancer {
  constructor(options?: Record<string, unknown>);
  enhance(code: string): Record<string, unknown>;
}

export const DesignTokens: Record<string, unknown>;

export const SharedRuleHelpers: Record<string, unknown>;

// === Runtime - Workflow Subsystem ===
export class ExecutionModeManager {
  constructor(options?: Record<string, unknown>);
  getMode(): string;
  setMode(mode: string): void;
}

export class SprintCycle {
  constructor(options?: Record<string, unknown>);
  start(goal: string): string;
  complete(sprintId: string): Record<string, unknown>;
}

export class ToolAdapter {
  constructor(options?: Record<string, unknown>);
  adapt(tool: Record<string, unknown>): Record<string, unknown>;
}

export class OptimizationLoop {
  constructor(options?: Record<string, unknown>);
  start(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(): void;
}

// === Runtime - TUI Subsystem ===
export class TUIApp {
  constructor(options?: Record<string, unknown>);
  start(): void;
  stop(): void;
}

export class REPLEngine {
  constructor(options?: Record<string, unknown>);
  execute(input: string): Promise<string>;
}

export class PersonaManager {
  constructor(options?: Record<string, unknown>);
  getActive(): string;
  switch(personaId: string): void;
}

export class QuickCommandRegistry {
  register(command: string, handler: Function): void;
  find(input: string): Record<string, unknown> | null;
}

// === Runtime - Deepening Subsystem ===
export class DeepeningModuleRegistry {
  register(name: string, module: Record<string, unknown>): void;
  get(name: string): Record<string, unknown> | undefined;
  list(): string[];
}

// === Infrastructure - Recently Activated ===
export class ConversationContextStore {
  constructor(options?: Record<string, unknown>);
  startSession(sessionId: string, metadata?: Record<string, unknown>): void;
  recordTurn(sessionId: string, role: string, content: string): void;
  endSession(sessionId: string): void;
  pinSession(sessionId: string, pinned: boolean): void;
  exportSession(sessionId: string, format?: string): Record<string, unknown>;
  searchTurns(query: string, limit?: number): Record<string, unknown>[];
  getSessionContext(sessionId: string): Record<string, unknown>;
}

export class ServiceFs {
  mount(serviceName: string, adapter: Record<string, unknown>): void;
  ls(path: string): Record<string, unknown>[];
  cat(path: string): string;
  write(path: string, content: string): boolean;
  rm(path: string): boolean;
  exists(path: string): boolean;
  tree(path?: string | null, depth?: number): string;
  resolve(path: string): Record<string, unknown>;
}

// === Anthropic Harness Design Fusion ===

/**
 * 任务生命周期编排器——融合自Anthropic Harness三层体系设计。
 * Planner→Generator→Evaluator三层分离运行时，防止Context Anxiety和Self-Evaluation偏差。
 */
export class TaskLifecycleOrchestrator {
  constructor(options?: { maxRounds?: number; evaluationThreshold?: number; contextResetTokenRatio?: number; enableCompaction?: boolean; enableContextReset?: boolean });
  attachSddContractManager(manager: object): this;
  attachGoalExecutor(executor: object): this;
  attachGeneratorVerifier(verifier: object): this;
  attachQualityScorer(scorer: object): this;
  attachContextCompressionEngine(engine: object): this;
  attachSessionResumptionProtocol(protocol: object): this;
  attachTokenManager(manager: object): this;
  execute(requirement: string, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
  getStatus(): Record<string, unknown>;
  getEvaluationHistory(): Record<string, unknown>[];
}

/**
 * 动态工作流 Harness 生成器——融合自Anthropic Dynamic Workflow Harness。
 * AI自动生成JavaScript调度脚本→沙箱执行→确定性编排。
 * 三大突破：确定性代码框住概率输出、自带对抗验证、留痕容灾。
 */
export class DynamicHarnessGenerator {
  constructor(options?: {
    maxParallelAgents?: number;
    tokenBudget?: number;
    scriptTimeoutMs?: number;
    enableAdversarialReview?: boolean;
    autoCheckpoint?: boolean;
    enableGapAnalysis?: boolean;
    maxRetries?: number;
  });
  attachLLMClient(client: object): this;
  attachSkillExecutor(executor: object): this;
  attachSubagentExecutor(executor: object): this;
  attachAdversarialReview(review: object): this;
  attachCheckpointManager(manager: object): this;
  attachTaskDecomposer(decomposer: object): this;
  attachCapabilityGapAnalyzer(analyzer: object): this;
  attachDynamicWorkflowEngine(engine: object): this;
  generateAndExecute(taskDescription: string, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
  resumeFromCheckpoint(checkpointId: string): Promise<Record<string, unknown>>;
  cancel(): void;
  getStatus(): string;
  getStats(): Record<string, unknown>;
  getHistory(limit?: number): Record<string, unknown>[];
  on(event: string, listener: Function): this;
  shutdown(): void;
  guardShutdown(): void;
  isHealthy(): boolean;
  static isTriggered(taskDescription: string): boolean;
}

/** Harness 状态枚举 */
export const HARNESS_STATUS: {
  IDLE: 'idle';
  GENERATING: 'generating';
  COMPILING: 'compiling';
  EXECUTING: 'executing';
  PAUSED: 'paused';
  CHECKPOINTING: 'checkpointing';
  VERIFYING: 'verifying';
  COMPLETED: 'completed';
  FAILED: 'failed';
  CANCELLED: 'cancelled';
};

/** 动态工作流触发关键词（英文 + 中文） */
export const TRIGGER_KEYWORDS: string[];

/**
 * 评估校准器——融合自Anthropic Harness设计理念中的Self-Evaluation偏差校正。
 * 追踪模型置信度vs实际通过率，自动调整评估阈值。
 */
export class EvaluationCalibrator {
  constructor(options?: { windowSize?: number; overestimateThreshold?: number; adjustmentFactor?: number; maxThresholdAdjustment?: number });
  record(confidence: number, passed: boolean): void;
  getCalibratedThreshold(baseThreshold: number): number;
  getCalibrationReport(): Record<string, unknown>;
}

/**
 * Harness迁移性引擎——融合自Anthropic Harness设计理念中的"动态承重调整"。
 * 根据模型能力等级动态调整Harness组件的承重与可删。
 */
export class HarnessMigrationEngine {
  constructor(options?: { componentRegistry?: Record<string, unknown> });
  attachCalibrationData(report: Record<string, unknown>): this;
  updateTier(tier: 'weak' | 'standard' | 'strong' | 'frontier'): Record<string, unknown>;
  getActiveComponents(): string[];
  getMigrationReport(): Record<string, unknown>;
}

// === staticExports 补全声明 ===

export class WebSocketHandler {
  constructor(options?: Record<string, unknown>);
  broadcast(channel: string, data: unknown): void;
  getClients(): unknown[];
}

export class IsolatedContextManager {
  constructor(options?: Record<string, unknown>);
  isolate(agentId: string): Record<string, unknown>;
  release(agentId: string): void;
}

export class PlanPersistence {
  constructor(options?: Record<string, unknown>);
  save(plan: Record<string, unknown>): string;
  load(planId: string): Record<string, unknown> | null;
}

export class StructuredIntent {
  constructor(options?: Record<string, unknown>);
  parse(input: string): Record<string, unknown>;
}

export class MemoryNudge {
  constructor(options?: Record<string, unknown>);
  nudge(context: Record<string, unknown>): Record<string, unknown>;
}

export class SkillCreationEngine {
  constructor(options?: Record<string, unknown>);
  createFromTemplate(template: Record<string, unknown>): Record<string, unknown>;
}

export class SkillCurator {
  constructor(options?: Record<string, unknown>);
  curate(skillId: string): Record<string, unknown>;
}

export class SkillEvolver {
  constructor(options?: Record<string, unknown>);
  evolve(skillId: string, feedback: Record<string, unknown>): Record<string, unknown>;
}

export class MetaSkillOrchestrator {
  constructor(options?: Record<string, unknown>);
  orchestrate(task: Record<string, unknown>): Record<string, unknown>;
}

export class MetaSkillGenerator {
  constructor(options?: Record<string, unknown>);
  generate(spec: Record<string, unknown>): Record<string, unknown>;
}

export class UserModelManager {
  constructor(options?: Record<string, unknown>);
  getUserModel(userId: string): Record<string, unknown>;
  updateUserModel(userId: string, data: Record<string, unknown>): void;
}

export class AutoVersionTracker {
  constructor(options?: Record<string, unknown>);
  track(skillId: string, version: string): Record<string, unknown>;
}

export class SignalPersistence {
  constructor(options?: Record<string, unknown>);
  persist(signal: Record<string, unknown>): Record<string, unknown>;
  load(signalId: string): Record<string, unknown> | null;
}

export class SkillPatchApproval {
  constructor(options?: Record<string, unknown>);
  requestApproval(patch: Record<string, unknown>): string;
  approve(requestId: string): void;
  reject(requestId: string, reason?: string): void;
}

export class PriorityQueue {
  constructor(options?: Record<string, unknown>);
  enqueue(item: unknown, priority: number): void;
  dequeue(): unknown;
  peek(): unknown;
  get size(): number;
}

export class CausalVectorIndex {
  constructor(options?: Record<string, unknown>);
  index(vector: number[], metadata: Record<string, unknown>): string;
  search(vector: number[], k?: number): Record<string, unknown>[];
}

export class CausalBufferManager {
  constructor(options?: Record<string, unknown>);
  buffer(data: Record<string, unknown>): void;
  flush(): Record<string, unknown>[];
}

export class HumanApprovalGate {
  constructor(options?: Record<string, unknown>);
  requestApproval(request: Record<string, unknown>): string;
  isApproved(requestId: string): boolean;
}

export class RiskBasedApprovalGate {
  constructor(options?: Record<string, unknown>);
  assessRisk(action: Record<string, unknown>): Record<string, unknown>;
  requestApproval(action: Record<string, unknown>): string;
}

export class RAGPipeline {
  constructor(options?: Record<string, unknown>);
  query(question: string): Promise<Record<string, unknown>>;
  indexDocument(doc: Record<string, unknown>): void;
}

export class ThoughtExtractor {
  constructor(options?: Record<string, unknown>);
  extract(content: string): Record<string, unknown>[];
}

export class ThoughtDeduplicator {
  constructor(options?: Record<string, unknown>);
  deduplicate(thoughts: Record<string, unknown>[]): Record<string, unknown>[];
}

export class ThoughtMemoryStore {
  constructor(options?: Record<string, unknown>);
  store(thought: Record<string, unknown>): string;
  retrieve(thoughtId: string): Record<string, unknown> | null;
}

export class ThoughtRetrieverCycle {
  constructor(options?: Record<string, unknown>);
  run(query: string): Promise<Record<string, unknown>[]>;
}

export class CostAwareRouter {
  constructor(options?: Record<string, unknown>);
  route(request: Record<string, unknown>): Record<string, unknown>;
}

export class BusinessGoal {
  constructor(options?: Record<string, unknown>);
  define(goal: Record<string, unknown>): string;
  trackProgress(goalId: string): Record<string, unknown>;
}

export class PlaybookGenerator {
  constructor(options?: Record<string, unknown>);
  generate(scenario: Record<string, unknown>): Record<string, unknown>;
}

export class SkillTreeDAG {
  constructor(options?: Record<string, unknown>);
  addNode(id: string, data: Record<string, unknown>): void;
  addEdge(from: string, to: string): void;
  topologicalSort(): string[];
}

export class InferenceCache {
  constructor(options?: Record<string, unknown>);
  get(key: string): Record<string, unknown> | null;
  set(key: string, value: Record<string, unknown>, ttl?: number): void;
  invalidate(key: string): void;
}

export class TUIOrchestrator {
  constructor(options?: Record<string, unknown>);
  start(): void;
  stop(): void;
  render(): void;
}

// === lazyExports 补全声明 ===

export class SharedInfrastructure {
  constructor(options?: Record<string, unknown>);
  registerService(name: string, service: unknown): void;
  getService(name: string): unknown;
}

export class SkillWrapper {
  constructor(options?: Record<string, unknown>);
  wrap(skill: Record<string, unknown>): Record<string, unknown>;
}

export class AutoregressiveContextSchema {
  constructor(options?: Record<string, unknown>);
  validate(context: Record<string, unknown>): boolean;
  encode(context: Record<string, unknown>): Record<string, unknown>;
}

export class OodaLoop {
  constructor(options?: Record<string, unknown>);
  observe(data: Record<string, unknown>): Record<string, unknown>;
  orient(observation: Record<string, unknown>): Record<string, unknown>;
  decide(orientation: Record<string, unknown>): Record<string, unknown>;
  act(decision: Record<string, unknown>): Record<string, unknown>;
}

export class CodeGraph {
  constructor(options?: Record<string, unknown>);
  addNode(id: string, data: Record<string, unknown>): void;
  addEdge(from: string, to: string): void;
  getDependencies(nodeId: string): string[];
}

export class TriAttention {
  constructor(options?: Record<string, unknown>);
  attend(query: Record<string, unknown>, context: Record<string, unknown>): Record<string, unknown>;
}

export class SkillDiscoverUtils {
  constructor(options?: Record<string, unknown>);
  discover(directory: string): Record<string, unknown>[];
}

export class BrainMemory {
  constructor(options?: Record<string, unknown>);
  store(key: string, value: unknown): void;
  retrieve(key: string): unknown;
  consolidate(): Record<string, unknown>;
}

export class LlmWiki {
  constructor(options?: Record<string, unknown>);
  initialize(): Promise<void>;
  query(topic: string): Promise<Record<string, unknown>>;
}

export class MemoryPrefetcher {
  constructor(options?: Record<string, unknown>);
  prefetch(keys: string[]): void;
  get(key: string): unknown;
}

export class MemorySyncCoordinator {
  constructor(options?: Record<string, unknown>);
  sync(source: string, target: string): Promise<Record<string, unknown>>;
  getStatus(): Record<string, unknown>;
}

export class UnifiedMemoryRecaller {
  constructor(options?: Record<string, unknown>);
  recall(query: string): Promise<Record<string, unknown>[]>;
}

export class AgentSkillsDiscipline {
  constructor(options?: Record<string, unknown>);
  enforce(agentId: string, skills: string[]): boolean;
  getViolations(agentId: string): Record<string, unknown>[];
}

export class GraphRag {
  constructor(options?: Record<string, unknown>);
  index(document: Record<string, unknown>): void;
  query(question: string): Promise<Record<string, unknown>>;
}

export class HookHandlers {
  constructor(options?: Record<string, unknown>);
  register(event: string, handler: Function): void;
  execute(event: string, data: Record<string, unknown>): Record<string, unknown>;
}

export class SkillCanary {
  constructor(options?: Record<string, unknown>);
  startEvaluation(skillId: string): string;
  getResult(evaluationId: string): Record<string, unknown>;
}

export class SkillObservability {
  constructor(options?: Record<string, unknown>);
  record(skillId: string, event: string, data: Record<string, unknown>): void;
  getMetrics(skillId: string): Record<string, unknown>;
}

export class SkillAuditTrail {
  constructor(options?: Record<string, unknown>);
  log(skillId: string, action: string, details: Record<string, unknown>): void;
  getHistory(skillId: string): Record<string, unknown>[];
}

export class KVCacheManager {
  constructor(options?: Record<string, unknown>);
  get(key: string): Record<string, unknown> | null;
  set(key: string, value: Record<string, unknown>, ttl?: number): void;
  invalidate(key: string): void;
}

export class DreamOutcomes {
  constructor(options?: Record<string, unknown>);
  analyze(dream: Record<string, unknown>): Record<string, unknown>;
}

export class DreamBridge {
  constructor(options?: Record<string, unknown>);
  bridge(dreamOutcomes: Record<string, unknown>): Record<string, unknown>;
}

export class CodeWikiOrchestrator {
  constructor(options?: Record<string, unknown>);
  generateWiki(codebase: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateWiki(filePath: string): Promise<void>;
}

/** MAGMA融合模块 — 跨图谱桥接器 */
export declare const QUERY_DIMENSIONS: {
  SEMANTIC: 'semantic';
  TEMPORAL: 'temporal';
  CAUSAL: 'causal';
  ENTITY: 'entity';
};

export declare const SEARCH_STRATEGIES: {
  BREADTH_FIRST: 'breadth-first';
  DEPTH_FIRST: 'depth-first';
  BEAM: 'beam';
  BEST_FIRST: 'best-first';
};

export interface JointQueryResult {
  results: Array<{
    dimension: string;
    type: string;
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    confidence: number;
    source: string;
    dimensions: string[];
    createdAt: number | null;
  }>;
  dimensionStats: Record<string, { queried: boolean; resultCount: number; error: string | null }>;
  queryId: string;
  strategy: string;
  dimensionsQueried: string[];
}

export interface IntentRouteResult {
  primaryDimension: string | null;
  secondaryDimensions: string[];
  confidence: number;
  signals: Record<string, number>;
}

export class CrossGraphBridge {
  constructor(options?: Record<string, unknown>);
  attachKnowledgeGraph(kg: Record<string, unknown>): CrossGraphBridge;
  attachCausalBus(bus: Record<string, unknown>): CrossGraphBridge;
  attachCausalMemory(store: Record<string, unknown>): CrossGraphBridge;
  jointQuery(query: string, options?: Record<string, unknown>): Promise<JointQueryResult>;
  routeByIntent(query: string): IntentRouteResult;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

/** MAGMA融合模块 — 统一向量索引服务 */
export declare const VECTOR_NAMESPACES: {
  CAUSAL: 'causal';
  SEMANTIC: 'semantic';
  ENTITY: 'entity';
  MEMORY: 'memory';
  THOUGHT: 'thought';
};

export interface VectorIndexResult {
  success: boolean;
  id?: string;
  namespace?: string;
  error?: string;
}

export class UnifiedVectorIndexService {
  constructor(options?: Record<string, unknown>);
  attachEmbeddingService(service: { embed(text: string): Promise<number[]> }): UnifiedVectorIndexService;
  index(namespace: string, id: string, text: string, metadata?: Record<string, unknown>): Promise<VectorIndexResult>;
  batchIndex(namespace: string, items: Array<{ id: string; text: string; metadata?: Record<string, unknown> }>): Promise<{ successCount: number; failCount: number; errors: Array<{ id: string; error: string }> }>;
  search(queryText: string, options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  remove(namespace: string, id: string): boolean;
  get(namespace: string, id: string): Record<string, unknown> | null;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

/** MAGMA融合模块 — 因果-记忆桥接器 */
export declare const FEEDBACK_TYPES: {
  DREAM_TO_CAUSAL: 'dream-to-causal';
  CAUSAL_TO_MEMORY: 'causal-to-memory';
  MEMORY_TO_PREFETCH: 'memory-to-prefetch';
  CONSOLIDATION: 'consolidation';
};

export declare const CONSOLIDATION_STRATEGIES: {
  IMMEDIATE: 'immediate';
  BATCHED: 'batched';
  SCHEDULED: 'scheduled';
};

export class CausalMemoryBridge {
  constructor(options?: Record<string, unknown>);
  attachDreamEngine(engine: Record<string, unknown>): CausalMemoryBridge;
  attachCausalMemory(store: Record<string, unknown>): CausalMemoryBridge;
  attachBrainMemory(memory: Record<string, unknown>): CausalMemoryBridge;
  attachPrefetcher(prefetcher: Record<string, unknown>): CausalMemoryBridge;
  attachCausalBus(bus: Record<string, unknown>): CausalMemoryBridge;
  onDreamCompleted(dreamResult: Record<string, unknown>): Promise<{ applied: number; skipped: number }>;
  consolidateToMemory(causalEntry: Record<string, unknown>): Promise<boolean>;
  prefetchByCausalChain(currentContext: string, options?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  startAutoConsolidation(): void;
  stopAutoConsolidation(): void;
  getStats(): Record<string, unknown>;
  getFeedbackHistory(type?: string): Array<Record<string, unknown>>;
  shutdown(): void;
  isHealthy(): boolean;
}

// === Deepening* lazyExports 补全声明 ===

export class DeepeningMetricsCollector {
  constructor(options?: Record<string, unknown>);
  collect(metrics: Record<string, unknown>): void;
  getReport(): Record<string, unknown>;
}

export class DeepeningCache {
  constructor(options?: Record<string, unknown>);
  get(key: string): unknown;
  set(key: string, value: unknown, ttl?: number): void;
  invalidate(key: string): void;
}

export class DeepeningStrategyPlugin {
  constructor(options?: Record<string, unknown>);
  apply(context: Record<string, unknown>): Record<string, unknown>;
}

export class DeepeningReportGenerator {
  constructor(options?: Record<string, unknown>);
  generate(data: Record<string, unknown>): Record<string, unknown>;
}

export class DeepeningHealthMonitor {
  constructor(options?: Record<string, unknown>);
  check(): Record<string, unknown>;
  isHealthy(): boolean;
}

export class DeepeningEventStore {
  constructor(options?: Record<string, unknown>);
  append(event: Record<string, unknown>): void;
  query(filter: Record<string, unknown>): Record<string, unknown>[];
}

export class DeepeningWorkflowTemplate {
  constructor(options?: Record<string, unknown>);
  define(steps: Record<string, unknown>[]): void;
  execute(): Promise<Record<string, unknown>>;
}

export class DeepeningBenchmark {
  constructor(options?: Record<string, unknown>);
  run(suite: string): Record<string, unknown>;
  compare(baseline: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown>;
}

export class DeepeningGracefulShutdown {
  constructor(options?: Record<string, unknown>);
  register(task: Function): void;
  shutdown(): Promise<void>;
}

export class DeepeningTaskScheduler {
  constructor(options?: Record<string, unknown>);
  schedule(task: Record<string, unknown>): string;
  cancel(taskId: string): void;
}

export class DeepeningPluginSystem {
  constructor(options?: Record<string, unknown>);
  register(plugin: Record<string, unknown>): void;
  load(pluginId: string): unknown;
}

export class DeepeningServiceRegistry {
  constructor(options?: Record<string, unknown>);
  register(name: string, service: unknown): void;
  resolve(name: string): unknown;
}

export class DeepeningRateLimiter {
  constructor(options?: Record<string, unknown>);
  acquire(key: string): boolean;
  release(key: string): void;
}

export class DeepeningSecurityGuard {
  constructor(options?: Record<string, unknown>);
  validate(action: Record<string, unknown>): boolean;
  sanitize(input: string): string;
}

export class DeepeningResourceManager {
  constructor(options?: Record<string, unknown>);
  allocate(resource: string, amount: number): boolean;
  release(resource: string, amount: number): void;
}

export class DeepeningCircuitBreaker {
  constructor(options?: Record<string, unknown>);
  execute(fn: Function): Promise<unknown>;
  getState(): string;
}

export class DeepeningSnapshot {
  constructor(options?: Record<string, unknown>);
  capture(): Record<string, unknown>;
  restore(data: Record<string, unknown>): void;
}

export class DeepeningStateManager {
  constructor(options?: Record<string, unknown>);
  getState(): Record<string, unknown>;
  setState(state: Record<string, unknown>): void;
  transition(action: string): Record<string, unknown>;
}

export class DeepeningBase {
  constructor(options?: Record<string, unknown>);
  init(): void;
  destroy(): void;
}

export class DeepeningConfigManager {
  constructor(options?: Record<string, unknown>);
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export class DeepeningEventBus {
  constructor(options?: Record<string, unknown>);
  on(event: string, handler: Function): void;
  emit(event: string, data: unknown): void;
  off(event: string, handler: Function): void;
}

export class DeepeningValidator {
  constructor(options?: Record<string, unknown>);
  validate(data: Record<string, unknown>, schema: Record<string, unknown>): boolean;
  getErrors(): string[];
}

export class DeepeningNotifier {
  constructor(options?: Record<string, unknown>);
  notify(channel: string, message: string): void;
  subscribe(channel: string, handler: Function): void;
}

export class DeepeningLockManager {
  constructor(options?: Record<string, unknown>);
  acquire(resource: string): Promise<string>;
  release(lockId: string): void;
}

export class DeepeningConnectionPool {
  constructor(options?: Record<string, unknown>);
  acquire(): Promise<unknown>;
  release(connection: unknown): void;
}

export class DeepeningFeatureFlags {
  constructor(options?: Record<string, unknown>);
  isEnabled(flag: string): boolean;
  set(flag: string, enabled: boolean): void;
}

export class DeepeningPriorityQueue {
  constructor(options?: Record<string, unknown>);
  enqueue(item: unknown, priority: number): void;
  dequeue(): unknown;
  peek(): unknown;
}

export class DeepeningThrottle {
  constructor(options?: Record<string, unknown>);
  acquire(): boolean;
  reset(): void;
}

export class DeepeningLoadBalancer {
  constructor(options?: Record<string, unknown>);
  select(): unknown;
  addTarget(target: unknown): void;
}

export class DeepeningRetryPolicy {
  constructor(options?: Record<string, unknown>);
  execute(fn: Function): Promise<unknown>;
}

export class DeepeningTaskQueue {
  constructor(options?: Record<string, unknown>);
  push(task: Record<string, unknown>): string;
  pop(): Record<string, unknown> | null;
}

export class DeepeningSnapshotStore {
  constructor(options?: Record<string, unknown>);
  save(snapshot: Record<string, unknown>): string;
  load(snapshotId: string): Record<string, unknown> | null;
}

export class DeepeningDataPipeline {
  constructor(options?: Record<string, unknown>);
  process(data: unknown): Promise<unknown>;
  addStage(stage: Record<string, unknown>): void;
}

export class DeepeningDependencyResolver {
  constructor(options?: Record<string, unknown>);
  resolve(moduleId: string): string[];
  register(moduleId: string, deps: string[]): void;
}

export class DeepeningDeployment {
  constructor(options?: Record<string, unknown>);
  deploy(config: Record<string, unknown>): Promise<string>;
  rollback(deploymentId: string): Promise<void>;
}

export class DeepeningErrorHandler {
  constructor(options?: Record<string, unknown>);
  handle(error: Error): Record<string, unknown>;
  registerHandler(type: string, handler: Function): void;
}

export class DeepeningEventReplay {
  constructor(options?: Record<string, unknown>);
  replay(fromSequence: number): Promise<Record<string, unknown>[]>;
}

export class DeepeningMetricsAggregator {
  constructor(options?: Record<string, unknown>);
  aggregate(metrics: Record<string, unknown>[]): Record<string, unknown>;
}

export class DeepeningStateMachine {
  constructor(options?: Record<string, unknown>);
  transition(action: string): Record<string, unknown>;
  getCurrentState(): string;
}

export class DeepeningTimeoutManager {
  constructor(options?: Record<string, unknown>);
  setTimeout(key: string, ms: number, callback: Function): string;
  clearTimeout(timeoutId: string): void;
}

export class DeepeningVisualizer {
  constructor(options?: Record<string, unknown>);
  render(data: Record<string, unknown>): string;
}

export class DeepeningAuditTrail {
  constructor(options?: Record<string, unknown>);
  log(action: string, details: Record<string, unknown>): void;
  query(filter: Record<string, unknown>): Record<string, unknown>[];
}

export class DeepeningBackpressureManager {
  constructor(options?: Record<string, unknown>);
  acquire(): Promise<void>;
  release(): void;
  getStatus(): Record<string, unknown>;
}

export class AITestFramework {
  constructor(options?: Record<string, unknown>);
  runHallucinationTest(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  runStressTest(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  runTokenBenchmark(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  runStabilityTest(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  runFuzzingTest(config: Record<string, unknown>): Promise<Record<string, unknown>>;
  getResults(): Record<string, unknown>[];
  getTokenBaselines(): Map<string, Record<string, unknown>[]>;
  getActiveTests(): Record<string, unknown>[];
  getStats(): Record<string, unknown>;
}

export class ProductDefinitionGate {
  constructor(options?: Record<string, unknown>);
  checkProposal(proposal: Record<string, unknown>): Record<string, unknown>;
  checkMvp(mvp: Record<string, unknown>): Record<string, unknown>;
  checkFeasibility(feasibility: Record<string, unknown>): Record<string, unknown>;
  getValidatedProposals(): Record<string, unknown>[];
  getReviewHistory(): Record<string, unknown>[];
  getStats(): Record<string, unknown>;
}

// === Claude Code扩展功能融合模块 ===

/** 上下文预算优化器 — 融合Claude Code上下文成本分层模型 */
export declare const FEATURE_LAYERS: {
  PROJECT_MEMORY: 'project_memory';
  SKILLS: 'skills';
  MCP: 'mcp';
  SUBAGENTS: 'subagents';
  HOOKS: 'hooks';
};

export declare const LAYER_PRIORITY: Record<string, number>;

export declare const LAYER_DEFAULT_BUDGET_RATIO: Record<string, number>;

export class ContextBudgetOptimizer {
  constructor(config?: { maxContextTokens?: number; warningThreshold?: number; dangerThreshold?: number; maxHistorySize?: number });
  canLoad(layer: string, itemId: string, estimatedTokens: number): boolean;
  registerLoad(layer: string, itemId: string, tokenCount: number): boolean;
  unregisterLoad(layer: string, itemId: string, tokenCount: number): boolean;
  reclaimFromLayer(layer: string, targetTokens: number): number;
  reallocateBudgets(usagePattern: Record<string, number>): void;
  getBudgetStatus(): { totalUsed: number; totalBudget: number; utilization: number; layers: Record<string, { usage: number; budget: number; utilization: number; loadedItems: number; priority: number }> };
  getRecommendations(): Array<{ layer: string; action: string; reason: string; suggestedReclaim?: number; suggestedIncrease?: number }>;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

/** 技能包管理器 — 融合Claude Code技能包分发机制 */
export declare const PACK_FORMAT_VERSION: string;

export declare const PACK_STATUS: {
  DRAFT: 'draft';
  PUBLISHED: 'published';
  DEPRECATED: 'deprecated';
};

export class SkillPackManager {
  constructor(config?: { maxPacks?: number; maxPackSize?: number; maxHistorySize?: number; exportDir?: string });
  createPack(packId: string, options?: { name?: string; description?: string; version?: string; author?: string; dependencies?: string[] }): Record<string, unknown>;
  addSkillToPack(packId: string, skillId: string, skillDefinition: Record<string, unknown>): Record<string, unknown>;
  removeSkillFromPack(packId: string, skillId: string): boolean;
  exportPack(packId: string): { formatVersion: string; pack: Record<string, unknown> };
  importPack(exportedData: Record<string, unknown>, options?: { packId?: string; overwrite?: boolean }): Record<string, unknown>;
  getPack(packId: string): Record<string, unknown> | null;
  getInstalledPack(packId: string): Record<string, unknown> | null;
  listPacks(): Array<Record<string, unknown>>;
  listInstalledPacks(): Array<Record<string, unknown>>;
  publishPack(packId: string): Record<string, unknown>;
  deprecatePack(packId: string, reason?: string): Record<string, unknown>;
  uninstallPack(packId: string): boolean;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

/** MCP服务器自动发现器 — 融合Claude Code MCP自动发现机制 */
export declare const DISCOVERY_SOURCES: {
  NODE_MODULES: 'node_modules';
  GLOBAL_NPM: 'global_npm';
  CONFIG_DIR: 'config_dir';
  MANIFEST: 'manifest';
};

export declare const SERVER_STATUS: {
  DISCOVERED: 'discovered';
  AVAILABLE: 'available';
  UNAVAILABLE: 'unavailable';
  ERROR: 'error';
};

export class McpAutoDiscovery {
  constructor(config?: { projectRoot?: string; scanNodeModules?: boolean; scanGlobalNpm?: boolean; scanConfigDir?: boolean; maxDiscovered?: number });
  discover(): Array<Record<string, unknown>>;
  getDiscoveredServer(name: string): Record<string, unknown> | null;
  getDiscoveredServers(): Array<Record<string, unknown>>;
  getServersBySource(source: string): Array<Record<string, unknown>>;
  generateConfigEntries(): Record<string, Record<string, unknown>>;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

/** Hook组合器 — 融合Claude Code Hook组合机制 */
export declare const COMPOSITION_STRATEGIES: {
  SEQUENTIAL: 'sequential';
  PARALLEL: 'parallel';
  CONDITIONAL: 'conditional';
};

export class HookComposer {
  constructor(hookExecutor?: Record<string, unknown>, config?: { maxCompositions?: number; maxHooksPerComposition?: number; compositionTimeoutMs?: number });
  createComposition(compositionId: string, options: { name?: string; description?: string; strategy?: string; hooks: Array<{ event: string; action: string; condition?: Function | string | null; timeout?: number | null }>; onFailure?: string; fallbackHook?: Record<string, unknown> | null }): Record<string, unknown>;
  executeComposition(compositionId: string, context: Record<string, unknown>): Promise<{ passed: boolean; reason?: string; results?: unknown[]; continued?: boolean }>;
  getComposition(compositionId: string): Record<string, unknown> | null;
  listCompositions(): Array<Record<string, unknown>>;
  removeComposition(compositionId: string): boolean;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

/** 动态Agent生成器 — 融合Claude Code动态Agent创建机制 */
export declare const SPAWN_MODES: {
  WORKER: 'worker';
  TEAM: 'team';
};

export declare const AGENT_TEMPLATES: Record<string, {
  role: string;
  capabilities: string[];
  modelTier: string;
  maxTokens: number;
  triggerMode: string;
  description: string;
}>;

export class DynamicAgentSpawner {
  constructor(agentRuntime?: Record<string, unknown>, config?: { maxSpawnedAgents?: number; defaultSpawnMode?: string; defaultTokenBudget?: number; defaultTimeoutMs?: number });
  spawnFromTask(taskDescription: string, options?: { spawnMode?: string; agentId?: string; modelTier?: string; maxTokens?: number; timeout?: number }): Record<string, unknown>;
  completeAgent(agentId: string, result: unknown): boolean;
  failAgent(agentId: string, error: unknown): boolean;
  getSpawnedAgent(agentId: string): Record<string, unknown> | null;
  listSpawnedAgents(): Array<Record<string, unknown>>;
  getTemplates(): Record<string, Record<string, unknown>>;
  registerTemplate(templateKey: string, template: Record<string, unknown>): void;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

// === Agent Skills融合模块 ===

/** 技能语义搜索器 — 融合find-skills向量嵌入语义搜索能力 */
export declare const DEFAULT_SEMANTIC_SEARCH_CONFIG: {
  embeddingDimension: number;
  similarityThreshold: number;
  maxResults: number;
  indexUpdateIntervalMs: number;
};

export declare const SIMILARITY_METRICS: {
  COSINE: 'cosine';
  EUCLIDEAN: 'euclidean';
  DOT_PRODUCT: 'dot_product';
};

export class SkillSemanticSearcher {
  constructor(config?: Partial<typeof DEFAULT_SEMANTIC_SEARCH_CONFIG>);
  attachEmbeddingService(embeddingService: { embed(text: string): Promise<number[]> }): void;
  attachSkillRouter(skillRouter: { getSkills(): unknown[]; match(context: unknown): unknown[] }): void;
  buildIndex(): Promise<number>;
  search(query: string, options?: { maxResults?: number; threshold?: number }): Promise<Array<{ skillId: string; similarity: number; skill: unknown }>>;
  findSimilar(skillId: string, options?: { maxResults?: number }): Promise<Array<{ skillId: string; similarity: number; skill: unknown }>>;
  compareSkills(skillIds: string[]): Promise<Array<{ skillA: string; skillB: string; similarity: number }>>;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}

/** 技能方案对比推荐器 — 融合find-skills方案对比推荐能力 */
export declare const DEFAULT_COMPARISON_CONFIG: {
  maxAlternatives: number;
  minQualityScore: number;
  comparisonDimensions: string[];
};

export declare const COMPARISON_DIMENSIONS: {
  QUALITY: 'quality';
  SPEED: 'speed';
  RELIABILITY: 'reliability';
  COVERAGE: 'coverage';
};

export declare const DIMENSION_WEIGHTS: {
  quality: number;
  speed: number;
  reliability: number;
  coverage: number;
};

export class SkillComparisonRecommender {
  constructor(config?: Partial<typeof DEFAULT_COMPARISON_CONFIG>);
  attachSkillRouter(skillRouter: unknown): void;
  attachQualityIndex(qualityIndex: unknown): void;
  attachEffectivenessOptimizer(optimizer: unknown): void;
  recommend(taskDescription: string, options?: { maxAlternatives?: number }): Promise<{ alternatives: Array<{ skills: string[]; scores: Record<string, number>; compositeScore: number; pros: string[]; cons: string[] }>; recommendation: unknown }>;
  compareSolutions(solutions: string[][]): Promise<{ comparisons: Array<{ skills: string[]; scores: Record<string, number>; compositeScore: number }> }>;
  getStats(): Record<string, unknown>;
  shutdown(): void;
  isHealthy(): boolean;
}
