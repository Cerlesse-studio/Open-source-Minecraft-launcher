const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { readElectronFuses } = require('./fuses.cjs');
const { collectBaselineReport } = require('./measure-baseline.cjs');

const bootStartTime = performance.now();
let readyInteractiveMs = null;

// ============================================================================
// [L2 4.2] 禁用不需要的 Chromium 特性与后台遥测开关（必须在 app.whenReady 前调用）
// ============================================================================
const DISABLED_CHROMIUM_FEATURES = [
  'MediaRouter',
  'OptimizationHints',
  'Translate',
  'AutofillServerCommunication',
  'CalculateNativeWinOcclusion',
  'HardwareMediaKeyHandling',
  'WebOTP',
  'WebPayments',
  'WebUSB',
  'WebBluetooth',
  'WebXR',
];

const DISABLED_CHROMIUM_SWITCHES = [
  'disable-component-update',
  'no-pings',
  'disable-background-networking',
  'disable-domain-reliability',
  'disable-print-preview',
  'disable-speech-api',
  'disable-sync',
];

app.commandLine.appendSwitch('disable-features', DISABLED_CHROMIUM_FEATURES.join(','));
for (const sw of DISABLED_CHROMIUM_SWITCHES) {
  app.commandLine.appendSwitch(sw);
}

// ============================================================================
// [L2 4.3] 渲染进程安全基线配置
// ============================================================================
const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
});

const PACKAGED_CSP = [
  "default-src 'self' launcher:",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' launcher:",
  "style-src 'self' 'unsafe-inline' launcher:",
  "img-src 'self' data: blob: https: http: launcher:",
  "font-src 'self' data: launcher:",
  "connect-src 'self' https: http: launcher:",
  "media-src 'self' data: blob: launcher:",
  "frame-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/**
 * [第 8 节 & 第 10.3 节] 对被裁剪的功能（打印、PDF 导出）提供明确的降级失败行为，避免静默失败或崩溃
 * @param {import('electron').WebContents} webContents
 */
function applyPrunedFeatureGuards(webContents) {
  if (!webContents) return;
  webContents.print = (_options, callback) => {
    const reason = '当前定制 Chromium 内核已裁剪打印子系统 (enable_printing = false)';
    if (typeof callback === 'function') {
      callback(false, reason);
    }
  };
  webContents.printToPDF = async () => {
    throw new Error('当前定制 Chromium 内核已裁剪 PDF 与打印预览子系统 (enable_pdf = false)');
  };
}

/**
 * [L2 4.3] 收紧会话权限策略：默认拒绝所有敏感硬件与隐私权限请求
 * @param {import('electron').Session} targetSession
 */
function hardenSessionPermissions(targetSession) {
  if (!targetSession) return;
  targetSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  targetSession.setPermissionCheckHandler(() => false);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'launcher',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

let mainWindow;
let loginWindow;
let core;
let nextId = 0;
const pending = new Map();
// Without an explicit icon Electron shows its own logo on the window and the
// taskbar (always in development, where electron.exe is the running binary).
const appIcon = app.isPackaged
  ? path.join(__dirname, '..', 'dist', 'logo.png')
  : path.join(
      __dirname,
      '..',
      'src-tauri',
      'icons',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    );
const events = new Set([
  'install:progress',
  'game:log',
  'game:status',
  'game:exit',
  'multiplayer:status',
  'multiplayer:log',
  'multiplayer:install',
]);

function startCore() {
  const binary = `open-source-minecraft-launcher${process.platform === 'win32' ? '.exe' : ''}`;
  const binaryPath = app.isPackaged
    ? path.join(process.resourcesPath, 'core', binary)
    : path.join(__dirname, '..', 'src-tauri', 'target', 'debug', binary);
  // Tauri stored accounts in its application config directory, named by its identifier.
  const config = path.join(app.getPath('appData'), 'com.opensource.minecraft.launcher');
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'src-tauri');
  core = spawn(binaryPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
      OSML_HOME: app.getPath('home'),
      OSML_CONFIG: config,
      OSML_RESOURCES: resources,
    },
  });
  core.stderr.on('data', (data) => process.stderr.write(data));
  core.on('error', failPending);
  core.on('exit', (code) => failPending(new Error(`核心进程已退出 (${code})`)));
  core.stdin.on('error', failPending);
  readline.createInterface({ input: core.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error('核心进程输出无效');
      return;
    }
    if (events.has(message.event) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('core:event', message.event, message.payload);
    }
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error != null ? reject(new Error(message.error)) : resolve(message.result);
    }
  });
}

function failPending(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

function invokeCore(command, args) {
  if (!core || !core.stdin.writable) return Promise.reject(new Error('核心进程不可用'));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    core.stdin.write(JSON.stringify({ id, command, args: args || {} }) + '\n', (error) => {
      if (error && pending.has(id)) {
        pending.delete(id);
        reject(error);
      }
    });
  });
}

function trusted(event) {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Unauthorized IPC sender');
  }
  const url = event.senderFrame.url;
  if (!(app.isPackaged ? url.startsWith('launcher://app/') : url.startsWith('http://127.0.0.1:1420/'))) {
    throw new Error('Unauthorized IPC origin');
  }
}

function microsoftUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'https:' &&
      [
        'microsoft.com',
        'live.com',
        'microsoftonline.com',
        'msauth.net',
        'msftauth.net',
        'xboxlive.com',
      ].some((root) => url.hostname === root || url.hostname.endsWith('.' + root))
    );
  } catch {
    return false;
  }
}

async function openLogin(url) {
  if (!microsoftUrl(url)) throw new Error('登录窗口只接受微软官方登录页面地址。');
  if (!loginWindow || loginWindow.isDestroyed()) {
    const loginSession = session.fromPartition('microsoft-login');
    hardenSessionPermissions(loginSession);
    loginWindow = new BrowserWindow({
      width: 520,
      height: 720,
      title: 'Microsoft 账户登录',
      icon: appIcon,
      parent: mainWindow,
      webPreferences: {
        ...SECURE_WEB_PREFERENCES,
        partition: 'microsoft-login',
      },
    });
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    applyPrunedFeatureGuards(loginWindow.webContents);
  }
  await loginWindow.loadURL(url);
  loginWindow.show();
  loginWindow.focus();
}

function getElectronChromiumProfile() {
  const metrics = app.getAppMetrics();
  let totalWorkingSetKb = 0;
  for (const proc of metrics) {
    totalWorkingSetKb += proc.memory?.workingSetSize || 0;
  }
  let baseline = null;
  try {
    baseline = collectBaselineReport();
  } catch (err) {
    baseline = null;
  }
  let runtimeFuses = null;
  try {
    runtimeFuses = readElectronFuses(process.execPath);
  } catch {
    runtimeFuses = null;
  }

  return {
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      v8: process.versions.v8,
      node: process.versions.node,
    },
    isPackaged: app.isPackaged,
    coldStartupMs: readyInteractiveMs,
    processCount: metrics.length,
    memoryWorkingSetMb: Number((totalWorkingSetKb / 1024).toFixed(1)),
    processes: metrics.map((m) => ({
      pid: m.pid,
      type: m.type,
      memoryMb: Number(((m.memory?.workingSetSize || 0) / 1024).toFixed(1)),
    })),
    runtimeFuses: runtimeFuses?.fuses || null,
    disabledFeatures: DISABLED_CHROMIUM_FEATURES,
    disabledSwitches: DISABLED_CHROMIUM_SWITCHES,
    webPreferencesBaseline: SECURE_WEB_PREFERENCES,
    baseline,
  };
}

// Groups the taskbar button under the launcher identity instead of Electron's.
if (process.platform === 'win32') app.setAppUserModelId('com.opensource.minecraft.launcher');

app.whenReady().then(async () => {
  // [L2 4.3] 默认会话权限拒绝与 CSP 响应头注入
  hardenSessionPermissions(session.defaultSession);
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [PACKAGED_CSP],
        },
      });
    });
  }

  if (typeof protocol.registerFileProtocol === 'function') {
    protocol.registerFileProtocol('launcher', (request, callback) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'app') {
          callback({ error: -6 });
          return;
        }
        const root = path.resolve(__dirname, '..', 'dist');
        const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
        if (file !== root && !file.startsWith(root + path.sep)) {
          callback({ error: -10 });
          return;
        }
        callback({ path: file === root ? path.join(root, 'index.html') : file });
      } catch {
        callback({ error: -2 });
      }
    });
  } else if (typeof protocol.handle === 'function') {
    protocol.handle('launcher', (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
      const root = path.resolve(__dirname, '..', 'dist');
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file === root ? path.join(root, 'index.html') : file).toString());
    });
  }

  startCore();

  mainWindow = new BrowserWindow({
    title: 'Open-source-Minecraft-launcher',
    width: 1220,
    height: 800,
    minWidth: 1020,
    minHeight: 680,
    frame: false,
    icon: appIcon,
    backgroundColor: '#080b09',
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  applyPrunedFeatureGuards(mainWindow.webContents);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged
      ? url.startsWith('launcher://app/')
      : url.startsWith('http://127.0.0.1:1420/');
    if (!allowed) event.preventDefault();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    readyInteractiveMs = Math.round(performance.now() - bootStartTime);
  });

  for (const event of ['maximize', 'unmaximize', 'resize']) {
    mainWindow.on(
      event,
      () => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('window:resized')
    );
  }

  ipcMain.handle('core:invoke', async (event, command, args) => {
    trusted(event);
    if (command === 'get_electron_chromium_profile') return getElectronChromiumProfile();
    if (command === 'open_login_window') return openLogin(args?.url);
    if (command === 'close_login_window') {
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      return;
    }
    if (command === 'open_url') {
      const url = new URL(args?.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持打开 http/https 链接');
      return shell.openExternal(url.href);
    }
    if (command === 'open_folder') {
      const target = typeof args?.path === 'string' ? args.path.trim() : '';
      if (!target) throw new Error('目录路径为空');
      let dir = target;
      try {
        if ((await fs.promises.stat(target)).isFile()) dir = path.dirname(target);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.promises.mkdir(target, { recursive: true });
      }
      const error = await shell.openPath(dir);
      if (error) throw new Error(error);
      return;
    }
    return invokeCore(command, args);
  });

  ipcMain.handle('dialog:open', async (event, options = {}) => {
    trusted(event);
    const properties = [options.directory ? 'openDirectory' : 'openFile'];
    if (options.multiple) properties.push('multiSelections');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      properties,
    });
    return result.canceled ? null : options.multiple ? result.filePaths : result.filePaths[0] || null;
  });

  ipcMain.handle('window:action', (event, action) => {
    trusted(event);
    switch (action) {
      case 'close':
        return mainWindow.close();
      case 'hide':
        return mainWindow.hide();
      case 'show':
        return mainWindow.show();
      case 'setFocus':
        return mainWindow.focus();
      case 'minimize':
        return mainWindow.minimize();
      case 'isMaximized':
        return mainWindow.isMaximized();
      case 'toggleMaximize':
        return mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
      default:
        throw new Error('Unknown window action');
    }
  });

  if (app.isPackaged) await mainWindow.loadURL('launcher://app/index.html');
  else await mainWindow.loadURL('http://127.0.0.1:1420/');
}).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (core && core.stdin.writable) core.stdin.end();
});
