<div align="center">

<img src="docs/images/logo.png" alt="Open-source-Minecraft-launcher" width="120" height="120" />

<h1>Open-source-Minecraft-launcher</h1>

<p>
  <strong>轻量 · 现代 · 高性能的开源 Minecraft 启动器</strong><br />
  Java 版 × 基岩版 · 基于 Tauri 2 / Rust / React 19
</p>

<p>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square" /></a>
  <img alt="Version" src="https://img.shields.io/badge/version-0.0.7-2EA043?style=flat-square" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555555?style=flat-square" />
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&amp;logo=tauri&amp;logoColor=white" />
  <img alt="Rust" src="https://img.shields.io/badge/Rust-2024-000000?style=flat-square&amp;logo=rust&amp;logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&amp;logo=react&amp;logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&amp;logo=typescript&amp;logoColor=white" />
</p>

<p>
  <a href="#功能亮点">功能亮点</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#技术架构">技术架构</a> ·
  <a href="#常见问题">常见问题</a> ·
  <a href="#参与贡献">参与贡献</a>
</p>

</div>

---

**Open-source-Minecraft-launcher** 是一款基于 **Tauri 2 + Rust + React 19** 构建的现代化桌面 Minecraft 启动器。它将 **Java 版与基岩版** 的版本管理、模组生态、内容市场、高速下载与点对点联机整合进同一个轻量应用中——无广告、无遥测、不自带厚重的 Chromium 内核。

<table>
  <tr>
    <td align="center" width="33%"><b>🎮 双版本统一</b><br /><sub>Java 版 + 基岩版<br />同一套版本库与启动入口</sub></td>
    <td align="center" width="33%"><b>⚡ 原生轻量</b><br /><sub>Tauri 2 + Rust 后端<br />系统 WebView，低内存占用</sub></td>
    <td align="center" width="33%"><b>⬇️ 高速下载</b><br /><sub>多线程分片 + 断点续传<br />多镜像自动测速与容灾</sub></td>
  </tr>
  <tr>
    <td align="center"><b>🔐 双账户体系</b><br /><sub>微软正版 OAuth / 离线账户<br />自定义皮肤与正版纹理注入</sub></td>
    <td align="center"><b>🧩 全生态加载器</b><br /><sub>Forge / NeoForge / Fabric / Quilt<br />LeviLamina / Amethyst</sub></td>
    <td align="center"><b>🌐 零配置联机</b><br /><sub>内置 EasyTier 点对点直连<br />分享码一键加入局域网世界</sub></td>
  </tr>
</table>

## 界面预览

<table>
  <tr>
    <td colspan="2" align="center">
      <img src="docs/images/home.png" alt="主页：更新新闻与一键启动" />
      <br />
      <sub>主页 · Mojang 更新新闻、账户面板与一键启动</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="docs/images/download.png" alt="下载中心：版本与内容" />
      <br />
      <sub>下载中心 · 版本 / 加载器 / 内容市场</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/images/settings.png" alt="设置：下载源与并发线程" />
      <br />
      <sub>设置 · 下载镜像测速、并发控制与界面个性化</sub>
    </td>
  </tr>
</table>

## 功能亮点

<table>
  <tr>
    <td align="center" width="50%"><img src="docs/images/feature-launch.svg" alt="一键启动" /></td>
    <td align="center" width="50%"><img src="docs/images/feature-download.svg" alt="多线程下载" /></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/feature-loaders.svg" alt="模组加载器" /></td>
    <td align="center"><img src="docs/images/feature-resources.svg" alt="资源中心" /></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/feature-mirror.svg" alt="就近镜像" /></td>
    <td align="center"><img src="docs/images/feature-java.svg" alt="Java 自动管理" /></td>
  </tr>
</table>

- **启动与账户管理**
  - **微软正版 & 离线登录**：采用 OAuth 2.0 设备码安全登录，令牌仅保存在本地；离线模式支持自定义皮肤与正版皮肤加载。
  - **Java 自动管理**：按游戏版本自动匹配本机 Java，缺失时自动下载部署 Eclipse Temurin JRE。
  - **全时期版本兼容**：支持正式版、快照、愚人节版本及 BetaCraft 远古版本（Classic / Alpha / Beta），内置旧版启动修复。
- **版本与内容市场**
  - **Java 模组与资源**：接入 Modrinth，支持模组、整合包、光影、资源包、数据包搜索与一键安装到对应版本实例，精准跳转 MC 百科词条。
  - **基岩版全支持（Windows）**：支持商店版、GDK（`.msixvc`）、UWP / AppX 免商店注册与 BDS 核心；接入 CurseForge 基岩版市场，支持 `.mcpack` / `.mcaddon` / `.mcworld` 自动部署及 LeviLamina / Amethyst 加载器。
  - **多语言智能搜索**：支持直接用中文（如「钠」「机械动力」）、日文、韩文、俄文搜索模组与光影，自动映射英文关键词。
- **高速下载引擎**
  - **分片并发与断点续传**：大文件自动分片并发下载，关闭应用或切换镜像均保留下载进度。
  - **多源容灾与测速**：内置官方 CDN、BMCLAPI 等多节点镜像，支持一键测速切换与失败自动换源。
- **点对点联机**
  - **三步开房**：EasyTier 内核随安装包内置，基于公网 IPv6 点对点直连；房主对局域网开放后自动生成 `cobble-mp://` 分享码，好友粘贴即可在「多人游戏 → 局域网」中看到世界。
  - **两种加入方式**：粘贴分享码，或者只填房主的公网 IPv6 与房间密码。房间网络名固定、身份由密码决定（密码不同会被内核直接拒绝），房间清单的端口和令牌也由同一密码推出，所以访客不用额外信息就能自动发现房主的虚拟地址和局域网端口。
  - **免管理员运行**：内核以无 TUN 模式启动（`--no-tun` + 用户态协议栈），不创建虚拟网卡、不需要每次开房都弹 UAC；房主的虚拟地址由内核直接转发到本机服务，访客则通过内核自带的本机 SOCKS5 入口访问。入站端口由安装包在安装时一次性放行。
  - **房间面板**：实时查看在线成员、延迟、房主模组/资源清单，支持轮换房间密钥。
- **深度个性化**
  - 支持深浅主题、任意强调色、自定义壁纸（模糊度与全局面板透明度调节）、多款字体切换，以及兼容 PCL2 `.xaml` / HTML 的自定义主页。

---

## 快速开始

### 1. 直接下载（推荐）

前往 [GitHub Releases](https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/releases) 下载对应平台的安装包。
> **平台支持**：推荐 **Windows 10 / 11 x64**（完整支持 Java 版 + 基岩版 + 联机）；macOS / Linux 可构建运行 Java 版核心功能。
>
> **系统兼容性**：界面层依赖 Microsoft Edge WebView2，它只提供 Windows 10 及以上版本；微软从 Edge 109 起停止为 Windows 7 / 8 / 8.1 更新 WebView2，Tauri 2.12 也移除了 Windows 7 支持，因此 **Windows XP / Vista / 7 / 8 / 8.1 无法运行**。安装包内置 WebView2 引导程序，Win10 / 11 缺少该组件时会自动安装；系统版本过低或缺少运行时，启动器会弹出中文说明而不是静默退出（可用 `OSML_SKIP_COMPAT_CHECK=1` 跳过检查）。

### 2. 从源码构建

**环境要求**：Node.js 20.19+、Rust 1.85+（Edition 2024）以及 [Tauri 2 系统前置依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
# 克隆仓库并安装依赖
git clone https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher.git
cd Open-source-Minecraft-launcher
npm install

# 联机内核内置在 src-tauri/resources/easytier/（easytier-core、easytier-cli 与随包 DLL）。
# 该目录随安装包分发，缺失时启动器会退回联机页的“下载内核”流程。

# 启动开发模式
npm run tauri dev

# 构建生产安装包（默认产物位于 src-tauri/target/release/bundle/）
npm run tauri build
```

> **构建输出位置**：Windows 构建不需要 MSVC C 编译器（TLS 走系统 Schannel，没有 `ring` 这类 C 依赖）。如果所在环境对项目目录内的可执行文件有写入限制（典型症状是 `ring` 构建报 `cl : Command line error D8050`，或启动时 WebView2 报 `HRESULT(0x800700AA) 请求的资源在使用中`），把 cargo 的 `target` 目录指到项目外即可：
>
> ```bash
> # 临时生效
> CARGO_TARGET_DIR="$TEMP/osml-target" npm run tauri dev
> # 或写进 .cargo/config.toml（仓库根，已被 .gitignore 忽略），一劳永逸
> ```

<details>
<summary><b>开发检查与测试命令</b></summary>

```bash
# 前端类型检查与构建
npm run build

# Rust 格式、Lint 与单元测试
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

</details>

---

## 技术架构

项目采用 **React 19 前端 → Tauri 2 IPC → Rust 后端** 架构。所有耗时与核心状态任务（版本解析、分片下载、镜像容灾、基岩版解包注册、EasyTier 进程管理与局域网广播）均由 Rust 后端独立驱动，切换前端页面不会中断任务。

| 模块路径 | 职责说明 |
| --- | --- |
| `src/components/` | 页面视图（主页、统一版本库、下载中心、联机面板、实例与全局设置） |
| `src/lib/` | Tauri IPC 桥接、主题配置、PCL2 XAML 主页解析 |
| `src-tauri/src/minecraft.rs` | Java 版本清单、资产校验与启动编排 |
| `src-tauri/src/loaders.rs` | Forge / NeoForge / Fabric / Quilt / OptiFine 安装器 |
| `src-tauri/src/net.rs` | 多线程分片下载、镜像回退与断点续传 |
| `src-tauri/src/bedrock.rs` | 基岩版核心部署、依赖自检、附加包与加载器管理 |
| `src-tauri/src/content.rs` | Modrinth / CurseForge 内容搜索与安装 |
| `src-tauri/src/multiplayer.rs` | EasyTier 虚拟组网与 Minecraft 局域网广播 |
| `src-tauri/src/auth.rs` / `java.rs` | 微软设备码认证、离线皮肤打包、Java 检测与 Temurin 部署 |

---

## 常见问题

<details>
<summary><b>必须有微软正版账号才能用吗？</b></summary>

不强制。离线账户可直接游玩单人模式与离线服务器，并支持自定义皮肤；登录微软正版账户后可使用正版验证服务器、正版皮肤及基岩版授权检测。
</details>

<details>
<summary><b>电脑没装 Java 或版本不对怎么办？</b></summary>

启动器会根据目标游戏版本自动检测所需 Java（如 Java 8 / 17 / 21），若本机未安装，首次启动时会自动下载对应的 Eclipse Temurin JRE 到 `<游戏目录>/runtime/`。
</details>

<details>
<summary><b>游戏存档和配置文件保存在哪里？如何备份？</b></summary>

默认游戏目录为 `~/.cobble`（可在设置中修改），包含所有版本、存档、模组与自动下载的 JRE。直接复制该目录即可完成完整备份；微软账户登录凭证独立保存在系统应用数据目录的 `account.json` 中。
</details>

<details>
<summary><b>能在 Windows XP / 7 / 8.1 上运行吗？</b></summary>

不能。界面层使用 Microsoft Edge WebView2，而它能运行的系统最低是 Windows 10；微软从 Edge 109 起停止为 Windows 7 / 8 / 8.1 发布 WebView2，Tauri 2.12 也正式移除了 Windows 7 支持，Windows XP 更是早已没有可用的 WebView2 与 Rust 运行环境。

在这类系统上双击启动器，会弹出「无法在这个 Windows 版本上运行」并列出检测到的系统版本；Windows 10 / 11 缺少 WebView2 时会提示，并可直接打开微软官方下载页。特殊环境想跳过检查可设置环境变量 `OSML_SKIP_COMPAT_CHECK=1`。

另外，如果解压版在旧机器上提示缺少 `VCRUNTIME140.dll`，安装 [Microsoft Visual C++ 2015-2022 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe) 即可；安装包里已经内置 WebView2 引导程序，无需另外准备。
</details>

<details>
<summary><b>联机有什么条件？</b></summary>

联机基于公网 IPv6 点对点直连（无中转服务器），双方需具备可用的公网 IPv6 网络，且房主需确保路由器/防火墙放行 UDP/TCP `11010` 端口。
</details>

<details>
<summary><b>已知限制说明</b></summary>

- **基岩版仅限 Windows**：依赖 Windows AppX / GDK 与 Xbox 运行时。
- **未代码签名提示**：当前构建未附带商业代码签名证书，Windows SmartScreen 提示「未知发布者」时请核对 GitHub Releases 来源后放行。
- **PCL2 主页兼容**：支持常用布局与控件，部分专属事件或复杂动画会标记为暂不支持。
</details>

---

## 参与贡献

欢迎提交 [Issue](https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/issues) 反馈问题，或直接发起 Pull Request：

1. Fork 本仓库并从 `main` 创建分支（如 `feat/xxx` 或 `fix/xxx`）。
2. 提交前请确保通过 `npm run build` 与 `cargo test --manifest-path src-tauri/Cargo.toml`。
3. 涉及界面改动建议在 PR 中附上预览截图。

## 致谢与许可证

感谢 [Tauri](https://tauri.app)、[React](https://react.dev)、[EasyTier](https://easytier.cn)、[BedrockBoot-DM](https://github.com/0x44614D696E67/BedrockBoot-DM) 等开源项目，以及 [BMCLAPI](https://github.com/bangbang93/BMCLAPI)、[Modrinth](https://modrinth.com)、[CurseForge](https://www.curseforge.com)、[Betacraft](https://betacraft.uk)、[MC 百科](https://www.mcmod.cn) 提供的镜像与数据服务。

本项目基于 [MIT License](LICENSE) 开源。
> Minecraft 是 Mojang Studios 的商标。本项目与 Mojang Studios 及 Microsoft 无关联，也不分发游戏本体。
