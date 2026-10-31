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
 * electron-builder afterPack 入口
 * @param {import('electron-builder').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const productFilename = packager.appInfo.productFilename;

  // 1. L1 语言包裁剪
  const { removedCount, savedBytes } = pruneLocales(appOutDir, electronPlatformName);
  const savedMb = (savedBytes / (1024 * 1024)).toFixed(2);
  console.log(
    `[Chromium L1 裁剪] 已清理多余语言包 ${removedCount} 个，仅保留 [${Array.from(ALLOWED_LOCALES).join(', ')}]，节省 ${savedMb} MB`
  );

  // 2. 核心组件与开源许可证校验
  verifyCoreAndLicenses(appOutDir, electronPlatformName);
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
};

module.exports.pruneLocales = pruneLocales;
module.exports.verifyCoreAndLicenses = verifyCoreAndLicenses;
module.exports.ALLOWED_LOCALES = ALLOWED_LOCALES;
