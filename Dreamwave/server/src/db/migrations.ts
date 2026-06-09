import { Database as SqlJsDatabase } from 'sql.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// 迁移定义：每个迁移有唯一版本号和执行函数
interface Migration {
  version: number;
  description: string;
  up: (db: SqlJsDatabase) => void | Promise<void>;
}

// 所有迁移，按版本号顺序排列
const migrations: Migration[] = [
  {
    version: 1,
    description: '初始表结构：users, dreams, tags, dream_tags',
    up: (db: SqlJsDatabase) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,
          username      TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL DEFAULT 'user',
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
          is_active     INTEGER NOT NULL DEFAULT 1
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS dreams (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL,
          title         TEXT NOT NULL,
          content       TEXT NOT NULL,
          emotion       TEXT NOT NULL,
          narrative     TEXT,
          recorded_date TEXT NOT NULL,
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);

      db.run(`CREATE INDEX IF NOT EXISTS idx_dreams_user_id ON dreams(user_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_dreams_recorded_date ON dreams(recorded_date)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_dreams_emotion ON dreams(emotion)`);

      db.run(`
        CREATE TABLE IF NOT EXISTS tags (
          id         TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL,
          name       TEXT NOT NULL,
          color      TEXT NOT NULL DEFAULT '#7EB8DA',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, name)
        );
      `);

      db.run(`CREATE INDEX IF NOT EXISTS idx_tags_user_id ON tags(user_id)`);

      db.run(`
        CREATE TABLE IF NOT EXISTS dream_tags (
          dream_id TEXT NOT NULL,
          tag_id   TEXT NOT NULL,
          PRIMARY KEY (dream_id, tag_id),
          FOREIGN KEY (dream_id) REFERENCES dreams(id) ON DELETE CASCADE,
          FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 2,
    description: '给 dreams 表添加 is_favorite 字段',
    up: (db: SqlJsDatabase) => {
      try { db.run('ALTER TABLE dreams ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0'); } catch (e) { /* 列已存在，忽略 */ }
    },
  },
  {
    version: 3,
    description: '添加操作日志表 operation_logs',
    up: (db: SqlJsDatabase) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS operation_logs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_type TEXT,
          target_id TEXT,
          detail TEXT,
          ip_address TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_operation_logs_user_id ON operation_logs(user_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_operation_logs_action ON operation_logs(action)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at)`);
    },
  },
  {
    version: 4,
    description: '添加 AI 全局配置表和 AI 调用记录表',
    up: (db: SqlJsDatabase) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS ai_config (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS ai_call_logs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          dream_id TEXT,
          call_type TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          result_url TEXT,
          result_text TEXT,
          error_message TEXT,
          tokens_used INTEGER,
          duration_ms INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (dream_id) REFERENCES dreams(id) ON DELETE SET NULL
        );
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_ai_call_logs_user_id ON ai_call_logs(user_id)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_ai_call_logs_call_type ON ai_call_logs(call_type)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_ai_call_logs_status ON ai_call_logs(status)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_ai_call_logs_created_at ON ai_call_logs(created_at)`);

      // 插入默认配置
      const defaults: [string, string][] = [
        ['api_key', ''],
        ['image_model', 'gpt-image-2'],
        ['image_size', '16:9'],
        ['image_resolution', '1k'],
        ['image_format', 'png'],
        ['chat_model', 'deepseek-v4-flash'],
        ['chat_temperature', '0.7'],
        ['daily_image_limit', '2'],
        ['daily_chat_limit', '2'],
        ['system_prompt', `你是一位温和、专业的梦境研究者，熟悉荣格、弗洛伊德及现代积极心理学。
请基于用户提供的「梦境画面描述」，输出一份结构化的中文解读。
要求：
1. 不要做医学诊断，不要暗示现实事件。
2. 关注画面中的象征物、颜色、场景、情绪氛围。
3. 给出可能的潜意识主题、情绪提示、可以自问的小问题。
4. 文字简洁、有温度，便于复制分享。
严格使用以下 Markdown 结构（不要使用代码块包裹，直接输出 Markdown）：
## 画面概览
（1-2 句）
## 关键象征
- 象征1：可能含义
- 象征2：可能含义
- 象征3：可能含义
## 情绪与主题
（2-3 句）
## 自我探索
- 问题1
- 问题2
- 问题3`],
      ];
      for (const [key, value] of defaults) {
        db.run('INSERT OR IGNORE INTO ai_config (key, value) VALUES (?, ?)', [key, value]);
      }
    },
  },
  {
    version: 5,
    description: '给 ai_call_logs 添加 task_id 字段',
    up: (db: SqlJsDatabase) => {
      db.run(`ALTER TABLE ai_call_logs ADD COLUMN task_id TEXT`);
    },
  },
  {
    version: 6,
    description: '给 dreams 表添加 image_url 和 interpretation 字段',
    up: (db: SqlJsDatabase) => {
      try { db.run('ALTER TABLE dreams ADD COLUMN image_url TEXT'); } catch (e) { /* 列已存在 */ }
      try { db.run('ALTER TABLE dreams ADD COLUMN interpretation TEXT'); } catch (e) { /* 列已存在 */ }
    },
  },
  {
    version: 7,
    description: '给 users 表添加 token_invalidated_before 字段（密码修改后使旧 session 失效）',
    up: (db: SqlJsDatabase) => {
      try { db.run('ALTER TABLE users ADD COLUMN token_invalidated_before TEXT'); } catch (e) { /* 列已存在 */ }
    },
  },
  {
    version: 8,
    description: '给 users 表添加 avatar 字段（用户头像）',
    up: (db: SqlJsDatabase) => {
      try { db.run('ALTER TABLE users ADD COLUMN avatar TEXT'); } catch (e) { /* 列已存在 */ }
    },
  },
];

export async function runMigrations(db: SqlJsDatabase): Promise<void> {
  // 创建迁移版本表
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER NOT NULL UNIQUE,
      description TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 查询已执行的迁移版本
  const appliedVersions = new Set<number>();
  try {
    const stmt = db.prepare('SELECT version FROM schema_migrations');
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      appliedVersions.add(row.version);
    }
    stmt.free();
  } catch {
    // 表刚创建，没有数据
  }

  // 按版本号顺序执行未执行的迁移
  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      console.log(`[DB] 执行迁移 v${migration.version}: ${migration.description}`);
      await migration.up(db);
      db.run(
        'INSERT INTO schema_migrations (version, description) VALUES (?, ?)',
        [migration.version, migration.description]
      );
    }
  }

  // 确保管理员账户存在
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  if (!process.env.ADMIN_PASSWORD && process.env.NODE_ENV === 'production') {
    console.error('[DB] FATAL: ADMIN_PASSWORD environment variable must be set in production.');
    process.exit(1);
  }
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[DB] WARNING: Using default admin password. Set ADMIN_PASSWORD for production.');
  }
  const adminExists = db.exec("SELECT id, username, role, is_active FROM users WHERE username = 'admin'");
  if (adminExists.length > 0 && adminExists[0].values.length > 0) {
    const id = adminExists[0].values[0][0];
    const hash = await bcrypt.hash(adminPassword, 10);
    db.run(
      "UPDATE users SET password_hash = ?, role = ?, is_active = 1 WHERE id = ?",
      [hash, 'admin', id]
    );
  } else {
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(adminPassword, 10);
    db.run(
      "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)",
      [id, 'admin', hash, 'admin']
    );
  }
}
