export interface LatestVersions {
  release: string;
  snapshot: string;
}

export interface VersionSummary {
  id: string;
  type: string;
  url: string;
  time?: string;
  releaseTime?: string;
  sha1?: string;
  phase?: string;
  source?: "mojang" | "betacraft" | string;
}

export interface VersionManifest {
  latest: LatestVersions;
  versions: VersionSummary[];
}

export interface InstalledVersion {
  id: string;
  type: string;
  installedAt: number;
  mcVersion?: string;
  loader?: string;
  loaderVersion?: string;
  optifineVersion?: string;
  fabricApiVersion?: string;
}

export interface LoaderVersionItem {
  version: string;
  stable: boolean;
  releaseTime?: string;
  subtitle?: string;
  downloadUrl?: string;
  fileName?: string;
  sha1?: string;
  size?: number;
}

export interface VersionLoadersCatalog {
  mcVersion: string;
  forge: LoaderVersionItem[];
  neoforge: LoaderVersionItem[];
  fabric: LoaderVersionItem[];
  quilt: LoaderVersionItem[];
  optifine: LoaderVersionItem[];
  fabricApi: LoaderVersionItem[];
}

export interface BedrockLoaderItem {
  name: string;
  version: string;
  loaderType: "levilamina" | "amethyst";
  compatibleMcVersion: string;
  downloadUrl: string;
  description: string;
  releaseTime?: string;
  stable: boolean;
}

export interface BedrockLoadersCatalog {
  mcVersion: string;
  levilamina: BedrockLoaderItem[];
  amethyst: BedrockLoaderItem[];
}

export interface BedrockModItem {
  id: string;
  name: string;
  fileName: string;
  path: string;
  modType: "levilamina_plugin" | "dll_mod" | "behavior_pack" | "resource_pack";
  enabled: boolean;
  injectDelay: number;
  isPreLoad: boolean;
  size: number;
  modifiedTime: string;
}

export interface JavaModItem {
  id: string;
  name: string;
  fileName: string;
  path: string;
  enabled: boolean;
  size: number;
  modifiedTime: string;
  version?: string;
  description?: string;
  modLoader?: string;
  /** Icon embedded in the jar, inlined as a `data:` URL by the backend. */
  iconDataUrl?: string | null;
}

export interface LoaderSelection {
  instanceName?: string;
  loaderType?: "forge" | "neoforge" | "fabric" | "quilt";
  loaderVersion?: string;
  optifineVersion?: string;
  optifineUrl?: string;
  optifineFilename?: string;
  fabricApiVersion?: string;
  fabricApiUrl?: string;
  fabricApiFilename?: string;
}

export type ContentProjectType =
  | "mod"
  | "modpack"
  | "shader"
  | "datapack"
  | "resourcepack";

export interface ContentHit {
  projectId: string;
  slug: string;
  author: string;
  title: string;
  description: string;
  categories: string[];
  versions: string[];
  downloads: number;
  follows: number;
  iconUrl?: string | null;
  dateCreated?: string;
  dateModified?: string;
  latestVersion?: string;
  projectType: ContentProjectType;
}

export interface SearchContentResult {
  hits: ContentHit[];
  offset: number;
  limit: number;
  totalHits: number;
}

export interface ContentFile {
  url: string;
  filename: string;
  primary: boolean;
  size: number;
  sha1?: string;
}

export interface ContentVersionItem {
  id: string;
  name: string;
  versionNumber: string;
  gameVersions: string[];
  loaders: string[];
  datePublished?: string;
  downloads: number;
  files: ContentFile[];
}

/** A resolved MC 百科 page (`/class/<id>.html` or `/modpack/<id>.html`). */
export interface WikiEntry {
  id: number;
  title: string;
  url: string;
}

export interface DownloadContentRequest {
  root: string;
  instanceId?: string;
  projectType: ContentProjectType;
  url: string;
  filename: string;
  sha1?: string;
  size?: number;
  title: string;
  /** Minecraft versions the build was published for; drives instance matching. */
  gameVersions?: string[];
  /** Loader family of the file ("fabric", "forge", …) when known. */
  loader?: string;
}

export interface DownloadContentResult {
  success: boolean;
  filePath: string;
  bytes: number;
  /** Instance the file ended up in (explicit or auto-detected). */
  instanceId?: string;
  /** True when no instance was requested and a matching local one was found. */
  autoMatched?: boolean;
}

export interface ActiveDownloadTask {
  workerId: number;
  name: string;
  stage: string;
  doneBytes: number;
  totalBytes: number;
  segments: number;
}

export interface StageProgress {
  stage: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  doneFiles: number;
  totalFiles: number;
  doneBytes: number;
  totalBytes: number;
}

export interface InstallProgress {
  versionId: string;
  stage: string;
  done: number;
  total: number;
  detail: string;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBps?: number;
  threads?: number;
  activeThreads?: number;
  skippedFiles?: number;
  retriedFiles?: number;
  activeTasks?: ActiveDownloadTask[];
  stages?: StageProgress[];
}

export interface DownloadHistoryRecord {
  id: string;
  versionId: string;
  status: "completed" | "failed" | "paused" | "cancelled";
  threads: number;
  totalFiles: number;
  totalBytes: number;
  downloadedBytes?: number;
  peakSpeedBps: number;
  durationMs: number;
  finishedAt: string;
  error?: string;
  selection?: LoaderSelection;
  edition?: "java" | "bedrock";
  bedrockVersionItem?: BedrockVersionItem;
  apiSource?: string;
  pausedReason?: string;
}

export interface InstallResult {
  versionId: string;
  versionType: string;
  libraries: number;
  assets: number;
  javaMajor: number;
}

export interface JavaInstall {
  path: string;
  major: number;
  version: string;
  source: string;
}

export interface SystemInfo {
  defaultRoot: string;
  os: string;
  arch: string;
  javaInstalls: JavaInstall[];
  gameRunning: boolean;
  launcherVersion: string;
}

export type GameStateName = "idle" | "preparing" | "running";

export interface GameStatus {
  state: GameStateName;
  detail?: string | null;
  pid?: number | null;
  versionId?: string | null;
}

export interface GameLogPayload {
  stream: string;
  line: string;
}

export interface GameExitPayload {
  code: number | null;
  versionId?: string | null;
}

export type OfflineSkinType = "random" | "steve" | "alex" | "mojang" | "custom";
export type OfflineSkinModel = "default" | "slim";

export type VersionIsolation = "all" | "modded" | "none";
export type LauncherVisibility = "keep" | "hide" | "close";
export type ProcessPriority =
  | "normal"
  | "realtime"
  | "high"
  | "above_normal"
  | "below_normal"
  | "low";
export type WindowSizeMode = "default" | "fullscreen" | "custom";

export interface LaunchRequest {
  versionId: string;
  root: string;
  playerName: string;
  memoryMb: number;
  javaPath?: string | null;
  width?: number | null;
  height?: number | null;
  skinType?: OfflineSkinType;
  customSkinPath?: string | null;
  customSkinModel?: OfflineSkinModel | null;
  mojangSkinName?: string | null;
  versionIsolation?: VersionIsolation;
  windowTitle?: string | null;
  customInfo?: string | null;
  launcherVisibility?: LauncherVisibility;
  processPriority?: ProcessPriority;
  windowSize?: WindowSizeMode;
  jvmArgs?: string | null;
}

export type DownloadSourceId = "official_ap" | "bmclapi" | "custom";

export type ThemeMode = "dark" | "light" | "system";
/** `default` keeps the flat theme backdrop, `custom` paints one image. */
export type BackgroundType = "default" | "custom";
export type LauncherFont = "default" | "pixel" | "system" | "serif";
/** Interface text weight; "medium" dials the whole launcher one step heavier. */
export type LauncherFontWeight = "regular" | "medium";
/** Interface letter spacing; useful with the pixel font. */
export type LauncherLetterSpacing = "tight" | "normal" | "wide";

export interface LauncherSettings {
  playerName: string;
  gameRoot: string;
  memoryMb: number;
  javaPath: string;
  resolutionEnabled: boolean;
  width: number;
  height: number;
  downloadThreads: number;
  downloadSource: DownloadSourceId;
  customSourceUrl?: string;
  offlineSkinType: OfflineSkinType;
  offlineSkinModel: OfflineSkinModel;
  customSkinPath?: string;
  mojangSkinName?: string;
  bedrockApiSource?: "endstone" | "mcserverjars" | "azure_mirror";
  versionIsolation: VersionIsolation;
  windowTitle: string;
  customInfo: string;
  launcherVisibility: LauncherVisibility;
  processPriority: ProcessPriority;
  windowSize: WindowSizeMode;
  /** Accent color as `#rrggbb`; `DEFAULT_ACCENT` is used when empty. */
  customThemeColor: string;
  themeMode: ThemeMode;
  backgroundType: BackgroundType;
  customBackgroundPath: string;
  backgroundBlur: number;
  backgroundOpacity: number;
  /** 30-100. Scales every UI surface (cards, sidebar, popovers, inputs). */
  uiOpacity: number;
  enableMica: boolean;
  enableAnimation: boolean;
  showWorldGrid: boolean;
  customSlogan: string;
  fontFamily: LauncherFont;
  fontWeight: LauncherFontWeight;
  letterSpacing: LauncherLetterSpacing;
  /** Replaces the ready-state line on the home card; empty keeps the default. */
  statusText: string;
  /** Replaces the launch button label; empty keeps the default per edition. */
  launchButtonText: string;
}

export type ViewId =
  | "home"
  | "version-select"
  | "download"
  | "version-install"
  | "download-progress"
  | "version-settings"
  | "settings";

export type GameEdition = "java" | "bedrock";

export interface BedrockStatus {
  uwpInstalled: boolean;
  standaloneInstalled: boolean;
  comMojangPath: string;
  portablePath: string;
  resourcePacksCount: number;
  behaviorPacksCount: number;
  worldsCount: number;
  installedVersions: string[];
  /** Version folders left behind by aborted installs; deletable, never launched. */
  leftoverVersions?: string[];
  versionDetails?: BedrockInstalledVersionDetail[];
  runtimeStatus?: BedrockRuntimeStatus;
  fullDependencyReport?: BedrockFullDependencyReport;
}

export interface BedrockInstalledVersionDetail {
  id: string;
  name: string;
  isServer: boolean;
  packageFile?: string | null;
  packageType?: string | null; // "msixvc" | "appx" | "exe" | "bds"
  isGdk: boolean;
}

export interface BedrockRuntimeStatus {
  xboxAppInstalled: boolean;
  gamingServicesInstalled: boolean;
  minecraftUwpInstalled: boolean;
  wingetAvailable: boolean;
  ready: boolean;
}

export interface BedrockDependencyItem {
  key: string;
  name: string;
  required: boolean;
  installed: boolean;
  version?: string | null;
  minVersion?: string | null;
  fixHint: string;
}

export interface BedrockFullDependencyReport {
  allSatisfied: boolean;
  developerMode: boolean;
  vcRedistX64: boolean;
  gamingServices: boolean;
  xboxApp: boolean;
  uwpClient: boolean;
  items: BedrockDependencyItem[];
}

export interface BedrockVersionItem {
  id: string;
  name: string;
  version: string;
  releaseType: string;
  downloadUrl: string;
  storeUrl?: string | null;
  date: string;
  size: number;
  apiSource?: string | null;
  sha256?: string | null;
  buildType?: string | null;
  md5?: string | null;
}

export interface BedrockContentItem {
  id: string;
  title: string;
  author: string;
  description: string;
  contentType: "shader" | "mod" | "resourcepack";
  downloadUrl: string;
  fileName: string;
  iconUrl?: string | null;
  tags: string[];
  downloads: number;
  version: string;
}

export interface InstallPackResult {
  success: boolean;
  packName: string;
  packType: string;
  targetPath: string;
  message: string;
}

/** One pack installed under a Bedrock `com.mojang` folder. */
export interface BedrockPackItem {
  /** Manifest UUID when readable, otherwise the folder name. */
  id: string;
  name: string;
  description: string;
  /** Semver-ish manifest version, e.g. `1.0.3`. */
  version: string;
  /** `resource` | `behavior` | `skin` | `template` */
  packType: string;
  folder: string;
  path: string;
  enabled: boolean;
  size: number;
  modifiedTime: string;
  /** `pack_icon.png` as a data URL, when the pack ships one. */
  icon?: string | null;
  /** Which data folder this copy lives in: portable, GDK or UWP. */
  location: string;
  locationPath: string;
}

