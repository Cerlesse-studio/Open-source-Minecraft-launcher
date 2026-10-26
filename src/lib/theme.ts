import type { LauncherSettings } from "./types";

/** Accent used until someone picks their own color. Kept in one place so the
 * DOM theme and the settings preview can never disagree. */
export const DEFAULT_ACCENT = "#9bdd6b";

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

function accentHex(value?: string): string {
  const clean = (value ?? "").trim();
  return HEX_PATTERN.test(clean) ? clean : DEFAULT_ACCENT;
}

function readableForeground(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 150 ? "#0b1408" : "#ffffff";
}

export function getEffectivePrimaryColor(
  settings: Pick<LauncherSettings, "customThemeColor">,
): { color: string; fg: string } {
  const color = accentHex(settings.customThemeColor);
  return { color, fg: readableForeground(color) };
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
  } else if (settings.fontFamily === "serif") {
    document.body.style.fontFamily =
      'Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", "SimSun", serif';
  } else {
    document.body.style.fontFamily = "";
  }

  // 4. Text weight & letter spacing
  document.body.style.fontWeight = settings.fontWeight === "medium" ? "500" : "400";
  document.body.style.letterSpacing =
    settings.letterSpacing === "tight"
      ? "-0.012em"
      : settings.letterSpacing === "wide"
        ? "0.028em"
        : "";

  // 5. Animation toggle
  if (settings.enableAnimation === false) {
    root.classList.add("reduce-motion");
  } else {
    root.classList.remove("reduce-motion");
  }

  // 6. Mica Glassmorphism
  if (settings.enableMica !== false) {
    root.classList.add("mica-enabled");
  } else {
    root.classList.remove("mica-enabled");
  }

  // 7. Surface opacity: scales the derived panel tokens in styles.css, so the
  //    slider fades every card, popover, input, the sidebar and the page
  //    backdrop together. Clamped so text never floats on nothing.
  const surfaceAlpha = Math.min(1, Math.max(0.3, (settings.uiOpacity ?? 100) / 100));
  root.style.setProperty("--surface-alpha", String(surfaceAlpha));
}
