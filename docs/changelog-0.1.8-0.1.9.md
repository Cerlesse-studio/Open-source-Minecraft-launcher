# 更新修复分析：v0.1.8 → v0.1.9（含当前工作区待提交修复）

> 本文档基于仓库 git 历史（`aca1040 (index 0.1.8)` → `4c96901 (index 0.1.9)`）及当前工作区未提交的 Linux 权限修复整理而成。
>
> - **v0.1.8 → v0.1.9**：相对 `aca1040 (index 0.1.8)`，共 **48 个文件变更**，+6584 / -3800。
> - **当前工作区（待提交）**：4 个文件变更（`electron/after-pack.cjs`、`electron/main.cjs`、`src-tauri/src/java.rs`、`src-tauri/src/multiplayer.rs`），+79 行。

---

## 一、下载引擎重构（rayburst 架构分层）

本阶段将原本集中在 `src-tauri/src/net.rs` 与 `download.rs` 的下载逻辑按 rayburst 架构拆分为独立子模块 `src-tauri/src/download/`，并完成全量迁移：

1. **模块骨架迁移**（`e248861`）：
   - 拆分出 `mod.rs`、`error.rs`（`DownloadError` 结构化错误）、`types.rs`、`source.rs`、`speed.rs`、`limit.rs`、`verify.rs`、`resume.rs`、`segments.rs`、`engine.rs`、`task.rs` 与 `tests.rs`。
2. **统一下载入口**（`0b32265`）：
   - 确立 `download::download(DownloadRequest)` 统一入口，支持多线程分段、镜像源回退与 `DownloadError` 错误分类。
3. **全量调用点迁移**（`9ff5e52`）：
   - 将 `minecraft`、`loaders`、`java`、`content`、`bedrock`、`littleskin`、`multiplayer` 共 19 处下载调用全部迁移到统一引擎，移除旧兼容入口与冗余死代码。
4. **任务状态机激活**（`6d95244`）：
   - 激活 PCL2 语义的 `NetFile` / `NetState` 任务状态机，通过 `get_download_stats` 向前端暴露活跃下载任务状态。

---

## 二、取消下载缓存自动清理（`4c96901`）

修复了取消下载后残留 `.minecraft/versions/<版本>` 及其它缓存文件的问题，同时保留“暂停下载”的断点续传能力：

- **区分暂停与取消**：
  - `src/lib/backend.ts` 中 `cancelInstall(cleanupCache = false)` 支持传入清理开关。
  - `src/App.tsx` 中手动暂停与关闭窗口自动暂停保持 `cleanupCache = false`（保留 `.part` / `.part.meta` 以便继续下载）；点击“取消”时 `handleCancelInstall` 传入 `true` 并刷新已安装版本列表。
- **后端协同中止与清理**（`src-tauri/src/lib.rs`、`src-tauri/src/bridge.rs`）：
  - 扩展 `InstallState` 记录当前安装目标（Java 实例目录 / 基岩版版本与缓存目录）与是否已完整安装。
  - 中止安装任务并等待文件句柄释放后再执行清理：
    - **Java 版**：若取消前未完整安装，删除 `versions/<instance_id>`；若为补全/修复已有版本，仅清理 `.part` / `.part.meta` / `.meta.tmp`；同时递归清理 `libraries/`、`assets/`、`meta/installers/` 下的未完成分片文件及空目录。
    - **基岩版**：清理 `bedrock/cache/` 下对应版本的安装包与分片缓存，并在目标目录为新建时移除未完成的 `bedrock/versions/<version_id>`。

---

## 三、Linux 兼容与权限问题修复

### 1. 构建与沙盒启动修复（`535d874`、`11d2ea6`）
- **Linux 编译修复**（`535d874`）：补齐 `src-tauri/src/bedrock.rs` 中仅限 Windows 代码的 `#[cfg]` 条件编译守卫，并为开发模式（`electron/dev.cjs`）注入 `--no-sandbox`。
- **AppImage SUID 沙盒修复**（`11d2ea6`）：
  - 在 `electron/after-pack.cjs` 新增 `applyLinuxNoSandboxWrapper`，将 Linux 主程序重命名为 `.bin` 并生成固定注入 `--no-sandbox` 的启动包装脚本，解决 AppImage FUSE 挂载无法为 `chrome-sandbox` 设置 root+4755 SUID 导致启动 `FATAL abort` 的问题。
  - 在 `electron/main.cjs` 同步配置 `no-sandbox` 与 `sandbox: false`。

### 2. 可执行权限与解压权限兜底（当前工作区待提交）
- **Electron 打包与核心进程拉起**：
  - `electron/after-pack.cjs`：新增 `ensureUnixCorePermissions`，在 `afterPack` 阶段为 Linux / macOS 打包产物中的 `resources/core/open-source-minecraft-launcher` 显式授予 `0o755` 权限。
  - `electron/main.cjs`：在 `startCore()` 启动核心进程前，非 Windows 平台先尝试 `fs.chmodSync(binaryPath, 0o755)`，防止解压包或开发目录丢失可执行位。
- **Java 运行时解压权限**（`src-tauri/src/java.rs`）：
  - `extract_zip` 恢复 `entry.unix_mode()` 权限；`extract_tar_gz` 启用 `tar.set_preserve_permissions(true)`。
  - 新增 `ensure_unix_java_permissions`，解压完成后统一确保 `bin/` 目录下文件与 `jspawnhelper` 具有 `0o755` 权限。
- **EasyTier 联机内核权限兜底**（`src-tauri/src/multiplayer.rs`）：
  - 在调用 `easytier-core` 与 `easytier-cli` 前，于 `#[cfg(unix)]` 下补设 `0o755` 权限。

---

## 四、桌面壳性能、稳定性与日志增强（`6770da1`）

- **IPC 事件批量合并**：`electron/main.cjs` 与 `electron/preload.cjs` 对高频 `core:event` 按 16ms 窗口合并为 `core:events` 批量发送，避免下载或游戏日志刷屏阻塞渲染进程。
- **启动阶段错误日志**：捕获主进程 `uncaughtException` / `unhandledRejection` 并写入用户数据目录 `startup.log`。
- **开发服务器与本地产物回退**：支持通过 `OSML_DEV_URL` 指定开发服务器地址，并在不可达时回退加载本地 `dist` 构建产物。
- **冗余图形运行库裁剪**：`electron/after-pack.cjs` 在 Windows / Linux 下裁剪 `vulkan-1.dll` / `libvulkan.so.1`，同时保留 `d3dcompiler_47` 与 `vk_swiftshader` 确保无硬件 GPU 环境下的软件渲染回退。

---

## 五、关键变更速览

| 类别 | 关键内容 | 关联提交 / 文件 |
|------|----------|-----------------|
| 下载引擎 | rayburst 分层重构、`DownloadRequest` 统一入口、`NetFile/NetState` 状态机 | `e248861`、`0b32265`、`9ff5e52`、`6d95244` |
| 缺陷修复 | 取消下载自动清理 `.part`/`.part.meta` 与未完成版本目录（暂停仍保留） | `4c96901` |
| Linux 兼容 | `cfg` 编译守卫、AppImage `--no-sandbox` 启动包装、核心/Java/EasyTier `0o755` 权限兜底 | `535d874`、`11d2ea6`、工作区待提交 |
| 桌面端优化 | IPC 16ms 批量事件合并、启动崩溃落盘日志、开发回退加载、冗余 Vulkan 库裁剪 | `6770da1` |
