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

export interface DownloadContentRequest {
  root: string;
  instanceId?: string;
  projectType: ContentProjectType;
  url: string;
  filename: string;
  sha1?: string;
  size?: number;
  title: string;
}

export interface DownloadContentResult {
  success: boolean;
  filePath: string;
  bytes: number;
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
  status: "completed" | "failed";
  threads: number;
  totalFiles: number;
  totalBytes: number;
  peakSpeedBps: number;
  durationMs: number;
  finishedAt: string;
  error?: string;
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

export interface LaunchRequest {
  versionId: string;
  root: string;
  playerName: string;
  memoryMb: number;
  javaPath?: string | null;
  width?: number | null;
  height?: number | null;
}

export type DownloadSourceId = "official_ap" | "bmclapi" | "custom";

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
}

export type ViewId =
  | "home"
  | "version-select"
  | "download"
  | "version-install"
  | "download-progress"
  | "version-settings"
  | "settings";
