# Open-source-Minecraft-launcher

开源 Minecraft 启动器，Java 版与基岩版共用一套版本库。支持 Windows 10 / 11，macOS / Linux 可构建 Java 版。

[下载](https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/releases) · [技术文档](docs/docs.html) · [联机说明](docs/multiplayer-network.md) · [扩展开发](docs/extensions.md) · [官方网站](docs/index.html)

## 功能

- **版本**：Java 正式版、快照、愚人节与远古版本；Windows 基岩版核心（GDK / UWP / BDS）。
- **下载**：1–64 线程分片、断点续传、SHA-1 校验；官方源、BMCLAPI 与自定义镜像。
- **账户**：微软 OAuth、离线账户、正版与离线皮肤。
- **加载器**：Forge、NeoForge、Fabric、Quilt、OptiFine；Fabric API 自动安装。
- **实例设置**：每个版本独立配置内存、窗口、JVM 参数、启动语言、版本隔离与进程优先级。
- **内容**：Modrinth / CurseForge 的模组、光影、资源包、数据包；支持中文关键词搜索。
- **Java**：自动检测并按版本匹配，缺失时安装 Temurin JRE。
- **联机**：EasyTier 虚拟局域网；默认 IPv6 P2P，不使用 STUN、信令或中继；无公网 IPv6 时可切换到公益节点；自动发现局域网世界；可克隆房主的游戏版本、模组、光影和数据包。
- **界面**：明暗主题、壁纸、模糊与透明度、字体、多语言、PCL2 主页。
- **扩展**：原生扩展与 Chrome MV2 / MV3 扩展，兼容常用 `chrome.*` API。
- **平台**：Windows 10 / 11 完整支持；基岩版仅 Windows。

## 下载

从 [GitHub Releases](https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/releases) 获取免安装单文件或 NSIS 安装包。

需要 Windows 10 / 11 x64，不依赖 WebView2。暂不支持 Windows 7 / 8 / 8.1。程序未签名，SmartScreen 提示时请确认来源。

## 源码构建

需要 Node.js 20.19+、Rust 1.85+ 与 npm。

```bash
git clone https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher.git
cd Open-source-Minecraft-launcher
npm ci
npm run start
```

打包：

```bash
npm run electron:build:portable   # 单文件 EXE → release/
npm run electron:build:nsis       # NSIS 安装包 → release/
```

PowerShell 若提示 `PSSecurityException`，把 `npm` 换成 `npm.cmd`。

检查：

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## 使用

1. 在设置中选择游戏目录，登录微软账户或创建离线账户。
2. 在下载页选择 Java 版本或基岩版；需要模组时选择加载器。
3. 在主页选择版本并启动游戏。

默认数据目录为 `~/.cobble`，复制整个目录即可备份存档、实例与配置。

## 联机

1. 房主在联机页创建房间，启动游戏并对局域网开放，把分享码发给好友。
2. 访客加入房间并粘贴分享码，把回执码发回给房主。
3. 双方建立连接后，在「多人游戏」中进入房主的世界。

默认使用 IPv6 双向直连，不联系 STUN、信令或中继，游戏流量只经过两台电脑。需要双方有公网 IPv6，并允许启动器 / `easytier-core` 联网。

Windows 防火墙需放行本机 TCP / UDP `11010`，安装版会自动写入。路由器通常不需要端口映射；如果路由器的 IPv6 防火墙直接丢弃入站包，直连会失败，此时需放行 UDP `11010` 或切换到公益节点模式。启动器不会自动从 P2P 切换到中继。

完整流程与排障见 [联机网络方案](docs/multiplayer-network.md)。

## 扩展

扩展页面支持原生扩展（JavaScript + Rust / WASM）与 Chrome 扩展格式（Manifest V2 / V3），可安装 `.zip`、`.crx` 或已解压目录。

安装位置为 `<游戏目录>/extensions/`，未配置游戏目录时为 `~/.cobble/extensions/`。CRX 不校验签名，请只安装可信来源。详见 [扩展开发](docs/extensions.md)。

## 目录

| 路径 | 职责 |
| :-- | :-- |
| `src/` | React 界面 |
| `electron/` | Electron 主进程、预加载与开发启动 |
| `src-tauri/src/` | Rust 核心：下载、启动、联机、基岩版与内容市场 |

`src-tauri/` 仅为沿用的 Rust 工程路径，运行时不使用 Tauri。

## 已知限制

- 基岩版仅支持 Windows。
- 未代码签名，SmartScreen 需要手动放行。
- 文件夹形式的光影包和数据包暂不参与联机克隆。
- PCL2 主页的复杂动画暂不支持。

## 贡献

欢迎提交 [Issue](https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/issues) 或 PR。修改界面时请附说明。

## 许可与致谢

项目使用 [MIT License](LICENSE)。Minecraft 是 Mojang Studios 的商标，本项目与 Mojang / Microsoft 无关，不分发游戏本体。

感谢 Electron、React、EasyTier、BedrockBoot-DM、BMCLAPI、Modrinth、CurseForge、Betacraft 与 MC 百科。
