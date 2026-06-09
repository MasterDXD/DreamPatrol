---
skill_id: memory-archive
name: 三层记忆归档
phase: module-development
priority: high
description: |
  三层记忆自动晋升引擎，融合OpenHuman三层记忆树核心能力。
  实现工作记忆→长期记忆→归档记忆的自动晋升管道，支持定时检查和手动操作。
trigger: auto
trigger_conditions:
  - 需要管理记忆生命周期
  - 长期项目需要记忆自动归档
  - 用户请求"归档记忆"或"整理记忆"
applicable_agents: []
auto_trigger: true
depends_on: []
blocks: []
verified: true
stability: stable
---

## 目标

通过三层记忆自动晋升引擎（Working→Long-term→Archive），实现记忆生命周期的自动化管理，确保高频记忆晋升、低频记忆归档，优化记忆存储效率。

## 步骤

1. 存储记忆条目（默认存入Working层，30分钟TTL）
2. 系统自动检测访问次数和存活时间，触发晋升（访问≥3次 → Long-term）
3. 长期记忆7天无访问自动归档到Archive层
4. 支持跨层检索和手动promote/archive操作

# 三层记忆归档（Memory Archive Store）

融合自OpenHuman三层记忆树能力。

## 核心能力

1. **三层记忆架构**：Working(30分钟) → Long-term(30天) → Archive(永久)
2. **自动晋升**：访问次数达标或存活时间过半自动晋升到下一层
3. **自动归档**：长期记忆7天无访问自动归档
4. **手动操作**：支持手动promote/archive操作

## 使用方式

```javascript
const MemoryArchiveStore = require('./src/runtime/thought/memory-archive-store');
const archive = new MemoryArchiveStore({ enableAutoPromotion: true });

archive.store('key', 'value'); // 默认存入working层
archive.store('key', 'value', { tier: 'long_term' }); // 指定层级
archive.retrieve('key'); // 跨层检索
archive.promote(entryId); // 手动晋升
archive.startAutoPromotion(); // 启动自动晋升
```

## 斜杠命令
`/memory-archive` — 记忆归档操作

## 配置选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| workingTTL | 30分钟 | 工作记忆TTL |
| longTermTTL | 30天 | 长期记忆TTL |
| promotionThreshold | 3 | 晋升所需访问次数 |
| autoPromotionInterval | 5分钟 | 自动晋升检查间隔 |

## 验收标准
- [ ] 三层记忆架构正常工作（Working→Long-term→Archive）
- [ ] 自动晋升按访问次数和存活时间触发
- [ ] 跨层检索功能正常
- [ ] 手动promote/archive操作可用

## 常见问题
- **Q: 工作记忆丢失太快？**
  A: 调整workingTTL（默认30分钟），或手动promote到长期记忆层
- **Q: 自动晋升不触发？**
  A: 确认enableAutoPromotion=true，且autoPromotionInterval配置合理
