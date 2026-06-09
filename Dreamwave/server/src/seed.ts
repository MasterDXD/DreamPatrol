import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { getDatabase, run, queryOne } from './db/database';

// 种子数据：6条示例梦境，覆盖所有6种情绪
const seedDreams = [
  {
    title: '金色麦田上的飞翔',
    content: '昨晚梦见在一片金色的麦田上飞翔，阳光温暖地洒在脸上，风从耳边呼啸而过，感觉无比自由。远处有一座小木屋，炊烟袅袅升起。',
    emotion: 'joy',
    tags: ['飞翔', '自然', '自由'],
  },
  {
    title: '湖边的宁静',
    content: '梦里坐在湖边，水面像镜子一样平静，倒映着远处的雪山。一只白鹭慢慢飞过，留下一道优美的弧线。一切都那么安宁。',
    emotion: 'calm',
    tags: ['自然', '宁静', '山水'],
  },
  {
    title: '空荡的老房子',
    content: '梦见回到了小时候的老房子，但房子已经空了。推开每扇门，都是回忆的画面，但伸手却什么也抓不住。窗外的雨一直下。',
    emotion: 'sadness',
    tags: ['童年', '回忆', '雨'],
  },
  {
    title: '无尽的走廊',
    content: '在一条没有尽头的走廊里奔跑，身后有什么东西在追赶。走廊的灯一盏接一盏熄灭，黑暗越来越近，但怎么也找不到出口。',
    emotion: 'fear',
    tags: ['追逐', '黑暗', '迷宫'],
  },
  {
    title: '蝴蝶的魔法世界',
    content: '梦见自己变成了一只蝴蝶，在巨大的花朵间穿梭。花瓣比房子还大，露珠像水晶球一样闪烁。整个世界色彩斑斓，充满魔法。',
    emotion: 'wonder',
    tags: ['变身', '魔法', '色彩'],
  },
  {
    title: '外婆家的院子',
    content: '梦见了外婆家的院子，那棵老槐树还在。外婆坐在树下摇着蒲扇，桌上摆着切好的西瓜。蝉鸣声此起彼伏，一切都和记忆中一模一样。',
    emotion: 'nostalgia',
    tags: ['童年', '亲情', '夏天'],
  },
];

// 标签颜色映射
const tagColors: Record<string, string> = {
  '飞翔': '#FFD700',
  '自然': '#4CAF50',
  '自由': '#64B5F6',
  '宁静': '#81C784',
  '山水': '#26A69A',
  '童年': '#FFB74D',
  '回忆': '#CE93D8',
  '雨': '#90CAF9',
  '追逐': '#EF5350',
  '黑暗': '#78909C',
  '迷宫': '#AB47BC',
  '变身': '#FF7043',
  '魔法': '#E040FB',
  '色彩': '#FF4081',
  '亲情': '#FF8A65',
  '夏天': '#FFCA28',
};

/**
 * 种子数据初始化：只在数据库为空时创建
 */
export async function seedDatabase(): Promise<void> {
  await getDatabase();

  // 确保管理员账号存在（如果不存在则创建）
  const existingAdmin = queryOne('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!existingAdmin) {
    console.log('[Seed] 创建管理员账号...');
    const adminId = crypto.randomUUID();
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const adminHash = await bcrypt.hash(adminPassword, 10);
    run(
      'INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?)',
      [adminId, 'admin', adminHash, 'admin', 1]
    );
  }

  // 检查demo用户是否已存在，存在则跳过其他种子数据
  const existingDemo = queryOne('SELECT id FROM users WHERE username = ?', ['demo']);
  if (existingDemo) {
    console.log('[Seed] 种子数据已存在，跳过初始化');
    return;
  }

  console.log('[Seed] 开始创建种子数据...');

  // 创建测试用户
  const userId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash('123456', 10);
  run(
    'INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?)',
    [userId, 'demo', passwordHash, 'user', 1]
  );

  // 获取今天日期，用于计算近期日期
  const today = new Date();

  // 创建标签（去重）
  const allTagNames = [...new Set(seedDreams.flatMap(d => d.tags))];
  const tagIdMap: Record<string, string> = {};

  for (const name of allTagNames) {
    const tagId = crypto.randomUUID();
    const color = tagColors[name] || '#7EB8DA';
    run(
      'INSERT INTO tags (id, user_id, name, color) VALUES (?, ?, ?, ?)',
      [tagId, userId, name, color]
    );
    tagIdMap[name] = tagId;
  }

  // 创建梦境及关联标签
  for (let i = 0; i < seedDreams.length; i++) {
    const dream = seedDreams[i];
    const dreamId = crypto.randomUUID();
    const now = new Date().toISOString();

    // recorded_date 使用近期日期（今天减0-5天）
    const dateOffset = i % 6;
    const recordedDate = new Date(today);
    recordedDate.setDate(recordedDate.getDate() - dateOffset);
    const dateStr = recordedDate.toISOString().slice(0, 10);

    run(
      'INSERT INTO dreams (id, user_id, title, content, emotion, recorded_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [dreamId, userId, dream.title, dream.content, dream.emotion, dateStr, now, now]
    );

    // 关联标签
    for (const tagName of dream.tags) {
      const tagId = tagIdMap[tagName];
      if (tagId) {
        run(
          'INSERT INTO dream_tags (dream_id, tag_id) VALUES (?, ?)',
          [dreamId, tagId]
        );
      }
    }
  }

  console.log('[Seed] 种子数据创建完成：1个测试用户(demo/123456)，6条示例梦境');
}
