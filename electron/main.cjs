const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const readline = require('node:readline');

protocol.registerSchemesAsPrivileged([{ scheme: 'launcher', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let mainWindow;
let loginWindow;
let core;
let nextId = 0;
const pending = new Map();
const events = new Set(['install:progress', 'game:log', 'game:status', 'game:exit', 'multiplayer:status', 'multiplayer:log', 'multiplayer:install']);

function startCore() {
  const binary = `open-source-minecraft-launcher${process.platform === 'win32' ? '.exe' : ''}`;
  const binaryPath = app.isPackaged ? path.join(process.resourcesPath, 'core', binary) : path.join(__dirname, '..', 'src-tauri', 'target', 'debug', binary);
  // Tauri stored accounts in its application config directory, named by its identifier.
  const config = path.join(app.getPath('appData'), 'com.opensource.minecraft.launcher');
  const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'src-tauri');
  core = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, OSML_HOME: app.getPath('home'), OSML_CONFIG: config, OSML_RESOURCES: resources } });
  core.stderr.on('data', data => process.stderr.write(data));
  core.on('error', failPending);
  core.on('exit', (code) => failPending(new Error(`核心进程已退出 (${code})`)));
  core.stdin.on('error', failPending);
  readline.createInterface({ input: core.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { console.error('核心进程输出无效'); return; }
    if (events.has(message.event) && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('core:event', message.event, message.payload);
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
    core.stdin.write(JSON.stringify({ id, command, args: args || {} }) + '\n', error => {
      if (error && pending.has(id)) { pending.delete(id); reject(error); }
    });
  });
}
function trusted(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized IPC sender');
  const url = event.senderFrame.url;
  if (!(app.isPackaged ? url.startsWith('launcher://app/') : url.startsWith('http://127.0.0.1:1420/'))) throw new Error('Unauthorized IPC origin');
}
function microsoftUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && ['microsoft.com', 'live.com', 'microsoftonline.com', 'msauth.net', 'msftauth.net', 'xboxlive.com'].some(root => url.hostname === root || url.hostname.endsWith('.' + root));
  } catch { return false; }
}
async function openLogin(url) {
  if (!microsoftUrl(url)) throw new Error('登录窗口只接受微软官方登录页面地址。');
  if (!loginWindow || loginWindow.isDestroyed()) {
    loginWindow = new BrowserWindow({ width: 520, height: 720, title: 'Microsoft 账户登录', parent: mainWindow, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'microsoft-login' } });
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
  await loginWindow.loadURL(url);
  loginWindow.show();
  loginWindow.focus();
}

app.whenReady().then(async () => {
  protocol.handle('launcher', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    const root = path.resolve(__dirname, '..', 'dist');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file === root ? path.join(root, 'index.html') : file).toString());
  });
  startCore();
  mainWindow = new BrowserWindow({ title: 'Open-source-Minecraft-launcher', width: 1220, height: 800, minWidth: 1020, minHeight: 680, frame: false, backgroundColor: '#080b09', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged ? url.startsWith('launcher://app/') : url.startsWith('http://127.0.0.1:1420/');
    if (!allowed) event.preventDefault();
  });
  for (const event of ['maximize', 'unmaximize', 'resize']) mainWindow.on(event, () => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('window:resized'));
  ipcMain.handle('core:invoke', async (event, command, args) => {
    trusted(event);
    if (command === 'open_login_window') return openLogin(args?.url);
    if (command === 'close_login_window') { if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close(); return; }
    if (command === 'open_url') {
      const url = new URL(args?.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持打开 http/https 链接');
      return shell.openExternal(url.href);
    }
    if (command === 'open_folder') {
      const target = typeof args?.path === 'string' ? args.path.trim() : '';
      if (!target) throw new Error('目录路径为空');
      let dir = target;
      try { if ((await fs.promises.stat(target)).isFile()) dir = path.dirname(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await fs.promises.mkdir(target, { recursive: true }); }
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
    const result = await dialog.showOpenDialog(mainWindow, { title: options.title, defaultPath: options.defaultPath, filters: options.filters, properties });
    return result.canceled ? null : options.multiple ? result.filePaths : result.filePaths[0] || null;
  });
  ipcMain.handle('window:action', (event, action) => {
    trusted(event);
    switch (action) {
      case 'close': return mainWindow.close();
      case 'hide': return mainWindow.hide();
      case 'show': return mainWindow.show();
      case 'setFocus': return mainWindow.focus();
      case 'minimize': return mainWindow.minimize();
      case 'isMaximized': return mainWindow.isMaximized();
      case 'toggleMaximize': return mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
      default: throw new Error('Unknown window action');
    }
  });
  if (app.isPackaged) await mainWindow.loadURL('launcher://app/index.html');
  else await mainWindow.loadURL('http://127.0.0.1:1420/');
}).catch(error => { console.error(error); app.quit(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (core && core.stdin.writable) core.stdin.end(); });
