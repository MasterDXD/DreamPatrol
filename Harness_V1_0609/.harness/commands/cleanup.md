---
command_id: cleanup
name: Dead Code清理
description: 检测并清理项目中的无用代码、孤立文件和未使用导出
skills: [refactor-code, deprecation-and-migration]
agent: task-worker
phase: module-development
aliases: [/dead-code, /清理]
enforcement: recommended
---

# /cleanup — Dead Code清理

## 使用场景
- 定期清理无用代码（建议每周五执行）
- 检测孤立文件（无依赖、无引用）
- 检测未使用的导出符号
- 检测模糊命名的文件（命名红线）
- 清理技术债务

## 执行流程
1. 运行 CodeGraph.detectOrphans() — 检测孤立文件
2. 运行 CodeGraph.detectUnusedExports() — 检测未使用导出
3. 运行 FrameworkComplianceChecker NO_VAGUE_FILENAME — 检测模糊文件名
4. 汇总检测报告，列出所有dead code候选项
5. 逐项人工确认后安全移除（不自动删除）
6. 运行测试验证移除后系统正常

## 检测维度
- **文件级**：无入边无出边的孤立文件
- **符号级**：已导出但从未被import的函数/类/常量
- **命名级**：含v2/final/new/backup等模糊后缀的文件名
- **配置级**：未被代码消费的配置项

## 安全规则
- 仅报告，不自动删除
- 每项删除需人工确认
- 删除前必须运行相关测试
- 遵循 deprecation-and-migration 技能的废弃流程

## 交付物
- Dead Code检测报告
- 清理变更说明
- 测试通过报告
