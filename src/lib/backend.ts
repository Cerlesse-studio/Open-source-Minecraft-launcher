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
  demoGetBedrockPacks,
  demoSetBedrockPackEnabled,
  demoDeleteBedrockPack,
  demoImportBedrockPackFile,
} from "./demo";
import type {
  BedrockContentItem,
  BedrockFullDependencyReport,
  BedrockLoadersCatalog,
  BedrockModItem,
  BedrockPackItem,
  BedrockRuntimeStatus,
  BedrockStatus,
  BedrockVersionItem,
  BedrockWorldItem,
  ContentProjectType,
  ContentVersionItem,
  DownloadContentRequest,
  DownloadContentResult,
  DownloadSourceId,
  DownloadSourceProbe,
  GameExitPayload,
  GameLogPayload,
  GameStatus,
  InstallPackResult,
  InstallProgress,
  InstallResult,
  InstalledVersion,
  JavaInstall,
  JavaModItem,
  JavaPackItem,
  JavaWorldItem,
  LaunchRequest,
  LoaderSelection,
  SearchContentResult,
  SystemInfo,
  WikiEntry,
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

/** Push the chosen Java download source into the Rust side so the mirror
 * ordering used by downloads matches the settings page. */
export async function setDownloadPreference(
  source: DownloadSourceId,
  customUrl?: string,
  threads = 16,
): Promise<void> {
  if (!isDesktop) return;
  await invoke("set_download_preference", {
    source,
    customUrl: customUrl || null,
    threads,
  });
}

/** Time each source's version-manifest request. Demo mode returns plausible
 * numbers so the settings page can be exercised in a browser. */
export async function probeDownloadSources(
  customUrl?: string,
): Promise<DownloadSourceProbe[]> {
  if (!isDesktop) {
    await new Promise((resolve) => setTimeout(resolve, 550));
    const probes: DownloadSourceProbe[] = [
      { source: "official_ap", ok: true, latencyMs: 238 },
      { source: "bmclapi", ok: true, latencyMs: 46 },
    ];
    if (customUrl?.trim()) {
      probes.push({ source: "custom", ok: true, latencyMs: 89 });
    }
    return probes;
  }
  return invoke<DownloadSourceProbe[]>("probe_download_sources", {
    customUrl: customUrl?.trim() || null,
  });
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

/**
 * Open an http(s) link in the default browser.
 *
 * The desktop build hands the URL to the OS through the Tauri command so the
 * link leaves the webview; the browser preview (demo mode) just opens a tab.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isDesktop) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_url", { url });
}

/**
 * Resolve the MC 百科 page of a Java project.
 *
 * The backend searches mcmod.cn and only accepts an entry whose English name
 * matches the project, so `null` means "no exact page" — the UI then links the
 * site's search page instead of a possibly unrelated mod page.
 */
export async function resolveMcmodEntry(
  title: string,
  slug: string,
  projectType: ContentProjectType,
): Promise<WikiEntry | null> {
  if (!isDesktop) return null;
  return invoke<WikiEntry | null>("resolve_mcmod_entry", {
    title,
    slug,
    projectType,
  });
}

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
  // TEMP-VERIFY
  if (!isDesktop)
    return [
      {
        id: "xaerominimap",
        name: "Xaero's Minimap",
        fileName: "xaerominimap-forge-1.21.8-26.6.0.jar",
        path: "",
        enabled: true,
        size: 2154725,
        modifiedTime: "2026-10-26 00:59",
        version: "26.6.0",
        description: "The most vanilla-looking minimap for Minecraft.",
        modLoader: "Forge",
        iconDataUrl: "https://cdn.modrinth.com/data/1IjD5062/icon.png",
      },
      {
        id: "jei",
        name: "Just Enough Items",
        fileName: "jei-1.21.1-19.2.0.2.jar.disabled",
        path: "",
        enabled: false,
        size: 1345678,
        modifiedTime: "2026-10-25 12:04",
        version: "19.2.0.2",
        description: "",
        modLoader: "Fabric",
        iconDataUrl: "https://cdn.modrinth.com/data/u6dRKJwZ/4a3f18ac0d096c9f8e9176984c44be4e58f94c89_96.webp",
      },
      {
        id: "create",
        name: "Create",
        fileName: "create-1.20.1-0.5.1.f.jar",
        path: "",
        enabled: true,
        size: 8765432,
        modifiedTime: "2026-10-24 09:12",
        version: "0.5.1.f",
        description: "Aesthetic technology mod with kinetic power and automation.",
        modLoader: "NeoForge",
        iconDataUrl: null,
      },
    ];
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

/**
 * Java resource packs and saves live in the game directory the instance is
 * launched with, so every call carries the version isolation mode: turning
 * isolation off points the manager back at the shared root folder.
 */
export async function getJavaResourcePacks(
  versionId: string,
  isolation?: string,
  root?: string,
): Promise<JavaPackItem[]> {
  if (!isDesktop) {
    return [
      {
        id: "Faithful32x.zip",
        name: "Faithful 32x",
        fileName: "Faithful32x.zip",
        path: "",
        enabled: true,
        size: 18_334_208,
        modifiedTime: "2026-10-25 21:12",
        description: "A double-resolution texture pack that keeps the vanilla look.",
        packFormat: 34,
        iconDataUrl: null,
        isDir: false,
      },
      {
        id: "Stay_True",
        name: "Stay True",
        fileName: "Stay_True",
        path: "",
        enabled: false,
        size: 42_991_616,
        modifiedTime: "2026-10-23 10:40",
        description: "干净柔和的写实风格材质包。",
        packFormat: 22,
        iconDataUrl: null,
        isDir: true,
      },
    ];
  }
  return invoke<JavaPackItem[]>("get_java_resource_packs", {
    versionId,
    isolation,
    root,
  });
}

export async function toggleJavaResourcePack(
  versionId: string,
  fileName: string,
  enabled: boolean,
  isolation?: string,
  root?: string,
): Promise<void> {
  if (!isDesktop) return;
  return invoke<void>("toggle_java_resource_pack", {
    versionId,
    fileName,
    enabled,
    isolation,
    root,
  });
}

export async function deleteJavaResourcePack(
  versionId: string,
  fileName: string,
  isolation?: string,
  root?: string,
): Promise<void> {
  if (!isDesktop) return;
  return invoke<void>("delete_java_resource_pack", {
    versionId,
    fileName,
    isolation,
    root,
  });
}

export async function installJavaResourcePackFile(
  versionId: string,
  filePath: string,
  isolation?: string,
  root?: string,
): Promise<string> {
  if (!isDesktop) return "模拟导入成功";
  return invoke<string>("install_java_resource_pack_file", {
    versionId,
    filePath,
    isolation,
    root,
  });
}

export async function getJavaWorlds(
  versionId: string,
  isolation?: string,
  root?: string,
): Promise<JavaWorldItem[]> {
  if (!isDesktop) {
    return [
      {
        id: "新的世界",
        name: "新的世界",
        folder: "新的世界",
        path: "",
        size: 27_512_832,
        modifiedTime: "2026-10-26 09:18",
        iconDataUrl: null,
      },
      {
        id: "Skyblock",
        name: "空岛生存",
        folder: "Skyblock",
        path: "",
        size: 64_225_280,
        modifiedTime: "2026-10-24 23:51",
        iconDataUrl: null,
      },
    ];
  }
  return invoke<JavaWorldItem[]>("get_java_worlds", { versionId, isolation, root });
}

export async function deleteJavaWorld(
  versionId: string,
  folder: string,
  isolation?: string,
  root?: string,
): Promise<void> {
  if (!isDesktop) return;
  return invoke<void>("delete_java_world", { versionId, folder, isolation, root });
}

export async function installJavaWorldFile(
  versionId: string,
  filePath: string,
  isolation?: string,
  root?: string,
): Promise<string> {
  if (!isDesktop) return "模拟导入成功";
  return invoke<string>("install_java_world_file", {
    versionId,
    filePath,
    isolation,
    root,
  });
}

/**
 * Bedrock packs live in `com.mojang` (resource/behavior/skin packs), not in a
 * Java `versions/<id>/mods` folder, so they get their own manager commands.
 */
export async function getBedrockPacks(root?: string): Promise<BedrockPackItem[]> {
  if (!isDesktop) return demoGetBedrockPacks();
  return invoke<BedrockPackItem[]>("get_bedrock_packs", { root });
}

export async function setBedrockPackEnabled(
  path: string,
  enabled: boolean,
  root?: string,
): Promise<void> {
  if (!isDesktop) return demoSetBedrockPackEnabled(path, enabled);
  return invoke<void>("set_bedrock_pack_enabled", { path, enabled, root });
}

export async function deleteBedrockPack(
  path: string,
  root?: string,
): Promise<void> {
  if (!isDesktop) return demoDeleteBedrockPack(path);
  return invoke<void>("delete_bedrock_pack", { path, root });
}

export async function importBedrockPackFile(
  filePath: string,
  root?: string,
): Promise<InstallPackResult> {
  if (!isDesktop) return demoImportBedrockPackFile(filePath);
  return invoke<InstallPackResult>("import_bedrock_pack_file", { filePath, root });
}

/** Bedrock worlds are stored next to the packs, one folder per world. */
export async function getBedrockWorlds(root?: string): Promise<BedrockWorldItem[]> {
  if (!isDesktop) {
    return [
      {
        id: "SkyblockBedrock",
        name: "空岛生存",
        folder: "SkyblockBedrock",
        path: "",
        size: 88_604_672,
        modifiedTime: "2026-10-25 19:02:11",
        icon: null,
        location: "启动器便携目录",
        locationPath: "",
      },
      {
        id: "SurvivalBedrock",
        name: "生存世界",
        folder: "SurvivalBedrock",
        path: "",
        size: 210_763_776,
        modifiedTime: "2026-10-21 13:44:09",
        icon: null,
        location: "UWP 客户端",
        locationPath: "",
      },
    ];
  }
  return invoke<BedrockWorldItem[]>("get_bedrock_worlds", { root });
}

export async function deleteBedrockWorld(path: string, root?: string): Promise<void> {
  if (!isDesktop) return;
  return invoke<void>("delete_bedrock_world", { path, root });
}

export async function importBedrockWorldFile(
  filePath: string,
  root?: string,
): Promise<InstallPackResult> {
  if (!isDesktop) return demoImportBedrockPackFile(filePath);
  return invoke<InstallPackResult>("import_bedrock_world_file", { filePath, root });
}

