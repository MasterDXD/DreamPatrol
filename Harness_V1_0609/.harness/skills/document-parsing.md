---
id: document-parsing
skill_id: document-parsing
applicable_agents: []
auto_trigger: true
trigger: auto
trigger_conditions: []
name: 智能文档解析
version: 1.0.0
phase: module-development
priority: 5
enforcement: recommended
description: 从PDF/Office文档识别到数据入库的全流程自动化，支持复杂表格、特殊符号、公式单位、定位溯源、双Agent智能提取、一键入库
triggers:
  - 解析文档
  - 解析PDF
  - 提取表格
  - 文档入库
  - OCR识别
  - 文档解析
  - 数据提取
  - document parsing
  - PDF extraction
  - table extraction
negate:
  - 代码解析
  - 源码分析
  - code parsing
model_tier: high
causal_inputs:
  - filePath
  - schemaName
  - extractionSchema
  - databaseConfig
causal_outputs:
  - parsedDocument
  - extractedFields
  - insertedRecords
verified: true
stability: stable
---

## 目标

实现从PDF/Office文档识别到数据入库的全流程自动化，支持复杂表格、特殊符号、公式单位、定位溯源、双Agent智能提取和一键入库，覆盖财务、科研、行业标准等多种业务场景。

## 验收

- [ ] 文档解析成功（PDF/Office/图像格式）
- [ ] 复杂表格提取完整（嵌套表头、跨行跨列、合并单元格）
- [ ] 特殊符号和公式单位正确保留
- [ ] 定位溯源功能可用（识别结果与原文同步高亮）
- [ ] 双Agent提取架构正常（Extractor + Verifier交叉验证）
- [ ] 置信度评分合理
- [ ] 数据入库成功（SQLite/MySQL/PostgreSQL）

# 智能文档解析技能

## 概述

实现从PDF/Office文档识别到数据入库的全流程自动化，覆盖财务、科研、行业标准等多种业务场景。

## 四大核心能力

### 1. 精准识别模块 (DocumentParser)

- **复杂表格**: 嵌套表头、跨行跨列、合并单元格
- **特殊符号**: 温度单位(°C/°F)、压力单位(Pa/MPa)、希腊字母(α/β/γ)
- **公式单位**: 完整保留实验结果表中数值的小数点精度
- **支持格式**: PDF, PNG/JPG/TIFF, DOCX, XLSX, PPTX

### 2. 定位溯源模块 (locateInDocument)

- 识别结果与PDF原文同步高亮
- 数据来源可追溯、可核验
- 点击识别结果自动定位到PDF对应位置

### 3. 智能抽取模块 (ExtractionAgent)

- 双Agent大模型架构: Extractor Agent + Verifier Agent
- 自动语义理解，按需提取任意字段
- 每个字段附带置信度评分，支持人工审核
- 可注册自定义Schema定义提取规则

### 4. 一键入库模块 (DatabaseAdapter)

- 支持SQLite/MySQL/PostgreSQL
- Schema自动建表
- 事务批量插入，保证数据一致性
- 结构化数据直接落库，无需手动搬运

## 执行步骤

1. **文件接收**: 接收用户上传的文档文件
2. **类型检测**: 自动识别文件类型(PDF/Office/图像)
3. **文档解析**: 调用DocumentParser进行精准解析
4. **表格提取**: 提取复杂表格结构，保留嵌套表头和跨行跨列
5. **智能抽取**: 使用ExtractionAgent双Agent架构提取目标字段
6. **置信度评估**: Verifier Agent交叉验证，生成置信度评分
7. **数据入库**: 通过DatabaseAdapter将结构化数据写入数据库
8. **结果返回**: 返回解析结果、提取字段、入库状态

## 适用场景

- **财务**: 银行对账单、财务报表、发票解析
- **科研**: 学术论文、硕士论文、实验数据表
- **行业标准**: 技术规范、检测报告、认证文件

## 使用示例

```javascript
const { DocumentParser, ExtractionAgent, DatabaseAdapter } = require('./src/runtime/doc-parser');

// 1. 精准识别
const parser = new DocumentParser({ projectRoot: '/project' });
const result = await parser.parse('/path/to/paper.pdf');
console.log(result.tables); // 嵌套表头、跨行跨列表格
console.log(result.textContent); // 保留小数精度的数值

// 2. 定位溯源
const locations = parser.locateInDocument(result.docId, '3.14159');
// → { page: 5, x: 120, y: 340, width: 60, height: 12 }

// 3. 智能抽取
const agent = new ExtractionAgent({ llmClient: myLLM });
agent.registerSchema('experiment', {
  name: 'experiment',
  version: '1.0',
  fields: [
    { name: 'temperature', type: 'number', description: '实验温度' },
    { name: 'pressure', type: 'number', description: '压力值' },
    { name: 'result', type: 'number', description: '实验结果' },
  ],
});
const extraction = await agent.extract(result.docId, result, 'experiment');
// → { fields: [{ name: 'temperature', value: 25.5, confidence: 0.95, verified: true }] }

// 4. 一键入库
const db = new DatabaseAdapter({ defaultType: 'sqlite' });
db.addConnection('main', { type: 'sqlite', filePath: './data.db' });
db.createTableFromSchema('experiments', extraction.schema, 'main');
db.insert('experiments', extraction.fields.map(f => ({ [f.name]: f.value })), 'main');
```

## FAQ

- **Q: 支持哪些文档格式？** A: PDF、PNG/JPG/TIFF图像、DOCX、XLSX、PPTX等常见格式。
- **Q: 双Agent架构的优势是什么？** A: Extractor Agent负责提取，Verifier Agent交叉验证，每个字段附带置信度评分，大幅降低误提取。
- **Q: 支持哪些数据库？** A: SQLite、MySQL、PostgreSQL，支持Schema自动建表和事务批量插入。
