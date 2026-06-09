'use strict';

/**
 * 项目脚手架生成器。融合Vibe Coding "PlanningWithFiles"技能核心能力，
 * 从需求描述自动生成项目文件结构，桥接Harness PhaseOrchestrator（开发阶段管理）
 * 与Vibe Coding（项目目录树和文件结构自动生成）之间的能力缺口。
 *
 * @module runtime/workflow/project-scaffolder
 * @fires ProjectScaffolder#scaffold-completed
 * @fires ProjectScaffolder#scaffold-failed
 * @fires ProjectScaffolder#shutdown
 * @example
 * const Scaffolder = require('./project-scaffolder');
 * const scaffolder = new Scaffolder({ defaultStack: 'node' });
 *
 * // 从模板生成项目
 * const result = await scaffolder.scaffold('node-web', { outputDir: '/project/my-app' });
 *
 * // 从自然语言描述生成项目（PlanningWithFiles核心能力）
 * const result2 = await scaffolder.scaffoldFromDescription(
 *   '一个Node.js REST API项目，需要用户认证和数据库模块',
 *   { outputDir: '/project/my-api' }
 * );
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { debug } = require('../../utils/debug-logger');
const { emitError } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const { generateId } = require('../../utils/constants');
const { ensureDirSync } = require('../../utils/fs-utils');
const { withShutdown } = require('../../utils/shutdown-mixin');

/**
 * 文件类型枚举
 * @enum {string}
 */
const FILE_TYPES = {
  ENTRY: 'entry',
  MODULE: 'module',
  DIRECTORY: 'directory',
  CONFIG: 'config',
  TEST: 'test',
  DOCS: 'docs',
  TEMPLATE: 'template',
  STYLE: 'style',
};

/**
 * 默认配置
 * @type {Object}
 */
const DEFAULT_CONFIG = {
  defaultStack: 'node',
  maxFiles: 200,
  maxDepth: 5,
  includeReadme: true,
  includeGitignore: true,
  includePackageJson: true,
  dryRun: false,
};

/**
 * 预设项目模板（8个）
 * @type {Object.<string, Object>}
 */
const PRESET_TEMPLATES = {
  'node-cli': {
    name: 'Node.js CLI',
    description: 'Node.js命令行工具项目',
    stack: ['node', 'javascript'],
    files: [
      { path: 'src/index.js', type: FILE_TYPES.ENTRY, description: '入口文件' },
      { path: 'src/cli.js', type: FILE_TYPES.MODULE, description: 'CLI参数解析' },
      { path: 'src/commands/', type: FILE_TYPES.DIRECTORY, description: '命令目录' },
      { path: 'src/utils/', type: FILE_TYPES.DIRECTORY, description: '工具函数' },
      { path: 'test/', type: FILE_TYPES.DIRECTORY, description: '测试目录' },
      { path: 'package.json', type: FILE_TYPES.CONFIG, description: '项目配置' },
      { path: '.gitignore', type: FILE_TYPES.CONFIG, description: 'Git忽略规则' },
      { path: 'README.md', type: FILE_TYPES.DOCS, description: '项目说明' },
    ],
  },
  'node-web': {
    name: 'Node.js Web',
    description: 'Node.js Web应用项目',
    stack: ['node', 'javascript', 'html', 'css'],
    files: [
      { path: 'src/server.js', type: FILE_TYPES.ENTRY, description: 'HTTP服务器' },
      { path: 'src/routes/', type: FILE_TYPES.DIRECTORY, description: '路由模块' },
      { path: 'src/middleware/', type: FILE_TYPES.DIRECTORY, description: '中间件' },
      { path: 'src/public/', type: FILE_TYPES.DIRECTORY, description: '静态资源' },
      { path: 'src/public/index.html', type: FILE_TYPES.TEMPLATE, description: '首页模板' },
      { path: 'src/public/styles.css', type: FILE_TYPES.STYLE, description: '全局样式' },
      { path: 'src/public/app.js', type: FILE_TYPES.MODULE, description: '前端逻辑' },
      { path: 'test/', type: FILE_TYPES.DIRECTORY, description: '测试目录' },
      { path: 'package.json', type: FILE_TYPES.CONFIG, description: '项目配置' },
      { path: '.gitignore', type: FILE_TYPES.CONFIG, description: 'Git忽略规则' },
      { path: 'README.md', type: FILE_TYPES.DOCS, description: '项目说明' },
    ],
  },
  'node-api': {
    name: 'Node.js API',
    description: 'Node.js REST API项目',
    stack: ['node', 'javascript'],
    files: [
      { path: 'src/server.js', type: FILE_TYPES.ENTRY, description: 'API服务器' },
      { path: 'src/routes/', type: FILE_TYPES.DIRECTORY, description: '路由定义' },
      { path: 'src/controllers/', type: FILE_TYPES.DIRECTORY, description: '控制器' },
      { path: 'src/models/', type: FILE_TYPES.DIRECTORY, description: '数据模型' },
      { path: 'src/middleware/', type: FILE_TYPES.DIRECTORY, description: '中间件' },
      { path: 'src/utils/', type: FILE_TYPES.DIRECTORY, description: '工具函数' },
      { path: 'test/', type: FILE_TYPES.DIRECTORY, description: '测试目录' },
      { path: 'package.json', type: FILE_TYPES.CONFIG, description: '项目配置' },
      { path: '.gitignore', type: FILE_TYPES.CONFIG, description: 'Git忽略规则' },
      { path: 'README.md', type: FILE_TYPES.DOCS, description: '项目说明' },
    ],
  },
  'fullstack': {
    name: 'Full-Stack',
    description: '全栈Web应用项目',
    stack: ['node', 'javascript', 'html', 'css'],
    files: [
      { path: 'src/server.js', type: FILE_TYPES.ENTRY, description: '服务器入口' },
      { path: 'src/api/', type: FILE_TYPES.DIRECTORY, description: 'API路由' },
      { path: 'src/api/routes.js', type: FILE_TYPES.MODULE, description: 'API路由定义' },
      { path: 'src/db/', type: FILE_TYPES.DIRECTORY, description: '数据库模块' },
      { path: 'src/services/', type: FILE_TYPES.DIRECTORY, description: '业务逻辑' },
      { path: 'src/public/', type: FILE_TYPES.DIRECTORY, description: '前端资源' },
      { path: 'src/public/index.html', type: FILE_TYPES.TEMPLATE, description: '首页' },
      { path: 'src/public/css/', type: FILE_TYPES.DIRECTORY, description: '样式目录' },
      { path: 'src/public/js/', type: FILE_TYPES.DIRECTORY, description: '脚本目录' },
      { path: 'test/api/', type: FILE_TYPES.DIRECTORY, description: 'API测试' },
      { path: 'test/unit/', type: FILE_TYPES.DIRECTORY, description: '单元测试' },
      { path: 'package.json', type: FILE_TYPES.CONFIG, description: '项目配置' },
      { path: '.gitignore', type: FILE_TYPES.CONFIG, description: 'Git忽略规则' },
      { path: 'README.md', type: FILE_TYPES.DOCS, description: '项目说明' },
    ],
  },
  'library': {
    name: 'Library',
    description: 'Node.js库/包项目',
    stack: ['node', 'javascript'],
    files: [
      { path: 'src/index.js', type: FILE_TYPES.ENTRY, description: '库入口，导出公共API' },
      { path: 'src/core.js', type: FILE_TYPES.MODULE, description: '核心逻辑' },
      { path: 'src/utils/', type: FILE_TYPES.DIRECTORY, description: '工具函数' },
      { path: 'test/', type: FILE_TYPES.DIRECTORY, description: '测试目录' },
      { path: 'test/index.test.js', type: FILE_TYPES.TEST, description: '入口测试' },
      { path: 'package.json', type: FILE_TYPES.CONFIG, description: '项目配置' },
      { path: '.gitignore', type: FILE_TYPES.CONFIG, description: 'Git忽略规则' },
      { path: 'README.md', type: FILE_TYPES.DOCS, description: '项目说明' },
      { path: 'CHANGELOG.md', type: FILE_TYPES.DOCS, description: '变更日志' },
    ],
  },
  'pwa': {
    name: 'PWA',
    description: '渐进式Web应用项目',
    stack: ['html', 'css', 'javascript'],
    files: [
      { path: 'src/index.html', type: FILE_TYPES.ENTRY, description: '应用入口' },
      { path: 'src/css/', type: FILE_TYPES.DIRECTORY, description: '样式目录' },
      { path: 'src/js/', type: FILE_TYPES.DIRECTORY, description: '脚本目录' },
      { path: 'src/js/app.js', type: FILE_TYPES.MODULE, description: '应用主逻辑' },
      { path: 'src/sw.js', type: FILE_TYPES.MODULE, description: 'Service Worker' },
      { path: 'src/manifest.json', type: FILE_TYPES.CONFIG, description: 'PWA清单' },
      { path: 'src/icons/', type: FILE_TYPES.DIRECTORY, description: '应用图标' },
      { path: 'test/', type: FILE_TYPES.DIRECTORY, description: '测试目录' },
      { path: 'package.json', type: FILE_TYPES.CONFIG, description: '项目配置' },
      { path: '.gitignore', type: FILE_TYPES.CONFIG, description: 'Git忽略规则' },
      { path: 'README.md', type: FILE_TYPES.DOCS, description: '项目说明' },
    ],
  },
  'monorepo': {
    name: 'Monorepo',
    description: 'Monorepo多包项目',
    stack: ['node', 'javascript'],
    files: [
      { path: 'packages/', type: FILE_TYPES.DIRECTORY, description: '包目录' },
      { path: 'packages/core/', type: FILE_TYPES.DIRECTORY, description: '核心包' },
      { path: 'packages/core/src/index.js', type: FILE_TYPES.ENTRY, description: '核心包入口' },
      { path: 'packages/utils/', type: FILE_TYPES.DIRECTORY, description: '工具包' },
      { path: 'packages/utils/src/index.js', type: FILE_TYPES.ENTRY, description: '工具包入口' },
      { path: 'test/', type: FILE_TYPES.DIRECTORY, description: '集成测试' },
      { path: 'package.json', type: FILE_TYPES.CONFIG, description: '根项目配置' },
      { path: '.gitignore', type: FILE_TYPES.CONFIG, description: 'Git忽略规则' },
      { path: 'README.md', type: FILE_TYPES.DOCS, description: '项目说明' },
    ],
  },
  'custom': {
    name: 'Custom',
    description: '自定义项目结构',
    stack: [],
    files: [],
  },
};

/**
 * 技术栈关键词映射，用于从描述中检测技术栈
 * @type {Object.<string, string[]>}
 * @private
 */
const STACK_KEYWORDS = {
  node: ['node', 'nodejs', 'node.js', 'npm', 'express', 'koa', 'fastify', 'backend', '后端'],
  javascript: ['javascript', 'js', 'es6', 'es2020', 'vanilla'],
  html: ['html', 'html5', 'web', '前端', 'frontend', '页面'],
  css: ['css', 'css3', 'stylesheet', '样式', 'style', 'scss', 'sass', 'less'],
  python: ['python', 'py', 'django', 'flask', 'fastapi'],
  typescript: ['typescript', 'ts', 'tsc'],
  react: ['react', 'reactjs', 'jsx', 'tsx'],
  vue: ['vue', 'vuejs', 'vue.js'],
};

/**
 * 项目类型关键词映射，用于从描述中检测项目类型
 * @type {Object.<string, string[]>}
 * @private
 */
const TYPE_KEYWORDS = {
  'node-cli': ['cli', '命令行', 'command', 'terminal', '脚手架', 'scaffold', 'tool'],
  'node-web': ['web', '网站', 'website', '页面', 'page', 'frontend', '前端应用'],
  'node-api': ['api', 'rest', 'restful', '接口', 'endpoint', '服务端', 'server', 'backend'],
  'fullstack': ['fullstack', 'full-stack', '全栈', '前后端', 'monolith'],
  'library': ['library', 'lib', '包', 'package', 'npm包', 'sdk', '工具库'],
  'pwa': ['pwa', 'progressive', '离线', 'offline', 'service worker', '渐进式'],
  'monorepo': ['monorepo', '多包', 'multi-package', 'workspace', 'lerna'],
};

/**
 * 特性关键词映射，用于从描述中检测额外特性并生成对应文件
 * @type {Object.<string, Object>}
 * @private
 */
const FEATURE_KEYWORDS = {
  auth: {
    keywords: ['auth', '认证', '登录', 'login', 'jwt', 'token', 'session', 'oauth'],
    files: [
      { path: 'src/auth/', type: FILE_TYPES.DIRECTORY, description: '认证模块' },
      { path: 'src/auth/middleware.js', type: FILE_TYPES.MODULE, description: '认证中间件' },
      { path: 'src/auth/strategies/', type: FILE_TYPES.DIRECTORY, description: '认证策略' },
    ],
  },
  database: {
    keywords: ['database', '数据库', 'db', 'sql', 'sqlite', 'mongo', 'postgres', 'mysql'],
    files: [
      { path: 'src/db/', type: FILE_TYPES.DIRECTORY, description: '数据库模块' },
      { path: 'src/db/connection.js', type: FILE_TYPES.MODULE, description: '数据库连接' },
      { path: 'src/db/migrations/', type: FILE_TYPES.DIRECTORY, description: '数据库迁移' },
    ],
  },
  config: {
    keywords: ['config', '配置', 'env', '环境变量', 'dotenv', 'settings'],
    files: [
      { path: 'src/config/', type: FILE_TYPES.DIRECTORY, description: '配置模块' },
      { path: 'src/config/index.js', type: FILE_TYPES.MODULE, description: '配置加载' },
      { path: '.env.example', type: FILE_TYPES.CONFIG, description: '环境变量示例' },
    ],
  },
  logging: {
    keywords: ['log', '日志', 'logger', 'winston', 'pino', 'logging'],
    files: [
      { path: 'src/logger/', type: FILE_TYPES.DIRECTORY, description: '日志模块' },
      { path: 'src/logger/index.js', type: FILE_TYPES.MODULE, description: '日志配置' },
    ],
  },
  docker: {
    keywords: ['docker', '容器', 'container', 'deploy', '部署', 'devops'],
    files: [
      { path: 'Dockerfile', type: FILE_TYPES.CONFIG, description: 'Docker构建文件' },
      { path: 'docker-compose.yml', type: FILE_TYPES.CONFIG, description: 'Docker Compose配置' },
      { path: '.dockerignore', type: FILE_TYPES.CONFIG, description: 'Docker忽略规则' },
    ],
  },
};

/**
 * ProjectScaffolder — 项目脚手架生成器
 * @classdesc 项目脚手架（ProjectScaffolder）。项目结构生成、模板管理。
 * 融合Vibe Coding "PlanningWithFiles"技能核心能力，从需求描述自动生成项目文件结构。
 * 桥接Harness PhaseOrchestrator与Vibe Coding之间的能力缺口。
 *
 * @extends EventEmitter
 */
const MAX_SCAFFOLDS = 100;

class ProjectScaffolder extends EventEmitter {
  /**
   * 创建ProjectScaffolder实例
   * @param {Object} [options={}] - 配置选项
   * @param {string} [options.defaultStack='node'] - 默认技术栈
   * @param {number} [options.maxFiles=200] - 单次脚手架最大文件数
   * @param {number} [options.maxDepth=5] - 目录最大深度
   * @param {boolean} [options.includeReadme=true] - 是否包含README
   * @param {boolean} [options.includeGitignore=true] - 是否包含.gitignore
   * @param {boolean} [options.includePackageJson=true] - 是否包含package.json
   * @param {boolean} [options.dryRun=false] - 试运行模式（不实际创建文件）
   */
  constructor(options = {}) {
    super();
    /** @type {Object} 合并后的配置 */
    this._config = mergeConfig(DEFAULT_CONFIG, options);
    /** @type {Map<string, Object>} 已完成的脚手架记录 */
    this._scaffolds = new Map();
    /** @type {Object} 统计信息 */
    this._stats = {
      scaffoldsCreated: 0,
      filesGenerated: 0,
      templatesUsed: {},
    };
    /** @type {Object} 依赖注入状态 */
    this._attached = {
      goalExecutor: false,
      phaseOrchestrator: false,
    };
    /** @type {Object|null} GoalExecutor实例引用 */
    this._ge = null;
    /** @type {Object|null} PhaseOrchestrator实例引用 */
    this._po = null;
  }

  /**
   * 挂载GoalExecutor实例，用于脚手架生成过程中的目标管理
   * @param {Object} executor - GoalExecutor实例，需实现createGoal方法
   * @returns {ProjectScaffolder} 当前实例，支持链式调用
   */
  attachGoalExecutor(executor) {
    if (executor && typeof executor.createGoal === 'function') {
      this._ge = executor;
      this._attached.goalExecutor = true;
      debug('ProjectScaffolder', 'attachGoalExecutor', '已挂载GoalExecutor');
    }
    return this;
  }

  /**
   * 挂载PhaseOrchestrator实例，用于脚手架生成与开发阶段流程的衔接
   * @param {Object} orchestrator - PhaseOrchestrator实例，需实现getCurrentPhase方法
   * @returns {ProjectScaffolder} 当前实例，支持链式调用
   */
  attachPhaseOrchestrator(orchestrator) {
    if (orchestrator && typeof orchestrator.getCurrentPhase === 'function') {
      this._po = orchestrator;
      this._attached.phaseOrchestrator = true;
      debug('ProjectScaffolder', 'attachPhaseOrchestrator', '已挂载PhaseOrchestrator');
    }
    return this;
  }

  /**
   * 列出所有可用的项目模板
   * @returns {Array<{id: string, name: string, description: string, stack: string[], fileCount: number}>} 模板列表
   */
  listTemplates() {
    this.guardShutdown();
    return Object.entries(PRESET_TEMPLATES).map(function(entry) {
      const id = entry[0];
      const t = entry[1];
      return {
        id: id,
        name: t.name,
        description: t.description,
        stack: t.stack,
        fileCount: t.files.length,
      };
    });
  }

  /**
   * 获取指定模板的完整定义
   * @param {string} templateId - 模板标识符
   * @returns {Object|null} 模板定义对象，不存在时返回null
   */
  getTemplate(templateId) {
    this.guardShutdown();
    return PRESET_TEMPLATES[templateId] ?? null;
  }

  /**
   * 从模板生成项目文件结构
   * @param {string} templateId - 模板标识符
   * @param {Object} [options={}] - 生成选项
   * @param {string} [options.outputDir] - 输出目录，默认process.cwd()
   * @param {Array<Object>} [options.customFiles] - 自定义文件列表，与模板文件合并
   * @param {string} [options.projectName] - 项目名称
   * @returns {Promise<Object>} 脚手架结果 { scaffoldId, templateId, outputDir, files, stats }
   * @fires ProjectScaffolder#scaffold-completed
   * @fires ProjectScaffolder#scaffold-failed
   */
  async scaffold(templateId, options = {}) {
    this.guardShutdown();

    // 验证模板标识符
    if (!PRESET_TEMPLATES[templateId]) {
      const err = new Error('未知模板: ' + templateId);
      emitError(this, 'scaffold-failed', err, { templateId: templateId });
      throw err;
    }

    const template = PRESET_TEMPLATES[templateId];
    const outputDir = options.outputDir || process.cwd();
    if (typeof outputDir !== 'string' || outputDir.length === 0) {
      throw new Error('outputDir must be a non-empty string');
    }
    if (outputDir.indexOf('\0') >= 0) {
      throw new Error('outputDir contains null bytes');
    }
    const projectName = options.projectName || path.basename(outputDir);

    // 合并自定义文件到模板文件
    const files = this._mergeFiles(template.files, options.customFiles);

    // 验证文件约束
    this._validateFiles(files, templateId);

    const scaffoldId = generateId('scaffold');
    const createdFiles = [];
    const dryRun = this._config.dryRun;

    debug('ProjectScaffolder', 'scaffold', '开始生成脚手架: ' + templateId + (dryRun ? ' (试运行)' : ''));

    // 如果挂载了GoalExecutor，创建脚手架目标
    if (this._ge) {
      try {
        this._ge.createGoal('scaffold:' + templateId + ':' + scaffoldId);
      } catch (err) {
        debug('ProjectScaffolder', 'createGoal', err);
        // 目标创建失败不阻塞脚手架流程，仅发出事件通知上层追踪
        this.emit('goal-creation-failed', { templateId, scaffoldId, error: err && err.message ? err.message : String(err) });
      }
    }

    // 逐个创建文件和目录
    this._createTemplateFiles(files, outputDir, templateId, dryRun, createdFiles);

    // 生成可选的标准文件（README、.gitignore、package.json）
    this._createOptionalFiles(files, outputDir, template, scaffoldId, projectName, dryRun, createdFiles);

    // 记录脚手架结果并更新统计
    this._recordScaffold(scaffoldId, templateId, outputDir, projectName, createdFiles, dryRun);

    const actualFileCount = createdFiles.filter(function(f) { return f.created; }).length;

    /**
     * 脚手架生成完成事件
     * @event ProjectScaffolder#scaffold-completed
     * @type {Object}
     * @property {string} templateId - 使用的模板标识符
     * @property {string} outputDir - 输出目录
     * @property {number} fileCount - 实际创建的文件数
     */
    this.emit('scaffold-completed', {
      scaffoldId: scaffoldId,
      templateId: templateId,
      outputDir: outputDir,
      fileCount: actualFileCount,
    });

    debug('ProjectScaffolder', 'scaffold', '脚手架生成完成: ' + templateId + ', 文件数=' + actualFileCount);

    return {
      scaffoldId: scaffoldId,
      templateId: templateId,
      outputDir: outputDir,
      files: createdFiles,
      stats: this.getStats(),
    };
  }

  /**
   * 合并模板文件与自定义文件
   * @param {Array<Object>} templateFiles - 模板文件列表
   * @param {Array<Object>} [customFiles] - 自定义文件列表
   * @returns {Array<Object>} 合并后的文件列表
   * @private
   */
  _mergeFiles(templateFiles, customFiles) {
    let files = templateFiles.slice();
    if (Array.isArray(customFiles) && customFiles.length > 0) {
      files = files.concat(customFiles);
    }
    return files;
  }

  /**
   * 验证文件列表的约束条件（数量上限和目录深度）
   * @param {Array<Object>} files - 文件列表
   * @param {string} templateId - 模板标识符
   * @throws {Error} 文件数量或深度超限时抛出
   * @private
   */
  _validateFiles(files, templateId) {
    if (files.length > this._config.maxFiles) {
      const err = new Error('文件数量超过上限: ' + files.length + ' > ' + this._config.maxFiles);
      emitError(this, 'scaffold-failed', err, { templateId: templateId, fileCount: files.length });
      throw err;
    }
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i].path;
      if (filePath.indexOf('..') >= 0 || filePath.indexOf('\0') >= 0 || path.isAbsolute(filePath)) {
        const err = new Error('文件路径不安全: ' + filePath + ' (禁止包含..、空字节或绝对路径)');
        emitError(this, 'scaffold-failed', err, { templateId: templateId, path: filePath });
        throw err;
      }
      const depth = filePath.split('/').length - 1;
      if (depth > this._config.maxDepth) {
        const err = new Error('目录深度超过上限: ' + filePath + ' (深度=' + depth + ')');
        emitError(this, 'scaffold-failed', err, { templateId: templateId, path: filePath });
        throw err;
      }
    }
  }

  /**
   * 创建模板中定义的文件和目录
   * @param {Array<Object>} files - 文件列表
   * @param {string} outputDir - 输出目录
   * @param {string} templateId - 模板标识符
   * @param {boolean} dryRun - 是否试运行
   * @param {Array<Object>} createdFiles - 已创建文件列表（就地追加）
   * @private
   */
  _createTemplateFiles(files, outputDir, templateId, dryRun, createdFiles) {
    for (let i = 0; i < files.length; i++) {
      const fileEntry = files[i];
      const fullPath = path.resolve(outputDir, fileEntry.path);

      // 路径遍历防护：确保解析后的路径仍在输出目录内
      if (!fullPath.startsWith(path.resolve(outputDir) + path.sep) && fullPath !== path.resolve(outputDir)) {
        debug('ProjectScaffolder', 'pathTraversal', 'Skipping path outside output dir: ' + fileEntry.path);
        continue;
      }

      if (dryRun) {
        createdFiles.push({ path: fileEntry.path, type: fileEntry.type, created: false });
        continue;
      }

      try {
        if (fileEntry.type === FILE_TYPES.DIRECTORY) {
          ensureDirSync(fullPath);
          createdFiles.push({ path: fileEntry.path, type: fileEntry.type, created: true });
        } else {
          const parentDir = path.dirname(fullPath);
          ensureDirSync(parentDir);
          const content = this._generateFileContent(fileEntry, templateId);
          fs.writeFileSync(fullPath, content, 'utf8');
          createdFiles.push({ path: fileEntry.path, type: fileEntry.type, created: true });
        }
      } catch (writeErr) {
        debug('ProjectScaffolder', 'scaffold:write', '写入失败: ' + fileEntry.path + ' - ' + writeErr.message);
        createdFiles.push({ path: fileEntry.path, type: fileEntry.type, created: false, error: writeErr.message });
      }
    }
  }

  /**
   * 创建可选的标准文件（README、.gitignore、package.json）
   * 仅在模板文件中未包含且配置允许时生成
   * @param {Array<Object>} files - 模板文件列表
   * @param {string} outputDir - 输出目录
   * @param {Object} template - 模板定义
   * @param {string} scaffoldId - 脚手架标识符
   * @param {string} projectName - 项目名称
   * @param {boolean} dryRun - 是否试运行
   * @param {Array<Object>} createdFiles - 已创建文件列表（就地追加）
   * @private
   */
  _createOptionalFiles(files, outputDir, template, scaffoldId, projectName, dryRun, createdFiles) {
    const existingPaths = new Set(files.map(function(f) { return f.path; }));

    // 生成README.md
    if (this._config.includeReadme && !existingPaths.has('README.md')) {
      this._writeOptionalFile(
        outputDir, 'README.md', FILE_TYPES.DOCS,
        this._generateReadme(template, scaffoldId, projectName),
        dryRun, createdFiles, 'scaffold:readme',
      );
    }

    // 生成.gitignore
    if (this._config.includeGitignore && !existingPaths.has('.gitignore')) {
      this._writeOptionalFile(
        outputDir, '.gitignore', FILE_TYPES.CONFIG,
        this._generateGitignore(),
        dryRun, createdFiles, 'scaffold:gitignore',
      );
    }

    // 生成package.json
    if (this._config.includePackageJson && !existingPaths.has('package.json')) {
      this._writeOptionalFile(
        outputDir, 'package.json', FILE_TYPES.CONFIG,
        this._generatePackageJson(template, projectName),
        dryRun, createdFiles, 'scaffold:packageJson',
      );
    }
  }

  /**
   * 写入单个可选文件，处理试运行和异常
   * @param {string} outputDir - 输出目录
   * @param {string} fileName - 文件名
   * @param {string} fileType - 文件类型
   * @param {string} content - 文件内容
   * @param {boolean} dryRun - 是否试运行
   * @param {Array<Object>} createdFiles - 已创建文件列表
   * @param {string} debugLabel - 调试标签
   * @private
   */
  _writeOptionalFile(outputDir, fileName, fileType, content, dryRun, createdFiles, debugLabel) {
    const fullPath = path.resolve(outputDir, fileName);
    if (dryRun) {
      createdFiles.push({ path: fileName, type: fileType, created: false });
      return;
    }
    try {
      fs.writeFileSync(fullPath, content, 'utf8');
      createdFiles.push({ path: fileName, type: fileType, created: true });
    } catch (writeErr) {
      debug('ProjectScaffolder', debugLabel, fileName + '写入失败: ' + writeErr.message);
    }
  }

  /**
   * 记录脚手架结果并更新统计信息
   * @param {string} scaffoldId - 脚手架标识符
   * @param {string} templateId - 模板标识符
   * @param {string} outputDir - 输出目录
   * @param {string} projectName - 项目名称
   * @param {Array<Object>} createdFiles - 已创建文件列表
   * @param {boolean} dryRun - 是否试运行
   * @private
   */
  _recordScaffold(scaffoldId, templateId, outputDir, projectName, createdFiles, dryRun) {
    const scaffoldRecord = {
      scaffoldId: scaffoldId,
      templateId: templateId,
      outputDir: outputDir,
      projectName: projectName,
      files: createdFiles,
      createdAt: new Date().toISOString(),
      dryRun: dryRun,
    };
    if (this._scaffolds.size >= MAX_SCAFFOLDS && !this._scaffolds.has(scaffoldId)) {
      const oldestKey = this._scaffolds.keys().next().value;
      this._scaffolds.delete(oldestKey);
    }
    this._scaffolds.set(scaffoldId, scaffoldRecord);

    this._stats.scaffoldsCreated++;
    this._stats.filesGenerated += createdFiles.filter(function(f) { return f.created; }).length;
    if (!this._stats.templatesUsed[templateId]) {
      this._stats.templatesUsed[templateId] = 0;
    }
    this._stats.templatesUsed[templateId]++;
  }

  /**
   * 从自然语言描述生成项目结构（PlanningWithFiles核心能力）
   * 解析描述中的技术栈、项目类型和特性关键词，自动匹配最佳模板并生成额外文件。
   *
   * @param {string} description - 自然语言需求描述
   * @param {Object} [options={}] - 生成选项（同scaffold方法）
   * @returns {Promise<Object>} 脚手架结果 { scaffoldId, templateId, outputDir, files, stats, detectedFeatures }
   * @fires ProjectScaffolder#scaffold-completed
   * @fires ProjectScaffolder#scaffold-failed
   * @example
   * const result = await scaffolder.scaffoldFromDescription(
   *   '一个Node.js REST API项目，需要用户认证和数据库模块',
   *   { outputDir: '/project/my-api' }
   * );
   */
  async scaffoldFromDescription(description, options = {}) {
    this.guardShutdown();

    if (!description || typeof description !== 'string') {
      const err = new Error('需求描述不能为空');
      emitError(this, 'scaffold-failed', err, {});
      throw err;
    }

    debug('ProjectScaffolder', 'scaffoldFromDescription', '解析需求描述: ' + description.substring(0, 100));

    // 匹配最佳模板
    const matchedTemplateId = this._matchTemplate(description);
    debug('ProjectScaffolder', 'scaffoldFromDescription', '匹配模板: ' + matchedTemplateId);

    // 检测特性关键词，生成额外文件
    const detectedFeatures = [];
    const customFiles = [];
    const lowerDesc = description.toLowerCase();

    const featureKeys = Object.keys(FEATURE_KEYWORDS);
    for (let i = 0; i < featureKeys.length; i++) {
      const featureKey = featureKeys[i];
      const feature = FEATURE_KEYWORDS[featureKey];
      let matched = false;
      for (let j = 0; j < feature.keywords.length; j++) {
        if (lowerDesc.includes(feature.keywords[j])) {
          matched = true;
          break;
        }
      }
      if (matched) {
        detectedFeatures.push(featureKey);
        for (let k = 0; k < feature.files.length; k++) {
          customFiles.push(feature.files[k]);
        }
      }
    }

    // 去重自定义文件（避免与模板文件重复）
    const templateFiles = PRESET_TEMPLATES[matchedTemplateId].files;
    const templatePaths = new Set(templateFiles.map(function(f) { return f.path; }));
    const uniqueCustomFiles = customFiles.filter(function(f) {
      return !templatePaths.has(f.path);
    });

    debug('ProjectScaffolder', 'scaffoldFromDescription', '检测到特性: ' + detectedFeatures.join(', ') + ', 额外文件: ' + uniqueCustomFiles.length);

    // 调用scaffold生成项目
    const result = await this.scaffold(matchedTemplateId, {
      ...options,
      customFiles: uniqueCustomFiles,
    });

    // 附加检测到的特性信息
    result.detectedFeatures = detectedFeatures;
    result.matchedTemplateId = matchedTemplateId;

    return result;
  }

  /**
   * 从描述文本匹配最佳模板
   * 通过关键词评分机制，对每个模板计算匹配分数，返回最高分模板。
   *
   * @param {string} description - 需求描述文本
   * @returns {string} 匹配的模板标识符，默认返回'node-cli'
   * @private
   */
  _matchTemplate(description) {
    const lowerDesc = description.toLowerCase();
    let bestScore = -1;
    let bestTemplateId = 'node-cli'; // 默认模板

    const templateIds = Object.keys(TYPE_KEYWORDS);
    for (let i = 0; i < templateIds.length; i++) {
      const templateId = templateIds[i];
      const keywords = TYPE_KEYWORDS[templateId];
      let score = 0;

      // 项目类型关键词匹配
      for (let j = 0; j < keywords.length; j++) {
        if (lowerDesc.includes(keywords[j])) {
          score += 2; // 类型关键词权重更高
        }
      }

      // 技术栈关键词匹配
      const template = PRESET_TEMPLATES[templateId];
      if (template && template.stack) {
        for (let j = 0; j < template.stack.length; j++) {
          const stackKey = template.stack[j];
          const stackKws = STACK_KEYWORDS[stackKey];
          if (stackKws) {
            for (let k = 0; k < stackKws.length; k++) {
              if (lowerDesc.includes(stackKws[k])) {
                score += 1;
              }
            }
          }
        }
      }

      // 模板描述关键词匹配
      if (template && template.description) {
        const descWords = template.description.toLowerCase().split(/\s+/);
        for (let j = 0; j < descWords.length; j++) {
          if (lowerDesc.includes(descWords[j]) && descWords[j].length > 1) {
            score += 1;
          }
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestTemplateId = templateId;
      }
    }

    return bestTemplateId;
  }

  /**
   * 根据文件条目生成样板内容
   * 不同文件类型生成不同的初始内容，为开发者提供合理的起始代码。
   *
   * @param {Object} fileEntry - 文件条目 { path, type, description }
   * @param {string} templateId - 模板标识符，用于生成上下文相关内容
   * @returns {string} 生成的文件内容
   * @private
   */
  _generateFileContent(fileEntry, templateId) {
    const template = PRESET_TEMPLATES[templateId] ?? {};
    const desc = fileEntry.description || '';

    switch (fileEntry.type) {
      case FILE_TYPES.ENTRY:
        return '\'use strict\';\n\n// ' + desc + '\n\n';

      case FILE_TYPES.MODULE:
        return '\'use strict\';\n\n// ' + desc + '\n\nmodule.exports = {};\n';

      case FILE_TYPES.TEST:
        return "'use strict';\n\nconst { describe, it } = require('node:test');\nconst assert = require('node:assert/strict');\n\ndescribe('" + desc + "', () => {\n  it('should work', () => {\n    assert.ok(true);\n  });\n});\n";

      case FILE_TYPES.CONFIG:
        return this._generateConfigContent(fileEntry, templateId);

      case FILE_TYPES.DOCS:
        return this._generateDocsContent(fileEntry, template);

      case FILE_TYPES.STYLE:
        return '/* ' + desc + ' */\n';

      case FILE_TYPES.TEMPLATE:
        return this._generateTemplateContent(fileEntry);

      case FILE_TYPES.DIRECTORY:
        // 目录类型不生成内容
        return '';

      default:
        return '// ' + desc + '\n';
    }
  }

  /**
   * 生成配置文件内容
   * @param {Object} fileEntry - 文件条目
   * @param {string} templateId - 模板标识符
   * @returns {string} 配置文件内容
   * @private
   */
  _generateConfigContent(fileEntry, templateId) {
    const basename = path.basename(fileEntry.path);

    if (basename === 'package.json') {
      return this._generatePackageJson(PRESET_TEMPLATES[templateId] ?? {}, 'my-project');
    }
    if (basename === '.gitignore') {
      return this._generateGitignore();
    }
    if (basename === '.env.example') {
      return '# 环境变量配置\n# 复制此文件为.env并填入实际值\n\nNODE_ENV=development\nPORT=3000\n';
    }
    if (basename === 'Dockerfile') {
      return 'FROM node:20-alpine\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --only=production\nCOPY . .\nEXPOSE 3000\nCMD ["node", "src/index.js"]\n';
    }
    if (basename === 'docker-compose.yml') {
      return 'version: "3.8"\nservices:\n  app:\n    build: .\n    ports:\n      - "3000:3000"\n    environment:\n      - NODE_ENV=development\n';
    }
    if (basename === '.dockerignore') {
      return 'node_modules\nnpm-debug.log\nDockerfile\ndocker-compose.yml\n.git\n.env\n';
    }
    if (basename === 'manifest.json') {
      return JSON.stringify({
        name: 'My PWA',
        short_name: 'PWA',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#000000',
        icons: [],
      }, null, 2) + '\n';
    }
    // 通用配置文件
    return '// ' + (fileEntry.description || '配置文件') + '\nmodule.exports = {};\n';
  }

  /**
   * 生成文档文件内容
   * @param {Object} fileEntry - 文件条目
   * @param {Object} template - 模板定义
   * @returns {string} 文档内容
   * @private
   */
  _generateDocsContent(fileEntry, template) {
    const basename = path.basename(fileEntry.path);
    const name = (template && template.name) || 'Project';

    if (basename === 'README.md') {
      return this._generateReadme(template, '', name);
    }
    if (basename === 'CHANGELOG.md') {
      return '# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n## [Unreleased]\n';
    }
    return '# ' + (fileEntry.description || name) + '\n';
  }

  /**
   * 生成HTML模板文件内容
   * @param {Object} fileEntry - 文件条目
   * @returns {string} HTML内容
   * @private
   */
  _generateTemplateContent(fileEntry) {
    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>' + (fileEntry.description || 'App') + '</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <div id="app"></div>\n  <script src="app.js"></script>\n</body>\n</html>\n';
  }

  /**
   * 生成README.md内容
   * @param {Object} template - 模板定义
   * @param {string} scaffoldId - 脚手架标识符
   * @param {string} [projectName] - 项目名称
   * @returns {string} README内容
   * @private
   */
  _generateReadme(template, scaffoldId, projectName) {
    const name = projectName || (template && template.name) || 'Project';
    const desc = (template && template.description) || '';
    const stack = (template && template.stack) ?? [];

    let content = '# ' + name + '\n\n';
    if (desc) {
      content += desc + '\n\n';
    }
    content += '## 技术栈\n\n';
    if (stack.length > 0) {
      content += stack.map(function(s) { return '- ' + s; }).join('\n') + '\n\n';
    } else {
      content += '- Node.js\n\n';
    }
    content += '## 快速开始\n\n';
    content += '```bash\nnpm install\nnpm start\n```\n\n';
    content += '## 项目结构\n\n';
    content += '```\n' + name + '/\n';
    if (template && template.files) {
      for (let i = 0; i < template.files.length; i++) {
        const f = template.files[i];
        const indent = '  ' + '  '.repeat(Math.max(0, f.path.split('/').length - 1));
        content += indent + f.path + (f.description ? '  # ' + f.description : '') + '\n';
      }
    }
    content += '```\n\n';
    content += '## 许可证\n\nMIT\n';
    if (scaffoldId) {
      content += '\n<!-- scaffold-id: ' + scaffoldId + ' -->\n';
    }
    return content;
  }

  /**
   * 生成.gitignore内容
   * @returns {string} .gitignore内容
   * @private
   */
  _generateGitignore() {
    return 'node_modules/\ndist/\nbuild/\n.env\n*.log\n.DS_Store\ncoverage/\n.nyc_output/\n';
  }

  /**
   * 生成package.json内容
   * @param {Object} template - 模板定义
   * @param {string} [projectName] - 项目名称
   * @returns {string} package.json内容
   * @private
   */
  _generatePackageJson(template, projectName) {
    const name = projectName || 'my-project';
    const pkg = {
      name: name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      version: '1.0.0',
      description: (template && template.description) || '',
      main: 'src/index.js',
      scripts: {
        start: 'node src/index.js',
        test: 'node --test test/',
      },
      keywords: [],
      license: 'MIT',
    };

    // 根据技术栈添加依赖
    if (template && template.stack) {
      if (template.stack.indexOf('node') !== -1) {
        pkg.engines = { node: '>=18.0.0' };
      }
    }

    return JSON.stringify(pkg, null, 2) + '\n';
  }

  /**
   * 获取指定脚手架记录
   * @param {string} scaffoldId - 脚手架标识符
   * @returns {Object|null} 脚手架记录，不存在时返回null
   */
  getScaffold(scaffoldId) {
    this.guardShutdown();
    const scaffold = this._scaffolds.get(scaffoldId); return scaffold ? { ...scaffold, files: scaffold.files ? [...scaffold.files] : [] } : null;
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息 { scaffoldsCreated, filesGenerated, templatesUsed }
   */
  getStats() {
    this.guardShutdown();
    return {
      scaffoldsCreated: this._stats.scaffoldsCreated,
      filesGenerated: this._stats.filesGenerated,
      templatesUsed: { ...this._stats.templatesUsed },
    };
  }

  /**
   * 关闭脚手架生成器，清理内部状态
   * 由withShutdown混入调用
   * @private
   */
  _onShutdown() {
    this._scaffolds.clear();
    this._ge = null;
    this._po = null;
    this._attached = { goalExecutor: false, phaseOrchestrator: false };
    this.removeAllListeners();
    debug('ProjectScaffolder', 'shutdown', '脚手架生成器已关闭');
  }
}

// 静态属性挂载
ProjectScaffolder.PRESET_TEMPLATES = PRESET_TEMPLATES;
ProjectScaffolder.FILE_TYPES = FILE_TYPES;
ProjectScaffolder.DEFAULT_CONFIG = DEFAULT_CONFIG;

module.exports = withShutdown(ProjectScaffolder);
