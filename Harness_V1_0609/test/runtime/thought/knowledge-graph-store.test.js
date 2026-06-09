'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const KGModule = require(path.join(ROOT, 'src', 'runtime', 'thought', 'knowledge-graph-store'));
const KnowledgeGraphStore = KGModule.KnowledgeGraphStore || KGModule;

describe('KnowledgeGraphStore - 构造函数', () => {
  it('默认配置创建实例', () => {
    const kg = new KnowledgeGraphStore();
    assert.ok(kg);
    assert.strictEqual(kg._config.maxEntities, 5000);
    assert.strictEqual(kg._config.maxRelations, 10000);
    assert.strictEqual(kg._config.maxQueryDepth, 5);
    assert.strictEqual(kg._config.enableAutoIndex, true);
    assert.strictEqual(kg._config.persistToDisk, false);
  });

  it('自定义选项与默认配置合并', () => {
    const kg = new KnowledgeGraphStore({ maxEntities: 100, maxQueryDepth: 3 });
    assert.strictEqual(kg._config.maxEntities, 100);
    assert.strictEqual(kg._config.maxQueryDepth, 3);
    assert.strictEqual(kg._config.maxRelations, 10000);
  });

  it('暴露静态常量 RELATION_TYPES 和 DEFAULT_CONFIG', () => {
    assert.ok(KGModule.RELATION_TYPES);
    assert.strictEqual(KGModule.RELATION_TYPES.IS_A, 'is_a');
    assert.strictEqual(KGModule.RELATION_TYPES.PART_OF, 'part_of');
    assert.strictEqual(KGModule.RELATION_TYPES.DEPENDS_ON, 'depends_on');
    assert.strictEqual(KGModule.RELATION_TYPES.PRODUCES, 'produces');
    assert.strictEqual(KGModule.RELATION_TYPES.USES, 'uses');
    assert.strictEqual(KGModule.RELATION_TYPES.RELATES_TO, 'relates_to');
    assert.strictEqual(KGModule.RELATION_TYPES.CONTRADICTS, 'contradicts');
    assert.strictEqual(KGModule.RELATION_TYPES.SUPPORTS, 'supports');

    assert.ok(KGModule.DEFAULT_CONFIG);
    assert.strictEqual(KGModule.DEFAULT_CONFIG.maxEntities, 5000);
    assert.strictEqual(KGModule.DEFAULT_CONFIG.maxRelations, 10000);
  });
});

describe('KnowledgeGraphStore - attach方法', () => {
  it('attachMemoryStore 注入有效存储', () => {
    const kg = new KnowledgeGraphStore();
    const store = { storeExperience() {} };
    const result = kg.attachMemoryStore(store);
    assert.strictEqual(result, kg);
    assert.strictEqual(kg._attached.memoryStore, true);
    assert.strictEqual(kg._ms, store);
    kg.shutdown();
  });

  it('attachMemoryStore 无效存储抛出TypeError', () => {
    const kg = new KnowledgeGraphStore();
    assert.throws(() => kg.attachMemoryStore(null), TypeError);
    assert.throws(() => kg.attachMemoryStore({}), TypeError);
    assert.throws(() => kg.attachMemoryStore({ foo: 'bar' }), TypeError);
    kg.shutdown();
  });

  it('attachEmbeddingService 注入有效服务', () => {
    const kg = new KnowledgeGraphStore();
    const service = { embed() {} };
    const result = kg.attachEmbeddingService(service);
    assert.strictEqual(result, kg);
    assert.strictEqual(kg._attached.embeddingService, true);
    assert.strictEqual(kg._es, service);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - addEntity', () => {
  it('添加默认类型实体', () => {
    const kg = new KnowledgeGraphStore();
    const entity = kg.addEntity('Node.js');
    assert.ok(entity);
    assert.ok(entity.id.startsWith('ent-'));
    assert.strictEqual(entity.name, 'Node.js');
    assert.strictEqual(entity.type, 'concept');
    assert.deepStrictEqual(entity.attributes, {});
    assert.ok(entity.createdAt > 0);
    kg.shutdown();
  });

  it('添加自定义类型和属性的实体', () => {
    const kg = new KnowledgeGraphStore();
    const entity = kg.addEntity('Express', 'framework', { version: '4.18' });
    assert.strictEqual(entity.name, 'Express');
    assert.strictEqual(entity.type, 'framework');
    assert.strictEqual(entity.attributes.version, '4.18');
    kg.shutdown();
  });

  it('添加实体触发 entity-added 事件', () => {
    const kg = new KnowledgeGraphStore();
    let eventData = null;
    kg.on('entity-added', (data) => { eventData = data; });
    const entity = kg.addEntity('Koa');
    assert.ok(eventData);
    assert.strictEqual(eventData.entityId, entity.id);
    assert.strictEqual(eventData.name, 'Koa');
    assert.strictEqual(eventData.type, 'concept');
    kg.shutdown();
  });

  it('通过ID获取实体', () => {
    const kg = new KnowledgeGraphStore();
    const entity = kg.addEntity('Fastify');
    const found = kg.getEntity(entity.id);
    assert.strictEqual(found.id, entity.id);
    assert.strictEqual(found.name, 'Fastify');
    assert.strictEqual(kg.getEntity('nonexistent'), null);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - findEntities', () => {
  it('findEntitiesByName 部分匹配（不区分大小写）', () => {
    const kg = new KnowledgeGraphStore();
    kg.addEntity('Node.js');
    kg.addEntity('Node.js LTS');
    kg.addEntity('Deno');
    const results = kg.findEntitiesByName('node');
    assert.strictEqual(results.length, 2);
    kg.shutdown();
  });

  it('findEntitiesByType 按类型查找', () => {
    const kg = new KnowledgeGraphStore();
    kg.addEntity('Express', 'framework');
    kg.addEntity('Koa', 'framework');
    kg.addEntity('Node.js', 'runtime');
    const results = kg.findEntitiesByType('framework');
    assert.strictEqual(results.length, 2);
    kg.shutdown();
  });

  it('findEntitiesByName 无匹配返回空数组', () => {
    const kg = new KnowledgeGraphStore();
    kg.addEntity('Node.js');
    const results = kg.findEntitiesByName('Python');
    assert.strictEqual(results.length, 0);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - addRelation/addTriple', () => {
  it('在已有实体间添加关系', () => {
    const kg = new KnowledgeGraphStore();
    const subject = kg.addEntity('Express');
    const object = kg.addEntity('Node.js');
    const rel = kg.addRelation(subject.id, 'depends_on', object.id);
    assert.ok(rel);
    assert.ok(rel.id.startsWith('rel-'));
    assert.strictEqual(rel.subject, subject.id);
    assert.strictEqual(rel.predicate, 'depends_on');
    assert.strictEqual(rel.object, object.id);
    assert.strictEqual(rel.confidence, 1.0);
    kg.shutdown();
  });

  it('添加关系触发 relation-added 事件', () => {
    const kg = new KnowledgeGraphStore();
    const subject = kg.addEntity('Harness');
    const object = kg.addEntity('Node.js');
    let eventData = null;
    kg.on('relation-added', (data) => { eventData = data; });
    const rel = kg.addRelation(subject.id, 'uses', object.id);
    assert.ok(eventData);
    assert.strictEqual(eventData.relationId, rel.id);
    assert.strictEqual(eventData.subjectId, subject.id);
    assert.strictEqual(eventData.predicate, 'uses');
    assert.strictEqual(eventData.objectId, object.id);
    kg.shutdown();
  });

  it('addTriple 便捷方法同时创建实体和关系', () => {
    const kg = new KnowledgeGraphStore();
    const result = kg.addTriple('Express', 'depends_on', 'Node.js', { subjectType: 'framework', objectType: 'runtime' });
    assert.ok(result);
    assert.strictEqual(result.subject.name, 'Express');
    assert.strictEqual(result.object.name, 'Node.js');
    assert.strictEqual(result.relation.predicate, 'depends_on');
    kg.shutdown();
  });

  it('addRelation 实体不存在时返回null', () => {
    const kg = new KnowledgeGraphStore();
    const subject = kg.addEntity('Express');
    const rel = kg.addRelation(subject.id, 'depends_on', 'nonexistent-id');
    assert.strictEqual(rel, null);
    const rel2 = kg.addRelation('nonexistent-id', 'depends_on', subject.id);
    assert.strictEqual(rel2, null);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - getRelations/getIncomingRelations', () => {
  it('getRelations 返回出边关系', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(a.id, 'uses', c.id);
    const rels = kg.getRelations(a.id);
    assert.strictEqual(rels.length, 2);
    kg.shutdown();
  });

  it('getRelations 按谓词过滤', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(a.id, 'uses', c.id);
    const rels = kg.getRelations(a.id, 'depends_on');
    assert.strictEqual(rels.length, 1);
    assert.strictEqual(rels[0].predicate, 'depends_on');
    kg.shutdown();
  });

  it('getIncomingRelations 返回入边关系', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    kg.addRelation(a.id, 'depends_on', c.id);
    kg.addRelation(b.id, 'uses', c.id);
    const rels = kg.getIncomingRelations(c.id);
    assert.strictEqual(rels.length, 2);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - getNeighbors', () => {
  it('获取直接邻居（depth=1）', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(a.id, 'uses', c.id);
    const neighbors = kg.getNeighbors(a.id, 1);
    assert.ok(neighbors.has(a.id));
    assert.ok(neighbors.has(b.id));
    assert.ok(neighbors.has(c.id));
    kg.shutdown();
  });

  it('获取二跳邻居（depth=2）', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    const d = kg.addEntity('D');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(b.id, 'depends_on', c.id);
    kg.addRelation(c.id, 'uses', d.id);
    const neighbors = kg.getNeighbors(a.id, 2);
    assert.ok(neighbors.has(a.id));
    assert.ok(neighbors.has(b.id));
    assert.ok(neighbors.has(c.id));
    assert.ok(!neighbors.has(d.id));
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - query', () => {
  it('默认选项查询', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    kg.addRelation(a.id, 'depends_on', b.id);
    const result = kg.query(a.id);
    assert.strictEqual(result.totalPaths, 1);
    assert.strictEqual(result.paths[0].length, 1);
    assert.ok(result.discoveredEntities.has(a.id));
    assert.ok(result.discoveredEntities.has(b.id));
    kg.shutdown();
  });

  it('按谓词过滤查询', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(a.id, 'uses', c.id);
    const result = kg.query(a.id, { predicate: 'depends_on' });
    assert.strictEqual(result.totalPaths, 1);
    assert.strictEqual(result.paths[0].relations[0].predicate, 'depends_on');
    kg.shutdown();
  });

  it('maxDepth 限制查询深度', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    const d = kg.addEntity('D');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(b.id, 'depends_on', c.id);
    kg.addRelation(c.id, 'depends_on', d.id);
    const result = kg.query(a.id, { maxDepth: 2 });
    assert.ok(result.totalPaths <= 2);
    for (const p of result.paths) {
      assert.ok(p.length <= 2);
    }
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - findPath', () => {
  it('查找已连接实体间的路径', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(b.id, 'uses', c.id);
    const result = kg.findPath(a.id, c.id);
    assert.strictEqual(result.found, true);
    assert.ok(result.path);
    assert.ok(result.length > 0);
    kg.shutdown();
  });

  it('断开实体返回未找到', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    kg.addRelation(a.id, 'depends_on', b.id);
    const result = kg.findPath(a.id, c.id);
    assert.strictEqual(result.found, false);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - inferRelations', () => {
  it('推断传递 IS_A 关系', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('Cat');
    const b = kg.addEntity('Mammal');
    const c = kg.addEntity('Animal');
    kg.addRelation(a.id, 'is_a', b.id);
    kg.addRelation(b.id, 'is_a', c.id);
    const inferred = kg.inferRelations(a.id);
    assert.strictEqual(inferred.length, 1);
    assert.strictEqual(inferred[0].predicate, 'is_a');
    assert.strictEqual(inferred[0].object, c.id);
    assert.strictEqual(inferred[0].source, 'inferred');
    assert.ok(inferred[0].confidence < 1.0);
    kg.shutdown();
  });

  it('推断传递 DEPENDS_ON 关系', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('App');
    const b = kg.addEntity('Framework');
    const c = kg.addEntity('Runtime');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(b.id, 'depends_on', c.id);
    const inferred = kg.inferRelations(a.id);
    assert.strictEqual(inferred.length, 1);
    assert.strictEqual(inferred[0].predicate, 'depends_on');
    assert.strictEqual(inferred[0].object, c.id);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - exportAsTriples/importFromTriples', () => {
  it('导出并重新导入保留数据', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('Express');
    const b = kg.addEntity('Node.js');
    kg.addRelation(a.id, 'depends_on', b.id);
    const triples = kg.exportAsTriples();
    assert.strictEqual(triples.length, 1);
    assert.strictEqual(triples[0].subject, 'Express');
    assert.strictEqual(triples[0].predicate, 'depends_on');
    assert.strictEqual(triples[0].object, 'Node.js');

    const kg2 = new KnowledgeGraphStore();
    const importResult = kg2.importFromTriples(triples);
    assert.ok(importResult.relationsAdded >= 1);

    const triples2 = kg2.exportAsTriples();
    assert.strictEqual(triples2.length, 1);
    assert.strictEqual(triples2[0].subject, 'Express');
    assert.strictEqual(triples2[0].predicate, 'depends_on');
    assert.strictEqual(triples2[0].object, 'Node.js');
    kg.shutdown();
    kg2.shutdown();
  });

  it('导入创建实体和关系', () => {
    const kg = new KnowledgeGraphStore();
    const triples = [
      { subject: 'A', predicate: 'is_a', object: 'B', confidence: 0.9 },
      { subject: 'B', predicate: 'part_of', object: 'C' },
    ];
    const result = kg.importFromTriples(triples);
    assert.ok(result.entitiesAdded >= 2);
    assert.strictEqual(result.relationsAdded, 2);
    const stats = kg.getStats();
    assert.strictEqual(stats.relationCount, 2);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - getSubgraph', () => {
  it('从实体集合提取子图', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    const c = kg.addEntity('C');
    const d = kg.addEntity('D');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.addRelation(b.id, 'uses', c.id);
    kg.addRelation(c.id, 'relates_to', d.id);
    const sub = kg.getSubgraph([a.id, b.id, c.id]);
    assert.strictEqual(sub.entities.length, 3);
    assert.strictEqual(sub.relations.length, 2);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - getStats', () => {
  it('统计信息反映操作', () => {
    const kg = new KnowledgeGraphStore();
    const a = kg.addEntity('A');
    const b = kg.addEntity('B');
    kg.addRelation(a.id, 'depends_on', b.id);
    kg.query(a.id);
    const stats = kg.getStats();
    assert.strictEqual(stats.entitiesAdded, 2);
    assert.strictEqual(stats.relationsAdded, 1);
    assert.strictEqual(stats.entityCount, 2);
    assert.strictEqual(stats.relationCount, 1);
    assert.strictEqual(stats.queriesExecuted, 1);
    assert.ok(stats.avgDegree > 0);
    kg.shutdown();
  });
});

describe('KnowledgeGraphStore - shutdown', () => {
  it('关闭后清空状态', () => {
    const kg = new KnowledgeGraphStore();
    kg.addEntity('A');
    kg.addEntity('B');
    kg.shutdown();
    const stats = kg.getStats();
    assert.strictEqual(stats.entityCount, 0);
    assert.strictEqual(stats.relationCount, 0);
  });
});
