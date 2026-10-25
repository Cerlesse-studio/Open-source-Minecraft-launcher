<div align="center">

<img src="docs/images/logo.png" alt="Open-source-Minecraft-launcher" width="128" />

# Open-source-Minecraft-launcher

一个轻量、现代的开源 Minecraft 启动器（支持 Java 版与基岩版双架构）

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

### ▶ 一键启动

从官方版本清单获取正式版、快照与远古版本，自动补全客户端、依赖库、natives 与资源文件后直接进入游戏。每个版本使用独立目录，存档、模组与配置互不干扰；还可以为单个版本单独设置内存与窗口大小。游戏输出会实时显示在日志面板中。

### ⇊ 多线程下载

内置并发下载器，线程数可在 1–64 之间调节。大文件会通过 HTTP Range 拆分成多个分片并行下载，所有文件写入前都会做 SHA-1 校验。下载页面可以查看每个文件的进度与速度。

### ◈ 模组加载器

在下载列表中点击任意版本，即可进入安装页面，选择 **Forge / NeoForge / Fabric / Quilt** 及 **OptiFine**、Fabric API 等附加组件。启动器会自动检查互斥关系，并生成一个可直接启动的独立实例。

### ▦ 资源中心

接入 Modrinth，可按游戏版本、加载器和热度搜索 **模组、整合包、光影包、数据包**。进入独立的版本选择页面挑选文件后，会自动下载到目标实例的 `mods/`、`shaderpacks/`、`datapacks/` 等对应目录。

### ◎ 就近镜像

默认使用官方源及亚太 Anycast CDN（香港 / 台北 / 东京 / 新加坡节点），不经过中国大陆的镜像。也可以在 **设置 → 下载与网络** 中切换到 BMCLAPI 或填写自定义镜像地址。

### ☕ Java 自动管理

启动前会根据版本要求的 Java 主版本，在本机已安装的运行时中自动匹配；没有合适的版本时会自动下载 Eclipse Temurin JRE。也支持手动指定 `java` 可执行文件。

### ❖ 基岩版支持 (Bedrock Edition)

原生集成 Minecraft 基岩版环境管理：
- **版本下载与商店直连**：可一键下载 Bedrock 核心与服务包，或快速跳转 Windows Microsoft Store 原生正版安装。
- **一键启动**：支持原生协议激活 Windows UWP 正版基岩版，或启动本地独立运行核心。
- **光影与模组自动安装**：精选并提供 **Deferred Lighting PBR (延迟着色管线光影)**、**Kelly's RTX (光追光影)**、**YSS Shader** 以及 **Actions & Stuff (动作物理行为包)**、**Essentials Add-on** 等。支持解析 `.mcpack` 与 `.mcaddon`，自动区分资源包与行为包解压部署至 `com.mojang` 目录并唤起系统安装。
- **本地包导入**：支持一键导入外部 `.mcpack` / `.mcaddon` / `.zip`，快速完成安装配置。

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

### 打包

```bash
npm run tauri build
```

安装包输出在 `src-tauri/target/release/bundle/`。

### 测试

```bash
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## 目录结构

```
├── src/                     # 前端 (React + TypeScript)
│   ├── components/          # 页面与业务组件
│   │   └── ui/              # shadcn/ui 基础组件
│   └── lib/                 # 类型、后端调用、设置存储
└── src-tauri/               # 后端 (Rust)
    └── src/
        ├── minecraft.rs     # 版本清单、下载、启动参数
        ├── loaders.rs       # 模组加载器安装
        ├── content.rs       # Modrinth 资源搜索与下载
        ├── bedrock.rs       # 基岩版检测、启动、光影与模组解压安装
        ├── java.rs          # Java 检测与自动安装
        ├── net.rs           # 多线程下载器
        └── lib.rs           # Tauri 命令与事件
```

游戏文件默认保存在 `~/.cobble/`，可在 **设置 → 游戏与启动** 中修改。

## 尚未支持

- Microsoft 正版登录与皮肤
- 删除版本、取消下载任务
- macOS / Linux 尚未充分实机测试

欢迎提交 Issue 与 Pull Request。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

> Minecraft 是 Mojang Studios 的商标。本项目与 Mojang 及 Microsoft 无任何关联。
