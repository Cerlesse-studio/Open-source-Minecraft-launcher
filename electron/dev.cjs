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
  electron = spawn(require('electron'), [path.join(__dirname, '..')], { stdio: 'inherit' });
  electron.on('error', error => { console.error(error); void stop(1); });
  electron.on('exit', code => { void stop(code || 0); });
})().catch(error => { console.error(error); void stop(1); });
