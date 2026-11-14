const { spawn } = require('node:child_process');
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
(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ server: { host: '127.0.0.1', port: 1420, strictPort: true } });
  await server.listen();
  server.printUrls();
  // [Linux 沙盒] 开发树里没有 root 所有权的 `chrome-sandbox`，Chromium 会在
  // 主进程执行前就 abort。直接携带 `--no-sandbox` 启动即可。
  const electronArgs =
    process.platform === 'linux'
      ? ['--no-sandbox', '--disable-setuid-sandbox', path.join(__dirname, '..')]
      : [path.join(__dirname, '..')];
  electron = spawn(require('electron'), electronArgs, { stdio: 'inherit' });
  electron.on('error', error => { console.error(error); void stop(1); });
  electron.on('exit', code => { void stop(code || 0); });
})().catch(error => { console.error(error); void stop(1); });
