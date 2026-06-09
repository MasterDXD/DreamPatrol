/**
 * @module preload
 * @description Electron 预加载脚本。通过 contextBridge 安全地向渲染进程暴露 companionAPI，
 *              避免直接暴露 ipcRenderer 从而保障安全性。所有主进程通信均通过 IPC invoke
 *              （请求-响应）或 on（事件监听）完成，渲染进程无法直接访问 Node.js 或 Electron 内部 API。
 *
 * 暴露的 API 命名空间：window.companionAPI
 * - 代理与状态查询：proxyAPI, getStatus
 * - 窗口控制：toggleWindow, openDashboard, moveWindow, getWindowBounds,
 *             resetPosition, getWindowPosition, getScreenSize, setWindowSize
 * - 应用控制：sendCommand, quitApp, setIgnoreMouseEvents
 * - 事件监听：onSpeech, onPermissionRequest, onPermissionShortcut
 */
const { contextBridge, ipcRenderer } = require('electron');

const preloadState = {
  speechHandler: null,
  permHandler: null,
  permShortcutHandler: null,
};

const SAFE_ENDPOINT_RE = /^\/api\/[a-zA-Z0-9_/.-]{0,128}$/;
const MAX_CMD_LENGTH = 500;
const MAX_MOVE_OFFSET = 100;
const MIN_WINDOW_DIM = 100;
const MAX_WINDOW_DIM = 4096;

contextBridge.exposeInMainWorld('companionAPI', {
  /**
   * @description 通过主进程代理调用后端 API 端点
   * @param {string} endpoint - 需要代理请求的 API 端点路径
   * @returns {Promise<any>} 主进程返回的 API 响应数据
   */
  proxyAPI: (endpoint) => {
    if (typeof endpoint !== 'string' || !SAFE_ENDPOINT_RE.test(endpoint)) {
      return Promise.reject(new Error('Invalid endpoint'));
    }
    return ipcRenderer.invoke('proxy-api', endpoint);
  },

  /**
   * @description 获取当前伴侣应用的状态信息
   * @returns {Promise<Object>} 包含应用运行状态的对象
   */
  getStatus: () => ipcRenderer.invoke('get-companion-status'),

  /**
   * @description 切换伴侣窗口的显示/隐藏状态
   * @returns {Promise<void>}
   */
  toggleWindow: () => ipcRenderer.invoke('toggle-window'),

  /**
   * @description 在默认浏览器中打开 Harness 监控仪表盘
   * @returns {Promise<void>}
   */
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),

  /**
   * @description 向主进程发送斜杠命令或操作指令
   * @param {string} cmd - 要执行的命令字符串
   * @returns {Promise<any>} 命令执行结果
   */
  sendCommand: (cmd) => {
    if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > MAX_CMD_LENGTH) {
      return Promise.reject(new Error('Invalid command'));
    }
    return ipcRenderer.invoke('send-command', cmd);
  },

  /**
   * @description 按偏移量移动伴侣窗口位置
   * @param {number} dx - 水平方向偏移量（像素），正值向右移动
   * @param {number} dy - 垂直方向偏移量（像素），正值向下移动
   * @returns {Promise<void>}
   */
  moveWindow: (dx, dy) => {
    if (typeof dx !== 'number' || typeof dy !== 'number' ||
        !Number.isFinite(dx) || !Number.isFinite(dy) ||
        Math.abs(dx) > MAX_MOVE_OFFSET || Math.abs(dy) > MAX_MOVE_OFFSET) {
      return Promise.reject(new Error('Invalid move offset'));
    }
    return ipcRenderer.invoke('move-window', dx, dy);
  },

  /**
   * @description 获取伴侣窗口的位置与尺寸信息
   * @returns {Promise<Electron.Rectangle>} 包含 x、y、width、height 属性的窗口边界对象
   */
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),

  /**
   * @description 将伴侣窗口位置重置为默认位置
   * @returns {Promise<void>}
   */
  resetPosition: () => ipcRenderer.invoke('reset-position'),

  /**
   * @description 退出应用程序
   * @returns {Promise<void>}
   */
  quitApp: () => ipcRenderer.invoke('quit-app'),

  /**
   * @description 设置窗口是否忽略鼠标事件（用于穿透点击）
   * @param {boolean} ignore - 是否忽略鼠标事件，true 为穿透模式
   * @param {Object} [options] - 额外选项，如 { forward: true } 表示仅在前方窗口忽略
   * @returns {Promise<void>}
   */
  setIgnoreMouseEvents: (ignore, options) => {
    if (typeof ignore !== 'boolean') {
      return Promise.reject(new Error('Invalid ignore value'));
    }
    return ipcRenderer.invoke('set-ignore-mouse-events', ignore, options);
  },

  /**
   * @description 获取伴侣窗口的当前坐标位置
   * @returns {Promise<{x: number, y: number}>} 窗口左上角的屏幕坐标
   */
  getWindowPosition: () => ipcRenderer.invoke('get-window-position'),

  /**
   * @description 获取主屏幕的尺寸信息
   * @returns {Promise<{width: number, height: number}>} 屏幕的宽度和高度（像素）
   */
  getScreenSize: () => ipcRenderer.invoke('get-screen-size'),

  /**
   * @description 设置伴侣窗口的尺寸
   * @param {number} w - 窗口宽度（像素）
   * @param {number} h - 窗口高度（像素）
   * @returns {Promise<void>}
   */
  setWindowSize: (w, h) => {
    if (typeof w !== 'number' || typeof h !== 'number' ||
        !Number.isFinite(w) || !Number.isFinite(h) ||
        w < MIN_WINDOW_DIM || h < MIN_WINDOW_DIM ||
        w > MAX_WINDOW_DIM || h > MAX_WINDOW_DIM) {
      return Promise.reject(new Error('Invalid window size'));
    }
    return ipcRenderer.invoke('set-window-size', w, h);
  },

  /**
   * @description 监听主进程推送的语音合成文本事件。每次调用会移除之前的监听器，确保仅保留一个回调。
   * @param {function(string): void} callback - 接收语音文本的回调函数
   * @returns {void}
   */
  onSpeech: (callback) => {
    if (typeof callback !== 'function') return;
    const handler = (_event, text) => callback(text);
    if (preloadState.speechHandler) ipcRenderer.removeListener('companion-speech', preloadState.speechHandler);
    preloadState.speechHandler = handler;
    ipcRenderer.on('companion-speech', handler);
  },

  /**
   * @description 监听主进程推送的权限请求事件。每次调用会移除之前的监听器，确保仅保留一个回调。
   * @param {function(Object): void} callback - 接收权限请求数据的回调函数
   * @returns {void}
   */
  onPermissionRequest: (callback) => {
    if (typeof callback !== 'function') return;
    const handler = (_event, data) => callback(data);
    if (preloadState.permHandler) ipcRenderer.removeListener('permission-request', preloadState.permHandler);
    preloadState.permHandler = handler;
    ipcRenderer.on('permission-request', handler);
  },

  /**
   * @description 监听主进程推送的权限快捷操作事件。每次调用会移除之前的监听器，确保仅保留一个回调。
   * @param {function(string): void} callback - 接收快捷操作标识的回调函数（如 'approve' 或 'deny'）
   * @returns {void}
   */
  onPermissionShortcut: (callback) => {
    if (typeof callback !== 'function') return;
    const handler = (_event, action) => callback(action);
    if (preloadState.permShortcutHandler) ipcRenderer.removeListener('permission-shortcut', preloadState.permShortcutHandler);
    preloadState.permShortcutHandler = handler;
    ipcRenderer.on('permission-shortcut', handler);
  },
});
