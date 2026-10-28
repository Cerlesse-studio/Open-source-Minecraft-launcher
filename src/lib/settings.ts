import type { BackgroundType, HomePageMode, LauncherSettings } from "./types";

const STORAGE_KEY = "cobble.settings.v1";

const BACKGROUND_TYPES: BackgroundType[] = ["default", "custom"];

const HOME_PAGE_MODES: HomePageMode[] = ["preset", "blank", "local", "online"];

function isHomePageMode(value: unknown): value is HomePageMode {
  return (
    typeof value === "string" && (HOME_PAGE_MODES as readonly string[]).includes(value)
  );
}

/**
 * Older builds shipped named accent presets (and five scenic wallpapers).
 * Their accent color is kept as the custom color so upgrading does not lose it;
 * their wallpaper name falls back to the plain backdrop.
 */
const LEGACY_ACCENTS: Record<string, string> = {
  emerald: "#9bdd6b",
  sapphire: "#38bdf8",
  amethyst: "#c084fc",
  blaze: "#fb923c",
  ruby: "#f43f5e",
  gold: "#facc15",
  prismarine: "#2dd4bf",
};

function resolveAccentColor(parsed: Record<string, unknown>): string {
  const legacy = typeof parsed.themeColor === "string" ? LEGACY_ACCENTS[parsed.themeColor] : undefined;
  if (legacy) return legacy;
  const custom = typeof parsed.customThemeColor === "string" ? parsed.customThemeColor.trim() : "";
  return /^#[0-9a-fA-F]{6}$/.test(custom) ? custom : defaultSettings.customThemeColor;
}

function isBackgroundType(value: unknown): value is BackgroundType {
  return (
    typeof value === "string" &&
    (BACKGROUND_TYPES as readonly string[]).includes(value)
  );
}

export const defaultSettings: LauncherSettings = {
  playerName: "Steve",
  gameRoot: "",
  memoryMb: 4096,
  javaPath: "",
  resolutionEnabled: false,
  width: 1280,
  height: 720,
  downloadThreads: 16,
  downloadSource: "official_ap",
  customSourceUrl: "",
  offlineSkinType: "random",
  offlineSkinModel: "default",
  customSkinPath: "",
  mojangSkinName: "",
  msClientId: "",
  bedrockApiSource: "endstone",
  versionIsolation: "all",
  windowTitle: "",
  customInfo: "PCL",
  launcherVisibility: "keep",
  processPriority: "normal",
  windowSize: "default",
  customThemeColor: "#9bdd6b",
  themeMode: "dark",
  backgroundType: "default",
  customBackgroundPath: "",
  backgroundBlur: 0,
  backgroundOpacity: 60,
  uiOpacity: 100,
  enableMica: true,
  enableAnimation: true,
  showWorldGrid: true,
  customSlogan: "",
  homePageMode: "preset",
  homePageLocalPath: "",
  homePageUrl: "",
  homePageRefreshMinutes: 0,
  fontFamily: "default",
  fontWeight: "regular",
  letterSpacing: "normal",
  statusText: "",
  launchButtonText: "",
};

export function loadSettings(): LauncherSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...defaultSettings };
    const parsed = JSON.parse(raw) as Partial<LauncherSettings>;
    return {
      ...defaultSettings,
      ...parsed,
      playerName:
        typeof parsed.playerName === "string" && parsed.playerName.trim()
          ? parsed.playerName.slice(0, 16)
          : defaultSettings.playerName,
      memoryMb:
        typeof parsed.memoryMb === "number"
          ? Math.min(16384, Math.max(1024, parsed.memoryMb))
          : defaultSettings.memoryMb,
      resolutionEnabled: Boolean(parsed.resolutionEnabled),
      downloadThreads:
        typeof parsed.downloadThreads === "number"
          ? Math.min(64, Math.max(1, Math.round(parsed.downloadThreads)))
          : defaultSettings.downloadThreads,
      downloadSource:
        parsed.downloadSource === "bmclapi" || parsed.downloadSource === "custom"
          ? parsed.downloadSource
          : "official_ap",
      customSourceUrl:
        typeof parsed.customSourceUrl === "string" ? parsed.customSourceUrl : "",
      offlineSkinType:
        parsed.offlineSkinType === "steve" ||
        parsed.offlineSkinType === "alex" ||
        parsed.offlineSkinType === "mojang" ||
        parsed.offlineSkinType === "custom"
          ? parsed.offlineSkinType
          : "random",
      offlineSkinModel:
        parsed.offlineSkinModel === "slim" ? "slim" : "default",
      customSkinPath:
        typeof parsed.customSkinPath === "string" ? parsed.customSkinPath : "",
      mojangSkinName:
        typeof parsed.mojangSkinName === "string" ? parsed.mojangSkinName : "",
      msClientId:
        typeof parsed.msClientId === "string" ? parsed.msClientId.trim() : "",
      bedrockApiSource:
        parsed.bedrockApiSource === "mcserverjars" || parsed.bedrockApiSource === "azure_mirror"
          ? parsed.bedrockApiSource
          : "endstone",
      versionIsolation:
        parsed.versionIsolation === "modded" || parsed.versionIsolation === "none"
          ? parsed.versionIsolation
          : "all",
      windowTitle:
        typeof parsed.windowTitle === "string" ? parsed.windowTitle : "",
      customInfo:
        typeof parsed.customInfo === "string" && parsed.customInfo.trim()
          ? parsed.customInfo.trim()
          : "PCL",
      launcherVisibility:
        parsed.launcherVisibility === "hide" || parsed.launcherVisibility === "close"
          ? parsed.launcherVisibility
          : "keep",
      processPriority:
        parsed.processPriority === "realtime" ||
        parsed.processPriority === "high" ||
        parsed.processPriority === "above_normal" ||
        parsed.processPriority === "below_normal" ||
        parsed.processPriority === "low"
          ? parsed.processPriority
          : "normal",
      windowSize:
        parsed.windowSize === "fullscreen" || parsed.windowSize === "custom"
          ? parsed.windowSize
          : "default",
      customThemeColor: resolveAccentColor(parsed as Record<string, unknown>),
      themeMode:
        parsed.themeMode === "light" || parsed.themeMode === "system"
          ? parsed.themeMode
          : "dark",
      backgroundType: isBackgroundType(parsed.backgroundType)
        ? parsed.backgroundType
        : "default",
      customBackgroundPath:
        typeof parsed.customBackgroundPath === "string" ? parsed.customBackgroundPath : "",
      backgroundBlur:
        typeof parsed.backgroundBlur === "number"
          ? Math.min(30, Math.max(0, Math.round(parsed.backgroundBlur)))
          : defaultSettings.backgroundBlur,
      backgroundOpacity:
        typeof parsed.backgroundOpacity === "number"
          ? Math.min(100, Math.max(10, Math.round(parsed.backgroundOpacity)))
          : defaultSettings.backgroundOpacity,
      uiOpacity:
        typeof parsed.uiOpacity === "number"
          ? Math.min(100, Math.max(30, Math.round(parsed.uiOpacity)))
          : defaultSettings.uiOpacity,
      enableMica: parsed.enableMica !== false,
      enableAnimation: parsed.enableAnimation !== false,
      showWorldGrid: parsed.showWorldGrid !== false,
      customSlogan:
        typeof parsed.customSlogan === "string" ? parsed.customSlogan : "",
      homePageMode: isHomePageMode(parsed.homePageMode) ? parsed.homePageMode : "preset",
      homePageLocalPath:
        typeof parsed.homePageLocalPath === "string" ? parsed.homePageLocalPath : "",
      homePageUrl: typeof parsed.homePageUrl === "string" ? parsed.homePageUrl : "",
      homePageRefreshMinutes:
        typeof parsed.homePageRefreshMinutes === "number"
          ? Math.min(180, Math.max(0, Math.round(parsed.homePageRefreshMinutes)))
          : defaultSettings.homePageRefreshMinutes,
      fontFamily:
        parsed.fontFamily === "pixel" ||
        parsed.fontFamily === "system" ||
        parsed.fontFamily === "serif"
          ? parsed.fontFamily
          : "default",
      fontWeight: parsed.fontWeight === "medium" ? "medium" : "regular",
      letterSpacing:
        parsed.letterSpacing === "tight" || parsed.letterSpacing === "wide"
          ? parsed.letterSpacing
          : "normal",
      statusText:
        typeof parsed.statusText === "string" ? parsed.statusText.slice(0, 40) : "",
      launchButtonText:
        typeof parsed.launchButtonText === "string"
          ? parsed.launchButtonText.slice(0, 20)
          : "",
    };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: LauncherSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Settings are non-critical; the launcher still works with defaults.
  }
}
