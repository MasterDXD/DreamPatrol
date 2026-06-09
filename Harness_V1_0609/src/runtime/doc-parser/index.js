'use strict';

/**
 * 智能文档解析子系统 — 统一导出模块
 *
 * 提供PDF/Office文档解析、双Agent智能提取、多数据库入库三大核心能力。
 * 融合路径：Agent化 + MCP封装 + Skill驱动 + Workflow编排
 *
 * @module doc-parser
 */

const DocumentParser = require('./document-parser');
const ExtractionAgent = require('./extraction-agent');
const DatabaseAdapter = require('./database-adapter');

module.exports = {
  DocumentParser,
  ExtractionAgent,
  DatabaseAdapter,
};
