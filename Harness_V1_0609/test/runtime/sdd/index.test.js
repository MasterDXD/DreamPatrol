'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');

const SddContractManager = require(path.join(ROOT, 'src', 'runtime', 'sdd', 'sdd-contract-manager'));
const IronRuleEngine = require(path.join(ROOT, 'src', 'runtime', 'sdd', 'iron-rule-engine'));
const SddDocumentValidator = require(path.join(ROOT, 'src', 'runtime', 'sdd', 'sdd-document-validator'));
const SddPhaseBridge = require(path.join(ROOT, 'src', 'runtime', 'sdd', 'sdd-phase-bridge'));
const SddSyncVerifier = require(path.join(ROOT, 'src', 'runtime', 'sdd', 'sdd-sync-verifier'));

const VALID_PROPOSE_DOC = [
  '# Proposal',
  '',
  '## Problem',
  'The current system lacks automated contract management. Users struggle with tracking requirements across multiple documents.',
  '',
  '## Solution',
  'Implement a contract management system that enforces document-driven development with four stages.',
  '',
  '## Scope',
  'This covers the contract lifecycle management. In scope: creation, validation, advancement. Out of scope: external integrations.',
  '',
  '## Stakeholders',
  'Development team, project managers, QA engineers.',
].join('\n');

const VALID_SPEC_DOC = [
  '# Specification',
  '',
  '## Functional Requirements',
  'The system must support creating contracts with four stages. Each stage requires document validation.',
  '',
  '## Non-Functional Requirements',
  'Performance: contract operations under 50ms. Scalability: support up to 100 concurrent contracts.',
  '',
  '## Constraints',
  'Must use CommonJS modules. No external dependencies. Must integrate with existing PhaseOrchestrator.',
  '',
  '## Acceptance Criteria',
  'All 4 stages can be completed. Validation rejects incomplete documents. 80%+ test coverage.',
].join('\n');

const VALID_DESIGN_DOC = [
  '# Design',
  '',
  '## Architecture',
  'The SDD subsystem follows a layered architecture pattern with contract manager as the entry point.',
  '',
  '## Interfaces',
  'SddContractManager exposes createContract, advanceStage, validateContract. API follows RESTful principles.',
  '',
  '## Data Models',
  'Contract: { contractId, status, currentStage, documents }. Document: { content, validatedAt, validationScore }.',
  '',
  '## Error Handling',
  'All operations use safeExecute wrapper. Validation errors are collected, not thrown. Retry with exponential backoff for transient failures.',
].join('\n');

const VALID_TASKS_DOC = [
  '# Tasks',
  '',
  '## Task Breakdown',
  'Task 1: Implement SddContractManager. Task 2: Implement IronRuleEngine. Task 3: Implement SddDocumentValidator. Task 4: Implement SddPhaseBridge.',
  '',
  '## Dependencies',
  'Task 3 depends on Task 1. Task 4 depends on Task 1. Tasks must be completed in order: 1 -> 2,3,4.',
  '',
  '## Estimates',
  'Task 1: 4 hours. Task 2: 3 hours. Task 3: 2 hours. Task 4: 2 hours. Total: 11 hours.',
  '',
  '## Risk Mitigation',
  'Risk: Integration with PhaseOrchestrator may have API mismatch. Mitigation: define interface contract first. Risk: Validation too strict. Mitigation: configurable threshold.',
].join('\n');

describe('SddContractManager', () => {
  let manager;

  beforeEach(() => {
    manager = new SddContractManager();
  });

  it('should create a contract', () => {
    const result = manager.createContract('/test/project');
    assert.ok(result);
    assert.ok(result.contractId);
    assert.strictEqual(result.status, 'draft');
    assert.strictEqual(result.currentStage, 'propose');
  });

  it('should get contract by id', () => {
    const { contractId } = manager.createContract('/test/project');
    const contract = manager.getContract(contractId);
    assert.ok(contract);
    assert.strictEqual(contract.contractId, contractId);
    assert.strictEqual(contract.projectRoot, '/test/project');
  });

  it('should return null for non-existent contract', () => {
    const contract = manager.getContract('non-existent');
    assert.strictEqual(contract, null);
  });

  it('should advance stage with valid document', () => {
    const { contractId } = manager.createContract('/test/project');
    const result = manager.advanceStage(contractId, VALID_PROPOSE_DOC);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(result.newStage, 'spec');
  });

  it('should block advance with invalid document in strict mode', () => {
    const { contractId } = manager.createContract('/test/project');
    const result = manager.advanceStage(contractId, 'invalid content');
    assert.strictEqual(result.advanced, false);
    assert.ok(result.validation);
  });

  it('should complete contract after all stages', () => {
    const { contractId } = manager.createContract('/test/project');
    manager.advanceStage(contractId, VALID_PROPOSE_DOC);
    manager.advanceStage(contractId, VALID_SPEC_DOC);
    manager.advanceStage(contractId, VALID_DESIGN_DOC);
    const result = manager.advanceStage(contractId, VALID_TASKS_DOC);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(result.completed, true);
  });

  it('should validate contract', () => {
    const { contractId } = manager.createContract('/test/project');
    const validation = manager.validateContract(contractId);
    assert.ok(validation);
    assert.strictEqual(validation.valid, false);
  });

  it('should get contract status', () => {
    const { contractId } = manager.createContract('/test/project');
    const status = manager.getContractStatus(contractId);
    assert.ok(status);
    assert.strictEqual(status.status, 'draft');
    assert.strictEqual(status.currentStage, 'propose');
    assert.strictEqual(status.progress, 0);
    assert.strictEqual(status.totalStages, 4);
  });

  it('should list contracts', () => {
    manager.createContract('/test/project1');
    manager.createContract('/test/project2');
    const list = manager.listContracts();
    assert.strictEqual(list.length, 2);
  });

  it('should archive contract', () => {
    const { contractId } = manager.createContract('/test/project');
    const result = manager.archiveContract(contractId);
    assert.strictEqual(result.archived, true);
    const contract = manager.getContract(contractId);
    assert.strictEqual(contract.status, 'archived');
  });

  it('should not archive non-existent contract', () => {
    const result = manager.archiveContract('non-existent');
    assert.strictEqual(result.archived, false);
  });

  it('should not advance archived contract', () => {
    const { contractId } = manager.createContract('/test/project');
    manager.archiveContract(contractId);
    const result = manager.advanceStage(contractId, VALID_PROPOSE_DOC);
    assert.strictEqual(result.advanced, false);
  });

  it('should expose CONTRACT_STAGES', () => {
    assert.deepStrictEqual(SddContractManager.CONTRACT_STAGES, ['propose', 'spec', 'design', 'tasks']);
  });

  it('should expose CONTRACT_STATUS', () => {
    assert.strictEqual(SddContractManager.CONTRACT_STATUS.DRAFT, 'draft');
    assert.strictEqual(SddContractManager.CONTRACT_STATUS.ACTIVE, 'active');
    assert.strictEqual(SddContractManager.CONTRACT_STATUS.COMPLETED, 'completed');
    assert.strictEqual(SddContractManager.CONTRACT_STATUS.ARCHIVED, 'archived');
  });

  it('should get stage requirements', () => {
    const reqs = manager.getStageRequirements('propose');
    assert.ok(reqs);
    assert.ok(reqs.requiredSections);
    assert.ok(reqs.qualityGates);
  });

  it('should get contract stages', () => {
    const stages = manager.getContractStages();
    assert.deepStrictEqual(stages, ['propose', 'spec', 'design', 'tasks']);
  });

  it('should emit contract-created event', () => {
    let emitted = false;
    manager.on('contract-created', () => { emitted = true; });
    manager.createContract('/test/project');
    assert.strictEqual(emitted, true);
  });

  it('should emit stage-advanced event', () => {
    let emitted = false;
    manager.on('stage-advanced', () => { emitted = true; });
    const { contractId } = manager.createContract('/test/project');
    manager.advanceStage(contractId, VALID_PROPOSE_DOC);
    assert.strictEqual(emitted, true);
  });

  it('should shutdown gracefully', () => {
    manager.createContract('/test/project');
    manager.shutdown();
    assert.strictEqual(manager.isHealthy(), false);
  });
});

describe('IronRuleEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new IronRuleEngine();
  });

  it('should load built-in rules', () => {
    const rules = engine.getRules();
    assert.ok(rules.length >= 10);
  });

  it('should add a custom rule', () => {
    const result = engine.addRule({
      id: 'custom-test-rule',
      name: 'Custom Test Rule',
      description: 'A test rule',
      severity: 'warning',
      category: 'style',
      check: function() { return { violated: false, evidence: '' }; },
    });
    assert.strictEqual(result.added, true);
    assert.strictEqual(result.ruleId, 'custom-test-rule');
  });

  it('should not add duplicate rule', () => {
    engine.addRule({
      id: 'dup-rule',
      name: 'Dup',
      check: function() { return { violated: false, evidence: '' }; },
    });
    const result = engine.addRule({
      id: 'dup-rule',
      name: 'Dup2',
      check: function() { return { violated: false, evidence: '' }; },
    });
    assert.strictEqual(result.added, false);
  });

  it('should not add rule without id', () => {
    const result = engine.addRule({ name: 'No ID', check: function() {} });
    assert.strictEqual(result.added, false);
  });

  it('should remove a rule', () => {
    engine.addRule({
      id: 'removable-rule',
      name: 'Removable',
      check: function() { return { violated: false, evidence: '' }; },
    });
    const result = engine.removeRule('removable-rule');
    assert.strictEqual(result, true);
  });

  it('should detect hardcoded secrets violation', () => {
    const code = 'const apiKey = "sk-1234567890abcdef";';
    const result = engine.checkViolation(code, {});
    const secretViolation = result.violations.find(v => v.ruleId === 'no-hardcoded-secrets');
    assert.ok(secretViolation);
    assert.strictEqual(secretViolation.severity, 'critical');
  });

  it('should detect sync I/O violation', () => {
    const code = 'const data = fs.readFileSync("/etc/passwd");';
    const result = engine.checkViolation(code, {});
    const syncViolation = result.violations.find(v => v.ruleId === 'no-sync-io');
    assert.ok(syncViolation);
  });

  it('should detect global mutation violation', () => {
    const code = 'global.myVar = 42;';
    const result = engine.checkViolation(code, {});
    const mutationViolation = result.violations.find(v => v.ruleId === 'no-global-mutation');
    assert.ok(mutationViolation);
  });

  it('should not detect violations in clean code', () => {
    const code = 'const x = 1; function add(a, b) { return a + b; }';
    const result = engine.checkViolation(code, {});
    assert.ok(result.violations.length === 0 || result.violations.every(v => v.ruleId !== 'no-hardcoded-secrets' && v.ruleId !== 'no-sync-io' && v.ruleId !== 'no-global-mutation'));
  });

  it('should get violations history', () => {
    const code = 'const apiKey = "sk-1234567890abcdef";';
    engine.checkViolation(code, {});
    const violations = engine.getViolations();
    assert.ok(violations.length > 0);
  });

  it('should get rule stats', () => {
    const code = 'const apiKey = "sk-1234567890abcdef";';
    engine.checkViolation(code, {});
    const stats = engine.getRuleStats();
    assert.ok(stats.totalChecks > 0);
    assert.ok(stats.totalRules >= 10);
    assert.ok(stats.enabledRules >= 10);
  });

  it('should enable and disable rules', () => {
    const enabled = engine.disableRule('no-hardcoded-secrets');
    assert.strictEqual(enabled, true);
    const code = 'const apiKey = "sk-1234567890abcdef";';
    const result = engine.checkViolation(code, {});
    const secretViolation = result.violations.find(v => v.ruleId === 'no-hardcoded-secrets');
    assert.strictEqual(secretViolation, undefined);
    engine.enableRule('no-hardcoded-secrets');
  });

  it('should emit violations-detected event', () => {
    let emitted = false;
    engine.on('violations-detected', () => { emitted = true; });
    const code = 'const apiKey = "sk-1234567890abcdef";';
    engine.checkViolation(code, {});
    assert.strictEqual(emitted, true);
  });

  it('should expose SEVERITY_LEVELS', () => {
    assert.strictEqual(IronRuleEngine.SEVERITY_LEVELS.CRITICAL, 'critical');
    assert.strictEqual(IronRuleEngine.SEVERITY_LEVELS.WARNING, 'warning');
    assert.strictEqual(IronRuleEngine.SEVERITY_LEVELS.INFO, 'info');
  });

  it('should expose CATEGORY_TYPES', () => {
    assert.strictEqual(IronRuleEngine.CATEGORY_TYPES.ARCHITECTURE, 'architecture');
    assert.strictEqual(IronRuleEngine.CATEGORY_TYPES.SECURITY, 'security');
  });

  it('should expose BUILT_IN_RULES', () => {
    assert.ok(Array.isArray(IronRuleEngine.BUILT_IN_RULES));
    assert.ok(IronRuleEngine.BUILT_IN_RULES.length >= 10);
  });

  it('should load rules from file', () => {
    const fs = require('fs');
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), 'sdd-test-rules-' + Date.now() + '.json');
    const rules = [
      {
        id: 'file-loaded-rule',
        name: 'File Loaded Rule',
        description: 'Loaded from file',
        severity: 'info',
        category: 'style',
        check: function() { return { violated: false, evidence: '' }; },
      },
    ];
    fs.writeFileSync(tmpFile, JSON.stringify(rules));
    try {
      const result = engine.loadRules(tmpFile);
      assert.strictEqual(result.loaded, 1);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('should handle non-existent rules file', () => {
    const result = engine.loadRules('/non/existent/path.json');
    assert.strictEqual(result.loaded, 0);
  });

  it('should detect circular dependencies', () => {
    const result = engine.checkViolation('', {
      dependencies: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    });
    const cycleViolation = result.violations.find(v => v.ruleId === 'no-circular-dependencies');
    assert.ok(cycleViolation);
  });

  it('should shutdown gracefully', () => {
    engine.shutdown();
    assert.strictEqual(engine.isHealthy(), false);
  });
});

describe('SddDocumentValidator', () => {
  let validator;

  beforeEach(() => {
    validator = new SddDocumentValidator();
  });

  it('should validate a valid propose document', () => {
    const result = validator.validateDocument('propose', VALID_PROPOSE_DOC);
    assert.ok(result);
    assert.strictEqual(result.valid, true);
    assert.ok(result.score > 0);
  });

  it('should reject an empty document', () => {
    const result = validator.validateDocument('propose', '');
    assert.strictEqual(result.valid, false);
  });

  it('should reject an invalid stage', () => {
    const result = validator.validateDocument('invalid-stage', 'some content');
    assert.strictEqual(result.valid, false);
  });

  it('should check required sections', () => {
    const result = validator.checkRequiredSections('propose', VALID_PROPOSE_DOC);
    assert.ok(result.present.length > 0);
    assert.strictEqual(result.missing.length, 0);
  });

  it('should detect missing sections', () => {
    const result = validator.checkRequiredSections('propose', 'Just some random text without structure');
    assert.ok(result.missing.length > 0);
  });

  it('should run quality gates', () => {
    const result = validator.runQualityGates('propose', VALID_PROPOSE_DOC);
    assert.ok(result.passed.length > 0);
    assert.ok(typeof result.score === 'number');
  });

  it('should get stage template', () => {
    const template = validator.getStageTemplate('propose');
    assert.ok(template);
    assert.ok(template.includes('Problem'));
    assert.ok(template.includes('Solution'));
  });

  it('should return null for unknown stage template', () => {
    const template = validator.getStageTemplate('unknown');
    assert.strictEqual(template, null);
  });

  it('should get stage requirements', () => {
    const reqs = validator.getStageRequirements('spec');
    assert.ok(reqs);
    assert.ok(reqs.requiredSections.includes('functionalRequirements'));
    assert.ok(reqs.requiredSections.includes('acceptanceCriteria'));
  });

  it('should validate spec document', () => {
    const result = validator.validateDocument('spec', VALID_SPEC_DOC);
    assert.strictEqual(result.valid, true);
  });

  it('should validate design document', () => {
    const result = validator.validateDocument('design', VALID_DESIGN_DOC);
    assert.strictEqual(result.valid, true);
  });

  it('should validate tasks document', () => {
    const result = validator.validateDocument('tasks', VALID_TASKS_DOC);
    assert.strictEqual(result.valid, true);
  });

  it('should report warnings for weak sections', () => {
    const weakDoc = '## Problem\nshort\n## Solution\nshort\n## Scope\nshort\n## Stakeholders\nshort';
    const result = validator.validateDocument('propose', weakDoc);
    assert.ok(result.warnings.length > 0 || result.score < 1);
  });

  it('should set and get validation report', () => {
    validator.setValidationReport('test-contract', { valid: true });
    const report = validator.getValidationReport('test-contract');
    assert.ok(report);
    assert.strictEqual(report.valid, true);
  });

  it('should expose STAGE_REQUIREMENTS', () => {
    assert.ok(SddDocumentValidator.STAGE_REQUIREMENTS);
    assert.ok(SddDocumentValidator.STAGE_REQUIREMENTS.propose);
  });

  it('should expose SECTION_KEYWORDS', () => {
    assert.ok(SddDocumentValidator.SECTION_KEYWORDS);
    assert.ok(SddDocumentValidator.SECTION_KEYWORDS.problem);
  });

  it('should expose QUALITY_GATE_CHECKS', () => {
    assert.ok(SddDocumentValidator.QUALITY_GATE_CHECKS);
    assert.ok(SddDocumentValidator.QUALITY_GATE_CHECKS.problemClarity);
  });

  it('should expose STAGE_TEMPLATES', () => {
    assert.ok(SddDocumentValidator.STAGE_TEMPLATES);
    assert.ok(SddDocumentValidator.STAGE_TEMPLATES.propose);
  });
});

describe('SddPhaseBridge', () => {
  let bridge;
  let contractManager;

  beforeEach(() => {
    bridge = new SddPhaseBridge();
    contractManager = new SddContractManager();
  });

  it('should attach to PhaseOrchestrator', () => {
    const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));
    const po = new PhaseOrchestrator();
    const result = bridge.attachToPhaseOrchestrator(po);
    assert.strictEqual(result.attached, true);
  });

  it('should not attach twice', () => {
    const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));
    const po = new PhaseOrchestrator();
    bridge.attachToPhaseOrchestrator(po);
    const result = bridge.attachToPhaseOrchestrator(po);
    assert.strictEqual(result.attached, false);
  });

  it('should reject invalid PhaseOrchestrator', () => {
    const result = bridge.attachToPhaseOrchestrator(null);
    assert.strictEqual(result.attached, false);
  });

  it('should attach SddContractManager', () => {
    const result = bridge.attachSddContractManager(contractManager);
    assert.strictEqual(result.attached, true);
  });

  it('should map SDD stage to phase', () => {
    assert.strictEqual(bridge.mapStageToPhase('propose'), 'brainstorming');
    assert.strictEqual(bridge.mapStageToPhase('spec'), 'requirement-analysis');
    assert.strictEqual(bridge.mapStageToPhase('design'), 'architecture-design');
    assert.strictEqual(bridge.mapStageToPhase('tasks'), 'module-development');
  });

  it('should map phase to SDD stage', () => {
    assert.strictEqual(bridge.mapPhaseToStage('brainstorming'), 'propose');
    assert.strictEqual(bridge.mapPhaseToStage('requirement-analysis'), 'spec');
    assert.strictEqual(bridge.mapPhaseToStage('architecture-design'), 'design');
    assert.strictEqual(bridge.mapPhaseToStage('module-development'), 'tasks');
  });

  it('should return null for unknown mapping', () => {
    assert.strictEqual(bridge.mapStageToPhase('unknown'), null);
    assert.strictEqual(bridge.mapPhaseToStage('unknown'), null);
  });

  it('should enforce contract gate', () => {
    bridge.attachSddContractManager(contractManager);
    const { contractId } = contractManager.createContract('/test/project');
    contractManager.advanceStage(contractId, VALID_PROPOSE_DOC);
    const result = bridge.enforceContractGate(contractId, 'brainstorming');
    assert.strictEqual(result.enforced, true);
    assert.strictEqual(result.passed, true);
  });

  it('should block contract gate for incomplete stage', () => {
    bridge.attachSddContractManager(contractManager);
    const { contractId } = contractManager.createContract('/test/project');
    const result = bridge.enforceContractGate(contractId, 'module-development');
    assert.strictEqual(result.enforced, true);
    assert.strictEqual(result.passed, false);
  });

  it('should fail enforcement without contract manager', () => {
    const result = bridge.enforceContractGate('any-id', 'brainstorming');
    assert.strictEqual(result.enforced, false);
  });

  it('should get bridge status', () => {
    const status = bridge.getBridgeStatus();
    assert.strictEqual(status.attached, false);
    assert.strictEqual(status.hasPhaseOrchestrator, false);
    assert.strictEqual(status.hasContractManager, false);
  });

  it('should get enforced contracts', () => {
    bridge.attachSddContractManager(contractManager);
    const { contractId } = contractManager.createContract('/test/project');
    contractManager.advanceStage(contractId, VALID_PROPOSE_DOC);
    bridge.enforceContractGate(contractId, 'brainstorming');
    const enforced = bridge.getEnforcedContracts();
    assert.strictEqual(enforced.length, 1);
  });

  it('should detach', () => {
    const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));
    const po = new PhaseOrchestrator();
    bridge.attachToPhaseOrchestrator(po);
    const result = bridge.detach();
    assert.strictEqual(result.detached, true);
    const status = bridge.getBridgeStatus();
    assert.strictEqual(status.attached, false);
  });

  it('should emit attached event', () => {
    let emitted = false;
    bridge.on('attached', () => { emitted = true; });
    const PhaseOrchestrator = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'phase-orchestrator'));
    const po = new PhaseOrchestrator();
    bridge.attachToPhaseOrchestrator(po);
    assert.strictEqual(emitted, true);
  });

  it('should expose SDD_PHASE_MAP', () => {
    assert.ok(SddPhaseBridge.SDD_PHASE_MAP);
    assert.strictEqual(SddPhaseBridge.SDD_PHASE_MAP.propose, 'brainstorming');
  });

  it('should expose PHASE_SDD_MAP', () => {
    assert.ok(SddPhaseBridge.PHASE_SDD_MAP);
    assert.strictEqual(SddPhaseBridge.PHASE_SDD_MAP.brainstorming, 'propose');
  });

  it('should shutdown gracefully', () => {
    bridge.shutdown();
    assert.strictEqual(bridge.isHealthy(), false);
  });
});

describe('SDD Integration with FrameworkComplianceChecker', () => {
  it('should attach SddContractManager to FrameworkComplianceChecker', () => {
    const FrameworkComplianceChecker = require(path.join(ROOT, 'src', 'gate', 'framework-compliance-checker'));
    const fcc = new FrameworkComplianceChecker(ROOT);
    const cm = new SddContractManager();
    const result = fcc.attachSddContractManager(cm);
    assert.strictEqual(result, true);
  });

  it('should reject invalid SddContractManager', () => {
    const FrameworkComplianceChecker = require(path.join(ROOT, 'src', 'gate', 'framework-compliance-checker'));
    const fcc = new FrameworkComplianceChecker(ROOT);
    const result = fcc.attachSddContractManager(null);
    assert.strictEqual(result, false);
  });

  it('should check SDD contract completeness', () => {
    const FrameworkComplianceChecker = require(path.join(ROOT, 'src', 'gate', 'framework-compliance-checker'));
    const fcc = new FrameworkComplianceChecker(ROOT);
    const cm = new SddContractManager();
    fcc.attachSddContractManager(cm);
    const { contractId } = cm.createContract('/test/project');
    const violations = fcc.checkSddContractComplete(contractId);
    assert.ok(violations.length > 0);
  });

  it('should pass SDD contract check for completed contract', () => {
    const FrameworkComplianceChecker = require(path.join(ROOT, 'src', 'gate', 'framework-compliance-checker'));
    const fcc = new FrameworkComplianceChecker(ROOT);
    const cm = new SddContractManager();
    fcc.attachSddContractManager(cm);
    const { contractId } = cm.createContract('/test/project');
    cm.advanceStage(contractId, VALID_PROPOSE_DOC);
    cm.advanceStage(contractId, VALID_SPEC_DOC);
    cm.advanceStage(contractId, VALID_DESIGN_DOC);
    cm.advanceStage(contractId, VALID_TASKS_DOC);
    const violations = fcc.checkSddContractComplete(contractId);
    assert.strictEqual(violations.length, 0);
  });

  it('should return empty violations without contract manager', () => {
    const FrameworkComplianceChecker = require(path.join(ROOT, 'src', 'gate', 'framework-compliance-checker'));
    const fcc = new FrameworkComplianceChecker(ROOT);
    const violations = fcc.checkSddContractComplete('any-id');
    assert.strictEqual(violations.length, 0);
  });

  it('should expose SDD_CONTRACT_COMPLETE rule', () => {
    const FrameworkComplianceChecker = require(path.join(ROOT, 'src', 'gate', 'framework-compliance-checker'));
    assert.ok(FrameworkComplianceChecker.DOC_COMPLETENESS_RULES.SDD_CONTRACT_COMPLETE);
    assert.strictEqual(FrameworkComplianceChecker.DOC_COMPLETENESS_RULES.SDD_CONTRACT_COMPLETE.id, 'sdd-contract-complete');
  });
});

describe('SDD Full Lifecycle Integration', () => {
  it('should complete full SDD lifecycle', () => {
    const cm = new SddContractManager();
    const bridge = new SddPhaseBridge();
    bridge.attachSddContractManager(cm);

    const { contractId } = cm.createContract('/test/project');
    assert.strictEqual(cm.getContractStatus(contractId).currentStage, 'propose');

    let result = cm.advanceStage(contractId, VALID_PROPOSE_DOC);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(result.newStage, 'spec');

    const proposeGate = bridge.enforceContractGate(contractId, 'brainstorming');
    assert.strictEqual(proposeGate.passed, true);

    result = cm.advanceStage(contractId, VALID_SPEC_DOC);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(result.newStage, 'design');

    const specGate = bridge.enforceContractGate(contractId, 'requirement-analysis');
    assert.strictEqual(specGate.passed, true);

    result = cm.advanceStage(contractId, VALID_DESIGN_DOC);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(result.newStage, 'tasks');

    const designGate = bridge.enforceContractGate(contractId, 'architecture-design');
    assert.strictEqual(designGate.passed, true);

    result = cm.advanceStage(contractId, VALID_TASKS_DOC);
    assert.strictEqual(result.advanced, true);
    assert.strictEqual(result.completed, true);

    const validation = cm.validateContract(contractId);
    assert.strictEqual(validation.valid, true);

    const status = cm.getContractStatus(contractId);
    assert.strictEqual(status.progress, 1);
    assert.strictEqual(status.status, 'completed');
  });

  it('should integrate iron rules with contract workflow', () => {
    const cm = new SddContractManager();
    const engine = new IronRuleEngine();

    const { contractId } = cm.createContract('/test/project');

    const badCode = 'const apiKey = "sk-hardcoded-key";\nglobal.config = {};\nconst data = fs.readFileSync("/etc/passwd");';
    const checkResult = engine.checkViolation(badCode, { filePath: 'src/business/service.js' });
    assert.ok(checkResult.violations.length >= 2);

    cm.advanceStage(contractId, VALID_PROPOSE_DOC);
    cm.advanceStage(contractId, VALID_SPEC_DOC);
    cm.advanceStage(contractId, VALID_DESIGN_DOC);
    cm.advanceStage(contractId, VALID_TASKS_DOC);

    const status = cm.getContractStatus(contractId);
    assert.strictEqual(status.status, 'completed');
  });
});

describe('SddContractManager Traceability', () => {
  let manager;

  beforeEach(() => {
    manager = new SddContractManager();
  });

  it('should register a trace item', () => {
    const { contractId } = manager.createContract('/test/project');
    const result = manager.registerTraceItem(contractId, 'item-1', { description: 'User login' });
    assert.strictEqual(result.registered, true);
    assert.strictEqual(result.itemId, 'item-1');
  });

  it('should update trace status', () => {
    const { contractId } = manager.createContract('/test/project');
    manager.registerTraceItem(contractId, 'item-1', { description: 'User login' });
    let eventFired = false;
    manager.on('trace-status-updated', () => { eventFired = true; });
    const result = manager.updateTraceStatus(contractId, 'item-1', 'implemented', { file: 'auth.js' });
    assert.strictEqual(result.updated, true);
    assert.strictEqual(result.previousStatus, 'pending');
    assert.strictEqual(result.newStatus, 'implemented');
    assert.strictEqual(eventFired, true);
  });

  it('should get trace matrix', () => {
    const { contractId } = manager.createContract('/test/project');
    manager.registerTraceItem(contractId, 'item-1', { description: 'Feature A' });
    manager.registerTraceItem(contractId, 'item-2', { description: 'Feature B' });
    manager.updateTraceStatus(contractId, 'item-1', 'implemented');
    const matrix = manager.getTraceMatrix(contractId);
    assert.strictEqual(matrix.items.length, 2);
    assert.strictEqual(matrix.summary.total, 2);
    assert.strictEqual(matrix.summary.byStatus.implemented, 1);
    assert.strictEqual(matrix.summary.byStatus.pending, 1);
  });

  it('should check spec coverage', () => {
    const { contractId } = manager.createContract('/test/project');
    manager.registerTraceItem(contractId, 'item-1', { description: 'Feature A' });
    manager.registerTraceItem(contractId, 'item-2', { description: 'Feature B' });
    manager.registerTraceItem(contractId, 'item-3', { description: 'Feature C' });
    manager.updateTraceStatus(contractId, 'item-1', 'implemented');
    manager.updateTraceStatus(contractId, 'item-2', 'partial');
    const coverage = manager.checkSpecCoverage(contractId);
    assert.strictEqual(coverage.totalItems, 3);
    assert.strictEqual(coverage.implemented, 1);
    assert.strictEqual(coverage.partial, 1);
    assert.strictEqual(coverage.pending, 1);
    assert.strictEqual(coverage.coveragePercent, 50);
  });

  it('should attach persist store', () => {
    const mockStore = { get: function() {}, set: function() {} };
    const result = manager.attachPersistStore(mockStore);
    assert.strictEqual(result.attached, true);
  });

  it('should persist and restore contract', () => {
    const store = {};
    const mockStore = {
      get: function(key) { return store[key] || null; },
      set: function(key, value) { store[key] = value; },
    };
    manager.attachPersistStore(mockStore);
    const { contractId } = manager.createContract('/test/project');
    manager.advanceStage(contractId, VALID_PROPOSE_DOC);
    const persistResult = manager.persistContract(contractId);
    assert.strictEqual(persistResult.persisted, true);
    const newManager = new SddContractManager();
    newManager.attachPersistStore(mockStore);
    const restoreResult = newManager.restoreContract(contractId);
    assert.strictEqual(restoreResult.restored, true);
    assert.strictEqual(restoreResult.contractId, contractId);
    const contract = newManager.getContract(contractId);
    assert.ok(contract);
    assert.strictEqual(contract.currentStage, 'spec');
  });

  it('should reject trace item for non-existent contract', () => {
    const result = manager.registerTraceItem('non-existent-contract', 'item-1', { description: 'Test' });
    assert.strictEqual(result.registered, false);
  });

  it('should reject trace item with invalid itemId', () => {
    const { contractId } = manager.createContract('/test/project');
    const result = manager.registerTraceItem(contractId, '', { description: 'Test' });
    assert.strictEqual(result.registered, false);
  });
});

describe('SddSyncVerifier', () => {
  let verifier;

  beforeEach(() => {
    verifier = new SddSyncVerifier();
  });

  it('should create instance', () => {
    const stats = verifier.getStats();
    assert.ok(stats);
    assert.strictEqual(stats.totalTraceItems, 0);
    assert.strictEqual(stats.totalSyncReports, 0);
    assert.strictEqual(stats.contractsTracked, 0);
  });

  it('should attach SddContractManager', () => {
    const mockManager = { listContracts: function() { return []; } };
    const result = verifier.attachSddContractManager(mockManager);
    assert.strictEqual(result.attached, true);
  });

  it('should attach IronRuleEngine', () => {
    const mockEngine = { checkViolation: function() { return { violations: [] }; } };
    const result = verifier.attachIronRuleEngine(mockEngine);
    assert.strictEqual(result.attached, true);
  });

  it('should register trace item', () => {
    let eventFired = false;
    verifier.on('trace-registered', () => { eventFired = true; });
    const result = verifier.registerTraceItem('contract-1', 'item-1', { description: 'User auth', stage: 'spec', source: 'spec-doc' });
    assert.strictEqual(result.registered, true);
    assert.strictEqual(result.itemId, 'item-1');
    assert.strictEqual(eventFired, true);
  });

  it('should update trace status', () => {
    verifier.registerTraceItem('contract-1', 'item-1', { description: 'User auth' });
    const result = verifier.updateTraceStatus('contract-1', 'item-1', 'implemented', { file: 'auth.js', line: 42 });
    assert.strictEqual(result.updated, true);
    assert.strictEqual(result.previousStatus, 'pending');
    assert.strictEqual(result.newStatus, 'implemented');
  });

  it('should get trace matrix', () => {
    verifier.registerTraceItem('contract-1', 'item-1', { description: 'Feature A' });
    verifier.registerTraceItem('contract-1', 'item-2', { description: 'Feature B' });
    verifier.updateTraceStatus('contract-1', 'item-1', 'implemented');
    const matrix = verifier.getTraceMatrix('contract-1');
    assert.strictEqual(matrix.items.length, 2);
    assert.strictEqual(matrix.summary.total, 2);
    assert.strictEqual(matrix.summary.byStatus.implemented, 1);
    assert.strictEqual(matrix.summary.byStatus.pending, 1);
  });

  it('should check spec coverage', () => {
    verifier.registerTraceItem('contract-1', 'item-1', { description: 'Feature A' });
    verifier.registerTraceItem('contract-1', 'item-2', { description: 'Feature B' });
    verifier.registerTraceItem('contract-1', 'item-3', { description: 'Feature C' });
    verifier.updateTraceStatus('contract-1', 'item-1', 'implemented');
    verifier.updateTraceStatus('contract-1', 'item-2', 'partial');
    const coverage = verifier.checkSpecCoverage('contract-1');
    assert.strictEqual(coverage.totalItems, 3);
    assert.strictEqual(coverage.implemented, 1);
    assert.strictEqual(coverage.partial, 1);
    assert.strictEqual(coverage.pending, 1);
    assert.strictEqual(coverage.coveragePercent, 0.5);
  });

  it('should detect drift', () => {
    verifier.registerTraceItem('contract-1', 'item-1', { description: 'Feature A', stage: 'spec', requirements: ['login'] });
    verifier.updateTraceStatus('contract-1', 'item-1', 'implemented');
    const result = verifier.detectDrift('contract-1', { files: [] });
    assert.strictEqual(result.driftDetected, true);
    assert.ok(result.drifts.length > 0);
    assert.strictEqual(result.drifts[0].type, 'file-missing');
  });

  it('should generate sync report', () => {
    verifier.registerTraceItem('contract-1', 'item-1', { description: 'Feature A' });
    verifier.registerTraceItem('contract-1', 'item-2', { description: 'Feature B' });
    const report = verifier.generateSyncReport('contract-1');
    assert.ok(report);
    assert.strictEqual(report.contractId, 'contract-1');
    assert.ok(report.generatedAt);
    assert.ok(report.traceMatrix);
    assert.ok(report.coverage);
    assert.ok(report.drift);
    assert.ok(report.syncStatus);
    assert.ok(Array.isArray(report.recommendations));
  });

  it('should get cached sync report', () => {
    verifier.registerTraceItem('contract-1', 'item-1', { description: 'Feature A' });
    verifier.generateSyncReport('contract-1');
    const cached = verifier.getSyncReport('contract-1');
    assert.ok(cached);
    assert.strictEqual(cached.contractId, 'contract-1');
  });

  it('should expose TRACE_STATUS and SYNC_STATUS', () => {
    assert.ok(SddSyncVerifier.TRACE_STATUS);
    assert.strictEqual(SddSyncVerifier.TRACE_STATUS.PENDING, 'pending');
    assert.strictEqual(SddSyncVerifier.TRACE_STATUS.IMPLEMENTED, 'implemented');
    assert.strictEqual(SddSyncVerifier.TRACE_STATUS.PARTIAL, 'partial');
    assert.strictEqual(SddSyncVerifier.TRACE_STATUS.DEVIATED, 'deviated');
    assert.strictEqual(SddSyncVerifier.TRACE_STATUS.STALE, 'stale');
    assert.ok(SddSyncVerifier.SYNC_STATUS);
    assert.strictEqual(SddSyncVerifier.SYNC_STATUS.SYNCED, 'synced');
    assert.strictEqual(SddSyncVerifier.SYNC_STATUS.DOC_AHEAD, 'doc-ahead');
    assert.strictEqual(SddSyncVerifier.SYNC_STATUS.CODE_AHEAD, 'code-ahead');
    assert.strictEqual(SddSyncVerifier.SYNC_STATUS.DIVERGED, 'diverged');
    assert.strictEqual(SddSyncVerifier.SYNC_STATUS.UNKNOWN, 'unknown');
  });

  it('should shutdown gracefully', () => {
    verifier.registerTraceItem('contract-1', 'item-1', { description: 'Feature A' });
    verifier.shutdown();
    assert.strictEqual(verifier.isHealthy(), false);
  });
});

describe('SddDocumentValidator Clarification & Ambiguity', () => {
  let validator;

  beforeEach(() => {
    validator = new SddDocumentValidator();
  });

  it('should generate clarification questions for sparse document', () => {
    const sparseDoc = '## Problem\nshort\n## Solution\nshort\n## Scope\nshort\n## Stakeholders\nshort';
    const questions = validator.generateClarificationQuestions('propose', sparseDoc);
    assert.ok(Array.isArray(questions));
    assert.ok(questions.length > 0);
  });

  it('should detect scope boundary ambiguity', () => {
    const docWithScope = '## Problem\nThe system needs improvement with detailed context and background.\n## Solution\nWe will implement a new approach.\n## Scope\nThis covers the main features and in-scope items.\n## Stakeholders\nDevelopment team and users.';
    const questions = validator.generateClarificationQuestions('propose', docWithScope);
    const boundaryQuestion = questions.find(q => q.type === 'boundary-ambiguity');
    assert.ok(boundaryQuestion);
    assert.strictEqual(boundaryQuestion.section, 'scope');
  });

  it('should detect non-measurable acceptance criteria', () => {
    const docWithCriteria = '## Functional Requirements\nThe system must support user authentication and session management.\n## Non-Functional Requirements\nThe system should be reliable and available.\n## Constraints\nMust use CommonJS modules.\n## Acceptance Criteria\nThe system must work correctly and pass all tests.';
    const questions = validator.generateClarificationQuestions('spec', docWithCriteria);
    const measurableQuestion = questions.find(q => q.type === 'non-measurable');
    assert.ok(measurableQuestion);
    assert.strictEqual(measurableQuestion.section, 'acceptanceCriteria');
  });

  it('should detect contradictions', () => {
    const docWithContradiction = '## Problem\nThe system must always enforce security policies but may optionally skip validation.\n## Solution\nWe will implement both real-time and batch processing.\n## Scope\nScope with unlimited capacity but capped at 100 users.\n## Stakeholders\nTeam.';
    const questions = validator.generateClarificationQuestions('propose', docWithContradiction);
    const contradictionQuestions = questions.filter(q => q.type === 'contradiction');
    assert.ok(contradictionQuestions.length > 0);
  });

  it('should detect ambiguity in vague terms', () => {
    const docWithVague = '## Problem\nThe system should be fast and user-friendly.\n## Solution\nWe will implement TBD features with appropriate measures.\n## Scope\nScope is reasonable.\n## Stakeholders\nTeam.';
    const ambiguities = validator.detectAmbiguity('propose', docWithVague);
    assert.ok(Array.isArray(ambiguities));
    assert.ok(ambiguities.length > 0);
    const hasFast = ambiguities.some(a => a.term.includes('should') && a.term.includes('fast'));
    const hasUserFriendly = ambiguities.some(a => a.term.includes('user') && a.term.includes('friendly'));
    const hasTbd = ambiguities.some(a => /tbd/i.test(a.term));
    assert.strictEqual(hasFast, true);
    assert.strictEqual(hasUserFriendly, true);
    assert.strictEqual(hasTbd, true);
  });

  it('should return empty for unknown stage', () => {
    const questions = validator.generateClarificationQuestions('unknown', 'some content');
    assert.ok(Array.isArray(questions));
    assert.strictEqual(questions.length, 0);
  });

  it('should return empty for empty content', () => {
    const questions = validator.generateClarificationQuestions('propose', '');
    assert.ok(Array.isArray(questions));
    assert.strictEqual(questions.length, 0);
  });
});

describe('SddPhaseBridge Auto-Enforcement', () => {
  let contractManager;

  beforeEach(() => {
    contractManager = new SddContractManager();
  });

  it('should auto-enforce on phase transition', () => {
    const bridge = new SddPhaseBridge({ autoEnforce: true, blockOnGateFailure: false });
    bridge.attachSddContractManager(contractManager);
    const { contractId } = contractManager.createContract('/test/project');
    contractManager.advanceStage(contractId, VALID_PROPOSE_DOC);
    let gateEnforced = false;
    bridge.on('contract-gate-enforced', () => { gateEnforced = true; });
    const handlers = {};
    const mockPO = {
      on: function(event, handler) { handlers[event] = handler; },
      off: function() {},
    };
    bridge.attachToPhaseOrchestrator(mockPO);
    assert.ok(handlers['phase-changed']);
    handlers['phase-changed']({ phase: 'brainstorming' });
    assert.strictEqual(gateEnforced, true);
    bridge.shutdown();
  });

  it('should block on gate failure when configured', () => {
    const bridge = new SddPhaseBridge({ autoEnforce: true, blockOnGateFailure: true });
    bridge.attachSddContractManager(contractManager);
    contractManager.createContract('/test/project');
    let gateBlocked = false;
    bridge.on('contract-gate-blocked', () => { gateBlocked = true; });
    let phasePaused = false;
    const handlers = {};
    const mockPO = {
      on: function(event, handler) { handlers[event] = handler; },
      off: function() {},
      pausePhase: function() { phasePaused = true; },
    };
    bridge.attachToPhaseOrchestrator(mockPO);
    handlers['phase-changed']({ phase: 'module-development' });
    assert.strictEqual(gateBlocked, true);
    assert.strictEqual(phasePaused, true);
    bridge.shutdown();
  });

  it('should not auto-enforce when disabled', () => {
    const bridge = new SddPhaseBridge({ autoEnforce: false });
    bridge.attachSddContractManager(contractManager);
    const handlers = {};
    const mockPO = {
      on: function(event, handler) { handlers[event] = handler; },
      off: function() {},
    };
    bridge.attachToPhaseOrchestrator(mockPO);
    assert.strictEqual(handlers['phase-transition'], undefined);
    bridge.shutdown();
  });
});
