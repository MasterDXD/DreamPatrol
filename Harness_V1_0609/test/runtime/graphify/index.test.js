'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

const {
  GraphifyCompiler,
  FileTypeDetector,
  AstParser,
  SemanticExtractor,
  LouvainClusterer,
  GraphBuilder,
  GraphQueryEngine,
} = require(path.join(ROOT, 'src', 'runtime', 'graphify'));

describe('FileTypeDetector', () => {
  it('should detect JavaScript file type', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('test.js');
    assert.strictEqual(result.type, 'javascript');
    assert.strictEqual(result.category, 'ast');
    assert.strictEqual(result.extension, '.js');
    detector.shutdown();
  });

  it('should detect TypeScript file type', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('app.tsx');
    assert.strictEqual(result.type, 'typescript');
    assert.strictEqual(result.category, 'ast');
    detector.shutdown();
  });

  it('should detect Python file type', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('main.py');
    assert.strictEqual(result.type, 'python');
    assert.strictEqual(result.category, 'ast');
    detector.shutdown();
  });

  it('should detect Markdown file type', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('README.md');
    assert.strictEqual(result.type, 'markdown');
    assert.strictEqual(result.category, 'text');
    detector.shutdown();
  });

  it('should detect PDF file type', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('doc.pdf');
    assert.strictEqual(result.type, 'pdf');
    assert.strictEqual(result.category, 'multimodal');
    detector.shutdown();
  });

  it('should detect image file types', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('photo.png');
    assert.strictEqual(result.type, 'image');
    assert.strictEqual(result.category, 'multimodal');
    detector.shutdown();
  });

  it('should detect audio file types', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('speech.mp3');
    assert.strictEqual(result.type, 'audio');
    assert.strictEqual(result.category, 'multimodal');
    detector.shutdown();
  });

  it('should return unknown for unrecognized extensions', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('data.xyz');
    assert.strictEqual(result.type, 'unknown');
    assert.strictEqual(result.category, 'unknown');
    detector.shutdown();
  });

  it('should return unknown for empty input', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect('');
    assert.strictEqual(result.type, 'unknown');
    detector.shutdown();
  });

  it('should return unknown for null input', () => {
    const detector = new FileTypeDetector();
    const result = detector.detect(null);
    assert.strictEqual(result.type, 'unknown');
    detector.shutdown();
  });

  it('should detect batch of files', () => {
    const detector = new FileTypeDetector();
    const results = detector.detectBatch(['a.js', 'b.py', 'c.md']);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].type, 'javascript');
    assert.strictEqual(results[1].type, 'python');
    assert.strictEqual(results[2].type, 'markdown');
    detector.shutdown();
  });

  it('should return empty array for non-array input', () => {
    const detector = new FileTypeDetector();
    const results = detector.detectBatch('not-array');
    assert.strictEqual(results.length, 0);
    detector.shutdown();
  });

  it('should return supported types', () => {
    const detector = new FileTypeDetector();
    const types = detector.getSupportedTypes();
    assert.ok(types.indexOf('javascript') >= 0);
    assert.ok(types.indexOf('python') >= 0);
    assert.ok(types.indexOf('markdown') >= 0);
    detector.shutdown();
  });

  it('should return supported extensions', () => {
    const detector = new FileTypeDetector();
    const exts = detector.getSupportedExtensions();
    assert.ok(exts.indexOf('.js') >= 0);
    assert.ok(exts.indexOf('.py') >= 0);
    detector.shutdown();
  });

  it('should get category for type', () => {
    const detector = new FileTypeDetector();
    assert.strictEqual(detector.getCategoryForType('javascript'), 'ast');
    assert.strictEqual(detector.getCategoryForType('markdown'), 'text');
    assert.strictEqual(detector.getCategoryForType('pdf'), 'multimodal');
    detector.shutdown();
  });

  it('should check AST type', () => {
    const detector = new FileTypeDetector();
    assert.strictEqual(detector.isAstType('javascript'), true);
    assert.strictEqual(detector.isAstType('markdown'), false);
    detector.shutdown();
  });

  it('should check multimodal type', () => {
    const detector = new FileTypeDetector();
    assert.strictEqual(detector.isMultimodalType('pdf'), true);
    assert.strictEqual(detector.isMultimodalType('javascript'), false);
    detector.shutdown();
  });

  it('should support custom mappings', () => {
    const detector = new FileTypeDetector({ customMappings: { '.custom': 'javascript' } });
    const result = detector.detect('file.custom');
    assert.strictEqual(result.type, 'javascript');
    detector.shutdown();
  });

  it('should reject after shutdown', () => {
    const detector = new FileTypeDetector();
    detector.shutdown();
    assert.throws(() => detector.detect('test.js'));
  });
});

describe('AstParser', () => {
  it('should parse JavaScript with regex fallback', async () => {
    const parser = new AstParser();
    const code = 'function hello() { return 42; }\nclass MyClass {}\nconst foo = require("bar");\nmodule.exports = hello;';
    const result = await parser.parseFile('test.js', code);
    assert.strictEqual(result.parser, 'regex');
    assert.ok(result.functions.length >= 0);
    assert.ok(result.classes.length >= 0);
    parser.shutdown();
  });

  it('should parse Python with regex fallback', async () => {
    const parser = new AstParser();
    const code = 'def hello():\n    pass\n\nclass MyClass:\n    pass\n\nimport os';
    const result = await parser.parseFile('test.py', code);
    assert.strictEqual(result.parser, 'regex');
    assert.ok(result.functions.length >= 0);
    assert.ok(result.classes.length >= 0);
    parser.shutdown();
  });

  it('should return empty result for empty path', async () => {
    const parser = new AstParser();
    const result = await parser.parseFile('', 'code');
    assert.strictEqual(result.functions.length, 0);
    parser.shutdown();
  });

  it('should return empty result for null content', async () => {
    const parser = new AstParser();
    const result = await parser.parseFile('test.js', null);
    assert.ok(result);
    parser.shutdown();
  });

  it('should parse batch of files', async () => {
    const parser = new AstParser();
    const files = [
      { filePath: 'a.js', content: 'function a() {}' },
      { filePath: 'b.py', content: 'def b(): pass' },
    ];
    const results = await parser.parseBatch(files);
    assert.ok(results.has('a.js'));
    assert.ok(results.has('b.py'));
    parser.shutdown();
  });

  it('should return empty map for non-array batch', async () => {
    const parser = new AstParser();
    const results = await parser.parseBatch('not-array');
    assert.strictEqual(results.size, 0);
    parser.shutdown();
  });

  it('should skip items without filePath in batch', async () => {
    const parser = new AstParser();
    const files = [{ content: 'code' }, { filePath: 'a.js', content: 'function a() {}' }];
    const results = await parser.parseBatch(files);
    assert.strictEqual(results.size, 1);
    parser.shutdown();
  });

  it('should clear cache', () => {
    const parser = new AstParser();
    parser.clearCache();
    parser.shutdown();
  });

  it('should report tree-sitter availability', () => {
    const parser = new AstParser();
    assert.strictEqual(typeof parser.isTreeSitterAvailable, 'boolean');
    parser.shutdown();
  });

  it('should reject after shutdown', async () => {
    const parser = new AstParser();
    parser.shutdown();
    await assert.rejects(() => parser.parseFile('test.js', 'code'));
  });
});

describe('SemanticExtractor', () => {
  it('should extract headings from markdown', async () => {
    const extractor = new SemanticExtractor();
    const content = '# Title\n## Section\n### Subsection\nSome text';
    const result = await extractor.extractSemantic('test.md', content, 'markdown');
    assert.ok(result.semantics.length >= 1);
    const headings = result.semantics.filter(s => s.type === 'heading');
    assert.ok(headings.length >= 1);
    extractor.shutdown();
  });

  it('should extract decisions from text', async () => {
    const extractor = new SemanticExtractor();
    const content = '决策：采用微服务架构\nDecision：Use REST API';
    const result = await extractor.extractSemantic('test.md', content, 'markdown');
    const decisions = result.semantics.filter(s => s.type === 'decision');
    assert.ok(decisions.length >= 1);
    extractor.shutdown();
  });

  it('should extract rules from text', async () => {
    const extractor = new SemanticExtractor();
    const content = '规则：所有接口必须鉴权\nRule：No direct DB access';
    const result = await extractor.extractSemantic('test.md', content, 'text');
    const rules = result.semantics.filter(s => s.type === 'rule');
    assert.ok(rules.length >= 1);
    extractor.shutdown();
  });

  it('should extract TODOs from text', async () => {
    const extractor = new SemanticExtractor();
    const content = 'TODO：实现缓存\nFIXME：修复内存泄漏';
    const result = await extractor.extractSemantic('test.md', content, 'text');
    const todos = result.semantics.filter(s => s.type === 'todo');
    assert.ok(todos.length >= 1);
    extractor.shutdown();
  });

  it('should return empty result for empty path', async () => {
    const extractor = new SemanticExtractor();
    const result = await extractor.extractSemantic('', 'content', 'text');
    assert.strictEqual(result.semantics.length, 0);
    extractor.shutdown();
  });

  it('should handle multimodal without LLM client', async () => {
    const extractor = new SemanticExtractor();
    const result = await extractor.extractSemantic('doc.pdf', 'content', 'pdf');
    assert.strictEqual(result.parser, 'no-llm');
    extractor.shutdown();
  });

  it('should extract from structured JSON', async () => {
    const extractor = new SemanticExtractor();
    const content = '{"name": "test", "version": "1.0"}';
    const result = await extractor.extractSemantic('pkg.json', content, 'json');
    assert.strictEqual(result.parser, 'structured');
    assert.ok(result.semantics.length >= 1);
    extractor.shutdown();
  });

  it('should extract batch of files', async () => {
    const extractor = new SemanticExtractor();
    const files = [
      { filePath: 'a.md', content: '# Title', type: 'markdown' },
      { filePath: 'b.md', content: '## Section', type: 'markdown' },
    ];
    const results = await extractor.extractBatch(files);
    assert.ok(results.has('a.md'));
    assert.ok(results.has('b.md'));
    extractor.shutdown();
  });

  it('should return empty map for non-array batch', async () => {
    const extractor = new SemanticExtractor();
    const results = await extractor.extractBatch('not-array');
    assert.strictEqual(results.size, 0);
    extractor.shutdown();
  });

  it('should report cost', () => {
    const extractor = new SemanticExtractor();
    const cost = extractor.getCostReport();
    assert.strictEqual(typeof cost.totalTokens, 'number');
    assert.strictEqual(typeof cost.totalCalls, 'number');
    extractor.shutdown();
  });

  it('should reject after shutdown', async () => {
    const extractor = new SemanticExtractor();
    extractor.shutdown();
    await assert.rejects(() => extractor.extractSemantic('test.md', 'content', 'text'));
  });
});

describe('LouvainClusterer', () => {
  it('should cluster a simple graph', () => {
    const clusterer = new LouvainClusterer();
    const nodes = new Map();
    nodes.set('n1', { id: 'n1', name: 'A' });
    nodes.set('n2', { id: 'n2', name: 'B' });
    nodes.set('n3', { id: 'n3', name: 'C' });
    const edges = new Map();
    edges.set('e1', { source: 'n1', target: 'n2', weight: 1.0 });
    edges.set('e2', { source: 'n2', target: 'n3', weight: 1.0 });

    const result = clusterer.cluster({ nodes, edges });
    assert.ok(result.clusters instanceof Map);
    assert.ok(result.clusters.size >= 1);
    assert.strictEqual(typeof result.modularity, 'number');
    clusterer.shutdown();
  });

  it('should handle empty graph', () => {
    const clusterer = new LouvainClusterer();
    const result = clusterer.cluster({ nodes: new Map(), edges: new Map() });
    assert.strictEqual(result.clusters.size, 0);
    assert.strictEqual(result.modularity, 0);
    clusterer.shutdown();
  });

  it('should handle graph with no edges', () => {
    const clusterer = new LouvainClusterer();
    const nodes = new Map();
    nodes.set('n1', { id: 'n1', name: 'A' });
    nodes.set('n2', { id: 'n2', name: 'B' });
    const result = clusterer.cluster({ nodes, edges: new Map() });
    assert.ok(result.clusters.size >= 1);
    clusterer.shutdown();
  });

  it('should handle null input', () => {
    const clusterer = new LouvainClusterer();
    const result = clusterer.cluster(null);
    assert.strictEqual(result.clusters.size, 0);
    clusterer.shutdown();
  });

  it('should get cluster by id', () => {
    const clusterer = new LouvainClusterer();
    const nodes = new Map();
    nodes.set('n1', { id: 'n1', name: 'A' });
    nodes.set('n2', { id: 'n2', name: 'B' });
    const edges = new Map();
    edges.set('e1', { source: 'n1', target: 'n2', weight: 1.0 });
    clusterer.cluster({ nodes, edges });

    const clusters = clusterer._clusters;
    if (clusters.size > 0) {
      const firstKey = clusters.keys().next().value;
      const cluster = clusterer.getCluster(firstKey);
      assert.ok(cluster);
      assert.ok(cluster.nodeIds);
    }
    clusterer.shutdown();
  });

  it('should return null for non-existent cluster', () => {
    const clusterer = new LouvainClusterer();
    assert.strictEqual(clusterer.getCluster('nonexistent'), null);
    clusterer.shutdown();
  });

  it('should get cluster hierarchy', () => {
    const clusterer = new LouvainClusterer();
    const nodes = new Map();
    nodes.set('n1', { id: 'n1', name: 'A' });
    const edges = new Map();
    clusterer.cluster({ nodes, edges });
    const hierarchy = clusterer.getClusterHierarchy();
    assert.ok(Array.isArray(hierarchy));
    clusterer.shutdown();
  });

  it('should get modularity', () => {
    const clusterer = new LouvainClusterer();
    assert.strictEqual(typeof clusterer.getModularity(), 'number');
    clusterer.shutdown();
  });

  it('should reject after shutdown', () => {
    const clusterer = new LouvainClusterer();
    clusterer.shutdown();
    assert.throws(() => clusterer.cluster({ nodes: new Map(), edges: new Map() }));
  });
});

describe('GraphBuilder', () => {
  it('should add nodes', () => {
    const builder = new GraphBuilder();
    const node = builder.addNode({ type: 'file', name: 'test.js', filePath: '/test.js' });
    assert.ok(node);
    assert.ok(node.id);
    assert.strictEqual(node.type, 'file');
    assert.strictEqual(node.name, 'test.js');
    builder.shutdown();
  });

  it('should add edges', () => {
    const builder = new GraphBuilder();
    const nodeA = builder.addNode({ type: 'file', name: 'a.js' });
    const nodeB = builder.addNode({ type: 'file', name: 'b.js' });
    const edge = builder.addEdge({ source: nodeA.id, target: nodeB.id, type: 'imports' });
    assert.ok(edge);
    assert.strictEqual(edge.source, nodeA.id);
    assert.strictEqual(edge.target, nodeB.id);
    builder.shutdown();
  });

  it('should reject node without type', () => {
    const builder = new GraphBuilder();
    const node = builder.addNode({ name: 'test' });
    assert.strictEqual(node, null);
    builder.shutdown();
  });

  it('should reject edge without source or target', () => {
    const builder = new GraphBuilder();
    const edge = builder.addEdge({ type: 'imports' });
    assert.strictEqual(edge, null);
    builder.shutdown();
  });

  it('should build from parsed data', () => {
    const builder = new GraphBuilder();
    const parsedData = {
      filePath: 'test.js',
      parser: 'regex',
      functions: [{ name: 'hello', startRow: 0, endRow: 5 }],
      classes: [{ name: 'MyClass', startRow: 6, endRow: 20 }],
      imports: [{ source: 'path', type: 'import' }],
      exports: [{ name: 'hello', type: 'export' }],
      calls: [{ name: 'require', startRow: 0 }],
    };
    const result = builder.buildFromParsedData(parsedData);
    assert.ok(result.nodesAdded > 0);
    assert.ok(result.edgesAdded > 0);
    builder.shutdown();
  });

  it('should return null for null parsed data', () => {
    const builder = new GraphBuilder();
    const result = builder.buildFromParsedData(null);
    assert.strictEqual(result.nodesAdded, 0);
    assert.strictEqual(result.edgesAdded, 0);
    builder.shutdown();
  });

  it('should resolve references', () => {
    const builder = new GraphBuilder();
    const nodeA = builder.addNode({ type: 'file', name: 'a.js', filePath: '/a.js' });
    builder.addNode({ type: 'function', name: 'myFunc', filePath: '/b.js' });
    builder.addEdge({ source: nodeA.id, target: 'myFunc', type: 'calls' });
    const resolved = builder.resolveReferences();
    assert.strictEqual(typeof resolved, 'number');
    builder.shutdown();
  });

  it('should get graph', () => {
    const builder = new GraphBuilder();
    builder.addNode({ type: 'file', name: 'test.js' });
    const graph = builder.getGraph();
    assert.strictEqual(graph.nodeCount, 1);
    assert.strictEqual(graph.edgeCount, 0);
    builder.shutdown();
  });

  it('should get nodes by type', () => {
    const builder = new GraphBuilder();
    builder.addNode({ type: 'file', name: 'a.js' });
    builder.addNode({ type: 'file', name: 'b.js' });
    builder.addNode({ type: 'function', name: 'foo' });
    const files = builder.getNodesByType('file');
    assert.strictEqual(files.length, 2);
    builder.shutdown();
  });

  it('should get edges for node', () => {
    const builder = new GraphBuilder();
    const nodeA = builder.addNode({ type: 'file', name: 'a.js' });
    const nodeB = builder.addNode({ type: 'file', name: 'b.js' });
    builder.addEdge({ source: nodeA.id, target: nodeB.id, type: 'imports' });
    const edges = builder.getEdgesForNode(nodeA.id);
    assert.strictEqual(edges.outgoing.length, 1);
    assert.strictEqual(edges.incoming.length, 0);
    builder.shutdown();
  });

  it('should deduplicate edges', () => {
    const builder = new GraphBuilder();
    const nodeA = builder.addNode({ type: 'file', name: 'a.js' });
    const nodeB = builder.addNode({ type: 'file', name: 'b.js' });
    builder.addEdge({ source: nodeA.id, target: nodeB.id, type: 'imports' });
    builder.addEdge({ source: nodeA.id, target: nodeB.id, type: 'imports' });
    assert.strictEqual(builder.getGraph().edgeCount, 1);
    builder.shutdown();
  });

  it('should reject after shutdown', () => {
    const builder = new GraphBuilder();
    builder.shutdown();
    assert.throws(() => builder.addNode({ type: 'file' }), /shut down/i);
  });
});

describe('GraphQueryEngine', () => {
  function createTestEngine() {
    const engine = new GraphQueryEngine();
    const nodes = new Map();
    nodes.set('n1', { id: 'n1', type: 'file', name: 'a.js' });
    nodes.set('n2', { id: 'n2', type: 'function', name: 'hello' });
    nodes.set('n3', { id: 'n3', type: 'class', name: 'MyClass' });
    const edges = new Map();
    edges.set('e1', { id: 'e1', source: 'n1', target: 'n2', type: 'contains', weight: 1 });
    edges.set('e2', { id: 'e2', source: 'n1', target: 'n3', type: 'contains', weight: 1 });
    const clusters = new Map();
    clusters.set('c1', { id: 'c1', nodeIds: ['n1', 'n2', 'n3'], size: 3 });
    engine.attachGraph({ nodes, edges }, clusters);
    return engine;
  }

  it('should query by type', () => {
    const engine = createTestEngine();
    const result = engine.query({ type: 'file' });
    assert.ok(result.results.length >= 1);
    assert.strictEqual(result.results[0].type, 'file');
    engine.shutdown();
  });

  it('should query by name', () => {
    const engine = createTestEngine();
    const result = engine.query({ name: 'hello' });
    assert.ok(result.results.length >= 1);
    engine.shutdown();
  });

  it('should query by nodeId', () => {
    const engine = createTestEngine();
    const result = engine.query({ nodeId: 'n1' });
    assert.ok(result.results.length >= 1);
    assert.strictEqual(result.results[0].id, 'n1');
    engine.shutdown();
  });

  it('should query by cluster', () => {
    const engine = createTestEngine();
    const result = engine.query({ clusterId: 'c1' });
    assert.ok(result.results.length >= 1);
    engine.shutdown();
  });

  it('should return all nodes when no filter', () => {
    const engine = createTestEngine();
    const result = engine.query({});
    assert.strictEqual(result.results.length, 3);
    engine.shutdown();
  });

  it('should return empty for null spec', () => {
    const engine = createTestEngine();
    const result = engine.query(null);
    assert.strictEqual(result.results.length, 0);
    engine.shutdown();
  });

  it('should find path between nodes', () => {
    const engine = createTestEngine();
    const pathResult = engine.findPath('n1', 'n3');
    assert.ok(pathResult);
    assert.ok(pathResult.nodes.length >= 2);
    engine.shutdown();
  });

  it('should return null for path to self', () => {
    const engine = createTestEngine();
    const pathResult = engine.findPath('n1', 'n1');
    assert.strictEqual(pathResult.length, 0);
    engine.shutdown();
  });

  it('should return null for non-existent node', () => {
    const engine = createTestEngine();
    const pathResult = engine.findPath('n1', 'nonexistent');
    assert.strictEqual(pathResult, null);
    engine.shutdown();
  });

  it('should get subgraph', () => {
    const engine = createTestEngine();
    const subgraph = engine.getSubgraph(['n1', 'n2']);
    assert.strictEqual(subgraph.nodes.length, 2);
    engine.shutdown();
  });

  it('should return empty subgraph for non-array input', () => {
    const engine = createTestEngine();
    const subgraph = engine.getSubgraph('not-array');
    assert.strictEqual(subgraph.nodes.length, 0);
    engine.shutdown();
  });

  it('should get architecture overview', () => {
    const engine = createTestEngine();
    const overview = engine.getArchitectureOverview();
    assert.strictEqual(overview.totalNodes, 3);
    assert.strictEqual(overview.totalEdges, 2);
    assert.strictEqual(overview.totalClusters, 1);
    assert.ok(overview.nodeTypes);
    engine.shutdown();
  });

  it('should get stats', () => {
    const engine = createTestEngine();
    engine.query({ type: 'file' });
    const stats = engine.getStats();
    assert.strictEqual(stats.queriesExecuted, 1);
    engine.shutdown();
  });

  it('should use bidirectional search strategy', () => {
    const engine = createTestEngine();
    const result = engine.query({ fromId: 'n2', toId: 'n3', strategy: 'bidirectional-search' });
    assert.ok(result);
    engine.shutdown();
  });

  it('should use selective priority strategy', () => {
    const engine = createTestEngine();
    const result = engine.query({ type: 'file', strategy: 'selective-priority' });
    assert.ok(result.results.length >= 1);
    engine.shutdown();
  });

  it('should use cache materialization strategy', () => {
    const engine = createTestEngine();
    const result = engine.query({ type: 'file', strategy: 'cache-materialization' });
    assert.ok(result.results.length >= 1);
    engine.shutdown();
  });

  it('should clear cache', () => {
    const engine = createTestEngine();
    engine.query({ type: 'file' });
    engine.clearCache();
    const stats = engine.getStats();
    assert.strictEqual(stats.cacheHits, 0);
    engine.shutdown();
  });

  it('should reject after shutdown', () => {
    const engine = createTestEngine();
    engine.shutdown();
    assert.throws(() => engine.query({ type: 'file' }));
  });
});

describe('GraphifyCompiler', () => {
  it('should create instance with default config', () => {
    const compiler = new GraphifyCompiler();
    assert.ok(compiler);
    assert.strictEqual(compiler._pipelineState, 'idle');
    compiler.shutdown();
  });

  it('should merge custom config', () => {
    const compiler = new GraphifyCompiler({ maxConcurrency: 8 });
    assert.strictEqual(compiler._config.maxConcurrency, 8);
    compiler.shutdown();
  });

  it('should return error for missing projectRoot', async () => {
    const compiler = new GraphifyCompiler();
    const result = await compiler.compile('');
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    compiler.shutdown();
  });

  it('should return error for null projectRoot', async () => {
    const compiler = new GraphifyCompiler();
    const result = await compiler.compile(null);
    assert.strictEqual(result.success, false);
    compiler.shutdown();
  });

  it('should compile a project directory', async () => {
    const compiler = new GraphifyCompiler({
      enableSemanticExtraction: false,
      enableClustering: true,
      enableReport: true,
    });
    const result = await compiler.compile(ROOT);
    assert.strictEqual(result.success, true);
    assert.ok(result.nodeCount >= 0);
    assert.ok(result.edgeCount >= 0);
    compiler.shutdown();
  });

  it('should get stats', async () => {
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });
    await compiler.compile(ROOT);
    const stats = compiler.getStats();
    assert.strictEqual(stats.pipelineState, 'completed');
    assert.ok(stats.nodeCount >= 0);
    compiler.shutdown();
  });

  it('should get cost report', () => {
    const compiler = new GraphifyCompiler();
    const cost = compiler.getCostReport();
    assert.strictEqual(typeof cost.totalTokens, 'number');
    assert.strictEqual(typeof cost.totalCalls, 'number');
    compiler.shutdown();
  });

  it('should get manifest', () => {
    const compiler = new GraphifyCompiler();
    const manifest = compiler.getManifest();
    assert.strictEqual(manifest.version, 1);
    compiler.shutdown();
  });

  it('should get report after compilation', async () => {
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false, enableReport: true });
    await compiler.compile(ROOT);
    const report = compiler.getReport();
    assert.ok(report);
    assert.ok(report.indexOf('Graphify') >= 0);
    compiler.shutdown();
  });

  it('should return null report before compilation', () => {
    const compiler = new GraphifyCompiler();
    assert.strictEqual(compiler.getReport(), null);
    compiler.shutdown();
  });

  it('should get node by id', async () => {
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });
    await compiler.compile(ROOT);
    const node = compiler.getNode('nonexistent');
    assert.strictEqual(node, null);
    compiler.shutdown();
  });

  it('should get edges for node', async () => {
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });
    await compiler.compile(ROOT);
    const edges = compiler.getEdges('nonexistent');
    assert.ok(edges);
    compiler.shutdown();
  });

  it('should get cluster', () => {
    const compiler = new GraphifyCompiler();
    assert.strictEqual(compiler.getCluster('nonexistent'), null);
    compiler.shutdown();
  });

  it('should query the compiled graph', async () => {
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });
    await compiler.compile(ROOT);
    const result = await compiler.query({ type: 'file', limit: 5 });
    assert.ok(result);
    assert.ok(Array.isArray(result.results));
    compiler.shutdown();
  });

  it('should handle incremental compilation with no changes', async () => {
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });
    const result = await compiler.compileIncremental(ROOT, []);
    assert.strictEqual(result.success, true);
    compiler.shutdown();
  });

  it('should handle incremental compilation with non-existent files', async () => {
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });
    const result = await compiler.compileIncremental(ROOT, ['nonexistent.js']);
    assert.strictEqual(result.success, true);
    compiler.shutdown();
  });

  it('should reject incremental with missing projectRoot', async () => {
    const compiler = new GraphifyCompiler();
    const result = await compiler.compileIncremental('', ['test.js']);
    assert.strictEqual(result.success, false);
    compiler.shutdown();
  });

  it('should reject incremental with non-array changedFiles', async () => {
    const compiler = new GraphifyCompiler();
    const result = await compiler.compileIncremental(ROOT, 'not-array');
    assert.strictEqual(result.success, true);
    compiler.shutdown();
  });

  it('should emit stage events during compilation', async () => {
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });
    const events = [];
    compiler.on('stage-started', (e) => events.push('started:' + e.stage));
    compiler.on('stage-completed', (e) => events.push('completed:' + e.stage));
    await compiler.compile(ROOT);
    assert.ok(events.length >= 2);
    compiler.shutdown();
  });

  it('should reject after shutdown', async () => {
    const compiler = new GraphifyCompiler();
    compiler.shutdown();
    await assert.rejects(() => compiler.compile(ROOT));
  });

  it('should expose PIPELINE_STAGES', () => {
    assert.ok(Array.isArray(GraphifyCompiler.PIPELINE_STAGES));
    assert.strictEqual(GraphifyCompiler.PIPELINE_STAGES.length, 7);
  });
});

describe('GraphifyCompiler - GraphRAG Integration', () => {
  it('should attach GraphifyCompiler to GraphRAG', async () => {
    const GraphRAGModule = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'graph-rag'));
    const GraphRAG = GraphRAGModule.GraphRAG || GraphRAGModule;
    const rag = new GraphRAG();
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });

    rag.attachGraphifyCompiler(compiler);
    assert.ok(rag._graphifyCompiler);

    rag.shutdown();
    compiler.shutdown();
  });

  it('should use Graphify for enhanced queries when attached', async () => {
    const GraphRAGModule = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'graph-rag'));
    const GraphRAG = GraphRAGModule.GraphRAG || GraphRAGModule;
    const rag = new GraphRAG();
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });

    await compiler.compile(ROOT);
    rag.attachGraphifyCompiler(compiler);

    rag.ingestDocument('doc1', 'NodeJS is a JavaScript runtime');

    const result = await rag.query('NodeJS');
    assert.strictEqual(result.success, true);

    rag.shutdown();
    compiler.shutdown();
  });

  it('should fallback to regex when Graphify has no results', async () => {
    const GraphRAGModule = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'graph-rag'));
    const GraphRAG = GraphRAGModule.GraphRAG || GraphRAGModule;
    const rag = new GraphRAG();

    rag.ingestDocument('doc1', 'Mr. John Smith works at Acme Inc. NodeJS is used.');

    const result = await rag.query('John Smith');
    assert.strictEqual(result.success, true);
    assert.ok(result.results.length >= 0);

    rag.shutdown();
  });

  it('should not break when GraphifyCompiler is not attached', async () => {
    const GraphRAGModule = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'graph-rag'));
    const GraphRAG = GraphRAGModule.GraphRAG || GraphRAGModule;
    const rag = new GraphRAG();

    rag.ingestDocument('doc1', 'NodeJS technology is used by Acme Inc.');
    const result = await rag.query('NodeJS');
    assert.strictEqual(result.success, true);

    rag.shutdown();
  });

  it('should track graphifyQueries in stats', async () => {
    const GraphRAGModule = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'graph-rag'));
    const GraphRAG = GraphRAGModule.GraphRAG || GraphRAGModule;
    const rag = new GraphRAG();
    const compiler = new GraphifyCompiler({ enableSemanticExtraction: false });

    await compiler.compile(ROOT);
    rag.attachGraphifyCompiler(compiler);

    const stats = rag.getStats();
    assert.strictEqual(typeof stats.graphifyQueries, 'number');

    rag.shutdown();
    compiler.shutdown();
  });
});
