import 'dotenv/config';
import app from './app';
import { getDatabase, closeDatabase } from './db/database';
import { seedDatabase } from './seed';

// 修复终端中文乱码：强制UTF-8输出
if (process.stdout && typeof process.stdout.setEncoding === 'function') {
  process.stdout.setEncoding('utf8');
}
if (process.stderr && typeof process.stderr.setEncoding === 'function') {
  process.stderr.setEncoding('utf8');
}

const PORT = process.env.PORT || 3100;

async function start() {
  try {
    await getDatabase();
    console.log('[Dreamwave] 数据库初始化完成');

    // 初始化种子数据
    try {
      await seedDatabase();
    } catch (seedErr) {
      console.warn('[Dreamwave] 种子数据初始化跳过:', seedErr);
    }

    const server = app.listen(PORT, () => {
      console.log(`[Dreamwave] 后端服务已启动: http://localhost:${PORT}`);
      console.log(`[Dreamwave] API地址: http://localhost:${PORT}/api`);
    });

    const shutdown = () => {
      console.log('[Dreamwave] 正在关闭服务...');
      server.close();
      closeDatabase();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // 全局异常处理器
    process.on('unhandledRejection', (reason) => {
      console.error('[Dreamwave] Unhandled Rejection:', reason);
    });
    process.on('uncaughtException', (err) => {
      console.error('[Dreamwave] Uncaught Exception:', err);
      // uncaughtException 后进程可能处于不稳定状态，安全退出
      shutdown();
    });
  } catch (err) {
    console.error('[Dreamwave] 启动失败:', err);
    process.exit(1);
  }
}

start();
