import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // 在测试环境启动前设置JWT_SECRET，避免auth模块加载时process.exit
    env: {
      JWT_SECRET: 'test-secret-for-unit-testing',
    },
  },
});
