import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

/**
 * 全局兜底：等待 Material Symbols 字体加载完成后再让图标显色，
 * 避免出现 "arrow_right_alt" / "volume_up" 等英文文本节点。
 *
 * 使用 FontFaceSet API 检查图标字体是否就绪；
 * 未就绪时这些 span 是透明的（见 index.html 的 .material-symbols-outlined 样式）。
 */
if (typeof document !== 'undefined' && (document as any).fonts) {
  const fonts = (document as any).fonts as FontFaceSet;
  const markIconsReady = () => {
    document
      .querySelectorAll<HTMLElement>('.material-symbols-outlined')
      .forEach((el) => el.classList.add('fonts-ready'));
  };
  if (fonts.status === 'loaded') {
    markIconsReady();
  } else {
    fonts.ready.then(() => {
      markIconsReady();
      // 后续动态插入的图标也需补上 class
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node) => {
            if (!(node instanceof HTMLElement)) return;
            if (node.classList?.contains('material-symbols-outlined')) {
              node.classList.add('fonts-ready');
            }
            node.querySelectorAll?.('.material-symbols-outlined').forEach((el) =>
              el.classList.add('fonts-ready'),
            );
          });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
