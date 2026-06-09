'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const { withShutdown } = require('../../utils/shutdown-mixin');
const { safeExecute } = require('../../utils/safe-execute');
const { mergeConfig } = require('../../utils/safe-assign');
const BoundedMap = require('../../utils/bounded-map');

const JS_FUNCTION_PATTERN = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\([^)]*\)\s*=>|(?:async\s+)?\([^)]*\)\s*=>)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\w+\.bind|(\w+)\s*\([^)]*\)\s*\{)/g;
const JS_CLASS_PATTERN = /class\s+(\w+)(?:\s+extends\s+\w+)?\s*\{/g;
const JS_IMPORT_PATTERN = /(?:import\s+.*?(?:from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const JS_EXPORT_PATTERN = /(?:export\s+(?:default\s+)?(?:const|let|var|function|class|async\s+function)\s+(\w+)|module\.exports\s*=\s*(\w+)|exports\.(\w+)\s*=)/g;
const JS_CALL_PATTERN = /(\w+)\s*\(/g;

const PY_FUNCTION_PATTERN = /def\s+(\w+)\s*\(/g;
const PY_CLASS_PATTERN = /class\s+(\w+)/g;
const PY_IMPORT_PATTERN = /(?:import\s+(\w+)|from\s+([\w.]+)\s+import)/g;

const DEFAULT_CONFIG = {
  maxCacheSize: 200,
  maxParseBatchSize: 50,
};

/**
 * @module runtime/graphify/ast-parser
 * @classdesc AST解析器。tree-sitter可选+regex降级，支持JS/TS/Python
 */
class AstParser extends EventEmitter {
  constructor(config) {
    super();
    this._config = mergeConfig(DEFAULT_CONFIG, config);
    this._treeSitterAvailable = false;
    this._TreeSitter = null;
    this._parsers = new Map();
    this._cache = new BoundedMap(this._config.maxCacheSize);
    this._initTreeSitter();
  }

  _initTreeSitter() {
    try {
      this._TreeSitter = require('tree-sitter');
      this._treeSitterAvailable = true;
    } catch (_e) {
      this._treeSitterAvailable = false;
    }
  }

  /**
   * 获取tree-sitter是否可用
   * @type {boolean}
   */
  get isTreeSitterAvailable() {
    return this._treeSitterAvailable;
  }

  /**
   * 解析单个文件，优先使用tree-sitter，不可用时降级为正则提取
   * @param {string} filePath - 文件路径
   * @param {string} [content] - 文件内容
   * @returns {{ functions: Array<Object>, classes: Array<Object>, imports: Array<Object>, exports: Array<Object>, calls: Array<Object>, filePath: string, parser: string }} 解析结果
   */
  async parseFile(filePath, content) {
    this.guardShutdown();
    if (!filePath || typeof filePath !== 'string') return { functions: [], classes: [], imports: [], exports: [], calls: [], filePath: filePath || '', parser: 'none' };
    if (content == null || typeof content !== 'string') content = '';

    const cacheKey = filePath + ':' + content.length;
    const cached = this._cache.get(cacheKey);
    if (cached) return cached;

    const ext = path.extname(filePath).toLowerCase();
    let result;

    if (this._treeSitterAvailable && this._isAstExtension(ext)) {
      result = await safeExecute(
        () => this._parseWithTreeSitter(filePath, content, ext),
        'AstParser', 'parseWithTreeSitter',
        () => this._parseWithRegex(filePath, content, ext),
      );
    } else {
      result = this._parseWithRegex(filePath, content, ext);
    }

    if (typeof result === 'object' && result !== null) {
      result.filePath = filePath;
      this._cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * 批量解析多个文件
   * @param {Array<{ filePath: string, content?: string }>} files - 待解析的文件列表
   * @returns {Map<string, Object>} 文件路径到解析结果的映射
   */
  async parseBatch(files) {
    this.guardShutdown();
    if (!Array.isArray(files)) return new Map();

    const results = new Map();
    const batch = files.slice(0, this._config.maxParseBatchSize);

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (!item || !item.filePath) continue;
      const content = item.content ?? '';
      const parsed = await this.parseFile(item.filePath, content);
      results.set(item.filePath, parsed);
    }

    return results;
  }

  _isAstExtension(ext) {
    return ext === '.js' || ext === '.jsx' || ext === '.ts' || ext === '.tsx' || ext === '.mjs' || ext === '.cjs' || ext === '.py';
  }

  _parseWithTreeSitter(filePath, content, ext) {
    const langName = this._getLanguageName(ext);
    if (!langName) return this._parseWithRegex(filePath, content, ext);

    let ParserClass;
    try {
      const langModule = require('tree-sitter-' + langName);
      ParserClass = langModule;
    } catch (_e) {
      return this._parseWithRegex(filePath, content, ext);
    }

    const parser = new this._TreeSitter();
    try {
      parser.setLanguage(ParserClass);
    } catch (_e) {
      return this._parseWithRegex(filePath, content, ext);
    }

    const tree = parser.parse(content || '');
    const result = this._extractFromTree(tree, content);

    return { ...result, parser: 'tree-sitter' };
  }

  _getLanguageName(ext) {
    if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
    if (ext === '.ts' || ext === '.tsx') return 'typescript';
    if (ext === '.py') return 'python';
    return null;
  }

  _extractFromTree(tree, _content) {
    const functions = [];
    const classes = [];
    const imports = [];
    const exports = [];
    const calls = [];

    const walk = (node) => {
      if (!node) return;
      this._extractFunctionNode(node, functions);
      this._extractClassNode(node, classes);
      this._extractImportNode(node, imports);
      this._extractExportNode(node, exports);
      this._extractCallNode(node, calls);
      if (node.children) {
        for (let i = 0; i < node.children.length; i++) {
          walk(node.children[i]);
        }
      }
    };

    if (tree && tree.rootNode) walk(tree.rootNode);

    return { functions, classes, imports, exports, calls };
  }

  _extractFunctionNode(node, functions) {
    if (node.type === 'function_declaration' || node.type === 'function' || node.type === 'arrow_function' || node.type === 'method_definition' || node.type === 'method_declaration') {
      const nameNode = node.childForFieldName && node.childForFieldName('name');
      if (nameNode) {
        functions.push({ name: nameNode.text, startRow: node.startPosition ? node.startPosition.row : 0, endRow: node.endPosition ? node.endPosition.row : 0 });
      }
    }
  }

  _extractClassNode(node, classes) {
    if (node.type === 'class_declaration' || node.type === 'class_definition') {
      const nameNode = node.childForFieldName && node.childForFieldName('name');
      if (nameNode) {
        classes.push({ name: nameNode.text, startRow: node.startPosition ? node.startPosition.row : 0, endRow: node.endPosition ? node.endPosition.row : 0 });
      }
    }
  }

  _extractImportNode(node, imports) {
    if (node.type === 'import_statement' || node.type === 'import_declaration' || node.type === 'import_from_statement') {
      const sourceNode = node.childForFieldName && node.childForFieldName('source');
      if (sourceNode) {
        imports.push({ source: sourceNode.text, type: 'import' });
      }
    }
  }

  _extractExportNode(node, exports) {
    if (node.type === 'export_statement' || node.type === 'export_default_declaration' || node.type === 'export_named_declaration') {
      const declNode = node.childForFieldName && node.childForFieldName('declaration');
      if (declNode) {
        const nameNode = declNode.childForFieldName && declNode.childForFieldName('name');
        if (nameNode) {
          exports.push({ name: nameNode.text, type: 'export' });
        }
      }
    }
  }

  _extractCallNode(node, calls) {
    if (node.type === 'call_expression') {
      const funcNode = node.childForFieldName && node.childForFieldName('function');
      if (funcNode) {
        calls.push({ name: funcNode.text, startRow: node.startPosition ? node.startPosition.row : 0 });
      }
    }
  }

  _parseWithRegex(filePath, content, ext) {
    if (ext === '.py') return this._parsePythonWithRegex(filePath, content);
    return this._parseJavaScriptWithRegex(filePath, content);
  }

  _parseJavaScriptWithRegex(filePath, content) {
    const functions = [];
    const classes = [];
    const imports = [];
    const exports = [];
    const calls = [];

    let match;
    const funcRegex = new RegExp(JS_FUNCTION_PATTERN.source, JS_FUNCTION_PATTERN.flags);
    while ((match = funcRegex.exec(content)) !== null) {
      const name = match[1] || match[2] || match[3] || match[4] || '';
      if (name && !this._isKeyword(name)) {
        functions.push({ name, startRow: this._getLineNumber(content, match.index), endRow: 0 });
      }
    }

    const classRegex = new RegExp(JS_CLASS_PATTERN.source, JS_CLASS_PATTERN.flags);
    while ((match = classRegex.exec(content)) !== null) {
      classes.push({ name: match[1], startRow: this._getLineNumber(content, match.index), endRow: 0 });
    }

    const importRegex = new RegExp(JS_IMPORT_PATTERN.source, JS_IMPORT_PATTERN.flags);
    while ((match = importRegex.exec(content)) !== null) {
      imports.push({ source: match[1] || match[2] || '', type: 'import' });
    }

    const exportRegex = new RegExp(JS_EXPORT_PATTERN.source, JS_EXPORT_PATTERN.flags);
    while ((match = exportRegex.exec(content)) !== null) {
      exports.push({ name: match[1] || match[2] || match[3] || '', type: 'export' });
    }

    const callRegex = new RegExp(JS_CALL_PATTERN.source, JS_CALL_PATTERN.flags);
    while ((match = callRegex.exec(content)) !== null) {
      if (!this._isKeyword(match[1]) && !this._isBuiltin(match[1])) {
        calls.push({ name: match[1], startRow: this._getLineNumber(content, match.index) });
      }
    }

    return { functions, classes, imports, exports, calls, filePath, parser: 'regex' };
  }

  _parsePythonWithRegex(filePath, content) {
    const functions = [];
    const classes = [];
    const imports = [];
    const exports = [];
    const calls = [];

    let match;
    const funcRegex = new RegExp(PY_FUNCTION_PATTERN.source, PY_FUNCTION_PATTERN.flags);
    while ((match = funcRegex.exec(content)) !== null) {
      if (match[1].charAt(0) !== '_') {
        functions.push({ name: match[1], startRow: this._getLineNumber(content, match.index), endRow: 0 });
      }
    }

    const classRegex = new RegExp(PY_CLASS_PATTERN.source, PY_CLASS_PATTERN.flags);
    while ((match = classRegex.exec(content)) !== null) {
      classes.push({ name: match[1], startRow: this._getLineNumber(content, match.index), endRow: 0 });
    }

    const importRegex = new RegExp(PY_IMPORT_PATTERN.source, PY_IMPORT_PATTERN.flags);
    while ((match = importRegex.exec(content)) !== null) {
      imports.push({ source: match[1] || match[2] || '', type: 'import' });
    }

    return { functions, classes, imports, exports, calls, filePath, parser: 'regex' };
  }

  _getLineNumber(content, index) {
    if (index <= 0) return 0;
    let count = 0;
    for (let i = 0; i < index && i < content.length; i++) {
      if (content.charAt(i) === '\n') count++;
    }
    return count;
  }

  _isKeyword(name) {
    const keywords = ['if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'instanceof', 'void', 'class', 'extends', 'super', 'import', 'export', 'default', 'from', 'async', 'await', 'yield', 'const', 'let', 'var', 'function', 'def', 'with'];
    return keywords.indexOf(name) >= 0;
  }

  _isBuiltin(name) {
    const builtins = ['console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'Map', 'Set', 'Promise', 'Error', 'Date', 'RegExp', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'undefined', 'null', 'true', 'false', 'require', 'module', 'exports', 'process', 'Buffer', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'tuple', 'set', 'type', 'isinstance', 'self', 'cls'];
    return builtins.includes(name);
  }

  /**
   * 清空解析缓存
   */
  clearCache() {
    this._cache.clear();
  }

  _onShutdown() {
    this._cache.clear();
    this._parsers.clear();
    this._TreeSitter = null;
    this._treeSitterAvailable = false;
    this.removeAllListeners();
  }
}

module.exports = withShutdown(AstParser);
