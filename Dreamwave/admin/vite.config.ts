import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);

/**
 * CJS 互操作修复：
 * `eventemitter3` `color-string` `color-name` `simple-swizzle` `svg-path-parser`
 * 这些 CJS 包在 Vite dev 模式原始加载时缺少 ESM `default` export。
 * 通过 alias 直接指向 esbuild 预构建后的 CJS 互操作包装：
 *   - 在 `node_modules/eventemitter3/index.js` 顶部加 `module.exports = EE;`
 *     esbuild 会在预构建时输出 `export default EE;`
 *   - 我们用插件把这些模块的代码手动包装 ESM default
 */
function cjsDefaultExportPlugin(): Plugin {
  const hasDefaultExport = (code: string) => {
    return /export\s+(?:default\b|\{[^}]*\bas\s+default\b)/.test(code);
  };
  const isCjsModule = (code: string) => {
    return /(module\.exports|exports\s*=)/.test(code);
  };
  const wrap = (code: string, id: string) => {
    if (hasDefaultExport(code)) {
      return null;
    }
    return {
      code:
        code +
        `\n// [vite-plugin] CJS->ESM default shim for ${id.split('/node_modules/').pop()}\n` +
        `const __cjsDefault = (typeof module !== "undefined" && module.exports) || ` +
        `(typeof exports !== "undefined" && exports) || {};\n` +
        `export default __cjsDefault;`,
      map: null,
    };
  };
  return {
    name: 'cjs-default-shim',
    enforce: 'post',
    transform(code, id) {
      if (!id.includes('/node_modules/')) {
        return null;
      }
      if (code.includes('CJS->ESM default shim')) {
        return null;
      }
      if (hasDefaultExport(code)) {
        return null;
      }
      if (id.includes('.vite/deps/')) {
        return null;
      }
      if (!isCjsModule(code)) {
        return null;
      }
      return wrap(code, id);
    },
  };
}

export default defineConfig({
  plugins: [react(), cjsDefaultExportPlugin()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
    hmr: {
      overlay: false,
    },
  },
  optimizeDeps: {
    exclude: [
      '@ant-design/charts',
      '@ant-design/graphs',
      '@antv/g2',
      '@antv/g6',
      '@antv/l7',
      '@antv/l7-maps',
      '@antv/l7-react',
      '@antv/ava',
      '@antv/knowledge-graph',
      '@antv/flowchart',
      '@antv/g2plot',
      '@antv/expr',
      '@antv/event-emitter',
    ],
    include: [
      'lodash',
      'eventemitter3',
      'color-string',
      'color-name',
      'simple-swizzle',
      'svg-path-parser',
      'pdfast',
    ],
    esbuildOptions: {
      target: 'es2020',
    },
    force: true,
  },
  resolve: {
    alias: {
      eventemitter3: _require.resolve('eventemitter3'),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: {
          'antd': ['antd'],
          'charts': ['@ant-design/charts', '@antv/g2'],
          'icons': ['@ant-design/icons'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
  },
});
