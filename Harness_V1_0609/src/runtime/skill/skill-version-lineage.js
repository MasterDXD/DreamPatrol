'use strict';

const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');
const BoundedArray = require('../../utils/bounded-array');
const { withShutdown } = require('../../utils/shutdown-mixin');

const CHANGE_TYPES = {
  CREATED: 'created',
  EVOLVED: 'evolved',
  IMPROVED: 'improved',
  DISTILLED: 'distilled',
  PROMOTED: 'promoted',
  ROLLED_BACK: 'rolled-back',
  RETIRED: 'retired',
  REACTIVATED: 'reactivated',
  MANUAL_EDIT: 'manual-edit',
};

const DEFAULT_OPTIONS = {
  maxVersionsPerSkill: 50,
  maxLineageEntries: 500,
  maxDiffSize: 10000,
  maxSnapshotSize: 65536,
  trackContentDiffs: true,
  trackSnapshots: true,
};

class SkillVersionLineage {
  constructor(options) {
    this._options = mergeConfig(DEFAULT_OPTIONS, options ?? {});
    this._lineages = new BoundedMap(this._options.maxLineageEntries);
    this._stats = {
      versionsRecorded: 0,
      diffsComputed: 0,
      snapshotsStored: 0,
      rollbacksExecuted: 0,
      byChangeType: {},
    };
  }

  recordVersion(skillId, change) {
    if (!skillId || !change) return null;
    const lineage = this._getOrCreateLineage(skillId);
    const currentVersion = lineage.currentVersion ?? 0;
    const newVersion = currentVersion + 1;
    const entry = {
      version: newVersion,
      changeType: change.changeType ?? CHANGE_TYPES.MANUAL_EDIT,
      parentVersion: currentVersion,
      timestamp: Date.now(),
      reason: change.reason ?? '',
      author: change.author ?? 'system',
      triggerType: change.triggerType ?? null,
      metrics: change.metrics ?? null,
      diff: null,
      snapshot: null,
    };
    if (this._options.trackContentDiffs && change.previousContent != null && change.newContent != null) {
      entry.diff = this._computeDiff(change.previousContent, change.newContent);
      this._stats.diffsComputed++;
    }
    if (this._options.trackSnapshots && change.newContent != null) {
      const snapshot = typeof change.newContent === 'string'
        ? change.newContent
        : JSON.stringify(change.newContent);
      entry.snapshot = snapshot.length > this._options.maxSnapshotSize
        ? snapshot.substring(0, this._options.maxSnapshotSize)
        : snapshot;
      this._stats.snapshotsStored++;
    }
    lineage.versions.push(entry);
    lineage.currentVersion = newVersion;
    lineage.lastModified = Date.now();
    this._stats.versionsRecorded++;
    this._stats.byChangeType[entry.changeType] = (this._stats.byChangeType[entry.changeType] ?? 0) + 1;
    return entry;
  }

  getVersionHistory(skillId) {
    const lineage = this._lineages.get(skillId);
    if (!lineage) return [];
    return lineage.versions.slice();
  }

  getVersion(skillId, version) {
    const lineage = this._lineages.get(skillId);
    if (!lineage) return null;
    return lineage.versions.find(v => v.version === version) ?? null;
  }

  getCurrentVersion(skillId) {
    const lineage = this._lineages.get(skillId);
    if (!lineage) return 0;
    return lineage.currentVersion ?? 0;
  }

  getVersionLineageChain(skillId) {
    const lineage = this._lineages.get(skillId);
    if (!lineage) return [];
    const chain = [];
    let current = lineage.currentVersion;
    const versionMap = new Map();
    lineage.versions.forEach(v => versionMap.set(v.version, v));
    while (current > 0) {
      const entry = versionMap.get(current);
      if (!entry) break;
      chain.push({
        version: entry.version,
        changeType: entry.changeType,
        reason: entry.reason,
        timestamp: entry.timestamp,
        parentVersion: entry.parentVersion,
      });
      current = entry.parentVersion;
    }
    return chain;
  }

  getEvolutionSummary(skillId) {
    const lineage = this._lineages.get(skillId);
    if (!lineage) return null;
    const byType = {};
    lineage.versions.forEach(v => {
      byType[v.changeType] = (byType[v.changeType] ?? 0) + 1;
    });
    return {
      skillId,
      currentVersion: lineage.currentVersion,
      totalVersions: lineage.versions.length,
      createdAt: lineage.createdAt,
      lastModified: lineage.lastModified,
      byChangeType: byType,
    };
  }

  exportMermaidGraph(skillId) {
    const lineage = this._lineages.get(skillId);
    if (!lineage || lineage.versions.length === 0) return '';
    const lines = ['graph TD'];
    lineage.versions.forEach(v => {
      const label = 'v' + v.version + '(' + v.changeType + ')';
      lines.push('  V' + v.version + '[' + label + ']');
      if (v.parentVersion > 0) {
        lines.push('  V' + v.parentVersion + ' --> V' + v.version);
      }
    });
    return lines.join('\n');
  }

  _getOrCreateLineage(skillId) {
    let lineage = this._lineages.get(skillId);
    if (!lineage) {
      lineage = {
        skillId,
        currentVersion: 0,
        versions: new BoundedArray(this._options.maxVersionsPerSkill),
        createdAt: Date.now(),
        lastModified: Date.now(),
      };
      this._lineages.set(skillId, lineage);
    }
    return lineage;
  }

  _computeDiff(previous, current) {
    const prevLines = (typeof previous === 'string' ? previous : JSON.stringify(previous)).split('\n');
    const currLines = (typeof current === 'string' ? current : JSON.stringify(current)).split('\n');
    const additions = [];
    const deletions = [];
    const prevSet = new Set(prevLines);
    const currSet = new Set(currLines);
    currLines.forEach(line => {
      if (!prevSet.has(line)) additions.push(line);
    });
    prevLines.forEach(line => {
      if (!currSet.has(line)) deletions.push(line);
    });
    const result = {
      additions: additions.length,
      deletions: deletions.length,
      unchanged: prevLines.length - deletions.length,
    };
    let jsonResult;
    try {
      jsonResult = JSON.stringify(result);
    } catch (_e) {
      jsonResult = '{}';
    }
    if (jsonResult.length > this._options.maxDiffSize) {
      return { additions: additions.length, deletions: deletions.length, truncated: true };
    }
    result.addedLines = additions.slice(0, 20);
    result.deletedLines = deletions.slice(0, 20);
    return result;
  }

  getStats() {
    return {
      versionsRecorded: this._stats.versionsRecorded,
      diffsComputed: this._stats.diffsComputed,
      snapshotsStored: this._stats.snapshotsStored,
      rollbacksExecuted: this._stats.rollbacksExecuted,
      byChangeType: Object.assign({}, this._stats.byChangeType),
      trackedSkills: this._lineages.size,
    };
  }

  _onShutdown() {
    this._lineages.shutdown();
  }
}

module.exports = withShutdown(SkillVersionLineage);
module.exports.CHANGE_TYPES = CHANGE_TYPES;
