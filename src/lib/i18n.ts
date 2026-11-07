import { useMemo, useSyncExternalStore } from "react";
import type { LauncherLanguage } from "./types";

/**
 * Tiny launcher-wide translation layer.
 *
 * Chinese is the source language: call sites keep writing `t("中文文案")` and the
 * English pack supplies the matching entry. Missing entries fall back to the
 * Chinese source, so a partially translated page never renders a raw key.
 * The module-level store lets every subscribed component react to a language
 * change without threading a context through every page.
 */
const EN: Record<string, string> = {
  // -------------------------------------------------------------------------
  // Window chrome / sidebar
  // -------------------------------------------------------------------------
  预览模式: "Preview",
  "当前在浏览器中预览，不会下载或启动真实游戏":
    "Browser preview — no real game will be downloaded or launched.",
  最小化: "Minimize",
  还原窗口: "Restore",
  最大化: "Maximize",
  关闭: "Close",
  主页: "Home",
  更新新闻与快速启动: "Patch notes and quick launch",
  联机: "Multiplayer",
  "无需公网 IPv6，通过共享节点分享局域网世界":
    "Share a LAN world through a shared relay, no public IPv6 required",
  下载: "Downloads",
  下载新的游戏版本与进入下载进度: "Get new game versions and track downloads",
  扩展: "Extensions",
  "Chrome MV2/MV3 兼容与 Rust + JS 扩展系统":
    "Chrome MV2/MV3 compatibility and the Rust + JS extension system",
  设置: "Settings",
  启动器总设置: "Launcher settings",
  "正在检测 Java": "Detecting Java",
  "Java 未检测到": "Java not found",
  启动时会再次校验版本: "The version is checked again at launch",
  正在扫描本机与运行时: "Scanning this PC and bundled runtimes",
  首次启动会自动安装: "Installed automatically on first launch",
  展开菜单: "Expand menu",
  收起菜单: "Collapse menu",
  打开启动器设置: "Open launcher settings",
  "已登录正版账户 {name} · 打开启动器设置":
    "Signed in as {name} · open launcher settings",
  正版: "Premium",
  离线: "Offline",
  "Java 与基岩版共用此账户": "Shared by Java and Bedrock",
  本地账户: "Local account",
  导航: "Navigation",
  "主导航": "Main navigation",
  下载中: "Downloading",
  运行中: "Running",
  空闲: "Idle",

  // -------------------------------------------------------------------------
  // Settings shell
  // -------------------------------------------------------------------------
  已自动保存: "Saved automatically",
  "正在载入页面…": "Loading page…",
  账户设置: "Account",
  游戏与启动: "Game & launch",
  下载与网络: "Downloads & network",
  个性化: "Personalization",
  开发者: "Developer",
  关于启动器: "About",

  // -------------------------------------------------------------------------
  // Personalization: theme / background
  // -------------------------------------------------------------------------
  主题: "Theme",
  外观模式: "Appearance",
  深色模式: "Dark",
  浅色模式: "Light",
  跟随系统: "System",
  强调色: "Accent color",
  背景与透明度: "Background & opacity",
  无背景: "None",
  自定义图片: "Custom image",
  图片路径或链接: "Image path or URL",
  "本地图片路径 (如 D:\\wallpaper.jpg) 或网络 URL":
    "Local image path (e.g. D:\\wallpaper.jpg) or a web URL",
  浏览: "Browse",
  清空: "Clear",
  背景模糊度: "Background blur",
  背景不透明度: "Background opacity",
  界面不透明度: "UI opacity",
  "作用于卡片、侧边栏、标题栏、弹窗与输入框":
    "Applies to cards, sidebar, title bar, dialogs and inputs",
  方块网格: "Block grid",
  磨砂玻璃: "Frosted glass",

  // -------------------------------------------------------------------------
  // Personalization: home page
  // -------------------------------------------------------------------------
  主页内容: "Home content",
  空白: "Blank",
  预设: "Preset",
  读取本地文件: "Local file",
  联网更新: "Online",
  "使用内置的“我的世界更新新闻”作为主页内容。":
    "Use the built-in Minecraft news feed as the home content.",
  "主页区域保持空白，只保留右侧启动面板。":
    "Leave the home area empty and keep only the launch panel.",
  "读取本地 HTML 文件，或直接使用 PCL2 的 .xaml 自定义主页；XAML 里的相对图片会按文件所在目录读取。":
    "Load a local HTML file or a PCL2 .xaml home page; relative images in XAML resolve next to the file.",
  "从网络地址加载 HTML 或 PCL2 的 .xaml 主页，可设置自动刷新间隔保持内容最新。":
    "Load an HTML or PCL2 .xaml home page from a URL, with an optional auto-refresh interval.",
  "兼容 PCL2 自定义主页：支持 Grid / StackPanel / Border / TextBlock / Image 等布局与内容组件，以及 MyCard、MyButton、MyHint、MyTextBox 等 PCL 控件、{DynamicResource} 主题色与 EventType 动作（打开网页 / 复制文本 / 刷新主页 / 启动游戏）。无法还原的元素会在主页标题旁标记。":
    "PCL2 home pages are supported: Grid / StackPanel / Border / TextBlock / Image layout and content, plus PCL controls such as MyCard, MyButton, MyHint and MyTextBox, {DynamicResource} theme colors, and EventType actions (open URL / copy text / refresh home / launch game). Elements that cannot be rendered are flagged next to the home title.",
  "本地主页文件（HTML 或 PCL2 的 .xaml）":
    "Local home file (HTML or PCL2 .xaml)",
  "例如 D:\\PCL2\\Homepage.html": "e.g. D:\\PCL2\\Homepage.html",
  主页地址: "Home URL",
  自动刷新间隔: "Auto-refresh interval",
  仅手动刷新: "Manual refresh only",
  打开主页或点击刷新时更新: "Update when the home opens or refresh is clicked",
  "每 5 分钟": "Every 5 minutes",
  适合频繁更新的主页: "For home pages that change often",
  "每 15 分钟": "Every 15 minutes",
  较为均衡: "Balanced",
  "每 30 分钟": "Every 30 minutes",
  节省流量: "Saves bandwidth",
  "每 60 分钟": "Every 60 minutes",
  适合更新较慢的页面: "For pages that change slowly",

  // -------------------------------------------------------------------------
  // Personalization: typography
  // -------------------------------------------------------------------------
  排版与文案: "Typography & copy",
  界面字体风格: "Interface font",
  "现代极简 (Geist Sans)": "Modern minimal (Geist Sans)",
  "专为代码与设计优化的现代极简无衬线字体（推荐）":
    "A modern, minimal sans-serif tuned for code and design (recommended)",
  "复古像素 (Silkscreen)": "Retro pixel (Silkscreen)",
  "经典的 8-bit Minecraft 像素风格字体": "Classic 8-bit Minecraft-style pixel font",
  "系统原生字体 (System UI)": "Native system font (System UI)",
  "跟随当前操作系统原生 UI 字体配置":
    "Follow the operating system's native UI font",
  "古典衬线 (Serif)": "Classic serif",
  "Georgia 与宋体回退，适合喜欢阅读感的排版":
    "Georgia with a CJK serif fallback, for a reading-friendly feel",
  界面字重: "Interface weight",
  "常规字重 (400)": "Regular (400)",
  "默认，轻盈通透": "Default, light and airy",
  "中等字重 (500)": "Medium (500)",
  "文字更厚重，小字号也更清晰": "Heavier text, clearer at small sizes",
  字间距: "Letter spacing",
  "紧凑 (-0.01em)": "Tight (-0.01em)",
  "信息密度更高，适合小屏": "Higher information density, good on small screens",
  标准: "Normal",
  默认排版间距: "Default spacing",
  "宽松 (+0.03em)": "Wide (+0.03em)",
  "更舒缓，搭配像素字体尤其清晰":
    "More relaxed, especially legible with the pixel font",
  平滑过渡动效: "Smooth transitions",
  "自定义启动器窗口标题 (留空使用默认名称)":
    "Custom launcher window title (leave empty for default)",
  "启动器个性标语 / 座右铭签名": "Launcher tagline / signature",
  "自由探索，无限创造。": "Explore freely, create without limits.",
  "首页状态文案 (留空使用默认)": "Home status line (leave empty for default)",
  "准备就绪，随时出发": "Ready when you are",
  "启动按钮文案 (留空使用默认)": "Launch button label (leave empty for default)",
  "启动游戏 / 启动基岩版": "Launch game / Launch Bedrock",

  // -------------------------------------------------------------------------
  // Personalization: language
  // -------------------------------------------------------------------------
  语言与地区: "Language & region",
  界面语言: "Interface language",
  "切换启动器界面语言，保存后立即生效。":
    "Switch the launcher interface language. Changes apply immediately.",
  "简体中文": "简体中文",
  "English": "English",
  "English 界面包目前覆盖启动器框架、主页与个性化设置，其余页面会继续回退到中文。":
    "The English pack currently covers the launcher shell, home screen and personalization settings. Other pages still fall back to Chinese.",

  // -------------------------------------------------------------------------
  // Home: context menu
  // -------------------------------------------------------------------------
  启动: "Launch",
  版本选择: "Versions",
  版本设置: "Version settings",
  玩家档案: "Player profile",
  "账户信息…": "Account details…",
  "登录微软账户…": "Sign in with Microsoft…",
  "上传离线皮肤…": "Upload offline skin…",
  复制玩家名: "Copy player name",
  "启动器设置…": "Launcher settings…",

  // -------------------------------------------------------------------------
  // Home: runtime labels
  // -------------------------------------------------------------------------
  游戏运行中: "Game running",
  "正在检查运行环境…": "Checking the runtime…",
  "基岩版已就绪，随时出发": "Bedrock is ready",
  "尚未下载安装此基岩版本": "This Bedrock version is not installed",
  "此版本尚未安装": "This version is not installed",
  "还没有可启动的版本": "No launchable version yet",
  终止基岩版: "Stop Bedrock",
  结束游戏: "Stop game",
  "正在启动…": "Launching…",
  "取消启动": "Cancel launch",
  "已取消启动": "Launch cancelled",
  启动基岩版: "Launch Bedrock",
  下载基岩版: "Download Bedrock",
  启动游戏: "Launch game",
  下载游戏: "Download game",
  停止运行: "Stop",
  "获取并下载基岩版": "Get and download Bedrock",

  // -------------------------------------------------------------------------
  // Home: news
  // -------------------------------------------------------------------------
  快照: "Snapshot",
  正式版: "Release",
  候选版: "Release candidate",
  预发布: "Pre-release",
  更新: "Update",
  更新新闻: "News",
  刷新主页: "Refresh home",
  复制当前更新标题: "Copy current update title",
  复制主页文件路径: "Copy home file path",
  复制主页地址: "Copy home URL",
  打开文件所在文件夹: "Open containing folder",
  在浏览器中打开: "Open in browser",
  "主页设置…": "Home settings…",
  预设更新新闻: "News feed",
  "内置的 Mojang 更新日志": "Built-in Mojang changelog",
  主页区域留空: "Leave the home area empty",
  "HTML 或 PCL2 的 .xaml 主页": "HTML or PCL2 .xaml home page",
  从网址加载主页: "Load a home page from a URL",
  我的世界更新新闻: "Minecraft news",
  "Mojang 官方 Java 版更新日志": "Official Mojang Java changelog",
  官方同步: "Official sync",
  同步失败: "Sync failed",
  刷新更新新闻: "Refresh news",
  更新新闻暂时不可用: "News is unavailable",
  "无法连接 Mojang 更新服务。检查网络后重试，不影响启动游戏。":
    "Could not reach Mojang's news service. Check your connection and retry; launching is unaffected.",
  重新加载: "Reload",
  最近更新: "Recent updates",
  "{count} 条": "{count} entries",
  "来自 Mojang 官方更新日志，保留英文原文。":
    "From Mojang's official changelog; English text is preserved.",
  暂无更新新闻: "No news yet",

  // -------------------------------------------------------------------------
  // Home: custom home page
  // -------------------------------------------------------------------------
  空白主页: "Blank home",
  "主页内容已清空，右侧启动面板不受影响。":
    "The home area is empty; the launch panel still works.",
  自定义主页: "Custom home",
  本地自定义主页: "Local custom home",
  在线自定义主页: "Online custom home",
  "PCL 兼容": "PCL compatible",
  "{count} 项未兼容": "{count} incompatible",
  尚未设置主页来源: "No home source configured",
  正在加载: "Loading",
  "已更新 {time}": "Updated {time}",
  等待加载: "Waiting",
  刷新自定义主页: "Refresh custom home",
  "正在加载自定义主页…": "Loading custom home…",
  主页加载失败: "Failed to load home",
  "无法读取该 HTML 文件，请检查路径是否存在。":
    "Could not read this HTML file. Check that the path exists.",
  "无法获取该地址，请检查网络与链接是否可访问。":
    "Could not fetch this URL. Check the network and that the link is reachable.",
  "尚未选择本地 HTML 文件": "No local HTML file selected",
  "尚未填写在线主页地址": "No online home URL set",
  打开主页设置: "Open home settings",
  "刷新失败，正在显示上一次成功加载的内容：{error}":
    "Refresh failed; showing the last successfully loaded content: {error}",

  // -------------------------------------------------------------------------
  // Home: launch panel
  // -------------------------------------------------------------------------
  "点击上传自定义皮肤 (PNG)": "Click to upload a custom skin (PNG)",
  在线账户暂不支持本地皮肤上传: "Local skin upload requires an offline account",
  离线档案: "Offline profile",
  在线档案: "Online profile",
  点击上传皮肤: "Click to upload a skin",
  "支持 64×64 PNG": "64×64 PNG",
  恢复默认皮肤: "Restore default skin",
  恢复为默认随机皮肤: "Restore the random default skin",
  未命名玩家: "Unnamed player",
  "正版账户 · Java 与基岩版共用 · XUID {xuid}":
    "Premium account · shared by Java and Bedrock · XUID {xuid}",
  "本地玩家档案 · Java 与基岩版混用共存":
    "Local profile · Java and Bedrock side by side",
  登录方式: "Sign-in",
  离线账户: "Offline account",
  选择登录方式: "Choose sign-in",
  切换: "Switch",
  当前: "Current",
  微软账户: "Microsoft account",
  点击登录: "Sign in",
  基岩版: "Bedrock",
  名称: "Name",
  正版账户名称: "Premium account name",
  使用正版账户时不可自定义角色名称:
    "The player name cannot be changed while signed in",
  "使用 1–16 位字母、数字或下划线":
    "Use 1–16 letters, numbers or underscores",
  "Java 版本:": "Java:",
  "基岩版:": "Bedrock:",
  "附加包:": "Add-ons:",
  "UWP 已就绪": "UWP ready",
  "{count} 个核心": "{count} cores",
};

export type TranslateVars = Record<string, string | number>;

export function translate(
  key: string,
  vars?: TranslateVars,
  language: LauncherLanguage = getLanguage(),
): string {
  const template = language === "en-US" ? (EN[key] ?? key) : key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

let currentLanguage: LauncherLanguage = "zh-CN";
const listeners = new Set<() => void>();

export function getLanguage(): LauncherLanguage {
  return currentLanguage;
}

function applyDocumentLanguage(language: LauncherLanguage) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
  document.documentElement.dataset.language = language;
}

export function setLanguage(next: LauncherLanguage): void {
  if (next !== "en-US") next = "zh-CN";
  if (next === currentLanguage) {
    applyDocumentLanguage(next);
    return;
  }
  currentLanguage = next;
  applyDocumentLanguage(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLanguage(): LauncherLanguage {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

export function useI18n(): {
  language: LauncherLanguage;
  t: (key: string, vars?: TranslateVars) => string;
} {
  const language = useLanguage();
  return useMemo(
    () => ({
      language,
      t: (key: string, vars?: TranslateVars) => translate(key, vars, language),
    }),
    [language],
  );
}
