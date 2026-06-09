#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = process.cwd();
let FRAMEWORK_VERSION = '0.0.0';
try {
    const _pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    if (_pkg && _pkg.version) FRAMEWORK_VERSION = _pkg.version;
} catch (_e) { }

function findProjectRoot() {
    let dir = PROJECT_ROOT;
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, '.harness', 'config.json'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return PROJECT_ROOT;
}

const root = findProjectRoot();

function cmdInit() {
    const harnessDir = path.join(root, '.harness');
    const dirs = [
        'commands', 'skills', 'agents', 'sessions', 'knowledge',
        'workspace/staging', 'workspace/shared', 'workspace/locks',
        'checkpoints', 'rag/documents', 'rag/indexes',
    ];
    for (const d of dirs) {
        const full = path.join(harnessDir, d);
        if (!fs.existsSync(full)) {
            fs.mkdirSync(full, { recursive: true });
            console.log('  Created: .harness/' + d);
        } else {
            console.log('  Exists:  .harness/' + d);
        }
    }
    const configFile = path.join(harnessDir, 'config.json');
    if (!fs.existsSync(configFile)) {
        const defaultConfig = {
            project_name: path.basename(root),
            version: '2.7.100',
            token_budget: 1000000000,
            skill_registry: { auto_trigger_enabled: true, skills: [] },
            agent_permissions: {},
            hooks: {},
            context_compression: { threshold: 0.8, retainCurrentPhase: true, retainKeyDecisions: true },
            mcp_servers: {},
            rag: { enabled: true, chunk_size: 512, chunk_overlap: 64, top_k: 5 },
            security: { rbac_level: 'recommended', audit_enabled: true, dev_bypass_env_only: true },
            tdd: { enforced: true, coverage_threshold: 80 },
        };
        fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));
        console.log('  Created: .harness/config.json');
    } else {
        console.log('  Exists:  .harness/config.json');
    }
    const envFile = path.join(root, '.env.harness');
    if (!fs.existsSync(envFile)) {
        fs.writeFileSync(envFile, '# Harness Engineering Environment Variables\n# HARNESS_API_TOKEN=your-api-token-here\n# NODE_ENV=development\n');
        console.log('  Created: .env.harness');
    }
    const gitignoreFile = path.join(root, '.gitignore');
    let gitignoreContent = '';
    if (fs.existsSync(gitignoreFile)) {
        gitignoreContent = fs.readFileSync(gitignoreFile, 'utf8');
    }
    if (!gitignoreContent.includes('.harness/sessions') || !gitignoreContent.includes('.harness/checkpoints')) {
        const harnessIgnore = [
            '',
            '# Harness Engineering',
            '.harness/sessions/',
            '.harness/checkpoints/',
            '.harness/workspace/locks/',
            '.harness/rag/indexes/',
            '.env.harness',
        ].join('\n');
        fs.appendFileSync(gitignoreFile, gitignoreContent.endsWith('\n') ? harnessIgnore : '\n' + harnessIgnore);
        console.log('  Updated: .gitignore');
    }
    console.log('\n  Harness project initialized successfully!');
    console.log('  Run `node harness-cli.js quickstart` to get started.\n');
}

function cmdVersion() {
    console.log('  Harness Engineering Framework v' + FRAMEWORK_VERSION);
    const configFile = path.join(root, '.harness', 'config.json');
    if (fs.existsSync(configFile)) {
        try {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            console.log('  Project:     ' + (config.project_name || 'unknown'));
            console.log('  Config ver:  ' + (config.version || 'unknown'));
        } catch (_e) {
            console.log('  Config:      (unreadable)');
        }
    } else {
        console.log('  Config:      (not initialized - run `init` first)');
    }
}

function cmdValidate() {
    const harness = require('./src/index');
    try {
        const h = harness.create(root);
        const cr = h.commandRouter;
        const router = h.router;
        const ph = h.programmableHookExecutor;
        const cc = h.contextCompressionEngine;

        console.log('\n=== Harness Framework Validation ===\n');
        console.log('  Commands:    ' + cr.commands.length + ' discovered');
        console.log('  Skills:      ' + router.skills.length + ' loaded (' + router.getVerifiedSkills().length + ' verified)');
        console.log('  Agents:      ' + Object.keys(h.enforcer.agents).length + ' configured');
        console.log('  Hook Builtin: ' + ph.getStats().builtinCount + ' handlers');
        console.log('  Compression:  ' + (cc.isHealthy() ? 'healthy' : 'unhealthy'));
        console.log('  Validation:   ' + (h.validation.valid ? 'PASSED' : 'FAILED'));

        if (!h.validation.valid && h.validation.errors) {
            console.log('\n  Errors:');
            for (const e of h.validation.errors) {
                console.log('    - ' + e);
            }
        }

        h.destroy();
        process.exit(h.validation.valid ? 0 : 1);
    } catch (err) {
        console.error('Validation failed:', err.message);
        process.exit(1);
    }
}

function cmdStatus() {
    const harness = require('./src/index');
    (async function() {
        try {
            const h = harness.create(root);
            const health = await h.healthChecker.checkAll();
            const report = await h.healthChecker.getAggregatedReport();
            const summary = report.summary || {};

            console.log('\n=== Harness Framework Status ===\n');
            console.log('  Framework:    v' + FRAMEWORK_VERSION);
            console.log('  Project:      ' + path.basename(root));
            console.log('  Overall:      ' + (report.status || health.status).toUpperCase());
            console.log('  Checks:       ' + (summary.healthy ?? 0) + '/' + (summary.total ?? 0) + ' passed');
            console.log('  Uptime:       ' + Math.floor(process.uptime()) + 's');

            if (summary.criticalIssues > 0 || summary.warningIssues > 0) {
                const checks = health.checks || {};
                const unhealthy = Object.entries(checks).filter(function(e) { return e[1].status !== 'healthy'; });
                if (unhealthy.length > 0) {
                    console.log('\n  Unhealthy modules:');
                    for (const [name, result] of unhealthy.slice(0, 10)) {
                        console.log('    - ' + name + ': ' + (result.message || result.status));
                    }
                }
            }

            const sessionCount = Object.keys(h.session.sessions || {}).length;
            const activeSessions = Object.values(h.session.sessions || {}).filter(function(s) { return s.status === 'active'; }).length;
            console.log('\n  Sessions:     ' + sessionCount + ' total, ' + activeSessions + ' active');
            console.log('  Skills:       ' + h.router.skills.length + ' discovered');
            console.log('  Commands:     ' + h.commandRouter.commands.length + ' available');
            console.log('  Agents:       ' + Object.keys(h.enforcer.agents).length + ' configured');

            h.destroy();
        } catch (err) {
            console.error('Status check failed:', err.message);
            process.exit(1);
        }
    })();
}

function cmdCommands() {
    const harness = require('./src/index');
    const h = harness.create(root);
    console.log(h.commandRouter.getHelpText(true));
    h.destroy();
}

function cmdSkills() {
    const harness = require('./src/index');
    const h = harness.create(root);
    const skills = h.router.skills;
    console.log('\n=== Harness Skills ===\n');
    for (const s of skills) {
        const badge = s.verified ? '[verified]' : '[unverified]';
        const stability = s.stability || 'unknown';
        console.log('  ' + badge.padEnd(12) + ('[' + stability + ']').padEnd(12) + s.skill_id);
    }
    console.log('\n  Total: ' + skills.length + ' | Verified: ' + h.router.getVerifiedSkills().length);
    h.destroy();
}

function cmdAgents() {
    const harness = require('./src/index');
    const h = harness.create(root);
    const agents = h.enforcer.agents;
    const keys = Object.keys(agents);
    console.log('\n=== Harness Agents ===\n');
    for (const a of keys) {
        const agent = agents[a];
        const perms = agent.permissions || {};
        const permLevel = perms.level || 'unknown';
        const tdd = agent.tdd_enforced ? 'TDD' : '';
        const auto = agent.auto_route ? 'Auto' : '';
        const tags = [tdd, auto].filter(Boolean).join(', ');
        console.log('  - ' + a.padEnd(22) + ' [' + permLevel + ']' + (tags ? ' (' + tags + ')' : ''));
    }
    console.log('\n  Total: ' + keys.length);
    h.destroy();
}

function cmdConfig() {
    const subCmd = process.argv[3] || 'show';
    const configFile = path.join(root, '.harness', 'config.json');

    if (!fs.existsSync(configFile)) {
        console.error('Config file not found. Run `init` first.');
        process.exit(1);
    }

    if (subCmd === 'show') {
        try {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            console.log('\n=== Harness Configuration ===\n');
            console.log(JSON.stringify(config, null, 2));
        } catch (err) {
            console.error('Failed to read config:', err.message);
        }
    } else if (subCmd === 'get') {
        const key = process.argv[4];
        if (!key) {
            console.error('Usage: node harness-cli.js config get <key>');
            process.exit(1);
        }
        try {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            const value = key.split('.').reduce(function(obj, k) { return obj && obj[k]; }, config);
            if (value !== undefined) {
                console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
            } else {
                console.log('(not set)');
            }
        } catch (err) {
            console.error('Failed to read config:', err.message);
        }
    } else if (subCmd === 'set') {
        const key = process.argv[4];
        const value = process.argv[5];
        if (!key || value === undefined) {
            console.error('Usage: node harness-cli.js config set <key> <value>');
            process.exit(1);
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(key)) {
            console.error('Invalid key format. Only alphanumeric, underscore, and dot characters are allowed.');
            process.exit(1);
        }
        if (key === '__proto__' || key === 'constructor' || key === 'prototype' || key.includes('.__proto__') || key.includes('.constructor.') || key.includes('.prototype.')) {
            console.error('Forbidden key: ' + key);
            process.exit(1);
        }
        try {
            const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            const keys = key.split('.');
            let obj = config;
            for (let i = 0; i < keys.length - 1; i++) {
                if (obj[keys[i]] !== undefined && typeof obj[keys[i]] !== 'object') {
                    console.error('Cannot set nested key "' + key + '": intermediate key "' + keys[i] + '" already exists as ' + typeof obj[keys[i]]);
                    process.exit(1);
                }
                if (!obj[keys[i]]) obj[keys[i]] = {};
                obj = obj[keys[i]];
            }
            let parsed = value;
            try { parsed = JSON.parse(value); } catch (_e) { }
            obj[keys[keys.length - 1]] = parsed;
            fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
            console.log('Set ' + key + ' = ' + JSON.stringify(parsed));
        } catch (err) {
            console.error('Failed to update config:', err.message);
        }
    } else {
        console.error('Unknown config subcommand: ' + subCmd);
        console.log('Usage: node harness-cli.js config [show|get|set]');
    }
}

function cmdDashboard() {
    let port = parseInt(process.env.HARNESS_PORT, 10) || 3210;
    let host = 'localhost';
    let shouldOpen = false;

    for (let i = 3; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === '--port' && process.argv[i + 1]) {
            const p = parseInt(process.argv[i + 1], 10);
            port = Number.isFinite(p) && p > 0 && p < 65536 ? p : 3210;
            i++;
        } else if (arg === '--host' && process.argv[i + 1]) {
            host = process.argv[i + 1];
            i++;
        } else if (arg === '--open') {
            shouldOpen = true;
        } else if (arg === '--no-ws') {
            process.env.HARNESS_NO_WS = '1';
        }
    }

    const harnessDir = path.join(root, '.harness');
    if (!fs.existsSync(harnessDir)) {
        console.log('  .harness/ directory not found. Auto-initializing...');
        cmdInit();
    }

    const DashboardServer = require('./src/web/server');
    const harness = require('./src/index').create(root);
    if (!process.env.HARNESS_API_TOKEN && !process.env.NODE_ENV) {
        process.env.NODE_ENV = 'development';
    }
    const server = new DashboardServer(root, port, harness);
    server.start().then(function() {
        console.log('\n  Dashboard running at http://' + host + ':' + port);
        console.log('  Press Ctrl+C to stop\n');
        if (shouldOpen) {
            const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
            const safeHost = host.replace(/[^a-zA-Z0-9.-]/g, '');
            const safeUrl = 'http://' + safeHost + ':' + port;
            const cp = require('child_process');
            cp.execFile(opener, [safeUrl], function(err) {
                if (err) console.warn('Failed to open browser:', err.message);
            });
        }
        function gracefulShutdown() {
            console.log('\n  Shutting down...');
            try { server.stop(); } catch(e) { /* ignore */ }
            try { harness.destroy(); } catch(e) { /* ignore */ }
            process.exit(0);
        }
        process.on('SIGINT', gracefulShutdown);
        process.on('SIGTERM', gracefulShutdown);
    }).catch(function(err) {
        console.error('Failed to start dashboard:', err.message);
        process.exit(1);
    });
}

function cmdMemoryVerify() {
    const harness = require('./src/index');
    try {
        const h = harness.create(root);
        const verifier = h.verifier;
        const memoryStore = h.memoryStore;
        const stats = memoryStore.getStats();

        console.log('\n=== Memory Verification Report ===\n');
        console.log('  Knowledge entries:  ' + stats.knowledgeCount);
        console.log('  Session summaries:  ' + stats.summaryCount);

        let staleCount = 0;
        let verifiedCount = 0;
        const staleEntries = [];

        if (stats.knowledgeCount > 0) {
            const allKnowledge = memoryStore.queryKnowledge({});
            for (const entry of allKnowledge) {
                const content = entry.content || '';
                const pathRefs = content.match(/\/[\w.-]+\.(js|ts|py|go|rs|java|jsx|tsx|md|json)\b/gi);
                if (pathRefs && pathRefs.length > 0) {
                    for (const ref of pathRefs) {
                        const cleanRef = ref.replace(/^\//, '');
                        const fullPath = path.join(root, cleanRef);
                        if (!fs.existsSync(fullPath)) {
                            staleCount++;
                            staleEntries.push({
                                id: entry.id,
                                title: entry.title || entry.id,
                                stalePath: cleanRef,
                                category: entry.category,
                            });
                            break;
                        }
                    }
                    if (!staleEntries.some(e => e.id === entry.id)) {
                        verifiedCount++;
                    }
                } else {
                    verifiedCount++;
                }
            }
        }

        const total = stats.knowledgeCount;
        const verificationRate = total > 0 ? Math.round((verifiedCount / total) * 100) : 100;

        console.log('  Verified:           ' + verifiedCount + '/' + total);
        console.log('  Stale references:   ' + staleCount);
        console.log('  Verification rate:  ' + verificationRate + '%');

        if (staleEntries.length > 0) {
            console.log('\n  Stale References:');
            for (const entry of staleEntries.slice(0, 20)) {
                console.log('    - [' + entry.category + '] ' + entry.title + ': ' + entry.stalePath);
            }
            if (staleEntries.length > 20) {
                console.log('    ... and ' + (staleEntries.length - 20) + ' more');
            }
        }

        console.log('\n  Result: ' + (verificationRate >= 80 ? 'HEALTHY' : 'NEEDS ATTENTION'));

        h.destroy();
        process.exit(verificationRate >= 80 ? 0 : 1);
    } catch (err) {
        console.error('Memory verification failed:', err.message);
        process.exit(1);
    }
}

function cmdAntipatternDetect() {
    const harness = require('./src/index');
    try {
        const h = harness.create(root);
        const monitor = h.agentMonitor;

        console.log('\n=== Antipattern Detection Report ===\n');

        const rules = monitor.getAntipatternRules();
        console.log('  Detection rules:    ' + rules.length);
        for (const rule of rules) {
            console.log('    - [' + rule.severity + '] ' + rule.name + ': ' + rule.description);
        }

        const agents = Object.keys(h.enforcer.agents);
        let totalDetections = 0;
        const allDetections = [];

        if (agents.length > 0) {
            console.log('\n  Scanning ' + agents.length + ' configured agents...');

            for (const agentId of agents) {
                const detected = monitor.detectAntipatterns(agentId);
                if (detected.length > 0) {
                    for (const d of detected) {
                        allDetections.push(d);
                        totalDetections++;
                    }
                }
            }
        }

        const alerts = monitor.getAlerts({});
        const antipatternAlerts = alerts.filter(function(a) {
            return a.metricName && a.metricName.startsWith('antipattern:');
        });

        console.log('\n  Active detections:  ' + totalDetections);
        console.log('  Alert history:      ' + antipatternAlerts.length);

        if (allDetections.length > 0) {
            console.log('\n  Detected Antipatterns:');
            const seen = new Set();
            for (const d of allDetections) {
                const key = d.id + ':' + d.agentId;
                if (seen.has(key)) continue;
                seen.add(key);
                console.log('    - [' + d.severity + '] ' + d.name + ' (agent: ' + d.agentId + ')');
                console.log('      ' + d.recommendation);
            }
        } else {
            console.log('\n  No antipatterns detected. All agents behaving within normal parameters.');
        }

        console.log('\n  Result: ' + (totalDetections === 0 ? 'CLEAN' : 'ISSUES FOUND'));

        h.destroy();
        process.exit(totalDetections === 0 ? 0 : 1);
    } catch (err) {
        console.error('Antipattern detection failed:', err.message);
        process.exit(1);
    }
}

function cmdQuickstart() {
    console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
    console.log('  ║          Harness Engineering - Quick Start Guide           ║');
    console.log('  ╚══════════════════════════════════════════════════════════════╝\n');
    console.log('  1. Initialize your project:');
    console.log('     $ node harness-cli.js init\n');
    console.log('  2. Start the Dashboard:');
    console.log('     $ node harness-cli.js dashboard --open\n');
    console.log('  3. Check framework status:');
    console.log('     $ node harness-cli.js status\n');
    console.log('  4. In Trae IDE, use slash commands:');
    console.log('     /plan    - Plan a new feature (brainstorming -> analysis -> design)');
    console.log('     /test    - Run integration tests');
    console.log('     /code-review  - Review code quality');
    console.log('     /security-review - Security audit\n');
    console.log('  5. Key concepts:');
    console.log('     - 17 Agent roles (6 functional + 5 task + 5 language reviewers + 1 human role)');
    console.log('     - 40 Skills auto-routed by context');
    console.log('     - TDD gate enforced (RED-GREEN-REFACTOR)');
    console.log('     - RBAC + chain-hash audit logging');
    console.log('     - Evidence-based verification\n');
    console.log('  6. Configuration:');
    console.log('     $ node harness-cli.js config show');
    console.log('     $ node harness-cli.js config set rag.enabled true\n');
    console.log('  7. RAG Knowledge Base:');
    console.log('     $ node harness-cli.js rag ingest ./docs');
    console.log('     $ node harness-cli.js rag query "how does TDD gate work"\n');
    console.log('  Documentation: https://github.com/harness-engineering/harness\n');
}

function cmdRag() {
    const subCmd = process.argv[3] || 'help';
    const harness = require('./src/index');

    if (subCmd === 'ingest') {
        const docPath = process.argv[4];
        if (!docPath) {
            console.error('Usage: node harness-cli.js rag ingest <path-to-docs>');
            process.exit(1);
        }
        try {
            const h = harness.create(root);
            const memoryStore = h.memoryStore;
            const stats = memoryStore.getStats();
            console.log('\n=== RAG Ingest ===\n');
            console.log('  Current knowledge entries: ' + stats.knowledgeCount);

            const resolvedPath = path.resolve(docPath);
            if (!fs.existsSync(resolvedPath)) {
                console.error('  Path not found: ' + resolvedPath);
                h.destroy();
                process.exit(1);
            }

            let ingested = 0;
            const stat = fs.statSync(resolvedPath);
            const files = [];

            if (stat.isFile()) {
                files.push(resolvedPath);
            } else if (stat.isDirectory()) {
                function walkDir(dir) {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
                            walkDir(fullPath);
                        } else if (entry.isFile() && /\.(md|txt|json|js|ts|py|go|rs|java)$/i.test(entry.name)) {
                            files.push(fullPath);
                        }
                    }
                }
                walkDir(resolvedPath);
            }

            for (const file of files) {
                try {
                    const content = fs.readFileSync(file, 'utf8');
                    if (content.length < 10) continue;
                    const relativePath = path.relative(root, file);
                    const title = relativePath.replace(/\\/g, '/');
                    const category = path.extname(file).replace('.', '');
                    memoryStore.addKnowledge({
                        title: title,
                        content: content.substring(0, 1048576),
                        category: category,
                        tags: [category, path.basename(file, path.extname(file))],
                        source: relativePath,
                    });
                    ingested++;
                } catch (fileErr) {
                    console.error('  Failed to ingest: ' + file + ' - ' + fileErr.message);
                }
            }

            console.log('  Ingested: ' + ingested + '/' + files.length + ' files');
            console.log('  Total knowledge entries: ' + memoryStore.getStats().knowledgeCount);
            h.destroy();
        } catch (err) {
            console.error('RAG ingest failed:', err.message);
            process.exit(1);
        }
    } else if (subCmd === 'query') {
        const query = process.argv.slice(4).join(' ');
        if (!query) {
            console.error('Usage: node harness-cli.js rag query <search-text>');
            process.exit(1);
        }
        try {
            const h = harness.create(root);
            const results = h.memoryStore.queryKnowledge({ query: query });
            console.log('\n=== RAG Query Results ===\n');
            console.log('  Query: "' + query + '"');
            console.log('  Results: ' + results.length + '\n');
            for (const r of results.slice(0, 10)) {
                console.log('  [' + (r.category || 'unknown') + '] ' + (r.title || r.id));
                const preview = (r.content || '').substring(0, 120).replace(/\n/g, ' ');
                console.log('    ' + preview + (r.content && r.content.length > 120 ? '...' : ''));
                console.log('');
            }
            h.destroy();
        } catch (err) {
            console.error('RAG query failed:', err.message);
            process.exit(1);
        }
    } else if (subCmd === 'stats') {
        try {
            const h = harness.create(root);
            const stats = h.memoryStore.getStats();
            console.log('\n=== RAG Knowledge Base Stats ===\n');
            console.log('  Knowledge entries:  ' + stats.knowledgeCount);
            console.log('  Session summaries:  ' + stats.summaryCount);
            console.log('  Max entries:        ' + (stats.maxEntries || 'unlimited'));
            h.destroy();
        } catch (err) {
            console.error('RAG stats failed:', err.message);
            process.exit(1);
        }
    } else {
        console.log('\n  RAG Knowledge Base Commands:\n');
        console.log('    rag ingest <path>   Ingest documents into knowledge base');
        console.log('    rag query <text>    Search knowledge base');
        console.log('    rag stats           Show knowledge base statistics\n');
    }
}

function cmdCurate() {
    const subCmd = process.argv[3] || 'run';
    const SkillCurator = require('./src/runtime/skill/skill-curator');
    const harness = require('./src/index');

    try {
        const h = harness.create(root);
        const curator = new SkillCurator({ projectRoot: root, skillRouter: h.router });

        if (subCmd === 'run') {
            const result = curator.runCuration();
            console.log('\n=== Skill Curation Report ===\n');
            console.log('  Reviewed:  ' + result.reviewed);
            console.log('  Stale:     ' + result.stale);
            console.log('  Archived:  ' + result.archived);
            console.log('\n  Result: ' + (result.stale === 0 ? 'ALL HEALTHY' : 'ACTION NEEDED'));
        } else if (subCmd === 'dry-run') {
            const result = curator.dryRunCuration();
            console.log('\n=== Skill Curation Dry-Run ===\n');
            console.log('  Reviewed:       ' + result.reviewed);
            console.log('  Skipped pinned: ' + result.skippedPinned);
            console.log('  Would flag:     ' + result.wouldFlag.length);
            if (result.wouldFlag.length > 0) {
                console.log('\n  Flagged skills:');
                for (const f of result.wouldFlag) {
                    console.log('    - [' + f.reason + '] ' + f.skillId);
                }
            }
            console.log('\n  (No changes were made)');
        } else if (subCmd === 'pin') {
            const skillId = process.argv[4];
            const reason = process.argv.slice(5).join(' ') || 'Protected by operator';
            if (!skillId) {
                console.error('Usage: node harness-cli.js curate pin <skillId> [reason]');
                process.exit(1);
            }
            curator.pinSkill(skillId, reason);
            console.log('  Pinned skill: ' + skillId + ' (reason: ' + reason + ')');
        } else if (subCmd === 'unpin') {
            const skillId = process.argv[4];
            if (!skillId) {
                console.error('Usage: node harness-cli.js curate unpin <skillId>');
                process.exit(1);
            }
            curator.unpinSkill(skillId);
            console.log('  Unpinned skill: ' + skillId);
        } else if (subCmd === 'classify') {
            const skillId = process.argv[4];
            const source = process.argv[5];
            if (!skillId || !source) {
                console.error('Usage: node harness-cli.js curate classify <skillId> <builtin|user|generated|evolved>');
                process.exit(1);
            }
            try {
                curator.classifySkill(skillId, source);
                console.log('  Classified skill: ' + skillId + ' as ' + source);
            } catch (err) {
                console.error('  ' + err.message);
                process.exit(1);
            }
        } else if (subCmd === 'snapshot') {
            const snapshot = curator.createSnapshot();
            console.log('\n=== Snapshot Created ===\n');
            console.log('  ID:            ' + snapshot.id);
            console.log('  Timestamp:     ' + new Date(snapshot.timestamp).toISOString());
            console.log('  Usage entries: ' + snapshot.usageEntries);
            console.log('  Pinned:        ' + snapshot.pinnedCount);
            console.log('  Classifications: ' + snapshot.classificationCount);
        } else if (subCmd === 'snapshots') {
            const snapshots = curator.listSnapshots();
            console.log('\n=== Available Snapshots ===\n');
            if (snapshots.length === 0) {
                console.log('  No snapshots available.');
            } else {
                for (const s of snapshots) {
                    console.log('  ' + s.id + '  ' + new Date(s.timestamp).toISOString() + '  (usage:' + s.usageEntries + ' pinned:' + s.pinnedCount + ')');
                }
            }
        } else if (subCmd === 'rollback') {
            const snapshotId = process.argv[4];
            if (!snapshotId) {
                console.error('Usage: node harness-cli.js curate rollback <snapshotId>');
                process.exit(1);
            }
            const result = curator.rollbackToSnapshot(snapshotId);
            if (result.success) {
                console.log('  Rolled back to snapshot: ' + snapshotId);
            } else {
                console.error('  Rollback failed: ' + result.error);
                process.exit(1);
            }
        } else if (subCmd === 'stats') {
            const stats = curator.getAllStats();
            console.log('\n=== Curator Statistics ===\n');
            console.log('  Curations run:    ' + stats.curatorStats.curated);
            console.log('  Skills reviewed:  ' + stats.curatorStats.reviewed);
            console.log('  Skills archived:  ' + stats.curatorStats.archived);
            console.log('  Total tracked:    ' + stats.totalTracked);
            console.log('  Pinned skills:    ' + stats.pinnedCount);
            console.log('  Classifications:  ' + stats.classificationCount);
            console.log('  Stale threshold:  ' + stats.staleThresholdDays + ' days');
        } else {
            console.log('\n  Skill Curation Commands:\n');
            console.log('    curate run              Run skill curation');
            console.log('    curate dry-run          Simulate curation without changes');
            console.log('    curate pin <id> [reason]  Pin a skill (protect from archive)');
            console.log('    curate unpin <id>       Unpin a skill');
            console.log('    curate classify <id> <type>  Classify skill source (builtin|user|generated|evolved)');
            console.log('    curate snapshot         Create a state snapshot');
            console.log('    curate snapshots        List available snapshots');
            console.log('    curate rollback <id>    Rollback to a snapshot');
            console.log('    curate stats            Show curator statistics\n');
        }

        h.destroy();
    } catch (err) {
        console.error('Curate command failed:', err.message);
        process.exit(1);
    }
}

function cmdTUI() {
    const harnessDir = path.join(root, '.harness');
    if (!fs.existsSync(harnessDir)) {
        console.log('  .harness/ directory not found. Auto-initializing...');
        cmdInit();
    }

    let resumeSession = null;
    let continueLast = false;
    let resumeName = null;

    for (let i = 3; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg === '--continue' || arg === '-c') {
            if (process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
                resumeName = process.argv[i + 1];
                i++;
            } else {
                continueLast = true;
            }
        } else if (arg === '--resume' && process.argv[i + 1]) {
            resumeSession = process.argv[i + 1];
            i++;
        }
    }

    const TUIOrchestrator = require('./src/runtime/tui/tui-orchestrator');
    const harness = require('./src/index').create(root);

    let quickCommandsConfig = null;
    try {
        const config = JSON.parse(fs.readFileSync(path.join(root, '.harness', 'config.json'), 'utf8'));
        if (config.quick_commands || config.quickCommands) {
            quickCommandsConfig = config;
        }
    } catch (_e) { }

    const orchestrator = new TUIOrchestrator(root, {
        commandRouter: harness.commandRouter,
        tokenManager: harness.tokenManager,
        sessionManager: harness.session,
        contextCompressionEngine: harness.contextCompressionEngine,
        quickCommands: quickCommandsConfig,
    });

    if (resumeSession) {
        try {
            if (orchestrator.resumeSession(resumeSession)) {
                console.log('  恢复会话: ' + resumeSession);
            } else {
                console.log('  会话未找到: ' + resumeSession + '，创建新会话');
            }
        } catch (_e) {
            console.log('  会话恢复失败，创建新会话');
        }
    } else if (resumeName) {
        console.log('  按名称查找会话: ' + resumeName);
    } else if (continueLast) {
        try {
            if (orchestrator.continueLastSession()) {
                console.log('  继续最近会话');
            }
        } catch (_e) { /* no session to continue */ }
    }

    orchestrator.start().catch(function(err) {
        console.error('TUI 启动失败:', err.message);
        process.exit(1);
    });

    function gracefulShutdown() {
        console.log('\n  正在关闭 TUI...');
        try { orchestrator.stop(); } catch(e) { /* ignore */ }
        try { harness.destroy(); } catch(e) { /* ignore */ }
        process.exit(0);
    }
    process.on('SIGINT', gracefulShutdown);
    process.on('SIGTERM', gracefulShutdown);
}

const args = process.argv.slice(2);
const command = args[0] || 'help';

switch (command) {
    case 'init':
        cmdInit();
        break;
    case 'validate':
        cmdValidate();
        break;
    case 'version':
        cmdVersion();
        break;
    case 'status':
        cmdStatus();
        break;
    case 'commands':
        cmdCommands();
        break;
    case 'skills':
        cmdSkills();
        break;
    case 'agents':
        cmdAgents();
        break;
    case 'config':
        cmdConfig();
        break;
    case 'dashboard':
        cmdDashboard();
        break;
    case 'memory-verify':
        cmdMemoryVerify();
        break;
    case 'antipattern-detect':
        cmdAntipatternDetect();
        break;
    case 'quickstart':
        cmdQuickstart();
        break;
    case 'rag':
        cmdRag();
        break;
    case 'curate':
        cmdCurate();
        break;
    case 'tui':
        cmdTUI();
        break;
    case 'help':
    default:
        console.log('\n  Harness Engineering CLI v' + FRAMEWORK_VERSION + '\n');
        console.log('  Usage: node harness-cli.js <command> [options]\n');
        console.log('  Commands:');
        console.log('    init              Initialize a new Harness project');
        console.log('    quickstart        Show quick start guide');
        console.log('    validate          Validate framework configuration');
        console.log('    version           Show framework version');
        console.log('    status            Show runtime status and health');
        console.log('    commands          List all slash commands');
        console.log('    skills            List all skills with verification status');
        console.log('    agents            List all configured agents');
        console.log('    config [show|get|set]  View or modify configuration');
        console.log('    dashboard         Start the monitoring dashboard');
        console.log('    rag [ingest|query|stats] RAG knowledge base management');
        console.log('    curate [run|dry-run|pin|unpin|classify|snapshot|snapshots|rollback|stats]');
        console.log('                            Skill curation management');
        console.log('    memory-verify     Verify memory-code consistency');
        console.log('    antipattern-detect Run antipattern detection across agents');
        console.log('    tui               Start interactive TUI mode');
        console.log('    help              Show this help message\n');
        console.log('  TUI options:');
        console.log('    --continue        Continue most recent session');
        console.log('    --resume <id>     Resume a specific session\n');
        console.log('  Dashboard options:');
        console.log('    --port <number>   Set dashboard port (default: 3210)');
        console.log('    --host <addr>     Set bind address (default: localhost)');
        console.log('    --open            Auto-open browser on start');
        console.log('    --no-ws           Disable WebSocket\n');
        break;
}
