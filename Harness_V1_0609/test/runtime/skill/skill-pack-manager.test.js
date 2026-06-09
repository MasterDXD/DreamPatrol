'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const { SkillPackManager, PACK_FORMAT_VERSION, PACK_STATUS } = require(
  path.join(ROOT, 'src', 'runtime', 'skill', 'skill-pack-manager'),
);

let manager;

beforeEach(() => {
  manager = new SkillPackManager();
});

afterEach(() => {
  if (manager && typeof manager.shutdown === 'function') {
    try { manager.shutdown(); } catch (_e) { /* ignore */ }
  }
  manager = null;
});

describe('SkillPackManager - Exported constants', () => {
  it('should export PACK_FORMAT_VERSION as a string', () => {
    assert.strictEqual(typeof PACK_FORMAT_VERSION, 'string');
    assert.strictEqual(PACK_FORMAT_VERSION, '1.0.0');
  });

  it('should export PACK_STATUS with draft, published, deprecated', () => {
    assert.strictEqual(PACK_STATUS.DRAFT, 'draft');
    assert.strictEqual(PACK_STATUS.PUBLISHED, 'published');
    assert.strictEqual(PACK_STATUS.DEPRECATED, 'deprecated');
  });
});

describe('SkillPackManager - Constructor', () => {
  it('should create instance with default config', () => {
    const mgr = new SkillPackManager();
    assert.ok(mgr);
    assert.strictEqual(mgr._config.maxPacks, 50);
    assert.strictEqual(mgr._config.maxPackSize, 100);
    assert.strictEqual(mgr._config.maxHistorySize, 200);
    assert.strictEqual(mgr._config.exportDir, '.harness/packs');
    assert.strictEqual(mgr._packs.size, 0);
    assert.strictEqual(mgr._installedPacks.size, 0);
    assert.strictEqual(mgr._skillToPack.size, 0);
  });

  it('should merge custom config', () => {
    const mgr = new SkillPackManager({
      maxPacks: 10,
      maxPackSize: 20,
      exportDir: '/tmp/packs',
    });
    assert.strictEqual(mgr._config.maxPacks, 10);
    assert.strictEqual(mgr._config.maxPackSize, 20);
    assert.strictEqual(mgr._config.exportDir, '/tmp/packs');
    assert.strictEqual(mgr._config.maxHistorySize, 200);
  });

  it('should initialize stats to zero', () => {
    const stats = manager.getStats();
    assert.strictEqual(stats.packsCreated, 0);
    assert.strictEqual(stats.packsExported, 0);
    assert.strictEqual(stats.packsImported, 0);
    assert.strictEqual(stats.packsInstalled, 0);
    assert.strictEqual(stats.skillsDistributed, 0);
  });
});

describe('SkillPackManager - createPack', () => {
  it('should create a pack with defaults', () => {
    const pack = manager.createPack('pack-1', {});
    assert.strictEqual(pack.id, 'pack-1');
    assert.strictEqual(pack.name, 'pack-1');
    assert.strictEqual(pack.description, '');
    assert.strictEqual(pack.version, '1.0.0');
    assert.strictEqual(pack.author, '');
    assert.strictEqual(pack.status, PACK_STATUS.DRAFT);
    assert.deepStrictEqual(pack.skills, []);
    assert.deepStrictEqual(pack.dependencies, []);
    assert.ok(pack.createdAt);
    assert.ok(pack.updatedAt);
  });

  it('should create a pack with custom options', () => {
    const pack = manager.createPack('pack-1', {
      name: 'My Pack',
      description: 'A test pack',
      version: '2.0.0',
      author: 'tester',
      dependencies: ['dep-a'],
    });
    assert.strictEqual(pack.name, 'My Pack');
    assert.strictEqual(pack.description, 'A test pack');
    assert.strictEqual(pack.version, '2.0.0');
    assert.strictEqual(pack.author, 'tester');
    assert.deepStrictEqual(pack.dependencies, ['dep-a']);
  });

  it('should emit pack-created event', () => {
    let eventData = null;
    manager.on('pack-created', (data) => { eventData = data; });
    const pack = manager.createPack('pack-1', { name: 'Test' });
    assert.ok(eventData);
    assert.strictEqual(eventData.packId, 'pack-1');
    assert.strictEqual(eventData.pack, pack);
  });

  it('should increment packsCreated stat', () => {
    manager.createPack('pack-1', {});
    manager.createPack('pack-2', {});
    const stats = manager.getStats();
    assert.strictEqual(stats.packsCreated, 2);
  });

  it('should throw for empty packId', () => {
    assert.throws(() => manager.createPack('', {}), /packId must be a non-empty string/);
  });

  it('should throw for non-string packId', () => {
    assert.throws(() => manager.createPack(123, {}), /packId must be a non-empty string/);
    assert.throws(() => manager.createPack(null, {}), /packId must be a non-empty string/);
  });

  it('should throw for duplicate pack name', () => {
    manager.createPack('pack-1', {});
    assert.throws(() => manager.createPack('pack-1', {}), /Pack already exists: pack-1/);
  });

  it('should throw when max packs reached', () => {
    const mgr = new SkillPackManager({ maxPacks: 2 });
    mgr.createPack('p1', {});
    mgr.createPack('p2', {});
    assert.throws(() => mgr.createPack('p3', {}), /Maximum packs reached/);
    mgr.shutdown();
  });
});

describe('SkillPackManager - addSkillToPack', () => {
  it('should add a skill to a pack', () => {
    manager.createPack('pack-1', {});
    const entry = manager.addSkillToPack('pack-1', 'skill-a', { name: 'Skill A' });
    assert.strictEqual(entry.skill_id, 'skill-a');
    assert.deepStrictEqual(entry.definition, { name: 'Skill A' });
    assert.ok(entry.addedAt);
    const pack = manager.getPack('pack-1');
    assert.strictEqual(pack.skills.length, 1);
  });

  it('should emit skill-added-to-pack event', () => {
    manager.createPack('pack-1', {});
    let eventData = null;
    manager.on('skill-added-to-pack', (data) => { eventData = data; });
    manager.addSkillToPack('pack-1', 'skill-a', {});
    assert.ok(eventData);
    assert.strictEqual(eventData.packId, 'pack-1');
    assert.strictEqual(eventData.skillId, 'skill-a');
  });

  it('should update pack updatedAt', () => {
    manager.createPack('pack-1', {});
    const before = manager.getPack('pack-1').updatedAt;
    manager.addSkillToPack('pack-1', 'skill-a', {});
    const after = manager.getPack('pack-1').updatedAt;
    assert.ok(after >= before);
  });

  it('should map skillId to packId', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    assert.strictEqual(manager._skillToPack.get('skill-a'), 'pack-1');
  });

  it('should throw for non-existent pack', () => {
    assert.throws(() => manager.addSkillToPack('no-pack', 'skill-a', {}), /Pack not found: no-pack/);
  });

  it('should throw for duplicate skill in pack', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    assert.throws(
      () => manager.addSkillToPack('pack-1', 'skill-a', {}),
      /Skill already in pack: skill-a/,
    );
  });

  it('should throw when pack skill limit reached', () => {
    const mgr = new SkillPackManager({ maxPackSize: 2 });
    mgr.createPack('pack-1', {});
    mgr.addSkillToPack('pack-1', 's1', {});
    mgr.addSkillToPack('pack-1', 's2', {});
    assert.throws(() => mgr.addSkillToPack('pack-1', 's3', {}), /Pack skill limit reached/);
    mgr.shutdown();
  });
});

describe('SkillPackManager - removeSkillFromPack', () => {
  it('should remove a skill from a pack', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    const result = manager.removeSkillFromPack('pack-1', 'skill-a');
    assert.strictEqual(result, true);
    assert.strictEqual(manager.getPack('pack-1').skills.length, 0);
  });

  it('should emit skill-removed-from-pack event', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    let eventData = null;
    manager.on('skill-removed-from-pack', (data) => { eventData = data; });
    manager.removeSkillFromPack('pack-1', 'skill-a');
    assert.ok(eventData);
    assert.strictEqual(eventData.packId, 'pack-1');
    assert.strictEqual(eventData.skillId, 'skill-a');
  });

  it('should delete skillToPack mapping', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    manager.removeSkillFromPack('pack-1', 'skill-a');
    assert.strictEqual(manager._skillToPack.has('skill-a'), false);
  });

  it('should return false for non-existent pack', () => {
    const result = manager.removeSkillFromPack('no-pack', 'skill-a');
    assert.strictEqual(result, false);
  });

  it('should return false for missing skill in pack', () => {
    manager.createPack('pack-1', {});
    const result = manager.removeSkillFromPack('pack-1', 'skill-x');
    assert.strictEqual(result, false);
  });

  it('should update pack updatedAt on removal', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    const before = manager.getPack('pack-1').updatedAt;
    manager.removeSkillFromPack('pack-1', 'skill-a');
    const after = manager.getPack('pack-1').updatedAt;
    assert.ok(after >= before);
  });
});

describe('SkillPackManager - exportPack', () => {
  it('should export a pack to portable format', () => {
    manager.createPack('pack-1', {
      name: 'My Pack',
      description: 'desc',
      version: '1.2.0',
      author: 'me',
      dependencies: ['dep-x'],
    });
    manager.addSkillToPack('pack-1', 'skill-a', { name: 'A' });
    const exported = manager.exportPack('pack-1');
    assert.strictEqual(exported.formatVersion, PACK_FORMAT_VERSION);
    assert.strictEqual(exported.pack.id, 'pack-1');
    assert.strictEqual(exported.pack.name, 'My Pack');
    assert.strictEqual(exported.pack.description, 'desc');
    assert.strictEqual(exported.pack.version, '1.2.0');
    assert.strictEqual(exported.pack.author, 'me');
    assert.strictEqual(exported.pack.skills.length, 1);
    assert.strictEqual(exported.pack.skills[0].skill_id, 'skill-a');
    assert.deepStrictEqual(exported.pack.skills[0].definition, { name: 'A' });
    assert.deepStrictEqual(exported.pack.dependencies, ['dep-x']);
    assert.ok(exported.pack.exportedAt);
  });

  it('should emit pack-exported event', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    let eventData = null;
    manager.on('pack-exported', (data) => { eventData = data; });
    manager.exportPack('pack-1');
    assert.ok(eventData);
    assert.strictEqual(eventData.packId, 'pack-1');
    assert.strictEqual(eventData.skillCount, 1);
  });

  it('should increment packsExported stat', () => {
    manager.createPack('pack-1', {});
    manager.exportPack('pack-1');
    assert.strictEqual(manager.getStats().packsExported, 1);
  });

  it('should throw for non-existent pack', () => {
    assert.throws(() => manager.exportPack('no-pack'), /Pack not found: no-pack/);
  });
});

describe('SkillPackManager - importPack', () => {
  function makeExportData(overrides) {
    return Object.assign({
      formatVersion: PACK_FORMAT_VERSION,
      pack: {
        id: 'imported-pack',
        name: 'Imported',
        description: 'desc',
        version: '1.0.0',
        author: 'author',
        skills: [{ skill_id: 's1', definition: { name: 'S1' } }],
        dependencies: [],
      },
    }, overrides);
  }

  it('should import a pack from portable format', () => {
    const data = makeExportData();
    const installed = manager.importPack(data);
    assert.strictEqual(installed.id, 'imported-pack');
    assert.strictEqual(installed.sourceName, 'Imported');
    assert.strictEqual(installed.sourceVersion, '1.0.0');
    assert.strictEqual(installed.sourceAuthor, 'author');
    assert.strictEqual(installed.description, 'desc');
    assert.strictEqual(installed.skills.length, 1);
    assert.deepStrictEqual(installed.dependencies, []);
    assert.ok(installed.installedAt);
  });

  it('should emit pack-imported event', () => {
    const data = makeExportData();
    let eventData = null;
    manager.on('pack-imported', (d) => { eventData = d; });
    manager.importPack(data);
    assert.ok(eventData);
    assert.strictEqual(eventData.packId, 'imported-pack');
    assert.strictEqual(eventData.skillCount, 1);
  });

  it('should increment packsImported, packsInstalled, skillsDistributed stats', () => {
    const data = makeExportData();
    manager.importPack(data);
    const stats = manager.getStats();
    assert.strictEqual(stats.packsImported, 1);
    assert.strictEqual(stats.packsInstalled, 1);
    assert.strictEqual(stats.skillsDistributed, 1);
  });

  it('should map imported skills to packId', () => {
    const data = makeExportData();
    manager.importPack(data);
    assert.strictEqual(manager._skillToPack.get('s1'), 'imported-pack');
  });

  it('should import with custom packId via options', () => {
    const data = makeExportData();
    const installed = manager.importPack(data, { packId: 'custom-id' });
    assert.strictEqual(installed.id, 'custom-id');
  });

  it('should throw for invalid pack format', () => {
    assert.throws(() => manager.importPack(null), /Invalid pack format/);
    assert.throws(() => manager.importPack({}), /Invalid pack format/);
    assert.throws(
      () => manager.importPack({ pack: {} }),
      /Unsupported pack format version/,
    );
  });

  it('should throw for unsupported format version', () => {
    const data = makeExportData({ formatVersion: '99.0.0' });
    assert.throws(() => manager.importPack(data), /Unsupported pack format version: 99.0.0/);
  });

  it('should throw for already installed pack without overwrite', () => {
    const data = makeExportData();
    manager.importPack(data);
    assert.throws(() => manager.importPack(data), /Pack already installed: imported-pack/);
  });

  it('should overwrite installed pack with overwrite option', () => {
    const data = makeExportData();
    manager.importPack(data);
    const result = manager.importPack(data, { overwrite: true });
    assert.ok(result);
    assert.strictEqual(manager.getStats().packsInstalled, 2);
  });
});

describe('SkillPackManager - publishPack', () => {
  it('should publish a draft pack', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    const pack = manager.publishPack('pack-1');
    assert.strictEqual(pack.status, PACK_STATUS.PUBLISHED);
  });

  it('should emit pack-published event', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    let eventData = null;
    manager.on('pack-published', (d) => { eventData = d; });
    manager.publishPack('pack-1');
    assert.ok(eventData);
    assert.strictEqual(eventData.packId, 'pack-1');
  });

  it('should update pack updatedAt', () => {
    manager.createPack('pack-1', {});
    manager.addSkillToPack('pack-1', 'skill-a', {});
    const before = manager.getPack('pack-1').updatedAt;
    manager.publishPack('pack-1');
    const after = manager.getPack('pack-1').updatedAt;
    assert.ok(after >= before);
  });

  it('should throw for non-existent pack', () => {
    assert.throws(() => manager.publishPack('no-pack'), /Pack not found: no-pack/);
  });

  it('should throw for empty pack', () => {
    manager.createPack('pack-1', {});
    assert.throws(() => manager.publishPack('pack-1'), /Cannot publish empty pack/);
  });
});

describe('SkillPackManager - deprecatePack', () => {
  it('should deprecate a pack', () => {
    manager.createPack('pack-1', {});
    const pack = manager.deprecatePack('pack-1');
    assert.strictEqual(pack.status, PACK_STATUS.DEPRECATED);
    assert.strictEqual(pack.deprecationReason, '');
  });

  it('should deprecate with a reason', () => {
    manager.createPack('pack-1', {});
    const pack = manager.deprecatePack('pack-1', 'obsolete');
    assert.strictEqual(pack.deprecationReason, 'obsolete');
  });

  it('should emit pack-deprecated event', () => {
    manager.createPack('pack-1', {});
    let eventData = null;
    manager.on('pack-deprecated', (d) => { eventData = d; });
    manager.deprecatePack('pack-1', 'old');
    assert.ok(eventData);
    assert.strictEqual(eventData.packId, 'pack-1');
    assert.strictEqual(eventData.reason, 'old');
  });

  it('should throw for non-existent pack', () => {
    assert.throws(() => manager.deprecatePack('no-pack'), /Pack not found: no-pack/);
  });
});

describe('SkillPackManager - uninstallPack', () => {
  function installPack() {
    const data = {
      formatVersion: PACK_FORMAT_VERSION,
      pack: {
        id: 'inst-pack',
        name: 'Installed',
        description: '',
        version: '1.0.0',
        author: '',
        skills: [
          { skill_id: 's1', definition: {} },
          { skill_id: 's2', definition: {} },
        ],
        dependencies: [],
      },
    };
    return manager.importPack(data);
  }

  it('should uninstall an installed pack', () => {
    installPack();
    const result = manager.uninstallPack('inst-pack');
    assert.strictEqual(result, true);
    assert.strictEqual(manager.getInstalledPack('inst-pack'), null);
  });

  it('should emit pack-uninstalled event', () => {
    installPack();
    let eventData = null;
    manager.on('pack-uninstalled', (d) => { eventData = d; });
    manager.uninstallPack('inst-pack');
    assert.ok(eventData);
    assert.strictEqual(eventData.packId, 'inst-pack');
  });

  it('should remove skillToPack mappings for all skills', () => {
    installPack();
    assert.strictEqual(manager._skillToPack.get('s1'), 'inst-pack');
    assert.strictEqual(manager._skillToPack.get('s2'), 'inst-pack');
    manager.uninstallPack('inst-pack');
    assert.strictEqual(manager._skillToPack.has('s1'), false);
    assert.strictEqual(manager._skillToPack.has('s2'), false);
  });

  it('should return false for non-existent pack', () => {
    const result = manager.uninstallPack('no-pack');
    assert.strictEqual(result, false);
  });
});

describe('SkillPackManager - getStats', () => {
  it('should return stats with totalPacks and totalInstalled', () => {
    manager.createPack('pack-1', {});
    const data = {
      formatVersion: PACK_FORMAT_VERSION,
      pack: {
        id: 'inst-pack',
        name: 'Installed',
        description: '',
        version: '1.0.0',
        author: '',
        skills: [{ skill_id: 's1', definition: {} }],
        dependencies: [],
      },
    };
    manager.importPack(data);
    const stats = manager.getStats();
    assert.strictEqual(stats.totalPacks, 1);
    assert.strictEqual(stats.totalInstalled, 1);
    assert.strictEqual(stats.packsCreated, 1);
    assert.strictEqual(stats.packsImported, 1);
    assert.strictEqual(stats.packsInstalled, 1);
    assert.strictEqual(stats.skillsDistributed, 1);
  });

  it('should return zeroed stats after shutdown', () => {
    manager.createPack('pack-1', {});
    manager.shutdown();
    const stats = manager.getStats();
    assert.strictEqual(stats.packsCreated, 0);
    assert.strictEqual(stats.packsExported, 0);
    assert.strictEqual(stats.packsImported, 0);
    assert.strictEqual(stats.packsInstalled, 0);
    assert.strictEqual(stats.skillsDistributed, 0);
  });
});

describe('SkillPackManager - listPacks / listInstalledPacks', () => {
  it('should list all packs', () => {
    manager.createPack('pack-1', { name: 'P1' });
    manager.createPack('pack-2', { name: 'P2' });
    const list = manager.listPacks();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].id, 'pack-1');
    assert.strictEqual(list[0].name, 'P1');
    assert.strictEqual(list[0].status, PACK_STATUS.DRAFT);
    assert.strictEqual(list[0].skillCount, 0);
  });

  it('should list installed packs', () => {
    const data = {
      formatVersion: PACK_FORMAT_VERSION,
      pack: {
        id: 'inst-pack',
        name: 'Installed',
        description: '',
        version: '2.0.0',
        author: '',
        skills: [{ skill_id: 's1', definition: {} }],
        dependencies: [],
      },
    };
    manager.importPack(data);
    const list = manager.listInstalledPacks();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].id, 'inst-pack');
    assert.strictEqual(list[0].name, 'Installed');
    assert.strictEqual(list[0].version, '2.0.0');
    assert.strictEqual(list[0].skillCount, 1);
  });
});

describe('SkillPackManager - getPack / getInstalledPack', () => {
  it('should return pack by id', () => {
    manager.createPack('pack-1', { name: 'P1' });
    const pack = manager.getPack('pack-1');
    assert.ok(pack);
    assert.strictEqual(pack.id, 'pack-1');
  });

  it('should return null for unknown pack id', () => {
    assert.strictEqual(manager.getPack('no-pack'), null);
  });

  it('should return installed pack by id', () => {
    const data = {
      formatVersion: PACK_FORMAT_VERSION,
      pack: {
        id: 'inst-pack',
        name: 'Installed',
        description: '',
        version: '1.0.0',
        author: '',
        skills: [],
        dependencies: [],
      },
    };
    manager.importPack(data);
    const installed = manager.getInstalledPack('inst-pack');
    assert.ok(installed);
    assert.strictEqual(installed.id, 'inst-pack');
  });

  it('should return null for unknown installed pack id', () => {
    assert.strictEqual(manager.getInstalledPack('no-pack'), null);
  });
});

describe('SkillPackManager - shutdown state', () => {
  it('should throw on createPack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.createPack('pack-1', {}), /shut down/i);
  });

  it('should throw on addSkillToPack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.addSkillToPack('pack-1', 's1', {}), /shut down/i);
  });

  it('should throw on removeSkillFromPack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.removeSkillFromPack('pack-1', 's1'), /shut down/i);
  });

  it('should throw on exportPack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.exportPack('pack-1'), /shut down/i);
  });

  it('should throw on importPack after shutdown', () => {
    manager.shutdown();
    assert.throws(
      () => manager.importPack({ formatVersion: PACK_FORMAT_VERSION, pack: {} }),
      /shut down/i,
    );
  });

  it('should throw on publishPack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.publishPack('pack-1'), /shut down/i);
  });

  it('should throw on deprecatePack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.deprecatePack('pack-1'), /shut down/i);
  });

  it('should throw on uninstallPack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.uninstallPack('pack-1'), /shut down/i);
  });

  it('should throw on getPack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.getPack('pack-1'), /shut down/i);
  });

  it('should throw on getInstalledPack after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.getInstalledPack('pack-1'), /shut down/i);
  });

  it('should throw on listPacks after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.listPacks(), /shut down/i);
  });

  it('should throw on listInstalledPacks after shutdown', () => {
    manager.shutdown();
    assert.throws(() => manager.listInstalledPacks(), /shut down/i);
  });

  it('should clear internal maps on shutdown', () => {
    manager.createPack('pack-1', {});
    manager.shutdown();
    assert.strictEqual(manager._packs.size, 0);
    assert.strictEqual(manager._installedPacks.size, 0);
    assert.strictEqual(manager._skillToPack.size, 0);
  });

  it('should remove all listeners on shutdown', () => {
    manager.on('test', () => {});
    manager.shutdown();
    assert.strictEqual(manager.listenerCount('test'), 0);
  });

  it('should be idempotent', () => {
    manager.shutdown();
    manager.shutdown();
  });
});

describe('SkillPackManager - isHealthy', () => {
  it('should return true when healthy', () => {
    assert.strictEqual(manager.isHealthy(), true);
  });

  it('should return false after shutdown', () => {
    manager.shutdown();
    assert.strictEqual(manager.isHealthy(), false);
  });
});

describe('SkillPackManager - full lifecycle', () => {
  it('should support create → add skills → publish → export → import → uninstall', () => {
    manager.createPack('lifecycle-pack', {
      name: 'Lifecycle',
      description: 'Full lifecycle test',
      version: '1.0.0',
      author: 'tester',
    });
    manager.addSkillToPack('lifecycle-pack', 'skill-1', { name: 'S1' });
    manager.addSkillToPack('lifecycle-pack', 'skill-2', { name: 'S2' });
    const published = manager.publishPack('lifecycle-pack');
    assert.strictEqual(published.status, PACK_STATUS.PUBLISHED);

    const exported = manager.exportPack('lifecycle-pack');
    assert.strictEqual(exported.pack.skills.length, 2);

    const imported = manager.importPack(exported, { packId: 'lifecycle-copy' });
    assert.strictEqual(imported.id, 'lifecycle-copy');
    assert.strictEqual(imported.skills.length, 2);

    const uninstalled = manager.uninstallPack('lifecycle-copy');
    assert.strictEqual(uninstalled, true);
    assert.strictEqual(manager.getInstalledPack('lifecycle-copy'), null);
  });
});
