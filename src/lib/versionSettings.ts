import type { LauncherSettings } from "./types";

export type VersionLaunchSettings = Pick<
  LauncherSettings,
  | "memoryMb"
  | "resolutionEnabled"
  | "width"
  | "height"
  | "versionIsolation"
  | "windowTitle"
  | "customInfo"
  | "launcherVisibility"
  | "processPriority"
  | "windowSize"
> & {
  javaPath?: string;
  jvmArgs?: string;
  /** Locale the game should start in; empty keeps the in-game choice. */
  language?: string;
  /** 自定义版本图标 ("auto" 或预设图标名，如 "crafting_table" / 自定义路径) */
  icon?: string;
  /** 自定义版本分类 ("auto" 或具体分类名) */
  category?: string;
  /** 自定义版本显示名 (修改版本名) */
  customName?: string;
  /** 自定义版本描述 (修改版本描述) */
  description?: string;
  /** 是否收藏 (加入收藏夹) */
  favorite?: boolean;
};

const STORAGE_KEY = "cobble.version-launch.v1";

export function resolveVersionLaunchSettings(
  defaults: LauncherSettings,
  overrides: Record<string, Partial<VersionLaunchSettings>>,
  versionId: string,
): VersionLaunchSettings {
  const override = overrides[versionId];
  return {
    memoryMb: override?.memoryMb ?? defaults.memoryMb,
    resolutionEnabled: override?.resolutionEnabled ?? defaults.resolutionEnabled,
    width: override?.width ?? defaults.width,
    height: override?.height ?? defaults.height,
    versionIsolation: override?.versionIsolation ?? defaults.versionIsolation,
    windowTitle: override?.windowTitle ?? defaults.windowTitle,
    customInfo: override?.customInfo ?? defaults.customInfo,
    launcherVisibility: override?.launcherVisibility ?? defaults.launcherVisibility,
    processPriority: override?.processPriority ?? defaults.processPriority,
    windowSize: override?.windowSize ?? defaults.windowSize,
    javaPath: override?.javaPath ?? "",
    jvmArgs: override?.jvmArgs ?? "",
    language: override?.language ?? "",
    icon: override?.icon ?? "auto",
    category: override?.category ?? "auto",
    customName: override?.customName ?? "",
    description: override?.description ?? "",
    favorite: Boolean(override?.favorite),
  };
}

function sanitize(value: Partial<VersionLaunchSettings>): VersionLaunchSettings {
  const memory = Number(value.memoryMb);
  const width = Number(value.width);
  const height = Number(value.height);
  return {
    memoryMb: Number.isFinite(memory)
      ? Math.min(16384, Math.max(1024, Math.round(memory / 512) * 512))
      : 4096,
    resolutionEnabled: Boolean(value.resolutionEnabled),
    width: Number.isFinite(width) ? Math.min(7680, Math.max(320, width)) : 1280,
    height: Number.isFinite(height) ? Math.min(4320, Math.max(240, height)) : 720,
    versionIsolation:
      value.versionIsolation === "modded" || value.versionIsolation === "none"
        ? value.versionIsolation
        : "all",
    windowTitle: typeof value.windowTitle === "string" ? value.windowTitle : "",
    customInfo:
      typeof value.customInfo === "string" && value.customInfo.trim()
        ? value.customInfo.trim()
        : "PCL",
    launcherVisibility:
      value.launcherVisibility === "hide" || value.launcherVisibility === "close"
        ? value.launcherVisibility
        : "keep",
    processPriority:
      value.processPriority === "realtime" ||
      value.processPriority === "high" ||
      value.processPriority === "above_normal" ||
      value.processPriority === "below_normal" ||
      value.processPriority === "low"
        ? value.processPriority
        : "normal",
    windowSize:
      value.windowSize === "fullscreen" || value.windowSize === "custom"
        ? value.windowSize
        : "default",
    javaPath: typeof value.javaPath === "string" ? value.javaPath.trim() : "",
    jvmArgs: typeof value.jvmArgs === "string" ? value.jvmArgs.trim() : "",
    // `zh-CN` typed or loaded from an older build becomes the code the game
    // actually understands.
    language:
      typeof value.language === "string"
        ? value.language.trim().replace("-", "_").toLowerCase()
        : "",
    icon: typeof value.icon === "string" ? value.icon : "auto",
    category: typeof value.category === "string" ? value.category : "auto",
    customName: typeof value.customName === "string" ? value.customName : "",
    description: typeof value.description === "string" ? value.description : "",
    favorite: Boolean(value.favorite),
  };
}

export function loadVersionSettings(): Record<string, VersionLaunchSettings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<VersionLaunchSettings>>;
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([versionId, value]) => versionId && value && typeof value === "object")
        .map(([versionId, value]) => [versionId, sanitize(value)]),
    );
  } catch {
    return {};
  }
}

export function saveVersionSettings(
  settings: Record<string, VersionLaunchSettings>,
): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Version overrides are optional; the launcher still uses global defaults.
  }
}
