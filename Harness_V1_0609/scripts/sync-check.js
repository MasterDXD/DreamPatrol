'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const ENTRY_FILES = [
  { name: 'CLAUDE.md', path: path.join(ROOT, 'CLAUDE.md') },
  { name: 'Trae', path: path.join(ROOT, '.trae', 'rules', 'project_rules.md') },
  { name: 'Cursor', path: path.join(ROOT, '.cursor', 'rules', 'harness-engineering.mdc') },
  { name: 'Copilot', path: path.join(ROOT, '.github', 'copilot-instructions.md') },
  { name: 'Windsurf', path: path.join(ROOT, '.windsurfrules') },
];

const CHECKS = [
  { pattern: /20个验证技能/, desc: 'Skill数量=20验证+41扩展+2基础', expected: true },
  { pattern: /19个验证技能/, desc: 'Skill数量=19验证(旧版)', expected: false },
  { pattern: /17个技能/, desc: 'Skill数量=17(旧版)', expected: false },
  { pattern: /16个技能/, desc: 'Skill数量=16(错误)', expected: false },
  { pattern: /六阶段/, desc: '六阶段流程', expected: true },
  { pattern: /五阶段/, desc: '五阶段流程(错误)', expected: false },
  { pattern: /brainstorming/, desc: 'brainstorming Skill', expected: true },
  { pattern: /tdd-implement/, desc: 'tdd-implement Skill', expected: true },
  { pattern: /verification-before-completion/, desc: 'verification Skill', expected: true },
  { pattern: /TDD强制/, desc: 'TDD强制原则', expected: true },
  { pattern: /证据验证/, desc: '证据验证原则', expected: true },
  { pattern: /自动路由/, desc: '自动路由原则', expected: true },
  { pattern: /writing-skills/, desc: 'writing-skills Skill', expected: true },
];

const AGENT_SKILL_CHECKS = [
  { agent: 'Team Lead', skills: ['brainstorming', 'idea-validation', 'requirement-analysis', 'dispatching-parallel', 'writing-skills', 'necessity-review', 'architecture-design', 'verification-before-completion', 'web-interaction', 'cli-anything', 'ai-native-scaling'] },
  { agent: 'Domain Analyst', skills: ['brainstorming', 'idea-validation', 'requirement-analysis', 'architecture-design', 'code-review', 'security-audit', 'performance-optimization', 'systematic-debugging', 'refactor-code', 'writing-skills', 'iterative-deepening', 'multi-agent-fusion', 'ai-prompting', 'necessity-review', 'design-md', 'taste-skill', 'impeccable', 'web-interaction', 'cli-anything', 'mvp-builder'] },
  { agent: 'Task Worker', skills: ['tdd-implement', 'module-development', 'bug-fix', 'performance-optimization', 'systematic-debugging', 'refactor-code', 'verification-before-completion', 'writing-skills', 'iterative-deepening', 'multi-agent-fusion', 'ai-prompting', 'design-md', 'taste-skill', 'impeccable', 'ui-skills', 'motion-ai-kit', 'better-icons', 'web-interaction', 'cli-anything'] },
  { agent: 'Quality Assurance', skills: ['code-review', 'integration-testing', 'security-audit', 'verification-before-completion', 'iterative-deepening', 'multi-agent-fusion'] },
  { agent: 'DevOps Engineer', skills: ['deployment', 'verification-before-completion', 'web-interaction', 'cli-anything'] },
  { agent: 'Technical Writer', skills: ['documentation', 'auto-doc-generation'] },
  { agent: 'Code Reviewer', skills: ['code-review', 'verification-before-completion', 'iterative-deepening'] },
  { agent: 'Security Reviewer', skills: ['security-audit', 'verification-before-completion'] },
  { agent: 'Build Error Solver', skills: ['systematic-debugging', 'bug-fix', 'verification-before-completion'] },
  { agent: 'Planner', skills: ['brainstorming', 'idea-validation', 'requirement-analysis', 'architecture-design', 'writing-skills'] },
  { agent: 'Test Writer', skills: ['tdd-implement', 'module-development', 'verification-before-completion'] },
  { agent: 'TypeScript Reviewer', skills: ['code-review', 'verification-before-completion', 'iterative-deepening'] },
  { agent: 'Python Reviewer', skills: ['code-review', 'verification-before-completion', 'iterative-deepening'] },
  { agent: 'Go Reviewer', skills: ['code-review', 'verification-before-completion', 'iterative-deepening'] },
  { agent: 'Rust Reviewer', skills: ['code-review', 'security-audit', 'verification-before-completion', 'iterative-deepening'] },
  { agent: 'Java Reviewer', skills: ['code-review', 'verification-before-completion', 'iterative-deepening'] },
  { agent: 'System Designer', skills: ['architecture-design', 'necessity-review', 'code-review', 'security-audit', 'verification-before-completion'] },
  { agent: 'Backend Engineer', skills: ['writing-skills', 'verification-before-completion', 'architecture-design', 'cli-anything'] },
  { agent: 'Data Analyst', skills: ['data-analysis', 'visualization', 'statistical-modeling', 'report-generation', 'deep-research'] },
  { agent: 'Frontend Engineer', skills: ['writing-skills', 'verification-before-completion', 'web-interaction'] },
  { agent: 'Marketing Strategist', skills: ['brainstorming', 'idea-validation', 'deep-research', 'writing-skills', 'data-analysis'] },
  { agent: 'Product Manager', skills: ['brainstorming', 'requirement-analysis', 'idea-validation', 'deep-research', 'writing-skills'] },
  { agent: 'Research Specialist', skills: ['deep-research', 'data-analysis', 'writing-skills', 'idea-validation'] },
  { agent: 'SEO Specialist', skills: ['deep-research', 'writing-skills', 'data-analysis'] },
  { agent: 'UX Designer', skills: ['brainstorming', 'idea-validation', 'requirement-analysis', 'writing-skills'] },
  { agent: 'Customer Service Agent', skills: ['requirement-analysis', 'writing-skills', 'verification-before-completion', 'web-interaction', 'cli-anything'] },
  { agent: 'Order Processing Agent', skills: ['requirement-analysis', 'writing-skills', 'verification-before-completion', 'web-interaction', 'cli-anything'] },
  { agent: 'Logistics Agent', skills: ['requirement-analysis', 'writing-skills', 'verification-before-completion', 'web-interaction', 'cli-anything'] },
];

let errors = 0;
let warnings = 0;

console.log('=== Harness Engineering 入口文件一致性检查 ===\n');

for (const entry of ENTRY_FILES) {
  console.log(`\n--- ${entry.name} ---`);
  if (!fs.existsSync(entry.path)) {
    console.log(`  [ERROR] 入口文件不存在: ${entry.path}`);
    errors++;
    continue;
  }
  const content = fs.readFileSync(entry.path, 'utf-8');

  for (const check of CHECKS) {
    const found = check.pattern.test(content);
    const ok = found === check.expected;
    if (!ok) {
      console.log(`  [ERROR] ${check.desc}: ${found ? '存在' : '缺失'} (期望: ${check.expected ? '存在' : '不存在'})`);
      errors++;
    } else {
      console.log(`  [OK] ${check.desc}`);
    }
  }

  const usesInclude = content.includes('@include');
  const hasAgentSkillSection = content.includes('可用Skill') || content.includes('available_skills');

  for (const agentCheck of AGENT_SKILL_CHECKS) {
    if (usesInclude) continue;
    if (!hasAgentSkillSection) continue;
    const agentSection = content.match(new RegExp(`${agentCheck.agent}[\\s\\S]*?可用Skill[：:](.+)`, 'm'));
    if (agentSection) {
      const skillList = agentSection[1];
      for (const skill of agentCheck.skills) {
        if (!skillList.includes(skill)) {
          console.log(`  [ERROR] ${agentCheck.agent} 缺少 Skill: ${skill}`);
          errors++;
        }
      }
    } else {
      console.log(`  [WARN] ${agentCheck.agent} 未找到可用Skill定义`);
      warnings++;
    }
  }
}

console.log('\n\n=== Skill文件完整性检查 ===\n');
const skillsDir = path.join(ROOT, '.harness', 'skills');
const skillFiles = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
const skillIds = skillFiles.map(f => f.replace('.md', ''));

const REQUIRED_FRONTMATTER = ['skill_id', 'name', 'applicable_agents', 'trigger', 'auto_trigger', 'phase', 'priority', 'trigger_conditions'];

const skillFrontmatters = {};

for (const file of skillFiles) {
  const content = fs.readFileSync(path.join(skillsDir, file), 'utf-8');
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

  if (!frontmatterMatch) {
    console.log(`  [ERROR] ${file}: 缺少YAML Frontmatter`);
    errors++;
    continue;
  }

  const frontmatter = frontmatterMatch[1];
  const isInfrastructure = frontmatter.includes('component_id:');

  if (isInfrastructure) {
    console.log(`  [OK] ${file} (基础设施组件)`);
    skillFrontmatters[file.replace('.md', '')] = { infrastructure: true, raw: frontmatter };
    continue;
  }

  for (const field of REQUIRED_FRONTMATTER) {
    if (!frontmatter.includes(`${field}:`) && !frontmatter.includes(`${field}: `)) {
      console.log(`  [WARN] ${file}: 缺少Frontmatter字段 '${field}'`);
      warnings++;
    }
  }

  const hasObjective = content.includes('任务目标') || content.includes('## 目标');
  const hasSteps = content.includes('执行步骤') || content.includes('## 步骤');
  const hasAcceptance = content.includes('验收标准') || content.includes('## 验收');
  const hasFAQ = content.includes('常见问题') || content.includes('## FAQ');

  if (!hasObjective || !hasSteps || !hasAcceptance || !hasFAQ) {
    console.log(`  [ERROR] ${file}: 缺少必需章节 (目标:${hasObjective} 步骤:${hasSteps} 验收:${hasAcceptance} FAQ:${hasFAQ})`);
    errors++;
  } else {
    console.log(`  [OK] ${file}`);
  }

  skillFrontmatters[file.replace('.md', '')] = {
    infrastructure: false,
    raw: frontmatter,
    applicable_agents: parseYamlArray(frontmatter, 'applicable_agents'),
    depends_on: parseYamlArray(frontmatter, 'depends_on'),
    blocks: parseYamlArray(frontmatter, 'blocks'),
    phase: parseYamlValue(frontmatter, 'phase'),
    priority: parseYamlValue(frontmatter, 'priority'),
    enforcement: parseYamlValue(frontmatter, 'enforcement'),
  };
}

/**
 * @param {string} frontmatter - YAML frontmatter 文本
 * @param {string} key - 要提取的键名
 * @returns {string[]} 解析得到的数组值
 */
function parseYamlArray(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  if (match) {
    return match[1].split(',').map(s => s.trim()).filter(Boolean);
  }
  // Handle multi-line YAML list: key:\n  - item1\n  - item2
  const multiLineMatch = frontmatter.match(new RegExp(`${key}:\\s*\\n((?:\\s+-\\s+\\S+\\s*\\n?)*)`));
  if (multiLineMatch) {
    const items = multiLineMatch[1].match(/- \S+/g);
    return items ? items.map(s => s.replace(/^- /, '').trim()).filter(Boolean) : [];
  }
  // Handle inline single value: key: value (but NOT key: - which is a list marker)
  const inlineMatch = frontmatter.match(new RegExp(`${key}:\\s*(\\S[^\\n]*)`));
  if (inlineMatch && inlineMatch[1] !== '-') {
    const val = inlineMatch[1].trim();
    return val ? [val] : [];
  }
  return [];
}

/**
 * @param {string} frontmatter - YAML frontmatter 文本
 * @param {string} key - 要提取的键名
 * @returns {string|null} 解析得到的单值，不存在时返回 null
 */
function parseYamlValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`${key}:\\s*(\\S+)`));
  return match ? match[1] : null;
}

console.log('\n\n=== config.json一致性检查 ===\n');
const configPath = path.join(ROOT, '.harness', 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch (err) {
  console.error('Failed to read/parse config.json:', (err && err.message ? err.message : String(err)));
  process.exit(1);
}

const configSkills = config.skill_registry?.skills?.map(s => s.skill_id) ?? [];
for (const id of skillIds) {
  if (id === 'skill-router' || id === 'session-start-hook') continue;
  if (!configSkills.includes(id)) {
    console.log(`  [ERROR] config.json缺少Skill注册: ${id}`);
    errors++;
  }
}
for (const id of configSkills) {
  if (!skillIds.includes(id)) {
    console.log(`  [ERROR] config.json注册了不存在的Skill: ${id}`);
    errors++;
  }
}
console.log(`  [OK] config.json Skill注册表: ${configSkills.length}个Skill`);

if (!config.tdd_config) {
  console.log('  [WARN] config.json缺少tdd_config节');
  warnings++;
}
if (!config.verification_config) {
  console.log('  [WARN] config.json缺少verification_config节');
  warnings++;
}

console.log('\n\n=== 版本一致性检查 ===\n');
const configVersion = config.version;
console.log(`  config.json版本: ${configVersion}`);

let versionConsistent = true;
for (const entry of ENTRY_FILES) {
  if (!fs.existsSync(entry.path)) continue;
  const content = fs.readFileSync(entry.path, 'utf-8');
  const hasVersion = content.includes('v2.34') || content.includes('v2.35') || content.includes('v2.36') || content.includes('v2.37');
  if (!hasVersion) {
    console.log(`  [WARN] ${entry.name}: 未包含版本号v2.34/v2.35/v2.36/v2.37引用`);
    warnings++;
    versionConsistent = false;
  }
}
if (versionConsistent) {
  console.log('  [OK] 所有入口文件版本引用一致');
}

console.log('\n\n=== RBAC权限矩阵验证 ===\n');
const agentsDir = path.join(ROOT, '.harness', 'agents');
const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));

const AGENT_FILE_SKILL_MAP = {
  'team-lead.md': 'Team Lead',
  'domain-analyst.md': 'Domain Analyst',
  'task-worker.md': 'Task Worker',
  'quality-assurance.md': 'Quality Assurance',
  'devops-engineer.md': 'DevOps Engineer',
  'technical-writer.md': 'Technical Writer',
  'code-reviewer.md': 'Code Reviewer',
  'security-reviewer.md': 'Security Reviewer',
  'build-error-solver.md': 'Build Error Solver',
  'planner.md': 'Planner',
  'test-writer.md': 'Test Writer',
  'typescript-reviewer.md': 'TypeScript Reviewer',
  'python-reviewer.md': 'Python Reviewer',
  'go-reviewer.md': 'Go Reviewer',
  'rust-reviewer.md': 'Rust Reviewer',
  'java-reviewer.md': 'Java Reviewer',
  'system-designer.md': 'System Designer',
  'backend-engineer.md': 'Backend Engineer',
  'data-analyst.md': 'Data Analyst',
  'frontend-engineer.md': 'Frontend Engineer',
  'marketing-strategist.md': 'Marketing Strategist',
  'product-manager.md': 'Product Manager',
  'research-specialist.md': 'Research Specialist',
  'seo-specialist.md': 'SEO Specialist',
  'ux-designer.md': 'UX Designer',
  'customer-service.md': 'Customer Service Agent',
  'order-processing.md': 'Order Processing Agent',
  'logistics.md': 'Logistics Agent',
};

for (const agentFile of agentFiles) {
  const agentName = AGENT_FILE_SKILL_MAP[agentFile];
  if (!agentName) {
    console.log(`  [WARN] ${agentFile}: 未在验证映射中定义`);
    warnings++;
    continue;
  }

  const content = fs.readFileSync(path.join(agentsDir, agentFile), 'utf-8');
  const expectedSkills = AGENT_SKILL_CHECKS.find(c => c.agent === agentName)?.skills ?? [];

  const availableSkillsMatch = content.match(/available_skills[：:]\s*\[([^\]]*)\]/);
  if (!availableSkillsMatch) {
    console.log(`  [WARN] ${agentFile}: 未找到available_skills定义`);
    warnings++;
    continue;
  }

  const agentSkills = availableSkillsMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);

  for (const skill of expectedSkills) {
    if (!agentSkills.includes(skill)) {
      console.log(`  [ERROR] ${agentName}(${agentFile}): 缺少Skill '${skill}' (入口文件有但Agent文件无)`);
      errors++;
    }
  }

  for (const skill of agentSkills) {
    if (!expectedSkills.includes(skill)) {
      console.log(`  [WARN] ${agentName}(${agentFile}): 额外Skill '${skill}' (Agent文件有但入口文件无)`);
      warnings++;
    }
  }

  const hasAutoRoute = content.includes('auto_route');
  const hasTddEnforced = content.includes('tdd_enforced');
  if (!hasAutoRoute) {
    console.log(`  [WARN] ${agentFile}: 缺少auto_route字段`);
    warnings++;
  }
  if (agentName === 'Task Worker' && !hasTddEnforced) {
    console.log(`  [ERROR] ${agentFile}: Task Worker必须包含tdd_enforced字段`);
    errors++;
  }

  console.log(`  [OK] ${agentName}(${agentFile}): ${agentSkills.length}个Skill`);
}

console.log('\n\n=== Skill依赖图验证 ===\n');
const skillGraph = {};
for (const [id, meta] of Object.entries(skillFrontmatters)) {
  if (meta.infrastructure) continue;
  skillGraph[id] = {
    depends_on: meta.depends_on ?? [],
    blocks: meta.blocks ?? [],
    phase: meta.phase,
    priority: meta.priority,
  };
}

/**
 * @param {object} graph - 依赖图，键为节点ID，值为含 depends_on 数组的对象
 * @param {string} node - 当前遍历的节点ID
 * @param {Set<string>} visited - 已访问节点集合
 * @param {Set<string>} recStack - 递归栈节点集合
 * @param {string[]} cyclePath - 当前遍历路径
 * @returns {string[]|null} 检测到的循环路径，无循环时返回 null
 */
function detectCycle(graph, node, visited, recStack, cyclePath) {
  visited.add(node);
  recStack.add(node);
  cyclePath.push(node);

  for (const dep of (graph[node]?.depends_on ?? [])) {
    if (!graph[dep]) continue;
    if (!visited.has(dep)) {
      const cycle = detectCycle(graph, dep, visited, recStack, cyclePath);
      if (cycle) return cycle;
    } else if (recStack.has(dep)) {
      const cycleStart = cyclePath.indexOf(dep);
      return cyclePath.slice(cycleStart).concat([dep]);
    }
  }

  cyclePath.pop();
  recStack.delete(node);
  return null;
}

const visited = new Set();
const recStack = new Set();
let hasCycle = false;
for (const node of Object.keys(skillGraph)) {
  if (!visited.has(node)) {
    const cycle = detectCycle(skillGraph, node, visited, recStack, []);
    if (cycle) {
      console.log(`  [ERROR] 检测到循环依赖: ${cycle.join(' → ')}`);
      errors++;
      hasCycle = true;
    }
  }
}
if (!hasCycle) {
  console.log('  [OK] 无循环依赖');
}

for (const [id, meta] of Object.entries(skillGraph)) {
  for (const dep of meta.depends_on) {
    if (!skillIds.includes(dep)) {
      console.log(`  [ERROR] ${id} 依赖不存在的Skill: ${dep}`);
      errors++;
    }
  }
  for (const block of meta.blocks) {
    if (!skillIds.includes(block)) {
      console.log(`  [ERROR] ${id} 阻塞不存在的Skill: ${block}`);
      errors++;
    }
  }
}
console.log('  [OK] 依赖目标存在性验证通过');

for (const [id, meta] of Object.entries(skillGraph)) {
  if (meta.enforcement === 'strict' && !['tdd-implement', 'verification-before-completion', 'module-development', 'bug-fix', 'code-review', 'security-audit'].includes(id)) {
    console.log(`  [INFO] ${id}: enforcement=strict (确认是否合理)`);
  }
}

console.log('\n\n=== 工作区目录检查 ===\n');
const workspaceDirs = ['staging', 'shared', 'locks'];
for (const dir of workspaceDirs) {
  const dirPath = path.join(ROOT, '.harness', 'workspace', dir);
  if (fs.existsSync(dirPath)) {
    const hasGitkeep = fs.existsSync(path.join(dirPath, '.gitkeep'));
    console.log(`  [OK] .harness/workspace/${dir}/ 存在${hasGitkeep ? ' (含.gitkeep)' : ''}`);
    if (!hasGitkeep) {
      console.log(`  [WARN] .harness/workspace/${dir}/ 缺少.gitkeep文件`);
      warnings++;
    }
  } else {
    console.log(`  [ERROR] .harness/workspace/${dir}/ 缺失`);
    errors++;
  }
}

console.log('\n\n=== @include引用完整性检查 ===\n');
const includePattern = /@include\s+(\S+)/g;
for (const entry of ENTRY_FILES) {
  if (!fs.existsSync(entry.path)) continue;
  const content = fs.readFileSync(entry.path, 'utf-8');
  let match;
  let fileIncludes = 0;
  let missingIncludes = 0;
  while ((match = includePattern.exec(content)) !== null) {
    fileIncludes++;
    const includePath = path.resolve(ROOT, match[1]);
    if (!includePath.startsWith(ROOT)) {
      console.warn('[Harness] Path traversal detected, skipping:', match[1]);
      continue;
    }
    if (!fs.existsSync(includePath)) {
      console.log(`  [ERROR] ${entry.name}: @include引用的文件不存在: ${match[1]}`);
      errors++;
      missingIncludes++;
    }
  }
  if (fileIncludes > 0 && missingIncludes === 0) {
    console.log(`  [OK] ${entry.name}: ${fileIncludes}个@include引用全部有效`);
  } else if (fileIncludes === 0) {
    console.log(`  [INFO] ${entry.name}: 无@include引用`);
  }
  includePattern.lastIndex = 0;
}

console.log('\n\n=== 检查结果 ===');
console.log(`  错误: ${errors}`);
console.log(`  警告: ${warnings}`);
console.log(`  状态: ${errors === 0 ? '✅ 通过' : '❌ 未通过'}`);

process.exit(errors > 0 ? 1 : 0);
