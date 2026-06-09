import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 修复 `@antv/expr` 的 esbuild 解析失败：
 * 该模块内部用 `${...}` 模板字符串模拟 DSL，esbuild 在预构建时会报
 * "Unexpected character: }"。我们使用插件拦截 `import '@antv/expr'`
 * 直接返回一段空 stub（G2 仅在高级表达式功能中用到，统计/折线图不需要）。
 */
function antvExprStubPlugin(): Plugin {
  return {
    name: 'antv-expr-stub',
    enforce: 'pre',
    resolveId(id) {
      if (id === '@antv/expr' || id.endsWith('/@antv/expr')) {
        return '\0virtual:antv-expr-stub';
      }
      return null;
    },
    load(id) {
      if (id === '\0virtual:antv-expr-stub') {
        return 'export default new Proxy({}, { get: () => () => ({}) });';
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [react(), antvExprStubPlugin()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    // 显式强制预构建所有 d3 / antv CJS 子包，让 esbuild 生成正确的 ESM 互操作
    include: [
      'eventemitter3',
      'color-string',
      'color-name',
      'simple-swizzle',
      'svg-path-parser',
      '@antv/util',
      '@antv/event-emitter',
      '@antv/algorithm',
      '@antv/scale',
      '@antv/coord',
      '@antv/component',
      'd3-array',
      'd3-shape',
      'd3-scale',
      'd3-color',
      'd3-interpolate',
      'd3-time',
      'd3-time-format',
      'd3-path',
      'd3-format',
    ],
    esbuildOptions: {
      target: 'es2020',
    },
  },
});
