/**
 * @module skill-pack-manager
 * @description 技能包管理器 — 融合Claude Code扩展功能的技能包分发机制。
 * 支持技能包的导出、导入、版本管理和跨项目共享，填补Harness框架
 * 在技能分发与复用方面的空白。
 */
'use strict';

const { EventEmitter } = require('events');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeCall } = require('../../utils/safe-execute');
const BoundedMap = require('../../utils/bounded-map');

const PACK_FORMAT_VERSION = '1.0.0';

const PACK_STATUS = {
  DRAFT: 'draft',
  PUBLISHED: 'published',
  DEPRECATED: 'deprecated',
};

const DEFAULT_CONFIG = {
  maxPacks: 50,
  maxPackSize: 100,     // max skills per pack
  maxHistorySize: 200,
  exportDir: '.harness/packs',
};

class SkillPackManager extends EventEmitter {
  constructor(config) {
    super();
    this._config = Object.assign({}, DEFAULT_CONFIG, config);
    this._packs = new BoundedMap(this._config.maxPacks);       // packId -> pack definition
    this._installedPacks = new BoundedMap(this._config.maxPacks); // packId -> installed pack metadata
    this._skillToPack = new BoundedMap(this._config.maxHistorySize); // skillId -> packId mapping
    this._stats = {
      packsCreated: 0,
      packsExported: 0,
      packsImported: 0,
      packsInstalled: 0,
      skillsDistributed: 0,
    };
  }

  // Create a new skill pack definition
  createPack(packId, options) {
    this.guardShutdown();
    if (!packId || typeof packId !== 'string') throw new Error('packId must be a non-empty string');
    if (this._packs.has(packId)) throw new Error('Pack already exists: ' + packId);
    if (this._packs.size >= this._config.maxPacks) throw new Error('Maximum packs reached');

    const pack = {
      id: packId,
      name: options.name || packId,
      description: options.description || '',
      version: options.version || '1.0.0',
      author: options.author || '',
      status: PACK_STATUS.DRAFT,
      skills: [],
      dependencies: options.dependencies ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this._packs.set(packId, pack);
    this._stats.packsCreated++;
    this.emit('pack-created', { packId, pack });
    return pack;
  }

  // Add a skill to a pack
  addSkillToPack(packId, skillId, skillDefinition) {
    this.guardShutdown();
    const pack = this._packs.get(packId);
    if (!pack) throw new Error('Pack not found: ' + packId);
    if (pack.skills.length >= this._config.maxPackSize) throw new Error('Pack skill limit reached');
    if (pack.skills.some(function(s) { return s.skill_id === skillId; })) {
      throw new Error('Skill already in pack: ' + skillId);
    }
    const entry = {
      skill_id: skillId,
      definition: skillDefinition,
      addedAt: new Date().toISOString(),
    };
    pack.skills.push(entry);
    pack.updatedAt = new Date().toISOString();
    this._skillToPack.set(skillId, packId);
    this.emit('skill-added-to-pack', { packId, skillId });
    return entry;
  }

  // Remove a skill from a pack
  removeSkillFromPack(packId, skillId) {
    this.guardShutdown();
    const pack = this._packs.get(packId);
    if (!pack) return false;
    const idx = pack.skills.findIndex(function(s) { return s.skill_id === skillId; });
    if (idx === -1) return false;
    pack.skills.splice(idx, 1);
    pack.updatedAt = new Date().toISOString();
    this._skillToPack.delete(skillId);
    this.emit('skill-removed-from-pack', { packId, skillId });
    return true;
  }

  // Export a pack to a portable format (JSON)
  exportPack(packId) {
    this.guardShutdown();
    const pack = this._packs.get(packId);
    if (!pack) throw new Error('Pack not found: ' + packId);
    const exported = {
      formatVersion: PACK_FORMAT_VERSION,
      pack: {
        id: pack.id,
        name: pack.name,
        description: pack.description,
        version: pack.version,
        author: pack.author,
        skills: pack.skills.map(function(s) {
          return { skill_id: s.skill_id, definition: s.definition };
        }),
        dependencies: pack.dependencies,
        exportedAt: new Date().toISOString(),
      },
    };
    this._stats.packsExported++;
    this.emit('pack-exported', { packId, skillCount: pack.skills.length });
    return exported;
  }

  // Import a pack from portable format
  importPack(exportedData, options) {
    this.guardShutdown();
    if (!exportedData || !exportedData.pack) throw new Error('Invalid pack format');
    if (exportedData.formatVersion !== PACK_FORMAT_VERSION) {
      throw new Error('Unsupported pack format version: ' + exportedData.formatVersion);
    }
    const pack = exportedData.pack;
    const targetId = (options && options.packId) || pack.id;
    if (this._installedPacks.has(targetId) && !(options && options.overwrite)) {
      throw new Error('Pack already installed: ' + targetId);
    }
    const installed = {
      id: targetId,
      sourceName: pack.name,
      sourceVersion: pack.version,
      sourceAuthor: pack.author,
      description: pack.description,
      skills: pack.skills,
      dependencies: pack.dependencies ?? [],
      installedAt: new Date().toISOString(),
    };
    this._installedPacks.set(targetId, installed);
    for (const skill of pack.skills) {
      this._skillToPack.set(skill.skill_id, targetId);
    }
    this._stats.packsImported++;
    this._stats.packsInstalled++;
    this._stats.skillsDistributed += pack.skills.length;
    this.emit('pack-imported', { packId: targetId, skillCount: pack.skills.length });
    return installed;
  }

  // Get a pack definition
  getPack(packId) {
    this.guardShutdown();
    const pack = this._packs.get(packId);
    return pack ? { ...pack, skills: [...pack.skills] } : null;
  }

  // Get an installed pack
  getInstalledPack(packId) {
    this.guardShutdown();
    const pack = this._installedPacks.get(packId);
    return pack ? { ...pack, skills: [...pack.skills] } : null;
  }

  // List all packs
  listPacks() {
    this.guardShutdown();
    const result = [];
    this._packs.forEach(function(pack, id) {
      result.push({ id, name: pack.name, version: pack.version, status: pack.status, skillCount: pack.skills.length });
    });
    return result;
  }

  // List installed packs
  listInstalledPacks() {
    this.guardShutdown();
    const result = [];
    this._installedPacks.forEach(function(pack, id) {
      result.push({ id, name: pack.sourceName, version: pack.sourceVersion, skillCount: pack.skills.length });
    });
    return result;
  }

  // Publish a pack (change status from draft to published)
  publishPack(packId) {
    this.guardShutdown();
    const pack = this._packs.get(packId);
    if (!pack) throw new Error('Pack not found: ' + packId);
    if (pack.skills.length === 0) throw new Error('Cannot publish empty pack');
    pack.status = PACK_STATUS.PUBLISHED;
    pack.updatedAt = new Date().toISOString();
    this.emit('pack-published', { packId });
    return pack;
  }

  // Deprecate a pack
  deprecatePack(packId, reason) {
    this.guardShutdown();
    const pack = this._packs.get(packId);
    if (!pack) throw new Error('Pack not found: ' + packId);
    pack.status = PACK_STATUS.DEPRECATED;
    pack.deprecationReason = reason || '';
    pack.updatedAt = new Date().toISOString();
    this.emit('pack-deprecated', { packId, reason });
    return pack;
  }

  // Uninstall an installed pack
  uninstallPack(packId) {
    this.guardShutdown();
    const pack = this._installedPacks.get(packId);
    if (!pack) return false;
    for (const skill of pack.skills) {
      this._skillToPack.delete(skill.skill_id);
    }
    this._installedPacks.delete(packId);
    this.emit('pack-uninstalled', { packId });
    return true;
  }

  getStats() {
    try { this.guardShutdown(); } catch (_e) {
      return { packsCreated: 0, packsExported: 0, packsImported: 0, packsInstalled: 0, skillsDistributed: 0 };
    }
    return Object.assign({}, this._stats, {
      totalPacks: this._packs.size,
      totalInstalled: this._installedPacks.size,
    });
  }

  _onShutdown() {
    safeCall(() => this._packs.shutdown(), 'SkillPackManager', 'shutdown-packs');
    safeCall(() => this._installedPacks.shutdown(), 'SkillPackManager', 'shutdown-installed');
    safeCall(() => this._skillToPack.shutdown(), 'SkillPackManager', 'shutdown-mapping');
    this.removeAllListeners();
  }
}

withShutdown(SkillPackManager);

module.exports = { SkillPackManager, PACK_FORMAT_VERSION, PACK_STATUS };
