const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { readElectronFuses } = require('./fuses.cjs');
const { collectBaselineReport } = require('./measure-baseline.cjs');
const updater = require('./updater.cjs');

// ============================================================================
// [存储目录] 便携版优先把数据和游戏目录放在程序旁边；若该目录不可写
// （例如以普通用户运行安装在 Program Files 的版本、Linux AppImage 或
// macOS .app），则回退到当前用户目录。Chromium 的 userData 必须可写，
// 否则 GPU/渲染进程会启动失败，主进程随即退出，表现为“闪退”。
// ============================================================================
const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR
  ? path.resolve(process.env.PORTABLE_EXECUTABLE_DIR)
  : null;
const executableRoot = app.isPackaged
  ? path.dirname(process.execPath)
  : path.resolve(__dirname, '..');
const preferredRoot = portableRoot || executableRoot;
const fallbackRoot = path.join(app.getPath('appData'), 'Open-source-Minecraft-launcher');

function ensureWritableDir(candidate) {
  try {
    fs.mkdirSync(candidate, { recursive: true });
    const probe = path.join(candidate, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    try {
      fs.unlinkSync(probe);
    } catch {}
    return true;
  } catch {
    return false;
  }
}

function storageAt(root) {
  return {
    root,
    data: path.join(root, 'data'),
    game: path.join(root, '.minecraft'),
  };
}

let storage = storageAt(preferredRoot);
if (!ensureWritableDir(storage.data) || !ensureWritableDir(storage.game)) {
  const fallback = storageAt(fallbackRoot);
  if (!ensureWritableDir(fallback.data) || !ensureWritableDir(fallback.game)) {
    dialog.showErrorBox(
      '启动失败',
      `启动器无法创建可写的数据目录。\n\n程序目录：${preferredRoot}\n用户目录：${fallbackRoot}\n\n请检查目录权限，或把启动器放到有写入权限的位置后重试。`,
    );
    app.exit(1);
  }
  console.warn(`程序目录不可写，数据目录已回退到：${fallback.root}`);
  try {
    fs.appendFileSync(
      path.join(fallback.data, 'startup.log'),
      `[${new Date().toISOString()}] 程序目录不可写（${preferredRoot}），已使用用户目录 ${fallback.root}\n`,
    );
  } catch {}
  storage = fallback;
}

const launcherDir = storage.root;
const launcherDataDir = storage.data;
const launcherGameDir = storage.game;

function appendStartupError(label, error) {
  const detail = error && error.stack ? error.stack : String(error);
  console.error(`[startup] ${label}:`, detail);
  try {
    fs.appendFileSync(
      path.join(launcherDataDir, 'startup.log'),
      `[${new Date().toISOString()}] ${label}：${detail}\n`,
    );
  } catch {}
}

process.on('uncaughtException', (error) => {
  appendStartupError('未捕获主进程异常', error);
});
process.on('unhandledRejection', (reason) => {
  appendStartupError('未处理的 Promise 拒绝', reason);
});

// 将 Electron 应用配置与缓存重定向至选定目录下的独立 web 子目录中。
// 注意：严禁重定向 appData 与 sessionData！
// 1. appData 必须保留为操作系统的 Roaming AppData，否则 Chromium 内部沙盒与系统集成会产生路径错乱。
// 2. sessionData 应默认驻留在 userData 内，单独重定向会导致 Chromium 在 Windows 普通用户（非管理员）
//    权限下初始化网络沙盒失败并抛出 0x5（拒绝访问），直接导致 GPU/渲染进程崩溃（error_code=18）闪退。
try {
  const webUserDataDir = path.join(launcherDataDir, 'web');
  fs.mkdirSync(webUserDataDir, { recursive: true });
  app.setPath('userData', webUserDataDir);
  app.setPath('crashDumps', path.join(launcherDataDir, 'crashes'));
  app.setPath('logs', path.join(launcherDataDir, 'logs'));
} catch (err) {
  console.warn('重定向应用数据路径遇到非致命警告:', err);
}

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
  // 必须禁用 NetworkServiceSandbox：在便携版或自定义数据目录下，非管理员启动时
  // Chromium 无法为沙盒化 NetworkService 配置 Windows AppContainer/Lowbox 权限，
  // 导致 Network 目录报 0x5 访问拒绝进而引发整个渲染层崩溃闪退。
  'NetworkServiceSandbox',
];

const DISABLED_CHROMIUM_SWITCHES = [
  'disable-component-update',
  'no-pings',
  'disable-background-networking',
  'disable-domain-reliability',
  'disable-print-preview',
  'disable-speech-api',
  'disable-sync',
  // 普通用户非管理员模式下避免 GPU 进程沙盒令牌初始化失败 (error_code=18)
  'disable-gpu-sandbox',
  // AppImage/便携版下 chrome-sandbox 无法获得 root+4755 SUID 位，不做 Sputnik
  // 检测，直接关闭 Sandbox 共享层
  'no-sandbox',
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
  // 不在沙盒模式下运行：AppImage/便携版下 `chrome-sandbox` 不可能获得
  // root 所有 + 4755 SUID 位，Chromium 的 SUID sandbox 检查会直接 abort
  // 整个应用。Linux 桌面应用无需沙盒也能通过 preload+contextIsolation 隔离。
  sandbox: false,
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

function resolveDevServerUrl() {
  const raw = process.env.OSML_DEV_URL;
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (
        parsed.protocol === 'http:' &&
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
      ) {
        return `${parsed.origin}/`;
      }
    } catch {}
  }
  return 'http://127.0.0.1:1420/';
}

const devServerUrl = resolveDevServerUrl();
let usingPackagedFallback = false;
let usingFileFallbackUrl = null;

// ============================================================================
// 开发者选项：F12 DevTools / 后台核心进程日志
// ============================================================================
let devToolsEnabled = false;
let backendConsoleEnabled = false;
let backendConsoleWindow = null;
let backendLogPath = null;
let backendLogStream = null;
let backendLogLines = [];
const BACKEND_LOG_LIMIT = 4000;
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
  'content:progress',
  'game:log',
  'game:status',
  'game:exit',
  'multiplayer:status',
  'multiplayer:log',
  'multiplayer:install',
  'multiplayer:clone',
  'update:progress',
]);

// ============================================================================
// [IPC 帧合并加速] 将 Rust 核心高频进度与日志事件按 16ms (60fps) 窗口合并为单次
// webContents.send('core:events')，避免多线程高速下载或游戏海量日志刷屏阻塞渲染主线程。
// ============================================================================
let pendingEventBatch = [];
let pendingEventTimer = null;

function flushRendererEvents() {
  if (pendingEventTimer !== null) {
    clearTimeout(pendingEventTimer);
    pendingEventTimer = null;
  }
  if (pendingEventBatch.length === 0) return;
  const batch = pendingEventBatch;
  pendingEventBatch = [];
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (batch.length === 1) {
    mainWindow.webContents.send('core:event', batch[0].event, batch[0].payload);
  } else {
    mainWindow.webContents.send('core:events', batch);
  }
}

function enqueueRendererEvent(event, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isImmediate =
    event === 'game:status' ||
    event === 'game:exit' ||
    event === 'multiplayer:status' ||
    (payload &&
      (payload.stage === 'done' ||
        payload.stage === 'error' ||
        payload.status === 'ready' ||
        payload.status === 'error'));

  if (event === 'install:progress' && !isImmediate) {
    for (let i = pendingEventBatch.length - 1; i >= 0; i -= 1) {
      if (pendingEventBatch[i].event === 'install:progress') {
        const prevLogs = pendingEventBatch[i].payload?.fileLogs;
        const nextLogs = payload?.fileLogs;
        const mergedPayload =
          Array.isArray(prevLogs) && prevLogs.length > 0
            ? {
                ...payload,
                fileLogs: Array.isArray(nextLogs)
                  ? prevLogs.concat(nextLogs).slice(-300)
                  : prevLogs,
              }
            : payload;
        pendingEventBatch[i] = { event, payload: mergedPayload };
        return;
      }
    }
  } else if (
    (event === 'content:progress' || event === 'update:progress') &&
    !isImmediate
  ) {
    for (let i = pendingEventBatch.length - 1; i >= 0; i -= 1) {
      if (
        pendingEventBatch[i].event === event &&
        pendingEventBatch[i].payload?.id === payload?.id
      ) {
        pendingEventBatch[i] = { event, payload };
        return;
      }
    }
  }

  pendingEventBatch.push({ event, payload });

  if (isImmediate || pendingEventBatch.length >= 64) {
    flushRendererEvents();
  } else if (pendingEventTimer === null) {
    pendingEventTimer = setTimeout(flushRendererEvents, 16);
  }
}

function resolveCoreBinary() {
  const binary = `open-source-minecraft-launcher${process.platform === 'win32' ? '.exe' : ''}`;
  if (app.isPackaged) {
    const candidates = [
      path.join(process.resourcesPath, 'core', binary),
      path.join(path.dirname(process.execPath), 'resources', 'core', binary),
      path.join(process.resourcesPath, binary),
      path.join(path.dirname(process.execPath), binary),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return candidates[0];
  }

  // Development builds both target/debug and target/release. Picking release
  // unconditionally made `npm start` (which builds debug) run an outdated
  // core, so new backend features silently fell back to old behaviour. Use the
  // most recently built binary instead.
  const candidates = [
    path.join(__dirname, '..', 'src-tauri', 'target', 'debug', binary),
    path.join(__dirname, '..', 'src-tauri', 'target', 'release', binary),
  ];
  let newest = null;
  let newestTime = -Infinity;
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.mtimeMs > newestTime) {
        newest = candidate;
        newestTime = stat.mtimeMs;
      }
    } catch {
      // Missing build artifact: try the next candidate.
    }
  }
  return newest ?? candidates[0];
}

function startCore() {
  if (core && core.stdin && core.stdin.writable && core.exitCode === null) {
    return;
  }
  const binaryPath = resolveCoreBinary();
  const config = path.join(launcherDataDir, 'config');
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'src-tauri');

  try {
    fs.mkdirSync(config, { recursive: true });
  } catch {}

  appendBackendLog('system', `启动核心进程: ${binaryPath}`);
  appendBackendLog('system', `启动器主程序目录: ${launcherDir}`);
  appendBackendLog('system', `核心配置目录: ${config}`);
  appendBackendLog('system', `默认游戏目录: ${launcherGameDir}`);
  try {
    core = spawn(binaryPath, [], {
      cwd: launcherDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        OSML_LAUNCHER_DIR: launcherDir,
        OSML_HOME: launcherDir,
        OSML_CONFIG: config,
        OSML_GAME_DIR: launcherGameDir,
        OSML_RESOURCES: resources,
      },
    });
    appendBackendLog('system', `核心进程 PID: ${core.pid ?? '未知'}`);
  } catch (err) {
    console.error('启动核心进程失败:', err);
    appendBackendLog('system', `启动核心进程失败: ${err}`);
    failPending(err);
    return;
  }

  core.stderr.on('data', (data) => {
    process.stderr.write(data);
    appendBackendLog('stderr', data);
  });
  core.on('error', (err) => {
    console.error('核心进程异常:', err);
    appendBackendLog('system', `核心进程异常: ${err}`);
    failPending(err);
  });
  core.on('exit', (code, signal) => {
    console.warn(`核心进程已退出 (code=${code}, signal=${signal})`);
    appendBackendLog('system', `核心进程已退出 (code=${code}, signal=${signal})`);
    failPending(new Error(`核心进程已退出 (${code})`));
  });
  core.stdin.on('error', (err) => {
    console.error('核心进程输入流异常:', err);
    appendBackendLog('system', `核心进程输入流异常: ${err}`);
    failPending(err);
  });
  readline.createInterface({ input: core.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error('核心进程输出无效:', line);
      appendBackendLog('stdout', line);
      return;
    }
    if (message.event) {
      if (backendConsoleEnabled) appendBackendLog('event', String(message.event));
    } else if (message.id != null && backendConsoleEnabled) {
      appendBackendLog(
        'ipc',
        `#${message.id} ${message.error != null ? `失败: ${message.error}` : '完成'}`,
      );
    }
    if (events.has(message.event) && mainWindow && !mainWindow.isDestroyed()) {
      enqueueRendererEvent(message.event, message.payload);
    }
    if (message.id != null && pending.has(message.id)) {
      flushRendererEvents();
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
  if (!core || !core.stdin || !core.stdin.writable || core.exitCode !== null) {
    console.warn('核心进程未就绪，正在尝试拉起核心进程...');
    try {
      startCore();
    } catch (e) {
      return Promise.reject(new Error('核心进程不可用: ' + e.message));
    }
  }
  if (!core || !core.stdin || !core.stdin.writable) {
    return Promise.reject(new Error('核心进程不可用'));
  }
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
  const allowLauncherProtocol = app.isPackaged || usingPackagedFallback;
  const allowed = usingFileFallbackUrl
    ? url.startsWith(usingFileFallbackUrl)
    : allowLauncherProtocol
      ? url.startsWith('launcher://app/')
      : url.startsWith(devServerUrl);
  if (!allowed) {
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

function ensureBackendLogFile() {
  if (backendLogPath) return backendLogPath;
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'core-console.log');
    try {
      if (fs.statSync(logPath).size > 5 * 1024 * 1024) fs.truncateSync(logPath, 0);
    } catch {
      // A missing or unreadable previous log is fine; create it below.
    }
    backendLogStream = fs.createWriteStream(logPath, { flags: 'a' });
    backendLogStream.on('error', (error) => {
      console.error('后台日志写入失败:', error);
      backendLogStream = null;
    });
    backendLogPath = logPath;
  } catch (error) {
    console.error('无法创建后台日志文件:', error);
    backendLogPath = null;
  }
  return backendLogPath;
}

function sanitizeBackendLogText(value) {
  return String(value)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|device[_-]?code|authorization|password|secret)\s*["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi,
      '$1***',
    );
}

function appendBackendLog(stream, value) {
  if (!backendConsoleEnabled) return;
  ensureBackendLogFile();
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const text = sanitizeBackendLogText(value).replace(/\r/g, '');
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    const entry = `[${stamp}] [${stream}] ${line}`;
    backendLogLines.push(entry);
    if (backendLogLines.length > BACKEND_LOG_LIMIT) backendLogLines.shift();
    if (backendLogStream) backendLogStream.write(entry + '\n');
    if (backendConsoleWindow && !backendConsoleWindow.isDestroyed()) {
      backendConsoleWindow.webContents.send('backend:log', entry);
    }
  }
}

function backendConsoleHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<title>后台进程日志 — CMD</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; background: #050807; color: #c9d6ce; font: 12px/1.55 "Cascadia Mono", "Consolas", "Geist Mono", monospace; }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #1d2b23; background: #0a100d; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #9bdd6b; box-shadow: 0 0 8px rgba(155,221,107,.7); flex: none; }
  h1 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .04em; color: #d7e6dc; white-space: nowrap; }
  .hint { color: #5f7468; font-size: 10.5px; }
  .spacer { flex: 1; }
  button { border: 1px solid #263a2e; background: #101a14; color: #a9bbaf; border-radius: 5px; padding: 4px 9px; font: inherit; font-size: 10.5px; cursor: pointer; }
  button:hover { border-color: #3f6b4e; color: #d7e6dc; }
  main { flex: 1; min-height: 0; overflow: auto; padding: 10px 14px 18px; }
  #log { min-height: 100%; }
  .row { white-space: pre-wrap; overflow-wrap: anywhere; color: #93a69a; }
  .row.system { color: #9bdd6b; }
  .row.stderr { color: #f0a3a3; }
  .row.event { color: #86b8e8; }
  .row.ipc { color: #7f9187; }
  footer { display: flex; align-items: center; gap: 12px; padding: 7px 14px; border-top: 1px solid #1d2b23; background: #0a100d; color: #5f7468; font-size: 10px; }
  label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
  input { accent-color: #9bdd6b; }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <h1>后台进程日志</h1>
  <span class="hint">Rust Core · stdout / stderr</span>
  <span class="spacer"></span>
  <button id="copy" type="button">复制全部</button>
  <button id="clear" type="button">清空窗口</button>
</header>
<main><div id="log"></div></main>
<footer>
  <span id="count">0 行</span>
  <span id="message"></span>
  <span class="spacer"></span>
  <label><input id="follow" type="checkbox" checked /> 自动滚动</label>
</footer>
<script>
(function () {
  var logEl = document.getElementById('log');
  var countEl = document.getElementById('count');
  var messageEl = document.getElementById('message');
  var followEl = document.getElementById('follow');
  var lines = [];
  var LIMIT = 4000;
  function rowClass(text) {
    if (text.indexOf('[system]') !== -1) return 'row system';
    if (text.indexOf('[stderr]') !== -1) return 'row stderr';
    if (text.indexOf('[event]') !== -1) return 'row event';
    if (text.indexOf('[ipc]') !== -1) return 'row ipc';
    return 'row';
  }
  function makeRow(text) {
    var row = document.createElement('div');
    row.className = rowClass(text);
    row.textContent = text;
    return row;
  }
  function updateCount() { countEl.textContent = lines.length + ' 行'; }
  function render() {
    logEl.textContent = '';
    var fragment = document.createDocumentFragment();
    for (var i = 0; i < lines.length; i += 1) fragment.appendChild(makeRow(lines[i]));
    logEl.appendChild(fragment);
    updateCount();
    if (followEl.checked) logEl.scrollTop = logEl.scrollHeight;
  }
  function append(text) {
    lines.push(text);
    if (lines.length > LIMIT) lines.shift();
    if (logEl.childElementCount >= LIMIT && logEl.firstChild) logEl.removeChild(logEl.firstChild);
    logEl.appendChild(makeRow(text));
    updateCount();
    if (followEl.checked) logEl.scrollTop = logEl.scrollHeight;
  }
  window.backendConsole.onSnapshot(function (snapshot) {
    lines = Array.isArray(snapshot) ? snapshot.slice(-LIMIT) : [];
    render();
  });
  window.backendConsole.onLine(append);
  document.getElementById('copy').addEventListener('click', function () {
    if (!lines.length) return;
    var area = document.createElement('textarea');
    area.value = lines.join(String.fromCharCode(10));
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); messageEl.textContent = '已复制'; }
    catch (error) { messageEl.textContent = '复制失败'; }
    document.body.removeChild(area);
    setTimeout(function () { messageEl.textContent = ''; }, 1600);
  });
  document.getElementById('clear').addEventListener('click', function () {
    lines = [];
    logEl.textContent = '';
    updateCount();
    messageEl.textContent = '窗口已清空，主进程仍在记录';
    setTimeout(function () { messageEl.textContent = ''; }, 2200);
  });
})();
</script>
</body>
</html>`;
}

function sendBackendSnapshot() {
  if (!backendConsoleWindow || backendConsoleWindow.isDestroyed()) return;
  backendConsoleWindow.webContents.send('backend:snapshot', backendLogLines.slice(-BACKEND_LOG_LIMIT));
}

function openBackendConsoleWindow() {
  if (!backendConsoleEnabled) return null;
  ensureBackendLogFile();
  if (backendConsoleWindow && !backendConsoleWindow.isDestroyed()) {
    backendConsoleWindow.show();
    backendConsoleWindow.focus();
    return backendConsoleWindow;
  }
  backendConsoleWindow = new BrowserWindow({
    title: '后台进程日志 — CMD',
    width: 940,
    height: 620,
    minWidth: 620,
    minHeight: 360,
    icon: appIcon,
    backgroundColor: '#050807',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // AppImage/便携版下 `chrome-sandbox` 无 SUID 位，沙盒模式会导致进程 abort
      sandbox: false,
      devTools: devToolsEnabled,
      preload: path.join(__dirname, 'backend-console-preload.cjs'),
    },
  });
  backendConsoleWindow.setMenuBarVisibility(false);
  backendConsoleWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  backendConsoleWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  backendConsoleWindow.on('closed', () => {
    backendConsoleWindow = null;
  });
  // A data: URL can finish loading before its inline script installs the
  // preload listeners; a short delay makes the initial history reliable.
  backendConsoleWindow.webContents.once('did-finish-load', () => {
    setTimeout(sendBackendSnapshot, 120);
  });
  backendConsoleWindow.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(backendConsoleHtml()),
  );
  return backendConsoleWindow;
}

function closeBackendConsoleWindow() {
  if (backendConsoleWindow && !backendConsoleWindow.isDestroyed()) backendConsoleWindow.close();
  backendConsoleWindow = null;
}

function applyDeveloperOptions(options = {}) {
  const nextDevTools = options.devToolsEnabled === true;
  if (!nextDevTools) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.closeDevTools();
    if (backendConsoleWindow && !backendConsoleWindow.isDestroyed()) {
      backendConsoleWindow.webContents.closeDevTools();
    }
  }
  devToolsEnabled = nextDevTools;

  const nextBackendConsole = options.backendConsoleEnabled === true;
  const nextBackendConsolePreviouslyEnabled = backendConsoleEnabled;
  if (!nextBackendConsole) {
    backendConsoleEnabled = false;
    backendLogLines = [];
    closeBackendConsoleWindow();
  } else if (!backendConsoleEnabled) {
    backendConsoleEnabled = true;
    appendBackendLog('system', '已启用后台进程日志捕获，等待 Rust 核心输出…');
  }

  if (backendConsoleEnabled) {
    ensureBackendLogFile();
    if (options.openConsole === true || !nextBackendConsolePreviouslyEnabled) openBackendConsoleWindow();
  }

  return {
    devToolsEnabled,
    backendConsoleEnabled,
    logPath: backendConsoleEnabled ? backendLogPath : null,
    consoleOpen: Boolean(backendConsoleWindow && !backendConsoleWindow.isDestroyed()),
  };
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
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '');
    const isF12 = key === 'F12';
    const isInspectShortcut =
      (input.control || input.meta) && input.shift && key.toLowerCase() === 'i';
    if (!isF12 && !isInspectShortcut) return;
    event.preventDefault();
    if (!devToolsEnabled) return;
    if (mainWindow.webContents.isDevToolsOpened()) mainWindow.webContents.closeDevTools();
    else mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.webContents.on('devtools-opened', () => {
    if (!devToolsEnabled) mainWindow.webContents.closeDevTools();
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = usingFileFallbackUrl
      ? url.startsWith(usingFileFallbackUrl)
      : app.isPackaged || usingPackagedFallback
        ? url.startsWith('launcher://app/')
        : url.startsWith(devServerUrl);
    if (!allowed) event.preventDefault();
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('渲染进程异常退出:', details);
    try {
      fs.appendFileSync(
        path.join(launcherDataDir, 'startup.log'),
        `[${new Date().toISOString()}] 渲染进程异常退出：${JSON.stringify(details)}\n`,
      );
    } catch {}
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
    if (command === 'configure_developer_options') return applyDeveloperOptions(args);
    if (command === 'get_developer_options') {
      return {
        devToolsEnabled,
        backendConsoleEnabled,
        logPath: backendLogPath,
        consoleOpen: Boolean(backendConsoleWindow && !backendConsoleWindow.isDestroyed()),
      };
    }
    if (command === 'check_app_update') return updater.checkForUpdate();
    if (command === 'download_app_update') {
      return updater.downloadUpdate(
        args?.asset,
        (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('core:event', 'update:progress', progress);
          }
        },
        Boolean(args?.force),
      );
    }
    if (command === 'install_app_update') return updater.installUpdate(args?.path);
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

  if (app.isPackaged) {
    try {
      await mainWindow.loadURL('launcher://app/index.html');
    } catch (loadErr) {
      console.warn('launcher:// 协议加载失败，正在尝试本地文件回退加载:', loadErr);
      const distIndex = path.resolve(__dirname, '..', 'dist', 'index.html');
      usingFileFallbackUrl = pathToFileURL(distIndex).toString();
      await mainWindow.loadFile(distIndex);
    }
  } else {
    try {
      await mainWindow.loadURL(devServerUrl);
    } catch (devErr) {
      const distIndex = path.resolve(__dirname, '..', 'dist', 'index.html');
      if (fs.existsSync(distIndex)) {
        console.warn(`开发服务器 ${devServerUrl} 不可达，正在回退加载本地构建产物 dist/index.html:`, devErr);
        usingPackagedFallback = true;
        try {
          await mainWindow.loadURL('launcher://app/index.html');
        } catch {
          usingFileFallbackUrl = pathToFileURL(distIndex).toString();
          await mainWindow.loadFile(distIndex);
        }
      } else {
        throw devErr;
      }
    }
  }
}).catch((error) => {
  console.error(error);
  try {
    fs.appendFileSync(
      path.join(launcherDataDir, 'startup.log'),
      `[${new Date().toISOString()}] 启动失败：${error && error.stack ? error.stack : error}\n`,
    );
  } catch {}
  try {
    dialog.showErrorBox('启动失败', `启动器初始化失败：${error && error.message ? error.message : error}`);
  } catch {}
  app.quit();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (core && core.stdin.writable) core.stdin.end();
});
