/**
 * PCL2 (Plain Craft Launcher 2) 自定义主页兼容层。
 *
 * PCL2 的主页文件是 WPF 风格的 XAML：标准布局控件（Grid / StackPanel /
 * Border / TextBlock / Image …）加上 PCL 自己的 `local:` 控件（MyCard、
 * MyButton、MyHint、MyTextBox …），并且会用到 `{DynamicResource ColorBrushN}`
 * 主题资源、`{Binding ElementName=…,Path=…}` 元素绑定，以及按钮上的
 * `EventType` / `EventData` 动作。
 *
 * 本启动器的主页用 HTML 渲染，因此这里把社区主页实际用到的 XAML 子集翻译成
 * 一个自包含的 HTML 文档（内联样式 + 一段很小的运行时脚本）：
 *
 * - 布局：Grid（含 RowDefinitions/ColumnDefinitions、Grid.Row/Column/Span）、
 *   StackPanel、WrapPanel、DockPanel（按纵向近似）、Canvas、Border、
 *   ScrollViewer、UniformGrid（近似）；
 * - 文本与图形：TextBlock（Run / LineBreak / Hyperlink / Span）、Image、
 *   Rectangle、Ellipse、Path（SVG）、Line；
 * - 控件：Button、CheckBox、ComboBox、TextBox、TabControl / TabItem，
 *   以及 PCL 的 MyCard、MyButton、MyTextButton、MyHint、MyTextBox；
 * - 主题：`{DynamicResource …}` 映射到启动器当前的主题色阶；未识别的资源键
 *   退化为继承色，并在警告里列出；
 * - 绑定：`{Binding ElementName=…,Path=…}`（Text / IsChecked / SelectedIndex）
 *   由生成文档里的脚本在运行时同步；没有 ElementName 的绑定取运行时变量
 *   （玩家名、版本号等），未知路径替换为空串并给出警告；
 * - 动作：`EventType` 支持 打开网页 / 复制文本 / 刷新主页 / 启动游戏，
 *   其余动作会原样转发给启动器，由启动器提示“暂不支持”，而不是静默失效。
 *
 * 无法支持的部分（例如 PCL 内置控件的行为、TabControl 的部分属性、未收录的
 * 资源键）不会让渲染失败：元素被跳过或降级渲染，并通过 `warnings` 反馈，
 * 启动器会把它们显示在主页标题旁。
 */
import { getEffectivePrimaryColor, accentHue } from "./theme";

export interface PclHomepageContext {
  /** 启动器当前的强调色，用于 `{DynamicResource ColorBrush*}`。 */
  accent: string;
  /** 深色（true）/ 浅色（false）渲染。 */
  dark: boolean;
  /** 无 ElementName 的 `{Binding Path=…}` 取值。 */
  runtime?: Record<string, string>;
  /** 把相对主页文件的资源路径解析为 data URL（本地主页用）。 */
  resolveLocalResource?: (path: string) => Promise<string | null>;
  /** 相对地址的基准 URL（联网主页用）。 */
  baseHref?: string;
}

export interface PclHomepageResult {
  html: string;
  warnings: string[];
}

type Style = Record<string, string>;
type ParentAxis = "column" | "row" | "grid" | "canvas";

interface Palette {
  accent: string;
  accentFg: string;
  panel: string;
  card: string;
  border: string;
  fg: string;
  muted: string;
  hover: string;
}

/** WPF / PCL 控件名，用于把 XAML 与 HTML 片段区分开。 */
const XAML_ROOTS = new Set([
  "grid",
  "stackpanel",
  "wrappanel",
  "dockpanel",
  "canvas",
  "uniformgrid",
  "border",
  "scrollviewer",
  "viewbox",
  "textblock",
  "image",
  "rectangle",
  "ellipse",
  "path",
  "line",
  "button",
  "checkbox",
  "combobox",
  "textbox",
  "tabcontrol",
  "mycard",
  "mybutton",
  "mytextbutton",
  "myhint",
  "mytextbox",
]);

const NAMED_COLORS: Record<string, string> = {
  transparent: "transparent",
  black: "#000000",
  white: "#ffffff",
  gray: "#808080",
  grey: "#808080",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  silver: "#c0c0c0",
  red: "#ff0000",
  darkred: "#8b0000",
  orange: "#ffa500",
  gold: "#ffd700",
  yellow: "#ffff00",
  lime: "#00ff00",
  green: "#008000",
  seagreen: "#2e8b57",
  teal: "#008080",
  cyan: "#00ffff",
  skyblue: "#87ceeb",
  blue: "#0000ff",
  dodgerblue: "#1e90ff",
  navy: "#000080",
  purple: "#800080",
  violet: "#ee82ee",
  magenta: "#ff00ff",
  pink: "#ffc0cb",
  brown: "#a52a2a",
  chocolate: "#d2691e",
};

const FONT_STACK =
  '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, "PingFang SC", sans-serif';

// ---------------------------------------------------------------- 文本工具

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

/** Camel-case style key -> CSS property name. */
function cssProperty(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function styleText(style: Style): string {
  return Object.entries(style)
    .filter(([, value]) => value !== "" && value != null)
    .map(([key, value]) => `${cssProperty(key)}:${value}`)
    .join(";");
}

/** Trims a leading BOM / XML declaration / comments so the root tag is first. */
function stripPreamble(source: string): string {
  return source
    .replace(/^\uFEFF/, "")
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, "")
    .replace(/^\s*<!--[\s\S]*?-->\s*/g, "")
    .trimStart();
}

function rootTagName(source: string): string | null {
  const match = /<([A-Za-z_][\w.-]*(?::[\w.-]+)?)(?=[\s/>])/.exec(stripPreamble(source));
  if (!match) return null;
  const raw = match[1];
  const colon = raw.indexOf(":");
  return (colon >= 0 ? raw.slice(colon + 1) : raw).toLowerCase();
}

/**
 * True when the content is a PCL2 home page rather than a plain HTML document.
 * `.xaml` decides on its own; otherwise only a known WPF/PCL root element is
 * treated as XAML, so an ordinary HTML fragment keeps rendering as HTML.
 */
export function looksLikePclHomepage(source: string, pathOrUrl?: string): boolean {
  if (/\.[xX][aA][mM][lL](\?|#|$)/.test(pathOrUrl ?? "")) return true;
  const tag = rootTagName(source);
  if (!tag) return false;
  return XAML_ROOTS.has(tag);
}

/**
 * XAML copied out of tutorials often uses the `local:` prefix without the
 * matching `xmlns:local` declaration; a strict XML parser rejects that, so the
 * missing namespaces are filled in before parsing.
 */
function ensureNamespaces(source: string): string {
  const body = stripPreamble(source);
  const prefixes = new Set<string>();
  for (const match of body.matchAll(/<([A-Za-z_][\w.-]*):[\w.-]+/g)) {
    prefixes.add(match[1]);
  }
  if (prefixes.size === 0) return source;

  const declared = new Set<string>();
  for (const match of body.matchAll(/xmlns:([\w.-]+)=/g)) {
    declared.add(match[1]);
  }
  const missing = [...prefixes].filter((prefix) => !declared.has(prefix));
  if (missing.length === 0) return source;

  const declarations = missing
    .map((prefix) => `xmlns:${prefix}="urn:${prefix}"`)
    .join(" ");
  const rootStart = /<[A-Za-z_][\w.-]*(?::[\w.-]+)?/.exec(source);
  if (!rootStart || rootStart.index === undefined) return source;
  const insertAt = rootStart.index + rootStart[0].length;
  return `${source.slice(0, insertAt)} ${declarations}${source.slice(insertAt)}`;
}

// ---------------------------------------------------------------- 数值 / 颜色

function numberValue(value?: string | null): number | null {
  if (!value) return null;
  const match = /^(-?\d+(?:\.\d+)?)(px|pt)?$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  return match[2] === "pt" ? Math.round((amount * 96) / 72) : amount;
}

/** WPF `Thickness` -> [left, top, right, bottom]. */
function thickness(value?: string | null): [number, number, number, number] | null {
  if (!value) return null;
  const parts = value
    .split(",")
    .map((part) => numberValue(part))
    .filter((part): part is number => part !== null);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 4) return [parts[0], parts[1], parts[2], parts[3]];
  return null;
}

function marginText(box: [number, number, number, number]): string {
  return `${box[1]}px ${box[2]}px ${box[3]}px ${box[0]}px`;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb
    .map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Linear blend; `amount` 0 keeps `from`, 1 returns `to`. */
function mixHex(from: string, to: string, amount: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const t = Math.min(1, Math.max(0, amount));
  return rgbToHex([
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]);
}

function hsl(hue: number, saturation: number, lightness: number): string {
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

function buildPalette(accent: string, dark: boolean): Palette {
  const { color, fg } = getEffectivePrimaryColor({ customThemeColor: accent });
  const hue = accentHue(color);
  return dark
    ? {
        accent: color,
        accentFg: fg,
        panel: hsl(hue, 9, 5),
        card: hsl(hue, 9, 7.5),
        border: hsl(hue, 13, 17),
        fg: hsl(hue, 8, 93.5),
        muted: hsl(hue, 7, 64),
        hover: hsl(hue, 11, 12),
      }
    : {
        accent: color,
        accentFg: fg,
        panel: hsl(hue, 12, 97),
        card: hsl(hue, 10, 100),
        border: hsl(hue, 14, 86),
        fg: hsl(hue, 13, 12),
        muted: hsl(hue, 9, 42),
        hover: hsl(hue, 13, 91),
      };
}

// ---------------------------------------------------------------- 渲染器

class XamlHomepageRenderer {
  private warnings = new Set<string>();
  private ctx: PclHomepageContext;
  private palette: Palette;
  private resolveDynamic: (key: string) => string | null;
  private usedDynamic = new Set<string>();

  constructor(ctx: PclHomepageContext) {
    this.ctx = ctx;
    this.palette = buildPalette(ctx.accent, ctx.dark);
    this.resolveDynamic = (key) => this.dynamicResource(key);
  }

  async render(source: string): Promise<PclHomepageResult> {
    const document = new DOMParser().parseFromString(ensureNamespaces(source), "application/xml");
    const failure = document.getElementsByTagName("parsererror")[0];
    if (failure) {
      const detail = (failure.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      throw new Error(`XAML 解析失败${detail ? `：${detail}` : ""}`);
    }
    const body = await this.element(document.documentElement, "column");
    return { html: this.shell(body), warnings: [...this.warnings] };
  }

  // ------------------------------------------------------------ 主题 / 绑定

  /**
   * PCL 的颜色资源键只公开确认过 `ColorBrush` 与 `ColorBrush5`（`ColorBrushN`
   * 是主题色的深浅档位）。这里按档位近似成主题色与面板色的混合，未收录的键
   * 返回 null（继承父级颜色）并记入警告。
   */
  private dynamicResource(key: string): string | null {
    const clean = key.trim();
    const lower = clean.toLowerCase();
    this.usedDynamic.add(clean);
    if (lower === "colorbrush") return this.palette.accent;
    const numbered = /^colorbrush(\d+)$/.exec(lower);
    if (numbered) {
      const step = Math.min(9, Math.max(1, Number(numbered[1])));
      return mixHex(this.palette.panel, this.palette.accent, 0.12 + step * 0.1);
    }
    const gray = /^colorgray(\d+)$/.exec(lower);
    if (gray) {
      const step = Math.min(9, Math.max(1, Number(gray[1])));
      return mixHex(this.palette.panel, this.palette.fg, 0.2 + step * 0.08);
    }
    if (lower === "colorbrushback" || lower === "colortheme") return this.palette.accent;
    this.warnings.add(`未支持的主题资源 {DynamicResource ${clean}}`);
    return null;
  }

  private color(value?: string | null): string | null {
    if (!value) return null;
    const trimmed = value.trim();
    const dynamic = /^\{DynamicResource\s+([^}]+)\}$/i.exec(trimmed);
    if (dynamic) return this.resolveDynamic(dynamic[1].trim());
    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
      const [, r, g, b] = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(trimmed) ?? [];
      if (r) return `#${r}${r}${g}${g}${b}${b}`;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed;
    if (/^#[0-9a-fA-F]{8}$/.test(trimmed)) {
      // WPF 的八位写法是 #AARRGGBB，CSS 需要 rgba()。
      const alpha = parseInt(trimmed.slice(1, 3), 16) / 255;
      const r = parseInt(trimmed.slice(3, 5), 16);
      const g = parseInt(trimmed.slice(5, 7), 16);
      const b = parseInt(trimmed.slice(7, 9), 16);
      return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`;
    }
    return NAMED_COLORS[trimmed.toLowerCase()] ?? null;
  }

  private static parseMarkup(value: string): { name: string; args: string } | null {
    const match = /^\{\s*([A-Za-z]+)\s*([^}]*)\}$/.exec(value.trim());
    if (!match) return null;
    return { name: match[1].toLowerCase(), args: match[2] };
  }

  private binding(value?: string | null): { elementName?: string; path?: string } | null {
    if (!value) return null;
    const markup = XamlHomepageRenderer.parseMarkup(value);
    if (!markup || markup.name !== "binding") return null;
    const elementName = /ElementName\s*=\s*([^,\s}]+)/i.exec(markup.args)?.[1];
    const path = /Path\s*=\s*([^,\s}]+)/i.exec(markup.args)?.[1];
    return { elementName, path };
  }

  private textValue(value?: string | null): string {
    if (!value) return "";
    const binding = this.binding(value);
    if (binding) {
      if (binding.elementName) return ""; // 元素间绑定由运行时脚本处理。
      return this.runtimeValue(binding.path);
    }
    const markup = XamlHomepageRenderer.parseMarkup(value);
    if (markup?.name === "dynamicresource") {
      const resolved = this.resolveDynamic(markup.args.trim());
      return resolved ?? "";
    }
    return value;
  }

  private runtimeValue(path?: string): string {
    if (!path) return "";
    const runtime = this.ctx.runtime ?? {};
    const key = Object.keys(runtime).find((name) => name.toLowerCase() === path.toLowerCase());
    if (key) return runtime[key];
    this.warnings.add(`未支持的绑定 {Binding ${path}}`);
    return "";
  }

  // ------------------------------------------------------------ HTML 组装

  private shell(bodyHtml: string): string {
    const p = this.palette;
    const base = this.ctx.baseHref ? `<base href="${escapeAttr(this.ctx.baseHref)}" />` : "";
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
${base}
<style>
:root {
  --pcl-accent: ${p.accent};
  --pcl-accent-fg: ${p.accentFg};
  --pcl-panel: ${p.panel};
  --pcl-card: ${p.card};
  --pcl-border: ${p.border};
  --pcl-fg: ${p.fg};
  --pcl-muted: ${p.muted};
  --pcl-hover: ${p.hover};
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; min-height: 100%; }
body {
  padding: 16px;
  background: transparent;
  color: var(--pcl-fg);
  font: 400 13px/1.6 ${FONT_STACK};
  overflow-wrap: break-word;
  overflow-x: hidden;
}
img { max-width: 100%; }
a { color: var(--pcl-accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.pcl-card {
  border: 1px solid var(--pcl-border);
  border-radius: 10px;
  background: var(--pcl-card);
  overflow: hidden;
}
.pcl-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 500;
  border-bottom: 1px solid var(--pcl-border);
}
.pcl-card-head.is-collapsed { border-bottom: 0; }
.pcl-card-toggle {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--pcl-muted);
  cursor: pointer;
  font: inherit;
  padding: 2px 6px;
  border-radius: 6px;
}
.pcl-card-toggle:hover { background: var(--pcl-hover); color: var(--pcl-fg); }
.pcl-card-body { padding: 14px 16px; }
.pcl-card.is-collapsed .pcl-card-body { display: none; }
.pcl-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--pcl-border);
  border-radius: 8px;
  background: var(--pcl-hover);
  color: var(--pcl-fg);
  font: inherit;
  cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease;
}
.pcl-button:hover { border-color: var(--pcl-accent); }
.pcl-button:disabled { opacity: .45; cursor: not-allowed; }
.pcl-button.is-highlight {
  background: var(--pcl-accent);
  color: var(--pcl-accent-fg);
  border-color: transparent;
}
.pcl-button.is-danger { color: #e07363; border-color: rgba(224, 115, 99, .45); }
.pcl-button.is-text {
  border-color: transparent;
  background: transparent;
  color: var(--pcl-accent);
  padding: 4px 8px;
}
.pcl-button.is-text:hover { background: var(--pcl-hover); }
.pcl-hint {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--pcl-border);
  background: var(--pcl-hover);
  color: var(--pcl-muted);
  font-size: 12px;
}
.pcl-hint.is-warn { border-color: rgba(224, 115, 99, .45); color: #e07363; }
.pcl-input,
.pcl-select {
  padding: 5px 10px;
  border: 1px solid var(--pcl-border);
  border-radius: 8px;
  background: var(--pcl-panel);
  color: var(--pcl-fg);
  font: inherit;
  outline: none;
}
.pcl-input:focus, .pcl-select:focus { border-color: var(--pcl-accent); }
.pcl-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.pcl-check input { accent-color: var(--pcl-accent); }
.pcl-tab-bar { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--pcl-border); padding-bottom: 6px; }
.pcl-tab {
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--pcl-muted);
  font: inherit;
  padding: 4px 12px;
  cursor: pointer;
}
.pcl-tab:hover { background: var(--pcl-hover); color: var(--pcl-fg); }
.pcl-tab.is-active { background: var(--pcl-hover); border-color: var(--pcl-border); color: var(--pcl-fg); }
.pcl-tab-panel { display: none; }
.pcl-tab-panel.is-active { display: block; }
.pcl-unsupported { color: var(--pcl-muted); font-style: italic; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--pcl-border); border-radius: 6px; }
::-webkit-scrollbar-thumb:hover { background: var(--pcl-muted); }
</style>
</head>
<body>
${bodyHtml}
<script>
(function () {
  var doc = document;
  function post(payload) {
    payload.source = "pcl-homepage";
    try { parent.postMessage(payload, "*"); } catch (error) {}
  }
  function readValue(el) {
    if (!el) return "";
    if (el.tagName === "SELECT") return el.value;
    if (el.type === "checkbox") return el.checked ? "true" : "false";
    if (el.value != null) return el.value;
    return el.textContent || "";
  }
  function eventData(target) {
    var from = target.getAttribute("data-pcl-event-data-from");
    if (from) {
      var source = doc.getElementById(from);
      var prop = target.getAttribute("data-pcl-event-data-prop") || "Text";
      if (source && prop === "SelectedIndex") {
        return String(source.selectedIndex != null ? source.selectedIndex : 0);
      }
      if (source && prop === "IsChecked") {
        return source.checked ? "true" : "false";
      }
      return readValue(source);
    }
    return target.getAttribute("data-pcl-event-data") || "";
  }
  function activateTabs(group, index) {
    var tabs = group.querySelectorAll("[data-pcl-tab-index]");
    var panels = group.querySelectorAll("[data-pcl-tab-panel]");
    var i;
    for (i = 0; i < tabs.length; i++) tabs[i].classList.toggle("is-active", i === index);
    for (i = 0; i < panels.length; i++) panels[i].classList.toggle("is-active", i === index);
  }
  // PCL 主页里的右键交给启动器：菜单在启动器窗口的指针位置弹出。
  doc.addEventListener("contextmenu", function (event) {
    event.preventDefault();
    post({ type: "contextmenu", x: event.clientX, y: event.clientY });
  });
  doc.addEventListener("click", function (event) {
    var node = event.target;
    if (!node || !node.closest) return;
    var anchor = node.closest("a[data-pcl-href]");
    if (anchor) {
      event.preventDefault();
      post({ type: "event", eventType: "打开网页", eventData: anchor.getAttribute("data-pcl-href") });
      return;
    }
    var tab = node.closest("[data-pcl-tab-index]");
    if (tab) {
      var group = tab.closest("[data-pcl-tabs]");
      if (group) activateTabs(group, Number(tab.getAttribute("data-pcl-tab-index")) || 0);
      return;
    }
    var toggle = node.closest("[data-pcl-card-toggle]");
    if (toggle) {
      var card = toggle.closest(".pcl-card");
      if (card) {
        card.classList.toggle("is-collapsed");
        var head = card.querySelector(".pcl-card-head");
        if (head) head.classList.toggle("is-collapsed");
        toggle.textContent = card.classList.contains("is-collapsed") ? "▸" : "▾";
      }
      return;
    }
    var button = node.closest("[data-pcl-event]");
    if (!button || button.disabled) return;
    post({
      type: "event",
      eventType: button.getAttribute("data-pcl-event") || "",
      eventData: eventData(button),
    });
  });
  // {Binding ElementName=…,Path=SelectedIndex}
  Array.prototype.forEach.call(doc.querySelectorAll("[data-bind-selected-index]"), function (target) {
    var source = doc.getElementById(target.getAttribute("data-bind-selected-index"));
    if (!source) return;
    function sync() {
      var index = Number(source.selectedIndex != null ? source.selectedIndex : source.value) || 0;
      if (target.hasAttribute("data-pcl-tabs")) activateTabs(target, index);
      else if (target.tagName === "SELECT") target.selectedIndex = index;
    }
    source.addEventListener("change", sync);
    sync();
  });
  // {Binding ElementName=…,Path=IsChecked} -> IsEnabled
  Array.prototype.forEach.call(doc.querySelectorAll("[data-bind-is-enabled]"), function (target) {
    var source = doc.getElementById(target.getAttribute("data-bind-is-enabled"));
    if (!source) return;
    function sync() {
      target.disabled = source.checked === false;
      target.style.opacity = source.checked === false ? "0.45" : "";
    }
    source.addEventListener("change", sync);
    sync();
  });
  // {Binding ElementName=…,Path=Text}
  Array.prototype.forEach.call(doc.querySelectorAll("[data-bind-text]"), function (target) {
    var source = doc.getElementById(target.getAttribute("data-bind-text"));
    if (!source) return;
    function sync() {
      var text = readValue(source);
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") target.value = text;
      else target.textContent = text;
    }
    source.addEventListener("input", sync);
    source.addEventListener("change", sync);
    sync();
  });
})();
</script>
</body>
</html>`;
  }

  private serialize(tag: string, style: Style, attrs: Record<string, string>, children: string): string {
    const styleValue = styleText(style);
    const attrText = Object.entries(attrs)
      // Empty values are kept: `data-pcl-tabs=""` is how a flag is expressed.
      .filter(([, value]) => value != null)
      .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
      .join("");
    const styleAttr = styleValue ? ` style="${escapeAttr(styleValue)}"` : "";
    return `<${tag}${attrText}${styleAttr}>${children}</${tag}>`;
  }

  private serializeSelfClosing(
    tag: string,
    style: Style,
    attrs: Record<string, string>,
  ): string {
    const styleValue = styleText(style);
    const attrText = Object.entries(attrs)
      .filter(([, value]) => value != null)
      .map(([key, value]) => ` ${key}="${escapeAttr(value ?? "")}"`)
      .join("");
    const styleAttr = styleValue ? ` style="${escapeAttr(styleValue)}"` : "";
    return `<${tag}${attrText}${styleAttr} />`;
  }

  // ------------------------------------------------------------ 公共属性

  private applyBox(node: Element, style: Style, attrs: Record<string, string>, parent: ParentAxis): void {
    const margin = thickness(node.getAttribute("Margin"));
    if (margin) style.margin = marginText(margin);
    const width = numberValue(node.getAttribute("Width"));
    if (width !== null) style.width = `${width}px`;
    const height = numberValue(node.getAttribute("Height"));
    if (height !== null) style.height = `${height}px`;
    const minWidth = numberValue(node.getAttribute("MinWidth"));
    if (minWidth !== null) style.minWidth = `${minWidth}px`;
    const minHeight = numberValue(node.getAttribute("MinHeight"));
    if (minHeight !== null) style.minHeight = `${minHeight}px`;
    const maxWidth = numberValue(node.getAttribute("MaxWidth"));
    if (maxWidth !== null) style.maxWidth = `${maxWidth}px`;
    const maxHeight = numberValue(node.getAttribute("MaxHeight"));
    if (maxHeight !== null) style.maxHeight = `${maxHeight}px`;
    const opacity = numberValue(node.getAttribute("Opacity"));
    if (opacity !== null) style.opacity = String(opacity);
    const background = this.color(node.getAttribute("Background"));
    if (background) style.background = background;

    const horizontal = (node.getAttribute("HorizontalAlignment") ?? "").trim().toLowerCase();
    const vertical = (node.getAttribute("VerticalAlignment") ?? "").trim().toLowerCase();
    const alignSelfValue = (value: string): string | null => {
      if (value === "left") return "flex-start";
      if (value === "right" || value === "center") return value === "right" ? "flex-end" : "center";
      if (value === "top") return "flex-start";
      if (value === "bottom") return "flex-end";
      if (value === "stretch") return "stretch";
      return null;
    };
    if (parent === "column") {
      const self = alignSelfValue(horizontal);
      if (self) style.alignSelf = self;
    } else if (parent === "row") {
      const self = alignSelfValue(vertical);
      if (self) style.alignSelf = self;
    } else if (parent === "grid") {
      const justifySelf = alignSelfValue(horizontal);
      const alignItemSelf = alignSelfValue(vertical);
      if (justifySelf) style.justifySelf = justifySelf;
      if (alignItemSelf) style.alignSelf = alignItemSelf;
    }

    const name = (node.getAttribute("Name") ?? node.getAttribute("x:Name") ?? "").trim();
    if (name) attrs.id = name;
    const tooltip = node.getAttribute("ToolTip");
    if (tooltip) attrs.title = this.textValue(tooltip);
  }

  private gridPlacement(node: Element, style: Style): void {
    const row = numberValue(node.getAttribute("Grid.Row"));
    const column = numberValue(node.getAttribute("Grid.Column"));
    const rowSpan = numberValue(node.getAttribute("Grid.RowSpan"));
    const columnSpan = numberValue(node.getAttribute("Grid.ColumnSpan"));
    if (row !== null) {
      const span = rowSpan && rowSpan > 1 ? ` / span ${rowSpan}` : "";
      style.gridRow = `${Math.max(0, Math.round(row)) + 1}${span}`;
    }
    if (column !== null) {
      const span = columnSpan && columnSpan > 1 ? ` / span ${columnSpan}` : "";
      style.gridColumn = `${Math.max(0, Math.round(column)) + 1}${span}`;
    }
  }

  private foregroundStyle(node: Element, style: Style): void {
    const color = this.color(node.getAttribute("Foreground"));
    if (color) style.color = color;
    const size = numberValue(node.getAttribute("FontSize"));
    if (size !== null) style.fontSize = `${size}px`;
    const weight = this.fontWeight(node.getAttribute("FontWeight"));
    if (weight) style.fontWeight = weight;
    const fontFamily = (node.getAttribute("FontFamily") ?? "").trim();
    if (fontFamily) {
      const family = fontFamily.split(",")[0].replace(/^"|"$/g, "");
      if (/minecraft/i.test(family)) {
        style.fontFamily = 'var(--font-pixel, "Silkscreen"), monospace';
      } else if (/yahei|微软雅黑|segoe|system/i.test(family)) {
        style.fontFamily = FONT_STACK;
      }
    }
    const alignment = (node.getAttribute("TextAlignment") ?? "").trim().toLowerCase();
    if (alignment) style.textAlign = alignment === "justify" ? "justify" : alignment;
    const lineHeight = numberValue(node.getAttribute("LineHeight"));
    if (lineHeight !== null) style.lineHeight = `${Math.round(lineHeight * 1.4)}px`;
  }

  private fontWeight(value?: string | null): string | null {
    if (!value) return null;
    const named = value.trim().toLowerCase();
    const table: Record<string, string> = {
      thin: "200",
      extralight: "200",
      light: "300",
      normal: "400",
      regular: "400",
      medium: "500",
      semibold: "600",
      demibold: "600",
      bold: "700",
      extrabold: "800",
      black: "900",
      heavy: "900",
    };
    if (table[named]) return table[named];
    const numeric = numberValue(value);
    return numeric !== null ? String(Math.round(numeric)) : null;
  }

  // ------------------------------------------------------------ 元素分发

  private async children(node: Element, parent: ParentAxis): Promise<string[]> {
    const output: string[] = [];
    for (const child of Array.from(node.children)) {
      output.push(await this.element(child, parent));
    }
    return output;
  }

  private async element(node: Element, parent: ParentAxis): Promise<string> {
    const name = (node.localName ?? node.tagName.split(":").pop()!).toLowerCase();
    const style: Style = {};
    const attrs: Record<string, string> = {};
    this.applyBox(node, style, attrs, parent);
    if (parent === "grid") this.gridPlacement(node, style);

    switch (name) {
      case "grid":
        return this.grid(node, style, attrs);
      case "stackpanel":
        return this.stackPanel(node, style, attrs);
      case "wrappanel": {
        const children = await this.children(node, "row");
        style.display = "flex";
        style.flexWrap = "wrap";
        return this.serialize("div", style, attrs, children.join(""));
      }
      case "dockpanel": {
        this.warnings.add("DockPanel 按纵向堆叠近似渲染");
        const children = await this.children(node, "column");
        style.display = "flex";
        style.flexDirection = "column";
        return this.serialize("div", style, attrs, children.join(""));
      }
      case "uniformgrid": {
        const columns = numberValue(node.getAttribute("Columns")) ?? 2;
        style.display = "grid";
        style.gridTemplateColumns = `repeat(${Math.max(1, Math.round(columns))}, 1fr)`;
        const children = await this.children(node, "grid");
        return this.serialize("div", style, attrs, children.join(""));
      }
      case "canvas": {
        style.position = "relative";
        const children: string[] = [];
        for (const child of Array.from(node.children)) {
          const left = numberValue(child.getAttribute("Canvas.Left"));
          const top = numberValue(child.getAttribute("Canvas.Top"));
          const html = await this.element(child, "canvas");
          if (left === null && top === null) {
            children.push(html);
            continue;
          }
          children.push(
            `<div style="position:absolute;left:${left ?? 0}px;top:${top ?? 0}px">${html}</div>`,
          );
        }
        return this.serialize("div", style, attrs, children.join(""));
      }
      case "border": {
        const background = this.color(node.getAttribute("Background"));
        if (background) style.background = background;
        const brush = this.color(node.getAttribute("BorderBrush"));
        const borderThickness = thickness(node.getAttribute("BorderThickness"));
        if (brush && borderThickness) {
          style.border = `${Math.max(...borderThickness)}px solid ${brush}`;
        }
        const radius = thickness(node.getAttribute("CornerRadius"));
        if (radius) style.borderRadius = `${radius[1]}px`;
        const padding = thickness(node.getAttribute("Padding"));
        if (padding) style.padding = marginText(padding);
        const children = await this.children(node, "column");
        return this.serialize("div", style, attrs, children.join(""));
      }
      case "scrollviewer": {
        style.overflow = "auto";
        style.maxHeight = "100%";
        const padding = thickness(node.getAttribute("Padding"));
        if (padding) style.padding = marginText(padding);
        const children = await this.children(node, "column");
        return this.serialize("div", style, attrs, children.join(""));
      }
      case "viewbox": {
        const children = await this.children(node, "column");
        return this.serialize("div", style, attrs, children.join(""));
      }
      case "textblock":
        return this.textBlock(node, style, attrs);
      case "run":
      case "span": {
        const color = this.color(node.getAttribute("Foreground"));
        if (color) style.color = color;
        const weight = this.fontWeight(node.getAttribute("FontWeight"));
        if (weight) style.fontWeight = weight;
        return this.serialize("span", style, attrs, escapeText(this.textValue(node.getAttribute("Text"))));
      }
      case "linebreak":
        return "<br />";
      case "hyperlink": {
        const uri = node.getAttribute("NavigateUri") ?? "";
        const text = this.textValue(node.getAttribute("Text")) || (node.textContent ?? "").trim();
        if (uri) attrs["data-pcl-href"] = this.textValue(uri);
        attrs.href = uri ? this.textValue(uri) : "#";
        return this.serialize("a", style, attrs, escapeText(text));
      }
      case "image":
        return this.image(node, style, attrs);
      case "rectangle": {
        const fill = this.color(node.getAttribute("Fill"));
        const stroke = this.color(node.getAttribute("Stroke"));
        const strokeThickness = numberValue(node.getAttribute("StrokeThickness"));
        if (fill) style.background = fill;
        if (stroke) style.border = `${strokeThickness ?? 1}px solid ${stroke}`;
        const radiusX = numberValue(node.getAttribute("RadiusX")) ?? numberValue(node.getAttribute("RadiusY")) ?? 0;
        if (radiusX) style.borderRadius = `${radiusX}px`;
        return this.serializeSelfClosing("div", style, attrs);
      }
      case "ellipse": {
        const fill = this.color(node.getAttribute("Fill"));
        const stroke = this.color(node.getAttribute("Stroke"));
        if (fill) style.background = fill;
        if (stroke) style.border = `${numberValue(node.getAttribute("StrokeThickness")) ?? 1}px solid ${stroke}`;
        style.borderRadius = "50%";
        return this.serializeSelfClosing("div", style, attrs);
      }
      case "line": {
        const stroke = this.color(node.getAttribute("Stroke")) ?? this.palette.border;
        style.background = stroke;
        style.height = style.height ?? "1px";
        return this.serializeSelfClosing("div", style, attrs);
      }
      case "path":
        return this.path(node, style, attrs);
      case "button":
        return this.button(node, style, attrs, false);
      case "checkbox":
        return this.checkBox(node, style, attrs);
      case "combobox":
        return this.comboBox(node, style, attrs);
      case "textbox":
        return this.textBox(node, style, attrs);
      case "tabcontrol":
        return this.tabControl(node, style, attrs);
      case "tabitem": {
        // 直接出现的 TabItem 当作普通分块渲染。
        const children = await this.children(node, "column");
        return this.serialize("div", style, attrs, children.join(""));
      }
      case "comboboxitem":
        return this.serialize("div", style, attrs, escapeText(this.textValue(node.getAttribute("Content"))));
      case "mycard":
        return this.myCard(node, style, attrs);
      case "mybutton":
        return this.button(node, style, attrs, true);
      case "mytextbutton":
        return this.button(node, style, attrs, true, true);
      case "myhint": {
        const warn = /true/i.test(node.getAttribute("IsWarn") ?? "");
        attrs.class = warn ? "pcl-hint is-warn" : "pcl-hint";
        return this.serialize("div", style, attrs, escapeText(this.textValue(node.getAttribute("Text"))));
      }
      case "mytextbox":
        return this.textBox(node, style, attrs, true);
      case "rowdefinition":
      case "columndefinition":
      case "grid.rowdefinitions":
      case "grid.columndefinitions":
      case "tabitem.header":
        return "";
      default: {
        this.warnings.add(`未支持的元素 <${node.tagName}> 已跳过`);
        const children = await this.children(node, "column");
        return this.serialize("div", style, attrs, children.join(""));
      }
    }
  }

  // ------------------------------------------------------------ 布局容器

  private async grid(node: Element, style: Style, attrs: Record<string, string>): Promise<string> {
    const columns: string[] = [];
    const rows: string[] = [];
    for (const child of Array.from(node.children)) {
      const childName = (child.localName ?? child.tagName).toLowerCase();
      if (childName === "grid.columndefinitions" || childName === "columndefinitions") {
        for (const definition of Array.from(child.children)) {
          columns.push(this.gridTrack(definition.getAttribute("Width")));
        }
      } else if (childName === "grid.rowdefinitions" || childName === "rowdefinitions") {
        for (const definition of Array.from(child.children)) {
          rows.push(this.gridTrack(definition.getAttribute("Height")));
        }
      }
    }

    const content: string[] = [];
    let widestColumn = columns.length;
    let tallestRow = rows.length;
    for (const child of Array.from(node.children)) {
      const childName = (child.localName ?? child.tagName).toLowerCase();
      if (childName.includes("definition")) continue;
      widestColumn = Math.max(
        widestColumn,
        Math.round(numberValue(child.getAttribute("Grid.Column")) ?? 0) + 1,
      );
      tallestRow = Math.max(
        tallestRow,
        Math.round(numberValue(child.getAttribute("Grid.Row")) ?? 0) + 1,
      );
      content.push(await this.element(child, "grid"));
    }

    while (columns.length < widestColumn) columns.push("auto");
    while (rows.length < tallestRow) rows.push("auto");
    style.display = "grid";
    style.gridTemplateColumns = columns.length > 0 ? columns.join(" ") : "auto";
    if (rows.length > 0) style.gridTemplateRows = rows.join(" ");
    style.alignItems = "stretch";
    const columnSpacing = numberValue(node.getAttribute("ColumnSpacing"));
    if (columnSpacing !== null) style.columnGap = `${columnSpacing}px`;
    const rowSpacing = numberValue(node.getAttribute("RowSpacing"));
    if (rowSpacing !== null) style.rowGap = `${rowSpacing}px`;
    return this.serialize("div", style, attrs, content.join(""));
  }

  private gridTrack(value?: string | null): string {
    if (!value) return "auto";
    const trimmed = value.trim();
    const star = /^(\d+(?:\.\d+)?)?\*$/.exec(trimmed);
    if (star) return star[1] ? `${star[1]}fr` : "1fr";
    if (/^auto$/i.test(trimmed)) return "auto";
    const pixels = numberValue(trimmed);
    return pixels !== null ? `${pixels}px` : "auto";
  }

  private async stackPanel(node: Element, style: Style, attrs: Record<string, string>): Promise<string> {
    const horizontal = /horizontal/i.test(node.getAttribute("Orientation") ?? "");
    style.display = "flex";
    style.flexDirection = horizontal ? "row" : "column";
    if (horizontal) style.flexWrap = "wrap";
    const children = await this.children(node, horizontal ? "row" : "column");
    const spacing = numberValue(node.getAttribute("Spacing"));
    if (spacing !== null) style.gap = `${spacing}px`;
    return this.serialize("div", style, attrs, children.join(""));
  }

  // ------------------------------------------------------------ 文本与媒体

  private async textBlock(node: Element, style: Style, attrs: Record<string, string>): Promise<string> {
    this.foregroundStyle(node, style);
    const wrapping = (node.getAttribute("TextWrapping") ?? "").trim().toLowerCase();
    style.whiteSpace = wrapping === "nowrap" ? "nowrap" : "pre-wrap";
    const text = node.getAttribute("Text");
    let content: string;
    if (text !== null) {
      content = escapeText(this.textValue(text));
    } else {
      const parts: string[] = [];
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) {
          const value = (child.textContent ?? "").trim();
          if (value) parts.push(escapeText(value));
          continue;
        }
        if (child.nodeType !== 1) continue;
        const element = child as Element;
        const name = (element.localName ?? element.tagName).toLowerCase();
        if (name === "linebreak") {
          parts.push("<br />");
        } else if (name === "run" || name === "span") {
          const runStyle: Style = {};
          const runAttrs: Record<string, string> = {};
          this.foregroundStyle(element, runStyle);
          parts.push(this.serialize("span", runStyle, runAttrs, escapeText(this.textValue(element.getAttribute("Text")))));
        } else if (name === "hyperlink") {
          const uri = this.textValue(element.getAttribute("NavigateUri"));
          const label = this.textValue(element.getAttribute("Text")) || (element.textContent ?? "").trim();
          parts.push(
            this.serialize(
              "a",
              {},
              uri ? { href: uri, "data-pcl-href": uri } : { href: "#" },
              escapeText(label),
            ),
          );
        } else {
          parts.push(await this.element(element, "column"));
        }
      }
      content = parts.join("");
    }
    return this.serialize("div", style, attrs, content);
  }

  private async image(node: Element, style: Style, attrs: Record<string, string>): Promise<string> {
    const source = this.textValue(node.getAttribute("Source")).trim();
    const stretch = (node.getAttribute("Stretch") ?? "").trim().toLowerCase();
    const objectFit =
      stretch === "fill"
        ? "fill"
        : stretch === "uniformtofill"
          ? "cover"
          : stretch === "none"
            ? "none"
            : "contain";
    style.objectFit = objectFit;

    if (!source) {
      this.warnings.add("发现没有 Source 的 <Image>");
      return this.serializeSelfClosing("div", style, attrs);
    }

    let resolved = source;
    const isRemote = /^(https?:|data:|about:)/i.test(source);
    if (!isRemote && this.ctx.resolveLocalResource) {
      const dataUrl = await this.ctx.resolveLocalResource(source);
      if (dataUrl) {
        resolved = dataUrl;
      } else {
        this.warnings.add(`无法读取本地图片 ${source}`);
        return this.serializeSelfClosing("div", style, attrs);
      }
    } else if (!isRemote && !this.ctx.baseHref) {
      this.warnings.add(`无法读取本地图片 ${source}`);
      return this.serializeSelfClosing("div", style, attrs);
    }

    attrs.src = resolved;
    attrs.alt = "";
    attrs.loading = "lazy";
    attrs.decoding = "async";
    return this.serializeSelfClosing("img", style, attrs);
  }

  private path(node: Element, style: Style, attrs: Record<string, string>): string {
    const data = (node.getAttribute("Data") ?? "").trim();
    if (!data) return "";
    const fill = this.color(node.getAttribute("Fill")) ?? "currentColor";
    const stroke = this.color(node.getAttribute("Stroke"));
    const strokeWidth = numberValue(node.getAttribute("StrokeThickness"));
    const width = numberValue(node.getAttribute("Width")) ?? 24;
    const height = numberValue(node.getAttribute("Height")) ?? 24;
    style.width = `${width}px`;
    style.height = `${height}px`;
    style.display = "block";
    const pathAttrs = [
      `d="${escapeAttr(data)}"`,
      `fill="${escapeAttr(fill)}"`,
      stroke ? `stroke="${escapeAttr(stroke)}"` : "",
      stroke ? `stroke-width="${strokeWidth ?? 1}"` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return this.serialize(
      "svg",
      style,
      { ...attrs, viewBox: `0 0 ${Math.max(width, 24)} ${Math.max(height, 24)}` },
      `<path ${pathAttrs} />`,
    );
  }

  // ------------------------------------------------------------ 交互控件

  private async button(
    node: Element,
    style: Style,
    attrs: Record<string, string>,
    isPcl: boolean,
    isText = false,
  ): Promise<string> {
    this.foregroundStyle(node, style);
    const colorType = (node.getAttribute("ColorType") ?? "").trim().toLowerCase();
    const classes = ["pcl-button"];
    if (isText) classes.push("is-text");
    if (colorType === "highlight") classes.push("is-highlight");
    if (colorType === "red" || colorType === "danger") classes.push("is-danger");
    attrs.class = classes.join(" ");
    if (!style.padding) style.padding = "6px 14px";

    const eventType = node.getAttribute("EventType");
    const eventData = node.getAttribute("EventData");
    if (eventType) attrs["data-pcl-event"] = this.textValue(eventType);
    if (eventData) {
      const binding = this.binding(eventData);
      if (binding) {
        if (binding.elementName) {
          attrs["data-pcl-event-data-from"] = binding.elementName;
          attrs["data-pcl-event-data-prop"] = binding.path ?? "Text";
        }
      } else {
        attrs["data-pcl-event-data"] = this.textValue(eventData);
      }
    } else if (eventType) {
      attrs["data-pcl-event-data"] = "";
    }
    if (!isPcl && !eventType) {
      // 标准 WPF Button 的行为来自代码后端，无法在浏览器里执行。
      attrs["data-pcl-event"] = "标准按钮";
    }

    const enabled = node.getAttribute("IsEnabled");
    const enabledBinding = this.binding(enabled);
    if (enabledBinding?.elementName) {
      attrs["data-bind-is-enabled"] = enabledBinding.elementName;
    } else if (enabled && /false/i.test(enabled)) {
      attrs.disabled = "disabled";
    }

    const content = node.getAttribute("Text") ?? node.getAttribute("Content");
    const label = content !== null ? this.textValue(content) : (node.textContent ?? "").trim();
    attrs.type = "button";
    return this.serialize("button", style, attrs, escapeText(label));
  }

  private checkBox(node: Element, style: Style, attrs: Record<string, string>): string {
    const checked = /true/i.test(node.getAttribute("IsChecked") ?? "");
    const label = this.textValue(node.getAttribute("Content")) || (node.textContent ?? "").trim();
    attrs.class = "pcl-check";
    return this.serialize(
      "label",
      style,
      attrs,
      `${this.serializeSelfClosing("input", {}, { type: "checkbox", ...(checked ? { checked: "checked" } : {}) })}<span>${escapeText(label)}</span>`,
    );
  }

  private comboBox(node: Element, style: Style, attrs: Record<string, string>): string {
    const options: string[] = [];
    for (const child of Array.from(node.children)) {
      const name = (child.localName ?? child.tagName).toLowerCase();
      if (name !== "comboboxitem") continue;
      const label = this.textValue(child.getAttribute("Content")) || (child.textContent ?? "").trim();
      options.push(this.serialize("option", {}, {}, escapeText(label)));
    }
    const index = numberValue(node.getAttribute("SelectedIndex")) ?? 0;
    const selected = this.binding(node.getAttribute("SelectedIndex"));
    if (selected?.elementName) attrs["data-bind-selected-index"] = selected.elementName;
    const itemText = options
      .map((option, position) => (position === index ? option.replace("<option", "<option selected") : option))
      .join("");
    attrs.class = "pcl-select";
    return this.serialize("select", style, attrs, itemText);
  }

  private textBox(node: Element, style: Style, attrs: Record<string, string>, isPcl = false): string {
    this.foregroundStyle(node, style);
    attrs.class = "pcl-input";
    if (!style.padding) style.padding = "5px 10px";
    const value = node.getAttribute("Text");
    if (value) attrs.value = this.textValue(value);
    const textBinding = this.binding(value);
    if (textBinding?.elementName) attrs["data-bind-text"] = textBinding.elementName;
    const acceptsReturn = /true/i.test(node.getAttribute("AcceptsReturn") ?? "");
    if (isPcl) style.minWidth = style.minWidth ?? "160px";
    if (!acceptsReturn) attrs.type = "text";
    return this.serializeSelfClosing(acceptsReturn ? "textarea" : "input", style, attrs);
  }

  private async tabControl(node: Element, style: Style, attrs: Record<string, string>): Promise<string> {
    const items = Array.from(node.children).filter(
      (child) => (child.localName ?? child.tagName).toLowerCase() === "tabitem",
    );
    if (items.length === 0) {
      const children = await this.children(node, "column");
      return this.serialize("div", style, attrs, children.join(""));
    }
    const selected = this.binding(node.getAttribute("SelectedIndex"));
    const initial = Math.max(0, Math.round(numberValue(node.getAttribute("SelectedIndex")) ?? 0));
    const tabs: string[] = [];
    const panels: string[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const headerAttribute = item.getAttribute("Header");
      const headerElement = Array.from(item.children).find(
        (child) => (child.localName ?? child.tagName).toLowerCase() === "tabitem.header",
      );
      const header =
        this.textValue(headerAttribute) || (headerElement?.textContent ?? "").trim() || `标签 ${index + 1}`;
      const style2: Style = {};
      const attrs2: Record<string, string> = {};
      this.applyBox(item, style2, attrs2, "column");
      const inner = await this.children(item, "column");
      const bodyStyle: Style = { padding: "10px 2px" };
      tabs.push(
        this.serialize(
          "button",
          {},
          {
            type: "button",
            class: `pcl-tab${index === initial ? " is-active" : ""}`,
            "data-pcl-tab-index": String(index),
          },
          escapeText(header),
        ),
      );
      panels.push(
        this.serialize(
          "div",
          { ...style2, ...bodyStyle },
          { class: `pcl-tab-panel${index === initial ? " is-active" : ""}`, "data-pcl-tab-panel": String(index) },
          inner.join(""),
        ),
      );
    }
    style.display = "flex";
    style.flexDirection = "column";
    attrs["data-pcl-tabs"] = "";
    if (selected?.elementName) attrs["data-bind-selected-index"] = selected.elementName;
    const bar = this.serialize("div", {}, { class: "pcl-tab-bar" }, tabs.join(""));
    const body = this.serialize("div", {}, { class: "pcl-tab-body" }, panels.join(""));
    return this.serialize("div", style, attrs, `${bar}${body}`);
  }

  // ------------------------------------------------------------ PCL 控件

  private async myCard(node: Element, style: Style, attrs: Record<string, string>): Promise<string> {
    attrs.class = "pcl-card";
    const canSwap = /true/i.test(node.getAttribute("CanSwap") ?? "");
    const swapped = /true/i.test(node.getAttribute("IsSwaped") ?? "");
    if (swapped) attrs.class = "pcl-card is-collapsed";
    const title = this.textValue(node.getAttribute("Title"));
    const padding = thickness(node.getAttribute("Padding"));
    const head = title
      ? this.serialize(
          "div",
          {},
          { class: `pcl-card-head${swapped ? " is-collapsed" : ""}` },
          `${escapeText(title)}${
            canSwap
              ? this.serialize(
                  "button",
                  {},
                  { type: "button", class: "pcl-card-toggle", "data-pcl-card-toggle": "" },
                  swapped ? "▸" : "▾",
                )
              : ""
          }`,
        )
      : "";
    const bodyStyle: Style = {};
    if (padding) bodyStyle.padding = marginText(padding);
    const children = await this.children(node, "column");
    const body = this.serialize("div", bodyStyle, { class: "pcl-card-body" }, children.join(""));
    return this.serialize("section", style, attrs, `${head}${body}`);
  }
}

/**
 * Render a PCL2 home page (XAML) into a self-contained HTML document.
 * Throws when the XAML cannot be parsed at all.
 */
export async function renderPclHomepage(
  source: string,
  ctx: PclHomepageContext,
): Promise<PclHomepageResult> {
  return new XamlHomepageRenderer(ctx).render(source);
}
