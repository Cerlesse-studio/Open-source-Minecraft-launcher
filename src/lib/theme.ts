import type { LauncherSettings } from "./types";

/** Accent used until someone picks their own color. Kept in one place so the
 * DOM theme and the settings preview can never disagree. */
export const DEFAULT_ACCENT = "#9bdd6b";

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Hue used when the accent carries none (pure grey). */
const NEUTRAL_HUE = 210;

function accentHex(value?: string): string {
  const clean = (value ?? "").trim();
  return HEX_PATTERN.test(clean) ? clean : DEFAULT_ACCENT;
}

export function hexToRgb(hex: string): string {
  const clean = hex.replace(/^#/, "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

export function hslToRgb(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `${Math.round(255 * f(0))}, ${Math.round(255 * f(8))}, ${Math.round(255 * f(4))}`;
}

/** Pick the foreground with the higher WCAG contrast ratio, not a fixed
 *  perceived-brightness threshold (which misjudges saturated yellows/greens). */
function readableForeground(hex: string): string {
  const linear = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const onDark = (luminance + 0.05) / (0.006 + 0.05);
  const onWhite = 1.05 / (luminance + 0.05);
  return onDark >= onWhite ? "#0b1408" : "#ffffff";
}

/** Position of the accent on the color wheel, in degrees. */
export function accentHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 0.0001) return NEUTRAL_HUE;
  const raw =
    max === r
      ? ((g - b) / delta + 6) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return Math.round((raw * 60) % 360);
}

export function getEffectivePrimaryColor(
  settings: Pick<LauncherSettings, "customThemeColor">,
): { color: string; fg: string } {
  const color = accentHex(settings.customThemeColor);
  return { color, fg: readableForeground(color) };
}

export function getLightModePrimary(hex: string): string {
  const h = accentHue(hex);
  // Yellow/green accents are perceptually bright. 22%/28% keeps `text-primary`
  // >= 4.5:1 even on the tinted `bg-primary/10` selected state, not just on
  // a pure white surface.
  const isYellowOrGreen = h >= 50 && h <= 150;
  const targetLightness = isYellowOrGreen ? 22 : 28;
  const rgbParts = hslToRgb(h, 85, targetLightness).split(", ").map(Number);
  return "#" + rgbParts.map((x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Panel colors as [variable, saturation %, lightness %].
 *
 * Only the accent's *hue* is borrowed: saturation and lightness stay fixed, so
 * the launcher keeps the contrast ladder it always had (these mirror the values
 * in styles.css) while the window itself takes on the chosen color. Without
 * this the surfaces stayed green no matter what accent was picked, because the
 * stylesheet's neutrals are hardcoded.
 */
const DARK_PANELS: ReadonlyArray<readonly [string, number, number]> = [
  ["--background-solid", 9, 4],
  ["--card-solid", 9, 6.5],
  ["--popover-solid", 9, 8.5],
  ["--secondary-solid", 11, 12],
  ["--muted-solid", 10, 9.5],
  ["--accent-solid", 12, 14.5],
  ["--border", 13, 17],
  ["--input", 13, 18.5],
  ["--sidebar-solid", 9, 5.5],
  ["--sidebar-accent-solid", 11, 11],
  ["--sidebar-border", 13, 15.5],
  ["--foreground", 8, 93.5],
  ["--card-foreground", 8, 93.5],
  ["--popover-foreground", 8, 93.5],
  ["--secondary-foreground", 9, 88.5],
  /* 68% keeps 9-11px muted labels >= 4.5:1 on the darkest panels. */
  ["--muted-foreground", 7, 68],
  ["--accent-foreground", 8, 95],
  ["--sidebar-foreground", 8, 93.5],
  ["--sidebar-accent-foreground", 8, 95],
];

const LIGHT_PANELS: ReadonlyArray<readonly [string, number, number]> = [
  ["--background-solid", 12, 97],
  ["--card-solid", 10, 100],
  ["--popover-solid", 10, 100],
  ["--secondary-solid", 12, 93],
  ["--muted-solid", 12, 93],
  ["--accent-solid", 14, 88],
  ["--border", 15, 80],
  ["--input", 15, 80],
  ["--sidebar-solid", 12, 96],
  ["--sidebar-accent-solid", 14, 88],
  ["--sidebar-border", 15, 80],
  ["--foreground", 13, 10],
  ["--card-foreground", 13, 10],
  ["--popover-foreground", 13, 10],
  ["--secondary-foreground", 13, 15],
  /* 32% keeps muted text >= 6:1 on white cards (38% was borderline). */
  ["--muted-foreground", 10, 32],
  ["--accent-foreground", 13, 10],
  ["--sidebar-foreground", 13, 10],
  ["--sidebar-accent-foreground", 13, 10],
];

/** Repaints every derived surface (they all reference these solid tokens). */
function applyPanelHue(root: HTMLElement, hue: number, dark: boolean): void {
  const panels = dark ? DARK_PANELS : LIGHT_PANELS;
  for (const [token, saturation, lightness] of panels) {
    root.style.setProperty(token, `hsl(${hue}, ${saturation}%, ${lightness}%)`);
    root.style.setProperty(`${token}-rgb`, hslToRgb(hue, saturation, lightness));
  }
}

export function applyThemeToDom(settings: LauncherSettings): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const { color, fg } = getEffectivePrimaryColor(settings);

  const mode = settings.themeMode ?? "dark";
  const isDark =
    mode === "dark" ||
    (mode === "system" &&
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);

  const activeColor = isDark ? color : getLightModePrimary(color);
  const activeFg = isDark ? fg : "#ffffff";
  const primaryRgb = hexToRgb(activeColor);
  const primaryFgRgb = hexToRgb(activeFg === "#ffffff" ? "#ffffff" : "#0b1408");

  // 1. Primary & accent CSS variables
  root.style.setProperty("--primary", activeColor);
  root.style.setProperty("--primary-rgb", primaryRgb);
  root.style.setProperty("--primary-foreground", activeFg);
  root.style.setProperty("--primary-fg-rgb", primaryFgRgb);
  root.style.setProperty("--ring", activeColor);
  root.style.setProperty("--ring-rgb", primaryRgb);
  root.style.setProperty("--sidebar-primary", activeColor);
  root.style.setProperty("--sidebar-primary-foreground", activeFg);
  root.style.setProperty("--sidebar-ring", activeColor);
  root.style.setProperty("--chart-1", activeColor);

  // 2. Panel surfaces, tinted with the accent's hue
  applyPanelHue(root, accentHue(color), isDark);

  // 3. Light / Dark mode
  if (isDark) {
    root.classList.add("dark");
    root.classList.remove("light");
    root.style.setProperty("color-scheme", "dark");
  } else {
    root.classList.add("light");
    root.classList.remove("dark");
    root.style.setProperty("color-scheme", "light");
  }

  // 4. Font Family
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

  // 5. Text weight & letter spacing
  document.body.style.fontWeight = settings.fontWeight === "medium" ? "500" : "400";
  document.body.style.letterSpacing =
    settings.letterSpacing === "tight"
      ? "-0.012em"
      : settings.letterSpacing === "wide"
        ? "0.028em"
        : "";

  // 6. Animation toggle
  if (settings.enableAnimation === false) {
    root.classList.add("reduce-motion");
  } else {
    root.classList.remove("reduce-motion");
  }

  // 7. Mica Glassmorphism
  if (settings.enableMica !== false) {
    root.classList.add("mica-enabled");
  } else {
    root.classList.remove("mica-enabled");
  }

  // 8. Surface opacity
  const surfaceAlpha = Math.min(1, Math.max(0.3, (settings.uiOpacity ?? 100) / 100));
  root.style.setProperty("--surface-alpha", String(surfaceAlpha));
}
