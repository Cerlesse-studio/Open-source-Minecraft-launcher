import type { LauncherSettings } from "./types";

const STORAGE_KEY = "cobble.settings.v1";

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
  bedrockApiSource: "endstone",
  versionIsolation: "all",
  windowTitle: "",
  customInfo: "PCL",
  launcherVisibility: "keep",
  processPriority: "normal",
  windowSize: "default",
  themeColor: "emerald",
  customThemeColor: "#9bdd6b",
  themeMode: "dark",
  backgroundType: "default",
  customBackgroundPath: "",
  backgroundBlur: 0,
  backgroundOpacity: 60,
  enableMica: true,
  enableAnimation: true,
  showWorldGrid: true,
  customSlogan: "",
  fontFamily: "default",
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
      themeColor:
        parsed.themeColor === "sapphire" ||
        parsed.themeColor === "amethyst" ||
        parsed.themeColor === "blaze" ||
        parsed.themeColor === "ruby" ||
        parsed.themeColor === "gold" ||
        parsed.themeColor === "prismarine" ||
        parsed.themeColor === "custom"
          ? parsed.themeColor
          : "emerald",
      customThemeColor:
        typeof parsed.customThemeColor === "string" && parsed.customThemeColor.startsWith("#")
          ? parsed.customThemeColor
          : defaultSettings.customThemeColor,
      themeMode:
        parsed.themeMode === "light" || parsed.themeMode === "system"
          ? parsed.themeMode
          : "dark",
      backgroundType:
        parsed.backgroundType === "dirt" ||
        parsed.backgroundType === "stone" ||
        parsed.backgroundType === "custom"
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
      enableMica: parsed.enableMica !== false,
      enableAnimation: parsed.enableAnimation !== false,
      showWorldGrid: parsed.showWorldGrid !== false,
      customSlogan:
        typeof parsed.customSlogan === "string" ? parsed.customSlogan : "",
      fontFamily:
        parsed.fontFamily === "pixel" || parsed.fontFamily === "system"
          ? parsed.fontFamily
          : "default",
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
