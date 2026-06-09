'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

describe('PersonaManager', () => {
  let PersonaManager;

  beforeEach(() => {
    PersonaManager = require(path.join(ROOT, 'src', 'runtime', 'tui', 'persona-manager'));
  });

  it('should construct with built-in personas', () => {
    const pm = new PersonaManager();
    const stats = pm.getStats();
    assert.ok(stats.totalPersonas >= 14);
    assert.equal(stats.currentPersona, 'default');
    pm.shutdown();
  });

  it('should get persona by id', () => {
    const pm = new PersonaManager();
    const analyst = pm.getPersona('analyst');
    assert.ok(analyst);
    assert.equal(analyst.name, '分析师');
    assert.equal(analyst.builtin, true);
    pm.shutdown();
  });

  it('should return null for non-existent persona', () => {
    const pm = new PersonaManager();
    assert.equal(pm.getPersona('nonexistent'), null);
    pm.shutdown();
  });

  it('should get current persona data', () => {
    const pm = new PersonaManager();
    const data = pm.getCurrentPersonaData();
    assert.ok(data);
    assert.equal(data.name, '默认');
    pm.shutdown();
  });

  it('should set current persona', () => {
    const pm = new PersonaManager();
    const result = pm.setPersona('analyst');
    assert.equal(result, true);
    assert.equal(pm.getCurrentPersona(), 'analyst');
    pm.shutdown();
  });

  it('should fail to set non-existent persona', () => {
    const pm = new PersonaManager();
    const result = pm.setPersona('nonexistent');
    assert.equal(result, false);
    assert.equal(pm.getCurrentPersona(), 'default');
    pm.shutdown();
  });

  it('should add custom persona', () => {
    const pm = new PersonaManager();
    const result = pm.addPersona('custom1', {
      name: '自定义',
      description: '自定义人格',
      prompt: '你是一个自定义助手',
    });
    assert.equal(result, true);
    const persona = pm.getPersona('custom1');
    assert.ok(persona);
    assert.equal(persona.name, '自定义');
    assert.equal(persona.builtin, false);
    pm.shutdown();
  });

  it('should reject invalid persona id', () => {
    const pm = new PersonaManager();
    assert.equal(pm.addPersona('', { name: 'empty' }), false);
    assert.equal(pm.addPersona('a b', { name: 'space' }), false);
    assert.equal(pm.addPersona('x'.repeat(65), { name: 'long' }), false);
    pm.shutdown();
  });

  it('should reject overwriting builtin persona', () => {
    const pm = new PersonaManager();
    const result = pm.addPersona('default', { name: 'override' });
    assert.equal(result, false);
    pm.shutdown();
  });

  it('should remove custom persona', () => {
    const pm = new PersonaManager();
    pm.addPersona('temp', { name: '临时' });
    const result = pm.removePersona('temp');
    assert.equal(result, true);
    assert.equal(pm.getPersona('temp'), null);
    pm.shutdown();
  });

  it('should not remove builtin persona', () => {
    const pm = new PersonaManager();
    const result = pm.removePersona('default');
    assert.equal(result, false);
    pm.shutdown();
  });

  it('should reset to default when removing active persona', () => {
    const pm = new PersonaManager();
    pm.addPersona('temp2', { name: '临时2' });
    pm.setPersona('temp2');
    assert.equal(pm.getCurrentPersona(), 'temp2');
    pm.removePersona('temp2');
    assert.equal(pm.getCurrentPersona(), 'default');
    pm.shutdown();
  });

  it('should list all personas', () => {
    const pm = new PersonaManager();
    const list = pm.listPersonas();
    assert.ok(list.length >= 14);
    const defaultEntry = list.find(p => p.id === 'default');
    assert.ok(defaultEntry);
    assert.equal(defaultEntry.active, true);
    pm.shutdown();
  });

  it('should get persona prompt', () => {
    const pm = new PersonaManager();
    const prompt = pm.getPersonaPrompt('analyst');
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes('分析师'));
    pm.shutdown();
  });

  it('should emit persona-changed event', (t, done) => {
    const pm = new PersonaManager();
    pm.on('persona-changed', (data) => {
      assert.equal(data.previous, 'default');
      assert.equal(data.current, 'worker');
      pm.shutdown();
      done();
    });
    pm.setPersona('worker');
  });

  it('should emit persona-added event', (t, done) => {
    const pm = new PersonaManager();
    pm.on('persona-added', (data) => {
      assert.equal(data.id, 'custom3');
      pm.shutdown();
      done();
    });
    pm.addPersona('custom3', { name: '测试3' });
  });

  it('should emit persona-removed event', (t, done) => {
    const pm = new PersonaManager();
    pm.addPersona('custom4', { name: '测试4' });
    pm.on('persona-removed', (data) => {
      assert.equal(data.id, 'custom4');
      pm.shutdown();
      done();
    });
    pm.removePersona('custom4');
  });

  it('should return correct stats', () => {
    const pm = new PersonaManager();
    pm.addPersona('stat1', { name: '统计1' });
    const stats = pm.getStats();
    assert.ok(stats.builtinCount >= 14);
    assert.equal(stats.customCount, 1);
    assert.equal(stats.currentPersona, 'default');
    pm.shutdown();
  });

  it('should expose BUILTIN_PERSONAS', () => {
    assert.ok(PersonaManager.BUILTIN_PERSONAS);
    assert.ok(PersonaManager.BUILTIN_PERSONAS.default);
    assert.ok(PersonaManager.BUILTIN_PERSONAS.analyst);
  });

  it('should shutdown cleanly', () => {
    const pm = new PersonaManager();
    pm.shutdown();
    assert.equal(pm.getStats().totalPersonas, 0);
  });
});

describe('PersonaManager - edge cases', () => {
  let PersonaManager;

  beforeEach(() => {
    PersonaManager = require(path.join(ROOT, 'src', 'runtime', 'tui', 'persona-manager'));
  });

  it('should reject addPersona when at capacity (MAX_PERSONAS=50)', () => {
    const pm = new PersonaManager();
    const builtinCount = pm.getStats().builtinCount;
    for (let i = 0; i < 50 - builtinCount; i++) {
      const result = pm.addPersona('custom-' + i, { name: 'Custom ' + i });
      assert.equal(result, true, 'should add persona custom-' + i);
    }
    assert.equal(pm.getStats().totalPersonas, 50);
    const overflow = pm.addPersona('overflow', { name: 'Overflow' });
    assert.equal(overflow, false);
    pm.shutdown();
  });

  it('should handle setPersona then removePersona then setPersona again', () => {
    const pm = new PersonaManager();
    pm.addPersona('temp1', { name: '临时1', prompt: 'prompt1' });
    pm.addPersona('temp2', { name: '临时2', prompt: 'prompt2' });
    pm.setPersona('temp1');
    assert.equal(pm.getCurrentPersona(), 'temp1');
    pm.removePersona('temp1');
    assert.equal(pm.getCurrentPersona(), 'default');
    pm.setPersona('temp2');
    assert.equal(pm.getCurrentPersona(), 'temp2');
    const data = pm.getCurrentPersonaData();
    assert.equal(data.name, '临时2');
    pm.shutdown();
  });

  it('should return empty string for getPersonaPrompt of non-existent persona', () => {
    const pm = new PersonaManager();
    const prompt = pm.getPersonaPrompt('nonexistent');
    assert.equal(prompt, '');
    pm.shutdown();
  });

  it('should return empty string for getPersonaPrompt with null id', () => {
    const pm = new PersonaManager();
    const prompt = pm.getPersonaPrompt(null);
    assert.equal(typeof prompt, 'string');
    pm.shutdown();
  });

  it('should return correct getCurrentPersonaData after multiple switches', () => {
    const pm = new PersonaManager();
    pm.setPersona('analyst');
    let data = pm.getCurrentPersonaData();
    assert.equal(data.name, '分析师');
    pm.setPersona('worker');
    data = pm.getCurrentPersonaData();
    assert.equal(data.name, '执行者');
    pm.setPersona('qa');
    data = pm.getCurrentPersonaData();
    assert.equal(data.name, '质量保证');
    pm.setPersona('default');
    data = pm.getCurrentPersonaData();
    assert.equal(data.name, '默认');
    pm.shutdown();
  });

  it('should list personas with correct active state after switch', () => {
    const pm = new PersonaManager();
    pm.setPersona('analyst');
    const list = pm.listPersonas();
    const analystEntry = list.find(p => p.id === 'analyst');
    const defaultEntry = list.find(p => p.id === 'default');
    assert.equal(analystEntry.active, true);
    assert.equal(defaultEntry.active, false);
    pm.shutdown();
  });

  it('should emit persona-changed for each switch in sequence', () => {
    const pm = new PersonaManager();
    const events = [];
    pm.on('persona-changed', (data) => events.push(data));
    pm.setPersona('analyst');
    pm.setPersona('worker');
    pm.setPersona('default');
    assert.equal(events.length, 3);
    assert.equal(events[0].current, 'analyst');
    assert.equal(events[1].current, 'worker');
    assert.equal(events[2].current, 'default');
    pm.shutdown();
  });

  it('should not remove non-existent custom persona', () => {
    const pm = new PersonaManager();
    const result = pm.removePersona('nonexistent');
    assert.equal(result, false);
    pm.shutdown();
  });

  it('should get persona prompt for current persona when no id given', () => {
    const pm = new PersonaManager();
    pm.setPersona('analyst');
    const prompt = pm.getPersonaPrompt();
    assert.ok(prompt.length > 0);
    assert.ok(prompt.includes('分析师'));
    pm.shutdown();
  });
});
