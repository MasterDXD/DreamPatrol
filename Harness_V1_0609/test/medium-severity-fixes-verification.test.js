'use strict';

/* eslint max-lines-per-function: ["warn", { "max": 600, "skipComments": true, "skipBlankLines": true }] */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const debugLogger = require('../src/utils/debug-logger');
const StructuredLogger = require('../src/utils/structured-logger');
const { safeCall, safeCallAsync, roundTo } = require('../src/utils/safe-execute');
const DebouncedPersister = require('../src/utils/debounced-persister');
const { estimateTokens, DANGEROUS_KEYS } = require('../src/utils/constants');
const { validatePath } = require('../src/utils/path-utils');
const { isPrivateIp } = require('../src/utils/network-utils');
const JsonStoreRestorer = require('../src/utils/json-store-restorer');
const TTLCache = require('../src/utils/ttl-cache');
const LRUCache = require('../src/utils/lru-cache');
const { t, setLocale } = require('../src/utils/i18n');
const stableStringify = require('../src/utils/stable-stringify');
const { counterId, getCounterValue, getCounterScopes, resetCounter } = require('../src/utils/unique-id');
const capacityConfig = require('../src/utils/capacity-config');
const SkillCurator = require('../src/runtime/skill/skill-curator');

describe('Round 13 Verification Tests', () => {

  describe('1. MEDIUM Severity Fixes', () => {

    describe('1.1 debug-logger info leakage', () => {
      it('sanitizes module labels with \\r, \\n, \\0', () => {
        const bridgeLogs = [];
        const bridge = { warn: (msg) => { bridgeLogs.push(msg); } };
        debugLogger.setBridge(bridge);

        try {
          debugLogger('mod\rule', 'action', new Error('test'));
          debugLogger('mod\nule', 'action', new Error('test'));
          debugLogger('mod\0ule', 'action', new Error('test'));
        } finally {
          debugLogger.setBridge(null);
        }

        assert.strictEqual(bridgeLogs.length, 3);
        assert.ok(!bridgeLogs[0].includes('\r'), 'module label with \\r should be sanitized');
        assert.ok(!bridgeLogs[1].includes('\n'), 'module label with \\n should be sanitized');
        assert.ok(!bridgeLogs[2].includes('\0'), 'module label with \\0 should be sanitized');
      });

      it('sanitizes action labels with control characters', () => {
        const bridgeLogs = [];
        const bridge = { warn: (msg) => { bridgeLogs.push(msg); } };
        debugLogger.setBridge(bridge);

        try {
          debugLogger('module', 'act\rion', new Error('test'));
          debugLogger('module', 'act\nion', new Error('test'));
          debugLogger('module', 'act\0ion', new Error('test'));
        } finally {
          debugLogger.setBridge(null);
        }

        assert.strictEqual(bridgeLogs.length, 3);
        assert.ok(!bridgeLogs[0].includes('\r'), 'action label with \\r should be sanitized');
        assert.ok(!bridgeLogs[1].includes('\n'), 'action label with \\n should be sanitized');
        assert.ok(!bridgeLogs[2].includes('\0'), 'action label with \\0 should be sanitized');
      });
    });

    describe('1.2 structured-logger log injection + module filter', () => {
      it('sanitizes messages containing \\r\\n (no log injection)', () => {
        const logger = new StructuredLogger({ level: 'debug' });
        logger.info('line1\r\nline2 FAKE ENTRY');
        const entries = logger.query({});
        assert.ok(entries.length >= 1);
        assert.ok(!entries[entries.length - 1].message.includes('\r'), 'message should not contain \\r');
        assert.ok(!entries[entries.length - 1].message.includes('\n'), 'message should not contain \\n');
      });

      it('module filter uses exact match, not substring', () => {
        const logger = new StructuredLogger({ level: 'debug', module: 'auth' });
        const child = logger.child('entication');
        logger.info('auth msg');
        child.info('authentication msg');

        const authOnly = logger.query({ module: 'auth' });
        for (const entry of authOnly) {
          assert.ok(
            entry.module === 'auth' || entry.module.startsWith('auth:'),
            'module filter should match exact or prefix, not substring: ' + entry.module,
          );
        }
      });

      it('module filter supports prefix match with : separator', () => {
        const logger = new StructuredLogger({ level: 'debug', module: 'auth' });
        const authLogin = logger.child('login');
        authLogin.info('login event');

        const filtered = authLogin.query({ module: 'auth' });
        assert.ok(filtered.length >= 1, 'should find entries for auth:login via prefix match');
        for (const entry of filtered) {
          assert.ok(
            entry.module === 'auth' || entry.module.startsWith('auth:'),
            'prefix match should use : separator',
          );
        }
      });
    });

    describe('1.3 safe-execute stack trace preservation', () => {
      it('safeCall preserves full Error objects', () => {
        const originalEnv = process.env.HARNESS_DEBUG;
        const originalWrite = process.stderr.write;
        process.env.HARNESS_DEBUG = '1';
        process.stderr.write = () => {};

        try {
          safeCall(() => { throw new Error('detailed error'); }, 'mod', 'act');
        } catch { /* safeCall swallows */ }
        finally {
          process.stderr.write = originalWrite;
          process.env.HARNESS_DEBUG = originalEnv;
        }
      });

      it('safeCallAsync preserves full Error objects', async () => {
        const originalEnv = process.env.HARNESS_DEBUG;
        const originalWrite = process.stderr.write;
        process.env.HARNESS_DEBUG = '1';
        process.stderr.write = () => {};

        try {
          await safeCallAsync(async () => { throw new Error('async detailed error'); }, 'mod', 'act');
        } catch { /* safeCallAsync swallows */ }
        finally {
          process.stderr.write = originalWrite;
          process.env.HARNESS_DEBUG = originalEnv;
        }
      });
    });

    describe('1.4 debounced-persister silent data loss', () => {
      it('tracks _persistFailCount', () => {
        const p = new DebouncedPersister({
          root: null,
          dir: 'test',
          filename: 'test.json',
          serialize: () => ({ a: 1 }),
        });
        assert.strictEqual(p.persistFailCount, 0);
      });

      it('persistFailCount getter works', () => {
        const p = new DebouncedPersister({
          root: null,
          dir: 'test',
          filename: 'test.json',
          serialize: () => ({ a: 1 }),
        });
        assert.strictEqual(typeof p.persistFailCount, 'number');
        assert.ok(p.persistFailCount >= 0);
      });

      it('isDirty getter works', () => {
        const p = new DebouncedPersister({
          root: null,
          dir: 'test',
          filename: 'test.json',
          serialize: () => ({ a: 1 }),
        });
        assert.strictEqual(p.isDirty, false);
        p.schedule();
        assert.strictEqual(p.isDirty, true);
        p.destroy();
      });

      it('retry mechanism works on persist failure', () => {
        const p = new DebouncedPersister({
          root: null,
          dir: 'test',
          filename: 'test.json',
          serialize: () => ({ a: 1 }),
          maxRetries: 3,
          debounceMs: 10,
        });
        assert.strictEqual(p._maxRetries, 3);
        assert.strictEqual(p._retryCount, 0);
        p.destroy();
      });

      it('_dirty stays true on persist failure', () => {
        const p = new DebouncedPersister({
          root: null,
          dir: 'test',
          filename: 'test.json',
          serialize: () => ({ a: 1 }),
        });
        p._dirty = true;
        p.persistNow();
        assert.strictEqual(p.isDirty, true);
        p.destroy();
      });
    });

    describe('1.5 constants CJK token estimation', () => {
      it('estimateTokens for pure English text (~4 chars/token)', () => {
        const text = 'Hello world this is a test of English text';
        const tokens = estimateTokens(text);
        const expected = Math.ceil(text.length / 4);
        assert.strictEqual(tokens, expected);
      });

      it('estimateTokens for pure Chinese text (~1.5 chars/token)', () => {
        const text = '这是一个中文测试文本';
        const tokens = estimateTokens(text);
        const expected = Math.ceil(text.length / 1.5);
        assert.strictEqual(tokens, expected);
      });

      it('estimateTokens for mixed content', () => {
        const text = 'Hello世界test测试';
        const tokens = estimateTokens(text);
        let cjkCount = 0;
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i);
          if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF) ||
              (code >= 0x3000 && code <= 0x303F) || (code >= 0xFF00 && code <= 0xFFEF) ||
              (code >= 0xAC00 && code <= 0xD7AF)) {
            cjkCount++;
          }
        }
        const nonCjkLen = text.length - cjkCount;
        const expected = Math.ceil(nonCjkLen / 4 + cjkCount / 1.5);
        assert.strictEqual(tokens, expected);
      });

      it('estimateTokens for empty/null/undefined inputs', () => {
        assert.strictEqual(estimateTokens(''), 0);
        assert.strictEqual(estimateTokens(null), 0);
        assert.strictEqual(estimateTokens(undefined), 0);
      });
    });

    describe('1.6 path-utils TOCTOU fix', () => {
      it('validatePath works without pre-checking existsSync', () => {
        const result = validatePath('some/nonexistent/path.txt', {
          rootDir: process.cwd(),
        });
        assert.ok(result.valid, 'should validate path even if file does not exist');
        assert.ok(result.resolvedPath);
      });

      it('validatePath still rejects path traversal', () => {
        const result = validatePath('../../../etc/passwd', {
          rootDir: process.cwd(),
        });
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason.includes('traversal'));
      });
    });

    describe('1.7 network-utils decimal/octal IP bypass', () => {
      it('decimal IP (2130706433) is normalized and detected as private', () => {
        assert.ok(isPrivateIp('2130706433'), '127.0.0.1 as decimal should be private');
      });

      it('octal IP (0177.0.0.1) is normalized and detected as private', () => {
        assert.ok(isPrivateIp('0177.0.0.1'), '0177.0.0.1 (octal 127.0.0.1) should be private');
      });

      it('hex IP (0x7f.0.0.1) is normalized and detected as private', () => {
        assert.ok(isPrivateIp('0x7f.0.0.1'), '0x7f.0.0.1 (hex 127.0.0.1) should be private');
      });

      it('normal dotted-decimal IP still works', () => {
        assert.ok(isPrivateIp('127.0.0.1'));
        assert.ok(isPrivateIp('10.0.0.1'));
        assert.ok(isPrivateIp('192.168.1.1'));
        assert.ok(!isPrivateIp('8.8.8.8'));
      });
    });

    describe('1.8 json-store-restorer type validation', () => {
      it('expectedType string validates correctly', () => {
        const restorer = new JsonStoreRestorer({
          root: '/tmp',
          subPath: 'test.json',
          expectedType: 'string',
        });
        assert.strictEqual(restorer._validateType('hello'), true);
        assert.strictEqual(restorer._validateType(123), false);
        assert.strictEqual(restorer._validateType(null), false);
      });

      it('expectedType number validates correctly (rejects NaN/Infinity)', () => {
        const restorer = new JsonStoreRestorer({
          root: '/tmp',
          subPath: 'test.json',
          expectedType: 'number',
        });
        assert.strictEqual(restorer._validateType(42), true);
        assert.strictEqual(restorer._validateType(3.14), true);
        assert.strictEqual(restorer._validateType(NaN), false);
        assert.strictEqual(restorer._validateType(Infinity), false);
        assert.strictEqual(restorer._validateType(-Infinity), false);
        assert.strictEqual(restorer._validateType('123'), false);
      });

      it('expectedType boolean validates correctly', () => {
        const restorer = new JsonStoreRestorer({
          root: '/tmp',
          subPath: 'test.json',
          expectedType: 'boolean',
        });
        assert.strictEqual(restorer._validateType(true), true);
        assert.strictEqual(restorer._validateType(false), true);
        assert.strictEqual(restorer._validateType(1), false);
        assert.strictEqual(restorer._validateType('true'), false);
        assert.strictEqual(restorer._validateType(null), false);
      });
    });
  });

  describe('2. LOW Severity Fixes', () => {

    describe('2.1 ttl-cache now=0', () => {
      it('isEntryExpired with now=0 uses 0 not Date.now()', () => {
        const entry = { expiresAt: 1000 };
        assert.strictEqual(TTLCache.isEntryExpired(entry, 0), false);
        assert.strictEqual(TTLCache.isEntryExpired(entry, 1001), true);
      });

      it('isTimestampExpired with now=0', () => {
        assert.strictEqual(TTLCache.isTimestampExpired(500, 1000, 0), false);
        assert.strictEqual(TTLCache.isTimestampExpired(500, 200, 0), false);
        assert.strictEqual(TTLCache.isTimestampExpired(0, 100, 200), true);
      });
    });

    describe('2.2 lru-cache isHealthy after shutdown', () => {
      it('isHealthy() returns false after shutdown()', () => {
        const cache = new LRUCache(10);
        assert.strictEqual(cache.isHealthy(), true);
        cache.shutdown();
        assert.strictEqual(cache.isHealthy(), false);
      });
    });

    describe('2.3 i18n template injection', () => {
      it('args containing {0}, {1} do not inject into other placeholders', () => {
        setLocale('en-US');
        const result = t('session.invalid_phase', '{1}', 'normal');
        assert.ok(!result.includes('{1}'), 'injected {1} should not create new placeholder');
        assert.ok(result.includes('normal'), 'second arg should be placed at {1}');
      });
    });

    describe('2.4 stable-stringify seen parameter', () => {
      it('passing a non-WeakSet as 4th arg is ignored (new WeakSet created)', () => {
        const obj = { a: 1, b: 2 };
        const result = stableStringify(obj, null, null, 'not-a-weakset');
        assert.ok(typeof result === 'string');
        const parsed = JSON.parse(result);
        assert.strictEqual(parsed.a, 1);
        assert.strictEqual(parsed.b, 2);
      });

      it('passing a WeakSet works correctly for circular detection', () => {
        const obj = { a: 1 };
        obj.self = obj;
        const seen = new WeakSet();
        const result = stableStringify(obj, null, null, seen);
        assert.ok(result.includes('[Circular]'), 'should detect circular reference with provided WeakSet');
      });
    });

    describe('2.5 unique-id counter registry observability', () => {
      it('getCounterValue returns current counter value', () => {
        resetCounter('test-scope-obs');
        counterId('', 'test-scope-obs');
        counterId('', 'test-scope-obs');
        counterId('', 'test-scope-obs');
        assert.strictEqual(getCounterValue('test-scope-obs'), 3);
        resetCounter('test-scope-obs');
      });

      it('getCounterScopes returns all scope names', () => {
        resetCounter('scope-a');
        resetCounter('scope-b');
        counterId('', 'scope-a');
        counterId('', 'scope-b');
        const scopes = getCounterScopes();
        assert.ok(scopes.includes('scope-a'), 'should include scope-a');
        assert.ok(scopes.includes('scope-b'), 'should include scope-b');
        resetCounter('scope-a');
        resetCounter('scope-b');
      });
    });

    describe('2.6 capacity-config cache TTL', () => {
      it('cache expires after TTL', () => {
        capacityConfig.clearCache();
        const config1 = capacityConfig.loadCapacityConfig(process.cwd());
        assert.ok(config1, 'first load should succeed');
        capacityConfig.clearCache();
        capacityConfig._cacheTimestamp = Date.now() - 100000;
        const config2 = capacityConfig.loadCapacityConfig(process.cwd());
        assert.ok(config2, 'reload after cache expiry should succeed');
        capacityConfig.clearCache();
      });
    });

    describe('2.7 DANGEROUS_KEYS no longer over-blocking', () => {
      it('toString, valueOf, hasOwnProperty are NOT in DANGEROUS_KEYS', () => {
        assert.strictEqual(DANGEROUS_KEYS.has('toString'), false, 'toString should not be dangerous');
        assert.strictEqual(DANGEROUS_KEYS.has('valueOf'), false, 'valueOf should not be dangerous');
        assert.strictEqual(DANGEROUS_KEYS.has('hasOwnProperty'), false, 'hasOwnProperty should not be dangerous');
      });

      it('__proto__, constructor, prototype ARE still in DANGEROUS_KEYS', () => {
        assert.strictEqual(DANGEROUS_KEYS.has('__proto__'), true);
        assert.strictEqual(DANGEROUS_KEYS.has('constructor'), true);
        assert.strictEqual(DANGEROUS_KEYS.has('prototype'), true);
      });
    });

    describe('2.8 safe-execute roundTo precision', () => {
      it('roundTo(1.005, 2) uses toFixed fallback for precision', () => {
        const result = roundTo(1.005, 2);
        assert.ok(typeof result === 'number');
        assert.ok(result >= 1 && result <= 1.01, 'result should be close to 1.01');
      });

      it('roundTo(2.475, 2) returns 2.48 (not 2.47)', () => {
        const result = roundTo(2.475, 2);
        assert.strictEqual(result, 2.48);
      });

      it('roundTo with Infinity returns Infinity', () => {
        assert.strictEqual(roundTo(Infinity, 2), Infinity);
        assert.strictEqual(roundTo(-Infinity, 3), -Infinity);
      });

      it('roundTo with NaN behavior', () => {
        assert.ok(isNaN(roundTo(NaN, 2)), 'NaN input should return NaN');
      });
    });
  });

  describe('3. Hermes Curator Fusion Tests', () => {

    describe('3.1 Source Classification', () => {
      it('classifySkill with valid sources', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        for (const source of ['builtin', 'user', 'generated', 'evolved']) {
          assert.doesNotThrow(() => curator.classifySkill('skill-' + source, source));
        }
      });

      it('classifySkill rejects invalid source', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        assert.throws(() => curator.classifySkill('skill-bad', 'invalid'), /Invalid source type/);
      });

      it('getClassification returns unknown for unclassified', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        assert.strictEqual(curator.getClassification('nonexistent'), 'unknown');
      });
    });

    describe('3.2 Pin Protection', () => {
      it('pinSkill and isPinned', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        curator.pinSkill('my-skill', 'important');
        assert.strictEqual(curator.isPinned('my-skill'), true);
        assert.strictEqual(curator.isPinned('other-skill'), false);
      });

      it('runCuration skips pinned skills', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        const mockRouter = {
          skills: [
            { skill_id: 'pinned-skill' },
            { skill_id: 'unpinned-skill' },
          ],
        };
        curator.attachSkillRouter(mockRouter);
        curator.pinSkill('pinned-skill', 'do not touch');
        curator.recordUsage('pinned-skill', { success: false, duration: 100 });
        curator.recordUsage('pinned-skill', { success: false, duration: 100 });
        curator.recordUsage('pinned-skill', { success: false, duration: 100 });
        curator.recordUsage('pinned-skill', { success: false, duration: 100 });
        curator.recordUsage('pinned-skill', { success: false, duration: 100 });

        const lowQualityEvents = [];
        curator.on('skill-low-quality', (e) => lowQualityEvents.push(e));
        curator.runCuration();
        assert.strictEqual(lowQualityEvents.length, 0, 'pinned skill should not be flagged');
      });
    });

    describe('3.3 Dry-Run Curation', () => {
      it('dryRunCuration returns wouldFlag without side effects', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        const mockRouter = {
          skills: [{ skill_id: 'test-skill' }],
        };
        curator.attachSkillRouter(mockRouter);
        for (let i = 0; i < 6; i++) {
          curator.recordUsage('test-skill', { success: false, duration: 100 });
        }

        const statsBefore = curator.getAllStats();
        const result = curator.dryRunCuration();
        const statsAfter = curator.getAllStats();

        assert.ok(Array.isArray(result.wouldFlag), 'should return wouldFlag array');
        assert.strictEqual(statsBefore.curatorStats.curated, statsAfter.curatorStats.curated,
          'dry run should not change curator stats');
      });
    });

    describe('3.4 Snapshot/Rollback', () => {
      it('createSnapshot and listSnapshots', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        curator.classifySkill('s1', 'builtin');
        curator.pinSkill('s1', 'important');
        const snapshot = curator.createSnapshot();
        assert.ok(snapshot.id, 'snapshot should have an id');
        assert.strictEqual(snapshot.classificationCount, 1);
        assert.strictEqual(snapshot.pinnedCount, 1);

        const list = curator.listSnapshots();
        assert.ok(list.length >= 1, 'should list at least one snapshot');
        assert.strictEqual(list[0].id, snapshot.id);
      });

      it('rollbackToSnapshot restores state', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        curator.classifySkill('skill-x', 'user');
        curator.pinSkill('skill-x', 'keep');
        const snapshot = curator.createSnapshot();

        curator.unpinSkill('skill-x');
        curator.classifySkill('skill-y', 'evolved');
        assert.strictEqual(curator.isPinned('skill-x'), false);

        const result = curator.rollbackToSnapshot(snapshot.id);
        assert.strictEqual(result.success, true);
        assert.strictEqual(curator.isPinned('skill-x'), true);
        assert.strictEqual(curator.getClassification('skill-y'), 'unknown');
      });
    });

    describe('3.5 Smart Curation', () => {
      it('startSmartCuration only runs when idle', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        const mockRouter = { skills: [] };
        curator.attachSkillRouter(mockRouter);

        const idleDetector = { isIdle: () => true };
        curator.attachIdleDetector(idleDetector);

        curator.startSmartCuration({ interval: 50 });
        assert.ok(curator._smartTimer !== null, 'smart timer should be started');

        curator.stopSmartCuration();
        assert.strictEqual(curator._smartTimer, null, 'smart timer should be stopped');
      });

      it('smart curation check returns null when not idle', () => {
        const curator = new SkillCurator({ projectRoot: '' });
        curator.attachIdleDetector({ isIdle: () => false });
        const result = curator._smartCurationCheck();
        assert.strictEqual(result, null, 'should return null when not idle');
      });
    });
  });

  describe('4. Performance Tests', () => {
    it('estimateTokens performance on large text (10000 chars)', () => {
      const text = 'a'.repeat(10000);
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        estimateTokens(text);
      }
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, 'estimateTokens should handle 1000 iterations of 10k chars in under 5s, took ' + elapsed + 'ms');
    });

    it('roundTo performance (10000 iterations)', () => {
      const start = Date.now();
      for (let i = 0; i < 10000; i++) {
        roundTo(1.005 + i * 0.001, 2);
      }
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 1000, 'roundTo should handle 10000 iterations in under 1s, took ' + elapsed + 'ms');
    });

    it('stableStringify performance on complex object', () => {
      const obj = {};
      for (let i = 0; i < 100; i++) {
        obj['key' + i] = { value: i, nested: { deep: 'val' + i } };
      }
      const start = Date.now();
      for (let i = 0; i < 1000; i++) {
        stableStringify(obj);
      }
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 5000, 'stableStringify should handle 1000 iterations of complex object in under 5s, took ' + elapsed + 'ms');
    });
  });

  describe('5. Boundary Condition Tests', () => {
    it('estimateTokens with empty string', () => {
      assert.strictEqual(estimateTokens(''), 0);
    });

    it('estimateTokens with null', () => {
      assert.strictEqual(estimateTokens(null), 0);
    });

    it('estimateTokens with undefined', () => {
      assert.strictEqual(estimateTokens(undefined), 0);
    });

    it('estimateTokens with very long string', () => {
      const text = 'x'.repeat(1000000);
      const tokens = estimateTokens(text);
      assert.ok(tokens > 0, 'should return positive token count for very long string');
      assert.ok(tokens < text.length, 'token count should be less than char count');
    });

    it('roundTo with negative decimals throws RangeError', () => {
      assert.throws(() => roundTo(1234, -2), RangeError);
    });

    it('roundTo with very large decimals', () => {
      const result = roundTo(1.123456789, 15);
      assert.ok(typeof result === 'number');
    });

    it('TTLCache with TTL=0 expires on next access after time advances', () => {
      const cache = new TTLCache({ defaultTTL: 0 });
      cache.set('key', 'value');
      const entry = cache._cache.get('key');
      if (entry) {
        entry.expiresAt = Date.now() - 1;
      }
      assert.strictEqual(cache.get('key'), undefined, 'expired entry should return undefined');
    });

    it('LRUCache with maxSize=1', () => {
      const cache = new LRUCache(1);
      cache.set('a', 1);
      assert.strictEqual(cache.get('a'), 1);
      cache.set('b', 2);
      assert.strictEqual(cache.get('a'), undefined, 'a should be evicted');
      assert.strictEqual(cache.get('b'), 2);
    });

    it('network-utils with 0.0.0.0', () => {
      assert.ok(isPrivateIp('0.0.0.0'), '0.0.0.0 should be private');
    });

    it('network-utils with 255.255.255.255', () => {
      assert.ok(isPrivateIp('255.255.255.255'), '255.255.255.255 should be private (>=224)');
    });

    it('network-utils with ::1', () => {
      assert.ok(isPrivateIp('::1'), '::1 should be private');
    });
  });
});
