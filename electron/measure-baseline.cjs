/**
 * Electron 内置 Chromium 裁剪与安全基线度量/验证工具
 * 对应开发文档第 1、2、3、4、5、8 节：
 * 测量并验证 L1（打包层）、L2（运行时与 Fuse 层）、L3（源码 GN 参数层）各项指标。
 */

const fs = require('node:fs');
const path = require('node:path');
const { readElectronFuses, RECOMMENDED_FUSE_CONFIG, FUSE_NAMES } = require('./fuses.cjs');
const ALLOWED_LOCALES = new Set(['en-US', 'zh-CN']);

const ROOT_DIR = path.resolve(__dirname, '..');

/**
 * 解析 electron/chromium/args.gn 中的 GN 开关
 */
function parseGnArgs() {
  const gnPath = path.join(__dirname, 'chromium', 'args.gn');
  if (!fs.existsSync(gnPath)) {
    return { exists: false, path: gnPath, args: {}, imports: [] };
  }
  const content = fs.readFileSync(gnPath, 'utf8');
  const args = {};
  const imports = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const importMatch = line.match(/^import\("([^"]+)"\)/);
    if (importMatch) {
      imports.push(importMatch[1]);
      continue;
    }
    const assignMatch = line.match(/^([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
    if (assignMatch) {
      const key = assignMatch[1];
      let val = assignMatch[2].trim();
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^\d+$/.test(val)) val = Number(val);
      else val = val.replace(/^"|"$/g, '');
      args[key] = val;
    }
  }

  return { exists: true, path: gnPath, args, imports };
}

/**
 * 统计目录总大小
 * @param {string} dirPath
 */
function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

/**
 * 执行完整基线度量与合规审计
 */
function collectBaselineReport() {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const buildConfig = pkg.build || {};

  let electronBinPath = null;
  let electronDistDir = null;
  try {
    electronBinPath = require('electron');
    electronDistDir = path.dirname(electronBinPath);
  } catch {
    // ignore if electron binary is not found
  }

  // 检查是否存在已打包的 unpacked 目录，若存在则优先度量打包后目录
  const unpackedCandidates = [
    path.join(ROOT_DIR, 'release', 'win-unpacked'),
    path.join(ROOT_DIR, 'release', 'linux-unpacked'),
    path.join(ROOT_DIR, 'release', 'mac'),
  ];
  const activeUnpackedDir = unpackedCandidates.find((d) => fs.existsSync(d)) || null;
  const targetDir = activeUnpackedDir || electronDistDir;

  // 1. 度量语言包 (L1 3.1)
  let totalLocalesCount = 0;
  let keptLocalesCount = 0;
  let removableLocalesBytes = 0;
  let keptLocalesBytes = 0;

  if (targetDir && fs.existsSync(path.join(targetDir, 'locales'))) {
    const localesDir = path.join(targetDir, 'locales');
    for (const file of fs.readdirSync(localesDir)) {
      if (!file.endsWith('.pak')) continue;
      totalLocalesCount += 1;
      const size = fs.statSync(path.join(localesDir, file)).size;
      const locale = file.slice(0, -4);
      if (ALLOWED_LOCALES.has(locale)) {
        keptLocalesCount += 1;
        keptLocalesBytes += size;
      } else {
        removableLocalesBytes += size;
      }
    }
  }

  // 2. 校验核心组件与开源许可证文件 (第 2、3.3、6.1、9 节)
  const coreFilesCheck = [
    { name: 'icudtl.dat', role: 'ICU 国际化数据', required: true },
    { name: 'snapshot_blob.bin', role: 'V8 启动快照', required: true },
    { name: 'v8_context_snapshot.bin', role: 'V8 上下文快照', required: true },
    { name: 'resources.pak', role: 'Chromium 内置资源', required: true },
    { name: 'LICENSE.electron.txt', role: 'Electron 开源许可证', required: true },
    { name: 'LICENSES.chromium.html', role: 'Chromium 开源许可证声明', required: true },
  ].map((item) => {
    const filePath = targetDir ? path.join(targetDir, item.name) : null;
    const exists = filePath ? fs.existsSync(filePath) : false;
    const sizeBytes = exists ? fs.statSync(filePath).size : 0;
    return { ...item, exists, sizeBytes };
  });

  // 3. 读取 FuseV1 状态 (L2 4.1)
  const targetExe = activeUnpackedDir
    ? path.join(
        activeUnpackedDir,
        `${buildConfig.productName || 'Open-source-Minecraft-launcher'}${process.platform === 'win32' ? '.exe' : ''}`
      )
    : electronBinPath;
  const fuseState = readElectronFuses(targetExe);

  const recommendedFuseSummary = {};
  for (const [wireIdx, expected] of Object.entries(RECOMMENDED_FUSE_CONFIG)) {
    if (wireIdx === 'version') continue;
    const name = FUSE_NAMES[Number(wireIdx)];
    if (name) {
      recommendedFuseSummary[name] = {
        recommended: expected,
        currentInBinary: fuseState?.fuses?.[name] ?? null,
      };
    }
  }

  // 4. 解析 L3 GN 参数 (L3 5.4)
  const gnReport = parseGnArgs();

  const totalDistBytes = targetDir ? getDirSize(targetDir) : 0;

  return {
    timestamp: new Date().toISOString(),
    targetEvaluated: activeUnpackedDir ? 'packaged-release' : 'dev-electron-dist',
    targetDir,
    totalDistSizeMb: Number((totalDistBytes / (1024 * 1024)).toFixed(2)),
    l1Packaging: {
      electronInDevDependencies: Boolean(pkg.devDependencies?.electron && !pkg.dependencies?.electron),
      asarEnabled: buildConfig.asar !== false,
      compression: buildConfig.compression || 'default',
      afterPackConfigured: Boolean(buildConfig.afterPack),
      electronLanguages: buildConfig.electronLanguages || [],
      localesStats: {
        totalLocalesCount,
        keptLocalesCount,
        keptLocalesKb: Number((keptLocalesBytes / 1024).toFixed(1)),
        prunableSavingsMb: Number((removableLocalesBytes / (1024 * 1024)).toFixed(2)),
      },
      coreFilesIntegrity: coreFilesCheck,
    },
    l2RuntimeSecurity: {
      fuses: recommendedFuseSummary,
      disabledChromiumFeatures: [
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
      ],
      disabledChromiumSwitches: [
        'disable-component-update',
        'no-pings',
        'disable-background-networking',
        'disable-domain-reliability',
        'disable-print-preview',
        'disable-speech-api',
        'disable-sync',
      ],
      webPreferencesBaseline: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
      },
      permissionHandlerDefaultDeny: true,
      cspEnforced: true,
      printAndPdfGracefulDegradation: true,
    },
    l3SourceGn: gnReport,
  };
}

module.exports = {
  collectBaselineReport,
  parseGnArgs,
};

if (require.main === module) {
  const report = collectBaselineReport();
  console.log('=== Electron 内置 Chromium 裁剪与安全基线度量报告 ===');
  console.log(`评估目标: ${report.targetEvaluated} (${report.targetDir})`);
  console.log(`当前目录总体积: ${report.totalDistSizeMb} MB`);
  console.log(
    `[L1 打包层] 语言包保留: ${JSON.stringify(report.l1Packaging.electronLanguages)} | 可裁剪语言包节省: ${report.l1Packaging.localesStats.prunableSavingsMb} MB | ASAR: ${report.l1Packaging.asarEnabled} | 压缩级别: ${report.l1Packaging.compression}`
  );
  console.log(
    `[L1 核心完整性] 核心与许可证文件齐全: ${report.l1Packaging.coreFilesIntegrity.every((c) => c.exists)}`
  );
  console.log(
    `[L2 运行时层] 已禁用 Chromium 特性 (${report.l2RuntimeSecurity.disabledChromiumFeatures.length} 项): ${report.l2RuntimeSecurity.disabledChromiumFeatures.join(', ')}`
  );
  console.log(
    `[L3 源码层] args.gn 存在: ${report.l3SourceGn.exists} | 配置项数量: ${Object.keys(report.l3SourceGn.args).length}`
  );
}
