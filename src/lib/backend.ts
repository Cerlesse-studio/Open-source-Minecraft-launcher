import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  demoDetectJava,
  demoDownloadContentFile,
  demoGetBedrockContent,
  demoGetBedrockStatus,
  demoGetBedrockVersions,
  demoGetContentVersions,
  demoInstall,
  demoDeleteVersion,
  demoDeleteBedrockVersion,
  demoCleanDownloadCache,
  demoInstallBedrockPack,
  demoInstallBedrockVersion,
  demoInstalledVersions,
  demoLaunch,
  demoLaunchBedrock,
  demoManifest,
  demoSearchContent,
  demoStopGame,
  demoSubscribe,
  demoSystemInfo,
  demoVersionLoaders,
  demoGetBedrockLoaders,
  demoInstallBedrockLoader,
  demoGetBedrockMods,
  demoToggleBedrockMod,
  demoDeleteBedrockMod,
  demoInstallBedrockModFile,
} from "./demo";
import type {
  BedrockContentItem,
  BedrockFullDependencyReport,
  BedrockLoadersCatalog,
  BedrockModItem,
  BedrockRuntimeStatus,
  BedrockStatus,
  BedrockVersionItem,
  ContentProjectType,
  ContentVersionItem,
  DownloadContentRequest,
  DownloadContentResult,
  GameExitPayload,
  GameLogPayload,
  GameStatus,
  InstallPackResult,
  InstallProgress,
  InstallResult,
  InstalledVersion,
  JavaInstall,
  JavaModItem,
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

export async function getBetacraftManifest(
  root: string,
  force = false,
): Promise<VersionManifest> {
  if (!isDesktop) {
    try {
      const res = await fetch("https://files.betacraft.uk/launcher/v2/assets/version_manifest_v2.json");
      if (res.ok) {
        const raw = await res.json();
        const versions = (raw.versions || []).map((v: any) => ({
          id: v.id,
          type: v.phase === "beta" ? "old_beta" : v.phase === "oddballs" ? "april_fools" : ["alpha", "classic", "indev", "infdev", "pre-classic"].includes(v.phase) ? "old_alpha" : v.type,
          url: v.url,
          time: v.time,
          releaseTime: v.releaseTime,
          phase: v.phase,
          source: "betacraft",
        }));
        return {
          latest: { release: "1.7.10", snapshot: "b1.8.1" },
          versions,
        };
      }
    } catch {
      // fallback
    }
    return { latest: { release: "1.7.10", snapshot: "b1.8.1" }, versions: [] };
  }
  return invoke<VersionManifest>("get_betacraft_manifest", { root, force });
}

export async function getInstalledVersions(root: string): Promise<InstalledVersion[]> {
  if (!isDesktop) return demoInstalledVersions();
  return invoke<InstalledVersion[]>("get_installed_versions", { root });
}

export async function readSkinAsDataUrl(path: string): Promise<string> {
  if (!isDesktop) return "";
  return invoke<string>("read_skin_as_data_url", { path });
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

export async function cancelInstall(): Promise<boolean> {
  if (!isDesktop) return true;
  return invoke<boolean>("cancel_install");
}

export async function deleteVersion(
  root: string,
  versionId: string,
): Promise<void> {
  if (!isDesktop) return demoDeleteVersion(versionId);
  return invoke<void>("delete_version", { root, versionId });
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
export const openFolder = openFolderPath;

export async function getBedrockStatus(root?: string): Promise<BedrockStatus> {
  if (!isDesktop) return demoGetBedrockStatus();
  return invoke<BedrockStatus>("get_bedrock_status", { root });
}

export async function getBedrockVersions(apiSource?: string): Promise<BedrockVersionItem[]> {
  if (!isDesktop) return demoGetBedrockVersions(apiSource);
  return invoke<BedrockVersionItem[]>("get_bedrock_versions", { apiSource });
}

export async function getBedrockContent(category?: string): Promise<BedrockContentItem[]> {
  if (!isDesktop) return demoGetBedrockContent(category);
  return invoke<BedrockContentItem[]>("get_bedrock_content", { category });
}

export async function installBedrockVersion(
  versionId: string,
  downloadUrl?: string,
  root?: string,
  apiSource?: string,
  threads?: number,
): Promise<string> {
  if (!isDesktop) return demoInstallBedrockVersion(versionId);
  return invoke<string>("install_bedrock_version", {
    versionId,
    downloadUrl,
    root,
    apiSource,
    threads,
  });
}

export async function deleteBedrockVersion(
  versionId: string,
  root?: string,
): Promise<void> {
  if (!isDesktop) return demoDeleteBedrockVersion(versionId);
  return invoke<void>("delete_bedrock_version", { versionId, root });
}

export async function installBedrockPack(
  source: string,
  filename?: string,
  root?: string,
): Promise<InstallPackResult> {
  if (!isDesktop) return demoInstallBedrockPack(source, filename);
  return invoke<InstallPackResult>("install_bedrock_pack", { source, filename, root });
}

export async function cleanDownloadCache(root?: string): Promise<number> {
  if (!isDesktop) return demoCleanDownloadCache();
  return invoke<number>("clean_download_cache", { root });
}

export async function launchBedrock(
  versionId?: string,
  root?: string,
  offlineAccount?: boolean,
): Promise<string> {
  if (!isDesktop) return demoLaunchBedrock();
  return invoke<string>("launch_bedrock", { versionId, root, offlineAccount });
}

export async function getBedrockRuntimeStatus(force = false): Promise<BedrockRuntimeStatus> {
  if (!isDesktop) {
    return {
      xboxAppInstalled: true,
      gamingServicesInstalled: true,
      minecraftUwpInstalled: true,
      wingetAvailable: true,
      ready: true,
    };
  }
  return invoke<BedrockRuntimeStatus>("get_bedrock_runtime_status", { force });
}

export async function autoProvisionBedrockRuntime(): Promise<BedrockRuntimeStatus> {
  if (!isDesktop) {
    return {
      xboxAppInstalled: true,
      gamingServicesInstalled: true,
      minecraftUwpInstalled: true,
      wingetAvailable: true,
      ready: true,
    };
  }
  return invoke<BedrockRuntimeStatus>("auto_provision_bedrock_runtime");
}

export async function checkBedrockBootDependencies(
  force?: boolean,
): Promise<BedrockFullDependencyReport> {
  if (!isDesktop) {
    return {
      allSatisfied: true,
      developerMode: true,
      vcRedistX64: true,
      gamingServices: true,
      xboxApp: true,
      uwpClient: true,
      items: [],
    };
  }
  return invoke<BedrockFullDependencyReport>("check_bedrockboot_dependencies", { force });
}

export async function autoFixBedrockBootDependencies(): Promise<BedrockFullDependencyReport> {
  if (!isDesktop) {
    return {
      allSatisfied: true,
      developerMode: true,
      vcRedistX64: true,
      gamingServices: true,
      xboxApp: true,
      uwpClient: true,
      items: [],
    };
  }
  return invoke<BedrockFullDependencyReport>("auto_fix_bedrockboot_dependencies");
}

export async function enableBedrockDeveloperMode(): Promise<void> {
  if (!isDesktop) return;
  return invoke<void>("enable_bedrock_developer_mode");
}

export async function autoInstallBdsFallback(versionId: string, root?: string): Promise<string> {
  if (!isDesktop) return "Demo BDS 核心安装成功";
  return invoke<string>("auto_install_bds_fallback", { versionId, root });
}

export async function getBedrockLoaders(
  mcVersion: string,
): Promise<BedrockLoadersCatalog> {
  if (!isDesktop) return demoGetBedrockLoaders(mcVersion);
  return invoke<BedrockLoadersCatalog>("get_bedrock_loaders", { mcVersion });
}

export async function installBedrockLoader(
  versionId: string,
  loaderType: string,
  loaderVersion: string,
  root?: string,
): Promise<string> {
  if (!isDesktop) return demoInstallBedrockLoader(versionId, loaderType, loaderVersion);
  return invoke<string>("install_bedrock_loader", {
    versionId,
    loaderType,
    loaderVersion,
    root,
  });
}

export async function getBedrockMods(
  versionId: string,
  root?: string,
): Promise<BedrockModItem[]> {
  if (!isDesktop) return demoGetBedrockMods(versionId);
  return invoke<BedrockModItem[]>("get_bedrock_mods", { versionId, root });
}

export async function toggleBedrockMod(
  versionId: string,
  modId: string,
  enabled: boolean,
  root?: string,
): Promise<void> {
  if (!isDesktop) return demoToggleBedrockMod(versionId, modId, enabled);
  return invoke<void>("toggle_bedrock_mod", { versionId, modId, enabled, root });
}

export async function deleteBedrockMod(
  versionId: string,
  modId: string,
  root?: string,
): Promise<void> {
  if (!isDesktop) return demoDeleteBedrockMod(versionId, modId);
  return invoke<void>("delete_bedrock_mod", { versionId, modId, root });
}

export async function installBedrockModFile(
  versionId: string,
  filePath: string,
  root?: string,
): Promise<string> {
  if (!isDesktop) return demoInstallBedrockModFile(versionId, filePath);
  return invoke<string>("install_bedrock_mod_file", { versionId, filePath, root });
}

export async function getJavaMods(
  versionId: string,
  root?: string,
): Promise<JavaModItem[]> {
  if (!isDesktop) return [];
  return invoke<JavaModItem[]>("get_java_mods", { versionId, root });
}

export async function toggleJavaMod(
  versionId: string,
  fileName: string,
  enabled: boolean,
  root?: string,
): Promise<void> {
  if (!isDesktop) return;
  return invoke<void>("toggle_java_mod", { versionId, fileName, enabled, root });
}

export async function deleteJavaMod(
  versionId: string,
  fileName: string,
  root?: string,
): Promise<void> {
  if (!isDesktop) return;
  return invoke<void>("delete_java_mod", { versionId, fileName, root });
}

export async function installJavaModFile(
  versionId: string,
  filePath: string,
  root?: string,
): Promise<string> {
  if (!isDesktop) return "模拟安装成功";
  return invoke<string>("install_java_mod_file", { versionId, filePath, root });
}

