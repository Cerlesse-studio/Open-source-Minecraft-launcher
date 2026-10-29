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

/** One Java resource pack inside the instance's `resourcepacks/` folder. */
export interface JavaPackItem {
  id: string;
  name: string;
  fileName: string;
  path: string;
  enabled: boolean;
  size: number;
  modifiedTime: string;
  description: string;
  packFormat?: number | null;
  /** `pack.png` inlined as a data URL by the backend. */
  iconDataUrl?: string | null;
  isDir: boolean;
}

/** One Java save inside the instance's `saves/` folder. */
export interface JavaWorldItem {
  id: string;
  name: string;
  folder: string;
  path: string;
  size: number;
  modifiedTime: string;
  /** `icon.png` inlined as a data URL by the backend. */
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
  /** English keywords used for a non-English query, when they were used. */
  translatedQuery?: string | null;
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
  /** Locale such as `zh_cn`; the game starts in this language. */
  language?: string | null;
  /** Microsoft account session; omitted for offline accounts. */
  auth?: LaunchAuth | null;
}

/** Credentials the game receives when the player signed in with a real account. */
export interface LaunchAuth {
  accessToken: string;
  /** Profile UUID from Mojang. */
  uuid: string;
  /** Profile name — the game rejects a session token paired with another name. */
  name: string;
  xuid?: string | null;
  clientId?: string | null;
}

/** What one Microsoft sign-in grants, for both editions at once. */
export interface MsEntitlements {
  java: boolean;
  bedrock: boolean;
  gamePass: boolean;
  items: string[];
}

export interface MsAccount {
  signedIn: boolean;
  clientId: string;
  uuid: string;
  name: string;
  skinUrl: string | null;
  xuid: string;
  entitlements: MsEntitlements;
  /** Unix seconds; the Java session must still be valid when the game starts. */
  sessionExpiresAt: number;
  refreshExpiresAt: number;
  /** Set when the stored session could not be renewed. */
  sessionError: string | null;
}

/** One pending Microsoft device-code login. */
export interface MsDeviceCode {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  /** Verification link with the code already filled in, when Microsoft sends one. */
  verificationUriComplete?: string | null;
  expiresIn: number;
  interval: number;
  message: string;
}

export interface MsLoginPoll {
  state: "pending" | "slow_down" | "success";
  message: string | null;
  account: MsAccount | null;
}

export type DownloadSourceId = "official_ap" | "bmclapi" | "custom";

/** Reachability of one download source, measured on its version manifest. */
export interface DownloadSourceProbe {
  source: DownloadSourceId;
  ok: boolean;
  latencyMs: number;
  error?: string | null;
}

export type ThemeMode = "dark" | "light" | "system";
/**
 * What the home page shows next to the launch panel: the built-in news feed,
 * an empty page, a local HTML file the player maintains, or a remote HTML page
 * that can refresh itself.
 */
export type HomePageMode = "preset" | "blank" | "local" | "online";
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
  /** Azure application id for Microsoft login; empty uses the built-in one. */
  msClientId?: string;
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
  /** Custom home page source; `preset` keeps the built-in news panel. */
  homePageMode: HomePageMode;
  /** Local HTML file shown when `homePageMode` is `local`. */
  homePageLocalPath: string;
  /** Remote HTML address shown when `homePageMode` is `online`. */
  homePageUrl: string;
  /** Auto-refresh interval for the online home page in minutes; 0 is manual. */
  homePageRefreshMinutes: number;
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
  | "multiplayer"
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
  /**
   * `min_engine_version` from the manifest, e.g. `1.21.0`. Minecraft silently
   * ignores a pack when the running core is older than this.
   */
  engineVersion?: string | null;
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

// ---------------------------------------------------------------------------
// 联机（EasyTier 内核）
// ---------------------------------------------------------------------------

/** Everything the 联机 page needs to know about the local EasyTier node. */
export interface MultiplayerStatus {
  installed: boolean;
  version: string | null;
  running: boolean;
  networkName: string | null;
  overlayIpv4: string | null;
  pid: number | null;
  corePath: string | null;
}

/** Windows Firewall state for the EasyTier listener and the overlay game port. */
export interface MultiplayerFirewallStatus {
  /** Windows-only automation; other systems show the manual port hint. */
  supported: boolean;
  /** Our inbound rules exist, match the current ports, and the firewall is on. */
  ready: boolean;
  /** Human-readable reason when something could not be checked or applied. */
  detail: string;
}

/** One device EasyTier reports as connected to the room. */
export interface MultiplayerPeer {
  /** EasyTier hostname, normally the other machine's computer name. */
  hostname: string;
  /** Overlay IPv4 inside the virtual network. */
  ipv4: string;
  latencyMs: number;
  /** `p2p` / `relay` / `local`; empty when the CLI does not report it. */
  cost: string;
  /** `udp` / `tcp` / `wg`; empty when unknown. */
  tunnel: string;
  /** True for this machine's own node. */
  isSelf: boolean;
}

/** The saved shape of the local EasyTier node. */
export interface MultiplayerConfig {
  networkName: string;
  /** 房间密码，也就是 EasyTier 的 `--network-secret`；由房主创建房间时设置。 */
  networkSecret: string;
  /** This machine's overlay IPv4 inside the virtual network. */
  overlayIpv4: string;
  /** Transport addresses of other nodes, e.g. `tcp://[240e:…]:11010`. */
  peers: string[];
  listenPort: number;
  /** Port from Minecraft's "Open to LAN" chat line, written into the share code. */
  hostPort: number;
  /** Installed version the host opened; all members see its resource list. */
  hostVersion: string;
  /** Overlay IPv4 of the host while this machine is a guest; empty when hosting. */
  hostIpv4: string;
  /** Guest bandwidth cap the host sets, in bytes per second; 0 means unlimited. */
  recvBpsLimit: number;
  /** Host's local HTTP port that serves the read-only room resource list. */
  resourcePort: number;
  /** Token that authorises the room resource endpoint. */
  resourceToken: string;
}

/** One mod, shader pack, or resource pack shown in a room. */
export interface RoomResourceItem {
  name: string;
  fileName: string;
  enabled: boolean;
  size: number;
}

/** A read-only snapshot of the host version's content. */
export interface RoomResources {
  versionId: string;
  mods: RoomResourceItem[];
  shaders: RoomResourceItem[];
  resourcePacks: RoomResourceItem[];
  updatedAt: number;
  /** 房主的局域网端口；只输 IPv6 加入的访客靠它认出要连哪个端口。 */
  hostPort?: number | null;
}

export interface RoomResourcesInfo {
  port: number;
  token: string;
  resources: RoomResources;
}

export interface LocalIpv6Address {
  address: string;
  interface: string;
  /** Global unicast (`2000::/3`): the only kind reachable from the internet. */
  global: boolean;
  /** Privacy-extension address that rotates; poor choice for a share code. */
  temporary: boolean;
}

/** Result of a Minecraft server-list ping over the virtual network. */
export interface MinecraftHostStatus {
  ok: boolean;
  motd: string;
  version: string;
  online: number;
  max: number;
  latencyMs: number;
  error?: string | null;
}

/** A remote world proxied onto this machine's LAN list. */
export interface LanBridgeInfo {
  host: string;
  port: number;
  localPort: number;
  connectAddress: string;
}

/** Backend-tracked EasyTier install task, independent of the visible page. */
export interface MultiplayerInstallState {
  active: boolean;
  stage: string;
  detail: string;
  doneBytes: number;
  totalBytes: number;
  speedBps: number;
  threads: number;
  version: string;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** 磁盘上有可续传的 `.part`：再点一次是接着下，不是重头来。 */
  resumable: boolean;
  /** 已下载的字节数（可续传时才有意义）。 */
  partialBytes: number;
}

/** One non-version download shown on the downloads page. */
export interface BackgroundDownloadTask extends MultiplayerInstallState {
  id: string;
  title: string;
  status: "running" | "done" | "error" | "paused";
}

export interface MultiplayerLogPayload {
  stream: string;
  line: string;
}

/** A friend's world as saved locally. */
export interface MultiplayerHost {
  id: string;
  label: string;
  host: string;
  port: number;
  status?: MinecraftHostStatus | null;
  /** Local proxy port while this world is announced on the LAN list. */
  bridgePort?: number | null;
  checkedAt?: number;
}

/** One Bedrock world inside a `com.mojang/minecraftWorlds` folder. */
export interface BedrockWorldItem {
  /** World folder id, shared by every installed copy on this machine. */
  id: string;
  name: string;
  folder: string;
  path: string;
  size: number;
  modifiedTime: string;
  /** `world_icon.jpeg` as a data URL, when the world has one. */
  icon?: string | null;
  location: string;
  locationPath: string;
}

