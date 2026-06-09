'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PlaybookGenerator } = require('../../../src/runtime/skill/playbook-generator');

describe('PlaybookGenerator', () => {
  it('should generate playbooks from dream notes', () => {
    const mockEngine = {
      getNotesByCategory: (cat) => {
        if (cat === 'best-practice') return [{ id: 'n1', title: 'API Error Handling', content: '1. Check status\n2. Retry on 5xx', confidence: 0.8, frequency: 3, category: 'best-practice' }];
        return [];
      },
    };
    const gen = new PlaybookGenerator({ dreamEngine: mockEngine, minPatternFrequency: 2, minConfidence: 0.6 });
    const playbooks = gen.generateFromDreams();
    assert.ok(playbooks.length > 0);
    assert.equal(playbooks[0].category, 'best_practice');
    assert.ok(playbooks[0].steps.length > 0);
  });

  it('should filter low frequency and confidence notes', () => {
    const mockEngine = {
      getNotesByCategory: (cat) => {
        if (cat === 'workflow-optimization') return [{ id: 'n2', content: 'rare pattern', confidence: 0.3, frequency: 1, category: 'workflow-optimization' }];
        return [];
      },
    };
    const gen = new PlaybookGenerator({ dreamEngine: mockEngine, minPatternFrequency: 2, minConfidence: 0.6 });
    const playbooks = gen.generateFromDreams();
    assert.equal(playbooks.length, 0);
  });

  it('should generate error prevention playbooks', () => {
    const mockEngine = {
      getNotesByCategory: (cat) => {
        if (cat === 'error-avoidance') return [{ id: 'n3', title: 'Avoid Null Ref', content: 'Check before access', confidence: 0.9, frequency: 5, category: 'error-avoidance', solution: 'Add null check' }];
        return [];
      },
    };
    const gen = new PlaybookGenerator({ dreamEngine: mockEngine, minPatternFrequency: 2, minConfidence: 0.6 });
    const playbooks = gen.generateFromDreams();
    assert.ok(playbooks.length > 0);
    assert.equal(playbooks[0].category, 'error_prevention');
    assert.ok(playbooks[0].errorPatterns.length > 0);
  });

  it('should enforce max playbooks limit', () => {
    const mockEngine = {
      getNotesByCategory: () => [
        { id: 'a', content: 'pattern a', confidence: 0.9, frequency: 5, category: 'best-practice' },
        { id: 'b', content: 'pattern b', confidence: 0.9, frequency: 5, category: 'best-practice' },
        { id: 'c', content: 'pattern c', confidence: 0.9, frequency: 5, category: 'best-practice' },
      ],
    };
    const gen = new PlaybookGenerator({ dreamEngine: mockEngine, maxPlaybooks: 2, minPatternFrequency: 2, minConfidence: 0.6 });
    gen.generateFromDreams();
    assert.equal(gen.getPlaybookCount(), 2);
  });

  it('should update and remove playbooks', () => {
    const mockEngine = {
      getNotesByCategory: (cat) => {
        if (cat === 'best-practice') return [{ id: 'n', content: 'test', confidence: 0.9, frequency: 5, category: 'best-practice' }];
        return [];
      },
    };
    const gen = new PlaybookGenerator({ dreamEngine: mockEngine, minPatternFrequency: 2, minConfidence: 0.6 });
    const playbooks = gen.generateFromDreams();
    const id = playbooks[0].id;
    const updated = gen.updatePlaybook(id, { title: 'Updated' });
    assert.equal(updated.title, 'Updated');
    assert.equal(updated.version, 2);
    assert.ok(gen.removePlaybook(id));
    assert.equal(gen.getPlaybookCount(), 0);
  });

  it('should get playbooks by category', () => {
    const mockEngine = {
      getNotesByCategory: (cat) => {
        if (cat === 'error-avoidance') return [{ id: 'n', content: 'err', confidence: 0.9, frequency: 5, category: 'error-avoidance' }];
        return [];
      },
    };
    const gen = new PlaybookGenerator({ dreamEngine: mockEngine, minPatternFrequency: 2, minConfidence: 0.6 });
    gen.generateFromDreams();
    const errorPbs = gen.getPlaybooksByCategory('error_prevention');
    assert.ok(errorPbs.length > 0);
  });

  it('should work without dream engine', () => {
    const gen = new PlaybookGenerator();
    const playbooks = gen.generateFromDreams();
    assert.equal(playbooks.length, 0);
  });

  it('should extract steps from numbered content', () => {
    const mockEngine = {
      getNotesByCategory: () => [{ id: 'n', content: '1. First step\n2. Second step\n3. Third step', confidence: 0.9, frequency: 5, category: 'best-practice' }],
    };
    const gen = new PlaybookGenerator({ dreamEngine: mockEngine, minPatternFrequency: 2, minConfidence: 0.6 });
    const playbooks = gen.generateFromDreams();
    assert.ok(playbooks[0].steps.length >= 2);
  });
});
