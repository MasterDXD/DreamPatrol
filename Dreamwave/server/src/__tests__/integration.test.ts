import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { runMigrations } from '../db/migrations';
import { generateToken, verifyToken } from '../middleware/auth';
import { generateNarrative } from '../utils/emotions';
import bcrypt from 'bcryptjs';

// 设置测试环境变量
process.env.JWT_SECRET = 'test-secret-for-integration-testing';
process.env.ADMIN_PASSWORD = 'testadmin123';

/**
 * 集成测试：完整用户流程
 * 注册 → 登录 → 创建梦境 → 获取列表 → 生成叙事 → 收藏 → 删除
 *
 * 使用内存数据库（不持久化到文件）
 * 如果sql.js的WASM初始化在测试环境有问题，整个测试套件会被跳过
 */
describe.skipIf(typeof WebAssembly === 'undefined')('集成测试：完整用户流程', () => {
  let db: SqlJsDatabase;
  let testUserId: string;
  let testDreamId: string;
  let authToken: string;

  // 初始化内存数据库
  beforeAll(async () => {
    const SQL = await initSqlJs();
    db = new SQL.Database(); // 纯内存数据库，不读取文件
    await runMigrations(db);
  });

  // 清理数据库
  afterAll(() => {
    if (db) {
      db.close();
    }
  });

  // 辅助函数：执行SQL查询
  function queryAll(sql: string, params: any[] = []): any[] {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  function queryOne(sql: string, params: any[] = []): any | undefined {
    const rows = queryAll(sql, params);
    return rows[0];
  }

  function run(sql: string, params: any[] = []): void {
    db.run(sql, params);
  }

  // 1. 注册
  it('应该成功注册新用户', async () => {
    const username = 'testuser_integration';
    const password = 'test123456';
    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 10);

    // 检查用户名不存在
    const existing = queryOne('SELECT id FROM users WHERE username = ?', [username]);
    expect(existing).toBeUndefined();

    // 插入用户
    run('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)', [id, username, passwordHash, 'user']);

    // 验证插入成功
    const user = queryOne('SELECT id, username, role FROM users WHERE username = ?', [username]) as any;
    expect(user).toBeDefined();
    expect(user.username).toBe(username);
    expect(user.role).toBe('user');

    testUserId = id;

    // 生成token
    authToken = generateToken({ userId: id, username, role: 'user' });
    expect(authToken).toBeTruthy();
  });

  // 2. 登录
  it('应该成功登录并验证密码', async () => {
    const user = queryOne('SELECT id, username, password_hash, role FROM users WHERE username = ?', ['testuser_integration']) as any;
    expect(user).toBeDefined();

    const isValid = await bcrypt.compare('test123456', user.password_hash);
    expect(isValid).toBe(true);

    // 验证token
    const decoded = verifyToken(authToken);
    expect(decoded.userId).toBe(testUserId);
    expect(decoded.username).toBe('testuser_integration');
  });

  // 3. 创建梦境
  it('应该成功创建梦境', () => {
    const id = crypto.randomUUID();
    const content = '我在星空下飞翔，看到了奇妙的景象';
    const emotion = 'wonder';
    const title = content.slice(0, 30);
    const now = new Date().toISOString();
    const date = now.slice(0, 10);

    run(
      'INSERT INTO dreams (id, user_id, title, content, emotion, recorded_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, testUserId, title, content, emotion, date, now, now]
    );

    const dream = queryOne('SELECT * FROM dreams WHERE id = ?', [id]) as any;
    expect(dream).toBeDefined();
    expect(dream.content).toBe(content);
    expect(dream.emotion).toBe(emotion);
    expect(dream.user_id).toBe(testUserId);

    testDreamId = id;
  });

  // 4. 获取梦境列表
  it('应该能获取用户的梦境列表', () => {
    const dreams = queryAll('SELECT * FROM dreams WHERE user_id = ? ORDER BY created_at DESC', [testUserId]);
    expect(dreams.length).toBeGreaterThanOrEqual(1);

    const dream = dreams.find((d: any) => d.id === testDreamId);
    expect(dream).toBeDefined();
  });

  // 5. 生成叙事
  it('应该成功生成叙事文本', () => {
    const dream = queryOne('SELECT * FROM dreams WHERE id = ?', [testDreamId]) as any;
    expect(dream).toBeDefined();

    const narrative = generateNarrative(dream.content, dream.emotion);
    expect(narrative).toBeTruthy();
    expect(narrative.length).toBeGreaterThan(0);

    // 更新梦境的叙事字段
    run('UPDATE dreams SET narrative = ?, updated_at = ? WHERE id = ?', [narrative, new Date().toISOString(), testDreamId]);

    const updated = queryOne('SELECT narrative FROM dreams WHERE id = ?', [testDreamId]) as any;
    expect(updated.narrative).toBe(narrative);
  });

  // 6. 收藏
  it('应该能切换收藏状态', () => {
    const dream = queryOne('SELECT is_favorite FROM dreams WHERE id = ?', [testDreamId]) as any;
    expect(dream.is_favorite).toBe(0);

    // 收藏
    run('UPDATE dreams SET is_favorite = 1, updated_at = ? WHERE id = ?', [new Date().toISOString(), testDreamId]);

    const favorited = queryOne('SELECT is_favorite FROM dreams WHERE id = ?', [testDreamId]) as any;
    expect(favorited.is_favorite).toBe(1);

    // 取消收藏
    run('UPDATE dreams SET is_favorite = 0, updated_at = ? WHERE id = ?', [new Date().toISOString(), testDreamId]);

    const unfavorited = queryOne('SELECT is_favorite FROM dreams WHERE id = ?', [testDreamId]) as any;
    expect(unfavorited.is_favorite).toBe(0);
  });

  // 7. 删除
  it('应该能删除梦境', () => {
    run('DELETE FROM dreams WHERE id = ? AND user_id = ?', [testDreamId, testUserId]);

    const deleted = queryOne('SELECT id FROM dreams WHERE id = ?', [testDreamId]);
    expect(deleted).toBeUndefined();
  });
});
