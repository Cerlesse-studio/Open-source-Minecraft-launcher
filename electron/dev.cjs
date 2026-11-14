const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
let server;
let electron;
let closing = false;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  if (electron && !electron.killed) electron.kill();
  if (server) await server.close();
  process.exitCode = code;
}
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

// Windows 沙盒/工作区目录若带有 Low Mandatory Level，会导致 CreateProcess 将
// electron.exe 或新编译出的 Rust 核心强行降级为 Low 完整性运行，引发 0xC0000142 闪退。
function ensureWindowsMediumIntegrity(targetPath) {
  if (process.platform !== 'win32' || !targetPath || !fs.existsSync(targetPath)) return;
  try {
    execFileSync('icacls', [targetPath, '/setintegritylevel', 'Medium'], { stdio: 'ignore' });
  } catch {}
}

(async () => {
  const { createServer } = await import('vite');
  try {
    server = await createServer({ server: { host: '127.0.0.1', port: 1420, strictPort: true } });
    await server.listen();
  } catch (err) {
    if (err && /already in use|EADDRINUSE/i.test(String(err.message || err))) {
      console.warn('端口 1420 已被占用，自动切换到可用端口启动 Vite 开发服务器…');
      server = await createServer({ server: { host: '127.0.0.1', port: 1421, strictPort: false } });
      await server.listen();
    } else {
      throw err;
    }
  }
  server.printUrls();
  const address = server.httpServer && server.httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 1420;
  const devUrl = `http://127.0.0.1:${port}/`;
  // [Linux 沙盒] 开发树里没有 root 所有权的 `chrome-sandbox`，Chromium 会在
  // 主进程执行前就 abort。直接携带 `--no-sandbox` 启动即可。
  const electronArgs =
    process.platform === 'linux'
      ? ['--no-sandbox', '--disable-setuid-sandbox', path.join(__dirname, '..')]
      : [path.join(__dirname, '..')];
  const childEnv = { ...process.env, OSML_DEV_URL: devUrl };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const electronBin = require('electron');
  ensureWindowsMediumIntegrity(electronBin);
  ensureWindowsMediumIntegrity(
    path.join(__dirname, '..', 'src-tauri', 'target', 'debug', 'open-source-minecraft-launcher.exe'),
  );
  ensureWindowsMediumIntegrity(
    path.join(__dirname, '..', 'src-tauri', 'target', 'release', 'open-source-minecraft-launcher.exe'),
  );
  electron = spawn(electronBin, electronArgs, {
    stdio: 'inherit',
    env: childEnv,
  });
  electron.on('error', error => {
    console.error('[dev] 无法启动 Electron 进程:', error);
    void stop(1);
  });
  electron.on('exit', (code, signal) => {
    if (code !== 0 || signal) {
      const hex = typeof code === 'number' ? ` (0x${(code >>> 0).toString(16).toUpperCase()})` : '';
      console.error(`[dev] Electron 桌面进程意外退出: code=${code}${hex}, signal=${signal}`);
      if (code === 3221225794) {
        console.error('[dev] 提示: 0xC0000142 (STATUS_DLL_INIT_FAILED) 通常由进程处于受限沙盒或文件完整性级别过低引起。');
      }
    }
    void stop(code || 0);
  });
})().catch(error => { console.error(error); void stop(1); });
