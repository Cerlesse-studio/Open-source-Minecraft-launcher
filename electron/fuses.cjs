/**
 * Electron Fuses (V1) 读写与翻转工具
 * 对应开发文档第 4.1 节：在打包阶段（代码签名之前）翻转二进制开关，永久关闭不需要的运行时能力。
 *
 * 优先调用官方 `@electron/fuses`（若已安装）；若环境中未安装 `@electron/fuses`，
 * 则直接通过 Electron 官方 FuseV1 哨兵字节序列 (`dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`)
 * 进行安全的二进制级读取与翻转。
 */

const fs = require('node:fs');
const path = require('node:path');

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'utf8');

const FuseVersion = {
  V1: 1,
};

// Electron FuseV1 线序定义（与 @electron/fuses FuseV1Options 严格一致）
const FuseV1Options = {
  RunAsNode: 0,
  EnableCookieEncryption: 1,
  EnableNodeOptionsEnvironmentVariable: 2,
  EnableNodeCliInspectArguments: 3,
  EnableEmbeddedAsarIntegrityValidation: 4,
  OnlyLoadAppFromAsar: 5,
  LoadBrowserProcessSpecificV8Snapshot: 6,
  GrantFileProtocolExtraPrivileges: 7,
};

const FUSE_NAMES = {
  [FuseV1Options.RunAsNode]: 'RunAsNode',
  [FuseV1Options.EnableCookieEncryption]: 'EnableCookieEncryption',
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 'EnableNodeOptionsEnvironmentVariable',
  [FuseV1Options.EnableNodeCliInspectArguments]: 'EnableNodeCliInspectArguments',
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 'EnableEmbeddedAsarIntegrityValidation',
  [FuseV1Options.OnlyLoadAppFromAsar]: 'OnlyLoadAppFromAsar',
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: 'LoadBrowserProcessSpecificV8Snapshot',
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: 'GrantFileProtocolExtraPrivileges',
};

/**
 * 开发文档第 4.1 节规定的安全加固目标配置
 */
const RECOMMENDED_FUSE_CONFIG = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
};

/**
 * 读取指定 Electron 二进制文件中的 FuseV1 状态
 * @param {string} binaryPath
 */
function readElectronFuses(binaryPath) {
  if (!binaryPath || !fs.existsSync(binaryPath)) {
    return null;
  }
  const buffer = fs.readFileSync(binaryPath);
  const sentinelIndex = buffer.indexOf(SENTINEL);
  if (sentinelIndex === -1) {
    return null;
  }

  const version = buffer[sentinelIndex + SENTINEL.length];
  const wireLength = buffer[sentinelIndex + SENTINEL.length + 1];
  const wireStart = sentinelIndex + SENTINEL.length + 2;

  const fuses = {};
  for (let i = 0; i < wireLength; i++) {
    const byte = buffer[wireStart + i];
    // ASCII '1' (49) = enabled, '0' (48) = disabled, 'r' (114) = removed
    const enabled = byte === 49;
    const name = FUSE_NAMES[i] || `Fuse_${i}`;
    fuses[name] = enabled;
  }

  return {
    binaryPath,
    version,
    wireLength,
    fuses,
  };
}

/**
 * 在打包产物上翻转 Electron Fuses
 * @param {string} electronBinaryPath
 * @param {object} [customConfig]
 */
async function flipElectronFuses(electronBinaryPath, customConfig = RECOMMENDED_FUSE_CONFIG) {
  if (!electronBinaryPath || !fs.existsSync(electronBinaryPath)) {
    throw new Error(`未找到 Electron 二进制文件: ${electronBinaryPath}`);
  }

  // 1. 优先尝试使用 @electron/fuses 官方包
  try {
    const officialFuses = require('@electron/fuses');
    await officialFuses.flipFuses(electronBinaryPath, customConfig);
    return {
      method: '@electron/fuses',
      status: readElectronFuses(electronBinaryPath),
    };
  } catch {
    // 若未安装 @electron/fuses，使用内置 FuseV1 哨兵翻转实现
  }

  const buffer = fs.readFileSync(electronBinaryPath);
  const sentinelIndex = buffer.indexOf(SENTINEL);
  if (sentinelIndex === -1) {
    throw new Error(`在二进制文件中未找到 Electron FuseV1 哨兵序列: ${electronBinaryPath}`);
  }

  const version = buffer[sentinelIndex + SENTINEL.length];
  if (version !== FuseVersion.V1) {
    throw new Error(`不支持的 Fuse 版本: ${version} (期望版本 1)`);
  }

  const wireLength = buffer[sentinelIndex + SENTINEL.length + 1];
  const wireStart = sentinelIndex + SENTINEL.length + 2;

  for (const [key, val] of Object.entries(customConfig)) {
    if (key === 'version') continue;
    const wireIndex = Number(key);
    if (Number.isNaN(wireIndex) || wireIndex < 0 || wireIndex >= wireLength) {
      continue;
    }
    // 注意：EnableEmbeddedAsarIntegrityValidation (index 4) 在 Windows/macOS 上依赖操作系统资源表中的
    // ASAR header 哈希资源（由 @electron/fuses 或签名工具写入）。若直接改二进制位但未写入 PE/plist 资源，
    // 启动会校验失败；因此内置回退模式下仅在显式提供 forceAsarIntegrityResource 时翻转第 4 位。
    if (
      wireIndex === FuseV1Options.EnableEmbeddedAsarIntegrityValidation &&
      !customConfig.forceAsarIntegrityResource
    ) {
      continue;
    }
    buffer[wireStart + wireIndex] = val ? 49 : 48; // '1' or '0'
  }

  fs.writeFileSync(electronBinaryPath, buffer);
  if (process.platform !== 'win32') {
    fs.chmodSync(electronBinaryPath, 0o755);
  }

  return {
    method: 'builtin-sentinel-v1',
    status: readElectronFuses(electronBinaryPath),
  };
}

module.exports = {
  SENTINEL,
  FuseVersion,
  FuseV1Options,
  FUSE_NAMES,
  RECOMMENDED_FUSE_CONFIG,
  readElectronFuses,
  flipElectronFuses,
};

if (require.main === module) {
  try {
    const electronBin = require('electron');
    const info = readElectronFuses(electronBin);
    console.log(JSON.stringify(info, null, 2));
  } catch (err) {
    console.error('读取 Electron Fuses 失败:', err.message);
    process.exitCode = 1;
  }
}
