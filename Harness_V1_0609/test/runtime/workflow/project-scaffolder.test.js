'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ProjectScaffolder = require(path.join(ROOT, 'src', 'runtime', 'workflow', 'project-scaffolder'));

// 临时目录，用于文件创建测试
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scaffolder-test-'));

after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
});

describe('Constructor 构造函数', () => {
  it('默认配置应正确初始化', () => {
    const s = new ProjectScaffolder();
    assert.strictEqual(s._config.defaultStack, 'node');
    assert.strictEqual(s._config.maxFiles, 200);
    assert.strictEqual(s._config.maxDepth, 5);
    assert.strictEqual(s._config.includeReadme, true);
    assert.strictEqual(s._config.includeGitignore, true);
    assert.strictEqual(s._config.includePackageJson, true);
    assert.strictEqual(s._config.dryRun, false);
    assert.strictEqual(s._scaffolds.size, 0);
    assert.strictEqual(s._stats.scaffoldsCreated, 0);
    assert.strictEqual(s._stats.filesGenerated, 0);
    s.shutdown();
  });

  it('自定义选项应覆盖默认配置', () => {
    const s = new ProjectScaffolder({
      defaultStack: 'python',
      maxFiles: 50,
      maxDepth: 3,
      includeReadme: false,
      includeGitignore: false,
      includePackageJson: false,
      dryRun: true,
    });
    assert.strictEqual(s._config.defaultStack, 'python');
    assert.strictEqual(s._config.maxFiles, 50);
    assert.strictEqual(s._config.maxDepth, 3);
    assert.strictEqual(s._config.includeReadme, false);
    assert.strictEqual(s._config.includeGitignore, false);
    assert.strictEqual(s._config.includePackageJson, false);
    assert.strictEqual(s._config.dryRun, true);
    s.shutdown();
  });

  it('静态常量 PRESET_TEMPLATES/FILE_TYPES/DEFAULT_CONFIG 应存在', () => {
    assert.ok(ProjectScaffolder.PRESET_TEMPLATES);
    assert.ok(ProjectScaffolder.FILE_TYPES);
    assert.ok(ProjectScaffolder.DEFAULT_CONFIG);
    assert.strictEqual(typeof ProjectScaffolder.PRESET_TEMPLATES, 'object');
    assert.strictEqual(typeof ProjectScaffolder.FILE_TYPES, 'object');
    assert.strictEqual(typeof ProjectScaffolder.DEFAULT_CONFIG, 'object');
    // 验证FILE_TYPES枚举值
    assert.strictEqual(ProjectScaffolder.FILE_TYPES.ENTRY, 'entry');
    assert.strictEqual(ProjectScaffolder.FILE_TYPES.MODULE, 'module');
    assert.strictEqual(ProjectScaffolder.FILE_TYPES.DIRECTORY, 'directory');
    assert.strictEqual(ProjectScaffolder.FILE_TYPES.CONFIG, 'config');
    assert.strictEqual(ProjectScaffolder.FILE_TYPES.TEST, 'test');
    assert.strictEqual(ProjectScaffolder.FILE_TYPES.DOCS, 'docs');
    assert.strictEqual(ProjectScaffolder.FILE_TYPES.TEMPLATE, 'template');
    assert.strictEqual(ProjectScaffolder.FILE_TYPES.STYLE, 'style');
  });
});

describe('attach 方法', () => {
  it('attachGoalExecutor 挂载有效的执行器', () => {
    const s = new ProjectScaffolder();
    const executor = { createGoal() {} };
    const result = s.attachGoalExecutor(executor);
    assert.strictEqual(s._ge, executor);
    assert.strictEqual(s._attached.goalExecutor, true);
    // 应支持链式调用
    assert.strictEqual(result, s);
    s.shutdown();
  });

  it('attachGoalExecutor 无效执行器不应挂载', () => {
    const s = new ProjectScaffolder();
    // 缺少 createGoal 方法
    s.attachGoalExecutor({ notCreateGoal() {} });
    assert.strictEqual(s._ge, null);
    assert.strictEqual(s._attached.goalExecutor, false);
    // null 值
    s.attachGoalExecutor(null);
    assert.strictEqual(s._ge, null);
    // undefined 值
    s.attachGoalExecutor(undefined);
    assert.strictEqual(s._ge, null);
    s.shutdown();
  });

  it('attachPhaseOrchestrator 挂载有效的编排器', () => {
    const s = new ProjectScaffolder();
    const orchestrator = { getCurrentPhase() {} };
    const result = s.attachPhaseOrchestrator(orchestrator);
    assert.strictEqual(s._po, orchestrator);
    assert.strictEqual(s._attached.phaseOrchestrator, true);
    // 应支持链式调用
    assert.strictEqual(result, s);
    s.shutdown();
  });
});

describe('listTemplates/getTemplate 模板操作', () => {
  it('listTemplates 返回全部8个模板', () => {
    const s = new ProjectScaffolder();
    const list = s.listTemplates();
    assert.ok(Array.isArray(list));
    assert.strictEqual(list.length, 8);
    // 验证每个模板条目结构
    const ids = list.map(t => t.id);
    assert.ok(ids.includes('node-cli'));
    assert.ok(ids.includes('node-web'));
    assert.ok(ids.includes('node-api'));
    assert.ok(ids.includes('fullstack'));
    assert.ok(ids.includes('library'));
    assert.ok(ids.includes('pwa'));
    assert.ok(ids.includes('monorepo'));
    assert.ok(ids.includes('custom'));
    // 验证条目字段
    const cli = list.find(t => t.id === 'node-cli');
    assert.strictEqual(cli.name, 'Node.js CLI');
    assert.ok(cli.description);
    assert.ok(Array.isArray(cli.stack));
    assert.strictEqual(typeof cli.fileCount, 'number');
    s.shutdown();
  });

  it('getTemplate 返回指定模板的完整定义', () => {
    const s = new ProjectScaffolder();
    const t = s.getTemplate('node-cli');
    assert.ok(t);
    assert.strictEqual(t.name, 'Node.js CLI');
    assert.ok(Array.isArray(t.files));
    assert.ok(t.files.length > 0);
    s.shutdown();
  });

  it('getTemplate 对未知模板返回null', () => {
    const s = new ProjectScaffolder();
    const t = s.getTemplate('nonexistent');
    assert.strictEqual(t, null);
    s.shutdown();
  });
});

describe('scaffold 脚手架生成', () => {
  it('dryRun模式生成node-cli模板不创建实际文件', async () => {
    const s = new ProjectScaffolder({ dryRun: true });
    const result = await s.scaffold('node-cli', { outputDir: TMP_DIR });
    assert.ok(result.scaffoldId);
    assert.strictEqual(result.templateId, 'node-cli');
    assert.ok(Array.isArray(result.files));
    assert.strictEqual(result.outputDir, TMP_DIR);
    // dryRun模式下所有文件created应为false
    const allNotCreated = result.files.every(f => f.created === false);
    assert.ok(allNotCreated, 'dryRun模式下不应有文件被实际创建');
    s.shutdown();
  });

  it('实际创建目录和文件（使用临时目录）', async () => {
    const outputDir = path.join(TMP_DIR, 'real-scaffold-' + Date.now());
    const s = new ProjectScaffolder();
    const result = await s.scaffold('node-cli', { outputDir });
    assert.ok(result.scaffoldId);
    assert.ok(Array.isArray(result.files));
    // 至少应有部分文件被创建
    const createdFiles = result.files.filter(f => f.created);
    assert.ok(createdFiles.length > 0, '应有文件被实际创建');
    // 验证关键目录/文件存在
    assert.ok(fs.existsSync(path.join(outputDir, 'src')), 'src目录应存在');
    assert.ok(fs.existsSync(path.join(outputDir, 'package.json')), 'package.json应存在');
    s.shutdown();
    // 清理
    try { fs.rmSync(outputDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  });

  it('生成完成应触发scaffold-completed事件', async () => {
    const s = new ProjectScaffolder({ dryRun: true });
    let eventData = null;
    s.on('scaffold-completed', (data) => { eventData = data; });
    await s.scaffold('node-web', { outputDir: TMP_DIR });
    assert.ok(eventData, '应触发scaffold-completed事件');
    assert.strictEqual(eventData.templateId, 'node-web');
    assert.strictEqual(eventData.outputDir, TMP_DIR);
    assert.strictEqual(typeof eventData.fileCount, 'number');
    assert.ok(eventData.scaffoldId);
    s.shutdown();
  });

  it('无效模板应抛出错误', async () => {
    const s = new ProjectScaffolder();
    await assert.rejects(
      () => s.scaffold('invalid-template'),
      { message: /未知模板/ },
    );
    s.shutdown();
  });
});

describe('scaffoldFromDescription 从描述生成', () => {
  it('从"web application with Node.js"描述生成项目', async () => {
    const s = new ProjectScaffolder({ dryRun: true });
    const result = await s.scaffoldFromDescription('web application with Node.js', { outputDir: TMP_DIR });
    assert.ok(result.scaffoldId);
    assert.ok(result.matchedTemplateId);
    assert.ok(Array.isArray(result.detectedFeatures));
    // web + node 关键词应匹配 node-web 或 fullstack
    assert.ok(
      result.matchedTemplateId === 'node-web' || result.matchedTemplateId === 'fullstack',
      '应匹配web相关模板',
    );
    s.shutdown();
  });

  it('从"API server"描述生成项目', async () => {
    const s = new ProjectScaffolder({ dryRun: true });
    const result = await s.scaffoldFromDescription('API server', { outputDir: TMP_DIR });
    assert.ok(result.scaffoldId);
    // api/server关键词应匹配node-api
    assert.strictEqual(result.matchedTemplateId, 'node-api');
    s.shutdown();
  });

  it('空描述应默认匹配node-cli模板', async () => {
    const s = new ProjectScaffolder({ dryRun: true });
    // 空描述在scaffoldFromDescription中会抛错，但无关键词描述应匹配默认模板
    // 使用一个不含任何关键词的描述
    const result = await s.scaffoldFromDescription('hello world project', { outputDir: TMP_DIR });
    assert.ok(result.scaffoldId);
    assert.strictEqual(result.matchedTemplateId, 'node-cli');
    s.shutdown();
  });
});

describe('getStats/getScaffold 统计与查询', () => {
  it('getStats 返回初始统计信息', () => {
    const s = new ProjectScaffolder();
    const stats = s.getStats();
    assert.strictEqual(stats.scaffoldsCreated, 0);
    assert.strictEqual(stats.filesGenerated, 0);
    assert.deepStrictEqual(stats.templatesUsed, {});
    s.shutdown();
  });

  it('getScaffold 通过id返回脚手架记录', async () => {
    const s = new ProjectScaffolder({ dryRun: true });
    const result = await s.scaffold('library', { outputDir: TMP_DIR });
    const record = s.getScaffold(result.scaffoldId);
    assert.ok(record, '应能通过scaffoldId查到记录');
    assert.strictEqual(record.scaffoldId, result.scaffoldId);
    assert.strictEqual(record.templateId, 'library');
    assert.strictEqual(record.outputDir, TMP_DIR);
    assert.ok(record.createdAt);
    assert.strictEqual(record.dryRun, true);
    // 不存在的id应返回null
    assert.strictEqual(s.getScaffold('nonexistent-id'), null);
    s.shutdown();
  });
});

describe('shutdown 关闭', () => {
  it('关闭后应清空内部状态', async () => {
    const s = new ProjectScaffolder({ dryRun: true });
    await s.scaffold('pwa', { outputDir: TMP_DIR });
    // 关闭前应有记录
    assert.strictEqual(s._scaffolds.size, 1);
    s.shutdown();
    // 关闭后应清空
    assert.strictEqual(s._scaffolds.size, 0);
    assert.strictEqual(s._ge, null);
    assert.strictEqual(s._po, null);
    assert.strictEqual(s._attached.goalExecutor, false);
    assert.strictEqual(s._attached.phaseOrchestrator, false);
  });
});
