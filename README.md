# Open-source-Minecraft-launcher

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个用 **Tauri 2 + React 19 + Rust** 构建的现代化开源 Minecraft 启动器，界面基于 **shadcn/ui + Tailwind CSS v4**。
下载与启动是完整实现的核心链路：从官方与亚太高速 CDN 获取版本、客户端、依赖库、natives 和资源文件，并在 Java 就绪后直接启动进入游戏。

## 特性

- **游戏版本下载**：读取官方 `version_manifest_v2.json`，多线程下载客户端 jar、libraries、natives、asset index 与资源散列对象。
- **多线程与 HTTP Range 加速**：支持 1–64 并发工作池，大文件启用 HTTP Range 分片并发拉取与 SHA-1 完整性校验。
- **模组加载器集成**：支持 Fabric、Quilt、Forge、NeoForge 及 OptiFine 等主流模组加载器安装与配置。
- **资源中心 (Marketplace)**：集成 Modrinth 模组 (Mods)、整合包 (Modpacks)、光影包 (Shaders) 与数据包 (Datapacks) 浏览与独立版本安装页面。
- **非大陆就近镜像链路**：默认接入 Cloudflare Anycast 与 AWS CloudFront 亚太分布式边缘节点（覆盖香港 HKG、台北 TPE、东京 NRT、新加坡 SIN 等），低延迟直连，亦支持切换至国内 BMCLAPI 或自定义镜像网关。
- **规则处理**：按操作系统 / 架构筛选依赖库，处理旧版 `natives` 分类器和 1.19+ 的独立 natives 依赖。
- **Java 自动安装**：检测系统及托管目录中的 Java；主版本不匹配时从 Adoptium 自动下载 Temurin JRE（Windows / macOS / Linux）。
- **多版本独立隔离**：每个版本使用独立的子目录，存档、模组、光影和配置文件相互隔离，避免冲突。
- **单版本启动参数覆盖**：在版本独立设置中为各个版本单独覆盖内存与窗口尺寸。
- **全功能控制台**：实时捕获游戏 stdout/stderr，高亮显示各类日志级别，支持一键停止进程。

## 开发与运行

需要 Node.js 20+、Rust stable，以及 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
npm install
npm run tauri dev
```

构建安装包：

```bash
npm run tauri build
```

## 验证

Rust 单元测试与前端编译：

```bash
cd src-tauri && cargo test
npm run build
```

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。

Minecraft 是 Mojang Studios 的商标。本项目与 Mojang 或 Microsoft 没有关联。
