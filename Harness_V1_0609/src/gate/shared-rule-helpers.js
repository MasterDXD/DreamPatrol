'use strict';

/**
 * 共享规则辅助工具。为TDD门禁执行器（gate子系统）提供代码内容预处理
 * 与合规性检查的底层函数，包括注释/字符串剥离、eval检测、加密安全检测、
 * 类导出规范检测和文件命名规范检测。
 *
 * 本模块被 framework-compliance-checker 等上层检查器引用，负责将源码内容
 * 预处理为可安全检测的纯逻辑文本，以及提供单项规则判定函数。
 *
 * @module gate/shared-rule-helpers
 * @example
 * const { stripCommentsAndStrings, checkNoEval, checkCryptoSafe, checkClassExport, checkKebabCase } = require('./shared-rule-helpers');
 * const stripped = stripCommentsAndStrings(sourceCode);
 * const hasEval = checkNoEval(stripped);
 * const unsafeCrypto = checkCryptoSafe(stripped);
 */

/**
 * 块注释正则。匹配斜杠星号形式的JS多行注释。
 * @constant {RegExp}
 */
const STRIP_COMMENTS_RE = /\/\*[\s\S]*?\*\//g;

/**
 * 行注释正则。匹配 `// ...` 形式的单行注释。
 * @constant {RegExp}
 */
const STRIP_LINE_COMMENTS_RE = /\/\/.*$/gm;

/**
 * 单引号字符串正则。匹配 `'...'` 形式的单引号字符串字面量，支持转义字符。
 * @constant {RegExp}
 */
const STRIP_SINGLE_QUOTE_RE = /'(?:[^'\\]|\\.)*'/g;

/**
 * 双引号字符串正则。匹配 `"..."` 形式的双引号字符串字面量，支持转义字符。
 * @constant {RegExp}
 */
const STRIP_DOUBLE_QUOTE_RE = /"(?:[^"\\]|\\.)*"/g;

/**
 * 模板字符串正则。匹配 `` `...` `` 形式的模板字面量，支持转义字符。
 * @constant {RegExp}
 */
const STRIP_TEMPLATE_RE = /`(?:[^`\\]|\\.)*`/g;

/**
 * 模板表达式正则。匹配 `${...}` 形式的模板插值表达式。
 * @constant {RegExp}
 */
const TEMPLATE_EXPR_RE = /\$\{[^}]*\}/g;

/**
 * 剥离源码中的所有注释和字符串字面量，但保留模板字符串中的插值表达式。
 *
 * 处理流程：
 * 1. 先提取模板插值表达式 `${...}` 并替换为占位符，防止插值内的代码被误删；
 * 2. 依次移除块注释、行注释、单引号字符串、双引号字符串、模板字符串；
 * 3. 将占位符还原为原始插值表达式。
 *
 * 这样可以确保模板字符串中的逻辑代码（如条件表达式、函数调用）被保留，
 * 以便后续的合规性检查能正确检测模板插值中的代码模式。
 *
 * @param {string} content - 源码文本
 * @returns {string} 剥离注释和字符串后的纯逻辑代码文本
 */
function stripCommentsAndStrings(content) {
  const templateExprs = [];
  let idx = 0;
  const withPlaceholders = content.replace(TEMPLATE_EXPR_RE, function(match) {
    templateExprs.push(match);
    return '__TMPL_EXPR_' + (idx++) + '__';
  });
  const stripped = withPlaceholders
    .replace(STRIP_COMMENTS_RE, '')
    .replace(STRIP_LINE_COMMENTS_RE, '')
    .replace(STRIP_SINGLE_QUOTE_RE, '')
    .replace(STRIP_DOUBLE_QUOTE_RE, '')
    .replace(STRIP_TEMPLATE_RE, '');
  let result = stripped;
  for (let i = templateExprs.length - 1; i >= 0; i--) {
    result = result.replace('__TMPL_EXPR_' + i + '__', templateExprs[i]);
  }
  return result;
}

/**
 * eval调用正则。匹配 `eval(` 形式的eval函数调用。
 * @constant {RegExp}
 */
const EVAL_RE = /\beval\s*\(/;

/**
 * Function构造器正则。匹配 `new Function(` 形式的动态函数创建。
 * @constant {RegExp}
 */
const NEW_FUNCTION_RE = /new\s+Function\s*\(/;

/**
 * Math.random调用正则。匹配 `Math.random()` 形式的不安全随机数调用。
 * @constant {RegExp}
 */
const MATH_RANDOM_RE = /Math\.random\(\)/;

/**
 * ID生成函数正则。匹配常见的ID生成函数命名模式，如 `_generateId`、`generateId`、`generateXXXId`。
 * @constant {RegExp}
 */
const ID_GEN_RE = /_generateId|generateId|generate.*[Ii]d/;

/**
 * 类定义正则。匹配 `class X` 形式的ES6类声明（类名以大写字母开头）。
 * @constant {RegExp}
 */
const CLASS_DEF_RE = /\bclass\s+[A-Z]/;

/**
 * module.exports赋值正则。匹配 `module.exports =` 形式的CommonJS模块导出。
 * @constant {RegExp}
 */
const MODULE_EXPORTS_RE = /module\.exports\s*=/;

/**
 * kebab-case文件名正则。验证文件名是否符合kebab-case命名规范，
 * 允许的扩展名包括 `.js`、`.ts`、`.d.ts`、`.mjs`、`.cjs`。
 * @constant {RegExp}
 */
const KEBAB_CASE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*\.(js|ts|d\.ts|mjs|cjs)$/;

/**
 * 模糊文件名后缀正则。检测文件名中是否包含版本号、临时标记等
 * 缺乏语义的命名模式（如 utils-v2、helper-final、service-new-backup）。
 * 命名红线规则：文件名应清晰说明功能，禁止使用模糊后缀。
 * @constant {RegExp}
 */
const VAGUE_FILENAME_SUFFIXES_RE = /(?:^|[-_.])(?:v\d+|final|new|old|backup|copy|tmp|temp|orig|original|draft|wip|todo|fix|updated?|latest|current|prev|previous|deprecated|unused|dead|broken|test2?|debug)(?:[-_.]|$)/i;

/**
 * 检测文件名是否包含模糊后缀（如v2、final、new、backup等）。
 * 命名红线规则：禁止使用utils-v3-final这类模糊文件名，要求文件名能清晰说明功能。
 *
 * @param {string} basename - 文件名（不含目录路径）
 * @returns {boolean} 若检测到模糊后缀则返回true，否则返回false
 */
function checkVagueFilename(basename) {
  return VAGUE_FILENAME_SUFFIXES_RE.test(basename);
}

/**
 * 检测代码中是否使用了eval或Function构造器。
 *
 * 这两个特性均属于动态代码执行，违反项目安全规范（SECURITY_RULES.NO_EVAL），
 * 可能引入代码注入风险。检测应在剥离注释和字符串后的代码上进行，
 * 以避免误报字符串中的eval关键字。
 *
 * @param {string} stripped - 已剥离注释和字符串的源码文本
 * @returns {boolean} 若检测到eval调用或Function构造器则返回true，否则返回false
 */
function checkNoEval(stripped) {
  return EVAL_RE.test(stripped) || NEW_FUNCTION_RE.test(stripped);
}

/**
 * 检测代码中是否存在使用Math.random()生成ID的不安全模式。
 *
 * 当代码同时包含 `Math.random()` 调用和ID生成函数时，判定为加密不安全
 * （SECURITY_RULES.CRYPTO_SAFE_RANDOM）。应使用 `crypto.randomUUID()` 替代。
 *
 * @param {string} stripped - 已剥离注释和字符串的源码文本
 * @returns {boolean} 若同时检测到Math.random()和ID生成函数则返回true，否则返回false
 */
function checkCryptoSafe(stripped) {
  return MATH_RANDOM_RE.test(stripped) && ID_GEN_RE.test(stripped);
}

/**
 * 检测模块是否定义了类但未通过module.exports导出。
 *
 * 项目规范（STRUCTURE_RULES.CLASS_EXPORT）要求：若模块定义了类，
 * 应通过 `module.exports = ClassName` 导出该类。仅定义类而不导出
 * 可能导致模块职责不清或类无法被外部引用。
 *
 * @param {string} content - 原始源码文本（无需预剥离，正则直接匹配原始内容）
 * @returns {boolean} 若检测到类定义但缺少module.exports导出则返回true，否则返回false
 */
function checkClassExport(content) {
  return CLASS_DEF_RE.test(content) && !MODULE_EXPORTS_RE.test(content);
}

/**
 * 检测文件名是否符合kebab-case命名规范。
 *
 * 项目规范（NAMING_RULES.FILE_KEBAB_CASE）要求源码文件名使用kebab-case。
 * `index.js`、`index.ts`、`types.js`、`types.ts` 等特殊入口文件豁免此规则。
 *
 * @param {string} basename - 文件基本名（含扩展名，如 `my-module.js`）
 * @returns {boolean} 若文件名不符合kebab-case且不属于豁免文件则返回true（违规），否则返回false
 */
function checkKebabCase(basename) {
  return !KEBAB_CASE_RE.test(basename) && !/^(index|types)\.(js|ts|d\.ts|mjs|cjs)$/.test(basename);
}

/**
 * 仅剥离源码中的注释（块注释和行注释），保留所有字符串字面量。
 *
 * 适用于需要检查字符串内容的场景（如检测字符串中的特定模式），
 * 与 stripCommentsAndStrings 的区别在于不会移除字符串字面量。
 *
 * @param {string} content - 源码文本
 * @returns {string} 剥离注释后的代码文本（保留字符串字面量）
 */
function stripCommentsOnly(content) {
  return content
    .replace(STRIP_COMMENTS_RE, '')
    .replace(STRIP_LINE_COMMENTS_RE, '');
}

module.exports = {
  stripCommentsAndStrings,
  stripCommentsOnly,
  checkNoEval,
  checkCryptoSafe,
  checkClassExport,
  checkKebabCase,
  checkVagueFilename,
  VAGUE_FILENAME_SUFFIXES_RE,
};
