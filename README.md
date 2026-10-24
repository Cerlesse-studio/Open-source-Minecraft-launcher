# Cobble · 卵石启动器

一个用 **Tauri 2 + React 19 + Rust** 写的 Minecraft 启动器，界面使用 **shadcn/ui + Tailwind CSS v4**。
下载与启动是完整实现的核心路径：从 Mojang 官方源获取版本、客户端、依赖库、natives 和资源文件，并在 Java 就绪后直接进入游戏。

## 已实现

- **版本下载**：读取官方 `version_manifest_v2.json`，下载客户端 jar、libraries、natives、asset index 与资源对象。
- **规则处理**：按操作系统 / 架构筛选依赖库，处理旧版 `natives` 分类器和 1.19+ 的独立 natives 依赖。
- **资源校验**：已存在文件按大小/ SHA-1 跳过，缺失或损坏的文件会重新下载。
- **Java 自动安装**：检测系统及托管目录中的 Java；主版本不匹配时从 Adoptium 自动下载 Temurin JRE（Windows / macOS / Linux）。
- **启动参数**：支持现代 `arguments` 与旧版 `minecraftArguments`，替换类路径、natives、资源目录、离线 UUID 等占位符。
- **进程管理**：捕获游戏 stdout/stderr，将旧版 log4j XML 转成可读日志；支持结束进程并正确回到空闲状态。
- **界面**：基于 shadcn/ui 的主页、版本选择、版本设置与启动器总设置；官方更新新闻、可收起侧栏、深色主题和键盘可访问控件。离线账户、游戏目录、Java、默认内存与自定义分辨率都会本地保存。
- **单版本启动参数**：在版本设置中为每个版本单独覆盖内存与窗口大小，主仪表盘、运行环境和日志也集中在这里。
- **离线可启动**：已安装版本不依赖网络；本地版本 JSON 缺失时才回退到版本清单。

## 开发

需要 Node.js 20+、Rust stable，以及 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
npm install
npm run tauri dev
```

构建安装包：

```bash
npm run tauri build
```

首次启动某个版本时，如果没有匹配的 Java，会自动下载 Temurin JRE。游戏文件默认放在：

```
~/.cobble/
├── assets/                 # 资源对象、索引与旧版虚拟资源
├── libraries/              # 依赖库
├── runtime/temurin-{n}/    # 自动安装的 Java
├── meta/                   # 版本清单缓存
└── versions/<id>/
    ├── <id>.json
    ├── <id>.jar
    └── natives/
```

每个版本使用 `versions/<id>` 作为游戏目录，因此存档、模组和配置互相隔离。

## 验证

Rust 单元测试与前端构建：

```bash
cd src-tauri && cargo test --lib
npm run build
```

还有一个真实的安装/启动冒烟测试（会下载文件和 Java，耗时取决于网络）：

```bash
cd src-tauri
cargo run --example smoke -- 1.8.9 "C:/absolute/path/mc-test" Steve 20
cargo run --example smoke -- 26.3 "C:/absolute/path/mc-modern" Steve 25
```

最后一个参数是等待游戏的秒数，设为 `0` 表示只安装不启动。测试目录可以随时删除。

## 结构

- `src-tauri/src/minecraft.rs` — 清单、规则、下载、natives、资源与启动参数
- `src-tauri/src/java.rs` — Java 检测、Adoptium 运行时安装
- `src-tauri/src/net.rs` — HTTP 下载、SHA-1 校验、原子写入
- `src-tauri/src/lib.rs` — Tauri 命令、安装/游戏事件、进程监控
- `src/components/ui/` — shadcn/ui 组件（按钮、卡片、标签页、表单、进度、菜单等）
- `src/components/` — 主页、版本选择、版本设置、启动器总设置和日志界面
- `src/styles.css` — Tailwind 主题变量与少量品牌样式
- `src/lib/demo.ts` — 浏览器预览用的模拟数据（桌面版不会加载）

## 当前限制

- 仅支持**离线账户**，尚未接入 Microsoft 登录、皮肤和 Realms。
- 暂不支持 Forge / Fabric / NeoForge 等模组加载器安装。
- 暂不支持删除版本、下载限速或安装任务取消。
- 主要在 Windows 上验证；其他平台保留了对应的路径和 Java 逻辑，但还需要实机测试。

Minecraft 是 Mojang Studios 的商标。本项目与 Mojang 或 Microsoft 没有关联。
