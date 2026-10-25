import type { LauncherSettings, ThemeColorPreset } from "./types";

export interface ThemePresetInfo {
  id: Exclude<ThemeColorPreset, "custom">;
  label: string;
  name: string;
  color: string;
  fg: string;
  description: string;
}

export const THEME_COLOR_PRESETS: ThemePresetInfo[] = [
  {
    id: "emerald",
    label: "绿宝石",
    name: "Emerald",
    color: "#9bdd6b",
    fg: "#0b1408",
    description: "经典 Minecraft 原生翠绿，护眼清新",
  },
  {
    id: "sapphire",
    label: "群青蓝",
    name: "Sapphire",
    color: "#38bdf8",
    fg: "#081420",
    description: "青空与深邃海洋，现代极客风格",
  },
  {
    id: "amethyst",
    label: "紫水晶",
    name: "Amethyst",
    color: "#c084fc",
    fg: "#150820",
    description: "紫晶裂隙与下界之影，神秘幽雅",
  },
  {
    id: "blaze",
    label: "烈焰橙",
    name: "Blaze",
    color: "#fb923c",
    fg: "#1f0b03",
    description: "岩浆与烈焰核心，明亮热烈",
  },
  {
    id: "ruby",
    label: "红石绯",
    name: "Ruby",
    color: "#f43f5e",
    fg: "#1f050b",
    description: "红石能量与宝石光泽，醒目炽诚",
  },
  {
    id: "gold",
    label: "纯金锭",
    name: "Gold",
    color: "#facc15",
    fg: "#1c1503",
    description: "下界黄金与日光微尘，璀璨华丽",
  },
  {
    id: "prismarine",
    label: "海晶石",
    name: "Prismarine",
    color: "#2dd4bf",
    fg: "#031815",
    description: "海底遗迹与青碧水波，温润通透",
  },
];

export function getEffectivePrimaryColor(settings: LauncherSettings): { color: string; fg: string } {
  if (settings.themeColor === "custom" && settings.customThemeColor) {
    const hex = settings.customThemeColor;
    const cleanHex = hex.startsWith("#") ? hex.slice(1) : hex;
    const r = parseInt(cleanHex.slice(0, 2) || "ff", 16);
    const g = parseInt(cleanHex.slice(2, 4) || "ff", 16);
    const b = parseInt(cleanHex.slice(4, 6) || "ff", 16);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    const fg = brightness > 150 ? "#0b1408" : "#ffffff";
    return { color: hex, fg };
  }
  const preset = THEME_COLOR_PRESETS.find((p) => p.id === settings.themeColor) ?? THEME_COLOR_PRESETS[0];
  return { color: preset.color, fg: preset.fg };
}

export function applyThemeToDom(settings: LauncherSettings): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const { color, fg } = getEffectivePrimaryColor(settings);

  // 1. Primary & accent CSS variables
  root.style.setProperty("--primary", color);
  root.style.setProperty("--primary-foreground", fg);
  root.style.setProperty("--ring", color);
  root.style.setProperty("--sidebar-primary", color);
  root.style.setProperty("--sidebar-primary-foreground", fg);
  root.style.setProperty("--sidebar-ring", color);
  root.style.setProperty("--chart-1", color);

  // 2. Light / Dark mode
  const mode = settings.themeMode ?? "dark";
  const isDark =
    mode === "dark" ||
    (mode === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (isDark) {
    root.classList.add("dark");
    root.classList.remove("light");
    root.style.setProperty("color-scheme", "dark");
  } else {
    root.classList.add("light");
    root.classList.remove("dark");
    root.style.setProperty("color-scheme", "light");
  }

  // 3. Font Family
  if (settings.fontFamily === "pixel") {
    document.body.style.fontFamily = "var(--font-pixel)";
  } else if (settings.fontFamily === "system") {
    document.body.style.fontFamily =
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
  } else {
    document.body.style.fontFamily = "";
  }

  // 4. Animation toggle
  if (settings.enableAnimation === false) {
    root.classList.add("reduce-motion");
  } else {
    root.classList.remove("reduce-motion");
  }

  // 5. Mica Glassmorphism
  if (settings.enableMica !== false) {
    root.classList.add("mica-enabled");
  } else {
    root.classList.remove("mica-enabled");
  }
}
