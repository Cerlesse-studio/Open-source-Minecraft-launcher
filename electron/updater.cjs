'use strict';

// OTA update channel. Update packages are published as GitHub Release assets,
// so the app never needs a separate update server.
const UPDATE_REPOSITORY = 'Cerlesse-studio/Open-source-Minecraft-launcher';
const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
const LATEST_RELEASE_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;

const DOWNLOAD_EXTENSIONS = [
  '.exe',
  '.msi',
  '.dmg',
  '.pkg',
  '.zip',
  '.appimage',
  '.deb',
  '.rpm',
  '.tar.gz',
];

function parseVersion(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function extractVersion(value) {
  const parts = parseVersion(value);
  return parts ? parts.join('.') : null;
}

function isNewerVersion(latest, current) {
  const left = parseVersion(latest);
  const right = parseVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return false;
}

/**
 * Releases in this repository do not always use a semver tag (`index`), so
 * fall back to the title and then the asset names before giving up.
 */
function releaseVersion(release) {
  if (!release || typeof release !== 'object') return null;
  const candidates = [release.tag_name, release.name];
  for (const asset of Array.isArray(release.assets) ? release.assets : []) {
    candidates.push(asset && asset.name);
  }
  for (const candidate of candidates) {
    const version = extractVersion(candidate);
    if (version) return version;
  }
  return null;
}

function assetExtension(name) {
  const lower = String(name || '').toLowerCase();
  return DOWNLOAD_EXTENSIONS.find((extension) => lower.endsWith(extension)) || null;
}

function normalizeAsset(asset) {
  if (!asset || typeof asset !== 'object') return null;
  if (!asset.name || !asset.browser_download_url) return null;
  return {
    name: String(asset.name),
    size: Number(asset.size) || 0,
    downloadUrl: String(asset.browser_download_url),
  };
}

/**
 * Pick the installer that fits the running platform. A setup/installer build
 * is preferred over a portable one when both are attached to the release.
 */
function pickUpdateAsset(release, platform = process.platform, arch = process.arch, options = {}) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const candidates = assets
    .map(normalizeAsset)
    .filter((asset) => asset && assetExtension(asset.name));

  const preferred = [];
  if (platform === 'win32') preferred.push('.exe', '.msi');
  else if (platform === 'darwin') preferred.push('.dmg', '.pkg', '.zip');
  else preferred.push('.appimage', '.deb', '.rpm');

  // A portable build must not be updated by running a Setup installer: its
  // portable executable has to be replaced in place. The env variable is set
  // by electron-builder's portable launcher at runtime.
  const portable =
    platform === 'win32' &&
    (options.portable ?? Boolean(process.env.PORTABLE_EXECUTABLE_FILE));

  const scored = candidates
    .filter((asset) => preferred.some((extension) => asset.name.toLowerCase().endsWith(extension)))
    .map((asset) => {
      const lower = asset.name.toLowerCase();
      let score = 0;
      if (/setup|installer|install/.test(lower)) score += portable ? -10 : 5;
      if (portable && /portable/.test(lower)) score += 6;
      if (arch && lower.includes(String(arch).toLowerCase())) score += 3;
      if (platform === 'linux' && lower.endsWith('.appimage')) score += 2;
      if (platform === 'darwin' && lower.endsWith('.dmg')) score += 2;
      return { asset, score };
    })
    .sort((left, right) => right.score - left.score);

  return scored.length > 0 ? scored[0].asset : null;
}

function updatesDirectory() {
  const { app } = require('electron');
  return pathJoin(app.getPath('userData'), 'updates');
}

function pathJoin(...parts) {
  return require('node:path').join(...parts);
}

function safeFileName(name) {
  const base = require('node:path').basename(String(name || 'update'));
  const extension = assetExtension(base);
  const stem = (extension ? base.slice(0, -extension.length) : base)
    .replace(/[^\w.\-+ ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'update';
  return `${stem}${extension || ''}`;
}

function githubJson(url) {
  const { net } = require('electron');
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = net.request({ url, method: 'GET', redirect: 'follow' });
    request.setHeader('User-Agent', 'Open-source-Minecraft-launcher-Updater');
    request.setHeader('Accept', 'application/vnd.github+json');
    const chunks = [];
    let bodySize = 0;
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        if (bodySize < 2_000_000) {
          chunks.push(chunk);
          bodySize += chunk.length;
        }
      });
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(
            response.statusCode === 404
              ? 'GitHub 上还没有可用的 Release。'
              : `GitHub 更新服务返回 HTTP ${response.statusCode}。`,
          );
          error.statusCode = response.statusCode;
          fail(error);
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          settled = true;
          resolve(parsed);
        } catch {
          fail(new Error('GitHub 更新信息格式无效。'));
        }
      });
      response.on('error', fail);
    });
    request.on('error', (error) => fail(new Error(`无法连接 GitHub：${error.message}`)));
    request.end();
  });
}

async function checkForUpdate() {
  const { app } = require('electron');
  const currentVersion = app.getVersion();
  const base = {
    currentVersion,
    latestVersion: null,
    available: false,
    releaseName: null,
    releaseUrl: RELEASES_URL,
    notes: null,
    publishedAt: null,
    asset: null,
    cachedPath: null,
    source: 'github',
    checkedAt: Date.now(),
    message: null,
  };

  let release;
  try {
    release = await githubJson(LATEST_RELEASE_URL);
  } catch (error) {
    if (error.statusCode === 404) {
      return { ...base, message: '尚未在 GitHub Releases 发布可用版本。' };
    }
    throw error;
  }

  const latestVersion = releaseVersion(release);
  if (!latestVersion) {
    return {
      ...base,
      releaseName: release.name || release.tag_name || null,
      releaseUrl: release.html_url || RELEASES_URL,
      publishedAt: release.published_at || null,
      message: '最新 Release 未标注版本号，无法自动比较。',
    };
  }

  const available = isNewerVersion(latestVersion, currentVersion);
  const asset = available ? pickUpdateAsset(release) : null;
  let cachedPath = null;
  if (available && asset) {
    const target = pathJoin(updatesDirectory(), safeFileName(asset.name));
    try {
      const stat = await require('node:fs').promises.stat(target);
      if (!asset.size || stat.size === asset.size) cachedPath = target;
    } catch {
      // No cached package yet.
    }
  }

  return {
    ...base,
    latestVersion,
    available,
    releaseName: release.name || release.tag_name || null,
    releaseUrl: release.html_url || RELEASES_URL,
    notes: typeof release.body === 'string' ? release.body : null,
    publishedAt: release.published_at || null,
    asset,
    cachedPath,
    message: available
      ? asset
        ? null
        : '发现新版本，但没有适用于当前平台的安装包。'
      : '当前已是最新版本。',
  };
}

let activeDownload = null;

function assertReleaseAsset(asset) {
  if (!asset || typeof asset !== 'object') throw new Error('更新包信息无效。');
  const name = String(asset.name || '');
  if (!assetExtension(name)) throw new Error('不支持的更新包格式。');
  let url;
  try {
    url = new URL(String(asset.downloadUrl || ''));
  } catch {
    throw new Error('更新包下载地址无效。');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error('更新包必须来自 GitHub Releases。');
  }
  if (!url.pathname.startsWith(`/${UPDATE_REPOSITORY}/releases/download/`)) {
    throw new Error('更新包不属于本项目的 GitHub Releases。');
  }
  return { name, url: url.toString(), size: Number(asset.size) || 0 };
}

async function downloadUpdate(asset, onProgress, force = false) {
  if (activeDownload) throw new Error('已有更新正在下载，请稍候。');
  activeDownload = performDownload(asset, onProgress, force).finally(() => {
    activeDownload = null;
  });
  return activeDownload;
}

/**
 * Electron's `net` stack can stall on GitHub's cross-origin release-asset
 * redirect in some builds. Downloads use Node's HTTPS client instead; the
 * release host is fixed and public, so no session cookies are needed.
 */
function openDownloadResponse(url, redirects = 0) {
  const https = require('node:https');
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'Open-source-Minecraft-launcher-Updater',
          Accept: 'application/octet-stream',
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 8) {
            reject(new Error('更新包下载重定向次数过多。'));
            return;
          }
          const next = new URL(response.headers.location, url).toString();
          resolve(openDownloadResponse(next, redirects + 1));
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`更新包下载失败（HTTP ${status}）。`));
          return;
        }
        response.setTimeout(60000, () => {
          response.destroy(new Error('更新包下载超时。'));
        });
        resolve(response);
      },
    );
    request.setTimeout(30000, () => {
      request.destroy(new Error('连接 GitHub 超时。'));
    });
    request.on('error', reject);
  });
}

async function performDownload(asset, onProgress, force = false) {
  const fs = require('node:fs');
  const path = require('node:path');
  const valid = assertReleaseAsset(asset);
  const directory = updatesDirectory();
  await fs.promises.mkdir(directory, { recursive: true });
  const fileName = safeFileName(valid.name);
  const finalPath = path.join(directory, fileName);
  const partialPath = `${finalPath}.part`;

  try {
    const existing = await fs.promises.stat(finalPath);
    if (!force && (!valid.size || existing.size === valid.size)) {
      onProgress?.({
        received: existing.size,
        total: valid.size || existing.size,
        percent: 100,
        fileName,
      });
      return { path: finalPath, bytes: existing.size, fileName };
    }
    await fs.promises.rm(finalPath, { force: true });
  } catch {
    // Download below.
  }

  return new Promise((resolve, reject) => {
    let received = 0;
    let lastReport = 0;
    let settled = false;
    const file = fs.createWriteStream(partialPath);

    const cleanup = async (error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      await fs.promises.rm(partialPath, { force: true }).catch(() => undefined);
      reject(error);
    };

    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 120) return;
      lastReport = now;
      const total = valid.size || 0;
      onProgress?.({
        received,
        total,
        percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        fileName,
      });
    };

    file.on('error', (error) => {
      void cleanup(new Error(`无法保存更新包：${error.message}`));
    });

    const start = async () => {
      let response;
      try {
        response = await openDownloadResponse(valid.url);
      } catch (error) {
        void cleanup(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (settled) {
        response.destroy();
        return;
      }

      const headerSize = Number(response.headers['content-length']);
      const total = Number.isFinite(headerSize) && headerSize > 0 ? headerSize : valid.size;
      if (total > 0) valid.size = total;
      report(true);

      response.on('data', (chunk) => {
        received += chunk.length;
        report();
      });
      response.on('error', (error) => {
        void cleanup(new Error(`更新包下载中断：${error.message}`));
      });
      response.on('aborted', () => {
        void cleanup(new Error('更新包下载被中断。'));
      });
      response.pipe(file);

      file.on('finish', () => {
        if (settled) return;
        if (valid.size > 0 && received !== valid.size) {
          void cleanup(
            new Error(`更新包大小校验失败（期望 ${valid.size} 字节，实际 ${received} 字节）。`),
          );
          return;
        }
        settled = true;
        fs.promises
          .rename(partialPath, finalPath)
          .then(() => {
            onProgress?.({
              received,
              total: valid.size || received,
              percent: 100,
              fileName,
            });
            resolve({ path: finalPath, bytes: received, fileName });
          })
          .catch((error) => {
            settled = false;
            void cleanup(error);
          });
      });
    };

    void start();
  });
}

function spawnDetached(command, args, options = {}) {
  const { spawn } = require('node:child_process');
  let child;
  try {
    child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      ...options,
    });
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve(child);
    };
    const onError = (error) => {
      child.removeListener('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  }).then((spawned) => {
    spawned.unref();
    return spawned;
  });
}

async function schedulePortableReplacement(source, target) {
  const { app } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const scriptPath = path.join(updatesDirectory(), `apply-update-${Date.now()}.cmd`);
  const script = [
    '@echo off',
    'setlocal',
    'set "SOURCE=%OSML_UPDATE_SOURCE%"',
    'set "TARGET=%OSML_UPDATE_TARGET%"',
    'set /a tries=0',
    ':retry',
    'move /Y "%SOURCE%" "%TARGET%" >nul 2>&1',
    'if not errorlevel 1 goto done',
    'set /a tries+=1',
    'if %tries% GEQ 120 goto cleanup',
    'timeout /t 1 /nobreak >nul',
    'goto retry',
    ':done',
    'start "" "%TARGET%"',
    ':cleanup',
    'del "%~f0"',
  ].join('\r\n');
  fs.writeFileSync(scriptPath, script, 'utf8');
  try {
    await spawnDetached('cmd.exe', ['/d', '/s', '/c', scriptPath], {
      windowsHide: true,
      env: {
        ...process.env,
        OSML_UPDATE_SOURCE: source,
        OSML_UPDATE_TARGET: target,
      },
    });
  } catch (error) {
    fs.rmSync(scriptPath, { force: true });
    throw error;
  }
  setTimeout(() => app.quit(), 900);
}

async function scheduleAppImageReplacement(source, target) {
  const { app } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const scriptPath = path.join(updatesDirectory(), `apply-update-${Date.now()}.sh`);
  const script = [
    '#!/bin/sh',
    'tries=0',
    'while [ "$tries" -lt 120 ]; do',
    '  if cp "$OSML_UPDATE_SOURCE" "$OSML_UPDATE_TARGET"; then',
    '    break',
    '  fi',
    '  tries=$((tries + 1))',
    '  sleep 1',
    'done',
    'chmod +x "$OSML_UPDATE_TARGET"',
    '"$OSML_UPDATE_TARGET" >/dev/null 2>&1 &',
    'rm -f "$0"',
  ].join('\n');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  try {
    await spawnDetached('/bin/sh', [scriptPath], {
      env: {
        ...process.env,
        OSML_UPDATE_SOURCE: source,
        OSML_UPDATE_TARGET: target,
      },
    });
  } catch (error) {
    fs.rmSync(scriptPath, { force: true });
    throw error;
  }
  setTimeout(() => app.quit(), 900);
}

async function installUpdate(filePath) {
  const { app, shell } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');

  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('更新包路径为空。');
  }
  const resolved = path.resolve(filePath);
  const root = path.resolve(updatesDirectory());
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('只能安装由启动器下载的更新包。');
  }
  const stat = await fs.promises.stat(resolved).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error('更新包不存在，请重新下载。');

  const lower = resolved.toLowerCase();
  if (process.platform === 'win32' && (lower.endsWith('.exe') || lower.endsWith('.msi'))) {
    const portableTarget = process.env.PORTABLE_EXECUTABLE_FILE;
    const isSetup = /setup|installer/i.test(path.basename(resolved));
    if (portableTarget && !isSetup) {
      await schedulePortableReplacement(resolved, portableTarget);
      return {
        action: 'replace',
        message: '启动器正在退出，更新完成后会自动重新打开。',
      };
    }

    if (lower.endsWith('.msi')) {
      await spawnDetached('msiexec.exe', ['/i', resolved], { windowsHide: false });
    } else {
      await spawnDetached(resolved, [], { windowsHide: false });
    }
    setTimeout(() => app.quit(), 1200);
    return {
      action: 'installer',
      message: '安装程序已启动，启动器将退出；请按安装程序提示完成更新。',
    };
  }

  if (process.platform === 'linux' && lower.endsWith('.appimage') && process.env.APPIMAGE) {
    await scheduleAppImageReplacement(resolved, process.env.APPIMAGE);
    return {
      action: 'replace',
      message: '启动器正在退出，更新完成后会自动重新打开。',
    };
  }

  const error = await shell.openPath(resolved);
  if (error) throw new Error(error);
  return {
    action: 'open',
    message: '已打开更新包，请按系统提示完成安装。',
  };
}

module.exports = {
  UPDATE_REPOSITORY,
  RELEASES_URL,
  LATEST_RELEASE_URL,
  extractVersion,
  isNewerVersion,
  releaseVersion,
  pickUpdateAsset,
  updatesDirectory,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
};
