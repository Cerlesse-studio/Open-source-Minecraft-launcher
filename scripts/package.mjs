#!/usr/bin/env node
/**
 * One-command desktop packaging.
 *
 *   npm run package                 # current platform (installer + OTA files)
 *   npm run package:win             # Windows: NSIS + portable EXE
 *   npm run package:mac             # macOS: DMG + ZIP
 *   npm run package:linux           # Linux: AppImage
 *   npm run package:ota             # rebuild latest.json / SHA256SUMS.txt only
 *
 * A native Rust core binary is embedded in the application, and macOS
 * packaging needs Apple's toolchain, so every platform must be built on its
 * own operating system (or on the matching CI runner). Cross-building a
 * macOS/Windows/Linux bundle from one host would silently embed the wrong
 * core binary, which is why this script refuses to do it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = String(PACKAGE.version || '').trim();
const PRODUCT_NAME = PACKAGE.build?.productName || PACKAGE.name || 'app';
const CORE_NAME = 'open-source-minecraft-launcher';
const REPOSITORY = 'Cerlesse-studio/Open-source-Minecraft-launcher';
const [REPO_OWNER, REPO_NAME] = REPOSITORY.split('/');
const RELEASE_ROOT = path.join(ROOT, 'release');
const BUILD_ROOT = path.join(RELEASE_ROOT, '.build');
const OUTPUT_DIR = path.join(RELEASE_ROOT, `v${VERSION}`);

const PLATFORMS = {
  win: {
    id: 'win',
    label: 'Windows',
    nodeName: 'win32',
    builderFlag: '--win',
    targets: ['nsis', 'portable'],
    metadataName: 'latest.yml',
  },
  mac: {
    id: 'mac',
    label: 'macOS',
    nodeName: 'darwin',
    builderFlag: '--mac',
    targets: ['dmg', 'zip'],
    metadataName: 'latest-mac.yml',
  },
  linux: {
    id: 'linux',
    label: 'Linux',
    nodeName: 'linux',
    builderFlag: '--linux',
    targets: ['AppImage'],
    metadataName: 'latest-linux.yml',
  },
};

const ARCH_FLAGS = {
  x64: '--x64',
  arm64: '--arm64',
  ia32: '--ia32',
};

function printHelp() {
  console.log(`
一键打包脚本

用法:
  node scripts/package.mjs [选项]

选项:
  --platform <win|mac|linux>  目标平台，默认当前系统
  --skip-build                跳过 Rust 核心与前端编译（复用已有产物）
  --ota-only                  不打包，只根据现有安装包重建 OTA 清单
  --tag <vX.Y.Z>              Release 标签，默认 v${VERSION}
  --base-url <url>            OTA 下载地址前缀，默认 GitHub Release
  -h, --help                  显示帮助

直接使用 npm 命令:
  npm run package         当前平台
  npm run package:win     Windows
  npm run package:mac     macOS
  npm run package:linux   Linux
  npm run package:ota     只重建 OTA 文件
`);
}

function parseArgs(argv) {
  const options = {
    platform: null,
    skipBuild: false,
    otaOnly: false,
    tag: `v${VERSION}`,
    baseUrl: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--skip-build' || arg === '--no-build') {
      options.skipBuild = true;
    } else if (arg === '--ota-only') {
      options.otaOnly = true;
      options.skipBuild = true;
    } else if (arg === '--platform' || arg === '--target') {
      options.platform = argv[++index] || null;
    } else if (arg.startsWith('--platform=')) {
      options.platform = arg.slice('--platform='.length);
    } else if (arg === '--tag') {
      options.tag = argv[++index] || options.tag;
    } else if (arg.startsWith('--tag=')) {
      options.tag = arg.slice('--tag='.length);
    } else if (arg === '--base-url') {
      options.baseUrl = argv[++index] || null;
    } else if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length);
    } else if (arg === '--win' || arg === '--windows') {
      options.platform = 'win';
    } else if (arg === '--mac' || arg === '--macos') {
      options.platform = 'mac';
    } else if (arg === '--linux') {
      options.platform = 'linux';
    } else {
      throw new Error(`未知参数：${arg}\n使用 --help 查看用法。`);
    }
  }

  if (options.platform === 'win32' || options.platform === 'windows') options.platform = 'win';
  if (options.platform === 'darwin') options.platform = 'mac';
  if (options.platform === 'all') {
    throw new Error(
      '不能在单个系统上构建全部平台：安装包会内嵌对应平台的 Rust 核心，macOS 还需要 Apple 工具链。\n' +
        '请分别在 Windows、macOS、Linux 上运行 npm run package，或使用对应平台的 CI 构建。',
    );
  }
  if (options.platform && !PLATFORMS[options.platform]) {
    throw new Error(`不支持的平台：${options.platform}（可选 win / mac / linux）`);
  }
  if (!options.tag.startsWith('v')) options.tag = `v${options.tag}`;
  return options;
}

function hostPlatform() {
  if (process.platform === 'win32') return PLATFORMS.win;
  if (process.platform === 'darwin') return PLATFORMS.mac;
  if (process.platform === 'linux') return PLATFORMS.linux;
  throw new Error(`不支持的主机平台：${process.platform}`);
}

function run(command, args, options = {}) {
  const printable = [command, ...args].join(' ');
  if (options.label) console.log(`\n▶ ${options.label}`);
  console.log(`  ${printable}`);

  const env = { ...process.env, ...(options.env || {}) };
  for (const key of options.unsetEnv || []) delete env[key];

  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.stdio || 'inherit',
    env,
    shell: Boolean(options.shell),
  });
  if (result.error) throw new Error(`无法运行 ${printable}：${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${printable} 失败（退出码 ${result.status ?? 'unknown'}）`);
  }
}

function runNpm(args, label) {
  const npmCli = process.env.npm_execpath;
  if (npmCli && fs.existsSync(npmCli)) {
    run(process.execPath, [npmCli, ...args], { label });
    return;
  }
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(command, args, { label, shell: process.platform === 'win32' });
}

function commandWorks(command, args = ['--version']) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'ignore' });
  return !result.error && result.status === 0;
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

async function ensureDependencies() {
  const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  if (await pathExists(builderCli)) return builderCli;

  console.log('\n未找到 electron-builder，先安装项目依赖…');
  runNpm(['ci'], '安装依赖');
  if (!(await pathExists(builderCli))) {
    throw new Error('安装依赖后仍未找到 electron-builder，请检查 npm ci 输出。');
  }
  return builderCli;
}

function hostArch() {
  return ARCH_FLAGS[process.arch] ? process.arch : null;
}

async function buildCore(platform) {
  if (!commandWorks('cargo')) {
    throw new Error('未找到 Rust / Cargo。请先安装 Rust stable 工具链并重新打开终端。');
  }
  if (!commandWorks('rustc')) {
    throw new Error('未找到 rustc。请检查 Rust 工具链安装。');
  }

  run(
    'cargo',
    ['build', '--release', '--manifest-path', path.join('src-tauri', 'Cargo.toml')],
    {
      label: '编译 Rust 核心',
      // electron-builder 的 extraResources 固定从 src-tauri/target/release 读取。
      unsetEnv: ['CARGO_TARGET_DIR'],
    },
  );

  const corePath = path.join(
    ROOT,
    'src-tauri',
    'target',
    'release',
    platform.id === 'win' ? `${CORE_NAME}.exe` : CORE_NAME,
  );
  const stat = await fsp.stat(corePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`Rust 核心编译完成但未找到文件：${path.relative(ROOT, corePath)}`);
  }
  return corePath;
}

async function buildFrontend() {
  runNpm(['run', 'build'], '构建前端');
  if (!(await pathExists(path.join(ROOT, 'dist', 'index.html')))) {
    throw new Error('前端构建完成但未找到 dist/index.html。');
  }
}

async function verifyExistingBuild(platform) {
  const core = path.join(
    ROOT,
    'src-tauri',
    'target',
    'release',
    platform.id === 'win' ? `${CORE_NAME}.exe` : CORE_NAME,
  );
  if (!(await pathExists(core))) {
    throw new Error(`缺少已编译的 Rust 核心：${path.relative(ROOT, core)}。去掉 --skip-build 后重试。`);
  }
  if (!(await pathExists(path.join(ROOT, 'dist', 'index.html')))) {
    throw new Error('缺少前端产物 dist/index.html。去掉 --skip-build 后重试。');
  }
}

function platformForFile(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.blockmap')) {
    return platformForFile(name.slice(0, -'.blockmap'.length));
  }
  if (lower.endsWith('.exe') || lower.endsWith('.msi')) return 'win32';
  if (lower.endsWith('.dmg') || lower.endsWith('.pkg')) return 'darwin';
  if (lower.endsWith('.appimage') || lower.endsWith('.deb') || lower.endsWith('.rpm')) {
    return 'linux';
  }
  if (lower.endsWith('.zip')) {
    if (/mac|darwin/.test(lower)) return 'darwin';
    if (/win|windows/.test(lower)) return 'win32';
    if (/linux/.test(lower)) return 'linux';
    return 'darwin';
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tar.xz')) return 'linux';
  return null;
}

function metadataPlatform(name) {
  const lower = name.toLowerCase();
  if (lower === 'latest.json') return null;
  if (/^latest-mac\.(?:ya?ml|json)$/.test(lower)) return 'darwin';
  if (/^latest-linux.*\.(?:ya?ml|json)$/.test(lower)) return 'linux';
  if (/^(?:latest|alpha|beta)\.(?:ya?ml|json)$/.test(lower)) return 'win32';
  return null;
}

function isMetadataFile(name) {
  return metadataPlatform(name) !== null;
}

function isDistributableFile(name) {
  return platformForFile(name) !== null;
}

function fileKind(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.blockmap')) return 'blockmap';
  if (lower.endsWith('.exe')) return /setup|installer|install/.test(lower) ? 'nsis' : 'portable';
  if (lower.endsWith('.msi')) return 'msi';
  if (lower.endsWith('.dmg')) return 'dmg';
  if (lower.endsWith('.pkg')) return 'pkg';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.appimage')) return 'appimage';
  if (lower.endsWith('.deb')) return 'deb';
  if (lower.endsWith('.rpm')) return 'rpm';
  return 'other';
}

function archFromName(name) {
  const lower = name.toLowerCase();
  if (/arm64|aarch64/.test(lower)) return 'arm64';
  if (/x86_64|x64|amd64/.test(lower)) return 'x64';
  if (/ia32|i386|x86/.test(lower)) return 'ia32';
  return null;
}

async function moveFile(source, destination) {
  await fsp.rm(destination, { force: true });
  try {
    await fsp.rename(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fsp.copyFile(source, destination);
    const stat = await fsp.stat(source);
    await fsp.chmod(destination, stat.mode).catch(() => undefined);
    await fsp.rm(source, { force: true });
  }
}

async function prunePlatformArtifacts(platform) {
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const entries = await fsp.readdir(OUTPUT_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === 'latest.json' || entry.name === 'SHA256SUMS.txt') continue;
    const owner = metadataPlatform(entry.name) || platformForFile(entry.name);
    if (owner === platform.nodeName) {
      await fsp.rm(path.join(OUTPUT_DIR, entry.name), { force: true });
    }
  }
}

async function collectArtifacts(buildDir, platform) {
  const entries = await fsp.readdir(buildDir, { withFileTypes: true }).catch(() => []);
  if (entries.length === 0) {
    throw new Error(`electron-builder 没有在 ${path.relative(ROOT, buildDir)} 生成文件。`);
  }

  await prunePlatformArtifacts(platform);

  const moved = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!isDistributableFile(name) && !isMetadataFile(name)) continue;

    const source = path.join(buildDir, name);
    const destination = path.join(OUTPUT_DIR, name);
    await moveFile(source, destination);
    moved.push(name);
  }

  if (moved.length === 0) {
    throw new Error(`未在 ${path.relative(ROOT, buildDir)} 找到安装包或 OTA 元数据。`);
  }

  const metadata = moved.filter(
    (name) => metadataPlatform(name) === platform.nodeName && /\.ya?ml$/i.test(name),
  );
  if (metadata.length === 0) {
    console.warn(
      `\n[警告] 本次构建没有生成 ${platform.metadataName}。安装包仍可用，但 OTA 元数据缺失。`,
    );
  } else {
    await validateUpdateMetadata(metadata);
  }

  console.log(`\n已收集 ${moved.length} 个文件：`);
  for (const name of moved.sort()) console.log(`  • ${name}`);
}

async function validateUpdateMetadata(metadataFiles) {
  for (const metadata of metadataFiles) {
    const content = await fsp.readFile(path.join(OUTPUT_DIR, metadata), 'utf8');
    const references = new Set();
    for (const match of content.matchAll(/^\s*(?:url|path):\s*(.+?)\s*$/gm)) {
      const value = match[1].replace(/^['"]|['"]$/g, '').trim();
      if (value) references.add(value);
    }
    for (const reference of references) {
      if (!(await pathExists(path.join(OUTPUT_DIR, reference)))) {
        throw new Error(
          `${metadata} 引用了不存在的文件：${reference}\n` +
            '请检查 artifactName 是否包含空格，或 OTA 元数据是否与实际产物一致。',
        );
      }
    }
  }
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function releaseBaseUrl(options) {
  if (options.baseUrl) return options.baseUrl.replace(/\/+$/, '');
  return `https://github.com/${REPOSITORY}/releases/download/${options.tag}`;
}

async function writeOtaManifest(options) {
  if (!(await pathExists(OUTPUT_DIR))) {
    throw new Error(`OTA 目录不存在：${path.relative(ROOT, OUTPUT_DIR)}。请先执行打包。`);
  }

  const entries = await fsp.readdir(OUTPUT_DIR, { withFileTypes: true });
  const baseUrl = releaseBaseUrl(options);
  const files = [];
  const metadata = { windows: null, macOS: null, linux: null };

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const metadataOwner = metadataPlatform(name);
    if (metadataOwner) {
      const key = metadataOwner === 'win32' ? 'windows' : metadataOwner === 'darwin' ? 'macOS' : 'linux';
      const current = metadata[key];
      // Prefer the current YAML format over electron-updater 1.x's JSON file.
      if (!current || (name.toLowerCase().endsWith('.yml') && current.toLowerCase().endsWith('.json'))) {
        metadata[key] = name;
      }
      continue;
    }
    if (!isDistributableFile(name)) continue;

    const fullPath = path.join(OUTPUT_DIR, name);
    const stat = await fsp.stat(fullPath);
    const sha256 = await sha256File(fullPath);
    files.push({
      name,
      platform: platformForFile(name),
      kind: fileKind(name),
      arch: archFromName(name),
      size: stat.size,
      sha256,
      url: `${baseUrl}/${encodeURIComponent(name)}`,
    });
  }

  files.sort((left, right) =>
    `${left.platform}:${left.kind}:${left.name}`.localeCompare(`${right.platform}:${right.kind}:${right.name}`),
  );

  const manifest = {
    schemaVersion: 1,
    productName: PRODUCT_NAME,
    version: VERSION,
    tag: options.tag,
    channel: 'stable',
    generatedAt: new Date().toISOString(),
    repository: REPOSITORY,
    releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/${options.tag}`,
    metadata,
    files,
  };
  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'latest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const sums = files.map((file) => `${file.sha256}  ${file.name}`).join('\n');
  await fsp.writeFile(
    path.join(OUTPUT_DIR, 'SHA256SUMS.txt'),
    sums ? `${sums}\n` : '',
    'utf8',
  );

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  console.log(`\nOTA 清单已生成：${files.length} 个文件，共 ${formatBytes(totalBytes)}`);
  console.log(`  • latest.json`);
  console.log(`  • SHA256SUMS.txt`);
  for (const [key, value] of Object.entries(metadata)) {
    if (value) console.log(`  • ${value} (${key})`);
  }
  return files;
}

async function packagePlatform(platform, options, builderCli) {
  const buildDir = path.join(BUILD_ROOT, platform.id);
  const relativeOutput = path.relative(ROOT, buildDir).split(path.sep).join('/');

  console.log(`\n=== 打包 ${platform.label} · v${VERSION} ===`);
  console.log(`产物目录：${path.relative(ROOT, OUTPUT_DIR)}`);

  if (!options.skipBuild) {
    await buildCore(platform);
    await buildFrontend();
  } else {
    await verifyExistingBuild(platform);
  }

  await fsp.rm(buildDir, { recursive: true, force: true });
  await fsp.mkdir(buildDir, { recursive: true });

  const args = [
    builderCli,
    platform.builderFlag,
    ...platform.targets,
    '--publish',
    'never',
    `--config.directories.output=${relativeOutput}`,
    '--config.publish.provider=github',
    `--config.publish.owner=${REPO_OWNER}`,
    `--config.publish.repo=${REPO_NAME}`,
    '--config.publish.releaseType=release',
  ];
  const arch = hostArch();
  if (arch && ARCH_FLAGS[arch]) args.push(ARCH_FLAGS[arch]);

  run(process.execPath, args, { label: `electron-builder：${platform.targets.join(' + ')}` });

  await collectArtifacts(buildDir, platform);
  const files = await writeOtaManifest(options);

  console.log('\n=== 打包完成 ===');
  console.log(`平台：${platform.label} (${process.arch})`);
  console.log(`目录：${path.relative(ROOT, OUTPUT_DIR)}`);
  console.log('安装包：');
  for (const file of files.filter((item) => item.kind !== 'blockmap')) {
    console.log(`  • ${file.name} (${formatBytes(file.size)})`);
  }
  console.log('\nOTA 文件：latest*.yml、latest.json、SHA256SUMS.txt');
  console.log(`将 ${path.relative(ROOT, OUTPUT_DIR)} 内的全部文件上传到 GitHub Release ${options.tag}。`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (!VERSION) throw new Error('package.json 缺少 version 字段。');

  if (options.otaOnly) {
    console.log(`\n=== 重建 OTA 文件 · v${VERSION} ===`);
    await writeOtaManifest(options);
    return;
  }

  const host = hostPlatform();
  const platform = options.platform ? PLATFORMS[options.platform] : host;
  if (platform.id !== host.id) {
    throw new Error(
      `当前主机是 ${host.label}，不能构建 ${platform.label} 安装包。\n` +
        '安装包会内嵌对应平台的 Rust 核心，macOS 还需要 Apple 工具链。\n' +
        `请在 ${platform.label} 上运行 npm run package，或在 CI 中使用对应平台的 runner。`,
    );
  }

  const builderCli = await ensureDependencies();
  await packagePlatform(platform, options, builderCli);
}

main().catch((error) => {
  console.error(`\n[打包失败] ${error.message}`);
  if (error.stack && process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
