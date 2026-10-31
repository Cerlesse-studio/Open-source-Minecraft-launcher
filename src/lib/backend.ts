import { invoke, isDesktop, listen } from "./desktop";
export { isDesktop } from "./desktop";
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
  demoEmit,
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
  LanBridgeInfo,
  LoaderSelection,
  LocalIpv6Address,
  MinecraftHostStatus,
  MsAccount,
  MsDeviceCode,
  MsLoginPoll,
  MultiplayerConfig,
  MultiplayerFirewallStatus,
  MultiplayerInstallState,
  MultiplayerLogPayload,
  MultiplayerPeer,
  MultiplayerStatus,
  RoomResources,
  RoomResourcesInfo,
  SearchContentResult,
  SystemInfo,
  WikiEntry,
  VersionIsolation,
  VersionLoadersCatalog,
  VersionManifest,
} from "./types";


export interface LauncherEventMap {
  "install:progress": InstallProgress;
  "game:log": GameLogPayload;
  "game:status": GameStatus;
  "game:exit": GameExitPayload;
  "multiplayer:status": MultiplayerStatus;
  "multiplayer:log": MultiplayerLogPayload;
  "multiplayer:install": MultiplayerInstallState;
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

/** Read a custom home page (HTML) from disk; desktop builds only. */
export async function readHomePageFile(path: string): Promise<string> {
  if (!isDesktop) {
    throw new Error("浏览器预览模式无法读取本地文件，请在桌面版中使用。");
  }
  return invoke<string>("read_home_page_file", { path });
}

/**
 * Fetch an online home page as text. The desktop build asks Rust for it so the
 * request is not subject to webview CORS; the browser preview falls back to a
 * plain fetch, which only works for hosts that allow it.
 */
export async function fetchHomePage(url: string): Promise<string> {
  if (isDesktop) return invoke<string>("fetch_home_page", { url });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.text();
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
 * The desktop build hands the URL to the OS through the desktop command so the
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

/**
 * Whether Bedrock should boot the offline core or the signed-in Store client.
 * Pushed from the app whenever the account changes so every launch button —
 * home, version list, download page — agrees without prop plumbing.
 */
let bedrockOfflineAccount: boolean | null = null;

export function setBedrockAccountMode(signedIn: boolean): void {
  bedrockOfflineAccount = !signedIn;
}

export async function launchBedrock(
  versionId?: string,
  root?: string,
  offlineAccount?: boolean,
  playerName?: string,
): Promise<string> {
  const offline =
    offlineAccount ??
    (bedrockOfflineAccount !== null
      ? bedrockOfflineAccount
      : localStorage.getItem("osml.offlineMode") === "1");
  if (!isDesktop) return demoLaunchBedrock();
  return invoke<string>("launch_bedrock", {
    versionId,
    root,
    offlineAccount: offline,
    playerName,
  });
}

// ---------------------------------------------------------------------------
// Microsoft account
// ---------------------------------------------------------------------------

/** Preview builds keep the demo account in localStorage so the UI can be
 * exercised (sign in, both-edition badges, sign out) without a real login. */
const DEMO_ACCOUNT_KEY = "cobble.demo.account";
let demoLoginPolls = 0;

function demoMsAccount(): MsAccount | null {
  try {
    const raw = localStorage.getItem(DEMO_ACCOUNT_KEY);
    return raw ? (JSON.parse(raw) as MsAccount) : null;
  } catch {
    return null;
  }
}

function demoStoreAccount(account: MsAccount | null): void {
  try {
    if (account) localStorage.setItem(DEMO_ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(DEMO_ACCOUNT_KEY);
  } catch {
    // Preview only; storage may be unavailable.
  }
}

/** Step 1: ask Microsoft for the short code the user types in a browser. */
export async function beginMsLogin(clientId?: string): Promise<MsDeviceCode> {
  if (!isDesktop) {
    demoLoginPolls = 0;
    return {
      userCode: "DEMO-CODE",
      deviceCode: "demo-device-code",
      verificationUri: "https://microsoft.com/link",
      verificationUriComplete: "https://microsoft.com/link?otc=DEMO-CODE",
      expiresIn: 900,
      interval: 5,
      message: "预览模式：把下面的代码填进微软登录页即可（不会真的登录）。",
    };
  }
  return invoke<MsDeviceCode>("ms_login_begin", { clientId });
}

/**
 * Opens the Microsoft sign-in page in a launcher-owned window.
 *
 * Unlike the system browser (which is usually already signed into a Microsoft
 * account and then locks the page to that address), this window runs on the
 * launcher's own clean session, so the login form always allows typing any
 * account e-mail.
 */
export async function openMsLoginWindow(url: string): Promise<void> {
  if (!isDesktop) {
    window.open(url, "ms-login", "popup,width=520,height=720");
    return;
  }
  await invoke("open_login_window", { url });
}

/** Closes the launcher's sign-in window after a finished or cancelled login. */
export async function closeMsLoginWindow(): Promise<void> {
  if (!isDesktop) return;
  await invoke("close_login_window");
}

/** Step 2: poll until the user finished; the backend then stores the account. */
export async function pollMsLogin(
  deviceCode: string,
  clientId?: string,
): Promise<MsLoginPoll> {
  if (!isDesktop) {
    demoLoginPolls += 1;
    if (demoLoginPolls < 3) return { state: "pending", message: null, account: null };
    const now = Math.floor(Date.now() / 1000);
    const account: MsAccount = {
      signedIn: true,
      clientId: clientId || "demo-client-id",
      uuid: "069a79f444e94726a5befca90e38aaf5",
      name: "Steve",
      skinUrl: null,
      xuid: "2535410000000000",
      entitlements: {
        java: true,
        bedrock: true,
        gamePass: false,
        items: ["product_minecraft", "product_minecraft_bedrock"],
      },
      sessionExpiresAt: now + 86_400,
      refreshExpiresAt: now + 3600,
      sessionError: null,
    };
    demoStoreAccount(account);
    return { state: "success", message: null, account };
  }
  return invoke<MsLoginPoll>("ms_login_poll", { deviceCode, clientId });
}

/** The stored account, renewed by the backend when its session expired. */
export async function getMsAccount(clientId?: string): Promise<MsAccount | null> {
  if (!isDesktop) return demoMsAccount();
  return invoke<MsAccount | null>("get_ms_account", { clientId });
}

export async function signOutMsAccount(): Promise<void> {
  if (!isDesktop) {
    demoStoreAccount(null);
    return;
  }
  await invoke("ms_sign_out");
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

// ---------------------------------------------------------------------------
// 联机（EasyTier）
// ---------------------------------------------------------------------------

/** Preview builds keep a plausible node in memory so the page can be walked
 * through in a browser without downloading anything. */
let demoMultiplayerStatus: MultiplayerStatus = {
  installed: false,
  version: null,
  running: false,
  networkName: null,
  overlayIpv4: null,
  pid: null,
  corePath: null,
};
const demoLanBridges = new Map<number, LanBridgeInfo>();
let demoBridgePort = 25570;
/** 预览环境的成员列表，形状与真实 `easytier-cli` 输出一致。 */
let demoMultiplayerPeers: MultiplayerPeer[] = [];
let demoFirewallReady = false;
let demoRoomVersion = "1.21.8";

/** 预览环境的房间资源快照：形状与房主后端返回的一致。 */
function demoRoomResources(versionId: string): RoomResources {
  const item = (name: string, size: number, enabled = true) => ({
    name,
    fileName: name,
    enabled,
    size,
  });
  return {
    versionId: versionId || demoRoomVersion,
    mods: [
      item("Fabric API", 2_214_912),
      item("Sodium", 1_842_176),
      item("Lithium", 684_032),
      item("Iris Shaders", 1_261_568),
      item("Just Enough Items", 3_108_864),
      item("Create", 8_912_896),
      item("AppleSkin", 148_480),
      item("Old Combat Tweak", 92_160, false),
    ],
    shaders: [
      item("Complementary Reimagined", 12_582_912),
      item("BSL Shaders", 9_437_184),
      item("MakeUp Ultra Fast", 4_194_304),
      item("Sildur's Basic", 2_097_152, false),
    ],
    resourcePacks: [
      item("Faithful 32x", 27_262_976),
      item("Fresh Animations", 18_874_368),
      item("Stay True", 6_291_456, false),
    ],
    updatedAt: Date.now(),
  };
}
let demoInstallState: MultiplayerInstallState = {
  active: false,
  stage: "",
  detail: "",
  doneBytes: 0,
  totalBytes: 0,
  speedBps: 0,
  threads: 0,
  version: "",
  error: null,
  startedAt: 0,
  finishedAt: null,
  resumable: false,
  partialBytes: 0,
};

function demoPushMultiplayerStatus(): void {
  demoEmit("multiplayer:status", { ...demoMultiplayerStatus });
}

const demoWait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export async function getMultiplayerStatus(root?: string): Promise<MultiplayerStatus> {
  if (!isDesktop) return { ...demoMultiplayerStatus };
  return invoke<MultiplayerStatus>("get_multiplayer_status", { root: root ?? "" });
}

export async function getMultiplayerPeers(root?: string): Promise<MultiplayerPeer[]> {
  if (!isDesktop) return demoMultiplayerPeers.map((peer) => ({ ...peer }));
  return invoke<MultiplayerPeer[]>("get_multiplayer_peers", { root: root ?? "" });
}

export async function getMultiplayerFirewallStatus(
  root: string,
  listenPort: number,
  hostPort: number,
  overlayIpv4: string,
): Promise<MultiplayerFirewallStatus> {
  if (!isDesktop) {
    return {
      supported: true,
      ready: demoFirewallReady,
      detail: demoFirewallReady ? "预览模式：规则已模拟放行" : "",
    };
  }
  return invoke<MultiplayerFirewallStatus>("get_multiplayer_firewall_status", {
    root,
    listenPort,
    hostPort,
    overlayIpv4,
  });
}

export async function setupMultiplayerFirewall(
  root: string,
  listenPort: number,
  hostPort: number,
  overlayIpv4: string,
): Promise<MultiplayerFirewallStatus> {
  if (!isDesktop) {
    await demoWait(550);
    demoFirewallReady = true;
    return { supported: true, ready: true, detail: "预览模式：规则已模拟放行" };
  }
  return invoke<MultiplayerFirewallStatus>("setup_multiplayer_firewall", {
    root,
    listenPort,
    hostPort,
    overlayIpv4,
  });
}

export async function getMultiplayerInstallState(
  root?: string,
): Promise<MultiplayerInstallState> {
  if (!isDesktop) return { ...demoInstallState };
  return invoke<MultiplayerInstallState>("get_multiplayer_install_state", {
    root: root ?? "",
  });
}

export async function installEasytier(root?: string): Promise<MultiplayerStatus> {
  if (!isDesktop) {
    demoInstallState = {
      ...demoInstallState,
      active: true,
      stage: "download",
      detail: "正在下载 EasyTier v2.6.4（预览）",
      doneBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      threads: 16,
      version: "2.6.4",
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      resumable: true,
      partialBytes: 0,
    };
    demoEmit("multiplayer:install", { ...demoInstallState });
    await demoWait(900);
    demoInstallState = {
      ...demoInstallState,
      active: false,
      stage: "done",
      detail: "EasyTier v2.6.4 已就绪",
      doneBytes: 1,
      totalBytes: 1,
      speedBps: 0,
      finishedAt: Date.now(),
      resumable: false,
      partialBytes: 0,
    };
    demoEmit("multiplayer:install", { ...demoInstallState });
    demoMultiplayerStatus = {
      ...demoMultiplayerStatus,
      installed: true,
      version: "v2.6.4",
      corePath: "C:\\demo\\easytier\\easytier-core.exe",
    };
    demoPushMultiplayerStatus();
    return { ...demoMultiplayerStatus };
  }
  return invoke<MultiplayerStatus>("install_easytier", { root: root ?? "" });
}

export async function startMultiplayer(
  root: string,
  config: MultiplayerConfig,
): Promise<MultiplayerStatus> {
  if (!isDesktop) {
    demoMultiplayerStatus = {
      ...demoMultiplayerStatus,
      running: true,
      networkName: config.networkName,
      overlayIpv4: config.overlayIpv4,
      pid: 4212,
    };
    demoEmit("multiplayer:log", {
      stream: "cobble",
      line: `启动 EasyTier（模拟）· 虚拟地址 ${config.overlayIpv4}`,
    });
    demoMultiplayerPeers =
      config.peers.length > 0
        ? [
            {
              hostname: "Cobble-Guest",
              ipv4: config.overlayIpv4,
              latencyMs: 0,
              cost: "local",
              tunnel: "udp",
              isSelf: true,
            },
            {
              hostname: "MCTier-Host",
              ipv4: config.hostIpv4 || "10.126.126.5",
              latencyMs: 12,
              cost: "p2p",
              tunnel: "udp",
              isSelf: false,
            },
          ]
        : [
            {
              hostname: "Cobble-Host",
              ipv4: config.overlayIpv4,
              latencyMs: 0,
              cost: "local",
              tunnel: "udp",
              isSelf: true,
            },
            {
              hostname: "MCTier-Studio",
              ipv4: "10.126.126.7",
              latencyMs: 18,
              cost: "p2p",
              tunnel: "udp",
              isSelf: false,
            },
          ];
    demoPushMultiplayerStatus();
    return { ...demoMultiplayerStatus };
  }
  return invoke<MultiplayerStatus>("start_multiplayer", { root, config });
}

/** 房主启动只读资源清单服务；重复调用会复用同一个端口。 */
export async function startRoomResources(
  root: string,
  versionId: string,
  isolation: VersionIsolation,
  secret: string,
  token: string,
  port: number,
  hostPort: number,
): Promise<RoomResourcesInfo> {
  if (!isDesktop) {
    await demoWait(320);
    demoRoomVersion = versionId || demoRoomVersion;
    return {
      port: 25670,
      token: token || "demo-room-resource-token",
      resources: demoRoomResources(demoRoomVersion),
    };
  }
  return invoke<RoomResourcesInfo>("start_room_resources", {
    root,
    versionId,
    isolation,
    secret,
    token,
    port,
    hostPort,
  });
}

/** 访客通过虚拟网络读取房主的资源清单。 */
export async function fetchRoomResources(
  host: string,
  port: number,
  token: string,
): Promise<RoomResources> {
  if (!isDesktop) {
    await demoWait(420);
    return demoRoomResources(demoRoomVersion);
  }
  return invoke<RoomResources>("fetch_room_resources", { host, port, token });
}

export async function stopMultiplayer(root?: string): Promise<MultiplayerStatus> {
  if (!isDesktop) {
    demoMultiplayerStatus = {
      ...demoMultiplayerStatus,
      running: false,
      networkName: null,
      overlayIpv4: null,
      pid: null,
    };
    demoLanBridges.clear();
    demoMultiplayerPeers = [];
    demoEmit("multiplayer:log", { stream: "cobble", line: "EasyTier 已停止（模拟）" });
    demoPushMultiplayerStatus();
    return { ...demoMultiplayerStatus };
  }
  return invoke<MultiplayerStatus>("stop_multiplayer", { root: root ?? "" });
}

export async function getLocalIpv6Addresses(): Promise<LocalIpv6Address[]> {
  if (!isDesktop) {
    return [
      { address: "240e:3b5:7a2c:1f60:8d21:44c7:1b0a:9f3e", interface: "WLAN", global: true, temporary: false },
      { address: "240e:3b5:7a2c:1f60:1c2a:9b3e:57d0:4a11", interface: "WLAN", global: true, temporary: true },
      { address: "fd7a:115c:a1e0::1", interface: "Tailscale", global: false, temporary: false },
    ];
  }
  return invoke<LocalIpv6Address[]>("get_local_ipv6_addresses");
}

/** 直接探测房主的 EasyTier 监听端口，不依赖缓存的成员路由。 */
export async function probeMultiplayerEndpoint(peer: string): Promise<boolean | null> {
  if (!isDesktop) {
    await demoWait(180);
    return peer.trim() ? true : null;
  }
  return invoke<boolean | null>("probe_multiplayer_endpoint", { peer });
}

/** 读取本次启动的 Minecraft 日志里「对局域网开放」的端口。 */
export async function readMinecraftLanPort(
  root: string,
  versionId: string,
  isolation?: VersionIsolation,
): Promise<number | null> {
  if (!isDesktop) return null;
  return invoke<number | null>("read_minecraft_lan_port", {
    root,
    versionId,
    isolation: isolation ?? null,
  });
}

export async function probeMinecraftHost(
  host: string,
  port: number,
): Promise<MinecraftHostStatus> {
  if (!isDesktop) {
    await demoWait(420);
    if (!host.trim()) {
      return {
        ok: false,
        motd: "",
        version: "",
        online: 0,
        max: 0,
        latencyMs: 0,
        error: "地址不能为空",
      };
    }
    return {
      ok: true,
      motd: "好友的生存世界",
      version: "1.21.8",
      online: 2,
      max: 8,
      latencyMs: 38,
      error: null,
    };
  }
  return invoke<MinecraftHostStatus>("probe_minecraft_host", { host, port });
}

export async function startLanBridge(
  host: string,
  port: number,
  motd?: string,
): Promise<LanBridgeInfo> {
  if (!isDesktop) {
    demoBridgePort += 1;
    const info: LanBridgeInfo = {
      host,
      port,
      localPort: demoBridgePort,
      connectAddress: `127.0.0.1:${demoBridgePort}`,
    };
    demoLanBridges.set(info.localPort, info);
    demoEmit("multiplayer:log", {
      stream: "cobble",
      line: `已在局域网广播 ${host}:${port}（模拟）`,
    });
    return info;
  }
  return invoke<LanBridgeInfo>("start_lan_bridge", { host, port, motd });
}

export async function stopLanBridge(localPort: number): Promise<boolean> {
  if (!isDesktop) return demoLanBridges.delete(localPort);
  return invoke<boolean>("stop_lan_bridge", { localPort });
}

