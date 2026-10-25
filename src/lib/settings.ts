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
