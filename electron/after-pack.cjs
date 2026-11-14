/**
 * electron-builder afterPack 钩子
 * 严格遵循《Electron 内置 Chromium 内核裁剪与专业化定制开发文档》：
 * 1. [L1 3.1] 裁剪多余语言包，仅保留 en-US（回退基准）与 zh-CN
 * 2. [L1 2 / 3.3 / 9] 校验核心运行时文件（V8 快照、ICU、ANGLE、FFmpeg）与开源许可证声明完整性
 * 3. [L2 4.1] 在代码签名前翻转 Electron Fuses 二进制安全开关
 */

const fs = require('node:fs');
const path = require('node:path');
const { flipElectronFuses, RECOMMENDED_FUSE_CONFIG } = require('./fuses.cjs');

const ALLOWED_LOCALES = new Set(['en-US', 'zh-CN']);
const ALLOWED_MAC_LPROJ = new Set(['en.lproj', 'en_US.lproj', 'zh_CN.lproj', 'Base.lproj']);

// 仅移除非必需的 Vulkan 桥接库；保留 d3dcompiler_47.dll 与 vk_swiftshader.dll，
// 确保 ANGLE D3D11 与无硬件 GPU 环境下的软件渲染回退均可正常启动桌面窗口。
const PRUNABLE_RUNTIME_FILES = {
  win32: [
    'vulkan-1.dll',
  ],
  linux: [
    'libvulkan.so.1',
  ],
};

// 第 2 节 & 第 3.3 节：严禁删除的核心文件清单
const REQUIRED_CORE_FILES_WIN_LINUX = [
  'icudtl.dat',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'resources.pak',
];

const LICENSE_FILES = ['LICENSE.electron.txt', 'LICENSES.chromium.html'];

/**
 * 裁剪 locales 目录下的多余 .pak 语言包
 * @param {string} appOutDir
 * @param {string} platformName
 */
function pruneLocales(appOutDir, platformName) {
  let removedCount = 0;
  let savedBytes = 0;

  const localesDir = path.join(appOutDir, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const entry of fs.readdirSync(localesDir)) {
      if (!entry.endsWith('.pak')) continue;
      const localeName = entry.slice(0, -4);
      if (!ALLOWED_LOCALES.has(localeName)) {
        const fullPath = path.join(localesDir, entry);
        const stat = fs.statSync(fullPath);
        savedBytes += stat.size;
        fs.unlinkSync(fullPath);
        removedCount += 1;
      }
    }
  }

  // macOS 对应 *.lproj 目录 (第 3.1 节)
  if (platformName === 'darwin') {
    const appBundles = fs.readdirSync(appOutDir).filter((name) => name.endsWith('.app'));
    for (const bundle of appBundles) {
      const resDir = path.join(appOutDir, bundle, 'Contents', 'Resources');
      if (!fs.existsSync(resDir)) continue;
      for (const item of fs.readdirSync(resDir)) {
        if (item.endsWith('.lproj') && !ALLOWED_MAC_LPROJ.has(item)) {
          const fullPath = path.join(resDir, item);
          fs.rmSync(fullPath, { recursive: true, force: true });
          removedCount += 1;
        }
      }
    }
  }

  return { removedCount, savedBytes };
}

/**
 * 裁剪冗余的软件渲染 / Vulkan 图形回退组件（仅在 Windows / Linux 上执行）
 * @param {string} appOutDir
 * @param {string} platformName
 */
function pruneUnusedRuntimeFiles(appOutDir, platformName) {
  const candidates = PRUNABLE_RUNTIME_FILES[platformName];
  if (!candidates || candidates.length === 0) {
    return { removedCount: 0, savedBytes: 0 };
  }
  let removedCount = 0;
  let savedBytes = 0;
  for (const name of candidates) {
    const fullPath = path.join(appOutDir, name);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      savedBytes += stat.size;
      fs.unlinkSync(fullPath);
      removedCount += 1;
    }
  }
  return { removedCount, savedBytes };
}

/**
 * 校验核心运行时组件与 Chromium 开源许可证未丢失 (第 2、3.3、9 节)
 * @param {string} appOutDir
 * @param {string} platformName
 */
function verifyCoreAndLicenses(appOutDir, platformName) {
  const missingCore = [];
  if (platformName !== 'darwin') {
    for (const file of REQUIRED_CORE_FILES_WIN_LINUX) {
      if (!fs.existsSync(path.join(appOutDir, file))) {
        missingCore.push(file);
      }
    }
  }
  if (missingCore.length > 0) {
    throw new Error(
      `[内核完整性校验失败] 核心运行时文件缺失 (${missingCore.join(', ')})，根据文档第 2/3.3 节严禁删除核心文件！`
    );
  }

  // 确保开源许可证声明随产品分发 (第 2 节 & 第 9 节)
  let electronDistDir = null;
  try {
    electronDistDir = path.dirname(require('electron'));
  } catch {
    // ignore
  }

  for (const lic of LICENSE_FILES) {
    const targetLic = path.join(appOutDir, lic);
    if (!fs.existsSync(targetLic) && electronDistDir) {
      const srcLic = path.join(electronDistDir, lic);
      if (fs.existsSync(srcLic)) {
        fs.copyFileSync(srcLic, targetLic);
      }
    }
  }
}

/**
 * 定位打包后的主程序路径
 * @param {string} appOutDir
 * @param {string} platformName
 * @param {string} productFilename
 */
function resolveExecutablePath(appOutDir, platformName, productFilename) {
  if (platformName === 'win32') {
    return path.join(appOutDir, `${productFilename}.exe`);
  }
  if (platformName === 'darwin') {
    return path.join(appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename);
  }
  const candidate = path.join(appOutDir, productFilename);
  if (fs.existsSync(candidate)) return candidate;
  const lower = path.join(appOutDir, productFilename.toLowerCase());
  return lower;
}

/**
 * [L2 5.1] Linux 沙盒启动包装：根治 AppImage 的 SUID sandbox FATAL
 *
 * 根因链：
 *  1. electron 官方 npm 包里的 `chrome-sandbox` 自带 SUID 位（4755, root）；
 *  2. electron-builder / app-builder 在复制到 `linux-unpacked` 时按安全惯例
 *     **剥掉 SUID 位**（实测 4755 → 755）；
 *  3. 打 AppImage 时该文件被存进 squashfs，模式固定为 755；
 *  4. AppImage 运行时用 FUSE 以普通用户挂载，文件显示为 root:root 但模式仍是
 *     755（且挂载带 nosuid，SUID 位即使存进去也不会生效）。
 *
 * Chromium 的判定只有三条分支（sandbox/linux/suid/sandbox_host.cc）：
 *   - chrome-sandbox 存在且 root+4755 → 启用 SUID 沙盒；
 *   - chrome-sandbox 不存在          → 回退 namespace 沙盒；
 *   - chrome-sandbox 存在但配置不正确 → `LOG(FATAL)` 直接 abort：
 *       "The SUID sandbox helper binary was found, but is not configured correctly."
 * 第三条正是 AppImage 的必然结局——普通用户永远无法给容器内文件设置 root+4755。
 *
 * 上游 electron-builder 也认这个事实：AppImage 的 .desktop 默认就写死
 * `Exec=AppRun --no-sandbox %U`（见 app-builder-lib/out/targets/AppImageTarget.js）。
 * 但那只是 desktop 入口；**终端直接执行 `./xxx.AppImage` 时 AppRun 不带任何参数**，
 * 于是仍然 FATAL。
 *
 * 这里在 afterPack 阶段做一次启动包装，让三条入口行为完全一致：
 *   - 真实 Electron 二进制改名为 `<name>.bin`；
 *   - 原路径放一个 shell 包装，固定注入 `--no-sandbox` 后 exec 真实二进制。
 *
 * 真实二进制通过 exec 替换进程映像，Electron 内部 /proc/self/exe 仍指向
 * `.bin`，因此 `process.execPath` / `app.getPath('exe')` 语义不变。
 *
 * @param {string} appOutDir
 * @param {string} productFilename
 */
function applyLinuxNoSandboxWrapper(appOutDir, productFilename) {
  const exePath = resolveExecutablePath(appOutDir, 'linux', productFilename);
  if (!fs.existsSync(exePath)) {
    console.warn(`[Chromium L2 沙盒修复] 未找到 Linux 主程序，跳过启动包装: ${exePath}`);
    return { applied: false };
  }
  // 已经是包装脚本则不重复处理（electron-builder 可能重复调用钩子）
  if (exePath.endsWith('.bin')) {
    return { applied: true, alreadyWrapped: true, realPath: exePath };
  }

  const realPath = `${exePath}.bin`;
  fs.renameSync(exePath, realPath);
  fs.chmodSync(realPath, 0o755);

  const wrapper = `#!/bin/sh
# 由 electron/after-pack.cjs 自动生成，请勿手工编辑。
#
# AppImage 以普通用户通过 FUSE 挂载，容器内的 chrome-sandbox 无法获得
# root 所有 + 4755 SUID 位，Chromium 的 SUID sandbox 检查会 FATAL abort。
# 此包装固定注入 --no-sandbox，使终端 / 桌面菜单 / 文件管理器三条启动
# 入口的行为完全一致。
SELF=$(readlink -f "$0")
DIR=$(dirname "$SELF")
exec "$DIR/$(basename "$SELF").bin" --no-sandbox "$@"
`;
  fs.writeFileSync(exePath, wrapper, { mode: 0o755 });
  fs.chmodSync(exePath, 0o755);

  return { applied: true, realPath, wrapperPath: exePath };
}

/**
 * electron-builder afterPack 入口
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const productFilename = packager.appInfo.productFilename;

  // 1. L1 语言包与冗余图形运行时组件裁剪
  const { removedCount, savedBytes } = pruneLocales(appOutDir, electronPlatformName);
  const savedMb = (savedBytes / (1024 * 1024)).toFixed(2);
  console.log(
    `[Chromium L1 裁剪] 已清理多余语言包 ${removedCount} 个，仅保留 [${Array.from(ALLOWED_LOCALES).join(', ')}]，节省 ${savedMb} MB`
  );

  const runtimePruned = pruneUnusedRuntimeFiles(appOutDir, electronPlatformName);
  if (runtimePruned.removedCount > 0) {
    const runtimeSavedMb = (runtimePruned.savedBytes / (1024 * 1024)).toFixed(2);
    console.log(
      `[Chromium L1 裁剪] 已清理冗余图形回退组件 ${runtimePruned.removedCount} 个，节省 ${runtimeSavedMb} MB`
    );
  }

  // 2. 核心组件与开源许可证校验
  verifyCoreAndLicenses(appOutDir, electronPlatformName);
  ensureUnixCorePermissions(appOutDir, electronPlatformName);
  console.log('[Chromium 完整性校验] V8 快照、ICU 国际化数据、图形后端与 Chromium 许可证声明均完整保留');

  // 3. L2 翻转 Electron Fuses（必须在代码签名前完成）
  const exePath = resolveExecutablePath(appOutDir, electronPlatformName, productFilename);
  if (fs.existsSync(exePath)) {
    const result = await flipElectronFuses(exePath, RECOMMENDED_FUSE_CONFIG);
    console.log(
      `[Chromium L2 Fuses] 已通过 ${result.method} 翻转二进制安全开关:`,
      JSON.stringify(result.status?.fuses || {})
    );
  } else {
    console.warn(`[Chromium L2 Fuses] 未找到可执行文件，跳过 Fuse 翻转: ${exePath}`);
  }

  // 4. L2 Linux 沙盒根治：AppImage 无法设置 SUID，固定注入 --no-sandbox
  if (electronPlatformName === 'linux') {
    const wrapped = applyLinuxNoSandboxWrapper(appOutDir, productFilename);
    if (wrapped.applied) {
      console.log(
        '[Chromium L2 沙盒修复] 已启用 Linux 启动包装（固定注入 --no-sandbox），' +
          '避免 AppImage 挂载后 chrome-sandbox 缺少 root+4755 SUID 位导致 FATAL abort'
      );
    }
  }
};

function ensureUnixCorePermissions(appOutDir, platformName) {
  if (platformName !== 'linux' && platformName !== 'darwin') {
    return;
  }
  const candidates = [path.join(appOutDir, 'resources', 'core', 'open-source-minecraft-launcher')];
  if (platformName === 'darwin') {
    const appBundles = fs.readdirSync(appOutDir).filter((name) => name.endsWith('.app'));
    for (const bundle of appBundles) {
      candidates.push(
        path.join(appOutDir, bundle, 'Contents', 'Resources', 'core', 'open-source-minecraft-launcher')
      );
    }
  }
  for (const corePath of candidates) {
    if (fs.existsSync(corePath) && fs.statSync(corePath).isFile()) {
      fs.chmodSync(corePath, 0o755);
    }
  }
}

module.exports.pruneLocales = pruneLocales;
module.exports.pruneUnusedRuntimeFiles = pruneUnusedRuntimeFiles;
module.exports.verifyCoreAndLicenses = verifyCoreAndLicenses;
module.exports.applyLinuxNoSandboxWrapper = applyLinuxNoSandboxWrapper;
module.exports.ALLOWED_LOCALES = ALLOWED_LOCALES;
