<div align="center">

<img src="docs/images/logo.png" alt="Open-source-Minecraft-launcher" width="128" />

# Open-source-Minecraft-launcher

一个轻量、现代的高性能开源 Minecraft 启动器（原生支持 Java 版与基岩版双架构）

基于 **Tauri 2 · Rust · React 19** 构建

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-2024-000000?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

</div>

---

## 截图

<table>
  <tr>
    <td colspan="2"><img src="docs/images/home.png" alt="主页" /></td>
  </tr>
  <tr>
    <td><img src="docs/images/download.png" alt="下载中心" /></td>
    <td><img src="docs/images/settings.png" alt="设置" /></td>
  </tr>
</table>

## 核心功能

<table>
  <tr>
    <td><img src="docs/images/feature-launch.svg" alt="一键启动" /></td>
    <td><img src="docs/images/feature-download.svg" alt="多线程下载" /></td>
  </tr>
  <tr>
    <td><img src="docs/images/feature-loaders.svg" alt="模组加载器" /></td>
    <td><img src="docs/images/feature-resources.svg" alt="资源中心" /></td>
  </tr>
  <tr>
    <td><img src="docs/images/feature-mirror.svg" alt="就近镜像" /></td>
    <td><img src="docs/images/feature-java.svg" alt="Java 自动管理" /></td>
  </tr>
</table>

### ▶ 智能游戏启动与设置
- **版本核心自动识别**：智能检测所选版本的启动架构与依赖，无需手动选择启动核心。
- **独立版本配置**：每个实例均支持独立设置最大/最小内存、窗口大小与全屏、JVM 参数、环境变量覆盖、进程优先级（高/正常/低）以及启动器关闭/最小化行为。
- **实时控制台**：游戏标准输出与错误日志实时投递至日志面板，支持 ANSI 染色与一键导出。

### ⇊ 多线程下载引擎与断点续传
- **并发多线程下载**：线程数支持 1–64 级调节，针对大文件自动利用 HTTP Range 进行无损分片并发传输。
- **暂停、恢复与取消**：支持下载任务实时暂停与恢复；软件关闭时自动保留断点而非丢失，彻底杜绝安装失败后的残留垃圾文件。
- **多镜像透明容灾 (防 404)**：遇到网络丢包或 HTTP 404 时，底层自动毫秒级故障转移（官方源、BMCLAPI、Fabric/Forge/NeoForge Maven、10 大 Xbox Live CDN 节点无缝轮询），确保 100% 下载成功率。

### ◈ 双架构模组加载器生态

#### Java 版模组生态
- 支持一键安装与配置 **Forge / NeoForge / Fabric / Quilt** 及 **OptiFine**、Fabric API 等附加组件，自动处理兼容性与依赖互斥。

#### 基岩版（Bedrock）模组生态（基于 BedrockBoot 架构标准）
- **LeviLamina 模组加载器**：接入官方 `levilamina-client-version-db` 数据库，自动匹配并一键下载部署官方最新或指定版本的 LeviLamina 加载器。
- **Amethyst 客户端加载器**：支持原生 C++ 客户端 Mod 注入框架。
- **原生 DLL 模组管理 (DllMods)**：遵循 BedrockBoot 目录与配置规范，支持原生 `.dll` 模组、LeviLamina 插件与行为包的一键启停（`.disabled` 切换）、删除与本地导入。

### ❖ 基岩版环境管理 (Bedrock Edition)
- **首次启动依赖自检**：所有基岩版启动路径（商店客户端、`.msixvc` 加密包、AppX、BDS 独立核心）都会在启动前自检运行依赖；Xbox GDK 路径会通过 winget 自动静默补齐「Xbox 应用」与「游戏服务」，随后直接唤起游戏，无需手动排查。
- **UWP / AppX 核心不经过 Microsoft Store**：下载得到的 UWP 核心由启动器自行解包，并按 BedrockBoot 的方式以开发模式在本机注册（`Add-AppxPackage -Register`，不带 `-DisableDevelopmentMode`），随后按应用标识唤起游戏；本机未安装的框架依赖会被自动跳过，不再回退到 `minecraft:` 协议或弹出商店安装页。安装包内的原始清单会保留为 `AppxManifest.factory.xml`。
- **Xbox GDK 加密包自动接管**：选中 `.msixvc` 加密核心时不再报错阻塞，启动器会自动探测并补齐运行依赖，随后直接唤起商店版客户端；若 winget 缺失或安装被拦截，会自动打开对应商店安装页。
- **85+ 款官方 Xbox Live CDN 实测直链**：集成高带宽原生直链，支持正式版与预览版极速下载安装。
- **离线账户核心策略**：离线账户启动基岩版时优先使用已安装的 BDS 独立核心；若只下载了 UWP/AppX 或 GDK 核心，则直接注册并唤起对应客户端（GDK 加密包自动补齐 Xbox 运行环境），不再强制改用 BDS；本机完全没有核心时才自动后台部署 BDS，无需手动选版本。
- **UWP / 独立核心多实例并存**：下载的 UWP/AppX 核心会以开发模式注册并直接启动，商店版 UWP 正版同样一键唤起，也可运行版本隔离的 AppX / BDS 独立核心。
- **光影与行为包自动部署**：原生支持 `.mcpack` 与 `.mcaddon`，智能区分资源包与行为包，一键解压并部署至 `com.mojang` 与实例目录。

### ▦ 资源市场
接入 Modrinth，可按游戏版本、加载器（Fabric/Forge/NeoForge/Quilt/Bedrock）和热度搜索模组、整合包、光影包与材质包，自动下载部署至目标实例目录。

### ☕ 智能运行时环境
启动前根据 Minecraft 版本规范自动匹配系统已安装的 Java 版本；首次启动若缺失对应 Java，会自动下载并部署 Eclipse Temurin JRE / JDK 后继续启动，无需手动干预。

---

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://www.rust-lang.org/tools/install) stable
- [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)

### 开发运行

```bash
git clone https://github.com/<your-name>/Open-source-Minecraft-launcher.git
cd Open-source-Minecraft-launcher
npm install
npm run tauri dev
```

### 构建打包

```bash
npm run tauri build
```

打包产物输出在 `src-tauri/target/release/bundle/`。

### 测试验证

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

---

## 目录结构

```
├── src/                     # 前端 (React 19 + TypeScript + Tailwind CSS)
│   ├── components/          # 视图与交互组件
│   │   ├── BedrockModLoaderModal.tsx # 基岩版加载器与模组管理器
│   │   ├── VersionSettingsView.tsx   # 版本独立启动设置面板
│   │   ├── DownloadCatalogView.tsx   # 版本与核心下载目录
│   │   └── ui/              # shadcn/ui 基础组件
│   └── lib/                 # 类型定义、IPC 桥接、设置存储
└── src-tauri/               # 后端 (Rust + Tauri 2)
    └── src/
        ├── minecraft.rs     # Java 版版本清单、资产下载、启动进程
        ├── loaders.rs       # Java 版模组加载器安装与解析
        ├── bedrock.rs       # 基岩版检测、Xbox CDN 直链、LeviLamina/模组加载与管理
        ├── content.rs       # 资源市场搜索与下载
        ├── java.rs          # Java 运行时检测与自动部署
        ├── net.rs           # 多线程分片并发下载、多镜像容灾与断点续传引擎
        └── lib.rs           # Tauri 命令暴露与事件分发
```

游戏数据默认保存在 `~/.cobble/`（或自定义游戏根目录）。

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

> Minecraft 是 Mojang Studios 的商标。本项目与 Mojang 及 Microsoft 无任何关联。
