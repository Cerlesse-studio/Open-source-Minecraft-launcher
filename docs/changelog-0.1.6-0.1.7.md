# 更新修复分析：v0.1.6 与 v0.1.7

> 本文档基于仓库 git 历史对两个版本提交的实际代码差异（`index 0.1.6` → `11fb19e`，`index 0.1.7` → `990e1bc`）整理而成，覆盖更新内容与缺陷修复。
>
> - **v0.1.6**：提交 `11fb19e`，相对 `4ad4c0e (index 0.1.5)`，共 44 个文件变更，+4151 / -570。
> - **v0.1.7**：提交 `990e1bc`，相对 `11fb19e (index 0.1.6)`，共 56 个文件变更，+5147 / -881。

---

## 一、v0.1.6 —— 外置登录与账户体系完善

本版本的核心主题是「三位一体登录体系」落地与底层版本/加载器识别加固。

### 1. 新增 LittleSkin 外置登录（重大功能）

新增后端模块 `src-tauri/src/littleskin.rs`（约 926 行），实现与微软登录同构、但认证体系完全不同的外置登录：

- 采用 **OAuth 2.0 设备授权流**（device_code），对接 `https://open.littleskin.cn/oauth/device_code`；
- 前端轮询令牌端点，用户在浏览器完成授权后用 OAuth access token 调 Yggdrasil 的 `/authserver/oauth` 换取 **Minecraft 会话令牌**（游戏真正使用的凭据）；
- 启动时通过 **authlib-injector** 将 Yggdrasil API 地址以 `-javaagent:authlib-injector.jar=<api>` 注入 JVM，`user_type` 固定为 `mojang`；
- 令牌保存到独立的 `littleskin_account.json`（与微软账号的 `account.json` 并列），文件权限沿用 `auth::store_account` 的收紧策略；
- **安全细节**：ID Token 不校验 JWT 签名（仅做 `iss`/`aud`/`exp` 一致性检查），且绝不把令牌里的 UUID 当作可信身份直接使用；OAuth 令牌只留在后端内存，绝不发给前端。

> 说明：LittleSkin 不代表正版授权，仅可用于同样配置了外置登录的服务器；设备授权流需 LittleSkin 侧将应用加入白名单，否则返回 `invalid_client`。

### 2. 账户系统重构（`auth.rs`）

- 扩展 `MinecraftToken` 结构，新增 LittleSkin 视图构建；
- 改进 `load_account` / `session_for_launch` / `account_view`，支持双 provider（microsoft / littleskin）并存；
- 强化 `restrict_permissions` 的安全收口策略，并补充相关单元测试。

### 3. 前端账户对话框重写（`AccountDialog.tsx`，+684 / -大量）

- 抽象出 `Provider = "microsoft" | "littleskin"` 统一登录入口；
- 新增 `DeviceCodeCard` 组件，同时为微软与 LittleSkin 提供设备码展示与轮询；
- 新增一批桥接接口：`beginLittleSkinLogin`、`pollLittleSkinLogin`、`selectLittleSkinProfile`、`openLittleSkinAuthorization`、`signOutLittleSkinAccount` 等；
- LittleSkin 自带应用 ID，设置被清空时仍能续登（`effectiveLsClientId` 回退逻辑）。

### 4. 加载器与版本识别（`minecraft.rs`）

重写版本/加载器探测逻辑，识别更稳健：

- 新增从 `fmlloader` / `fmlcore` / `fancymodloader:loader` 依赖名、以及启动参数 `--fml.forgeVersion` / `--fml.neoForgeVersion` 识别 forge / neoforge；
- 新增从版本 id 字符串（如 `1.18.2-Forge_40.3.12`、`1.20.1-neoforge-47.1.0`）的兜底解析；
- 完善 fabric / quilt 的 loader 版本提取；
- 改进「现代 Forge」判定（1.13+），相应调整 `install_version_with_options` 中 `ensure_forge_or_neoforge_client_jar` 的调用时机。

### 5. 联机房间资源扫描（`multiplayer.rs`）

- 重写 `scan_room_datapacks` / `scan_room_resources` / `attach_room_file_ids`，房间资源（模组、数据包等）扫描更完整；
- 加固 `safe_room_download_path` 路径安全校验；
- 改进 `clone_room_resources` 下载流程。

### 6. 工程与打包

- 移除被误提交进仓库的 `easytier` 二进制（`Packet.dll`、`easytier-cli.exe`、`easytier-core.exe`、`wintun.dll` 等），相关 `.github/workflows/*` 改为运行时下载；
- 更新 `LICENSE`，调整 `package.json` / `Cargo.toml` / `Cargo.lock` 依赖；
- 前端 `App.tsx`、`HomeView`、`VersionSelectView`、`DownloadsView`、`MultiplayerRoomResources` 等大量 UI 重构。

---

## 二、v0.1.7 —— 下载引擎重做与体验打磨

本版本的核心主题是「对齐 PCL2 语义的工业级下载引擎」与一批痛点 Bug 修复。

### 1. 下载引擎重做（全新 `download.rs`，约 749 行）

新模块将 **PCL2 的 `ModNet.vb` / `ModLoader.vb` 下载语义移植到 Rust**：

- 引入 `NetManager` / `NetFile` / `NetThread` / `NetSource` 模型，由全局 `NetManagerClass` 统一调度（线程上限、令牌桶限速、0.1s 统计刷新）；
- 分片下载控制：`FILE_PIECE_LIMIT`（256 KiB 以下不分片）、`NO_SPLIT_SIZE`（1 MiB 以下文件不分段）；
- 连接超时自适应：`Min(Max(ConnectAverage, 15000) * (1 + FailCount), 30000)`；
- 慢链路检测：包间隔 > 5s 且速率 < 1 KiB/s 判定为慢链；`SourceFail` 分类（Range 不支持 / HTTP 状态码 / 慢链 / 无数据 / 磁盘满 / 未知）；
- `net.rs` 保持为兼容门面，供旧调用方使用。

### 2. 断点续传（`download_file_resumable`）

- 引入 `.part.meta` 分片持久化机制：每个分片下载完成即记录；
- 软件崩溃、关机或中途切换镜像源后，重启自动识别并**只补全剩余分片**，GB 级大包不再清零重来；
- `verify_and_commit` 合并阶段提供 3 次重试，退避 `500ms * attempt`。

### 3. 网络层修复：代理降速顽疾（重点修复，`net.rs`）

- 新增 `direct_client()`：**下载强制直连，绕过系统代理**（Clash / Surge 写入的 `HTTP_PROXY` / `HTTPS_PROXY`）。此前开着加速软件或系统代理时，下载被绕行导致速度骤降到约 1/5，还白白消耗梯子流量；
- 新增 `proxy_retry_worthwhile`：仅当直连确实不可达（连接级失败）时才回退到带系统代理的 `client()`，瞬间跑满物理带宽；
- 解析官方 `client.jar` / 版本 JSON，BMCLAPI 重定向到慢存储节点时优先使用官方源。

### 4. 全局限速与线程上限

- 暴露 `set_download_speed_limit` / `set_thread_limit` 接口（令牌桶算法 `refill_tokens`，按 100ms 补充配额），可在设置中控制下载占用与并发。

### 5. 内容市场统一检索（新增多个模块）

- 新增 `src/lib/resource-catalog.ts`、`resource-project.ts`、`resource-search.ts`（约 284 / 299 / 176 行）与 `search-glossary.json`（约 1090 行）、`search-i18n.ts`；
- 模组、光影、数据包等 **6 大类资源统一检索**；`content.rs` 的 `search_content` 重写，`download_content_file` 增强；
- 前端 `ContentMarketplaceView` 重构，统一检索与分类入口。

### 6. 联机 P2P 升级（`multiplayer.rs` / `multiplayer.ts`）

- 引入**节点心跳探活**与公共中继节点发现，切换中继后房间仍稳定互通；
- 增强分享码 / 对等凭证（`buildShareCode` / `parseShareCode` / `buildPeerReceipt` / `parsePeerReceipt`）解析；
- 扩充冗余中继列表 `FALLBACK_REDUNDANT_RELAYS`；访客可按房主版本自动补齐模组与光影；
- `MultiplayerView` UI 调整，新增 P2P 健康状态展示。

### 7. UI / 样式修复（`styles.css` / `theme.ts`）

- **中文字体回退链修复（重点）**：`--font-mono` 与 `--font-pixel` 原缺失中文字体回退，导致版本号、徽标、像素标题中的中文「隐形空白」；现补齐 `PingFang SC` / `Microsoft YaHei UI` / `Noto Sans CJK SC` 后备链，全界面渲染统一；
- 状态药丸（status pills）与 9–10px 小标签在浅色主题下重映射为深色墨色（如 `#8a4d00`），避免对比度不足；
- 主题主色 `getEffectivePrimaryColor` 与明暗面板亮度（`DARK_PANELS` / `LIGHT_PANELS`）微调。

### 8. 加载器镜像兜底（`loaders.rs`）

- 修复 **Quilt 官方源无任何国内镜像兜底** 的问题，无缝接入 BMCLAPI；Quilt 玩家下载依赖库同样享受加速；
- Forge / NeoForge 的 client jar 与 json 改为走官方主机 + BMCLAPI 自动回退链，而非单一 BMCLAPI 直连（不可用时自动换源）。

### 9. 文档与官网

- 新增 `docs/multiplayer-network.md`（联机网络说明）；
- 官网升级至 v0.1.7：`docs/index.html`、`docs/SITE.md` 更新，新增 `docs/assets/site.css`，并补充 `docs/presentation.html`（v0.1.7 发布会演示页）；
- 版本号提升：`package.json`、`src-tauri/Cargo.toml`、`Cargo.lock` 升至 0.1.7。

---

## 三、关键修复点速览

| 类型 | v0.1.6 | v0.1.7 |
|------|--------|--------|
| 新功能 | LittleSkin 外置登录、双 provider 账户体系 | 断点续传、全局限速、内容市场统一检索、P2P 心跳探活 |
| 引擎 | — | 下载引擎对齐 PCL2 语义（分片/令牌桶/线程池） |
| Bug 修复 | 加载器/版本识别不稳、联机资源扫描不全 | **代理导致下载降速到 1/5**、**中文「隐形空白」**、Quilt 无镜像兜底 |
| 安全 | authlib-injector 注入、令牌不落地前端、文件权限收紧 | 下载直连绕过系统代理、直连失败才回退代理 |
| 样式 | — | 中文字体回退链、浅色主题状态标签对比度 |
| 文档 | LICENSE 更新 | 联机网络文档、发布会演示页、官网升级 |

---

## 四、参考

- 版本提交：`11fb19e (index 0.1.6)`、`990e1bc (index 0.1.7)`
- 发布会演示：`docs/presentation.html`（标题「Open-source-Minecraft-launcher v0.1.7 版本发布介绍」）
- 官网根目录：`docs/index.html`（当前对应 0.1.7）
