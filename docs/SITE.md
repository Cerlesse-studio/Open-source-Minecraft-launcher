# 官网维护说明

`docs/` 同时是项目官网的根目录，入口为 `index.html`。可以直接用 GitHub Pages 的「Deploy from a branch → main / docs」发布，仓库里已经包含 `.nojekyll`。

## 页面

| 文件 | 页面 |
| --- | --- |
| `index.html` | 首页 / 介绍、功能、截图与下载入口 |
| `docs.html` | 技术文档 |
| `download.html` | 下载页与源码构建说明 |
| `about.html` | 关于项目 |
| `credits.html` | 开源项目与第三方声明 |

## 本地预览

在仓库根目录执行：

```bash
python -m http.server 8080 --directory docs
```

然后打开 `http://127.0.0.1:8080/`。

## 资源

- `assets/site.css`：共享设计系统与响应式样式。
- `assets/site.js`：导航、滚动显现、截图切换、文档侧栏、复制按钮与系统检测。
- `assets/logo-mark.png`、`assets/favicon.png`、`assets/apple-touch-icon.png`：由 `docs/images/logo.png` 生成。
- `assets/og.png`：社交分享预览图（1200 × 630）。
- `assets/fonts/`：Geist、Geist Mono、Silkscreen，附 OFL 文本。
- `assets/icons/`、`assets/minecraft/`：第三方项目 Logo 与 Minecraft 像素图标。
- `images/`：README 与官网共用的截图与功能图。

## 维护提示

- 页面共享同一套 header / footer，修改导航时请同步五个页面。
- 官网截图来自开发版；如果更新界面，请同步替换 `docs/images/home.png`、`download.png`、`settings.png`。
- 社交预览图引用的是 `main` 分支的 raw 地址；更换仓库默认分支时需要同步修改各页面的 `og:image`。
- 第三方项目、许可证或链接发生变化时，更新 `credits.html` 与根目录 `README.md` 的致谢部分。
