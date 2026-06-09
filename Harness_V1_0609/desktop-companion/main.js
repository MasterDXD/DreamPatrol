/**
 * @module desktop-companion/main
 * @description Harness 桌面伙伴 Electron 主进程入口。
 * 负责创建无边框透明窗口、系统托盘、全局快捷键，
 * 以及通过 IPC 桥接渲染进程与 Harness 后端 API 的通信。
 * 窗口默认定位在屏幕右下角，尺寸 276×380，始终置顶。
 */
const { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain, shell, globalShortcut } = require('electron');
const path = require('path');
const http = require('http');

/** Harness 后端 API 基地址 */
const HARNESS_API = 'http://localhost:3210';
/** API 认证令牌，从环境变量读取 */
const HARNESS_API_TOKEN = process.env.HARNESS_API_TOKEN || '';
/** 主窗口默认宽度 */
const WIN_WIDTH = 276;
/** 主窗口默认高度 */
const WIN_HEIGHT = 380;
/** 窗口水平偏移（屏幕右边缘距离） */
const WIN_OFFSET_X = 310;
/** 窗口垂直偏移（屏幕底边缘距离） */
const WIN_OFFSET_Y = 420;
/** 主窗口实例引用 */
let mainWindow = null;
/** 系统托盘实例引用 */
let tray = null;
/** IPC速率限制追踪器 */
const _ipcRateLimit = new Map();
const IPC_RATE_WINDOW = 1000;
const IPC_RATE_MAX = 8;

function _checkRateLimit(channel) {
  const now = Date.now();
  const record = _ipcRateLimit.get(channel);
  if (!record || now - record.windowStart > IPC_RATE_WINDOW) {
    _ipcRateLimit.set(channel, { windowStart: now, count: 1 });
    return true;
  }
  record.count++;
  if (record.count > IPC_RATE_MAX) {
    console.warn('[Companion] IPC速率限制:', channel, 'count:', record.count);
    return false;
  }
  return true;
}

function _sanitizeError(e) {
  return typeof e === 'object' && e !== null && e.message ? 'Internal error' : String(e);
}

function safeOpenExternal(url) {
  try {
    var parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    shell.openExternal(url);
  } catch {}
}

function safeSend(channel, ...args) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.webContents.send(channel, ...args); } catch {}
}

/**
 * @description 校验 API 端点路径是否合法
 * @param {string} endpoint - 待校验的端点路径
 * @returns {boolean} 端点以 /api/ 开头时返回 true
 */
function isValidEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('/api/')) return false;
  try {
    var pathname = new URL(endpoint, 'http://localhost').pathname;
    if (pathname.includes('..')) return false;
    return pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * @description 检测 Harness 后端 API 是否可用
 * @returns {Promise<boolean>} API 健康检查通过返回 true，否则返回 false
 */
function checkHarnessAPI() {
  return new Promise((resolve) => {
    var resolved = false;
    function safeResolve(val) { if (!resolved) { resolved = true; resolve(val); } }
    const req = http.get(`${HARNESS_API}/api/health`, (res) => {
      res.resume();
      safeResolve(res.statusCode === 200);
    });
    req.on('error', () => safeResolve(false));
    req.setTimeout(2000, () => { req.destroy(); safeResolve(false); });
  });
}

/**
 * @description 通过 GET 请求代理访问 Harness 后端 API
 * @param {string} endpoint - API 端点路径，如 '/api/agents'
 * @returns {Promise<{ok: boolean, data: object|null, status: number}>}
 *   ok 为响应状态码是否在 2xx 范围，data 为解析后的 JSON，status 为 HTTP 状态码
 */
var MAX_RESPONSE_SIZE = 5 * 1024 * 1024;

function proxyAPI(endpoint) {
  if (!isValidEndpoint(endpoint)) {
    return Promise.resolve({ ok: false, data: null, status: 0, error: 'Endpoint not allowed' });
  }
  return new Promise((resolve) => {
    var resolved = false;
    function safeResolve(val) { if (!resolved) { resolved = true; resolve(val); } }
    var parsed = new URL(endpoint, 'http://localhost');
    const url = `${HARNESS_API}${parsed.pathname}${parsed.search}`;
    const headers = HARNESS_API_TOKEN ? { Authorization: `Bearer ${HARNESS_API_TOKEN}` } : {};
    const req = http.get(url, { headers }, (res) => {
      let data = '';
      var size = 0;
      var aborted = false;
      res.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_RESPONSE_SIZE) { aborted = true; req.destroy(); safeResolve({ ok: false, data: null, status: res.statusCode, error: 'response too large' }); return; }
        data += chunk;
      });
      res.on('end', () => {
        if (resolved) return;
        try {
          safeResolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data: JSON.parse(data), status: res.statusCode });
        } catch (e) {
          console.warn('[Companion] JSON解析失败:', parsed.pathname, e.message);
          safeResolve({ ok: false, data: null, status: res.statusCode });
        }
      });
    });
    req.on('error', (e) => safeResolve({ ok: false, data: null, status: 0, error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); safeResolve({ ok: false, data: null, status: 0, error: 'timeout' }); });
  });
}

/**
 * @description 通过 POST 请求向 Harness 后端 API 发送数据
 * @param {string} endpoint - API 端点路径
 * @param {object} [body] - 请求体，将被序列化为 JSON
 * @returns {Promise<{ok: boolean, data: object|null, status: number}>}
 *   ok 为响应状态码是否在 2xx 范围，data 为解析后的 JSON，status 为 HTTP 状态码
 */
function postAPI(endpoint, body) {
  if (!isValidEndpoint(endpoint)) {
    return Promise.resolve({ ok: false, data: null, status: 0, error: 'Endpoint not allowed' });
  }
  return new Promise((resolve) => {
    var resolved = false;
    function safeResolve(val) { if (!resolved) { resolved = true; resolve(val); } }
    var parsed = new URL(endpoint, 'http://localhost');
    const url = `${HARNESS_API}${parsed.pathname}${parsed.search}`;
    const payload = JSON.stringify(body || {});
    if (Buffer.byteLength(payload) > 1024 * 1024) {
      safeResolve({ ok: false, data: null, status: 0, error: 'payload too large' });
      return;
    }
    const reqHeaders = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (HARNESS_API_TOKEN) reqHeaders.Authorization = `Bearer ${HARNESS_API_TOKEN}`;
    const req = http.request(url, {
      method: 'POST',
      headers: reqHeaders,
    }, (res) => {
      let data = '';
      var size = 0;
      var aborted = false;
      res.on('data', (chunk) => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_RESPONSE_SIZE) { aborted = true; req.destroy(); safeResolve({ ok: false, data: null, status: res.statusCode, error: 'response too large' }); return; }
        data += chunk;
      });
      res.on('end', () => {
        if (resolved) return;
        try {
          safeResolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data: JSON.parse(data), status: res.statusCode });
        } catch (e) {
          console.warn('[Companion] POST JSON解析失败:', parsed.pathname, e.message);
          safeResolve({ ok: false, data: null, status: res.statusCode });
        }
      });
    });
    req.on('error', (e) => safeResolve({ ok: false, data: null, status: 0, error: e.message }));
    req.setTimeout(5000, () => { req.destroy(); safeResolve({ ok: false, data: null, status: 0, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

/**
 * @description 创建 Electron 主窗口。
 * 窗口为无边框透明置顶模式，定位在屏幕右下角，
 * 启用上下文隔离和预加载脚本以保障渲染进程安全。
 */
function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    x: screenWidth - WIN_OFFSET_X,
    y: screenHeight - WIN_OFFSET_Y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    // 不在任务栏显示窗口图标
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 安全设置：禁用 Node.js 集成，启用上下文隔离
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  // macOS 全工作空间可见
  mainWindow.setVisibleOnAllWorkspaces(true);
  mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * @description 创建系统托盘图标及右键菜单。
 * 菜单包含：显示伙伴、打开控制台、角色状态、技能状态、退出。
 * 单击托盘图标切换窗口显示/隐藏。
 */
function createTray() {
  const iconPath = path.join(__dirname, 'src', 'icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    // 图标文件不存在或为空时使用空白图标兜底
    if (trayIcon.isEmpty()) trayIcon = nativeImage.createEmpty();
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  // 托盘图标缩放至 16×16 适配系统托盘
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
  tray.setToolTip('驭 · 桌面伙伴');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示伙伴',
      click: () => { if (!mainWindow) createWindow(); else { mainWindow.show(); mainWindow.focus(); } },
    },
    {
      label: '打开控制台',
      click: () => { safeOpenExternal(HARNESS_API); },
    },
    { type: 'separator' },
    {
      label: '角色状态',
      click: async () => {
        try {
          const res = await proxyAPI('/api/agents');
          if (res.ok && mainWindow) {
            const agents = res.data.agents || res.data;
            const count = Array.isArray(agents) ? agents.length : 0;
            // 统计活跃角色数（status 为 active 或 running 标记）
            const active = Array.isArray(agents) ? agents.filter((a) => {
              if (!a || typeof a !== 'object') return false;
              var st = a.status || a.state || '';
              return st === 'active' || st === 'running' || a.running === true;
            }).length : 0;
            safeSend('companion-speech', `${active}/${count} 个角色活跃`);
          }
        } catch {
          safeSend('companion-speech', 'API不可用');
        }
      },
    },
    {
      label: '技能状态',
      click: async () => {
        try {
          const res = await proxyAPI('/api/skills');
          if (res.ok && mainWindow) {
            const skills = res.data.skills || res.data;
            // 兼容数组和对象两种返回格式
            const count = Array.isArray(skills) ? skills.length : (typeof skills === 'object' ? Object.keys(skills).length : 0);
            safeSend('companion-speech', `${count} 个技能已加载`);
          }
        } catch {
          safeSend('companion-speech', 'API不可用');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => { app.quit(); },
    },
  ]);

  tray.setContextMenu(contextMenu);
  // 单击托盘图标切换窗口可见性
  tray.on('click', () => {
    if (!mainWindow) createWindow();
    else if (mainWindow.isVisible()) { mainWindow.hide(); }
    else { mainWindow.show(); mainWindow.focus(); }
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); process.exit(0); }

app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

// 应用就绪后初始化窗口、托盘和快捷键
app.whenReady().then(() => {
  createWindow();
  createTray();
  registerShortcuts();
  app.on('activate', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createWindow();
  });
}).catch((e) => {
  console.error('[Companion] 初始化失败:', e.message);
  app.quit();
});

// 应用退出前注销所有全局快捷键
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
});

/**
 * @description 注册全局快捷键。
 * - Cmd/Ctrl+Shift+H：切换伙伴窗口显示/隐藏
 * - Cmd/Ctrl+Shift+Y：快捷批准权限请求
 * - Cmd/Ctrl+Shift+N：快捷拒绝权限请求
 */
function registerShortcuts() {
  try {
    globalShortcut.register('CommandOrControl+Shift+H', () => {
      if (!mainWindow) createWindow();
      else if (mainWindow.isVisible()) mainWindow.hide();
      else { mainWindow.show(); mainWindow.focus(); }
    });
    globalShortcut.register('CommandOrControl+Shift+Y', () => {
      safeSend('permission-shortcut', 'approve');
    });
    globalShortcut.register('CommandOrControl+Shift+N', () => {
      safeSend('permission-shortcut', 'deny');
    });
  } catch (e) { console.warn('[Companion] 快捷键注册失败:', e.message); }
}

// 非 macOS 平台关闭所有窗口后退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * @description IPC 处理器：代理渲染进程的 API 请求。
 * 仅允许以 /api/ 开头的端点，防止路径遍历攻击。
 * @param {Electron.IpcMainInvokeEvent} _event - IPC 事件（未使用）
 * @param {string} endpoint - 请求的 API 端点路径
 * @returns {Promise<{ok: boolean, data: object|null, error?: string}>} 代理请求结果
 */
ipcMain.handle('proxy-api', async (_event, endpoint) => {
  if (!_checkRateLimit('proxy-api')) {
    return { ok: false, data: null, error: 'Rate limited' };
  }
  if (!isValidEndpoint(endpoint)) {
    return { ok: false, data: null, error: 'Endpoint not allowed' };
  }
  try { return await proxyAPI(endpoint); }
  catch (e) { return { ok: false, data: null, error: _sanitizeError(e) }; }
});

/**
 * @description IPC 处理器：获取桌面伙伴运行状态
 * @returns {Promise<{status: string, version: string, apiConnected: boolean}>}
 *   status 固定为 'active'，version 为应用版本号，apiConnected 为后端连接状态
 */
ipcMain.handle('get-companion-status', async () => {
  const connected = await checkHarnessAPI();
  return { status: 'active', version: app.getVersion(), apiConnected: connected };
});

/**
 * @description IPC 处理器：切换主窗口显示/隐藏
 * @returns {Promise<void>}
 */
ipcMain.handle('toggle-window', async () => {
  if (mainWindow) {
    if (mainWindow.isVisible()) mainWindow.hide();
    else { mainWindow.show(); mainWindow.focus(); }
  }
});

/**
 * @description IPC 处理器：在默认浏览器中打开 Harness 控制台
 * @returns {Promise<void>}
 */
ipcMain.handle('open-dashboard', async () => {
  safeOpenExternal(HARNESS_API);
});

/**
 * @description IPC 处理器：向 Harness 后端发送斜杠命令
 * @param {Electron.IpcMainInvokeEvent} _event - IPC 事件（未使用）
 * @param {string} cmd - 斜杠命令文本
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>} 命令执行结果
 */
ipcMain.handle('send-command', async (_event, cmd) => {
  if (!_checkRateLimit('send-command')) {
    return { ok: false, error: 'Rate limited' };
  }
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return { ok: false, error: 'Invalid command' };
  }
  if (cmd.length > 500) {
    return { ok: false, error: 'Command too long' };
  }
  try {
    const res = await postAPI('/api/command', { command: cmd });
    return res;
  } catch (e) {
    return { ok: false, error: _sanitizeError(e) };
  }
});

/**
 * @description IPC 处理器：按偏移量移动主窗口位置
 * @param {Electron.IpcMainInvokeEvent} _event - IPC 事件（未使用）
 * @param {number} dx - 水平偏移量（像素）
 * @param {number} dy - 垂直偏移量（像素）
 * @returns {Promise<void>}
 */
ipcMain.handle('move-window', async (_event, dx, dy) => {
  if (!mainWindow) return;
  if (typeof dx !== 'number' || typeof dy !== 'number' || !isFinite(dx) || !isFinite(dy)) return;
  if (Math.abs(dx) > 100 || Math.abs(dy) > 100) return;
  try {
    const [x, y] = mainWindow.getPosition();
    const nx = x + Math.round(dx);
    const ny = y + Math.round(dy);
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const bounds = mainWindow.getBounds();
    if (nx + bounds.width < 50 || nx > sw - 50 || ny + bounds.height < 50 || ny > sh - 50) return;
    mainWindow.setPosition(nx, ny);
  } catch (e) { console.warn('[Companion] move-window:', e.message); }
});

/**
 * @description IPC 处理器：获取主窗口的位置和尺寸信息
 * @returns {Promise<Electron.Rectangle|null>} 窗口边界矩形，窗口不存在时返回 null
 */
ipcMain.handle('get-window-bounds', async () => {
  if (!mainWindow) return null;
  try {
    return mainWindow.getBounds();
  } catch (e) { console.warn('[Companion] get-window-bounds:', e.message); return null; }
});

/**
 * @description IPC 处理器：将主窗口重置到屏幕右下角默认位置
 * @returns {Promise<void>}
 */
ipcMain.handle('reset-position', async () => {
  if (!mainWindow) return;
  try {
    const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
    mainWindow.setPosition(screenWidth - WIN_OFFSET_X, screenHeight - WIN_OFFSET_Y);
  } catch (e) { console.warn('[Companion] reset-position:', e.message); }
});

/**
 * @description IPC 处理器：设置主窗口是否忽略鼠标事件（穿透模式）
 * @param {Electron.IpcMainInvokeEvent} _event - IPC 事件（未使用）
 * @param {boolean} ignore - 是否忽略鼠标事件
 * @param {Electron.SetIgnoreMouseEventsOptions} [options] - 附加选项，如 { forward: true }
 * @returns {Promise<void>}
 */
ipcMain.handle('set-ignore-mouse-events', async (_event, ignore, options) => {
  if (!mainWindow) return;
  if (typeof ignore !== 'boolean') return;
  try {
    var safeOptions = {};
    if (options && typeof options === 'object' && typeof options.forward === 'boolean') {
      safeOptions.forward = options.forward;
    }
    mainWindow.setIgnoreMouseEvents(ignore, safeOptions);
  } catch (e) { console.warn('[Companion] set-ignore-mouse-events:', e.message); }
});

/**
 * @description IPC 处理器：获取主窗口当前位置坐标
 * @returns {Promise<[number, number]|null>} [x, y] 坐标数组，窗口不存在时返回 null
 */
ipcMain.handle('get-window-position', async () => {
  if (!mainWindow) return null;
  try {
    return mainWindow.getPosition();
  } catch (e) { console.warn('[Companion] get-window-position:', e.message); return null; }
});

/**
 * @description IPC 处理器：获取主屏幕工作区尺寸
 * @returns {Promise<{width: number, height: number}>} 屏幕宽高，获取失败时返回 1920×1080 兜底值
 */
ipcMain.handle('get-screen-size', async () => {
  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return { width, height };
  } catch (e) { console.warn('[Companion] get-screen-size:', e.message); return { width: 1920, height: 1080 }; }
});

/**
 * @description IPC 处理器：动态调整主窗口尺寸
 * @param {Electron.IpcMainInvokeEvent} _event - IPC 事件（未使用）
 * @param {number} w - 目标宽度（像素）
 * @param {number} h - 目标高度（像素）
 * @returns {Promise<void>}
 */
ipcMain.handle('set-window-size', async (_event, w, h) => {
  if (!mainWindow) return;
  if (typeof w !== 'number' || typeof h !== 'number' || !isFinite(w) || !isFinite(h) || w < 100 || h < 100 || w > 4000 || h > 4000) return;
  try {
    mainWindow.setSize(Math.round(w), Math.round(h));
  } catch (e) { console.warn('[Companion] set-window-size:', e.message); }
});

/**
 * @description IPC 处理器：退出应用
 * @returns {Promise<void>}
 */
ipcMain.handle('quit-app', async () => {
  app.quit();
});
