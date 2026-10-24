import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  demoDetectJava,
  demoDownloadContentFile,
  demoGetContentVersions,
  demoInstall,
  demoInstalledVersions,
  demoLaunch,
  demoManifest,
  demoSearchContent,
  demoStopGame,
  demoSubscribe,
  demoSystemInfo,
  demoVersionLoaders,
} from "./demo";
import type {
  ContentProjectType,
  ContentVersionItem,
  DownloadContentRequest,
  DownloadContentResult,
  GameExitPayload,
  GameLogPayload,
  GameStatus,
  InstallProgress,
  InstallResult,
  InstalledVersion,
  JavaInstall,
  LaunchRequest,
  LoaderSelection,
  SearchContentResult,
  SystemInfo,
  VersionLoadersCatalog,
  VersionManifest,
} from "./types";

export const isDesktop = isTauri();

export interface LauncherEventMap {
  "install:progress": InstallProgress;
  "game:log": GameLogPayload;
  "game:status": GameStatus;
  "game:exit": GameExitPayload;
}

export async function subscribe<K extends keyof LauncherEventMap>(
  event: K,
  handler: (payload: LauncherEventMap[K]) => void,
): Promise<() => void> {
  if (!isDesktop) {
    return demoSubscribe(event, handler);
  }
  return listen<LauncherEventMap[K]>(event, (message) => handler(message.payload));
}

export async function getVersionManifest(
  root: string,
  force = false,
): Promise<VersionManifest> {
  if (!isDesktop) return demoManifest();
  return invoke<VersionManifest>("get_version_manifest", { root, force });
}

export async function getInstalledVersions(root: string): Promise<InstalledVersion[]> {
  if (!isDesktop) return demoInstalledVersions();
  return invoke<InstalledVersion[]>("get_installed_versions", { root });
}

export async function getVersionLoaders(
  mcVersion: string,
): Promise<VersionLoadersCatalog> {
  if (!isDesktop) return demoVersionLoaders(mcVersion);
  return invoke<VersionLoadersCatalog>("get_version_loaders", { mcVersion });
}

export async function searchContent(options: {
  query?: string;
  projectType: ContentProjectType;
  gameVersion?: string;
  loader?: string;
  sort?: string;
  offset?: number;
  limit?: number;
}): Promise<SearchContentResult> {
  if (!isDesktop) return demoSearchContent(options);
  return invoke<SearchContentResult>("search_content", {
    query: options.query || "",
    projectType: options.projectType,
    gameVersion: options.gameVersion || null,
    loader: options.loader || null,
    sort: options.sort || null,
    offset: options.offset ?? 0,
    limit: options.limit ?? 20,
  });
}

export async function getContentVersions(
  projectIdOrSlug: string,
  gameVersion?: string,
  loader?: string,
): Promise<ContentVersionItem[]> {
  if (!isDesktop) return demoGetContentVersions(projectIdOrSlug, gameVersion, loader);
  return invoke<ContentVersionItem[]>("get_content_versions", {
    projectIdOrSlug,
    gameVersion: gameVersion || null,
    loader: loader || null,
  });
}

export async function downloadContentFile(
  request: DownloadContentRequest,
): Promise<DownloadContentResult> {
  if (!isDesktop) return demoDownloadContentFile(request);
  return invoke<DownloadContentResult>("download_content_file", { request });
}

export async function installVersion(
  root: string,
  versionId: string,
  concurrency?: number,
  selection?: LoaderSelection,
): Promise<InstallResult> {
  if (!isDesktop) return demoInstall(versionId, concurrency, selection);
  return invoke<InstallResult>("install_version", {
    request: { versionId, root, concurrency, selection },
  });
}

export async function getSystemInfo(): Promise<SystemInfo> {
  if (!isDesktop) return demoSystemInfo();
  return invoke<SystemInfo>("get_system_info");
}

export async function detectJava(root: string): Promise<JavaInstall[]> {
  if (!isDesktop) return demoDetectJava();
  return invoke<JavaInstall[]>("detect_java", { root });
}

export async function launchGame(request: LaunchRequest): Promise<number> {
  if (!isDesktop) return demoLaunch(request);
  return invoke<number>("launch_game", { request });
}

export async function stopGame(): Promise<void> {
  if (!isDesktop) {
    demoStopGame();
    return;
  }
  await invoke("stop_game");
}

export async function openFolderPath(path: string): Promise<void> {
  if (!isDesktop) return;
  await invoke("open_folder", { path });
}
