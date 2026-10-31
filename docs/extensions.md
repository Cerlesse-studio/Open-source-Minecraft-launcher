# 扩展开发

启动器的扩展系统提供两条路径：启动器原生格式（JavaScript + Rust/WASM）和 Chrome 扩展兼容格式（Manifest V2 / V3）。两套扩展都安装到同一个目录，在「扩展」页面统一启用、停用、导出和卸载。

> 扩展会在启动器界面进程里执行 JavaScript，**不是**浏览器级别的安全沙箱。只安装你信任的扩展；来自网络的 `.crx` 不会校验 Chrome 的签名链。

## 目录

- [安装方式](#安装方式)
- [目录与 ID](#目录与-id)
- [启动器原生格式](#启动器原生格式)
- [Chrome 扩展兼容](#chrome-扩展兼容)
- [chrome.* API 支持范围](#chrome-api-支持范围)
- [启动器 API](#启动器-api)
- [示例：Chrome MV3 扩展](#示例chrome-mv3-扩展)
- [示例：原生 Rust + JS 扩展](#示例原生-rust--js-扩展)
- [调试](#调试)
- [限制与安全边界](#限制与安全边界)

## 安装方式

扩展页面右上角提供三个入口：

| 入口 | 接受的内容 | 说明 |
| :-- | :-- | :-- |
| 安装扩展 | `.zip` / `.crx` | 压缩包根目录或唯一一级子目录中必须有 `manifest.json`。`.crx` 会剥离 CRX2/CRX3 头部，不验证签名。 |
| 载入目录 | 已解压的扩展文件夹 | 等价于 Chrome 的「加载已解压的扩展程序」，目录根级必须有 `manifest.json`；复制时跳过 `.git` 和符号链接。 |
| 示例扩展 | 内置示例 | 生成并安装一个原生 Rust + JS 示例。 |

也可以直接把扩展文件夹放进 `<游戏目录>/extensions/<任意名称>/`，然后在扩展页面点刷新。没有配置游戏目录时，扩展位于 `~/.cobble/extensions/`。

安装会先写入临时目录 `.install-*`，完成后再替换旧目录。以 `.` 开头的目录不会出现在扩展列表中。

## 目录与 ID

```text
<游戏目录>/extensions/
├── extensions.json          # 启用状态，由启动器维护，不要手改
├── my-native-extension/     # 原生扩展
│   ├── manifest.json
│   ├── background.js
│   ├── plugin.wasm
│   └── popup.html
└── chrome-hello-world/      # Chrome 扩展
    ├── manifest.json
    ├── background.js
    ├── popup.html
    └── _locales/
```

- 原生扩展的 ID 来自 `manifest.json` 的 `id`，必须只包含 ASCII 字母、数字、`-`、`_`。
- Chrome 扩展没有 `id` 字段：安装后的**文件夹名就是扩展 ID**。通过安装包安装时，ID 由 `chrome-` 加扩展名 slug 组成；手工放入的文件夹保持原名。
- `extensions.json` 是 `{ "<id>": true }` 形式的状态表。卸载扩展会同时删除对应条目。

## 启动器原生格式

`manifest.json`：

```json
{
  "id": "hello-native",
  "name": "Hello Native",
  "version": "1.0.0",
  "description": "一个最小的原生扩展",
  "author": "you",
  "icon": "icon.png",
  "permissions": ["launcher:game", "launcher:storage", "launcher:notification", "launcher:rust"],
  "scripts": {
    "javascript": "background.js",
    "rust": "plugin.wasm"
  },
  "ui": {
    "popup": "popup.html",
    "tab": { "title": "Hello", "entry": "popup.html" }
  }
}
```

| 字段 | 必填 | 说明 |
| :-- | :-: | :-- |
| `id` | ✅ | 唯一 ID，同时也是安装目录名。 |
| `name` / `version` | ✅ | 展示名称和版本。 |
| `description` / `author` |  | 卡片描述与作者。 |
| `icon` |  | 相对路径，支持 PNG / JPEG / SVG / WebP。 |
| `permissions` |  | 仅供展示与约定使用，启动器不会在运行时强制拦截 API。 |
| `scripts.javascript` |  | 后台脚本；在启动器界面进程的 `new Function` 中执行。 |
| `scripts.rust` |  | `.wasm` 文件会被加载为 WebAssembly；其他扩展名按源码展示。 |
| `ui.popup` / `ui.tab.entry` |  | 弹窗 HTML。相对路径的 CSS / JS / 图片会在加载时内联。 |

没有 `scripts.javascript` 时扩展仍然可以只提供弹窗。`plugin.wasm` 是约定的可选 Rust 协处理器文件。

## Chrome 扩展兼容

扩展页面会识别 `manifest_version: 2` 和 `manifest_version: 3`，无需转换清单。安装器会读取以下字段：

| Chrome 字段 | 在启动器中的行为 |
| :-- | :-- |
| `name` / `version` / `description` / `author` | 展示在扩展卡片；`name` / `description` 中的 `__MSG_key__` 会用 `_locales/<default_locale>/messages.json` 解析。 |
| `icons` | 取最大尺寸作为卡片图标。 |
| `action.default_popup`（MV3） / `browser_action.default_popup`（MV2） | 作为「打开扩展窗口」的 HTML。 |
| `background.service_worker`（MV3） | 读取并拼接为后台脚本。 |
| `background.scripts`（MV2） | 按数组顺序拼接后台脚本。 |
| `background.page` | 读取页面中的 `<script src>`，按顺序加载。 |
| `permissions` | 展示 API 权限；形如 `https://*/*`、`*://*/*`、`<all_urls>` 的条目会归入主机权限展示。 |
| `host_permissions` | 仅展示，不会拦截或注入网页。 |
| `default_locale` + `_locales/` | 供清单占位符和 `chrome.i18n.getMessage` 使用。 |

### 弹窗资源

Chrome 弹窗常见写法：

```html
<link rel="stylesheet" href="popup.css">
<img src="images/logo.png">
<script src="popup.js"></script>
```

启动器没有为扩展注册独立的页面源，弹窗通过 `srcDoc` 载入，因此会在读取时把以下内容内联成自包含 HTML：

- `<link rel="stylesheet" href="...">` → `<style>`，并递归处理 CSS 的 `url(...)`。
- `<script src="...">` → 内联 `<script>`。
- `<img src="...">` → base64 `data:` URL。
- 内联 `<style>` 中的 `url(...)`。

单个内联资源上限为 8 MiB。以下情况不会被内联，需要改写扩展：

- 运行时 `fetch()`、`XMLHttpRequest` 读取扩展目录文件。
- `chrome.runtime.getURL()` 返回的路径：目前只返回原字符串，不能直接作为 `<img src>` 或 `fetch` 使用。
- ES module 的相对 `import`（脚本会被内联，模块解析基准会丢失）。
- `srcset`、`<video>`、`<audio>`、`@import "x.css"` 等未列出的引用。

## chrome.* API 支持范围

`chrome` 与 `browser` 指向同一个对象，同时提供回调写法和 Promise。后台脚本和弹窗都能拿到它。

| API | 支持 | 说明 |
| :-- | :-: | :-- |
| `chrome.storage.local` / `sync` | ✅ | `get` / `set` / `remove` / `clear`；两者共用同一个存储区，和原生扩展的 `launcher.storage` 同前缀。 |
| `chrome.runtime.id` | ✅ | 扩展 ID。 |
| `chrome.runtime.getManifest()` | ✅ | 返回归一化后的清单，不一定包含原始清单的所有字段。 |
| `chrome.runtime.getURL(path)` | ⚠️ | 返回传入的路径字符串；不能直接加载资源。 |
| `chrome.runtime.sendMessage()` | ✅ | **弹窗 → 后台**有效；后台通过 `onMessage` 收到消息并可回复。 |
| `chrome.runtime.onMessage` | ⚠️ | 后台脚本可接收；弹窗侧的监听器目前不会收到后台消息。 |
| `chrome.notifications.create()` | ✅ | 转成启动器通知，标题缺省用扩展名；不支持 `onClicked`、按钮和图标。 |
| `chrome.i18n.getMessage()` | ✅ | 使用安装时读取的默认语言消息，支持 `$1` / `$2` 替换。 |
| `chrome.action.*` / `chrome.browserAction.*` | ❌ | 只读取其 `default_popup`，不提供徽标、脚本注入等。 |
| `chrome.tabs` / `windows` / `scripting` | ❌ | 没有网页上下文。 |
| `content_scripts` | ❌ | 不会向任何网页注入脚本。 |
| `declarativeNetRequest` / `webRequest` | ❌ | 不拦截网络。 |
| `nativeMessaging` / `omnibox` / `devtools` / `sidePanel` | ❌ | 未实现。 |
| `runtime.connect` / 端口 | ❌ | 仅支持一次性 `sendMessage`。 |
| `storage.onChanged` | ❌ | 修改可通过重新读取获得。 |
| Service Worker 生命周期 | ❌ | 后台脚本在启动器加载扩展时执行一次，不模拟 install/update/activate 事件。 |

`chrome.runtime.lastError` 未提供；回调在被拒绝时拿到的是 `undefined`。

## 启动器 API

原生扩展和 Chrome 扩展都可以使用 `window.launcher`：

```js
// 键值存储：值为 JSON 序列化后的任意数据
const count = (await launcher.storage.get("count")) ?? 0;
await launcher.storage.set("count", count + 1);
await launcher.storage.remove("count");

// 游戏生命周期
launcher.game.onLaunch((event) => console.log("launched", event));
launcher.game.onExit((event) => console.log("exited", event));

// 启动器通知
launcher.ui.notify({ title: "标题", message: "内容", type: "success" });

// 调用扩展自带 WASM；没有对应导出时回退到后端演示分派器
const result = await launcher.rust.call("compute", { a: 1, b: 2 });
```

WASM 导出函数按 `(a: i32, b: i32) => i32` 调用。后端 `execute_extension_rust` 目前只内置 `compute`（相加）、`multiply`（相乘）、`hash`（SHA-1）三个演示函数，其他名称会回退为相加；真正的扩展逻辑应编译进 `plugin.wasm`。

## 示例：Chrome MV3 扩展

目录：

```text
chrome-hello-world/
├── manifest.json
├── background.js
├── popup.html
├── popup.css
└── _locales/zh_CN/messages.json
```

`manifest.json`：

```json
{
  "manifest_version": 3,
  "name": "__MSG_appName__",
  "version": "1.0.0",
  "description": "一个兼容启动器的 Chrome 扩展示例",
  "default_locale": "zh_CN",
  "action": { "default_popup": "popup.html" },
  "background": { "service_worker": "background.js" },
  "permissions": ["storage", "notifications"]
}
```

`_locales/zh_CN/messages.json`：

```json
{
  "appName": { "message": "Hello Chrome" }
}
```

`background.js`：

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ping") {
    chrome.storage.local.get("count").then(({ count = 0 }) => {
      chrome.storage.local.set({ count: count + 1 });
      sendResponse({ pong: true, count: count + 1 });
    });
    return true; // 异步回复
  }
  return false;
});
```

`popup.html`：

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <button id="ping">Ping 后台</button>
    <pre id="out"></pre>
    <script src="popup.js"></script>
  </body>
</html>
```

`popup.js`：

```js
document.getElementById("ping").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "ping" });
  document.getElementById("out").textContent = JSON.stringify(response);
});
```

这个示例覆盖了清单本地化、Service Worker 后台、`chrome.storage`、消息回复和样式内联，是验证兼容层的最小流程。

## 示例：原生 Rust + JS 扩展

「示例扩展」按钮会生成一个可直接运行的包，包含：

- `manifest.json`：声明 `launcher:*` 权限、后台脚本和弹窗。
- `background.js`：监听 `launcher.game.onLaunch`，累计启动次数并发送通知。
- `plugin.wasm`：导出 `compute(a, b) = a + b` 的最小 WASM 模块。
- `plugin.rs`：WASM 源码示例。
- `popup.html` / `icon.png`：弹窗和图标。

生成后会自动安装，可在扩展页面点击「打开扩展窗口」查看。也可以点「导出」把安装目录重新打包为 ZIP，用于分享或版本归档。

## 调试

1. 打开扩展页面的「控制台」，后台脚本的 `console.log` / `warn` / `error`、WASM 初始化、消息处理和 Rust 调用会按扩展 ID 记录在这里。
2. 弹窗内的错误会显示在弹窗自身；扩展页面不会捕获 iframe 的异常。
3. 「测试 Rust 模块」会优先调用 `compute` 的 WASM 导出，没有时再走后端演示分派器。
4. 修改扩展文件后点刷新会重新扫描；后台脚本会再次执行。由于没有真正的 Service Worker 生命周期，重复执行可能重复注册监听器，开发时请留意日志。

## 限制与安全边界

- **没有网页上下文**：不支持 content script、标签页、网络拦截和页面脚本注入。
- **不是安全沙箱**：后台脚本在启动器渲染进程里通过 `new Function` 执行，可以访问 `window`、`document` 和启动器 API；弹窗 iframe 也只是 HTML sandbox。请只安装可信扩展。
- **不验证 CRX 签名**：`.crx` 只剥离头部后当作 ZIP 解包。不要安装来源不明的 CRX。
- **弹窗资源是静态内联**：动态 `fetch`、`chrome.runtime.getURL` 资源和 ES module 相对导入不受支持。
- **后台消息是单向的**：支持弹窗发消息给后台并等待回复；不支持后台主动向弹窗发消息或长连接端口。
- **权限仅作展示**：不会因为清单声明了 `tabs`、`webRequest` 或主机权限就获得对应能力。
- **每次扫描会重新执行后台脚本**：没有持久化的 Service Worker 生命周期和 `onInstalled` / `onStartup` 事件。
- **后台脚本按普通脚本执行**：MV3 的 `type: "module"`、`import`、`importScripts()` 不会被解析；需要打包成单文件后再放入扩展。
- **Chrome 清单只读取上面列出的字段**：`options_ui`、`commands`、`omnibox`、`side_panel`、`declarative_net_request` 等会被忽略。

如果扩展依赖上述能力，建议改用原生格式，把需要的能力通过 `launcher.*` 显式实现，而不是依赖 Chrome API 的完整模拟。
