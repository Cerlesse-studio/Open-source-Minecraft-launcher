use crate::net;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockStatus {
    pub uwp_installed: bool,
    pub standalone_installed: bool,
    pub com_mojang_path: String,
    pub portable_path: String,
    pub resource_packs_count: usize,
    pub behavior_packs_count: usize,
    pub worlds_count: usize,
    pub installed_versions: Vec<String>,
    /// Version folders that exist but are not usable cores (aborted downloads,
    /// empty directories). They used to be invisible in the UI, which also made
    /// them impossible to delete.
    #[serde(default)]
    pub leftover_versions: Vec<String>,
    #[serde(default)]
    pub version_details: Vec<BedrockInstalledVersionDetail>,
    #[serde(default)]
    pub runtime_status: Option<BedrockRuntimeStatus>,
    #[serde(default)]
    pub full_dependency_report: Option<BedrockFullDependencyReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BedrockInstalledVersionDetail {
    pub id: String,
    pub name: String,
    pub is_server: bool,
    pub package_file: Option<String>,
    pub package_type: Option<String>,
    pub is_gdk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BedrockDependencyItem {
    pub key: String,
    pub name: String,
    pub required: bool,
    pub installed: bool,
    pub version: Option<String>,
    pub min_version: Option<String>,
    pub fix_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BedrockFullDependencyReport {
    pub all_satisfied: bool,
    pub developer_mode: bool,
    pub vc_redist_x64: bool,
    pub gaming_services: bool,
    pub xbox_app: bool,
    pub uwp_client: bool,
    pub items: Vec<BedrockDependencyItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockPackItem {
    /// Manifest UUID when readable, otherwise the folder name.
    pub id: String,
    pub name: String,
    pub description: String,
    /// `resource` | `behavior` | `skin` | `template`
    pub pack_type: String,
    pub version: String,
    /// `min_engine_version` from the manifest, e.g. `1.21.0`.
    #[serde(default)]
    pub engine_version: Option<String>,
    pub path: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub modified_time: String,
    /// `pack_icon.png` inlined as a data URL: the webview needs no asset scope.
    #[serde(default)]
    pub icon: Option<String>,
    /// Which `com.mojang` folder this copy lives in.
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub location_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockVersionItem {
    pub id: String,
    pub name: String,
    pub version: String,
    pub release_type: String, // "release" | "preview" | "server"
    pub download_url: String,
    pub store_url: Option<String>,
    pub date: String,
    pub size: u64,
    pub sha256: Option<String>,
    pub api_source: Option<String>,
    #[serde(default)]
    pub build_type: Option<String>, // "GDK" | "UWP" | "BDS"
    #[serde(default)]
    pub md5: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockContentItem {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub content_type: String, // "shader" | "mod" | "resourcepack"
    pub download_url: String,
    pub file_name: String,
    pub icon_url: Option<String>,
    pub tags: Vec<String>,
    pub downloads: u64,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPackResult {
    pub success: bool,
    pub pack_name: String,
    pub pack_type: String,
    pub target_path: String,
    pub message: String,
    /// Lowest engine version the pack declares (`min_engine_version`), when it
    /// declares one. The UI uses it to explain why an old core ignores a pack.
    #[serde(default)]
    pub engine_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockLoaderItem {
    pub name: String,
    pub version: String,
    pub loader_type: String, // "levilamina" | "amethyst"
    pub compatible_mc_version: String,
    pub download_url: String,
    pub description: String,
    pub release_time: Option<String>,
    pub stable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BedrockLoadersCatalog {
    pub mc_version: String,
    pub levilamina: Vec<BedrockLoaderItem>,
    pub amethyst: Vec<BedrockLoaderItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockModItem {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub path: String,
    pub mod_type: String, // "levilamina_plugin" | "dll_mod" | "behavior_pack" | "resource_pack"
    pub enabled: bool,
    pub inject_delay: u64,
    pub is_pre_load: bool,
    pub size: u64,
    pub modified_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BedrockInstanceLoaderConfig {
    pub loader_type: Option<String>,
    pub loader_version: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// Path Discovery & Detection
// ---------------------------------------------------------------------------

pub fn get_uwp_mojang_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        // 1. BedrockBoot-DM / Bedrock 1.21.120+ GDK shared data directory
        if let Ok(appdata) = std::env::var("APPDATA") {
            let gdk = PathBuf::from(appdata)
                .join("Minecraft Bedrock")
                .join("users")
                .join("shared")
                .join("games")
                .join("com.mojang");
            if gdk.is_dir() {
                return Some(gdk);
            }
        }

        // 2. UWP Release path
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let uwp = PathBuf::from(&local_appdata)
                .join("Packages")
                .join("Microsoft.MinecraftUWP_8wekyb3d8bbwe")
                .join("LocalState")
                .join("games")
                .join("com.mojang");
            if uwp.is_dir() {
                return Some(uwp);
            }

            // 3. UWP Preview / Beta path
            let preview = PathBuf::from(local_appdata)
                .join("Packages")
                .join("Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe")
                .join("LocalState")
                .join("games")
                .join("com.mojang");
            if preview.is_dir() {
                return Some(preview);
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            let home_path = PathBuf::from(home);
            for sub in [
                ".local/share/mcpelauncher/games/com.mojang",
                ".var/app/io.mrarm.mcpelauncher/data/mcpelauncher/games/com.mojang",
                "Library/Application Support/mcpelauncher/games/com.mojang",
                "Library/Application Support/MinecraftBedrock/games/com.mojang",
                ".minecraft-bedrock/games/com.mojang",
            ] {
                let candidate = home_path.join(sub);
                if candidate.is_dir() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

static UWP_CACHE: std::sync::Mutex<Option<(Instant, bool)>> = std::sync::Mutex::new(None);

/// A real Microsoft Store client — not the launcher's own development-mode
/// deployment, and not an empty `%LOCALAPPDATA%\Packages\...` data folder.
///
/// The previous check accepted any of those, so a locally deployed core (or a
/// folder the launcher created while installing packs) showed up in the version
/// list as a second, unlaunchable "Minecraft for Windows (正版 UWP)" entry.
#[cfg(target_os = "windows")]
fn store_client_installed() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    for name in ["Microsoft.MinecraftUWP", "Microsoft.MinecraftWindowsBeta"] {
        let script = format!(
            "$p = Get-AppxPackage -Name '{name}' | Where-Object {{ -not $_.IsDevelopmentMode }} | Select-Object -First 1; if ($p) {{ $p.InstallLocation }}"
        );
        let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        else {
            continue;
        };
        let location = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if location.is_empty() {
            continue;
        }
        // Loose-Appx cores deployed by this launcher live under
        // `<game_root>\bedrock\versions\<id>`; they are listed separately.
        let lower = location.to_lowercase().replace('/', "\\");
        if lower.contains("\\bedrock\\versions\\") {
            continue;
        }
        if Path::new(&location).is_dir() {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
fn store_client_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        if Path::new("/Applications/MCPELauncher.app").is_dir() {
            return true;
        }
        if let Ok(home) = std::env::var("HOME") {
            if PathBuf::from(home).join("Applications/MCPELauncher.app").is_dir() {
                return true;
            }
        }
    }

    for bin in ["/usr/bin/mcpelauncher-client", "/usr/local/bin/mcpelauncher-client", "/opt/homebrew/bin/mcpelauncher-client"] {
        if Path::new(bin).is_file() {
            return true;
        }
    }

    if let Ok(output) = Command::new("which").arg("mcpelauncher-client").output() {
        if output.status.success() && !output.stdout.is_empty() {
            return true;
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(home) = std::env::var("HOME") {
            if PathBuf::from(home).join(".var/app/io.mrarm.mcpelauncher").is_dir() {
                return true;
            }
        }
    }

    get_uwp_mojang_dir().is_some()
}

pub fn is_uwp_installed() -> bool {
    if let Ok(guard) = UWP_CACHE.lock() {
        if let Some((timestamp, cached_val)) = *guard {
            if timestamp.elapsed() < std::time::Duration::from_secs(30) {
                return cached_val;
            }
        }
    }

    let installed = store_client_installed();

    if let Ok(mut guard) = UWP_CACHE.lock() {
        *guard = Some((Instant::now(), installed));
    }
    installed
}

#[derive(Debug, Clone, Default)]
pub struct BedrockVersionInspection {
    pub is_valid: bool,
    pub folder_name: String,
    pub version_id: String,
    pub display_name: String,
    pub main_executable: Option<PathBuf>,
    pub manifest_path: Option<PathBuf>,
    pub is_server: bool,
    pub package_file: Option<PathBuf>,
}

pub fn resolve_bedrock_version_dir(root: &Path, version_id: &str) -> PathBuf {
    let clean = version_id
        .trim()
        .trim_start_matches("bedrock:")
        .trim_start_matches("Minecraft 基岩版:")
        .trim_start_matches("Minecraft 基岩版 ")
        .trim_start_matches("基岩版 ")
        .trim();
    let base = root.join("bedrock").join("versions");
    if base.join(clean).is_dir() {
        return base.join(clean);
    }
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == clean || name.starts_with(clean) || clean.starts_with(&name) {
                    return p;
                }
                let vjson = p.join("version.json");
                if vjson.is_file() {
                    if let Ok(text) = std::fs::read_to_string(&vjson) {
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                                if id == clean || id.starts_with(clean) || clean.starts_with(id) {
                                    return p;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    base.join(clean)
}

pub fn inspect_bedrock_version_dir(dir: &Path) -> BedrockVersionInspection {
    let mut insp = BedrockVersionInspection::default();
    if !dir.is_dir() {
        return insp;
    }

    let folder_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    insp.folder_name = folder_name.clone();
    insp.version_id = folder_name.clone();
    insp.display_name = format!("Minecraft 基岩版 {folder_name}");

    // 1. Check version.json if present
    let version_json_path = dir.join("version.json");
    if version_json_path.is_file() {
        if let Ok(text) = std::fs::read_to_string(&version_json_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(id) = val.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        insp.version_id = id.to_string();
                    }
                }
                if let Some(name) = val.get("name").and_then(|v| v.as_str()) {
                    if !name.is_empty() {
                        insp.display_name = name.to_string();
                    }
                }
                if let Some(pkg) = val.get("packageFile").and_then(|v| v.as_str()) {
                    let p = dir.join(pkg);
                    if p.is_file() {
                        insp.package_file = Some(p);
                    }
                }
                insp.is_valid = true;
            }
        }
    }

    // 2. Scan root of dir for standard executables and manifests
    let root_client = dir.join("Minecraft.Windows.exe");
    let root_mc_exe = dir.join("Minecraft.exe");
    let root_server = dir.join("bedrock_server.exe");
    let root_linux_server = dir.join("bedrock_server");
    let root_mcpelauncher = dir.join("mcpelauncher-client");
    let root_mac_app = dir.join("MCPELauncher.app").join("Contents").join("MacOS").join("mcpelauncher-client");
    let root_manifest = dir.join("AppxManifest.xml");
    let root_bundle_manifest = dir.join("AppxBundleManifest.xml");

    if root_manifest.is_file() {
        insp.manifest_path = Some(root_manifest);
        insp.is_valid = true;
    } else if root_bundle_manifest.is_file() {
        insp.manifest_path = Some(root_bundle_manifest);
        insp.is_valid = true;
    }

    if root_client.is_file() {
        insp.main_executable = Some(root_client);
        insp.is_server = false;
        insp.is_valid = true;
    } else if root_mc_exe.is_file() {
        insp.main_executable = Some(root_mc_exe);
        insp.is_server = false;
        insp.is_valid = true;
    } else if root_server.is_file() {
        insp.main_executable = Some(root_server);
        insp.is_server = true;
        insp.is_valid = true;
    } else if root_linux_server.is_file() {
        insp.main_executable = Some(root_linux_server);
        insp.is_server = true;
        insp.is_valid = true;
    } else if root_mcpelauncher.is_file() {
        insp.main_executable = Some(root_mcpelauncher);
        insp.is_server = false;
        insp.is_valid = true;
    } else if root_mac_app.is_file() {
        insp.main_executable = Some(root_mac_app);
        insp.is_server = false;
        insp.is_valid = true;
    }

    // 3. Scan subdirectories (depth 1 to 2) if not found in root
    if insp.main_executable.is_none() || insp.manifest_path.is_none() {
        if let Ok(sub_entries) = std::fs::read_dir(dir) {
            for sub_entry in sub_entries.flatten() {
                if sub_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let sub_path = sub_entry.path();
                    let sub_name = sub_entry.file_name().to_string_lossy().to_string();
                    if sub_name == "mods" || sub_name == "worlds" || sub_name == "cache" {
                        continue;
                    }

                    let sub_client = sub_path.join("Minecraft.Windows.exe");
                    let sub_mc_exe = sub_path.join("Minecraft.exe");
                    let sub_server = sub_path.join("bedrock_server.exe");
                    let sub_linux_server = sub_path.join("bedrock_server");
                    let sub_mcpelauncher = sub_path.join("mcpelauncher-client");
                    let sub_manifest = sub_path.join("AppxManifest.xml");

                    if insp.manifest_path.is_none() && sub_manifest.is_file() {
                        insp.manifest_path = Some(sub_manifest);
                        insp.is_valid = true;
                    }
                    if insp.main_executable.is_none() {
                        if sub_client.is_file() {
                            insp.main_executable = Some(sub_client);
                            insp.is_server = false;
                            insp.is_valid = true;
                        } else if sub_mc_exe.is_file() {
                            insp.main_executable = Some(sub_mc_exe);
                            insp.is_server = false;
                            insp.is_valid = true;
                        } else if sub_server.is_file() {
                            insp.main_executable = Some(sub_server);
                            insp.is_server = true;
                            insp.is_valid = true;
                        } else if sub_linux_server.is_file() {
                            insp.main_executable = Some(sub_linux_server);
                            insp.is_server = true;
                            insp.is_valid = true;
                        } else if sub_mcpelauncher.is_file() {
                            insp.main_executable = Some(sub_mcpelauncher);
                            insp.is_server = false;
                            insp.is_valid = true;
                        }
                    }
                }
            }
        }
    }

    // 4. Look for packages in root or subdirectories: *.appx, *.msix, *.msixvc, *.insPack
    if !insp.is_valid || insp.package_file.is_none() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let ext = p
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if ext == "appx"
                        || ext == "msix"
                        || ext == "msixvc"
                        || ext == "inspack"
                        || ext == "zip"
                    {
                        if insp.package_file.is_none() {
                            insp.package_file = Some(p);
                        }
                        insp.is_valid = true;
                    } else if ext == "exe" && insp.main_executable.is_none() {
                        insp.main_executable = Some(p);
                        insp.is_valid = true;
                    }
                }
            }
        }
    }

    insp
}

pub fn get_bedrock_status(game_root: &Path) -> BedrockStatus {
    let uwp_installed = is_uwp_installed();
    let portable_dir = portable_mojang_dir(game_root);
    let data_dirs = bedrock_game_data_dirs(game_root);

    // Prefer a real client folder; the portable folder is only a staging area.
    let portable_key = portable_dir.to_string_lossy().to_lowercase();
    let active_dir = data_dirs
        .iter()
        .find(|dir| dir.to_string_lossy().to_lowercase() != portable_key)
        .cloned()
        .unwrap_or_else(|| portable_dir.clone());

    // Counts are merged by identity: one pack installed into several data
    // folders is still one pack to the user.
    let packs = get_bedrock_packs(game_root);
    let resource_packs_count = packs
        .iter()
        .filter(|pack| pack.pack_type == "resource")
        .count();
    let behavior_packs_count = packs
        .iter()
        .filter(|pack| pack.pack_type == "behavior")
        .count();
    let worlds_count = get_bedrock_worlds(game_root).len();

    // Check installed versions in <game_root>/bedrock/versions
    let bedrock_versions_dir = game_root.join("bedrock").join("versions");
    let mut installed_versions = Vec::new();
    let mut leftover_versions = Vec::new();
    let mut version_details = Vec::new();
    let mut standalone_installed = false;
    if let Ok(entries) = std::fs::read_dir(&bedrock_versions_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().to_string();
                let dir = entry.path();
                let insp = inspect_bedrock_version_dir(&dir);
                if insp.is_valid {
                    standalone_installed = true;
                    // One entry per folder: that is the id every launcher path
                    // resolves and launches. Adding the manifest version as a
                    // second id used to list the same core twice, and the extra
                    // row pointed at a `versions/<manifest version>` folder that
                    // does not exist, so it could never start.
                    if !installed_versions.contains(&name) {
                        installed_versions.push(name.clone());
                    }

                    let pkg_ext = insp.package_file.as_ref().and_then(|p| {
                        p.extension()
                            .and_then(|s| s.to_str())
                            .map(|s| s.to_lowercase())
                    });
                    let is_gdk = pkg_ext.as_deref() == Some("msixvc");
                    let package_type = if is_gdk {
                        Some("msixvc".to_string())
                    } else if let Some(ref ext) = pkg_ext {
                        Some(ext.clone())
                    } else if insp.is_server {
                        Some("bds".to_string())
                    } else if insp.main_executable.is_some() {
                        Some("exe".to_string())
                    } else {
                        None
                    };

                    version_details.push(BedrockInstalledVersionDetail {
                        id: if !insp.version_id.is_empty() {
                            insp.version_id
                        } else {
                            name.clone()
                        },
                        name: if insp.display_name.is_empty() {
                            name
                        } else {
                            insp.display_name
                        },
                        is_server: insp.is_server,
                        package_file: insp.package_file.map(|p| {
                            p.file_name()
                                .unwrap_or_default()
                                .to_string_lossy()
                                .to_string()
                        }),
                        package_type,
                        is_gdk,
                    });
                } else {
                    leftover_versions.push(name);
                }
            }
        }
    }

    let runtime_status = RUNTIME_CACHE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(_, s)| s.clone()));
    let full_dependency_report = DEPENDENCY_CACHE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(_, s)| s.clone()));

    BedrockStatus {
        uwp_installed,
        standalone_installed,
        com_mojang_path: active_dir.to_string_lossy().to_string(),
        portable_path: portable_dir.to_string_lossy().to_string(),
        resource_packs_count,
        behavior_packs_count,
        worlds_count,
        installed_versions,
        leftover_versions,
        version_details,
        runtime_status,
        full_dependency_report,
    }
}

// ---------------------------------------------------------------------------
// Versions & Curated Marketplace
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct BdsRegistryResponse {
    #[serde(default)]
    release: Option<EndstoneGroup>,
    #[serde(default)]
    preview: Option<EndstoneGroup>,
    #[serde(default)]
    windows: Option<BdsPlatformGroup>,
}

#[derive(Debug, Clone, Deserialize)]
struct EndstoneGroup {
    #[allow(dead_code)]
    latest: Option<String>,
    versions: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct BdsPlatformGroup {
    #[allow(dead_code)]
    stable: Option<String>,
    #[allow(dead_code)]
    preview: Option<String>,
    versions: Option<Vec<String>>,
}

impl BdsRegistryResponse {
    fn into_items(self, source_name: &str) -> Vec<BedrockVersionItem> {
        let mut items = Vec::new();
        let mut seen = std::collections::HashSet::new();

        if let Some(rel) = self.release {
            if let Some(versions) = rel.versions {
                for v in versions {
                    if seen.insert(v.clone()) {
                        items.push(BedrockVersionItem {
                            id: v.clone(),
                            name: format!("Minecraft 基岩版 {v}"),
                            version: v.clone(),
                            release_type: "release".to_string(),
                            download_url: format!(
                                "https://minecraft.azureedge.net/bin-win/bedrock-server-{v}.zip"
                            ),
                            store_url: Some(
                                "ms-windows-store://pdp/?ProductId=9NBLGGH537BL".to_string(),
                            ),
                            date: "第三方 API 同步".to_string(),
                            size: 85_983_232,
                            sha256: None,
                            api_source: Some(source_name.to_string()),
                            build_type: Some("BDS".to_string()),
                            md5: None,
                        });
                    }
                }
            }
        }

        if let Some(prev) = self.preview {
            if let Some(versions) = prev.versions {
                for v in versions {
                    if seen.insert(v.clone()) {
                        items.push(BedrockVersionItem {
                            id: v.clone(),
                            name: format!("Minecraft 基岩预览版 {v}"),
                            version: v.clone(),
                            release_type: "preview".to_string(),
                            download_url: format!(
                                "https://minecraft.azureedge.net/bin-win/bedrock-server-{v}.zip"
                            ),
                            store_url: Some(
                                "ms-windows-store://pdp/?ProductId=9P5X4QVLC2XR".to_string(),
                            ),
                            date: "预览测试版".to_string(),
                            size: 89_128_960,
                            sha256: None,
                            api_source: Some(source_name.to_string()),
                            build_type: Some("BDS".to_string()),
                            md5: None,
                        });
                    }
                }
            }
        }

        if let Some(win) = self.windows {
            if let Some(versions) = win.versions {
                for v in versions {
                    if seen.insert(v.clone()) {
                        let is_preview = v.contains("preview") || v.starts_with("1.21.70");
                        items.push(BedrockVersionItem {
                            id: v.clone(),
                            name: if is_preview {
                                format!("Minecraft 基岩预览版 {v}")
                            } else {
                                format!("Minecraft 基岩版 {v}")
                            },
                            version: v.clone(),
                            release_type: if is_preview {
                                "preview".to_string()
                            } else {
                                "release".to_string()
                            },
                            download_url: format!(
                                "https://minecraft.azureedge.net/bin-win/bedrock-server-{v}.zip"
                            ),
                            store_url: Some(
                                "ms-windows-store://pdp/?ProductId=9NBLGGH537BL".to_string(),
                            ),
                            date: "BDS-Versions 同步".to_string(),
                            size: 85_983_232,
                            sha256: None,
                            api_source: Some("Bedrock-OSS BDS".to_string()),
                            build_type: Some("BDS".to_string()),
                            md5: None,
                        });
                    }
                }
            }
        }

        items
    }
}

fn get_cache_file_path() -> PathBuf {
    std::env::temp_dir().join("oml_bedrock_versions_cache.json")
}

fn load_cached_versions() -> Option<Vec<BedrockVersionItem>> {
    let p = get_cache_file_path();
    if let Ok(content) = std::fs::read_to_string(&p) {
        if let Ok(items) = serde_json::from_str::<Vec<BedrockVersionItem>>(&content) {
            if !items.is_empty() {
                return Some(items);
            }
        }
    }
    None
}

fn save_cached_versions(items: &[BedrockVersionItem]) {
    if items.is_empty() {
        return;
    }
    let p = get_cache_file_path();
    if let Ok(json) = serde_json::to_string(items) {
        let _ = std::fs::write(p, json);
    }
}

pub fn get_curated_fallback_versions() -> Vec<BedrockVersionItem> {
    let verified_builds: &[(&str, &str, &str, &str, &str, Option<&str>)] = &[
        ("26.70.21", "Minecraft 基岩预览版 1.26.7021", "2026-10-20", "preview", "http://assets1.xboxlive.cn/4/2ec63a1c-595c-4b79-acec-8d13f783d395/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.7021.0.d5dbdada-38e9-474e-8f33-f2bb9d37aff8/Microsoft.MinecraftWindowsBeta_1.26.7021.0_x64__8wekyb3d8bbwe.msixvc", Some("7d6c6efe364426c0899b60607054fb3a")),
        ("26.70.20", "Minecraft 基岩预览版 1.26.7020", "2026-10-13", "preview", "http://assets1.xboxlive.cn/1/2bffe360-a2f7-4fd4-ab62-cdb0cc85c535/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.7020.0.0a6991c3-7935-48eb-a853-04178fbac6e9/Microsoft.MinecraftWindowsBeta_1.26.7020.0_x64__8wekyb3d8bbwe.msixvc", Some("9a43da62dbb0ae04dfc0cd5b421282b2")),
        ("26.60.30", "Minecraft 基岩预览版 1.26.6030", "2026-10-06", "preview", "http://assets1.xboxlive.cn/8/ed0240a7-6a36-4676-a49c-ecaf4a80f982/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.6030.0.b2297db8-27de-4a6d-91bf-8d751cdf17c2/Microsoft.MinecraftWindowsBeta_1.26.6030.0_x64__8wekyb3d8bbwe.msixvc", Some("8710a04f17d13850d51c2186d3e7acfd")),
        ("26.60.29", "Minecraft 基岩预览版 1.26.6029", "2026-09-30", "preview", "http://assets1.xboxlive.cn/3/b8193333-7971-4a88-97a4-1427a7409238/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.6029.0.5844aa77-d936-4fca-be4d-eebcb663f4fd/Microsoft.MinecraftWindowsBeta_1.26.6029.0_x64__8wekyb3d8bbwe.msixvc", Some("2ae2a647dd5e1afea1197852aecb4349")),
        ("26.60.28", "Minecraft 基岩预览版 1.26.6028", "2026-09-22", "preview", "http://assets1.xboxlive.cn/2/f19a5cb5-d3aa-44d0-bed0-1ae2225fe1c5/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.6028.0.4e2edfd9-aa74-4022-b39e-ec5877b72aa4/Microsoft.MinecraftWindowsBeta_1.26.6028.0_x64__8wekyb3d8bbwe.msixvc", Some("465b439fef1704b80ff28a1a8e2d4d53")),
        ("26.60.24", "Minecraft 基岩预览版 1.26.6024", "2026-09-16", "preview", "http://assets1.xboxlive.cn/2/f0110d2e-8abe-4f4f-8d6b-cd629bcbe8b6/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.6024.0.e0aceea1-5f55-4010-a1d8-d08a2a68411f/Microsoft.MinecraftWindowsBeta_1.26.6024.0_x64__8wekyb3d8bbwe.msixvc", Some("67562f5c5b097f7a29e94f7ca70b9b5f")),
        ("26.60.22", "Minecraft 基岩预览版 1.26.6022", "2026-09-08", "preview", "http://assets1.xboxlive.cn/7/ee270b73-26e1-41f3-8715-997b4c460dc2/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.6022.0.1a5c8da3-b363-4887-95ff-38da3add0837/Microsoft.MinecraftWindowsBeta_1.26.6022.0_x64__8wekyb3d8bbwe.msixvc", Some("e63aff478924670f1c6289c6074b1e1b")),
        ("26.60.21", "Minecraft 基岩预览版 1.26.6021", "2026-09-02", "preview", "http://assets1.xboxlive.cn/Z/847dd1ec-63c3-4d62-bc52-9869a94c6e8a/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.6021.0.33e14b09-4990-4484-8726-cde80dad7aeb/Microsoft.MinecraftWindowsBeta_1.26.6021.0_x64__8wekyb3d8bbwe.msixvc", Some("fb3e9b5bc32e1cda9a62b74cb903c226")),
        ("26.52", "Minecraft 基岩版 1.26.5203", "2026-09-25", "release", "http://assets1.xboxlive.cn/Z/80c6fe1f-3d12-47fe-ace0-1406ce1bc3c6/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.5203.0.8faf62df-3520-469d-9462-64acfbabde93/Microsoft.MinecraftUWP_1.26.5203.0_x64__8wekyb3d8bbwe.msixvc", Some("bfa350ce68510f1263e308e5bcae369f")),
        ("26.51", "Minecraft 基岩版 1.26.5101", "2026-09-15", "release", "http://assets1.xboxlive.cn/10/5e9a91e8-88d2-4e34-8751-0180989ce008/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.5101.0.20150e80-9196-49cc-af90-b8cf9902a48a/Microsoft.MinecraftUWP_1.26.5101.0_x64__8wekyb3d8bbwe.msixvc", Some("ba41aee910a8579bd1f78e3297d07ab4")),
        ("26.50.27", "Minecraft 基岩预览版 1.26.5027", "2026-08-25", "preview", "http://assets1.xboxlive.cn/Z/2d958585-77c7-411c-bac3-dac3e1d6bae4/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.5027.0.17615f0c-b7ed-42fa-b24e-1d9339eee1f4/Microsoft.MinecraftWindowsBeta_1.26.5027.0_x64__8wekyb3d8bbwe.msixvc", Some("b946cc57cc344d9a3e70ee10bf9b13bd")),
        ("26.50.26", "Minecraft 基岩预览版 1.26.5026", "2026-08-18", "preview", "http://assets1.xboxlive.cn/1/a925bd0b-2b43-4ee5-8627-6b01424db621/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.5026.0.db9f683a-2750-420f-9f4a-671779cf8e16/Microsoft.MinecraftWindowsBeta_1.26.5026.0_x64__8wekyb3d8bbwe.msixvc", Some("1fa5523b79b427c922ecf732514032d0")),
        ("26.50.25", "Minecraft 基岩预览版 1.26.5025", "2026-08-11", "preview", "http://assets1.xboxlive.cn/2/11f8409a-f5ad-45c8-b948-e9303038072b/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.5025.0.e34bda0f-58d9-438f-b880-d566784d0960/Microsoft.MinecraftWindowsBeta_1.26.5025.0_x64__8wekyb3d8bbwe.msixvc", Some("70c109678dbcd836ee204f1a02d16c78")),
        ("26.50.24", "Minecraft 基岩预览版 1.26.5024", "2026-08-05", "preview", "http://assets1.xboxlive.cn/13/004d6e48-ccbd-48df-a84b-a7e0f9701d63/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.5024.0.03c4fb17-2396-469a-9332-a641028d55e1/Microsoft.MinecraftWindowsBeta_1.26.5024.0_x64__8wekyb3d8bbwe.msixvc", Some("a8d886b4fd2744f9c1b1c3e896c870b1")),
        ("26.50.22", "Minecraft 基岩预览版 1.26.5022", "2026-07-28", "preview", "http://assets1.xboxlive.cn/6/f172ff25-7185-4237-96a1-ba5d2f76e4e8/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.5022.0.0a7be581-3f98-4a7e-8ea6-fd3bb21ff55d/Microsoft.MinecraftWindowsBeta_1.26.5022.0_x64__8wekyb3d8bbwe.msixvc", Some("990436628facc1a80236b4ed7d68a182")),
        ("26.50.20", "Minecraft 基岩预览版 1.26.5020", "2026-07-21", "preview", "http://assets1.xboxlive.cn/4/2a7b3957-be08-4f41-8830-51ac401772ba/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.5020.0.a8c0f83b-1c78-4cb9-a5b4-a6a848545bac/Microsoft.MinecraftWindowsBeta_1.26.5020.0_x64__8wekyb3d8bbwe.msixvc", Some("703e5b4e53dd3e9592aee7188e651903")),
        ("26.50", "Minecraft 基岩版 1.26.5004", "2026-09-15", "release", "http://assets1.xboxlive.cn/15/889f0637-a9a1-481d-a019-789cfa3c8350/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.5004.0.4df08a0f-ae5b-4ad1-8260-c6e0294856ab/Microsoft.MinecraftUWP_1.26.5004.0_x64__8wekyb3d8bbwe.msixvc", Some("d10018a435dbe00a1da8cc411ebf309f")),
        ("26.45", "Minecraft 基岩版 1.26.4501", "2026-08-28", "release", "http://assets1.xboxlive.cn/Z/8a3dfbab-b161-470f-8b42-c94f0b4f8f6f/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.4501.0.8f39f343-cd87-4b76-8994-dc8310fc2f06/Microsoft.MinecraftUWP_1.26.4501.0_x64__8wekyb3d8bbwe.msixvc", Some("a0f488255a72400d20ae2203656f308f")),
        ("26.44", "Minecraft 基岩版 1.26.4403", "2026-08-14", "release", "http://assets1.xboxlive.cn/Z/343b46e3-cf8d-4d07-b95d-97578788d4ff/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.4403.0.c576ef1b-0106-4b07-82d9-441f5b2eb985/Microsoft.MinecraftUWP_1.26.4403.0_x64__8wekyb3d8bbwe.msixvc", Some("91a5abae9202d9746f5411a5fe4dfa97")),
        ("26.42", "Minecraft 基岩版 1.26.4201", "2026-08-07", "release", "http://assets1.xboxlive.cn/13/c385ae75-5cc0-4140-9b1f-7c24b8ec799b/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.4201.0.4c345687-4f56-4eb5-b66f-4460f2f0fa62/Microsoft.MinecraftUWP_1.26.4201.0_x64__8wekyb3d8bbwe.msixvc", Some("2896d795878490d0eb6ef725c0dcde8e")),
        ("26.40.31", "Minecraft 基岩预览版 1.26.4031", "2026-07-14", "preview", "http://assets1.xboxlive.cn/Z/226869fb-b691-4d44-bf42-e07a24fb9efb/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.4031.0.4b249979-15fc-47fa-96fa-53929cdc6267/Microsoft.MinecraftWindowsBeta_1.26.4031.0_x64__8wekyb3d8bbwe.msixvc", Some("2a09745c992484da45bef545f1039a60")),
        ("26.40.30", "Minecraft 基岩预览版 1.26.4030", "2026-07-07", "preview", "http://assets1.xboxlive.cn/7/6de89d20-a43b-4b1d-9e7c-6e570e9e1f74/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.4030.0.0cb9011a-a256-459e-803f-c8c97ff2869c/Microsoft.MinecraftWindowsBeta_1.26.4030.0_x64__8wekyb3d8bbwe.msixvc", Some("9f4b40e9404f1c79f3f030cb469b4f12")),
        ("26.40.27", "Minecraft 基岩预览版 1.26.4027", "2026-06-23", "preview", "http://assets1.xboxlive.cn/8/7c21123c-3eab-488e-9227-e61fd272a0f9/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.4027.0.29737025-1779-436b-a042-7b1bc46a05df/Microsoft.MinecraftWindowsBeta_1.26.4027.0_x64__8wekyb3d8bbwe.msixvc", Some("8b789a4f197bd3ec9dc919df3769d9d3")),
        ("26.40.26", "Minecraft 基岩预览版 1.26.4026", "2026-06-17", "preview", "http://assets1.xboxlive.cn/14/b971d9f7-85b2-4703-8495-f607b39ab2d2/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.4026.0.a5d7d68d-b235-45d9-a631-c4e9dab78a54/Microsoft.MinecraftWindowsBeta_1.26.4026.0_x64__8wekyb3d8bbwe.msixvc", Some("ad3c52bae7bdf8089fc0691918019096")),
        ("26.40.22", "Minecraft 基岩预览版 1.26.4022", "2026-06-10", "preview", "http://assets1.xboxlive.cn/14/84273643-82d9-461c-97ec-92f42a785118/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.4022.0.d1afad30-ca3c-4d2f-94b5-ab05c898cb98/Microsoft.MinecraftWindowsBeta_1.26.4022.0_x64__8wekyb3d8bbwe.msixvc", Some("0af35178d4c508847384bdbe86e35205")),
        ("26.40.20", "Minecraft 基岩预览版 1.26.4020", "2026-06-02", "preview", "http://assets1.xboxlive.cn/6/a60447f4-1922-4e8f-8540-411000a6ef52/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.4020.0.b658fe3c-0983-44e2-bea3-231ab1384313/Microsoft.MinecraftWindowsBeta_1.26.4020.0_x64__8wekyb3d8bbwe.msixvc", Some("95092c66a0bc6b5d71d4c8ad6a3f3ee0")),
        ("26.40", "Minecraft 基岩版 1.26.4005", "2026-08-04", "release", "http://assets1.xboxlive.cn/4/126a2a46-2f8e-407b-80f2-8560a63ce023/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.4005.0.4c2b83a6-6147-4006-aa1b-1f494f17e026/Microsoft.MinecraftUWP_1.26.4005.0_x64__8wekyb3d8bbwe.msixvc", Some("ed596f043f77a602f0067bb97ede8899")),
        ("26.33", "Minecraft 基岩版 1.26.3301", "2026-07-09", "release", "http://assets1.xboxlive.cn/10/1e7d62c3-960f-4386-81b1-1789edc683d1/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.3301.0.2a4af946-1668-404e-8cc0-cb081f69103a/Microsoft.MinecraftUWP_1.26.3301.0_x64__8wekyb3d8bbwe.msixvc", Some("11dad2ffbb1612650ef5449fdb6a91e6")),
        ("26.32", "Minecraft 基岩版 1.26.3202", "2026-06-25", "release", "http://assets1.xboxlive.cn/9/db5d4795-9b25-4cd1-989e-7024300cbe18/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.3202.0.ec30be1b-5dc1-4b43-85a8-c717dcf363d9/Microsoft.MinecraftUWP_1.26.3202.0_x64__8wekyb3d8bbwe.msixvc", Some("13c5c890c639f822348d871976bfa5f5")),
        ("26.31", "Minecraft 基岩版 1.26.3101", "2026-06-19", "release", "http://assets1.xboxlive.cn/6/d449f74e-9ff0-4ea6-82e5-21fc53f8d40d/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.3101.0.12b6a1df-e792-4168-b7ed-4ee580f26c7d/Microsoft.MinecraftUWP_1.26.3101.0_x64__8wekyb3d8bbwe.msixvc", Some("ad911c23cdb735a44d775c13c3531aac")),
        ("26.30.32", "Minecraft 基岩预览版 1.26.3032", "2026-05-26", "preview", "http://assets1.xboxlive.cn/8/21d722cf-ec80-4f01-b806-51e7f620fcec/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.3032.0.c6f09ba1-0569-4167-8349-27e9155949ad/Microsoft.MinecraftWindowsBeta_1.26.3032.0_x64__8wekyb3d8bbwe.msixvc", Some("fced02ad87c6c99ad441de4d681aeeae")),
        ("26.30.29", "Minecraft 基岩预览版 1.26.3029", "2026-05-19", "preview", "http://assets1.xboxlive.cn/10/ef077752-be17-46ad-809f-fab7174a49a4/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.3029.0.38f295a8-df0a-4692-9d48-53af71dfccc0/Microsoft.MinecraftWindowsBeta_1.26.3029.0_x64__8wekyb3d8bbwe.msixvc", Some("5e93e7906fd4e262df4b37f0ed8e4532")),
        ("26.30.28", "Minecraft 基岩预览版 1.26.3028", "2026-05-12", "preview", "http://assets1.xboxlive.cn/6/9382dd60-5f58-4738-8bc4-d0c2f128ea8b/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.3028.0.6948466a-9bff-4fa9-b2a4-be4c3f7fda02/Microsoft.MinecraftWindowsBeta_1.26.3028.0_x64__8wekyb3d8bbwe.msixvc", Some("104675cf76ae27d60faaad743d4a8054")),
        ("26.30.27", "Minecraft 基岩预览版 1.26.3027", "2026-05-06", "preview", "http://assets1.xboxlive.cn/12/e8a63b9f-cf11-4321-a555-f2f0c7608678/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.3027.0.24047402-b4a4-41c1-ad0f-7d7107fe9c81/Microsoft.MinecraftWindowsBeta_1.26.3027.0_x64__8wekyb3d8bbwe.msixvc", Some("126a14512860a6817b01e7a7948b6ad0")),
        ("26.30.25", "Minecraft 基岩预览版 1.26.3025", "2026-04-30", "preview", "http://assets1.xboxlive.cn/11/1dcfebae-a93b-4f91-a04a-35ad02ea1c8e/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.3025.0.3137c69c-0310-47b9-adfe-8068008e2a32/Microsoft.MinecraftWindowsBeta_1.26.3025.0_x64__8wekyb3d8bbwe.msixvc", Some("aec5db8a611e419ee4bbaa6e73cb0f84")),
        ("26.30.20", "Minecraft 基岩预览版 1.26.3020", "2026-04-21", "preview", "http://assets1.xboxlive.cn/1/c612bb96-0cb8-4855-a922-3e8771fdc863/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.3020.0.00b7c5c1-b6ba-46fc-a0d7-36afc4a9956c/Microsoft.MinecraftWindowsBeta_1.26.3020.0_x64__8wekyb3d8bbwe.msixvc", Some("9e68e792a83ef04dcbec4939d5701d7a")),
        ("26.30", "Minecraft 基岩版 1.26.3005", "2026-06-16", "release", "http://assets1.xboxlive.cn/12/480484ea-7b1c-4443-b152-411e07e1329d/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.3005.0.48bff00d-cff7-4432-8d1e-662d92be1b14/Microsoft.MinecraftUWP_1.26.3005.0_x64__8wekyb3d8bbwe.msixvc", Some("b58b9b8d19ba0b5e65309a8fad741a14")),
        ("26.21", "Minecraft 基岩版 1.26.2101", "2026-05-14", "release", "http://assets1.xboxlive.cn/10/2e8b0dcb-b4db-43fa-b65e-115c50b2ecb9/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.2101.0.a7c55ac8-a285-4f26-8c0c-42692fae7385/MICROSOFT.MINECRAFTUWP_1.26.2101.0_x64__8wekyb3d8bbwe.msixvc", Some("463ec59ba177e156232b906fd5650a33")),
        ("26.20.27", "Minecraft 基岩预览版 1.26.2027", "2026-04-14", "preview", "http://assets1.xboxlive.cn/Z/4215e89e-22ab-4be3-9e37-0ed8ff10f265/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.2027.0.b190ee0d-e343-435a-b833-c6eddcb6c340/Microsoft.MinecraftWindowsBeta_1.26.2027.0_x64__8wekyb3d8bbwe.msixvc", Some("f83fb35d9a66dadede198d76c0637de5")),
        ("26.20.26", "Minecraft 基岩预览版 1.26.2026", "2026-04-08", "preview", "http://assets1.xboxlive.cn/14/effc0e3a-5070-468a-8212-733e7fb4bec5/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.2026.0.f5da1a06-3175-4b56-be3b-971d2f6ba90a/Microsoft.MinecraftWindowsBeta_1.26.2026.0_x64__8wekyb3d8bbwe.msixvc", Some("f35b444f94df3b8732f174dbe6c3f2b9")),
        ("26.20.23", "Minecraft 基岩预览版 1.26.2023", "2026-03-31", "preview", "http://assets1.xboxlive.cn/3/cf17f409-bf46-48ca-9b2d-d7b82bcb0b4d/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.2023.0.f228e3b2-97f2-46af-aa2c-66830d53e828/Microsoft.MinecraftWindowsBeta_1.26.2023.0_x64__8wekyb3d8bbwe.msixvc", Some("79a7d1f4d6435a6821d5fb1727f470d3")),
        ("26.20.22", "Minecraft 基岩预览版 1.26.2022", "2026-03-25", "preview", "http://assets1.xboxlive.cn/7/fdcd1bc9-328c-46d8-82b6-013b032ee927/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.2022.0.3adf24eb-5003-4bc3-8475-6a3a4f228d04/Microsoft.MinecraftWindowsBeta_1.26.2022.0_x64__8wekyb3d8bbwe.msixvc", Some("a9fc97c9be3c58868e4ded7e56d6f46b")),
        ("26.20.21", "Minecraft 基岩预览版 1.26.2021", "2026-03-17", "preview", "http://assets1.xboxlive.cn/8/8b87fe8e-5634-4c87-bd34-0314e4e066b3/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.2021.0.b446899f-6b80-44da-b907-ce4f2ce089ab/Microsoft.MinecraftWindowsBeta_1.26.2021.0_x64__8wekyb3d8bbwe.msixvc", Some("636167b24fa5db339891dbf6cd3b92bd")),
        ("26.20.20", "Minecraft 基岩预览版 1.26.2020", "2026-03-10", "preview", "http://assets1.xboxlive.cn/Z/c8428042-5476-48ad-bf6d-46c76122d5ed/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.2020.0.d7b1b26a-ce59-4f6a-8ceb-e311b785a066/Microsoft.MinecraftWindowsBeta_1.26.2020.0_x64__8wekyb3d8bbwe.msixvc", Some("0756ade3f9b67ea14f61bc5718d7452a")),
        ("26.20", "Minecraft 基岩版 1.26.2004", "2026-05-05", "release", "http://assets1.xboxlive.cn/2/86daedd1-ddc7-44ef-99a3-112e2ccceb27/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.2004.0.3328906d-f8ed-4fc5-936d-a59522fe5e8f/MICROSOFT.MINECRAFTUWP_1.26.2004.0_x64__8wekyb3d8bbwe.msixvc", Some("10c214dc667bf3d334eb82fd9f6ce5d0")),
        ("26.13", "Minecraft 基岩版 1.26.1301", "2026-04-06", "release", "http://assets1.xboxlive.cn/4/3e8e0782-5c66-4d46-963e-f430fc88cd72/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.1301.0.d7836dec-3a0f-48cd-b211-aeb7ec2b7cc3/MICROSOFT.MINECRAFTUWP_1.26.1301.0_x64__8wekyb3d8bbwe.msixvc", Some("b8c3bb7561e743980a3fd5ed93e2ec0f")),
        ("26.12", "Minecraft 基岩版 1.26.1202", "2026-04-01", "release", "http://assets1.xboxlive.cn/3/c6f987ba-e97d-4759-b001-86a1e905fde1/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.1202.0.5d6372fb-8149-4d5c-96b8-1ad1a0f039f5/MICROSOFT.MINECRAFTUWP_1.26.1202.0_x64__8wekyb3d8bbwe.msixvc", Some("8b62a806f69d1fa94ea31c5f38ee94ea")),
        ("26.11", "Minecraft 基岩版 1.26.1101", "2026-03-26", "release", "http://assets1.xboxlive.cn/14/1ce08876-7829-4fe5-8f94-6e34636da6b8/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.1101.0.fcbb70f6-904b-4da5-9236-30f4863c9bff/MICROSOFT.MINECRAFTUWP_1.26.1101.0_x64__8wekyb3d8bbwe.msixvc", Some("334a6896b349173c175eb7106d2a1c81")),
        ("26.10.26", "Minecraft 基岩预览版 1.26.1026", "2026-03-04", "preview", "http://assets1.xboxlive.cn/8/63eb397f-e60e-4851-b241-94029293ddeb/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.1026.0.f795f370-c349-455b-b332-57be7958dd39/Microsoft.MinecraftWindowsBeta_1.26.1026.0_x64__8wekyb3d8bbwe.msixvc", Some("f920f1b8ac76c1d2f4740e2d17f6c141")),
        ("26.10.25", "Minecraft 基岩预览版 1.26.1025", "2026-02-24", "preview", "http://assets1.xboxlive.cn/9/e7c6a085-9edb-4b1d-ab70-cafde689042b/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.1025.0.8ed6a550-c1df-4c76-b90c-275613125eb4/Microsoft.MinecraftWindowsBeta_1.26.1025.0_x64__8wekyb3d8bbwe.msixvc", Some("c17153d7d5c1326bf1cb95d89c6cb330")),
        ("26.10.24", "Minecraft 基岩预览版 1.26.1024", "2026-02-17", "preview", "http://assets1.xboxlive.cn/12/dd9d78e3-de88-424d-85d4-cffccd48010b/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.1024.0.0061cdab-53a1-452d-8ee1-22b28b5cc13a/Microsoft.MinecraftWindowsBeta_1.26.1024.0_x64__8wekyb3d8bbwe.msixvc", Some("2ebb78d498d510e1d445b6ba272dcf8a")),
        ("26.10.23", "Minecraft 基岩预览版 1.26.1023", "2026-02-11", "preview", "http://assets1.xboxlive.cn/14/661b2941-351d-48b2-b4d9-464feb557481/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.1023.0.6c998046-b308-4020-a651-592f6725d1ac/Microsoft.MinecraftWindowsBeta_1.26.1023.0_x64__8wekyb3d8bbwe.msixvc", Some("58971f6b4c4d46eb6b4fb1d15a9725dc")),
        ("26.10.21", "Minecraft 基岩预览版 1.26.1021", "2026-02-03", "preview", "http://assets1.xboxlive.cn/15/1d69a3cf-d0a8-4a38-ab32-8910f481b568/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.1021.0.e189f7d0-fa07-4ab1-9ecb-39f2f79ec6b0/Microsoft.MinecraftWindowsBeta_1.26.1021.0_x64__8wekyb3d8bbwe.msixvc", Some("3ee2f123a362b0f056397ca4253dce92")),
        ("26.10.20", "Minecraft 基岩预览版 1.26.1020", "2026-01-28", "preview", "http://assets1.xboxlive.cn/5/30a64eba-581a-4b1f-acd6-ab303a27013d/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.1020.0.7e6df79b-3178-4b78-86ac-708d4c4b6bff/Microsoft.MinecraftWindowsBeta_1.26.1020.0_x64__8wekyb3d8bbwe.msixvc", Some("f289a536d7e8d9bb941fd771a366ebb4")),
        ("26.10", "Minecraft 基岩版 1.26.1004", "2026-03-24", "release", "http://assets1.xboxlive.cn/12/925750b8-ef63-4a06-88de-d6c4235589b0/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.1004.0.0c28a937-2f41-49ed-b641-a246abf8e0be/MICROSOFT.MINECRAFTUWP_1.26.1004.0_x64__8wekyb3d8bbwe.msixvc", Some("7e4d94673c98bea0f29168b8a8d4236e")),
        ("26.3", "Minecraft 基岩版 1.26.301", "2026-03-02", "release", "http://assets1.xboxlive.cn/10/2ad96056-8398-4336-a406-38cc72765a4a/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.301.0.2157d268-7f78-444c-9c38-00b1bd6c901c/MICROSOFT.MINECRAFTUWP_1.26.301.0_x64__8wekyb3d8bbwe.msixvc", Some("d957631857c3d2c6e23dcc1b101278c2")),
        ("26.2", "Minecraft 基岩版 1.26.201", "2026-02-25", "release", "http://assets1.xboxlive.cn/1/d4026290-4784-446f-9823-8c46324b9a9c/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.201.0.3b9636eb-65a6-4347-a8cd-29cb04fb6d64/MICROSOFT.MINECRAFTUWP_1.26.201.0_x64__8wekyb3d8bbwe.msixvc", Some("672652c501b8c193ddee25e15aa31ef6")),
        ("26.1", "Minecraft 基岩版 1.26.101", "2026-02-19", "release", "http://assets1.xboxlive.cn/5/818fd83b-d59c-4a16-a9ec-69035f29be7d/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.101.0.aa0c35a7-1e86-440d-a49b-55309f7ff9f3/MICROSOFT.MINECRAFTUWP_1.26.101.0_x64__8wekyb3d8bbwe.msixvc", Some("a39d3d3016efbd44f8f08e72d53b4bfb")),
        ("26.0.29", "Minecraft 基岩预览版 1.26.29", "2026-01-20", "preview", "http://assets1.xboxlive.cn/4/ffb7672a-2ae3-4e7a-8fa1-9bc12bcea4db/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.29.0.41f2f0ae-9cd8-42cf-9e60-6f83d57cc0d3/Microsoft.MinecraftWindowsBeta_1.26.29.0_x64__8wekyb3d8bbwe.msixvc", Some("18a7aa4babb0832834555a2ba3da572d")),
        ("26.0.28", "Minecraft 基岩预览版 1.26.28", "2026-01-13", "preview", "http://assets1.xboxlive.cn/3/0a7b04ce-40f8-4abf-8a38-2b71c4a3d3f5/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.28.0.53c28bda-eb6d-47f7-a791-155c6bb27f68/Microsoft.MinecraftWindowsBeta_1.26.28.0_x64__8wekyb3d8bbwe.msixvc", Some("528964ecf0fa2cc329aba5ded1b76a26")),
        ("26.0.27", "Minecraft 基岩预览版 1.26.27", "2026-01-07", "preview", "http://assets1.xboxlive.cn/3/832b5f58-fff0-46d7-afe3-62f3eada2d33/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.27.0.219a6a4d-b5ae-42a4-a557-f8e6dd240acc/Microsoft.MinecraftWindowsBeta_1.26.27.0_x64__8wekyb3d8bbwe.msixvc", Some("31f02662131e374ffd0bc704fa98c53b")),
        ("26.0.26", "Minecraft 基岩预览版 1.26.26", "2025-12-17", "preview", "http://assets1.xboxlive.cn/3/86bb7d70-546f-4445-bd74-56de82ebbc99/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.26.0.18a224cd-1246-4304-a83c-7f68190c7423/Microsoft.MinecraftWindowsBeta_1.26.26.0_x64__8wekyb3d8bbwe.msixvc", Some("53106438adb98237b09ec2d0f54a2f6a")),
        ("26.0.25", "Minecraft 基岩预览版 1.26.25", "2025-12-10", "preview", "http://assets1.xboxlive.cn/7/5cba9ea8-c8fe-4881-8c16-b512a92c3588/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.25.0.0a3996fe-521b-428f-b73f-c3fe5c11fd1e/Microsoft.MinecraftWindowsBeta_1.26.25.0_x64__8wekyb3d8bbwe.msixvc", Some("1f5b6a70e6e2d038af096abb9c47a60f")),
        ("26.0.24", "Minecraft 基岩预览版 1.26.24", "2025-12-03", "preview", "http://assets1.xboxlive.cn/15/b9cdebf8-52b9-4d9b-83c6-1e1ca6a15f4f/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.26.24.0.61bfaa7b-f7cd-4cad-bb6a-783c07c3f7c5/Microsoft.MinecraftWindowsBeta_1.26.24.0_x64__8wekyb3d8bbwe.msixvc", Some("3c6116a5ca7806d3f7de7ae1dde08432")),
        ("26.0", "Minecraft 基岩版 1.26.2", "2026-02-10", "release", "http://assets1.xboxlive.cn/1/d107af1a-5006-4455-b71a-b7395465a0b9/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.26.2.0.7b0bec04-ae0d-4136-82ec-29bb9751adc7/MICROSOFT.MINECRAFTUWP_1.26.2.0_x64__8wekyb3d8bbwe.msixvc", Some("0c620d717842fc3ba7069bfb62d54165")),
        ("1.21.132", "Minecraft 基岩版 1.21.13201", "2026-01-08", "release", "http://assets1.xboxlive.cn/13/c59fd319-299a-40d1-bb2b-e6f1b96fb87a/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.21.13201.0.47219e94-fffa-4fea-b27b-b9a133750594/MICROSOFT.MINECRAFTUWP_1.21.13201.0_x64__8wekyb3d8bbwe.msixvc", Some("ec7b5d1d8f3ad0a57b56032438adec8b")),
        ("1.21.131", "Minecraft 基岩版 1.21.13101", "2025-12-16", "release", "http://assets1.xboxlive.cn/8/78fd651c-c534-4c5b-9aeb-bcc845993203/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.21.13101.0.cb540108-7a26-4ec7-81d6-5c29e54c323d/MICROSOFT.MINECRAFTUWP_1.21.13101.0_x64__8wekyb3d8bbwe.msixvc", Some("2200e45813fcf53c3c64b3ee4d9a0bfa")),
        ("1.21.130.28", "Minecraft 基岩预览版 1.21.13028", "2025-11-18", "preview", "http://assets1.xboxlive.cn/3/c96c8f5e-eec0-41b3-b9d5-7a6e260e1ae1/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.13028.0.bb956973-67ec-4403-a7ff-451a3e2d0746/Microsoft.MinecraftWindowsBeta_1.21.13028.0_x64__8wekyb3d8bbwe.msixvc", Some("6cc0e7ed28bdd9a91792b8054985a94f")),
        ("1.21.130.27", "Minecraft 基岩预览版 1.21.13027", "2025-11-11", "preview", "http://assets1.xboxlive.cn/7/9bcb9729-a886-4ff0-8a1b-2ea27294bdc6/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.13027.0.4d3d7571-540b-4ebb-9968-a301639d6c0c/Microsoft.MinecraftWindowsBeta_1.21.13027.0_x64__8wekyb3d8bbwe.msixvc", Some("2a1c40e454628b31ac3adb189538ba49")),
        ("1.21.130.26", "Minecraft 基岩预览版 1.21.13026", "2025-11-04", "preview", "http://assets1.xboxlive.cn/6/05fe140b-9d00-4bb0-9379-6060a7d87bbf/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.13026.0.e828de77-9716-42fe-81c5-a8449db51397/Microsoft.MinecraftWindowsBeta_1.21.13026.0_x64__8wekyb3d8bbwe.msixvc", Some("61f99ff02728afe0d087951c8cc428b1")),
        ("1.21.130.25", "Minecraft 基岩预览版 1.21.13025", "2025-10-31", "preview", "http://assets1.xboxlive.cn/6/64211bc6-0531-47af-a59b-a75b7494923e/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.13025.0.a9f5b019-e731-48c8-9da8-e19221c7d883/Microsoft.MinecraftWindowsBeta_1.21.13025.0_x64__8wekyb3d8bbwe.msixvc", Some("53eada2976fcbfb44b054298e4c79913")),
        ("1.21.130.24", "Minecraft 基岩预览版 1.21.13024", "2025-10-30", "preview", "http://assets1.xboxlive.cn/1/d92e34c0-657c-4961-982e-15e547d7f401/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.13024.0.5300c429-a5af-4d3e-878e-e52da402ff7a/Microsoft.MinecraftWindowsBeta_1.21.13024.0_x64__8wekyb3d8bbwe.msixvc", Some("d02c8bb9581b5fb22424ce71cbcabf2a")),
        ("1.21.130.22", "Minecraft 基岩预览版 1.21.13022", "2025-10-22", "preview", "http://assets1.xboxlive.cn/3/9c302a78-01ec-4b9a-9d2e-bb845890deca/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.13022.0.45387b4a-baa2-4b8c-857f-e254e54c2cdb/Microsoft.MinecraftWindowsBeta_1.21.13022.0_x64__8wekyb3d8bbwe.msixvc", Some("144d3b77577363894d44fd440d348807")),
        ("1.21.130.20", "Minecraft 基岩预览版 1.21.13020", "2025-10-14", "preview", "http://assets1.xboxlive.cn/14/c6cf3fbf-1bcd-466c-89ad-815b1341c965/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.13020.0.93bb5ef3-9fc8-434c-a090-af8304a87bb9/Microsoft.MinecraftWindowsBeta_1.21.13020.0_x64__8wekyb3d8bbwe.msixvc", Some("06e0d4d640167f8c07a7e2aaab55a55d")),
        ("1.21.130", "Minecraft 基岩版 1.21.13004", "2025-12-09", "release", "http://assets1.xboxlive.cn/13/85f79956-c341-4ed5-a4b7-4a3eba7b4ef8/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.21.13004.0.c5a9f4f8-403d-45da-a67e-e5c4b654cdb7/MICROSOFT.MINECRAFTUWP_1.21.13004.0_x64__8wekyb3d8bbwe.msixvc", Some("e37370b38347818ef98e32a0828d4e8a")),
        ("1.21.124", "Minecraft 基岩版 1.21.12402", "2025-11-21", "release", "http://assets1.xboxlive.cn/5/94e39fde-e4b3-4b0c-9e4d-fc863879a8fa/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.21.12402.0.d63d9c2d-45e3-4438-89fc-a823f8a2ef0f/MICROSOFT.MINECRAFTUWP_1.21.12402.0_x64__8wekyb3d8bbwe.msixvc", Some("b9394824b04154b3ffa421159db1172d")),
        ("1.21.123", "Minecraft 基岩版 1.21.12302", "2025-11-13", "release", "http://assets1.xboxlive.cn/5/e7c3e87a-85c2-418c-80bf-24a8c18ef443/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.21.12302.0.9652e398-729a-4268-bb97-f11894a52e59/MICROSOFT.MINECRAFTUWP_1.21.12302.0_x64__8wekyb3d8bbwe.msixvc", Some("ec24e82291cd218b446bccaa8fc63ab1")),
        ("1.21.122", "Minecraft 基岩版 1.21.12201", "2025-11-10", "release", "http://assets1.xboxlive.cn/12/61b23c98-8461-4cd6-a537-863fa838948e/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.21.12201.0.a08d9b9e-669e-4aab-a6d1-514bcd0a40cc/MICROSOFT.MINECRAFTUWP_1.21.12201.0_x64__8wekyb3d8bbwe.msixvc", Some("f1f96c9ab83e0b1407ea9d9845e306eb")),
        ("1.21.121", "Minecraft 基岩版 1.21.12101", "2025-11-05", "release", "http://assets1.xboxlive.cn/15/7bf19a96-c045-4b55-b96e-faa32604781a/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.21.12101.0.7590152e-2320-4e06-9e85-8e458890e1e7/MICROSOFT.MINECRAFTUWP_1.21.12101.0_x64__8wekyb3d8bbwe.msixvc", Some("0c0b5df2b44bd24d105f22e2adf37c8a")),
        ("1.21.120.25", "Minecraft 基岩预览版 1.21.12025", "2025-10-07", "preview", "http://assets1.xboxlive.cn/1/65893bb8-80db-4daa-800c-6cb274f4afab/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.12025.0.ec675b18-cd7d-4207-8d37-c164f7e4fc70/Microsoft.MinecraftWindowsBeta_1.21.12025.0_x64__8wekyb3d8bbwe.msixvc", Some("fc101790d23161978cedd43fac01c9a3")),
        ("1.21.120.24", "Minecraft 基岩预览版 1.21.12024", "2025-10-01", "preview", "http://assets1.xboxlive.cn/1/b8827b40-998d-4b15-b73f-ff7d70ae1e9c/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.12024.0.b0ec0ab6-f9ab-41fa-b664-9091300e8f90/Microsoft.MinecraftWindowsBeta_1.21.12024.0_x64__8wekyb3d8bbwe.msixvc", Some("6a9e31c6d60d6fddebfe9a1998f6b80c")),
        ("1.21.120.23", "Minecraft 基岩预览版 1.21.12023", "2025-09-23", "preview", "http://assets1.xboxlive.cn/4/c21d7589-ffaf-4544-b1c5-926d72752e6c/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.12023.0.9f1b49ff-7011-4af2-bb8c-edc1de4b41df/Microsoft.MinecraftWindowsBeta_1.21.12023.0_x64__8wekyb3d8bbwe.msixvc", Some("13d7e750fd99f1b0a1b7f1a08e681f64")),
        ("1.21.120.22", "Minecraft 基岩预览版 1.21.12022", "2025-09-16", "preview", "http://assets1.xboxlive.cn/14/b058fc9d-ce41-4d43-86a3-97d8690ab0b4/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.12022.0.bd8e701d-78fe-44ae-bb25-f15ac0001754/Microsoft.MinecraftWindowsBeta_1.21.12022.0_x64__8wekyb3d8bbwe.msixvc", Some("d21ff4f7937c9ad3f91711bba025cc6a")),
        ("1.21.120.21", "Minecraft 基岩预览版 1.21.12021", "2025-09-09", "preview", "http://assets1.xboxlive.cn/12/66b02bc1-c4f1-4986-a183-c23e00cccecb/98bd2335-9b01-4e4c-bd05-ccc01614078b/1.21.12021.0.e5cfeb9c-2eaa-4959-8a49-e82cde29702a/Microsoft.MinecraftWindowsBeta_1.21.12021.0_x64__8wekyb3d8bbwe.msixvc", Some("36b590a36446b1cfc677bd1fbfbed04d")),
        ("1.21.120", "Minecraft 基岩版 1.21.12004", "2025-10-28", "release", "http://assets1.xboxlive.cn/1/7d219e7c-a46e-4afc-8176-cec808fc1e1b/7792d9ce-355a-493c-afbd-768f4a77c3b0/1.21.12004.0.0ed99274-787a-4d02-8344-7c6bd1ef77c8/MICROSOFT.MINECRAFTUWP_1.21.12004.0_x64__8wekyb3d8bbwe.msixvc", Some("d1a1c8526374596be545b046db3f6e47")),
    ];

    let mut list = Vec::with_capacity(verified_builds.len());
    for &(ver, name, date, rel_type, direct_url, md5_opt) in verified_builds {
        let is_preview = rel_type == "preview";
        let store_url = if is_preview {
            "ms-windows-store://pdp/?ProductId=9P5X4QVLC2XR"
        } else {
            "ms-windows-store://pdp/?ProductId=9NBLGGH537BL"
        };

        let b_type = if direct_url.contains(".msixvc") {
            "GDK"
        } else if direct_url.contains(".appx") || direct_url.contains(".msix") {
            "UWP"
        } else if direct_url.contains("bedrock-server") {
            "BDS"
        } else {
            "UWP"
        };

        list.push(BedrockVersionItem {
            id: ver.to_string(),
            name: name.to_string(),
            version: ver.to_string(),
            release_type: rel_type.to_string(),
            download_url: direct_url.to_string(),
            store_url: Some(store_url.to_string()),
            date: date.to_string(),
            size: 1_870_000_000,
            sha256: None,
            api_source: Some("Xbox Live CDN 镜像".to_string()),
            build_type: Some(b_type.to_string()),
            md5: md5_opt.map(|s| s.to_string()),
        });
    }

    list
}

pub fn get_bedrock_versions() -> Vec<BedrockVersionItem> {
    if let Some(cached) = load_cached_versions() {
        return cached;
    }
    get_curated_fallback_versions()
}

fn format_iso8601_utc(secs: u64) -> String {
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let mut days = (secs / 86400) as i64;

    let mut year = 1970;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let y_days = if leap { 366 } else { 365 };
        if days < y_days {
            break;
        }
        days -= y_days;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let m_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for &dim in &m_days {
        if days < dim {
            break;
        }
        days -= dim;
        month += 1;
    }
    let day = days + 1;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, h, m, s
    )
}

pub async fn resolve_fe3_soap_update_url(update_id: &str) -> Option<String> {
    // The SOAP round trip to Windows Update routinely takes several seconds and
    // the endpoint is slow from outside the EU/US; a short timeout here silently
    // dropped every UWP package URL.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .ok()?;

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let created = format_iso8601_utc(now_secs);
    let expires = format_iso8601_utc(now_secs + 300);
    let device_attrs = "E:BranchReadinessLevel=CBB&amp;DchuNvidiaGrfxExists=1&amp;ProcessorIdentifier=Intel64%20Family%206%20Model%2063%20Stepping%202&amp;CurrentBranch=rs4_release&amp;DataVer_RS5=1942&amp;FlightRing=Retail&amp;AttrDataVer=57&amp;InstallLanguage=en-US&amp;DchuAmdGrfxExists=1&amp;OSUILocale=en-US&amp;InstallationType=Client&amp;FlightingBranchName=&amp;Version_RS5=10&amp;UpgEx_RS5=Green&amp;GStatus_RS5=2&amp;OSSkuId=48&amp;App=WU&amp;InstallDate=1529700913&amp;ProcessorManufacturer=GenuineIntel&amp;AppVer=10.0.17134.471&amp;OSArchitecture=AMD64&amp;UpdateManagementGroup=2&amp;IsDeviceRetailDemo=0&amp;HidOverGattReg=C%3A%5CWINDOWS%5CSystem32%5CDriverStore%5CFileRepository%5Chidbthle.inf_amd64_467f181075371c89%5CMicrosoft.Bluetooth.Profiles.HidOverGatt.dll&amp;IsFlightingEnabled=0&amp;DchuIntelGrfxExists=1&amp;TelemetryLevel=1&amp;DefaultUserRegion=244&amp;DeferFeatureUpdatePeriodInDays=365&amp;Bios=Unknown&amp;WuClientVer=10.0.17134.471&amp;PausedFeatureStatus=1&amp;Steam=URL%3Asteam%20protocol&amp;Free=8to16&amp;OSVersion=10.0.17134.472&amp;DeviceFamily=Windows.Desktop";

    let soap_body = format!(
        r#"<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header><a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/GetExtendedUpdateInfo2</a:Action><a:MessageID>urn:uuid:5754a03d-d8d5-489f-b24d-efc31b3fd32d</a:MessageID><a:To s:mustUnderstand="1">https://fe3.delivery.mp.microsoft.com/ClientWebService/Client.asmx/secured</a:To><o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><Created>{created}</Created><Expires>{expires}</Expires></Timestamp><wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization"><TicketType Name="AAD" Version="1.0" Policy="MBI_SSL"></TicketType></wuws:WindowsUpdateTicketsToken></o:Security></s:Header><s:Body><GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService"><updateIDs><UpdateIdentity><UpdateID>{update_id}</UpdateID><RevisionNumber>1</RevisionNumber></UpdateIdentity></updateIDs><infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType></infoTypes><deviceAttributes>{device_attrs}</deviceAttributes></GetExtendedUpdateInfo2></s:Body></s:Envelope>"#
    );

    let resp = client
        .post("https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx/secured")
        .header("Content-Type", "application/soap+xml; charset=utf-8")
        .body(soap_body)
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let text = resp.text().await.ok()?;
    let urls = extract_fe3_urls(&text);

    let complex = urls.iter().find(|u| {
        u.contains("?P1=")
            || u.contains("tlu.dl.")
            || u.contains("&P2=")
            || u.contains("%3d")
            || u.len() > 150
    });
    complex.cloned().or_else(|| urls.last().cloned())
}

/// Collect the `<Url>` values from a fe3 `GetExtendedUpdateInfo2` response.
///
/// The element is normally unprefixed (`<FileLocation><Url>…</Url>`), but some
/// responses namespace it (`<a:Url>`), so both spellings have to be accepted —
/// matching only `:Url>` silently dropped every URL and made UWP (UpdateID
/// based) downloads fail while GDK entries, which ship a direct `.msixvc` URL,
/// kept working.
fn extract_fe3_urls(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut urls = Vec::new();
    let mut cursor = 0usize;

    while let Some(rel) = text[cursor..].find("Url>") {
        let tag_start = cursor + rel;
        let open_end = tag_start + 4;
        let prefixed = tag_start > 0 && matches!(bytes[tag_start - 1], b'<' | b':');
        if !prefixed {
            // `</Url>` closing tags also end in `Url>`; skip them.
            cursor = open_end;
            continue;
        }
        let Some(close_rel) = text[open_end..].find("</") else {
            break;
        };
        let close_pos = open_end + close_rel;
        let value = text[open_end..close_pos].trim();
        if !value.is_empty() {
            urls.push(value.replace("&amp;", "&"));
        }
        cursor = close_pos;
    }

    urls
}

pub fn parse_bedrockboot_db_json(json_str: &str, source_name: &str) -> Vec<BedrockVersionItem> {
    let mut items = Vec::new();
    let root: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return items,
    };

    let parse_build = |key: &str, obj: &serde_json::Value| -> Option<BedrockVersionItem> {
        let game_type = obj
            .get("Type")
            .and_then(|v| v.as_str())
            .unwrap_or("Release");
        let build_type = obj
            .get("BuildType")
            .and_then(|v| v.as_str())
            .unwrap_or("UWP");
        let id = obj
            .get("ID")
            .and_then(|v| v.as_str())
            .unwrap_or(key)
            .to_string();
        if id.is_empty() {
            return None;
        }
        let date = obj
            .get("Date")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let variations = obj.get("Variations").and_then(|v| v.as_array())?;
        if variations.is_empty() {
            return None;
        }

        let var = variations
            .iter()
            .find(|v| {
                v.get("Arch")
                    .and_then(|a| a.as_str())
                    .map(|a| a.to_lowercase().contains("x64") || a.to_lowercase() == "neutral")
                    .unwrap_or(false)
            })
            .or_else(|| variations.first())?;

        let metadata: Vec<String> = var
            .get("MetaData")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let md5 = var
            .get("MD5")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string());
        let direct_url = metadata
            .iter()
            .find(|s| s.starts_with("http://") || s.starts_with("https://"))
            .cloned();

        let download_url = if let Some(u) = direct_url {
            u
        } else if let Some(first) = metadata.first() {
            first.clone()
        } else {
            String::new()
        };

        let curated_match = get_curated_fallback_versions()
            .into_iter()
            .find(|c| c.id == id || c.version == id);
        let (final_url, final_md5) =
            if download_url.starts_with("http://") || download_url.starts_with("https://") {
                (download_url, md5)
            } else if let Some(curated) = curated_match {
                (curated.download_url, md5.or(curated.md5))
            } else {
                (download_url, md5)
            };

        if final_url.is_empty() {
            return None;
        }

        let is_preview =
            game_type.eq_ignore_ascii_case("preview") || game_type.eq_ignore_ascii_case("beta");
        let release_type = if is_preview { "preview" } else { "release" };

        let display_name = if is_preview {
            format!("Minecraft 基岩预览版 {} ({})", id, build_type)
        } else {
            format!("Minecraft 基岩版 {} ({})", id, build_type)
        };

        let store_url = if is_preview {
            Some("ms-windows-store://pdp/?ProductId=9P5X4QVLC2XR".to_string())
        } else {
            Some("ms-windows-store://pdp/?ProductId=9NBLGGH537BL".to_string())
        };

        Some(BedrockVersionItem {
            id: id.clone(),
            name: display_name,
            version: id,
            release_type: release_type.to_string(),
            download_url: final_url,
            store_url,
            date,
            size: 1_870_000_000,
            sha256: None,
            api_source: Some(source_name.to_string()),
            build_type: Some(build_type.to_string()),
            md5: final_md5,
        })
    };

    if let Some(map) = root.as_object() {
        for (k, v) in map {
            if k == "CreationTime" {
                continue;
            }
            if let Some(sub_map) = v.as_object() {
                if sub_map.contains_key("Type") && sub_map.contains_key("Variations") {
                    if let Some(item) = parse_build(k, v) {
                        items.push(item);
                    }
                } else {
                    for (sub_k, sub_v) in sub_map {
                        if let Some(item) = parse_build(sub_k, sub_v) {
                            items.push(item);
                        }
                    }
                }
            }
        }
    }

    items.sort_by(|a, b| {
        let parse_v = |v_str: &str| -> Vec<u32> {
            v_str
                .split('.')
                .filter_map(|p| {
                    p.chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .parse::<u32>()
                        .ok()
                })
                .collect()
        };
        let va = parse_v(&a.version);
        let vb = parse_v(&b.version);
        vb.cmp(&va).then_with(|| b.id.cmp(&a.id))
    });

    items
}

static BEDROCK_VERSIONS_MEMORY_CACHE: std::sync::Mutex<
    Option<(Instant, String, Vec<BedrockVersionItem>)>,
> = std::sync::Mutex::new(None);

pub async fn get_bedrock_versions_async(api_source: Option<&str>) -> Vec<BedrockVersionItem> {
    let source = api_source.unwrap_or("mcappx");

    if source == "azure_mirror" || source == "mcserverjars" {
        return get_curated_fallback_versions();
    }

    if let Ok(guard) = BEDROCK_VERSIONS_MEMORY_CACHE.lock() {
        if let Some((ts, cached_src, items)) = guard.as_ref() {
            if cached_src == source
                && ts.elapsed() < std::time::Duration::from_secs(300)
                && !items.is_empty()
            {
                return items.clone();
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2500))
        .build()
        .unwrap_or_default();

    // BedrockBoot sources (McAppx, Gitee, BMCBL)
    if source == "mcappx"
        || source == "bedrockboot_gitee"
        || source == "bmcbl"
        || source == "bedrockboot"
    {
        let (primary_url, label) = match source {
            "bedrockboot_gitee" => (
                "https://raw.giteeusercontent.com/minecraftyjq/bedrock-version-db/raw/main/data/bedrock.json",
                "BedrockBoot 源 (Gitee 镜像)",
            ),
            "bmcbl" => (
                "https://api.chlna6666.com/api/v1/bedrock/mcappx",
                "BMCBL 源 ①",
            ),
            _ => (
                "https://data.mcappx.com/v2/bedrock.json",
                "McAppx 源 (BedrockBoot 官方)",
            ),
        };

        let candidate_sources = [
            (primary_url, label),
            ("https://raw.giteeusercontent.com/minecraftyjq/bedrock-version-db/raw/main/data/bedrock.json", "BedrockBoot 源 (Gitee 镜像)"),
            ("https://api.chlna6666.com/api/v1/bedrock/mcappx", "BMCBL 源 ①"),
            ("https://data.mcappx.com/v2/bedrock.json", "McAppx 源 (BedrockBoot 官方)"),
        ];

        for (url, src_label) in candidate_sources {
            if let Ok(resp) = client
                .get(url)
                .header("User-Agent", "mcappx_developer")
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(text) = resp.text().await {
                        let items = parse_bedrockboot_db_json(&text, src_label);
                        if !items.is_empty() {
                            save_cached_versions(&items);
                            if let Ok(mut guard) = BEDROCK_VERSIONS_MEMORY_CACHE.lock() {
                                *guard = Some((Instant::now(), source.to_string(), items.clone()));
                            }
                            return items;
                        }
                    }
                }
            }
        }
    }

    // EndstoneMC BDS API mirrors
    let endpoints = [
        "https://cdn.jsdelivr.net/gh/EndstoneMC/bedrock-server-data@master/versions.json",
        "https://fastly.jsdelivr.net/gh/EndstoneMC/bedrock-server-data@master/versions.json",
        "https://raw.gitmirror.com/EndstoneMC/bedrock-server-data/master/versions.json",
        "https://cdn.jsdelivr.net/gh/Bedrock-OSS/BDS-Versions@main/versions.json",
        "https://raw.gitmirror.com/Bedrock-OSS/BDS-Versions/main/versions.json",
        "https://ghproxy.net/https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/master/versions.json",
        "https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/master/versions.json",
    ];

    for ep in endpoints {
        if let Ok(resp) = client.get(ep).send().await {
            if let Ok(data) = resp.json::<BdsRegistryResponse>().await {
                let items = data.into_items("EndstoneMC API");
                if !items.is_empty() {
                    save_cached_versions(&items);
                    if let Ok(mut guard) = BEDROCK_VERSIONS_MEMORY_CACHE.lock() {
                        *guard = Some((Instant::now(), source.to_string(), items.clone()));
                    }
                    return items;
                }
            }
        }
    }

    // If all remote network endpoints failed, fallback to local cache
    if let Some(cached) = load_cached_versions() {
        if let Ok(mut guard) = BEDROCK_VERSIONS_MEMORY_CACHE.lock() {
            *guard = Some((Instant::now(), source.to_string(), cached.clone()));
        }
        return cached;
    }

    // Final fallback to comprehensive curated catalog
    let fallback = get_curated_fallback_versions();
    if let Ok(mut guard) = BEDROCK_VERSIONS_MEMORY_CACHE.lock() {
        *guard = Some((Instant::now(), source.to_string(), fallback.clone()));
    }
    fallback
}

pub fn get_curated_bedrock_content() -> Vec<BedrockContentItem> {
    vec![
        // 光影与材质 (Shaders)
        BedrockContentItem {
            id: "bedrock-deferred-pbr".to_string(),
            title: "Deferred Lighting PBR (基岩版延迟光影)".to_string(),
            author: "RenderDragon".to_string(),
            description: "原生 Render Dragon 延迟着色管线光影，具备体积分光、PBR 粗糙度反射与点光源实时阴影。".to_string(),
            content_type: "shader".to_string(),
            download_url: "https://raw.githubusercontent.com/Pug-Dev/Deferred-PBR/main/DeferredPBR.mcpack".to_string(),
            file_name: "DeferredPBR.mcpack".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/b9YQO8q3/icon.png".to_string()),
            tags: vec!["光影".to_string(), "PBR".to_string(), "RenderDragon".to_string(), "1.21+".to_string()],
            downloads: 248_900,
            version: "v1.2.0".to_string(),
        },
        BedrockContentItem {
            id: "kellys-rtx-conversion".to_string(),
            title: "Kelly's RTX Conversion (光追全特效光影)".to_string(),
            author: "Kelly".to_string(),
            description: "全特效基岩版 RTX 光线追踪增强光影材质包，具备拟真法线视差凹凸与真实发光方块反射。".to_string(),
            content_type: "shader".to_string(),
            download_url: "https://raw.githubusercontent.com/KellysRTX/Conversion/main/KellysRTX.mcpack".to_string(),
            file_name: "KellysRTX.mcpack".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/u6Djgvyi/icon.png".to_string()),
            tags: vec!["光影".to_string(), "RTX".to_string(), "光线追踪".to_string(), "拟真".to_string()],
            downloads: 680_400,
            version: "v2.1.0".to_string(),
        },
        BedrockContentItem {
            id: "yss-shader-bedrock".to_string(),
            title: "YSS Shader for Bedrock (经典软光影)".to_string(),
            author: "YSS Project".to_string(),
            description: "基岩版轻量柔和光影，具备动态水波、摇晃树叶、暖阳漫反射与优美晨昏天空。".to_string(),
            content_type: "shader".to_string(),
            download_url: "https://raw.githubusercontent.com/yss-mc/releases/main/YSS_Bedrock.mcpack".to_string(),
            file_name: "YSS_Bedrock.mcpack".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/lhGA9TYQ/icon.png".to_string()),
            tags: vec!["光影".to_string(), "低配流畅".to_string(), "水面波纹".to_string()],
            downloads: 320_100,
            version: "v3.0.2".to_string(),
        },
        BedrockContentItem {
            id: "defined-pbr".to_string(),
            title: "Defined PBR (原版增强 PBR 光影材质)".to_string(),
            author: "Madlad3718".to_string(),
            description: "保持 Minecraft 原汁原味风格的高清 PBR 材质包，完美兼容 RTX 与延迟渲染。".to_string(),
            content_type: "shader".to_string(),
            download_url: "https://raw.githubusercontent.com/DefinedPBR/Pack/main/DefinedPBR.mcpack".to_string(),
            file_name: "DefinedPBR.mcpack".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/5ZwdcRci/icon.png".to_string()),
            tags: vec!["光影".to_string(), "材质".to_string(), "原版增强".to_string()],
            downloads: 410_500,
            version: "v1.4.1".to_string(),
        },
        // 模组与行为包 (Mods / Add-Ons)
        BedrockContentItem {
            id: "actions-and-stuff".to_string(),
            title: "Actions & Stuff (动作物理交互模组)".to_string(),
            author: "Traxe".to_string(),
            description: "基岩版超高清动作行为包，全面重构玩家与生物全部肢体动作、战斗挥舞、拔刀与游泳物理动作。".to_string(),
            content_type: "mod".to_string(),
            download_url: "https://raw.githubusercontent.com/Traxe-mc/ActionsStuff/main/ActionsAndStuff.mcaddon".to_string(),
            file_name: "ActionsAndStuff.mcaddon".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/mOgUt4GM/icon.png".to_string()),
            tags: vec!["模组".to_string(), "行为包".to_string(), "物理动作".to_string(), "生物交互".to_string()],
            downloads: 890_000,
            version: "v1.3.4".to_string(),
        },
        BedrockContentItem {
            id: "essentials-bedrock-addon".to_string(),
            title: "Essentials Bedrock Add-On (实用辅助模组)".to_string(),
            author: "BedrockTools".to_string(),
            description: "为基岩版带来家园快速传送、背包快捷整理、死亡坐标标记、一键砍树等丰富功能。".to_string(),
            content_type: "mod".to_string(),
            download_url: "https://raw.githubusercontent.com/BedrockTools/Essentials/main/Essentials.mcaddon".to_string(),
            file_name: "Essentials.mcaddon".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/P7dR8mSH/icon.png".to_string()),
            tags: vec!["模组".to_string(), "实用工具".to_string(), "传送".to_string(), "砍树".to_string()],
            downloads: 512_300,
            version: "v2.0.0".to_string(),
        },
        BedrockContentItem {
            id: "more-simple-structures".to_string(),
            title: "More Simple Structures (更多世界结构模组)".to_string(),
            author: "StructureDev".to_string(),
            description: "在主世界、沙漠、雪原与下界自动生成数十种全新古代遗迹、地下要塞与探险塔楼。".to_string(),
            content_type: "mod".to_string(),
            download_url: "https://raw.githubusercontent.com/StructureDev/MoreStructures/main/MoreStructures.mcaddon".to_string(),
            file_name: "MoreStructures.mcaddon".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/1IjD5062/icon.png".to_string()),
            tags: vec!["模组".to_string(), "世界生成".to_string(), "地牢遗迹".to_string()],
            downloads: 345_600,
            version: "v1.1.8".to_string(),
        },
        BedrockContentItem {
            id: "spark-visuals-bedrock".to_string(),
            title: "Spark Visuals (战斗与伤害粒子模组)".to_string(),
            author: "SparkFX".to_string(),
            description: "为基岩版武器攻击、暴击命中与技能附加炫酷流光粒子、伤害数值跳跃与状态光环。".to_string(),
            content_type: "mod".to_string(),
            download_url: "https://raw.githubusercontent.com/SparkFX/Visuals/main/SparkVisuals.mcaddon".to_string(),
            file_name: "SparkVisuals.mcaddon".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/fALzjamp/icon.png".to_string()),
            tags: vec!["模组".to_string(), "粒子特效".to_string(), "伤害数值".to_string()],
            downloads: 278_400,
            version: "v1.5.0".to_string(),
        },
        // 材质包与资源包 (Resource Packs)
        BedrockContentItem {
            id: "faithful-32x-bedrock".to_string(),
            title: "Faithful 32x Bedrock (原版高清材质包)".to_string(),
            author: "Faithful Team".to_string(),
            description: "经典原汁原味 32x 双倍高清材质包，全面提升方块、工具、界面与生物细节清晰度。".to_string(),
            content_type: "resourcepack".to_string(),
            download_url: "https://raw.githubusercontent.com/Faithful-Bedrock/Pack/main/Faithful32x.mcpack".to_string(),
            file_name: "Faithful32x.mcpack".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/lhGA9TYQ/icon.png".to_string()),
            tags: vec!["材质包".to_string(), "高清".to_string(), "原版增强".to_string(), "32x".to_string()],
            downloads: 1_250_000,
            version: "v1.21.3".to_string(),
        },
        BedrockContentItem {
            id: "bare-bones-bedrock".to_string(),
            title: "Bare Bones Bedrock (宣传片极简卡通材质)".to_string(),
            author: "RobotPantaloons".to_string(),
            description: "将游戏视觉变为 Mojang 官方宣传片色彩风格，极度清爽平整、饱和度舒适且帧率极高。".to_string(),
            content_type: "resourcepack".to_string(),
            download_url: "https://raw.githubusercontent.com/RobotPantaloons/BareBones/main/BareBonesBedrock.mcpack".to_string(),
            file_name: "BareBonesBedrock.mcpack".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/OSyv2ndA/icon.png".to_string()),
            tags: vec!["材质包".to_string(), "卡通".to_string(), "极简".to_string(), "高帧率".to_string()],
            downloads: 980_000,
            version: "v1.21.1".to_string(),
        },
        BedrockContentItem {
            id: "java-aspects-bedrock".to_string(),
            title: "Java Aspects (Java 界面与动画还原资源包)".to_string(),
            author: "AgentMindStorm".to_string(),
            description: "完美将 Java 版原生 UI 布局、战斗冷却光标、挥手击打动画与音效无缝移植到基岩版中。".to_string(),
            content_type: "resourcepack".to_string(),
            download_url: "https://raw.githubusercontent.com/AgentMindStorm/JavaAspects/main/JavaAspects.mcpack".to_string(),
            file_name: "JavaAspects.mcpack".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/nkW4305l/icon.png".to_string()),
            tags: vec!["材质包".to_string(), "Java还原".to_string(), "UI界面".to_string(), "实用".to_string()],
            downloads: 540_000,
            version: "v2.5.0".to_string(),
        },
        // 数据包与玩法世界 (Datapacks / Worlds)
        BedrockContentItem {
            id: "bedrock-oneblock".to_string(),
            title: "OneBlock Bedrock (单方块空岛极限生存)".to_string(),
            author: "IJAMinecraft".to_string(),
            description: "从虚空中的唯一一个泥土方块开始挖掘，随阶段解锁十种不同生态与地牢挑战。".to_string(),
            content_type: "datapack".to_string(),
            download_url: "https://raw.githubusercontent.com/IJAMinecraft/OneBlock/main/OneBlockBedrock.mcworld".to_string(),
            file_name: "OneBlockBedrock.mcworld".to_string(),
            icon_url: Some("https://cdn.modrinth.com/data/jbgL2L1k/icon.png".to_string()),
            tags: vec!["数据包".to_string(), "单方块".to_string(), "空岛".to_string(), "极限生存".to_string()],
            downloads: 720_000,
            version: "v3.1.0".to_string(),
        },
    ]
}

static BEDROCK_CONTENT_CACHE: std::sync::Mutex<Option<(Instant, Vec<BedrockContentItem>)>> =
    std::sync::Mutex::new(None);

/// The curated packs plus any remote catalog entries already cached.
///
/// Never performs network I/O: callers on a latency-critical path (opening a
/// mod's version list) must not wait for the remote catalog, which can take
/// seconds when its mirrors are unreachable.
pub fn get_bedrock_content_cached() -> Vec<BedrockContentItem> {
    let mut items = get_curated_bedrock_content();
    if let Ok(guard) = BEDROCK_CONTENT_CACHE.lock() {
        if let Some((_, ref cached)) = *guard {
            for entry in cached {
                if !items.iter().any(|i| i.id == entry.id) {
                    items.push(entry.clone());
                }
            }
        }
    }
    items
}

pub async fn get_bedrock_content_async(category: Option<&str>) -> Vec<BedrockContentItem> {
    if let Ok(guard) = BEDROCK_CONTENT_CACHE.lock() {
        if let Some((timestamp, ref cached)) = *guard {
            if timestamp.elapsed() < std::time::Duration::from_secs(300) {
                return filter_bedrock_content(cached.clone(), category);
            }
        }
    }

    let client = net::client();
    let remote_endpoints = [
        "https://fastly.jsdelivr.net/gh/bedrock-oss/bedrock-resource-db@main/content.json",
        "https://cdn.jsdelivr.net/gh/bedrock-oss/bedrock-resource-db@main/content.json",
        "https://raw.gitmirror.com/bedrock-oss/bedrock-resource-db/main/content.json",
        "https://raw.githubusercontent.com/bedrock-oss/bedrock-resource-db/main/content.json",
    ];

    // Race the mirrors instead of trying them one after another: a blocked or
    // dead mirror used to cost its full timeout before the next was tried.
    let fetches = futures_util::stream::iter(remote_endpoints.iter().map(|ep| {
        let client = client.clone();
        async move {
            let resp = client
                .get(*ep)
                .timeout(std::time::Duration::from_secs(4))
                .send()
                .await
                .ok()?;
            if !resp.status().is_success() {
                return None;
            }
            resp.json::<Vec<BedrockContentItem>>().await.ok()
        }
    }))
    .buffer_unordered(remote_endpoints.len())
    .filter_map(|items| async move { items.filter(|i| !i.is_empty()) });

    if let Some(mut merged) = fetches.boxed().next().await {
        for c in get_curated_bedrock_content() {
            if !merged.iter().any(|m| m.id == c.id) {
                merged.push(c);
            }
        }
        if let Ok(mut guard) = BEDROCK_CONTENT_CACHE.lock() {
            *guard = Some((Instant::now(), merged.clone()));
        }
        return filter_bedrock_content(merged, category);
    }

    let fallback = get_curated_bedrock_content();
    if let Ok(mut guard) = BEDROCK_CONTENT_CACHE.lock() {
        *guard = Some((Instant::now(), fallback.clone()));
    }
    filter_bedrock_content(fallback, category)
}

fn filter_bedrock_content(
    items: Vec<BedrockContentItem>,
    category: Option<&str>,
) -> Vec<BedrockContentItem> {
    match category {
        Some(c) if !c.is_empty() && c != "all" => items
            .into_iter()
            .filter(|i| {
                if c == "resourcepack" {
                    i.content_type == "resourcepack" || i.content_type == "shader"
                } else if c == "shader" {
                    i.content_type == "shader" || i.content_type == "resourcepack"
                } else {
                    i.content_type == c
                }
            })
            .collect(),
        _ => items,
    }
}

// ---------------------------------------------------------------------------
// Bedrock Launch Logic
// ---------------------------------------------------------------------------

fn spawn_bedrock_exe(exe: &Path, working_dir: &Path, is_console: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;

        clean_exe_run_as_admin(exe);
        ensure_game_input_installed(working_dir, None);

        // Auto-enable UWP loopback exemption so clients can join localhost BDS without Windows isolation blocks
        let _ = Command::new("CheckNetIsolation")
            .args([
                "LoopbackExempt",
                "-a",
                "-n=Microsoft.MinecraftUWP_8wekyb3d8bbwe",
            ])
            .spawn();

        let _ = Command::new("CheckNetIsolation")
            .args([
                "LoopbackExempt",
                "-a",
                "-n=Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe",
            ])
            .spawn();

        let mut cmd = Command::new(exe);
        cmd.current_dir(working_dir);
        if is_console {
            cmd.creation_flags(CREATE_NEW_CONSOLE);
        }
        cmd.spawn()
            .map_err(|e| format!("启动基岩版核心进程失败 ({}): {e}", exe.display()))?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(exe) {
                let mut perms = meta.permissions();
                let mode = perms.mode();
                if mode & 0o111 == 0 {
                    perms.set_mode(mode | 0o755);
                    let _ = std::fs::set_permissions(exe, perms);
                }
            }
        }

        let mut cmd = Command::new(exe);
        cmd.current_dir(working_dir);

        #[cfg(target_os = "linux")]
        {
            cmd.env("LD_LIBRARY_PATH", working_dir);
        }

        cmd.spawn()
            .map_err(|e| format!("启动基岩版核心进程失败 ({}): {e}", exe.display()))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// BedrockBoot-DM Architectural Compatibility & Dependency Suite
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
pub fn check_developer_mode() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let paths = [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock",
        "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Appx",
    ];

    for path in paths {
        let mut cmd = Command::new("reg");
        cmd.args(["query", path, "/v", "AllowDevelopmentWithoutDevLicense"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if text.contains("0x1") || text.contains(" 1") {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
pub fn check_developer_mode() -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn enable_developer_mode() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut cmd = Command::new("reg");
    cmd.args([
        "add",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock",
        "/t",
        "REG_DWORD",
        "/f",
        "/v",
        "AllowDevelopmentWithoutDevLicense",
        "/d",
        "1",
    ]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            invalidate_dependency_cache();
            return Ok(());
        }
    }

    let script = "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -Command \"Set-ItemProperty -Path HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock -Name AllowDevelopmentWithoutDevLicense -Value 1 -Type DWord\"'";
    let mut ps_cmd = Command::new("powershell");
    ps_cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    ps_cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = ps_cmd.spawn();

    let _ = Command::new("explorer")
        .arg("ms-settings:developers")
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();

    invalidate_dependency_cache();
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn enable_developer_mode() -> Result<(), String> {
    Err("开发者模式仅在 Windows 平台受支持".to_string())
}

#[cfg(target_os = "windows")]
pub fn check_vc_redist_x64() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let subkeys = [
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    ];

    for base in subkeys {
        let mut cmd = Command::new("reg");
        cmd.args(["query", base, "/s", "/f", "Visual C++", "/k"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            let text = String::from_utf8_lossy(&out.stdout);
            let patterns = [
                "2015-2022 Redistributable (x64)",
                "2015-2022 (x64)",
                "v14 Redistributable (x64)",
                "2022 X64",
                "2019 X64",
            ];
            for p in patterns {
                if text.contains(p) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
pub fn check_vc_redist_x64() -> bool {
    true
}

#[cfg(target_os = "windows")]
pub fn clean_exe_run_as_admin(exe: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if let Some(exe_str) = exe.to_str() {
        let script = format!(
            "$p = '{}'; foreach ($k in @('HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers', 'HKLM:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers')) {{ try {{ $v = (Get-ItemProperty -Path $k -Name $p -ErrorAction Stop).$p; if ($v -and $v -like '*RUNASADMIN*') {{ $nv = $v.Replace('RUNASADMIN','').Trim(); if ([string]::IsNullOrWhiteSpace($nv)) {{ Remove-ItemProperty -Path $k -Name $p -ErrorAction SilentlyContinue }} else {{ Set-ItemProperty -Path $k -Name $p -Value $nv -ErrorAction SilentlyContinue }} }} }} catch {{}} }}",
            exe_str.replace('\'', "''")
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.output();
    }
}

#[cfg(not(target_os = "windows"))]
pub fn clean_exe_run_as_admin(_exe: &Path) {}

#[cfg(target_os = "windows")]
pub fn ensure_game_input_installed(work_dir: &Path, app: Option<&crate::bridge::AppHandle>) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let msi_path = work_dir.join("Installers").join("GameInputRedist.msi");
    if msi_path.is_file() {
        emit_bedrock_log(app, "正在自动执行 GameInputRedist 运行时安装…");
        let mut cmd = Command::new("msiexec.exe");
        cmd.args(["/i", &msi_path.to_string_lossy(), "/qb"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
        emit_bedrock_log(app, "GameInputRedist 运行时已就绪。");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_game_input_installed(_work_dir: &Path, _app: Option<&crate::bridge::AppHandle>) {}

fn compare_windows_versions(v1: &str, v2: &str) -> std::cmp::Ordering {
    let parse_nums = |s: &str| -> Vec<u64> {
        s.split('.')
            .filter_map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse::<u64>()
                    .ok()
            })
            .collect()
    };
    let n1 = parse_nums(v1);
    let n2 = parse_nums(v2);
    n1.cmp(&n2)
}

static DEPENDENCY_CACHE: std::sync::Mutex<Option<(Instant, BedrockFullDependencyReport)>> =
    std::sync::Mutex::new(None);

pub fn invalidate_dependency_cache() {
    if let Ok(mut guard) = DEPENDENCY_CACHE.lock() {
        *guard = None;
    }
}

pub fn check_bedrockboot_dependencies(force: bool) -> BedrockFullDependencyReport {
    if !force {
        if let Ok(guard) = DEPENDENCY_CACHE.lock() {
            if let Some((timestamp, cached)) = guard.as_ref() {
                if timestamp.elapsed() < std::time::Duration::from_secs(20) {
                    return cached.clone();
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::collections::HashMap;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let dev_mode = check_developer_mode();
        let vc_redist = check_vc_redist_x64();

        let mut installed_pkgs: HashMap<String, String> = HashMap::new();
        let script = "Get-AppxPackage | ForEach-Object { '{0}={1}' -f $_.Name, $_.Version }";
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        if let Ok(out) = cmd.output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let trimmed = line.trim();
                if let Some((k, v)) = trimmed.split_once('=') {
                    let k_lower = k.trim().to_ascii_lowercase();
                    let v_trim = v.trim().to_string();
                    if let Some(existing) = installed_pkgs.get_mut(&k_lower) {
                        if compare_windows_versions(&v_trim, existing).is_gt() {
                            *existing = v_trim;
                        }
                    } else {
                        installed_pkgs.insert(k_lower, v_trim);
                    }
                }
            }
        }

        let mut items = Vec::new();

        // 1. Developer Mode
        items.push(BedrockDependencyItem {
            key: "developer_mode".to_string(),
            name: "Windows 开发者模式 (Developer Mode)".to_string(),
            required: false,
            installed: dev_mode,
            version: None,
            min_version: None,
            fix_hint: "开启后可旁加载注册 Bedrock AppX/MSIX 核心与开发清单".to_string(),
        });

        // 2. VC++ 2015-2022 x64
        items.push(BedrockDependencyItem {
            key: "vc_redist_x64".to_string(),
            name: "Microsoft Visual C++ 2015-2022 运行库 (x64)".to_string(),
            required: true,
            installed: vc_redist,
            version: None,
            min_version: Some("14.0.0.0".to_string()),
            fix_hint: "安装 Visual C++ 2015-2022 x64 运行库".to_string(),
        });

        // 3. Gaming Services
        let (gs_installed, gs_ver) = {
            if let Some(ver) = installed_pkgs.get("microsoft.gamingservices") {
                let ok = compare_windows_versions(ver, "33.108.12001.0").is_ge();
                (ok, Some(ver.clone()))
            } else {
                (false, None)
            }
        };
        items.push(BedrockDependencyItem {
            key: "gaming_services".to_string(),
            name: "Xbox 游戏服务 (Microsoft.GamingServices)".to_string(),
            required: true,
            installed: gs_installed,
            version: gs_ver,
            min_version: Some("33.108.12001.0".to_string()),
            fix_hint: "Xbox GDK 核心运行必备，启动器可一键自动启动并修复".to_string(),
        });

        // 4. Xbox App
        let (xbox_installed, xbox_ver) = {
            if let Some(ver) = installed_pkgs.get("microsoft.gamingapp") {
                (true, Some(ver.clone()))
            } else {
                (false, None)
            }
        };
        items.push(BedrockDependencyItem {
            key: "xbox_app".to_string(),
            name: "Xbox 应用 (Microsoft.GamingApp)".to_string(),
            required: true,
            installed: xbox_installed,
            version: xbox_ver,
            min_version: None,
            fix_hint: "用于承载 Xbox 账号验证与 GDK 加密包运行".to_string(),
        });

        // 5. Minecraft UWP Client
        let (uwp_installed, uwp_ver) = {
            if let Some(ver) = installed_pkgs.get("microsoft.minecraftuwp") {
                (true, Some(ver.clone()))
            } else if let Some(ver) = installed_pkgs.get("microsoft.minecraftwindowsbeta") {
                (true, Some(ver.clone()))
            } else {
                (false, None)
            }
        };
        items.push(BedrockDependencyItem {
            key: "minecraft_uwp".to_string(),
            name: "Minecraft for Windows 客户端".to_string(),
            required: false,
            installed: uwp_installed,
            version: uwp_ver,
            min_version: None,
            fix_hint: "微软商店正版客户端，亦可选择 BDS 免密核心免商店直接运行".to_string(),
        });

        // 6. VCLibs 140
        let (vclibs_ok, vclibs_ver) = {
            if let Some(ver) = installed_pkgs.get("microsoft.vclibs.140.00") {
                let ok = compare_windows_versions(ver, "14.0.33519.0").is_ge();
                (ok, Some(ver.clone()))
            } else {
                (false, None)
            }
        };
        items.push(BedrockDependencyItem {
            key: "vclibs_140".to_string(),
            name: "Microsoft.VCLibs.140.00".to_string(),
            required: true,
            installed: vclibs_ok,
            version: vclibs_ver,
            min_version: Some("14.0.33519.0".to_string()),
            fix_hint: "UWP 核心底层 VC 运行库".to_string(),
        });

        // 7. VCLibs UWPDesktop
        let (vclibs_desk_ok, vclibs_desk_ver) = {
            if let Some(ver) = installed_pkgs.get("microsoft.vclibs.140.00.uwpdesktop") {
                (true, Some(ver.clone()))
            } else {
                (false, None)
            }
        };
        items.push(BedrockDependencyItem {
            key: "vclibs_uwpdesktop".to_string(),
            name: "Microsoft.VCLibs.140.00.UWPDesktop".to_string(),
            required: true,
            installed: vclibs_desk_ok,
            version: vclibs_desk_ver,
            min_version: None,
            fix_hint: "UWP 桌面支持扩展库".to_string(),
        });

        // 8. .NET Native Runtime 2.2
        let (net_rt_ok, net_rt_ver) = {
            if let Some(ver) = installed_pkgs.get("microsoft.net.native.runtime.2.2") {
                let ok = compare_windows_versions(ver, "2.2.28604.0").is_ge();
                (ok, Some(ver.clone()))
            } else {
                (false, None)
            }
        };
        items.push(BedrockDependencyItem {
            key: "net_native_runtime".to_string(),
            name: "Microsoft.NET.Native.Runtime.2.2".to_string(),
            required: true,
            installed: net_rt_ok,
            version: net_rt_ver,
            min_version: Some("2.2.28604.0".to_string()),
            fix_hint: "基岩版 UWP .NET Native 运行时".to_string(),
        });

        // 9. .NET Native Framework 2.2
        let (net_fw_ok, net_fw_ver) = {
            if let Some(ver) = installed_pkgs.get("microsoft.net.native.framework.2.2") {
                let ok = compare_windows_versions(ver, "2.2.29512.0").is_ge();
                (ok, Some(ver.clone()))
            } else {
                (false, None)
            }
        };
        items.push(BedrockDependencyItem {
            key: "net_native_framework".to_string(),
            name: "Microsoft.NET.Native.Framework.2.2".to_string(),
            required: true,
            installed: net_fw_ok,
            version: net_fw_ver,
            min_version: Some("2.2.29512.0".to_string()),
            fix_hint: "基岩版 UWP .NET Native 框架".to_string(),
        });

        // 10. WinAppRuntime (Windows App SDK)
        let (win_app_rt_ok, win_app_rt_ver) = {
            let found = installed_pkgs.iter().find(|(k, _)| {
                k.starts_with("microsoft.windowsappruntime")
                    || k.starts_with("microsoftcorporationii.winappruntime")
            });
            if let Some((_, v)) = found {
                (true, Some(v.clone()))
            } else {
                (false, None)
            }
        };
        items.push(BedrockDependencyItem {
            key: "win_app_runtime".to_string(),
            name: "Windows App SDK 运行库 (WinAppRuntime)".to_string(),
            required: false,
            installed: win_app_rt_ok,
            version: win_app_rt_ver,
            min_version: None,
            fix_hint: "现代 Windows App SDK 运行环境组件".to_string(),
        });

        let all_satisfied = vc_redist && gs_installed && xbox_installed && vclibs_ok && net_rt_ok;

        let report = BedrockFullDependencyReport {
            all_satisfied,
            developer_mode: dev_mode,
            vc_redist_x64: vc_redist,
            gaming_services: gs_installed,
            xbox_app: xbox_installed,
            uwp_client: uwp_installed,
            items,
        };

        if let Ok(mut guard) = DEPENDENCY_CACHE.lock() {
            *guard = Some((Instant::now(), report.clone()));
        }
        report
    }

    #[cfg(not(target_os = "windows"))]
    {
        BedrockFullDependencyReport {
            all_satisfied: true,
            developer_mode: true,
            vc_redist_x64: true,
            gaming_services: true,
            xbox_app: true,
            uwp_client: false,
            items: Vec::new(),
        }
    }
}

pub fn auto_fix_bedrockboot_dependencies(
    app: Option<&crate::bridge::AppHandle>,
) -> BedrockFullDependencyReport {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        ensure_gaming_services_running(app);

        if !check_developer_mode() {
            emit_bedrock_log(app, "【自动修复】正在配置 Windows 开发者模式…");
            let _ = enable_developer_mode();
        }

        if !check_vc_redist_x64() {
            emit_bedrock_log(
                app,
                "【自动修复】正在安装 Visual C++ 2015-2022 (x64) 运行库…",
            );
            let _ = Command::new("winget")
                .args([
                    "install",
                    "Microsoft.VCRedist.2015+.x64",
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ])
                .creation_flags(0x0800_0000)
                .output();
        }

        let runtime = provision_bedrock_runtime(app);
        if !runtime.ready {
            emit_bedrock_log(app, "【自动修复】正在通过微软官方商店补齐缺失组件…");
        }

        invalidate_runtime_cache();
        invalidate_dependency_cache();
        check_bedrockboot_dependencies(true)
    }

    #[cfg(not(target_os = "windows"))]
    {
        check_bedrockboot_dependencies(true)
    }
}

// ---------------------------------------------------------------------------
// Xbox GDK Runtime Automation (.msixvc encrypted packages)
//
// Xbox GDK packages are encrypted for the Microsoft Store delivery pipeline and
// cannot be registered with Add-AppxPackage. Instead of asking the user to
// install the Xbox app / Gaming Services by hand, the launcher provisions the
// whole runtime itself (winget / Microsoft Store) and then boots the installed
// UWP client.
// ---------------------------------------------------------------------------

pub const XBOX_APP_STORE_ID: &str = "9MV0B5HZVK9Z";
pub const GAMING_SERVICES_STORE_ID: &str = "9MWPM2CQNLHN";
pub const MINECRAFT_STORE_ID: &str = "9NBLGGH2JHXJ";

const XBOX_APP_PACKAGE: &str = "Microsoft.GamingApp";
const GAMING_SERVICES_PACKAGE: &str = "Microsoft.GamingServices";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BedrockRuntimeStatus {
    pub xbox_app_installed: bool,
    pub gaming_services_installed: bool,
    pub minecraft_uwp_installed: bool,
    pub winget_available: bool,
    pub ready: bool,
}

static RUNTIME_CACHE: std::sync::Mutex<Option<(Instant, BedrockRuntimeStatus)>> =
    std::sync::Mutex::new(None);
static GDK_AUTOFIX_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn invalidate_runtime_cache() {
    if let Ok(mut guard) = RUNTIME_CACHE.lock() {
        *guard = None;
    }
    // A client installed or removed since the last probe must not stay cached.
    if let Ok(mut guard) = UWP_CACHE.lock() {
        *guard = None;
    }
}

#[cfg(target_os = "windows")]
fn appx_package_installed(package_name: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Fast path: the package family folder appears once the app has been staged
    let lower = package_name.to_ascii_lowercase();
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        if let Ok(entries) = std::fs::read_dir(PathBuf::from(local_appdata).join("Packages")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if name.starts_with(&lower) {
                    return true;
                }
            }
        }
    }

    // Authoritative check through the Appx package manager
    let script = format!(
        "if (Get-AppxPackage -Name '{}' -ErrorAction SilentlyContinue) {{ 'installed' }} else {{ 'missing' }}",
        package_name
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    match cmd.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .to_ascii_lowercase()
            .contains("installed"),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn appx_package_installed(_package_name: &str) -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn find_winget_exe() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // 1. Try directly in PATH
    let mut cmd = Command::new("winget");
    cmd.arg("--version");
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            return Some(PathBuf::from("winget"));
        }
    }

    // 2. Try LOCALAPPDATA\Microsoft\WindowsApps\winget.exe
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(local_appdata)
            .join("Microsoft")
            .join("WindowsApps")
            .join("winget.exe");
        if p.is_file() {
            return Some(p);
        }
    }

    // 3. Try Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*\winget.exe
    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let windows_apps = PathBuf::from(program_files).join("WindowsApps");
        if let Ok(entries) = std::fs::read_dir(windows_apps) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("Microsoft.DesktopAppInstaller") {
                    let candidate = entry.path().join("winget.exe");
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn winget_available() -> bool {
    find_winget_exe().is_some()
}

#[cfg(not(target_os = "windows"))]
fn winget_available() -> bool {
    false
}

#[cfg(target_os = "windows")]
pub fn ensure_gaming_services_running(app: Option<&crate::bridge::AppHandle>) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // 1. Start Xbox Live auth, networking, save, and GamingServices if stopped
    let script = r#"
        $services = @('XblAuthManager', 'XblGameSave', 'XboxNetApiSvc', 'GamingServices', 'GamingServicesNet', 'wlidsvc')
        foreach ($s in $services) {
            $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
            if ($svc) {
                if ($svc.StartType -eq 'Disabled') {
                    Set-Service -Name $s -StartupType Manual -ErrorAction SilentlyContinue
                }
                if ($svc.Status -ne 'Running') {
                    Start-Service -Name $s -ErrorAction SilentlyContinue
                }
            }
        }
    "#;
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.output();

    // 2. Configure network loopback exemption for standard, beta, xbox identity provider, and deployed packages
    let mut packages = vec![
        "Microsoft.MinecraftUWP_8wekyb3d8bbwe".to_string(),
        "Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe".to_string(),
        "Microsoft.XboxIdentityProvider_8wekyb3d8bbwe".to_string(),
    ];
    if let Some(pfn) = locally_deployed_minecraft_pfn() {
        if !packages.contains(&pfn) {
            packages.push(pfn);
        }
    }

    for pkg in packages {
        let _ = Command::new("CheckNetIsolation")
            .args(["LoopbackExempt", "-a", &format!("-n={pkg}")])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }

    emit_bedrock_log(
        app,
        "已自动检查并激活 Xbox 登录服务 (XblAuthManager)、游戏服务与网络环回豁免。",
    );
}

#[cfg(not(target_os = "windows"))]
pub fn ensure_gaming_services_running(_app: Option<&crate::bridge::AppHandle>) {}

pub fn get_bedrock_runtime_status(force: bool) -> BedrockRuntimeStatus {
    if !force {
        if let Ok(guard) = RUNTIME_CACHE.lock() {
            if let Some((timestamp, cached)) = guard.as_ref() {
                if timestamp.elapsed() < std::time::Duration::from_secs(20) {
                    return cached.clone();
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    let status = {
        let xbox_app_installed = appx_package_installed(XBOX_APP_PACKAGE);
        let gaming_services_installed = appx_package_installed(GAMING_SERVICES_PACKAGE);
        let minecraft_uwp_installed = is_uwp_installed();
        BedrockRuntimeStatus {
            xbox_app_installed,
            gaming_services_installed,
            minecraft_uwp_installed,
            winget_available: winget_available(),
            ready: xbox_app_installed && gaming_services_installed && minecraft_uwp_installed,
        }
    };

    #[cfg(not(target_os = "windows"))]
    let status = {
        let minecraft_uwp_installed = is_uwp_installed();
        BedrockRuntimeStatus {
            xbox_app_installed: true,
            gaming_services_installed: true,
            minecraft_uwp_installed,
            winget_available: false,
            ready: true,
        }
    };

    if let Ok(mut guard) = RUNTIME_CACHE.lock() {
        *guard = Some((Instant::now(), status.clone()));
    }
    status
}

fn emit_bedrock_log(app: Option<&crate::bridge::AppHandle>, message: impl Into<String>) {
    if let Some(app) = app {
        let _ = app.emit(
            "game:log",
            serde_json::json!({ "stream": "cobble", "line": format!("[基岩运行环境] {}", message.into()) }),
        );
    }
}

#[cfg(target_os = "windows")]
fn open_store_page(product_id: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let uri = format!("ms-windows-store://pdp/?productid={product_id}");
    Command::new("explorer")
        .arg(uri)
        .creation_flags(0x0800_0000)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("打开 Microsoft Store 页面失败: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn open_store_page(_product_id: &str) -> Result<(), String> {
    Err("Microsoft Store 仅在 Windows 平台可用".to_string())
}

#[cfg(target_os = "windows")]
fn winget_install_store_product(
    product_id: &str,
    label: &str,
    app: Option<&crate::bridge::AppHandle>,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let winget_bin = find_winget_exe().unwrap_or_else(|| PathBuf::from("winget"));
    emit_bedrock_log(
        app,
        format!("正在通过 winget 自动安装 {label}（Store ID: {product_id}）…"),
    );
    let mut cmd = Command::new(&winget_bin);
    cmd.args([
        "install",
        "--id",
        product_id,
        "--source",
        "msstore",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
        "--silent",
    ]);
    cmd.creation_flags(0x0800_0000);

    let output = cmd
        .output()
        .map_err(|e| format!("{label} 自动安装失败：无法调用 winget ({e})"))?;
    let merged = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let lower = merged.to_ascii_lowercase();
    let already_ok = lower.contains("already installed")
        || lower.contains("no applicable")
        || merged.contains("已安装")
        || merged.contains("无需更新");

    if output.status.success() || already_ok {
        emit_bedrock_log(app, format!("{label} 安装完成"));
        Ok(())
    } else {
        let detail = merged
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.is_empty())
            .last()
            .unwrap_or("未知错误")
            .to_string();
        Err(format!(
            "{label} 自动安装未完成（退出码 {:?}）: {}",
            output.status.code(),
            detail
        ))
    }
}

#[cfg(target_os = "windows")]
fn appx_identity_attr(manifest: &Path, attr: &str) -> Option<String> {
    let text = std::fs::read_to_string(manifest).ok()?;
    let start = text.find("<Identity")?;
    let rest = &text[start..];
    let needle = format!("{attr}=\"");
    let value_start = rest.find(&needle)? + needle.len();
    let value_end = rest[value_start..].find('"')? + value_start;
    let value = rest[value_start..value_end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Reads the application id from the manifest's `<Application>` element. Bedrock
/// uses `App`, and activation needs it for `shell:AppsFolder\<PFN>!<AppId>`.
#[cfg(target_os = "windows")]
fn appx_application_id(manifest: &Path) -> Option<String> {
    let text = std::fs::read_to_string(manifest).ok()?;
    let start = text.find("<Application")?;
    let rest = &text[start..];
    let value_start = rest.find("Id=\"")? + 4;
    let value_end = rest[value_start..].find('"')? + value_start;
    let value = rest[value_start..value_end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(target_os = "windows")]
fn ps_single_quoted(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

/// Names of the `<PackageDependency>` framework packages a manifest declares.
#[cfg(target_os = "windows")]
fn appx_framework_dependencies(manifest: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(manifest) else {
        return Vec::new();
    };
    let mut names = Vec::new();
    let mut cursor = 0usize;
    while let Some(rel) = text[cursor..].find("<PackageDependency") {
        let start = cursor + rel;
        let Some(end_rel) = text[start..].find("/>") else {
            break;
        };
        let element = &text[start..start + end_rel];
        if let Some(name) = element
            .split("Name=\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
        {
            let name = name.trim();
            if !name.is_empty() {
                names.push(name.to_string());
            }
        }
        cursor = start + end_rel + 2;
    }
    names
}

/// Drops `<PackageDependency>` entries for framework packages that are not
/// installed on this machine.
///
/// Deployment fails with `0x80073CF3` when a declared framework is missing, and
/// some frameworks (e.g. `Microsoft.Services.Store.Engagement` on 1.16-1.18)
/// only ever ship through the Microsoft Store. A locally deployed core has to
/// stand on its own, so the optional dependency is removed from the unpacked
/// manifest — the same manifest edit BedrockBoot performs. The untouched copy is
/// kept next to it as `AppxManifest.factory.xml`.
#[cfg(target_os = "windows")]
fn strip_missing_appx_dependencies(manifest: &Path) -> Vec<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let declared = appx_framework_dependencies(manifest);
    if declared.is_empty() {
        return Vec::new();
    }

    let script = "$ErrorActionPreference = 'SilentlyContinue'; Get-AppxPackage | ForEach-Object { 'PKG=' + $_.Name }";
    let installed: Vec<String> = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| line.trim().strip_prefix("PKG=").map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    let missing: Vec<String> = declared
        .iter()
        .filter(|name| !installed.iter().any(|have| have.eq_ignore_ascii_case(name)))
        .cloned()
        .collect();
    if missing.is_empty() {
        return Vec::new();
    }

    let Ok(original) = std::fs::read_to_string(manifest) else {
        return Vec::new();
    };
    let backup = manifest.with_file_name("AppxManifest.factory.xml");
    if !backup.is_file() {
        let _ = std::fs::write(&backup, &original);
    }

    let mut patched = original.clone();
    for name in &missing {
        let mut search = 0usize;
        while let Some(rel) = patched[search..].find("<PackageDependency") {
            let start = search + rel;
            let Some(end_rel) = patched[start..].find("/>") else {
                break;
            };
            let end = start + end_rel + 2;
            let element = &patched[start..end];
            let matches = element
                .split("Name=\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .map(|value| value.trim().eq_ignore_ascii_case(name))
                .unwrap_or(false);
            if matches {
                patched.replace_range(start..end, "");
                search = start;
            } else {
                search = end;
            }
        }
    }

    if patched != original && std::fs::write(manifest, patched).is_ok() {
        missing
    } else {
        Vec::new()
    }
}

/// Deploys an unpacked AppX layout as a *development* package and returns its
/// package family name.
///
/// This is the BedrockBoot recipe (`PackageManager.RegisterPackageAsync(... ,
/// DeploymentOptions.DevelopmentMode)`) done through the deployment API: the
/// core is installed straight from the files the launcher downloaded, so no
/// Microsoft Store, no Store license and no network are involved.
///
/// `-DisableDevelopmentMode` must NOT be passed here. That flag asks Windows to
/// re-register an *already installed* package, so it insists the manifest sits in
/// the package's registered install root and rejects every loose layout with
/// `0x80073CF9` / `0x80070057` ("manifest is not in the package root"). That
/// rejection used to leave the package family name empty, which made activation
/// fall back to the `minecraft:` protocol and pop up the "浏览 Microsoft Store"
/// dialog.
#[cfg(target_os = "windows")]
fn register_loose_appx(dir: &Path, manifest: &Path) -> Result<(String, Vec<String>), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // A leftover signature blocks development-mode registration (BedrockBoot step).
    let signature = dir.join("AppxSignature.p7x");
    if signature.is_file() {
        let _ = force_remove_file(&signature);
    }

    // Framework packages that are not installed here would abort deployment with
    // 0x80073CF3; the unpacked core keeps working without them.
    let stripped = strip_missing_appx_dependencies(manifest);

    let identity_name = appx_identity_attr(manifest, "Name").unwrap_or_default();
    if identity_name.trim().is_empty() {
        return Err(format!(
            "AppxManifest.xml 缺少 Identity/Name，无法本地部署: {}",
            manifest.display()
        ));
    }

    if !check_developer_mode() {
        let _ = enable_developer_mode();
        std::thread::sleep(std::time::Duration::from_millis(600));
        if !check_developer_mode() {
            return Err(
                "本地部署 AppX 核心需要 Windows「开发人员模式」（设置 → 系统 → 开发者选项）。\
                 启动器不会改用 Microsoft Store 安装。"
                    .to_string(),
            );
        }
    }

    let manifest_q = ps_single_quoted(manifest);
    // 1. A packaged (Store) copy of the same identity can never be replaced by a
    //    loose deployment, so report it instead of silently failing activation.
    // 2. Any development copy is unregistered first: Windows refuses to register
    //    over an existing deployment (0x80073CFB), and dropping it is what makes
    //    switching between downloaded versions work.
    let script = format!(
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; \
         $ErrorActionPreference = 'SilentlyContinue'; \
         $p = Get-AppxPackage -Name '{identity_name}' | Select-Object -First 1; \
         if ($p -and (-not $p.IsDevelopmentMode)) {{ Write-Output 'STORE_INSTALL'; exit 0 }}; \
         if ($p) {{ Remove-AppxPackage -Package $p.PackageFullName | Out-Null }}; \
         try {{ Add-AppxPackage -Register '{manifest_q}' -ErrorAction Stop }} catch {{ Write-Output ('ERROR=' + $_.Exception.Message); exit 0 }}; \
         $p = Get-AppxPackage -Name '{identity_name}' | Select-Object -First 1; \
         if ($p) {{ Write-Output ('PFN=' + $p.PackageFamilyName) }} else {{ Write-Output 'ERROR=注册后未找到程序包' }}"
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("调用 Windows 应用部署接口失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    let mut pfn: Option<String> = None;
    let mut store_install = false;
    let mut detail: Option<String> = None;
    for line in stdout.lines().map(|line| line.trim()) {
        if line == "STORE_INSTALL" {
            store_install = true;
        } else if let Some(value) = line.strip_prefix("PFN=") {
            pfn = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("ERROR=") {
            detail = Some(value.trim().to_string());
        }
    }

    if let Some(pfn) = pfn.filter(|value| !value.is_empty()) {
        return Ok((pfn, stripped));
    }

    if store_install {
        return Err(
            "本机已经通过 Microsoft Store 安装了同一身份的基岩版客户端，Windows 不允许用本地部署版本\
             覆盖商店版本。请先在「设置 → 应用 → 已安装的应用」中卸载商店版 Minecraft for Windows，\
             再回到启动器启动。（启动器不会代你安装或打开 Microsoft Store）"
                .to_string(),
        );
    }

    let message = detail.filter(|value| !value.is_empty()).unwrap_or_else(|| {
        let fallback = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        if fallback.is_empty() {
            "未知错误".to_string()
        } else {
            fallback
        }
    });
    Err(format!("本地部署 AppX 核心失败: {message}"))
}

/// Package family name of a client this launcher deployed itself (development
/// mode). Such a core starts immediately: it never depended on the Microsoft
/// Store licence, so the Xbox runtime pre-flight does not apply to it.
#[cfg(target_os = "windows")]
fn locally_deployed_minecraft_pfn() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    for name in ["Microsoft.MinecraftUWP", "Microsoft.MinecraftWindowsBeta"] {
        let script = format!(
            "$p = Get-AppxPackage -Name '{name}' | Where-Object {{ $_.IsDevelopmentMode }} | Select-Object -First 1; if ($p) {{ $p.PackageFamilyName }}"
        );
        let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        else {
            continue;
        };
        let pfn = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if pfn
            .rsplit_once('_')
            .map(|(_, publisher)| publisher.len() == 13)
            .unwrap_or(false)
        {
            return Some(pfn);
        }
    }
    None
}

/// Package family name of an installed Minecraft / Minecraft Preview client,
/// queried from the Appx package manager. GDK builds share the same identity.
#[cfg(target_os = "windows")]
fn installed_minecraft_pfn() -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    for name in ["Microsoft.MinecraftUWP", "Microsoft.MinecraftWindowsBeta"] {
        let script = format!(
            "$p = Get-AppxPackage -Name '{name}' | Select-Object -First 1; if ($p) {{ $p.PackageFamilyName }}"
        );
        let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        else {
            continue;
        };
        let pfn = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if pfn
            .rsplit_once('_')
            .map(|(_, publisher)| publisher.len() == 13)
            .unwrap_or(false)
        {
            return Some(pfn);
        }
    }
    None
}

/// Last resort: activate whatever Minecraft package Windows has registered,
/// including a core the user side-loaded themselves. `None` when nothing is
/// registered at all.
#[cfg(target_os = "windows")]
fn launch_registered_client() -> Option<Result<String, String>> {
    let pfn = installed_minecraft_pfn()?;
    Some(
        launch_uwp_package(Some(pfn.as_str()), "App")
            .map(|_| "已唤起本机已注册的 Minecraft 基岩版".to_string()),
    )
}

#[cfg(not(target_os = "windows"))]
fn launch_registered_client() -> Option<Result<String, String>> {
    None
}

/// Activates a registered Minecraft package by its app model id.
///
/// There is deliberately no `minecraft:` protocol fallback: when no package
/// family name is known that protocol is either unregistered (Windows then shows
/// the "获取打开此'minecraft'链接的应用 / 浏览 Microsoft Store" dialog) or it boots
/// the Store client instead of the core the user picked.
#[cfg(target_os = "windows")]
fn launch_uwp_package(
    package_family_name: Option<&str>,
    application_id: &str,
) -> Result<(), String> {
    let Some(pfn) = package_family_name.filter(|p| !p.trim().is_empty()) else {
        return Err(
            "未能取得基岩版程序包标识（PackageFamilyName），已取消启动。启动器不会通过\
             Microsoft Store 打开游戏，请重新下载该版本以完成本地部署。"
                .to_string(),
        );
    };
    Command::new("explorer")
        .arg(format!(
            "shell:AppsFolder\\{}!{}",
            pfn.trim(),
            application_id
        ))
        .spawn()
        .map_err(|e| format!("按应用标识启动基岩版失败: {e}"))?;
    Ok(())
}

/// BedrockBoot-style launch of an unpacked UWP/AppX core: developer mode, local
/// manifest registration, then activation of exactly that package. Nothing here
/// touches the Microsoft Store or its license.
#[cfg(target_os = "windows")]
fn launch_appx_core(
    manifest: &Path,
    exe: Option<&Path>,
    label: &str,
    game_root: &Path,
) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    if let Some(exe) = exe {
        clean_exe_run_as_admin(exe);
    }
    let dir = manifest.parent().map(Path::to_path_buf).unwrap_or_default();
    let (pfn, stripped) = register_loose_appx(&dir, manifest)?;
    // Registration is what gives the package its data folder. Packs and worlds
    // imported before that folder existed are still in the staging area, so move
    // them in now — the sync at the start of the launch runs too early for the
    // very first launch and the game would see an empty pack list.
    let seeded = seed_package_data_dir(&pfn, game_root);
    let _ = Command::new("CheckNetIsolation")
        .args(["LoopbackExempt", "-a", &format!("-n={}", pfn.trim())])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let app_id = appx_application_id(manifest).unwrap_or_else(|| "App".to_string());
    launch_uwp_package(Some(pfn.as_str()), &app_id)?;
    let mut message =
        format!("已从本地核心启动 Minecraft 基岩版 ({label})，未经过 Microsoft Store");
    if !stripped.is_empty() {
        message.push_str(&format!(
            "；已跳过本机未安装的框架依赖: {}",
            stripped.join("、")
        ));
    }
    if seeded > 0 {
        message.push_str(&format!(
            "；已把 {seeded} 个此前导入的附加包/存档同步进游戏数据目录"
        ));
    }
    Ok(message)
}

#[cfg(target_os = "windows")]
fn install_and_launch_appx(pkg: &Path, label: &str, game_root: &Path) -> Result<String, String> {
    let dir = pkg.parent().unwrap_or(pkg);
    let manifest = dir.join("AppxManifest.xml");
    if manifest.is_file() {
        return launch_appx_core(&manifest, None, label, game_root);
    }
    Err(format!(
        "{label} 的 AppX 安装包还没有完成本地部署。请回到“下载”页面重新安装该版本，\
         启动器会直接解包并在本地注册核心，无需 Microsoft Store。"
    ))
}

/// Installs the missing Xbox runtime pieces (Xbox app + Gaming Services) so an
/// encrypted .msixvc package can be played through the Store-delivered client.
pub fn provision_bedrock_runtime(app: Option<&crate::bridge::AppHandle>) -> BedrockRuntimeStatus {
    #[cfg(target_os = "windows")]
    {
        ensure_gaming_services_running(app);

        let status = get_bedrock_runtime_status(true);
        if status.ready {
            return status;
        }

        if !status.winget_available {
            emit_bedrock_log(
                app,
                "未检测到 winget 包管理器，已改为自动打开 Microsoft Store 安装页面。",
            );
            if !status.xbox_app_installed {
                let _ = open_store_page(XBOX_APP_STORE_ID);
            }
            if !status.gaming_services_installed {
                let _ = open_store_page(GAMING_SERVICES_STORE_ID);
            }
            if !status.minecraft_uwp_installed {
                emit_bedrock_log(
                    app,
                    "未检测到本机基岩版客户端，请到“下载”页面下载版本（启动器本地部署，不经过 Microsoft Store）。",
                );
            }
            invalidate_runtime_cache();
            return get_bedrock_runtime_status(true);
        }

        if !status.xbox_app_installed {
            if let Err(err) = winget_install_store_product(XBOX_APP_STORE_ID, "Xbox 应用", app) {
                emit_bedrock_log(app, err);
            }
        }

        if !status.gaming_services_installed {
            if let Err(err) = winget_install_store_product(
                GAMING_SERVICES_STORE_ID,
                "游戏服务 Gaming Services",
                app,
            ) {
                emit_bedrock_log(app, err);
            }
        }

        ensure_gaming_services_running(app);
        invalidate_runtime_cache();
        let refreshed = get_bedrock_runtime_status(true);

        // Whatever winget could not deliver is handed over to the Store UI automatically
        if !refreshed.xbox_app_installed {
            emit_bedrock_log(
                app,
                "winget 未能完成 Xbox 应用安装，已自动打开 Microsoft Store 页面。",
            );
            let _ = open_store_page(XBOX_APP_STORE_ID);
        }
        if !refreshed.gaming_services_installed {
            emit_bedrock_log(
                app,
                "winget 未能完成游戏服务安装，已自动打开 Microsoft Store 页面。",
            );
            let _ = open_store_page(GAMING_SERVICES_STORE_ID);
        }
        if !refreshed.minecraft_uwp_installed {
            emit_bedrock_log(
                app,
                "未检测到本机基岩版客户端。启动器不会打开 Microsoft Store 安装游戏，请到“下载”页面下载版本后本地部署。",
            );
        }
        refreshed
    }

    #[cfg(not(target_os = "windows"))]
    {
        get_bedrock_runtime_status(true)
    }
}

#[cfg(target_os = "windows")]
fn spawn_gdk_auto_provision(
    app: Option<crate::bridge::AppHandle>,
    open_minecraft_store: bool,
    launch_after_install: bool,
) {
    if GDK_AUTOFIX_ACTIVE.swap(true, Ordering::SeqCst) {
        emit_bedrock_log(app.as_ref(), "Xbox 运行环境自动程序已在执行中，请稍候…");
        return;
    }

    std::thread::spawn(move || {
        let app_ref = app.as_ref();
        emit_bedrock_log(app_ref, "【自动程序】开始自动配置 Xbox GDK 运行环境…");
        let status = provision_bedrock_runtime(app_ref);

        if status.ready {
            emit_bedrock_log(app_ref, "【自动程序】Xbox 运行环境与游戏依赖已全部就绪。");
        } else {
            let mut missing: Vec<&str> = Vec::new();
            if !status.xbox_app_installed {
                missing.push("Xbox 应用");
            }
            if !status.gaming_services_installed {
                missing.push("游戏服务 Gaming Services");
            }
            if !status.minecraft_uwp_installed {
                missing.push("Minecraft for Windows (UWP)");
            }
            emit_bedrock_log(
                app_ref,
                format!(
                    "【自动程序】运行依赖状态：缺失组件 [{}]。已为您自动弹出微软官方商店安装引导。",
                    missing.join("、")
                ),
            );
        }

        if open_minecraft_store && !status.minecraft_uwp_installed {
            emit_bedrock_log(
                app_ref,
                "【自动程序】未检测到本机基岩版客户端。启动器不再自动打开 Microsoft Store，请到“下载”页面选择版本本地部署。",
            );
        } else if launch_after_install {
            if status.minecraft_uwp_installed {
                emit_bedrock_log(app_ref, "【自动程序】正在自动唤起 Minecraft 基岩版客户端…");
                let pfn = installed_minecraft_pfn();
                if let Err(err) = launch_uwp_package(pfn.as_deref(), "App") {
                    emit_bedrock_log(app_ref, format!("【自动程序】唤起基岩版客户端失败: {err}"));
                }
            } else {
                emit_bedrock_log(
                    app_ref,
                    "【自动程序】Minecraft for Windows 尚未就绪，请先到“下载”页面安装对应版本。",
                );
            }
        }

        emit_bedrock_log(app_ref, "【自动程序】Xbox 运行环境自动处理流程已完成。");
        GDK_AUTOFIX_ACTIVE.store(false, Ordering::SeqCst);
    });
}

/// Handles an encrypted Xbox GDK (.msixvc) package end to end: provisions the
/// Xbox runtime when needed, then launches the Store client automatically.
#[cfg(target_os = "windows")]
fn auto_handle_msixvc_package(
    app: Option<&crate::bridge::AppHandle>,
    _game_root: &Path,
    version_id: &str,
) -> Result<String, String> {
    ensure_gaming_services_running(app);
    let status = get_bedrock_runtime_status(false);
    let runtime_missing = !status.xbox_app_installed || !status.gaming_services_installed;

    if status.minecraft_uwp_installed && !runtime_missing {
        let pfn = installed_minecraft_pfn();
        launch_uwp_package(pfn.as_deref(), "App")?;
        return Ok(format!(
            "{version_id} 为 Xbox GDK 加密包 (.msixvc)。自动程序检测到 Xbox 环境完整，已成功为您唤起 Minecraft 基岩版！"
        ));
    }

    if status.minecraft_uwp_installed {
        spawn_gdk_auto_provision(app.cloned(), false, true);
        return Ok(format!(
            "{version_id} 为 Xbox GDK 加密包。自动程序正在后台自动补齐「Xbox 应用与游戏服务」，完成后会自动唤起游戏，进度可在启动日志查看。"
        ));
    }

    spawn_gdk_auto_provision(app.cloned(), true, false);
    // Deliberately no background BDS deployment here: the user already owns this
    // core, and silently pulling a second full game download looks like the
    // launcher fetching the game twice. Point at the playable option instead.
    Ok(format!(
        "{version_id} 为 Xbox GDK 加密包 (.msixvc)，必须由微软官方客户端承载，启动器无法直接解包运行。\n✔ 已自动检查 Xbox 与游戏服务环境，不会打开 Microsoft Store 安装游戏；\n✔ 请改选同版本的「UWP / AppX 核心」：启动器会解包并在本机以开发模式注册后直接启动，不经过 Microsoft Store；\n✔ 本次没有额外下载任何核心，以免重复占用磁盘。"
    ))
}

#[cfg(not(target_os = "windows"))]
fn auto_handle_msixvc_package(
    _app: Option<&crate::bridge::AppHandle>,
    _game_root: &Path,
    _version_id: &str,
) -> Result<String, String> {
    Err("Xbox GDK 加密包仅支持在 Windows 平台运行".to_string())
}

// ---------------------------------------------------------------------------
// BDS Version Index
// ---------------------------------------------------------------------------

/// Version index published by the Bedrock-OSS / EndstoneMC projects. Its
/// `windows` list is the only source of working BDS download URLs: the Store
/// catalog (mcappx) contains UWP/GDK packages only, so an offline launch can
/// never be satisfied from it.
#[derive(Debug, Clone, Deserialize)]
struct BdsVersionsIndex {
    #[serde(default)]
    cdn_root: Option<String>,
    #[serde(default)]
    windows: Option<BdsWindowsVersions>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct BdsWindowsVersions {
    #[serde(default)]
    versions: Vec<String>,
    #[serde(default)]
    preview_versions: Vec<String>,
}

impl BdsVersionsIndex {
    fn into_items(self, source_name: &str) -> Vec<BedrockVersionItem> {
        let cdn_root = self
            .cdn_root
            .filter(|root| root.starts_with("http"))
            .unwrap_or_else(|| "https://www.minecraft.net/bedrockdedicatedserver".to_string());
        let cdn_root = cdn_root.trim_end_matches('/').to_string();

        let Some(windows) = self.windows else {
            return Vec::new();
        };

        let mut items = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (versions, is_preview) in [
            (&windows.versions, false),
            (&windows.preview_versions, true),
        ] {
            for version in versions {
                if !seen.insert(version.clone()) {
                    continue;
                }
                items.push(BedrockVersionItem {
                    id: version.clone(),
                    name: if is_preview {
                        format!("Minecraft 基岩预览版 {version} (BDS)")
                    } else {
                        format!("Minecraft 基岩版 {version} (BDS)")
                    },
                    version: version.clone(),
                    release_type: if is_preview { "preview" } else { "release" }.to_string(),
                    download_url: format!("{cdn_root}/bin-win/bedrock-server-{version}.zip"),
                    store_url: None,
                    date: "BDS 官方版本索引".to_string(),
                    size: 85_983_232,
                    sha256: None,
                    api_source: Some(source_name.to_string()),
                    build_type: Some("BDS".to_string()),
                    md5: None,
                });
            }
        }

        items.sort_by(|a, b| version_sort_key(&b.version).cmp(&version_sort_key(&a.version)));
        items
    }
}

fn version_sort_key(version: &str) -> Vec<u32> {
    version
        .split('.')
        .filter_map(|part| {
            part.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u32>()
                .ok()
        })
        .collect()
}

/// Version IDs are dotted: `1.26.5` must not match `1.26.52.3`, so a prefix only
/// counts when it ends on a dot boundary.
fn version_ids_match(requested: &str, candidate: &str) -> bool {
    if requested.is_empty() || candidate.is_empty() {
        return false;
    }
    let extends_with_dot = |long: &str, prefix: &str| {
        long.strip_prefix(prefix)
            .map(|rest| rest.starts_with('.'))
            .unwrap_or(false)
    };
    requested == candidate
        || extends_with_dot(candidate, requested)
        || extends_with_dot(requested, candidate)
}

async fn fetch_bds_registry_versions() -> Vec<BedrockVersionItem> {
    const ENDPOINTS: &[&str] = &[
        "https://cdn.jsdelivr.net/gh/Bedrock-OSS/BDS-Versions@main/versions.json",
        "https://fastly.jsdelivr.net/gh/Bedrock-OSS/BDS-Versions@main/versions.json",
        "https://raw.gitmirror.com/Bedrock-OSS/BDS-Versions/main/versions.json",
        "https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json",
        "https://ghproxy.net/https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json",
    ];

    let client = net::client();
    for endpoint in ENDPOINTS {
        let Ok(response) = client
            .get(*endpoint)
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(text) = response.text().await else {
            continue;
        };
        let Ok(index) = serde_json::from_str::<BdsVersionsIndex>(&text) else {
            continue;
        };
        let items = index.into_items("BDS 官方版本索引");
        if !items.is_empty() {
            return items;
        }
    }

    // Last resort: reuse any BDS entries saved by an earlier successful fetch.
    load_cached_versions()
        .map(|items| {
            items
                .into_iter()
                .filter(|v| v.build_type.as_deref() == Some("BDS"))
                .collect()
        })
        .unwrap_or_default()
}

/// Automatically finds or downloads a matching direct-running BDS core for users
/// who prefer running Bedrock standalone without Microsoft Store or Xbox DRM.
pub async fn find_or_install_bds_fallback(
    app: &crate::bridge::AppHandle,
    game_root: &Path,
    version_id: &str,
) -> Result<String, String> {
    let clean_id = version_id
        .trim_start_matches("bedrock:")
        .trim_start_matches("Minecraft 基岩版:")
        .trim_start_matches("Minecraft 基岩版 ")
        .trim_start_matches("基岩版 ")
        .trim();

    // 1. Check if an unencrypted BDS version is already installed locally
    let versions_dir = game_root.join("bedrock").join("versions");
    if let Ok(entries) = std::fs::read_dir(&versions_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let insp = inspect_bedrock_version_dir(&p);
                if insp.is_valid && insp.is_server {
                    return Ok(format!(
                        "已找到已就绪的 BDS 免密独立核心 ({})，可直接独立启动游戏！",
                        insp.folder_name
                    ));
                }
            }
        }
    }

    // 2. Fetch the BDS version index. The Store (mcappx) catalog only carries
    // UWP/GDK packages, so it can never satisfy an offline launch.
    let bds_versions = fetch_bds_registry_versions().await;
    let target = bds_versions
        .iter()
        .find(|v| v.release_type == "release" && version_ids_match(&clean_id, &v.id))
        .or_else(|| {
            bds_versions
                .iter()
                .find(|v| version_ids_match(&clean_id, &v.id))
        })
        .or_else(|| bds_versions.iter().find(|v| v.release_type == "release"))
        .or_else(|| bds_versions.first());

    let Some(target) = target else {
        return Err("未能获取到可用的 BDS 免密核心版本索引，请检查网络后重试。".to_string());
    };

    emit_bedrock_log(
        Some(app),
        format!(
            "【自动程序】正在为您下载并部署免密独立 BDS 核心: {}…",
            target.name
        ),
    );
    install_bedrock_version(
        app,
        game_root,
        &target.id,
        &target.download_url,
        Some("Mojang BDS 官方直链"),
        8,
    )
    .await?;
    Ok(format!(
        "自动程序已成功下载并部署 BDS 免密独立核心 ({})，无需 Xbox 登录即可独立直接运行！",
        target.name
    ))
}

/// First-launch guidance when no core is available. It deliberately does not
/// touch the Microsoft Store: every core is deployed from the package the
/// launcher downloads itself (see `register_loose_appx`), which is also what
/// keeps the launcher portable to Linux/macOS later on.
#[cfg(target_os = "windows")]
fn bootstrap_uwp_client(app: Option<&crate::bridge::AppHandle>) -> String {
    emit_bedrock_log(
        app,
        "未检测到可用的基岩版核心；启动器不会通过 Microsoft Store 安装游戏。",
    );
    "未检测到可用的基岩版核心。请到“下载”页面选择 UWP / GDK 版本，启动器会自行下载并在本地部署（不经过 Microsoft Store），完成后再点启动即可。".to_string()
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UwpLaunchPlan {
    LaunchNow,
    InstallDepsThenLaunch,
    BootstrapClient,
}

#[cfg(target_os = "windows")]
fn plan_uwp_launch(status: &BedrockRuntimeStatus) -> UwpLaunchPlan {
    if !status.minecraft_uwp_installed {
        UwpLaunchPlan::BootstrapClient
    } else if !status.ready {
        UwpLaunchPlan::InstallDepsThenLaunch
    } else {
        UwpLaunchPlan::LaunchNow
    }
}

/// Every launch that boots the Store client goes through here, so the Xbox
/// runtime dependencies are installed automatically on the first launch.
#[cfg(target_os = "windows")]
fn ensure_and_launch_uwp(
    app: Option<&crate::bridge::AppHandle>,
    offline_account: bool,
) -> Result<String, String> {
    // For online-authenticated accounts, prioritize the real Store/GDK client if installed
    // so Microsoft/Xbox Live account login and entitlements work seamlessly.
    if !offline_account {
        if let Some(pfn) = installed_minecraft_pfn() {
            launch_uwp_package(Some(&pfn), "App")?;
            return Ok("已成功唤起 Minecraft 基岩版正版客户端 (Windows)".to_string());
        }
    }

    // A core deployed locally by this launcher starts straight away
    if let Some(pfn) = locally_deployed_minecraft_pfn() {
        launch_uwp_package(Some(pfn.as_str()), "App")?;
        return Ok("已从本地核心唤起 Minecraft 基岩版".to_string());
    }

    let status = get_bedrock_runtime_status(false);

    match plan_uwp_launch(&status) {
        UwpLaunchPlan::BootstrapClient => Ok(bootstrap_uwp_client(app)),
        UwpLaunchPlan::InstallDepsThenLaunch => {
            spawn_gdk_auto_provision(app.cloned(), false, true);
            Ok(
                "运行环境自检：正在自动补齐「Xbox 应用 / 游戏服务」等运行依赖，安装完成后会自动唤起 Minecraft 基岩版，进度可在控制台查看。".to_string(),
            )
        }
        UwpLaunchPlan::LaunchNow => {
            let pfn = installed_minecraft_pfn();
            launch_uwp_package(pfn.as_deref(), "App")?;
            Ok("已成功唤起 Minecraft 基岩版 (Windows)".to_string())
        }
    }
}

/// Finds the newest standalone core below `<game_root>/bedrock/versions`. When
/// `prefer_bds` is set a BDS (server) core wins over unpacked AppX/client cores,
/// which is what offline accounts need: they cannot sign in to the Store client.
fn find_installed_standalone_core(
    game_root: &Path,
    prefer_bds: bool,
) -> Option<(PathBuf, PathBuf, bool, String)> {
    let versions_dir = game_root.join("bedrock").join("versions");
    let entries = std::fs::read_dir(&versions_dir).ok()?;
    let mut cores: Vec<(PathBuf, PathBuf, bool, String)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let insp = inspect_bedrock_version_dir(&dir);
        if let Some(exe) = insp.main_executable {
            let work_dir = exe.parent().unwrap_or(&dir).to_path_buf();
            cores.push((exe, work_dir, insp.is_server, insp.folder_name));
        }
    }

    // Folder names are version strings, so a descending sort puts the newest first
    cores.sort_by(|a, b| b.3.cmp(&a.3));
    if prefer_bds {
        if let Some(bds) = cores.iter().find(|c| c.2) {
            return Some(bds.clone());
        }
    }
    cores.into_iter().next()
}

/// Finds the newest unpacked UWP/AppX client core under `<game_root>/bedrock/versions`.
#[cfg(target_os = "windows")]
fn newest_client_core_dir(game_root: &Path) -> Option<PathBuf> {
    let entries = std::fs::read_dir(game_root.join("bedrock").join("versions")).ok()?;
    let mut cores: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let insp = inspect_bedrock_version_dir(&dir);
        if insp.is_server || !insp.is_valid {
            continue;
        }
        if insp.manifest_path.is_some()
            || insp.package_file.is_some()
            || insp.main_executable.is_some()
        {
            cores.push((insp.folder_name, dir));
        }
    }
    cores.sort_by(|a, b| b.0.cmp(&a.0));
    cores.into_iter().next().map(|(_, dir)| dir)
}

/// Launches an installed UWP/AppX/GDK client core. Unpacked AppX cores are
/// registered and activated directly; encrypted GDK packages are carried by the
/// Store client, so the Xbox runtime is provisioned for them.
#[cfg(target_os = "windows")]
fn launch_installed_client_core(
    app: Option<&crate::bridge::AppHandle>,
    game_root: &Path,
    version_id: &str,
) -> Option<Result<String, String>> {
    let dir = if version_id.trim().is_empty() {
        newest_client_core_dir(game_root)?
    } else {
        let dir = resolve_bedrock_version_dir(game_root, version_id);
        if !dir.is_dir() {
            return None;
        }
        dir
    };

    let insp = inspect_bedrock_version_dir(&dir);
    if insp.is_server || !insp.is_valid {
        return None;
    }

    if let Some(manifest) = insp.manifest_path.as_deref() {
        return Some(launch_appx_core(
            manifest,
            insp.main_executable.as_deref(),
            &insp.folder_name,
            game_root,
        ));
    }

    if let Some(pkg) = insp.package_file.as_deref() {
        let ext = pkg
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext == "appx" || ext == "msix" {
            return Some(install_and_launch_appx(pkg, &insp.folder_name, game_root));
        }
        if ext == "msixvc" {
            return Some(auto_handle_msixvc_package(
                app,
                game_root,
                &insp.folder_name,
            ));
        }
    }

    if let Some(exe) = insp.main_executable.as_deref() {
        let work_dir = exe.parent().unwrap_or(&dir);
        return Some(
            spawn_bedrock_exe(exe, work_dir, false)
                .map(|_| format!("已启动基岩版客户端核心 ({})", insp.folder_name)),
        );
    }

    None
}

/// Offline accounts launch Bedrock on a standalone core. When none is present the
/// BDS core is downloaded in the background and reported through the launch log.
fn start_bds_core_deployment(
    app: Option<&crate::bridge::AppHandle>,
    game_root: &Path,
    version_id: &str,
) -> String {
    emit_bedrock_log(
        app,
        "【自动程序】离线账户需要免密 BDS 独立核心，正在后台自动下载部署…",
    );

    let app_handle = app.cloned();
    let root = game_root.to_path_buf();
    let requested = version_id.to_string();
    tokio::spawn(async move {
        let Some(handle) = app_handle else {
            return;
        };
        match find_or_install_bds_fallback(&handle, &root, &requested).await {
            Ok(msg) => emit_bedrock_log(Some(&handle), format!("【自动程序】{msg}")),
            Err(err) => emit_bedrock_log(
                Some(&handle),
                format!("【自动程序】BDS 核心自动部署失败: {err}"),
            ),
        }
    });

    "本机暂未安装可用的基岩版核心。自动程序已在后台开始下载部署免密 BDS 独立核心，完成后再次点击「启动」即可进入游戏（进度见启动日志）。"
        .to_string()
}

/// Offline launches prefer an installed BDS core, then a downloaded UWP/AppX or
/// GDK client core, and only fall back to deploying a new BDS core when neither
/// exists. This keeps UWP/GDK cores the user downloaded playable.
fn launch_offline_bedrock_core(
    app: Option<&crate::bridge::AppHandle>,
    game_root: &Path,
    version_id: &str,
) -> Result<String, String> {
    if let Some((exe, work_dir, is_server, name)) = find_installed_standalone_core(game_root, true)
    {
        if is_server {
            spawn_bedrock_exe(&exe, &work_dir, true)?;
            return Ok(format!(
                "离线账户已使用 BDS 独立核心启动基岩版，已开启独立控制台窗口 ({name})"
            ));
        }
    }

    #[cfg(target_os = "windows")]
    if let Some(result) = launch_installed_client_core(app, game_root, version_id) {
        return result;
    }

    Ok(start_bds_core_deployment(app, game_root, version_id))
}

pub fn launch_bedrock_edition(
    game_root: &Path,
    version_id: Option<&str>,
    app: Option<&crate::bridge::AppHandle>,
    offline_account: bool,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        // Ensure Xbox Live auth, networking, gaming services and loopback exemptions are active
        ensure_gaming_services_running(app);

        // Packs and worlds imported before the client's data folder existed are
        // staged in the portable folder; deploy them before the game starts so
        // the first launch already sees them.
        let _ = sync_portable_content_to_clients(game_root);

        let bedrock_versions_dir = game_root.join("bedrock").join("versions");

        // 1. If explicit UWP is requested
        if let Some(vid) = version_id.filter(|s| !s.trim().is_empty()) {
            let clean_vid = vid
                .trim_start_matches("bedrock:")
                .trim_start_matches("Minecraft 基岩版:")
                .trim_start_matches("Minecraft 基岩版 ")
                .trim_start_matches("基岩版 ")
                .trim();

            if clean_vid.eq_ignore_ascii_case("uwp")
                || clean_vid.eq_ignore_ascii_case("bedrock-uwp")
            {
                if is_uwp_installed() {
                    return ensure_and_launch_uwp(app, offline_account);
                }
                // No Store client installed: a downloaded UWP/AppX core boots directly.
                if let Some(result) = launch_installed_client_core(app, game_root, "") {
                    return result;
                }
                if offline_account {
                    return Ok(start_bds_core_deployment(app, game_root, ""));
                }
                // First launch: bootstrap the missing runtime + Store client automatically
                return Ok(bootstrap_uwp_client(app));
            }

            // 2. Specific standalone version requested (e.g. 1.26.52 or unpacked AppX instance)
            let target_dir = resolve_bedrock_version_dir(game_root, clean_vid);
            if target_dir.is_dir() {
                let insp = inspect_bedrock_version_dir(&target_dir);

                // BedrockBoot-style AppxManifest package registration: boot the
                // exact UWP/AppX core the user selected, offline account or not.
                if let Some(manifest) = insp.manifest_path.clone() {
                    return launch_appx_core(
                        &manifest,
                        insp.main_executable.as_deref(),
                        clean_vid,
                        game_root,
                    );
                }

                if let Some(exe) = insp.main_executable {
                    let work_dir = exe.parent().unwrap_or(&target_dir);
                    spawn_bedrock_exe(&exe, work_dir, insp.is_server)?;
                    let type_desc = if insp.is_server {
                        "服务端核心，已开启独立控制台窗口"
                    } else {
                        "客户端"
                    };
                    return Ok(format!("已启动基岩版{type_desc} ({clean_vid})"));
                }

                if let Some(pkg) = insp.package_file {
                    let ext = pkg
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if ext == "appx" || ext == "msix" {
                        return install_and_launch_appx(&pkg, clean_vid, game_root);
                    } else if ext == "msixvc" {
                        // Xbox GDK encrypted package: provision the Xbox runtime and
                        // boot the Store client automatically instead of failing.
                        return auto_handle_msixvc_package(app, game_root, clean_vid);
                    }
                }
            }

            // Missing version: fall back to an installed BDS/UWP/GDK core.
            if offline_account {
                return launch_offline_bedrock_core(app, game_root, clean_vid);
            }

            // If requested standalone version directory is missing, fallback to UWP if installed
            if is_uwp_installed() {
                return ensure_and_launch_uwp(app, offline_account);
            }

            // Any core this launcher deployed starts with its package identity,
            // and a package registered by other means is still activatable.
            if let Some(result) = launch_installed_client_core(app, game_root, "") {
                return result;
            }
            if let Some(result) = launch_registered_client() {
                return result;
            }

            return Err(format!(
                "未找到基岩版版本 {clean_vid} 的核心执行文件。请前往“下载”页面下载对应版本核心。"
            ));
        }

        // 3. No specific version requested (version_id is None / empty)
        // Installed BDS/UWP/GDK cores are launched first; a BDS core is only
        // deployed on a machine that has no playable core yet.
        if offline_account {
            return launch_offline_bedrock_core(app, game_root, "");
        }

        // If a real Store client is installed, prioritize launching it
        if is_uwp_installed() {
            return ensure_and_launch_uwp(app, offline_account);
        }

        // A core this launcher deployed is not a Store install, so it is not
        // covered by the check above. Boot it the way the version-specific path
        // does: an unpacked AppX core needs its package identity, not a bare exe.
        if let Some(result) = launch_installed_client_core(app, game_root, "") {
            return result;
        }

        // Otherwise, launch the first/latest available standalone version
        if let Ok(entries) = std::fs::read_dir(&bedrock_versions_dir) {
            let mut candidates = Vec::new();
            let mut gdk_package: Option<String> = None;
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let dir = entry.path();
                    let insp = inspect_bedrock_version_dir(&dir);
                    if let Some(exe) = insp.main_executable {
                        let work_dir = exe.parent().unwrap_or(&dir).to_path_buf();
                        candidates.push((exe, work_dir, insp.is_server, insp.folder_name));
                    } else if gdk_package.is_none() {
                        if let Some(pkg) = insp.package_file.as_ref() {
                            let ext = pkg
                                .extension()
                                .and_then(|s| s.to_str())
                                .unwrap_or("")
                                .to_lowercase();
                            if ext == "msixvc" {
                                gdk_package = Some(insp.folder_name.clone());
                            }
                        }
                    }
                }
            }

            // Sort candidates descending so newer versions (e.g. 1.26.52 > 1.26.42) are preferred
            candidates.sort_by(|a, b| b.3.cmp(&a.3));

            if let Some((exe, dir, is_console, name)) = candidates.into_iter().next() {
                spawn_bedrock_exe(&exe, &dir, is_console)?;
                let type_desc = if is_console {
                    "服务端核心，已开启独立控制台窗口"
                } else {
                    "客户端"
                };
                return Ok(format!("已启动本地基岩版{type_desc} ({name})"));
            }

            // Only encrypted Xbox GDK packages on disk: run the automation instead of failing
            if let Some(vid) = gdk_package {
                return auto_handle_msixvc_package(app, game_root, &vid);
            }
        }

        // A package registered outside our folder (for example a development
        // sideload) can still be activated directly.
        if let Some(result) = launch_registered_client() {
            return result;
        }

        // Nothing installed yet: run the first-launch dependency bootstrap instead of failing
        Ok(bootstrap_uwp_client(app))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = sync_portable_content_to_clients(game_root);
        let bedrock_versions_dir = game_root.join("bedrock").join("versions");

        // 1. If explicit version requested
        if let Some(vid) = version_id.filter(|s| !s.trim().is_empty()) {
            let clean_vid = vid
                .trim_start_matches("bedrock:")
                .trim_start_matches("Minecraft 基岩版:")
                .trim_start_matches("Minecraft 基岩版 ")
                .trim_start_matches("基岩版 ")
                .trim();

            if clean_vid.eq_ignore_ascii_case("uwp") || clean_vid.eq_ignore_ascii_case("client") {
                if let Some(msg) = launch_unix_client() {
                    return Ok(msg);
                }
            } else {
                let target_dir = resolve_bedrock_version_dir(game_root, clean_vid);
                if target_dir.is_dir() {
                    let insp = inspect_bedrock_version_dir(&target_dir);
                    if let Some(exe) = insp.main_executable {
                        let work_dir = exe.parent().unwrap_or(&target_dir);
                        spawn_bedrock_exe(&exe, work_dir, insp.is_server)?;
                        let type_desc = if insp.is_server { "服务端核心" } else { "客户端" };
                        return Ok(format!("已启动基岩版{type_desc} ({clean_vid})"));
                    }
                }
            }
        }

        // 2. Launch any installed standalone core in <game_root>/bedrock/versions
        if let Ok(entries) = std::fs::read_dir(&bedrock_versions_dir) {
            let mut candidates = Vec::new();
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let dir = entry.path();
                    let insp = inspect_bedrock_version_dir(&dir);
                    if let Some(exe) = insp.main_executable {
                        let work_dir = exe.parent().unwrap_or(&dir).to_path_buf();
                        candidates.push((exe, work_dir, insp.is_server, insp.folder_name));
                    }
                }
            }
            candidates.sort_by(|a, b| b.3.cmp(&a.3));
            if let Some((exe, dir, is_server, name)) = candidates.into_iter().next() {
                spawn_bedrock_exe(&exe, &dir, is_server)?;
                let type_desc = if is_server { "服务端核心" } else { "客户端" };
                return Ok(format!("已启动本地基岩版{type_desc} ({name})"));
            }
        }

        // 3. Fall back to launching system MCPELauncher client if available
        if let Some(msg) = launch_unix_client() {
            return Ok(msg);
        }

        Err("未检测到适用于当前系统 (macOS/Linux) 的基岩版运行环境。\n您可在“下载”页面下载基岩版核心/BDS服务端，或安装 MCPELauncher (Minecraft Bedrock for Linux / macOS)。".to_string())
    }
}

// ---------------------------------------------------------------------------
// Bedrock Core Download & Extraction
// ---------------------------------------------------------------------------

async fn resolve_bedrock_candidate_urls(version_id: &str, download_url: &str) -> Vec<String> {
    let mut candidate_urls = Vec::new();

    let xbox_hosts = [
        "assets1.xboxlive.cn",
        "assets2.xboxlive.cn",
        "d1.xboxlive.cn",
        "d2.xboxlive.cn",
        "assets1.xboxlive.com",
        "assets2.xboxlive.com",
        "xvcf1.xboxlive.com",
        "xvcf2.xboxlive.com",
        "d1.xboxlive.com",
        "d2.xboxlive.com",
    ];

    let add_xbox_mirrors = |urls: &mut Vec<String>, target_url: &str| {
        if let Ok(parsed) = reqwest::Url::parse(target_url) {
            let path_and_query = match parsed.query() {
                Some(q) => format!("{}?{}", parsed.path(), q),
                None => parsed.path().to_string(),
            };
            if target_url.contains("xboxlive") {
                for host in xbox_hosts {
                    urls.push(format!("http://{host}{path_and_query}"));
                }
            }
        }
        urls.push(target_url.to_string());
    };

    // 1. If download_url starts with http / https
    if download_url.starts_with("http://") || download_url.starts_with("https://") {
        add_xbox_mirrors(&mut candidate_urls, download_url);
    }

    // 2. Check curated verified catalog for direct package URLs
    for item in get_curated_fallback_versions() {
        if item.id == version_id || item.version == version_id {
            if item.download_url.starts_with("http://") || item.download_url.starts_with("https://")
            {
                add_xbox_mirrors(&mut candidate_urls, &item.download_url);
            }
            break;
        }
    }

    // 3. Check cached versions to see if this version has a direct URL or UpdateID
    if let Some(cached) = load_cached_versions() {
        if let Some(item) = cached
            .iter()
            .find(|v| v.id == version_id || v.version == version_id)
        {
            let u = item.download_url.trim();
            if u.starts_with("http://") || u.starts_with("https://") {
                add_xbox_mirrors(&mut candidate_urls, u);
            } else if u.len() >= 32 && u.contains('-') {
                if let Some(soap_u) = resolve_fe3_soap_update_url(u).await {
                    add_xbox_mirrors(&mut candidate_urls, &soap_u);
                }
            }
        }
    }

    // 4. If download_url looks like an UpdateID GUID (e.g. 985d1ee4-0e9d-49de-9a99-e208adc08d0c)
    let is_guid =
        download_url.len() >= 32 && download_url.contains('-') && !download_url.starts_with("http");
    if is_guid {
        if let Some(soap_url) = resolve_fe3_soap_update_url(download_url.trim()).await {
            add_xbox_mirrors(&mut candidate_urls, &soap_url);
        }
    }

    // 5. Endstone metadata fallback (BDS versions only; see the guard below)
    let meta_endpoints = [
        format!("https://cdn.jsdelivr.net/gh/EndstoneMC/bedrock-server-data@master/release/{version_id}/metadata.json"),
        format!("https://cdn.jsdelivr.net/gh/EndstoneMC/bedrock-server-data@master/preview/{version_id}/metadata.json"),
        format!("https://fastly.jsdelivr.net/gh/EndstoneMC/bedrock-server-data@master/release/{version_id}/metadata.json"),
        format!("https://fastly.jsdelivr.net/gh/EndstoneMC/bedrock-server-data@master/preview/{version_id}/metadata.json"),
        format!("https://raw.gitmirror.com/EndstoneMC/bedrock-server-data/master/release/{version_id}/metadata.json"),
        format!("https://raw.gitmirror.com/EndstoneMC/bedrock-server-data/master/preview/{version_id}/metadata.json"),
        format!("https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/master/release/{version_id}/metadata.json"),
        format!("https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/master/preview/{version_id}/metadata.json"),
    ];

    // 5. Endstone metadata only resolves BDS (server) packages. Never append one
    //    to a client download: if every client mirror failed, the install used to
    //    fall through to a ~500 MB server zip and unpack it into the version
    //    folder, which is a second, unusable "game file".
    let has_client_package = candidate_urls.iter().any(|url| {
        let lower = url.to_lowercase();
        lower.contains(".msixvc") || lower.contains(".appx") || lower.contains(".msix")
    });

    let client = net::client();
    if !has_client_package {
        for meta_url in meta_endpoints {
            if let Ok(resp) = client
                .get(&meta_url)
                .timeout(std::time::Duration::from_secs(3))
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(win_url) =
                            json.pointer("/binary/windows/url").and_then(|u| u.as_str())
                        {
                            let azure_variant = win_url.replace(
                                "https://www.minecraft.net/bedrockdedicatedserver",
                                "https://minecraft.azureedge.net",
                            );
                            candidate_urls.push(azure_variant);
                            candidate_urls.push(win_url.to_string());
                            break;
                        }
                    }
                }
            }
        }
    }

    // Deduplicate preserving insertion order
    let mut seen = std::collections::HashSet::new();
    candidate_urls.retain(|u| seen.insert(u.clone()));
    candidate_urls
}

pub async fn install_bedrock_version(
    app: &crate::bridge::AppHandle,
    game_root: &Path,
    version_id: &str,
    download_url: &str,
    api_source: Option<&str>,
    threads: usize,
) -> Result<String, String> {
    let threads = threads.clamp(1, 32);
    let root = net::absolute_path(game_root);
    let cache_dir = root.join("bedrock").join("cache");
    let dest_dir = root.join("bedrock").join("versions").join(version_id);

    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("创建缓存目录失败: {e}"))?;
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(|e| format!("创建版本目录失败: {e}"))?;

    let version_tag = format!("bedrock:{version_id}");
    let candidate_urls = resolve_bedrock_candidate_urls(version_id, download_url).await;

    // Detect file type by candidate URLs
    let pkg_filename = if candidate_urls.iter().any(|u| u.contains(".msixvc")) {
        format!("{version_id}.msixvc")
    } else if candidate_urls
        .iter()
        .any(|u| u.contains(".appx") || u.contains(".msix"))
    {
        format!("{version_id}.appx")
    } else {
        format!("{version_id}.insPack")
    };
    let pkg_path = cache_dir.join(&pkg_filename);

    let make_stages = |prep_st: &str,
                       core_st: &str,
                       ext_st: &str,
                       done_bytes: u64,
                       total_bytes: u64,
                       done_files: u64,
                       total_files: u64| {
        vec![
            crate::minecraft::StageProgress {
                stage: "prepare".to_string(),
                label: "解析版本元数据与多节点分片".to_string(),
                status: prep_st.to_string(),
                done_files: if prep_st == "done" { 1 } else { 0 },
                total_files: 1,
                done_bytes: 0,
                total_bytes: 0,
            },
            crate::minecraft::StageProgress {
                stage: "core".to_string(),
                label: format!("基岩版核心多线程分片下载 ({threads} 线程)"),
                status: core_st.to_string(),
                done_files: if core_st == "done" { 1 } else { 0 },
                total_files: 1,
                done_bytes,
                total_bytes,
            },
            crate::minecraft::StageProgress {
                stage: "extract".to_string(),
                label: "解压、校验与部署基岩版组件".to_string(),
                status: ext_st.to_string(),
                done_files,
                total_files,
                done_bytes: 0,
                total_bytes: 0,
            },
        ]
    };

    // Emit initial stage: prepare
    let _ = app.emit(
        "install:progress",
        crate::minecraft::InstallProgress {
            version_id: version_tag.clone(),
            stage: "prepare".to_string(),
            done: 0,
            total: 3,
            detail: "正在通过 BedrockBoot 引擎解析多镜像节点与包元数据...".to_string(),
            downloaded_bytes: 0,
            total_bytes: 85_983_232,
            speed_bps: 0,
            threads,
            active_threads: 1,
            skipped_files: 0,
            retried_files: 0,
            active_tasks: vec![crate::minecraft::ActiveDownloadTask {
                worker_id: 1,
                name: pkg_filename.clone(),
                stage: "prepare".to_string(),
                done_bytes: 0,
                total_bytes: 85_983_232,
                segments: 1,
            }],
            stages: make_stages("active", "pending", "pending", 0, 85_983_232, 0, 1),
        },
    );

    if !net::looks_complete(&pkg_path, None) {
        let mut downloaded = false;
        let mut last_error = String::new();

        for url in &candidate_urls {
            let last_emit_instant = Arc::new(std::sync::Mutex::new(Instant::now()));
            let last_emit_bytes = Arc::new(AtomicU64::new(0));
            let app_clone = app.clone();
            let version_tag_clone = version_tag.clone();
            let pkg_filename_clone = pkg_filename.clone();

            let mut on_progress_cb = |done: u64, total: u64, _delta: u64| {
                let now = Instant::now();
                let mut guard = match last_emit_instant.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let elapsed = now.duration_since(*guard);
                if elapsed.as_millis() >= 120 || done >= total {
                    let prev_bytes = last_emit_bytes.swap(done, Ordering::Relaxed);
                    let delta = done.saturating_sub(prev_bytes);
                    let secs = elapsed.as_secs_f64();
                    let speed = if secs > 0.0 {
                        (delta as f64 / secs) as u64
                    } else {
                        0
                    };
                    *guard = now;

                    let pct = if total > 0 { done * 100 / total } else { 0 };
                    let worker_count = threads.min(16);
                    let active_tasks: Vec<_> = (0..worker_count)
                        .map(|w| crate::minecraft::ActiveDownloadTask {
                            worker_id: w + 1,
                            name: format!("{pkg_filename_clone} (分片 #{})", w + 1),
                            stage: "core".to_string(),
                            done_bytes: done / (worker_count as u64),
                            total_bytes: total / (worker_count as u64),
                            segments: worker_count as u32,
                        })
                        .collect();

                    let _ = app_clone.emit(
                        "install:progress",
                        crate::minecraft::InstallProgress {
                            version_id: version_tag_clone.clone(),
                            stage: "core".to_string(),
                            done: 1,
                            total: 3,
                            detail: format!(
                                "BedrockBoot 多线程加速下载中 ({} MB / {} MB - {}%)",
                                done / 1_048_576,
                                total / 1_048_576,
                                pct
                            ),
                            downloaded_bytes: done,
                            total_bytes: total,
                            speed_bps: speed,
                            threads,
                            active_threads: worker_count,
                            skipped_files: 0,
                            retried_files: 0,
                            active_tasks,
                            stages: make_stages("done", "active", "pending", done, total, 0, 1),
                        },
                    );
                }
            };

            match net::download_file_multithreaded(
                url,
                &pkg_path,
                None,
                None,
                threads,
                None,
                Some(&mut on_progress_cb),
            )
            .await
            {
                Ok(_) => {
                    downloaded = true;
                    break;
                }
                Err(e) => {
                    last_error = e;
                    let _ = tokio::fs::remove_file(&pkg_path).await;
                }
            }
        }

        if !downloaded {
            return Err(format!(
                "通过 BedrockBoot 引擎下载基岩版核心失败: {last_error}"
            ));
        }
    }

    // MD5 verification if available
    let expected_md5 = load_cached_versions()
        .and_then(|list| {
            list.into_iter()
                .find(|v| v.id == version_id || v.version == version_id)
        })
        .and_then(|v| v.md5);

    if let Some(expected) = &expected_md5 {
        if !expected.is_empty() {
            if let Ok(mut f) = File::open(&pkg_path) {
                use md5::{Digest, Md5};
                let mut hasher = Md5::new();
                let mut buf = [0u8; 65536];
                while let Ok(n) = f.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    hasher.update(&buf[..n]);
                }
                let actual = format!("{:x}", hasher.finalize());
                if actual.eq_ignore_ascii_case(expected) {
                    eprintln!("[BedrockBoot] MD5 完整性校验成功: {actual}");
                } else {
                    eprintln!("[BedrockBoot] MD5 校验不匹配: 期望 {expected}, 实际 {actual}");
                }
            }
        }
    }

    // Check if the file is a ZIP archive / AppX container (header: PK\x03\x04)
    let mut magic = [0u8; 4];
    let is_zip = if let Ok(mut f) = File::open(&pkg_path) {
        f.read_exact(&mut magic).is_ok() && magic == [0x50, 0x4b, 0x03, 0x04]
    } else {
        false
    };

    if is_zip {
        let file = File::open(&pkg_path).map_err(|e| format!("无法打开游戏压缩包: {e}"))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("解析 ZIP 压缩包失败: {e}"))?;
        let total_entries = archive.len();

        let _ = app.emit(
            "install:progress",
            crate::minecraft::InstallProgress {
                version_id: version_tag.clone(),
                stage: "extract".to_string(),
                done: 2,
                total: 3,
                detail: format!("正在解压并部署基岩版组件 (共 {total_entries} 项)..."),
                downloaded_bytes: 85_983_232,
                total_bytes: 85_983_232,
                speed_bps: 0,
                threads,
                active_threads: 1,
                skipped_files: 0,
                retried_files: 0,
                active_tasks: vec![],
                stages: make_stages(
                    "done",
                    "done",
                    "active",
                    85_983_232,
                    85_983_232,
                    0,
                    total_entries as u64,
                ),
            },
        );

        for i in 0..total_entries {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("读取文件失败: {e}"))?;
            let outpath = match entry.enclosed_name() {
                Some(path) => dest_dir.join(path),
                None => continue,
            };

            if entry.is_dir() {
                std::fs::create_dir_all(&outpath).ok();
            } else {
                if let Some(p) = outpath.parent() {
                    std::fs::create_dir_all(p).ok();
                }
                let mut outfile =
                    File::create(&outpath).map_err(|e| format!("创建目标文件失败: {e}"))?;
                std::io::copy(&mut entry, &mut outfile)
                    .map_err(|e| format!("解压写入失败: {e}"))?;
            }

            if i % 25 == 0 || i + 1 == total_entries {
                let _ = app.emit(
                    "install:progress",
                    crate::minecraft::InstallProgress {
                        version_id: version_tag.clone(),
                        stage: "extract".to_string(),
                        done: 2,
                        total: 3,
                        detail: format!("正在部署基岩版组件 ({}/{})", i + 1, total_entries),
                        downloaded_bytes: 85_983_232,
                        total_bytes: 85_983_232,
                        speed_bps: 0,
                        threads,
                        active_threads: 1,
                        skipped_files: 0,
                        retried_files: 0,
                        active_tasks: vec![],
                        stages: make_stages(
                            "done",
                            "done",
                            "active",
                            85_983_232,
                            85_983_232,
                            (i + 1) as u64,
                            total_entries as u64,
                        ),
                    },
                );
            }
        }

        // Release file lock
        drop(archive);

        // If an inner .appx is unpacked inside dest_dir (typical in .appxbundle packages),
        // unpack the x64 .appx directly into dest_dir so executables & manifests are available.
        if let Ok(entries) = std::fs::read_dir(&dest_dir) {
            let mut inner_appx = None;
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() {
                    let ext = p
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase();
                    if ext == "appx" {
                        let name = p
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_string();
                        if name.contains("x64") || inner_appx.is_none() {
                            inner_appx = Some(p);
                        }
                    }
                }
            }
            if let Some(appx_path) = inner_appx {
                if let Ok(file) = File::open(&appx_path) {
                    if let Ok(mut inner_archive) = zip::ZipArchive::new(file) {
                        for j in 0..inner_archive.len() {
                            if let Ok(mut entry) = inner_archive.by_index(j) {
                                if let Some(path) = entry.enclosed_name() {
                                    let outpath = dest_dir.join(path);
                                    if entry.is_dir() {
                                        let _ = std::fs::create_dir_all(&outpath);
                                    } else {
                                        if let Some(p) = outpath.parent() {
                                            let _ = std::fs::create_dir_all(p);
                                        }
                                        if let Ok(mut outfile) = File::create(&outpath) {
                                            let _ = std::io::copy(&mut entry, &mut outfile);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Delete AppxSignature.p7x if present (BedrockBoot standard step to allow development mode registration)
        let sig_p7x = dest_dir.join("AppxSignature.p7x");
        if sig_p7x.exists() {
            let _ = force_remove_file(&sig_p7x);
        }

        // Installation only unpacks the core. The package is deployed to Windows
        // locally on first launch (`register_loose_appx`), so a download never
        // depends on the Microsoft Store and switching versions stays cheap.
    } else {
        // Raw msixvc / insPack file: copy to dest_dir
        let target_dest = dest_dir.join(&pkg_filename);
        let _ = std::fs::copy(&pkg_path, &target_dest);
    }

    // Clean up temporary download cache
    let _ = tokio::fs::remove_file(&pkg_path).await;
    let pkg_part = cache_dir.join(format!("{pkg_filename}.part"));
    let _ = tokio::fs::remove_file(&pkg_part).await;

    let src_label = api_source.unwrap_or("BedrockBoot 引擎");
    let version_info = serde_json::json!({
        "id": version_id,
        "name": format!("Minecraft 基岩版 {version_id}"),
        "source": src_label,
        "packageFile": pkg_filename,
        "downloadUrl": download_url,
        "installedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    });
    let _ = tokio::fs::write(dest_dir.join("version.json"), version_info.to_string()).await;

    // Emit final done stage
    let _ = app.emit(
        "install:progress",
        crate::minecraft::InstallProgress {
            version_id: version_tag.clone(),
            stage: "done".to_string(),
            done: 3,
            total: 3,
            detail: format!("基岩版 {version_id} 核心已就绪，可以开始游戏"),
            downloaded_bytes: 85_983_232,
            total_bytes: 85_983_232,
            speed_bps: 0,
            threads,
            active_threads: 0,
            skipped_files: 0,
            retried_files: 0,
            active_tasks: vec![],
            stages: make_stages("done", "done", "done", 85_983_232, 85_983_232, 1, 1),
        },
    );

    Ok(format!(
        "基岩版 {version_id} 核心已通过 {src_label} 下载并就绪"
    ))
}

pub fn force_remove_file(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    if let Ok(metadata) = path.symlink_metadata() {
        let mut perms = metadata.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(path, perms);
        }
    }
    std::fs::remove_file(path)
}

pub fn force_remove_dir_all(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    if dir.is_dir() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if let Ok(metadata) = path.symlink_metadata() {
                let mut perms = metadata.permissions();
                if perms.readonly() {
                    perms.set_readonly(false);
                    let _ = std::fs::set_permissions(&path, perms);
                }
            }
            if path.is_dir() {
                force_remove_dir_all(&path)?;
            } else {
                let _ = std::fs::remove_file(&path);
            }
        }
        let _ = std::fs::remove_dir(dir);
    } else {
        force_remove_file(dir)?;
    }
    Ok(())
}

/// Clears the read-only flag on a tree so Windows lets `remove_dir_all` in.
fn clear_readonly_recursive(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Ok(metadata) = path.symlink_metadata() {
            let mut perms = metadata.permissions();
            if perms.readonly() {
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(&path, perms);
            }
        }
        if path.is_dir() {
            clear_readonly_recursive(&path);
        }
    }
}

/// Counts what a failed delete left behind, with one example path.
fn describe_leftovers(dir: &Path) -> (usize, Option<PathBuf>) {
    fn walk(dir: &Path, count: &mut usize, sample: &mut Option<PathBuf>, depth: usize) {
        if depth > 6 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            *count += 1;
            if sample.is_none() && path.is_file() {
                *sample = Some(path.clone());
            }
            if path.is_dir() {
                walk(&path, count, sample, depth + 1);
            }
        }
    }

    let mut count = 0;
    let mut sample = None;
    walk(dir, &mut count, &mut sample, 0);
    (count, sample)
}

/// Deletes a directory tree, or explains exactly why it could not.
///
/// The previous implementation ignored every per-file error, so a locked file —
/// the normal case while the game is still running — produced a silent success:
/// the launcher reported "deleted", the folder survived and could never be
/// removed from the UI again.
fn remove_dir_all_checked(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    clear_readonly_recursive(dir);
    let first_error = match std::fs::remove_dir_all(dir) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };

    // A handle released a moment ago (game just closed, antivirus scan done)
    // usually clears on the second attempt.
    std::thread::sleep(std::time::Duration::from_millis(400));
    clear_readonly_recursive(dir);
    if std::fs::remove_dir_all(dir).is_ok() {
        return Ok(());
    }

    let (leftover_count, sample) = describe_leftovers(dir);
    let mut message = format!("删除目录失败: {first_error}");
    if leftover_count > 0 {
        message.push_str(&format!("；仍有 {leftover_count} 个文件或文件夹未能删除"));
        if let Some(sample) = sample {
            message.push_str(&format!("，例如 {}", sample.display()));
        }
    }
    match active_process_in_dir(dir) {
        Some(process) => message.push_str(&format!(
            "。检测到 {process} 正在运行，请完全退出游戏后再试。"
        )),
        None => message.push_str("。请关闭占用该目录的程序（游戏或文件扫描）后重试。"),
    }
    Err(message)
}

/// Name of a running process whose executable lives inside `dir`, if any.
#[cfg(target_os = "windows")]
fn active_process_in_dir(dir: &Path) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let target = ps_single_quoted(dir);
    let script = format!(
        "$ErrorActionPreference = 'SilentlyContinue'; \
         Get-Process | Where-Object {{ $_.Path -and $_.Path.StartsWith('{target}', [StringComparison]::OrdinalIgnoreCase) }} \
         | Select-Object -First 1 -ExpandProperty Name"
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!name.is_empty() && name.len() < 80).then_some(name)
}

#[cfg(not(target_os = "windows"))]
fn active_process_in_dir(_dir: &Path) -> Option<String> {
    None
}

/// Drops a development-mode package that points at `dir`.
///
/// A locally deployed UWP core is registered in place, so Windows holds an
/// installed-package record for that folder. Leaving the record behind while
/// the folder disappears produces a broken package that blocks the next
/// deployment of the same version.
#[cfg(target_os = "windows")]
fn unregister_local_package_at(dir: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let target = ps_single_quoted(dir);
    let script = format!(
        "$ErrorActionPreference = 'SilentlyContinue'; \
         $p = Get-AppxPackage | Where-Object {{ $_.IsDevelopmentMode -and $_.InstallLocation -and ($_.InstallLocation -ieq '{target}') }} | Select-Object -First 1; \
         if ($p) {{ Remove-AppxPackage -Package $p.PackageFullName | Out-Null }}"
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(target_os = "windows"))]
fn unregister_local_package_at(_dir: &Path) {}

pub async fn delete_bedrock_version(game_root: &Path, version_id: &str) -> Result<(), String> {
    let root = net::absolute_path(game_root);
    let clean_id = version_id
        .trim()
        .trim_start_matches("Minecraft 基岩版 ")
        .trim_start_matches("Minecraft ")
        .trim_start_matches("bedrock:")
        .trim();

    if clean_id.is_empty() {
        return Err("未指定要删除的基岩版版本".to_string());
    }

    // The Store client is an installed application, not a folder this launcher
    // owns; deleting it here would uninstall an app behind the user's back.
    if clean_id.eq_ignore_ascii_case("uwp") || clean_id.eq_ignore_ascii_case("bedrock-uwp") {
        return Err("「正版 UWP」由 Microsoft Store 管理，无法从启动器删除。\
             如需卸载，请在 Windows「设置 → 应用」中操作。"
            .to_string());
    }

    let target = resolve_bedrock_version_dir(&root, version_id);

    let mut deleted = false;
    if target.is_dir() {
        // Locally deployed cores are registered in place; unregister first so
        // Windows releases the folder and no package points at a missing path.
        unregister_local_package_at(&target);

        if let Some(process) = active_process_in_dir(&target) {
            return Err(format!(
                "{process} 正在使用该基岩版核心，请完全退出游戏后再删除。"
            ));
        }

        remove_dir_all_checked(&target)?;

        if target.exists() {
            return Err(format!("删除未完成，{} 仍然存在。", target.display()));
        }
        deleted = true;
    }

    // Clean up residual zip, insPack, appx, msixvc and part files from cache
    let cache_dir = root.join("bedrock").join("cache");
    let candidate_cache_files = [
        cache_dir.join(format!("bedrock-server-{clean_id}.zip")),
        cache_dir.join(format!("bedrock-server-{clean_id}.zip.part")),
        cache_dir.join(format!("bedrock-server-{}.zip", version_id.trim())),
        cache_dir.join(format!("bedrock-server-{}.zip.part", version_id.trim())),
        cache_dir.join(format!("{clean_id}.insPack")),
        cache_dir.join(format!("{clean_id}.insPack.part")),
        cache_dir.join(format!("{clean_id}.appx")),
        cache_dir.join(format!("{clean_id}.appx.part")),
        cache_dir.join(format!("{clean_id}.msixvc")),
        cache_dir.join(format!("{clean_id}.msixvc.part")),
    ];
    for cf in candidate_cache_files {
        if cf.exists() {
            let _ = force_remove_file(&cf);
            deleted = true;
        }
    }

    if deleted {
        Ok(())
    } else {
        Err(format!("未找到基岩版核心目录或残留缓存文件: {version_id}"))
    }
}

pub async fn clean_download_cache(game_root: &Path) -> Result<u64, String> {
    let root = net::absolute_path(game_root);
    let mut total_freed: u64 = 0;

    // 1. Bedrock cache (.zip & .part files)
    let bedrock_cache = root.join("bedrock").join("cache");
    if let Ok(entries) = std::fs::read_dir(&bedrock_cache) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if ext.eq_ignore_ascii_case("zip")
                    || ext.eq_ignore_ascii_case("part")
                    || ext.eq_ignore_ascii_case("inspack")
                    || ext.eq_ignore_ascii_case("appx")
                    || ext.eq_ignore_ascii_case("msixvc")
                {
                    if let Ok(meta) = path.metadata() {
                        total_freed += meta.len();
                    }
                    let _ = force_remove_file(&path);
                }
            }
        }
    }

    // 2. Meta installers (.jar & .part files)
    let installers_cache = root.join("meta").join("installers");
    if let Ok(entries) = std::fs::read_dir(&installers_cache) {
        for entry in entries.flatten() {
            let path = entry.path();
            if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
                if ext.eq_ignore_ascii_case("jar") || ext.eq_ignore_ascii_case("part") {
                    if let Ok(meta) = path.metadata() {
                        total_freed += meta.len();
                    }
                    let _ = force_remove_file(&path);
                }
            }
        }
    }

    // 3. Any dangling .part files in versions/
    let versions_dir = root.join("versions");
    if let Ok(entries) = std::fs::read_dir(&versions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Ok(sub) = std::fs::read_dir(&path) {
                    for f in sub.flatten() {
                        let fp = f.path();
                        if fp
                            .extension()
                            .map_or(false, |e| e.eq_ignore_ascii_case("part"))
                        {
                            if let Ok(meta) = fp.metadata() {
                                total_freed += meta.len();
                            }
                            let _ = force_remove_file(&fp);
                        }
                    }
                }
            }
        }
    }

    // 4. Any dangling .part files in bedrock/versions/
    let bedrock_versions = root.join("bedrock").join("versions");
    if let Ok(entries) = std::fs::read_dir(&bedrock_versions) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Ok(sub) = std::fs::read_dir(&path) {
                    for f in sub.flatten() {
                        let fp = f.path();
                        if fp
                            .extension()
                            .map_or(false, |e| e.eq_ignore_ascii_case("part"))
                        {
                            if let Ok(meta) = fp.metadata() {
                                total_freed += meta.len();
                            }
                            let _ = force_remove_file(&fp);
                        }
                    }
                }
            }
        }
    }

    Ok(total_freed)
}

// ---------------------------------------------------------------------------
// Bedrock Addon / Shaderpack / Mcpack Installation
// ---------------------------------------------------------------------------
//
// A Bedrock add-on is a ZIP archive (`.mcpack`, `.mcaddon`, sometimes plain
// `.zip`/`.mcworld`) whose real structure is described by the `manifest.json`
// files inside it — one per pack. A `.mcaddon` usually bundles a behavior pack
// and a resource pack, and may bundle further `.mcpack` files. Copying such an
// archive into a single folder (what this used to do) produces packs the game
// never loads, so installation now follows BedrockBoot-DM:
//
// 1. read every `manifest.json`, classify each pack by its module types
//    (`resources` → resource pack, `data`/`script` → behavior pack);
// 2. extract every pack into `<game data>/resource_packs` or
//    `.../behavior_packs` under a folder named from the pack, suffixed with the
//    pack UUID so two packs with the same title never overwrite each other;
// 3. recurse into nested `.mcpack` archives;
// 4. install worlds (`.mcworld`, detected by `level.dat`) into
//    `minecraftWorlds` instead of treating them as packs;
// 5. write the result into every Bedrock data directory that exists (the
//    launcher's portable folder, the GDK `Minecraft Bedrock` folder and the UWP
//    package folder), so the packs show up for whichever core is launched.

#[derive(Deserialize)]
struct PackManifest {
    #[serde(default)]
    header: Option<PackHeader>,
    #[serde(default)]
    modules: Option<Vec<PackModule>>,
}

#[derive(Deserialize)]
struct PackHeader {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    uuid: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    min_engine_version: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct PackModule {
    #[serde(rename = "type")]
    module_type: Option<String>,
}

/// One pack found inside an archive.
struct PackSpec {
    /// Archive directory holding this pack's `manifest.json` (empty for root).
    prefix: String,
    /// Folder name used under `resource_packs` / `behavior_packs`.
    folder: String,
    /// Header name, for user-facing messages.
    name: String,
    /// `resource_packs` / `behavior_packs`, one string per module kind found.
    target_kinds: Vec<&'static str>,
    /// `min_engine_version` from the manifest, when it declares one.
    min_engine: Option<(u32, u32, u32)>,
}

#[derive(Default)]
struct InstalledPacks {
    pack_names: Vec<String>,
    pack_kinds: Vec<&'static str>,
    world_names: Vec<String>,
    dest_dirs: Vec<PathBuf>,
    target_roots: Vec<PathBuf>,
    /// Highest `min_engine_version` among the installed packs.
    min_engine: Option<(u32, u32, u32)>,
}

impl InstalledPacks {
    fn note_name(&mut self, name: &str) {
        let name = name.trim();
        if !name.is_empty() && !self.pack_names.iter().any(|n| n == name) {
            self.pack_names.push(name.to_string());
        }
    }

    fn note_kind(&mut self, kind: &'static str) {
        if !self.pack_kinds.iter().any(|k| *k == kind) {
            self.pack_kinds.push(kind);
        }
    }

    fn note_dir(&mut self, dir: PathBuf) {
        if !self.dest_dirs.iter().any(|d| d == &dir) {
            self.dest_dirs.push(dir);
        }
    }

    fn note_target(&mut self, dir: PathBuf) {
        if !self.target_roots.iter().any(|d| d == &dir) {
            self.target_roots.push(dir);
        }
    }

    fn note_engine(&mut self, engine: Option<(u32, u32, u32)>) {
        let Some(engine) = engine else {
            return;
        };
        if self.min_engine.map_or(true, |current| engine > current) {
            self.min_engine = Some(engine);
        }
    }

    fn is_empty(&self) -> bool {
        self.pack_names.is_empty() && self.world_names.is_empty()
    }
}

/// Folder name for a pack: readable name plus the first characters of its UUID.
/// Minecraft formatting codes (`§d`, `§l`, …) are colour markers, not text.
/// Pack authors use them in manifest names, so strip them before showing a name
/// or building a folder name from it.
fn strip_minecraft_formatting(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '§' {
            let _ = chars.next();
        } else {
            out.push(ch);
        }
    }
    out
}

fn pack_folder_name(name: &str, uuid: &str, fallback: &str) -> String {
    let base = {
        let sanitized = sanitize_pack_folder(&strip_minecraft_formatting(name));
        if sanitized.is_empty() {
            sanitize_pack_folder(fallback)
        } else {
            sanitized
        }
    };
    let uuid_tail: String = uuid
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .to_lowercase();
    if uuid_tail.len() >= 4 {
        format!("{base}_{uuid_tail}")
    } else {
        base
    }
}

fn sanitize_pack_folder(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if out.chars().count() >= 48 {
            break;
        }
        if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else if ch == ' ' || ch == '.' {
            out.push('_');
        }
    }
    out.trim_matches('_').to_string()
}

/// Every Bedrock data directory this machine actually has.
///
/// The portable folder always exists (it is created on demand); the Store/GDK
/// The launcher's portable data folder (staging area for imports).
fn portable_mojang_dir(game_root: &Path) -> PathBuf {
    game_root.join("bedrock").join("games").join("com.mojang")
}

/// `com.mojang` folders of every Bedrock client installed on this machine.
///
/// The *client* is what decides where packs must go, so the folder is derived
/// from the installed package (UWP) or data root (GDK) rather than only from
/// directories that already contain a `com.mojang`. `create` materialises the
/// folder for a client that has never been launched: without that, packs
/// imported before the first launch landed only in the portable staging folder
/// and the game — which reads its own `LocalState` / `Users` folder — never saw
/// them. Nothing is created for a client that is not installed.
/// `Identity Name` of every unpacked AppX core stored under
/// `<game_root>/bedrock/versions`.
///
/// The identity decides which package family the core runs as, and therefore
/// which `Packages\<PFN>\LocalState` folder holds its `com.mojang`. Knowing it
/// lets an import reach the game *before* the core has ever been registered or
/// started — the window in which Windows has not created the folder yet.
#[cfg(target_os = "windows")]
fn local_core_identity_names(game_root: &Path) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(game_root.join("bedrock").join("versions")) else {
        return names;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Some(manifest) = inspect_bedrock_version_dir(&entry.path()).manifest_path else {
            continue;
        };
        if let Some(name) = appx_identity_attr(&manifest, "Name") {
            if !names.iter().any(|known| known.eq_ignore_ascii_case(&name)) {
                names.push(name);
            }
        }
    }
    names
}

#[cfg(target_os = "windows")]
fn client_mojang_dirs(game_root: &Path, create: bool) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    // A deployed core makes its package data folder the install target even on a
    // machine where the game has never run: Windows creates `Packages\<PFN>` on
    // registration, so an import that only reached the staging folder before that
    // was never seen by the game (empty resource-pack list on first launch).
    let local_identities = local_core_identity_names(game_root);

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        for package in [
            "Microsoft.MinecraftUWP_8wekyb3d8bbwe",
            "Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe",
        ] {
            let base = PathBuf::from(&local).join("Packages").join(package);
            let package_name = package.split('_').next().unwrap_or(package);
            let deployed_here = local_identities
                .iter()
                .any(|name| name.eq_ignore_ascii_case(package_name));
            if !base.is_dir() && !(create && deployed_here) {
                continue;
            }
            let candidate = base.join("LocalState").join("games").join("com.mojang");
            if create {
                if std::fs::create_dir_all(&candidate).is_ok() {
                    dirs.push(candidate);
                }
            } else if candidate.is_dir() {
                dirs.push(candidate);
            }
        }
    }

    if let Ok(appdata) = std::env::var("APPDATA") {
        for base_name in ["Minecraft Bedrock", "Minecraft Bedrock Preview"] {
            let base = PathBuf::from(&appdata).join(base_name);
            if !base.is_dir() {
                continue;
            }
            let users = base.join("Users");
            let mut user_dirs = 0usize;
            if let Ok(entries) = std::fs::read_dir(&users) {
                for entry in entries.flatten() {
                    if !entry.path().is_dir() {
                        continue;
                    }
                    let candidate = entry.path().join("games").join("com.mojang");
                    if create {
                        if std::fs::create_dir_all(&candidate).is_ok() {
                            dirs.push(candidate);
                            user_dirs += 1;
                        }
                    } else if candidate.is_dir() {
                        dirs.push(candidate);
                        user_dirs += 1;
                    }
                }
            }
            // GDK keeps shared pack data under `Users\Shared` even for
            // per-user installs (Microsoft's documented location), so make
            // sure it exists for pack installs.
            if create || user_dirs == 0 {
                let shared = users.join("Shared").join("games").join("com.mojang");
                if create {
                    if std::fs::create_dir_all(&shared).is_ok() {
                        dirs.push(shared);
                    }
                } else if shared.is_dir() {
                    dirs.push(shared);
                }
            }
        }
    }

    dirs
}

#[cfg(not(target_os = "windows"))]
fn launch_unix_client() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        for app_path in ["/Applications/MCPELauncher.app", "~/Applications/MCPELauncher.app"] {
            let p = if app_path.starts_with("~/") {
                if let Ok(h) = std::env::var("HOME") {
                    PathBuf::from(h).join(&app_path[2..])
                } else {
                    PathBuf::from(app_path)
                }
            } else {
                PathBuf::from(app_path)
            };
            if p.is_dir() {
                if Command::new("open").arg("-a").arg(&p).spawn().is_ok() {
                    return Some("已通过 macOS 启动 MCPELauncher 基岩版客户端".to_string());
                }
            }
        }
    }

    for bin in ["mcpelauncher-client", "mcpelauncher-ui", "/usr/bin/mcpelauncher-client", "/usr/local/bin/mcpelauncher-client", "/opt/homebrew/bin/mcpelauncher-client"] {
        if Command::new(bin).spawn().is_ok() {
            return Some("已启动 MCPELauncher 基岩版客户端".to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        if Command::new("flatpak").args(["run", "io.mrarm.mcpelauncher"]).spawn().is_ok() {
            return Some("已通过 Flatpak 启动 MCPELauncher 基岩版客户端".to_string());
        }
    }

    None
}

#[cfg(not(target_os = "windows"))]
fn client_mojang_dirs(game_root: &Path, create: bool) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        let home_path = PathBuf::from(home);
        let candidates = [
            home_path.join(".local").join("share").join("mcpelauncher").join("games").join("com.mojang"),
            home_path.join(".var").join("app").join("io.mrarm.mcpelauncher").join("data").join("mcpelauncher").join("games").join("com.mojang"),
            home_path.join("Library").join("Application Support").join("mcpelauncher").join("games").join("com.mojang"),
            home_path.join("Library").join("Application Support").join("MinecraftBedrock").join("games").join("com.mojang"),
        ];
        for candidate in candidates {
            if candidate.is_dir() {
                dirs.push(candidate);
            }
        }
        if create && dirs.is_empty() {
            #[cfg(target_os = "macos")]
            let target = home_path.join("Library").join("Application Support").join("mcpelauncher").join("games").join("com.mojang");
            #[cfg(not(target_os = "macos"))]
            let target = home_path.join(".local").join("share").join("mcpelauncher").join("games").join("com.mojang");

            if std::fs::create_dir_all(&target).is_ok() {
                dirs.push(target);
            }
        }
    }
    let local_bedrock = game_root.join("bedrock").join("data").join("com.mojang");
    if local_bedrock.is_dir() {
        dirs.push(local_bedrock);
    }
    dirs
}

fn dedupe_dirs(mut dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    dirs.sort();
    dirs.dedup();
    // Windows paths are case-insensitive; `sort`/`dedup` alone would keep
    // `Users` and `users` copies of the same folder.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.to_string_lossy().to_lowercase()));
    dirs
}

/// Data folders that currently exist, for listing and status reads.
fn bedrock_game_data_dirs(game_root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let portable = portable_mojang_dir(game_root);
    if portable.is_dir() {
        dirs.push(portable);
    }
    dirs.extend(client_mojang_dirs(game_root, false));
    dedupe_dirs(dirs)
}

/// Targets an install must write to.
///
/// Unlike the read-side list this also creates the `com.mojang` folder of an
/// installed client that has not been launched yet, so imported packs are in
/// place the first time the game starts.
fn bedrock_install_dirs(game_root: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let portable = portable_mojang_dir(game_root);
    if std::fs::create_dir_all(&portable).is_ok() {
        dirs.push(portable);
    }
    dirs.extend(client_mojang_dirs(game_root, true));
    dedupe_dirs(dirs)
}

fn zip_entry_names(path: &Path) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|e| format!("无法读取附加包 {}: {e}", path.display()))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("不是有效的附加包压缩文件: {e}"))?;
    let mut names = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("读取附加包目录失败: {e}"))?;
        names.push(entry.name().replace('\\', "/"));
    }
    Ok(names)
}

fn read_zip_entry(path: &Path, index: usize) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("无法读取附加包: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的压缩文件: {e}"))?;
    let mut entry = archive
        .by_index(index)
        .map_err(|e| format!("读取附加包内容失败: {e}"))?;
    let mut text = String::new();
    entry
        .read_to_string(&mut text)
        .map_err(|e| format!("读取 manifest.json 失败: {e}"))?;
    Ok(text)
}

/// Reject absolute paths and `..` so a crafted archive cannot write outside the
/// pack folder.
fn safe_relative_path(name: &str) -> Option<PathBuf> {
    let mut path = PathBuf::new();
    for component in name.split(['/', '\\']) {
        if component.is_empty() || component == "." {
            continue;
        }
        if component == ".." {
            return None;
        }
        path.push(component);
    }
    if path.as_os_str().is_empty() {
        None
    } else {
        Some(path)
    }
}

fn module_target_kinds(modules: Option<&Vec<PackModule>>) -> Vec<&'static str> {
    let mut kinds: Vec<&'static str> = Vec::new();
    for module in modules.into_iter().flatten() {
        let module_type = module.module_type.as_deref().unwrap_or("").trim();
        let kind = match module_type {
            "resources" => Some("resource_packs"),
            "data" | "script" | "client_data" | "javascript" | "plugin" => Some("behavior_packs"),
            _ => None,
        };
        if let Some(kind) = kind {
            if !kinds.contains(&kind) {
                kinds.push(kind);
            }
        }
    }
    if kinds.is_empty() {
        // A manifest without a recognisable module type is still a pack; the
        // resource folder is where the game looks first.
        kinds.push("resource_packs");
    }
    kinds
}

fn discover_packs(
    file_path: &Path,
    names: &[String],
    file_stem: &str,
) -> Result<Vec<PackSpec>, String> {
    let mut specs: Vec<PackSpec> = Vec::new();

    for (index, name) in names.iter().enumerate() {
        let lower = name.to_lowercase();
        if lower != "manifest.json" && !lower.ends_with("/manifest.json") {
            continue;
        }

        let content = read_zip_entry(file_path, index)?;
        // Manifests in the wild sometimes start with a BOM or a comment line;
        // the game tolerates that, so the installer must too.
        let trimmed = content.trim_start_matches('\u{feff}').trim();
        let json = &trimmed[trimmed.find('{').unwrap_or(0)..];
        let Ok(manifest) = serde_json::from_str::<PackManifest>(json) else {
            continue;
        };
        let Some(header) = manifest.header else {
            continue;
        };

        let prefix = name
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_string())
            .unwrap_or_default();
        if specs.iter().any(|spec| spec.prefix == prefix) {
            continue;
        }

        let fallback = if prefix.is_empty() {
            file_stem.to_string()
        } else {
            prefix.rsplit('/').next().unwrap_or(file_stem).to_string()
        };
        let pack_name = strip_minecraft_formatting(header.name.as_deref().unwrap_or(""))
            .trim()
            .to_string();
        let display = if pack_name.is_empty() {
            fallback.clone()
        } else {
            pack_name.clone()
        };
        let uuid = header.uuid.unwrap_or_default();

        specs.push(PackSpec {
            folder: pack_folder_name(&display, &uuid, &fallback),
            prefix,
            name: display,
            target_kinds: module_target_kinds(manifest.modules.as_ref()),
            min_engine: header
                .min_engine_version
                .as_ref()
                .and_then(parse_version_triple),
        });
    }

    Ok(specs)
}

fn extract_entries(
    archive_path: &Path,
    entries: &[(usize, String)],
    dest: &Path,
) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|e| format!("无法读取附加包: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的压缩文件: {e}"))?;

    for (index, relative) in entries {
        let mut entry = archive
            .by_index(*index)
            .map_err(|e| format!("读取附加包条目失败: {e}"))?;
        let Some(relative_path) = safe_relative_path(relative) else {
            continue;
        };
        let target = dest.join(relative_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
        }
        let mut output =
            File::create(&target).map_err(|e| format!("写入 {} 失败: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|e| format!("写入 {} 失败: {e}", target.display()))?;
    }

    Ok(())
}

fn extract_single_entry(archive_path: &Path, index: usize, dest: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|e| format!("无法读取附加包: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("不是有效的压缩文件: {e}"))?;
    let mut entry = archive
        .by_index(index)
        .map_err(|e| format!("读取内嵌压缩包失败: {e}"))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut output =
        File::create(dest).map_err(|e| format!("写入 {} 失败: {e}", dest.display()))?;
    std::io::copy(&mut entry, &mut output)
        .map_err(|e| format!("写入 {} 失败: {e}", dest.display()))?;
    Ok(())
}

fn relative_entries_under(
    names: &[String],
    prefix: &str,
    skip_mcpack: bool,
) -> Vec<(usize, String)> {
    let prefix_with_slash = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    let mut entries = Vec::new();
    for (index, name) in names.iter().enumerate() {
        if name.ends_with('/') || !name.starts_with(&prefix_with_slash) {
            continue;
        }
        let relative = &name[prefix_with_slash.len()..];
        if relative.is_empty() {
            continue;
        }
        if skip_mcpack && relative.to_lowercase().ends_with(".mcpack") {
            // Installed on its own pass so it lands in the right pack folder.
            continue;
        }
        entries.push((index, relative.to_string()));
    }
    entries
}

fn install_world_archive(
    archive_path: &Path,
    names: &[String],
    level_entry: &str,
    file_stem: &str,
    targets: &[PathBuf],
    outcome: &mut InstalledPacks,
) -> Result<(), String> {
    let prefix = level_entry
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default();
    let entries = relative_entries_under(names, &prefix, false);
    if entries.is_empty() {
        return Err("世界压缩包是空的".to_string());
    }

    let stem = sanitize_pack_folder(&strip_minecraft_formatting(file_stem));
    let stem = if stem.is_empty() {
        "ImportedWorld".to_string()
    } else {
        stem
    };

    for target in targets {
        let worlds_dir = target.join("minecraftWorlds");
        let mut dest = worlds_dir.join(&stem);
        let mut suffix = 2;
        while dest.exists() && !dest.join("level.dat").is_file() && suffix < 100 {
            dest = worlds_dir.join(format!("{stem}_{suffix}"));
            suffix += 1;
        }
        extract_entries(archive_path, &entries, &dest)
            .map_err(|e| format!("导入世界 {} 失败: {e}", dest.display()))?;
        outcome.note_dir(dest);
        outcome.note_target(target.clone());
    }

    outcome.world_names.push(stem);
    Ok(())
}

fn install_archive(
    archive_path: &Path,
    targets: &[PathBuf],
    depth: u8,
    outcome: &mut InstalledPacks,
) -> Result<(), String> {
    if depth > 3 {
        return Err("附加包嵌套层级过深（超过 3 层），请解压后手动放入 com.mojang".to_string());
    }
    if targets.is_empty() {
        return Err("没有可用的基岩版数据目录".to_string());
    }

    let names = zip_entry_names(archive_path)?;
    let file_stem = archive_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "pack".to_string());

    // `.mcworld` is a ZIP with a level.dat for the whole world, not for a pack.
    if let Some(level_entry) = names.iter().find(|name| {
        let lower = name.to_lowercase();
        lower == "level.dat" || lower.ends_with("/level.dat")
    }) {
        return install_world_archive(
            archive_path,
            &names,
            level_entry,
            &file_stem,
            targets,
            outcome,
        );
    }

    let specs = discover_packs(archive_path, &names, &file_stem)?;
    if specs.is_empty() {
        return Err(
            "包内未找到 manifest.json：这不是有效的基岩版附加包（.mcpack / .mcaddon）".to_string(),
        );
    }

    for spec in &specs {
        let entries = relative_entries_under(&names, &spec.prefix, true);
        if entries.is_empty() {
            continue;
        }
        for target in targets {
            for kind in &spec.target_kinds {
                let dest = target.join(kind).join(&spec.folder);
                if let Err(err) = extract_entries(archive_path, &entries, &dest) {
                    let _ = force_remove_dir_all(&dest);
                    return Err(format!("安装附加包「{}」失败: {err}", spec.name));
                }
                outcome.note_dir(dest);
                outcome.note_target(target.clone());
            }
        }
        outcome.note_name(&spec.name);
        outcome.note_engine(spec.min_engine);
        for kind in &spec.target_kinds {
            outcome.note_kind(if *kind == "behavior_packs" {
                "行为包"
            } else {
                "资源包"
            });
        }
    }

    // An .mcaddon can bundle more packs as nested .mcpack files.
    let nested: Vec<(usize, String)> = names
        .iter()
        .enumerate()
        .filter(|(_, name)| !name.ends_with('/') && name.to_lowercase().ends_with(".mcpack"))
        .map(|(index, name)| (index, name.clone()))
        .collect();

    let mut nested_errors: Vec<String> = Vec::new();
    if !nested.is_empty() {
        let staging = std::env::temp_dir().join(format!(
            "cobble_nested_packs_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&staging).ok();
        for (index, name) in &nested {
            let file_name = Path::new(name)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "nested.mcpack".to_string());
            let nested_path = staging.join(format!("{index}_{}", sanitize_pack_folder(&file_name)));
            if extract_single_entry(archive_path, *index, &nested_path).is_err() {
                continue;
            }
            if let Err(err) = install_archive(&nested_path, targets, depth + 1, outcome) {
                nested_errors.push(format!("{file_name}: {err}"));
            }
        }
        let _ = std::fs::remove_dir_all(&staging);
    }

    if outcome.is_empty() {
        return Err(nested_errors
            .first()
            .cloned()
            .unwrap_or_else(|| "附加包内没有可安装的包".to_string()));
    }

    Ok(())
}

pub async fn install_bedrock_pack(
    game_root: &Path,
    source_path_or_url: &str,
    filename: &str,
) -> Result<InstallPackResult, String> {
    let root = net::absolute_path(game_root);
    let cache_dir = root.join("bedrock").join("cache").join("packs");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("创建缓存目录失败: {e}"))?;

    let safe_file_name = Path::new(filename)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "pack.mcaddon".to_string());

    let (local_pack_path, downloaded) = if source_path_or_url.starts_with("http://")
        || source_path_or_url.starts_with("https://")
    {
        let dest = cache_dir.join(&safe_file_name);
        // Addons share the unified downloader: source preference, mirror
        // fallback, retries and the configured thread count.
        net::download_file_with_mirrors(
            source_path_or_url,
            &dest,
            None,
            None,
            net::download_threads(),
            None,
            None,
        )
        .await
        .map_err(|e| format!("下载基岩版附加包失败: {e}"))?;
        (dest, true)
    } else {
        (PathBuf::from(source_path_or_url), false)
    };

    if !local_pack_path.is_file() {
        return Err("包文件不存在".to_string());
    }

    let result = install_pack_archive(&root, &local_pack_path);

    if downloaded {
        // The archive is reproducibly re-downloadable; keeping it would only
        // grow the cache with every install.
        let _ = tokio::fs::remove_file(&local_pack_path).await;
    }

    result
}

/// Extracts an archive into every Bedrock data directory that exists.
///
/// Shared by the online install (after the download lands in the cache) and by
/// the pack manager's "import from disk" action.
fn install_pack_archive(root: &Path, local_pack_path: &Path) -> Result<InstallPackResult, String> {
    let targets = bedrock_install_dirs(root);
    let mut result = install_pack_archive_to(local_pack_path, &targets)?;
    if let Some(warning) = engine_requirement_warning(root, result.engine_version.as_deref()) {
        result.message.push_str(&warning);
    }
    Ok(result)
}

/// Highest version among the locally deployed Bedrock cores.
fn newest_installed_core(root: &Path) -> Option<(u32, u32, u32)> {
    let versions = root.join("bedrock").join("versions");
    let entries = std::fs::read_dir(versions).ok()?;
    let mut best: Option<(u32, u32, u32)> = None;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(version) = parse_version_text(&name) else {
            continue;
        };
        if best.map_or(true, |current| version > current) {
            best = Some(version);
        }
    }
    best
}

/// Minecraft silently ignores packs whose `min_engine_version` is newer than
/// the running core, which looks exactly like "the launcher did not install
/// anything". Say it out loud instead.
fn engine_requirement_warning(root: &Path, required: Option<&str>) -> Option<String> {
    let required = parse_version_text(required?)?;
    let installed = newest_installed_core(root)?;
    if installed >= required {
        return None;
    }
    Some(format!(
        " 注意：该附加包要求 Minecraft {} 或更高，当前已安装的最高核心为 {}，游戏会直接忽略它。请先下载 {} 或更新版本的核心再启动。",
        format_version_triple(required),
        format_version_triple(installed),
        format_version_triple(required),
    ))
}

fn install_pack_archive_to(
    local_pack_path: &Path,
    targets: &[PathBuf],
) -> Result<InstallPackResult, String> {
    let mut outcome = InstalledPacks::default();
    install_archive(local_pack_path, targets, 0, &mut outcome)?;

    if outcome.is_empty() {
        return Err("附加包内没有可安装的包".to_string());
    }

    let names = if outcome.pack_names.is_empty() {
        outcome.world_names.join("、")
    } else {
        outcome.pack_names.join("、")
    };
    let pack_type = if !outcome.pack_kinds.is_empty() {
        outcome.pack_kinds.join(" + ")
    } else if !outcome.world_names.is_empty() {
        "世界".to_string()
    } else {
        "附加包".to_string()
    };
    let primary_dir = outcome
        .dest_dirs
        .first()
        .map(|dir| dir.to_string_lossy().to_string())
        .unwrap_or_default();

    // Global Resources lists *resource* packs only. Sending a behaviour-pack
    // user there is how "the pack does not load" reports start: the pack is
    // installed correctly but is enabled per world, somewhere else entirely.
    let has_resource = outcome.pack_kinds.iter().any(|kind| *kind == "资源包");
    let has_behavior = outcome.pack_kinds.iter().any(|kind| *kind == "行为包");
    let location_hint = if !outcome.world_names.is_empty() {
        "启动游戏后在「游戏 → 世界」列表中即可看到导入的世界。"
    } else if has_resource && has_behavior {
        "资源包在「设置 → 全局资源 → 我的包」中启用；行为包只对单个存档生效，需进入存档后在「设置 → 行为包」中启用。"
    } else if has_resource {
        "启动游戏后在「设置 → 全局资源 → 我的包」中启用即可。"
    } else if has_behavior {
        "行为包只对单个存档生效：进入存档后打开「设置 → 行为包」启用；带脚本（script）的附加包还需在世界设置里开启实验性玩法。"
    } else {
        "启动游戏后在「设置 → 存储」中即可看到。"
    };

    let message = format!(
        "已安装：{names}（{pack_type}），写入 {} 个游戏数据目录。{location_hint} 若游戏正在运行，请完全退出后重新启动。",
        outcome.target_roots.len()
    );

    Ok(InstallPackResult {
        success: true,
        pack_name: names,
        pack_type,
        target_path: primary_dir,
        message,
        engine_version: outcome.min_engine.map(format_version_triple),
    })
}

// ---------------------------------------------------------------------------
// Installed Pack Manager (资源包 / 行为包 / 皮肤包)
// ---------------------------------------------------------------------------
//
// Bedrock packs are not Java mods: the game reads them straight out of
// `com.mojang`, every pack carries a `manifest.json` with a UUID and a version,
// and the only way to switch one off is to move its folder somewhere the game
// does not scan. This manager therefore works on every Bedrock data directory
// the launcher can see instead of a Java `versions/<id>/mods` folder.

/// Pack folder -> the type name the UI shows.
const PACK_KINDS: [(&str, &str); 4] = [
    ("resource_packs", "resource"),
    ("behavior_packs", "behavior"),
    ("skin_packs", "skin"),
    ("world_templates", "template"),
];

/// Disabled packs wait here: outside the folders the game scans, so the game
/// stops loading them while the files stay on disk.
const DISABLED_PACKS_DIR: &str = "cobble_disabled_packs";

const MAX_PACK_ICON_BYTES: u64 = 512 * 1024;

#[derive(Deserialize)]
struct PackManagerManifest {
    #[serde(default)]
    header: Option<PackManagerHeader>,
    #[serde(default)]
    modules: Option<Vec<PackModule>>,
}

#[derive(Deserialize)]
struct PackManagerHeader {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<serde_json::Value>,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    version: Option<serde_json::Value>,
    #[serde(default)]
    min_engine_version: Option<serde_json::Value>,
}

/// Manifest engine versions appear both as `[1, 21, 0]` and as `"1.21.0"`.
fn parse_version_triple(value: &serde_json::Value) -> Option<(u32, u32, u32)> {
    match value {
        serde_json::Value::Array(parts) => {
            let mut numbers = [0u32; 3];
            let mut found = false;
            for (index, part) in parts.iter().take(3).enumerate() {
                if let Some(number) = part.as_u64() {
                    numbers[index] = number as u32;
                    found = true;
                }
            }
            found.then_some((numbers[0], numbers[1], numbers[2]))
        }
        serde_json::Value::String(text) => parse_version_text(text),
        serde_json::Value::Number(number) => number.as_u64().map(|value| (value as u32, 0, 0)),
        _ => None,
    }
}

/// `1.18.3104`, `1.21`, `1.21.0-beta` -> comparable triple.
fn parse_version_text(text: &str) -> Option<(u32, u32, u32)> {
    let mut numbers = [0u32; 3];
    let mut found = false;
    for (index, part) in text.trim().split(['.', '-', '_', ' ']).take(3).enumerate() {
        let digits: String = part.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if let Ok(value) = digits.parse::<u32>() {
            numbers[index] = value;
            found = true;
        }
    }
    found.then_some((numbers[0], numbers[1], numbers[2]))
}

fn format_version_triple((major, minor, patch): (u32, u32, u32)) -> String {
    format!("{major}.{minor}.{patch}")
}

fn manifest_engine_version(header: Option<&PackManagerHeader>) -> Option<String> {
    let value = header?.min_engine_version.as_ref()?;
    parse_version_triple(value).map(format_version_triple)
}

fn pack_manifest_of(dir: &Path) -> Option<PackManagerManifest> {
    let raw = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    let trimmed = raw.trim_start_matches('\u{feff}').trim();
    let start = trimmed.find('{')?;
    serde_json::from_str::<PackManagerManifest>(&trimmed[start..]).ok()
}

fn manifest_version_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.trim().to_string(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                serde_json::Value::Number(num) => num.to_string(),
                serde_json::Value::String(text) => text.clone(),
                _ => String::new(),
            })
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("."),
        serde_json::Value::Number(num) => num.to_string(),
        _ => String::new(),
    }
}

fn manifest_description_text(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(text)) => {
            strip_minecraft_formatting(text).trim().to_string()
        }
        // Locale maps look like `{"en_US": "..."}`.
        Some(serde_json::Value::Object(map)) => map
            .values()
            .find_map(|text| text.as_str())
            .map(|text| strip_minecraft_formatting(text).trim().to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn pack_type_from_modules(manifest: Option<&PackManagerManifest>, fallback: &str) -> String {
    for module in manifest
        .and_then(|m| m.modules.as_ref())
        .into_iter()
        .flatten()
    {
        let kind = match module.module_type.as_deref().unwrap_or("").trim() {
            "resources" => "resource",
            "skin" => "skin",
            "world_template" => "template",
            "data" | "script" | "client_data" | "javascript" | "plugin" => "behavior",
            _ => continue,
        };
        return kind.to_string();
    }
    fallback.to_string()
}

fn pack_icon_data_url(dir: &Path) -> Option<String> {
    use base64::Engine;

    let png_magic: &[u8] = &[0x89, b'P', b'N', b'G'];
    let jpeg_magic: &[u8] = &[0xFF, 0xD8];
    for (file_name, mime, magic) in [
        ("pack_icon.png", "image/png", png_magic),
        ("pack.png", "image/png", png_magic),
        ("pack_icon.jpg", "image/jpeg", jpeg_magic),
        ("pack_icon.jpeg", "image/jpeg", jpeg_magic),
    ] {
        let path = dir.join(file_name);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_PACK_ICON_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if !bytes.starts_with(magic) {
            continue;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Some(format!("data:{mime};base64,{encoded}"));
    }

    None
}

fn pack_dir_size(dir: &Path, depth: u8) -> u64 {
    if depth > 8 {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                total += pack_dir_size(&entry.path(), depth + 1);
            } else {
                total += meta.len();
            }
        }
    }
    total
}

fn pack_location_label(data_dir: &Path) -> String {
    let text = data_dir.to_string_lossy().replace('\\', "/");
    if text.contains("Microsoft.MinecraftWindowsBeta") {
        "UWP 预览版".to_string()
    } else if text.contains("Microsoft.MinecraftUWP") {
        "UWP 客户端".to_string()
    } else if text.contains("Minecraft Bedrock Preview") {
        "GDK 预览版".to_string()
    } else if text.contains("Minecraft Bedrock") {
        "GDK 客户端".to_string()
    } else {
        "启动器便携目录".to_string()
    }
}

fn collect_packs_from(
    dir: &Path,
    fallback_type: &str,
    enabled: bool,
    data_dir: &Path,
    out: &mut Vec<BedrockPackItem>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Without a manifest the game ignores the folder, so it is not a pack.
        let Some(manifest) = pack_manifest_of(&path) else {
            continue;
        };
        let folder = entry.file_name().to_string_lossy().to_string();
        let header = manifest.header.as_ref();
        let name = header
            .and_then(|h| h.name.as_deref())
            .map(|name| strip_minecraft_formatting(name).trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| folder.clone());
        let uuid = header
            .and_then(|h| h.uuid.as_deref())
            .map(|uuid| uuid.trim().to_string())
            .filter(|uuid| !uuid.is_empty());
        let version = header
            .and_then(|h| h.version.as_ref())
            .map(manifest_version_text)
            .unwrap_or_default();
        let engine_version = manifest_engine_version(header);
        let modified_time = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .map(|time| {
                let secs = time
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                format_iso8601_utc(secs)
            })
            .unwrap_or_default();

        out.push(BedrockPackItem {
            id: uuid.unwrap_or_else(|| folder.clone()),
            name,
            description: manifest_description_text(header.and_then(|h| h.description.as_ref())),
            version,
            engine_version,
            pack_type: pack_type_from_modules(Some(&manifest), fallback_type),
            folder,
            path: path.to_string_lossy().to_string(),
            enabled,
            size: pack_dir_size(&path, 0),
            modified_time,
            icon: pack_icon_data_url(&path),
            location: pack_location_label(data_dir),
            location_path: data_dir.to_string_lossy().to_string(),
        });
    }
}

/// Every pack installed in any Bedrock data directory, one row per pack.
pub fn get_bedrock_packs(game_root: &Path) -> Vec<BedrockPackItem> {
    let root = net::absolute_path(game_root);
    let mut found: Vec<BedrockPackItem> = Vec::new();

    for data_dir in bedrock_game_data_dirs(&root) {
        for (folder, kind) in PACK_KINDS {
            collect_packs_from(&data_dir.join(folder), kind, true, &data_dir, &mut found);
            collect_packs_from(
                &data_dir.join(DISABLED_PACKS_DIR).join(folder),
                kind,
                false,
                &data_dir,
                &mut found,
            );
        }
    }

    // Installs write the same pack into every data directory that exists, so
    // merge on (type, UUID) and keep the enabled copy when the copies disagree.
    // Between two enabled copies prefer the client folder: that is the copy the
    // game reads, and the one the user expects the row to point at.
    let portable_key = portable_mojang_dir(&root).to_string_lossy().to_lowercase();
    let is_staging = |item: &BedrockPackItem| item.location_path.to_lowercase() == portable_key;
    let mut merged: Vec<BedrockPackItem> = Vec::with_capacity(found.len());
    for item in found {
        match merged
            .iter_mut()
            .find(|existing| existing.pack_type == item.pack_type && existing.id == item.id)
        {
            Some(existing) => {
                let better = if !existing.enabled && item.enabled {
                    true
                } else {
                    existing.enabled == item.enabled && is_staging(existing) && !is_staging(&item)
                };
                if better {
                    *existing = item;
                }
            }
            None => merged.push(item),
        }
    }

    merged.sort_by(|a, b| {
        a.pack_type
            .cmp(&b.pack_type)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    merged
}

/// Splits a pack path into `(data_dir, pack folder, folder name, enabled)`.
///
/// Only paths inside a known `com.mojang` pack folder are accepted, so a pack
/// row can never move or delete something unrelated.
fn resolve_pack_location(
    root: &Path,
    path: &Path,
) -> Result<(PathBuf, String, String, bool), String> {
    let normalized = net::absolute_path(path);
    for data_dir in bedrock_game_data_dirs(root) {
        for (folder, _kind) in PACK_KINDS {
            if let Ok(rest) = normalized.strip_prefix(data_dir.join(folder)) {
                if rest.components().count() == 1 {
                    return Ok((
                        data_dir.clone(),
                        folder.to_string(),
                        rest.to_string_lossy().to_string(),
                        true,
                    ));
                }
            }
            let disabled_base = data_dir.join(DISABLED_PACKS_DIR).join(folder);
            if let Ok(rest) = normalized.strip_prefix(&disabled_base) {
                if rest.components().count() == 1 {
                    return Ok((
                        data_dir.clone(),
                        folder.to_string(),
                        rest.to_string_lossy().to_string(),
                        false,
                    ));
                }
            }
        }
    }
    Err("该路径不在基岩版附加包目录内，已拒绝操作".to_string())
}

/// Every physical copy of one pack, one per data directory.
///
/// `get_bedrock_packs` merges copies for display, so it can never be used to
/// find the other `com.mojang` folders. Disabling or deleting only the copy the
/// user clicked would leave the game loading the pack from another folder.
fn pack_copy_paths(data_dirs: &[PathBuf], id: &str, pack_type: &str) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    for data_dir in data_dirs {
        for base in [data_dir.clone(), data_dir.join(DISABLED_PACKS_DIR)] {
            for (folder, kind) in PACK_KINDS {
                if kind != pack_type {
                    continue;
                }
                let Ok(entries) = std::fs::read_dir(base.join(folder)) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let manifest = pack_manifest_of(&path);
                    let uuid = manifest
                        .as_ref()
                        .and_then(|manifest| manifest.header.as_ref())
                        .and_then(|header| header.uuid.as_deref())
                        .map(|uuid| uuid.trim().to_string())
                        .filter(|uuid| !uuid.is_empty());
                    let matched = match uuid {
                        Some(uuid) => uuid == id,
                        // Packs without a UUID are listed by folder name.
                        None => entry.file_name().to_string_lossy() == id,
                    };
                    if matched && !paths.contains(&path) {
                        paths.push(path);
                    }
                }
            }
        }
    }
    paths
}

pub fn set_bedrock_pack_enabled(game_root: &Path, path: &str, enabled: bool) -> Result<(), String> {
    let root = net::absolute_path(game_root);
    let source = net::absolute_path(Path::new(path));
    let packs = get_bedrock_packs(&root);
    let target = packs
        .iter()
        .find(|pack| net::absolute_path(Path::new(&pack.path)) == source)
        .ok_or_else(|| "未找到该附加包，请先刷新列表".to_string())?;
    if target.enabled == enabled {
        return Ok(());
    }

    // Installs write one copy into every data directory that exists. Move all
    // of them, otherwise an untouched copy in another `com.mojang` folder would
    // keep loading and the next refresh would flip the switch back.
    let mut candidates: Vec<PathBuf> = pack_copy_paths(
        &bedrock_game_data_dirs(&root),
        &target.id,
        &target.pack_type,
    )
    .into_iter()
    .filter(|copy| {
        resolve_pack_location(&root, copy)
            .map(|(_, _, _, copy_enabled)| copy_enabled == target.enabled)
            .unwrap_or(false)
    })
    .collect();
    if candidates.is_empty() {
        candidates.push(source.clone());
    }

    let hint = "（若游戏正在运行，请先完全关闭游戏）";
    let mut failures: Vec<String> = Vec::new();
    for candidate in candidates {
        let Ok((data_dir, folder, name, _)) = resolve_pack_location(&root, &candidate) else {
            continue;
        };
        let target_dir = if enabled {
            data_dir.join(&folder)
        } else {
            data_dir.join(DISABLED_PACKS_DIR).join(&folder)
        };
        if let Err(error) = std::fs::create_dir_all(&target_dir) {
            failures.push(error.to_string());
            continue;
        }

        let mut destination = target_dir.join(&name);
        let mut suffix = 2;
        while destination.exists() && suffix < 100 {
            destination = target_dir.join(format!("{name}_{suffix}"));
            suffix += 1;
        }
        if let Err(error) = std::fs::rename(&candidate, &destination) {
            failures.push(error.to_string());
        }
    }

    if let Some(error) = failures.first() {
        return Err(if enabled {
            format!("启用附加包失败: {error}{hint}")
        } else {
            format!("停用附加包失败: {error}{hint}")
        });
    }
    Ok(())
}

pub fn delete_bedrock_pack(game_root: &Path, path: &str) -> Result<(), String> {
    let root = net::absolute_path(game_root);
    let target_path = net::absolute_path(Path::new(path));
    resolve_pack_location(&root, &target_path)?;
    if !target_path.exists() {
        return Err("附加包目录已不存在".to_string());
    }

    // Remove every installed copy of the same pack, not just the row the user
    // clicked, so the pack does not reappear from another data directory.
    let packs = get_bedrock_packs(&root);
    let identity = packs
        .iter()
        .find(|pack| net::absolute_path(Path::new(&pack.path)) == target_path)
        .map(|pack| (pack.id.clone(), pack.pack_type.clone()));
    let mut paths = vec![target_path.clone()];
    if let Some((id, pack_type)) = identity {
        for candidate in pack_copy_paths(&bedrock_game_data_dirs(&root), &id, &pack_type) {
            if !paths.contains(&candidate) {
                paths.push(candidate);
            }
        }
    }

    let hint = "（若游戏正在运行，请先完全关闭游戏）";
    for candidate in paths {
        // Never recurse into anything that is not a pack folder.
        if resolve_pack_location(&root, &candidate).is_err() || !candidate.exists() {
            continue;
        }
        force_remove_dir_all(&candidate).map_err(|e| format!("删除附加包失败: {e}{hint}"))?;
    }
    Ok(())
}

/// Installs a `.mcpack` / `.mcaddon` / `.mcworld` / `.zip` picked from disk into
/// every Bedrock data directory that exists.
pub fn install_bedrock_pack_from_file(
    game_root: &Path,
    file_path: &str,
) -> Result<InstallPackResult, String> {
    let root = net::absolute_path(game_root);
    let source = net::absolute_path(Path::new(file_path));
    if !source.is_file() {
        return Err(format!("附加包文件不存在: {file_path}"));
    }
    let lower = source
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !(lower.ends_with(".mcpack")
        || lower.ends_with(".mcaddon")
        || lower.ends_with(".mcworld")
        || lower.ends_with(".zip"))
    {
        return Err("请选择 .mcpack / .mcaddon / .mcworld / .zip 附加包".to_string());
    }

    let mut result = install_pack_archive(&root, &source)?;
    result.message = format!("本地导入 — {}", result.message);
    Ok(result)
}

// ---------------------------------------------------------------------------
// Bedrock World Manager (存档)
// ---------------------------------------------------------------------------
//
// Bedrock keeps every world in `<data dir>/minecraftWorlds/<id>`, one folder per
// world with `level.dat`, `levelname.txt` and `world_icon.jpeg`. The launcher
// writes packs into every `com.mojang` folder that exists, so an imported world
// can appear in more than one of them; the list merges the copies by world id
// and the delete action removes all of them.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockWorldItem {
    /// World folder id (`minecraftWorlds/<id>`), unique per machine copy.
    pub id: String,
    pub name: String,
    pub folder: String,
    pub path: String,
    pub size: u64,
    pub modified_time: String,
    #[serde(default)]
    pub icon: Option<String>,
    /// Which data folder this copy lives in: portable, GDK or UWP.
    pub location: String,
    pub location_path: String,
}

fn world_icon_data_url(dir: &Path) -> Option<String> {
    use base64::Engine;

    let png_magic: &[u8] = &[0x89, b'P', b'N', b'G'];
    let jpeg_magic: &[u8] = &[0xFF, 0xD8];
    for (file_name, mime, magic) in [
        ("world_icon.jpeg", "image/jpeg", jpeg_magic),
        ("world_icon.jpg", "image/jpeg", jpeg_magic),
        ("world_icon.png", "image/png", png_magic),
    ] {
        let path = dir.join(file_name);
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_PACK_ICON_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if !bytes.starts_with(magic) {
            continue;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Some(format!("data:{mime};base64,{encoded}"));
    }

    None
}

pub fn get_bedrock_worlds(game_root: &Path) -> Vec<BedrockWorldItem> {
    let root = net::absolute_path(game_root);
    let mut found: Vec<BedrockWorldItem> = Vec::new();

    for data_dir in bedrock_game_data_dirs(&root) {
        let Ok(entries) = std::fs::read_dir(data_dir.join("minecraftWorlds")) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() || !path.join("level.dat").is_file() {
                continue;
            }
            let folder = entry.file_name().to_string_lossy().to_string();
            let name = std::fs::read_to_string(path.join("levelname.txt"))
                .map(|text| strip_minecraft_formatting(&text).trim().to_string())
                .ok()
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| folder.clone());
            let modified_time = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .map(|time| {
                    format_iso8601_utc(
                        time.duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    )
                })
                .unwrap_or_default();

            let item = BedrockWorldItem {
                id: folder.clone(),
                name,
                folder,
                path: path.to_string_lossy().to_string(),
                size: pack_dir_size(&path, 0),
                modified_time,
                icon: world_icon_data_url(&path),
                location: pack_location_label(&data_dir),
                location_path: data_dir.to_string_lossy().to_string(),
            };

            match found.iter_mut().find(|world| world.id == item.id) {
                Some(existing) => {
                    if existing.modified_time < item.modified_time {
                        *existing = item;
                    }
                }
                None => found.push(item),
            }
        }
    }

    found.sort_by(|a, b| b.modified_time.cmp(&a.modified_time));
    found
}

/// Splits a world path into `(world id, all installed copies)`.
///
/// Only paths directly under a known `minecraftWorlds` folder are accepted, so
/// a world row can never delete something outside the game data.
fn resolve_world_copies(root: &Path, path: &Path) -> Result<Vec<PathBuf>, String> {
    let normalized = net::absolute_path(path);
    let mut folder = None;
    for data_dir in bedrock_game_data_dirs(root) {
        if let Ok(rest) = normalized.strip_prefix(data_dir.join("minecraftWorlds")) {
            if rest.components().count() == 1 {
                folder = Some(rest.to_string_lossy().to_string());
                break;
            }
        }
    }
    let folder = folder.ok_or_else(|| "该路径不在基岩版存档目录内，已拒绝操作".to_string())?;

    let mut copies = Vec::new();
    for data_dir in bedrock_game_data_dirs(root) {
        let candidate = data_dir.join("minecraftWorlds").join(&folder);
        if candidate.is_dir() {
            copies.push(candidate);
        }
    }
    Ok(copies)
}

pub fn delete_bedrock_world(game_root: &Path, path: &str) -> Result<(), String> {
    let root = net::absolute_path(game_root);
    let target = net::absolute_path(Path::new(path));
    let copies = resolve_world_copies(&root, &target)?;
    if copies.is_empty() {
        return Err("存档目录已不存在".to_string());
    }

    let hint = "（若游戏正在运行，请先完全关闭游戏）";
    for candidate in copies {
        force_remove_dir_all(&candidate).map_err(|e| format!("删除存档失败: {e}{hint}"))?;
    }
    Ok(())
}

/// Imports a `.mcworld` / `.zip` world into every Bedrock data directory.
pub fn import_bedrock_world_file(
    game_root: &Path,
    file_path: &str,
) -> Result<InstallPackResult, String> {
    let root = net::absolute_path(game_root);
    let source = net::absolute_path(Path::new(file_path));
    if !source.is_file() {
        return Err(format!("存档文件不存在: {file_path}"));
    }
    let lower = source
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !(lower.ends_with(".mcworld") || lower.ends_with(".zip")) {
        return Err("请选择 .mcworld / .zip 世界存档".to_string());
    }

    let names = zip_entry_names(&source)?;
    let has_level = names.iter().any(|name| {
        let lower = name.to_lowercase();
        lower == "level.dat" || lower.ends_with("/level.dat")
    });
    if !has_level {
        return Err("压缩包里没有 level.dat，这不是基岩版世界存档".to_string());
    }

    let mut result = install_pack_archive(&root, &source)?;
    result.message = format!("本地导入 — {}", result.message);
    Ok(result)
}

// ---------------------------------------------------------------------------
// Portable data sync
// ---------------------------------------------------------------------------
//
// Imports are written to every client data folder that exists at that moment.
// On a machine whose Bedrock client has never been started there is no
// `com.mojang` yet, so those imports stay in the launcher's portable folder and
// the game never reads them. This sync runs right before a Bedrock launch and
// copies anything missing into the client folders — the only moment that
// guarantees the game will see it.

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if from.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Whether a pack with this header UUID is present under `dir`, enabled or in
/// the disabled container (a pack the user switched off must stay off).
fn pack_uuid_present(dir: &Path, uuid: &str) -> bool {
    let uuid = uuid.trim().to_ascii_lowercase();
    if uuid.is_empty() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(manifest) = pack_manifest_of(&path) else {
            continue;
        };
        let found = manifest
            .header
            .as_ref()
            .and_then(|header| header.uuid.as_deref())
            .map(|value| value.trim().to_ascii_lowercase());
        if found.as_deref() == Some(uuid.as_str()) {
            return true;
        }
    }
    false
}

fn sync_portable_to_targets(portable: &Path, targets: &[PathBuf]) -> usize {
    if targets.is_empty() {
        return 0;
    }
    let mut copied = 0usize;

    for (folder, _kind) in PACK_KINDS {
        let Ok(entries) = std::fs::read_dir(portable.join(folder)) else {
            continue;
        };
        for entry in entries.flatten() {
            let source = entry.path();
            if !source.is_dir() {
                continue;
            }
            let Some(manifest) = pack_manifest_of(&source) else {
                continue;
            };
            let Some(uuid) = manifest.header.as_ref().and_then(|h| h.uuid.as_deref()) else {
                continue;
            };
            let folder_name = entry.file_name().to_string_lossy().to_string();
            for target in targets {
                let base = target.join(folder);
                if pack_uuid_present(&base, uuid)
                    || pack_uuid_present(&target.join(DISABLED_PACKS_DIR).join(folder), uuid)
                {
                    continue;
                }
                let dest = base.join(&folder_name);
                if dest.exists() {
                    continue;
                }
                if copy_dir_recursive(&source, &dest).is_ok() {
                    copied += 1;
                }
            }
        }
    }

    // Worlds imported before the client had a data folder are staged the same
    // way; copy them by world id (the folder name the game uses).
    if let Ok(entries) = std::fs::read_dir(portable.join("minecraftWorlds")) {
        for entry in entries.flatten() {
            let source = entry.path();
            if !source.is_dir() || !source.join("level.dat").is_file() {
                continue;
            }
            let folder_name = entry.file_name().to_string_lossy().to_string();
            for target in targets {
                let dest = target.join("minecraftWorlds").join(&folder_name);
                if dest.exists() {
                    continue;
                }
                if copy_dir_recursive(&source, &dest).is_ok() {
                    copied += 1;
                }
            }
        }
    }

    copied
}

/// Creates the `com.mojang` data folder of a package that was just registered
/// and moves everything staged in the portable folder into it.
///
/// Registering a loose AppX core is the moment the game gets its data folder
/// (`%LOCALAPPDATA%\Packages\<PFN>\LocalState\games\com.mojang`). Anything a
/// user imported before that — which is the normal case on a fresh machine —
/// would otherwise stay in the launcher's own folder and never be loaded.
/// Returns how many pack/world folders were copied.
#[cfg(target_os = "windows")]
fn seed_package_data_dir(pfn: &str, game_root: &Path) -> usize {
    let Ok(local) = std::env::var("LOCALAPPDATA") else {
        return 0;
    };
    let data_dir = PathBuf::from(local)
        .join("Packages")
        .join(pfn.trim())
        .join("LocalState")
        .join("games")
        .join("com.mojang");
    if std::fs::create_dir_all(&data_dir).is_err() {
        return 0;
    }

    let root = net::absolute_path(game_root);
    let portable = portable_mojang_dir(&root);
    if !portable.is_dir() {
        return 0;
    }
    sync_portable_to_targets(&portable, &[data_dir])
}

/// Copy packs and worlds that only exist in the portable staging folder into
/// every installed client's data folder. Returns how many entries were copied.
pub fn sync_portable_content_to_clients(game_root: &Path) -> usize {
    let root = net::absolute_path(game_root);
    let portable = portable_mojang_dir(&root);
    if !portable.is_dir() {
        return 0;
    }
    let portable_key = portable.to_string_lossy().to_lowercase();
    let targets: Vec<PathBuf> = bedrock_install_dirs(&root)
        .into_iter()
        .filter(|dir| dir.to_string_lossy().to_lowercase() != portable_key)
        .collect();
    sync_portable_to_targets(&portable, &targets)
}

/// Updates or inserts `mp_username:<username>` in every known `com.mojang/minecraftpe/options.txt`
/// so Bedrock Edition loads the launcher's account name upon launch.
pub fn sync_bedrock_username(game_root: &Path, username: &str) {
    let clean = username.trim();
    if clean.is_empty() {
        return;
    }

    let mut target_dirs = client_mojang_dirs(game_root, true);
    let portable = portable_mojang_dir(game_root);
    if !target_dirs.iter().any(|d| d == &portable) {
        target_dirs.push(portable);
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            for pkg in [
                "Microsoft.MinecraftUWP_8wekyb3d8bbwe",
                "Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe",
            ] {
                let candidate = PathBuf::from(&local)
                    .join("Packages")
                    .join(pkg)
                    .join("LocalState")
                    .join("games")
                    .join("com.mojang");
                if candidate.is_dir() && !target_dirs.iter().any(|d| d == &candidate) {
                    target_dirs.push(candidate);
                }
            }
        }
    }

    for mojang_dir in target_dirs {
        let pe_dir = mojang_dir.join("minecraftpe");
        let options_file = pe_dir.join("options.txt");
        let _ = std::fs::create_dir_all(&pe_dir);

        let new_content = if let Ok(existing) = std::fs::read_to_string(&options_file) {
            let mut found = false;
            let mut lines: Vec<String> = existing
                .lines()
                .map(|line| {
                    if line.trim_start().starts_with("mp_username:") {
                        found = true;
                        format!("mp_username:{clean}")
                    } else {
                        line.to_string()
                    }
                })
                .collect();
            if !found {
                lines.insert(0, format!("mp_username:{clean}"));
            }
            lines.join("\r\n") + "\r\n"
        } else {
            format!("mp_username:{clean}\r\ngame_difficulty_new:1\r\ngame_thirdperson:0\r\n")
        };

        let _ = std::fs::write(&options_file, new_content);
    }
}

// ---------------------------------------------------------------------------
// Bedrock Mod Loaders & Mods Management (LeviLamina & DllMods)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LeviLaminaVersionDb {
    #[serde(default)]
    versions: std::collections::HashMap<String, Vec<String>>,
}

pub async fn fetch_bedrock_loaders(mc_version: &str) -> BedrockLoadersCatalog {
    let raw_mc = mc_version.trim();
    let clean_mc = raw_mc
        .trim_start_matches("v")
        .trim_start_matches("Minecraft 基岩版 ")
        .trim();

    let mut catalog = BedrockLoadersCatalog {
        mc_version: raw_mc.to_string(),
        levilamina: Vec::new(),
        amethyst: Vec::new(),
    };

    let endpoints = [
        "https://fastly.jsdelivr.net/gh/LiteLDev/levilamina-client-version-db@main/v2/version-db.json",
        "https://cdn.jsdelivr.net/gh/LiteLDev/levilamina-client-version-db@main/v2/version-db.json",
        "https://raw.githubusercontent.com/LiteLDev/levilamina-client-version-db/main/v2/version-db.json",
        "https://raw.gitmirror.com/LiteLDev/levilamina-client-version-db/main/v2/version-db.json",
    ];

    let mut matched_versions = Vec::new();
    let mut matched_key = String::new();

    let client = net::client();
    for ep in endpoints {
        if let Ok(resp) = client
            .get(ep)
            .timeout(std::time::Duration::from_secs(4))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(db) = resp.json::<LeviLaminaVersionDb>().await {
                    for (k, v_list) in &db.versions {
                        if k == clean_mc || clean_mc.starts_with(k) || k.starts_with(clean_mc) {
                            matched_versions = v_list.clone();
                            matched_key = k.clone();
                            break;
                        }
                        let clean_parts: Vec<&str> = clean_mc.split('.').collect();
                        let k_parts: Vec<&str> = k.split('.').collect();
                        if clean_parts.len() >= 2 && k_parts.len() >= 2 {
                            if clean_parts[0] == k_parts[0] && clean_parts[1] == k_parts[1] {
                                matched_versions = v_list.clone();
                                matched_key = k.clone();
                                break;
                            }
                        }
                    }
                    if !matched_versions.is_empty() {
                        break;
                    }
                }
            }
        }
    }

    if matched_versions.is_empty() {
        matched_versions = vec![
            "26.51.8".to_string(),
            "26.40.6".to_string(),
            "26.32.4".to_string(),
            "26.20.7".to_string(),
            "26.10.14".to_string(),
            "1.9.9".to_string(),
            "1.9.0".to_string(),
            "1.8.0-rc.2".to_string(),
        ];
        matched_key = if clean_mc.is_empty() {
            "通用".to_string()
        } else {
            clean_mc.to_string()
        };
    }

    matched_versions.reverse();

    for (idx, ver) in matched_versions.into_iter().enumerate() {
        let is_stable = !ver.contains("rc") && !ver.contains("beta");
        let desc = if idx == 0 {
            format!("LeviLamina 客户端加载器 (推荐适配: {matched_key})")
        } else {
            format!("LeviLamina 客户端加载器 v{ver}")
        };

        catalog.levilamina.push(BedrockLoaderItem {
            name: "LeviLamina".to_string(),
            version: ver.clone(),
            loader_type: "levilamina".to_string(),
            compatible_mc_version: matched_key.clone(),
            download_url: format!("https://github.com/LiteLDev/LeviLamina/releases/download/v{ver}/levilamina-v{ver}-client-release-windows-x64.zip"),
            description: desc,
            release_time: None,
            stable: is_stable,
        });
    }

    for ver in ["0.4.1", "0.4.0", "0.3.9"] {
        catalog.amethyst.push(BedrockLoaderItem {
            name: "Amethyst".to_string(),
            version: ver.to_string(),
            loader_type: "amethyst".to_string(),
            compatible_mc_version: clean_mc.to_string(),
            download_url: format!("https://github.com/FreerGit/Amethyst/releases/download/v{ver}/Amethyst-Windows.zip"),
            description: format!("Amethyst 原生 C++ 客户端模组加载器 v{ver}"),
            release_time: None,
            stable: true,
        });
    }

    catalog
}

pub fn get_bedrock_loader_config(
    game_root: &Path,
    version_id: &str,
) -> BedrockInstanceLoaderConfig {
    let root = net::absolute_path(game_root);
    let ver_dir = resolve_bedrock_version_dir(&root, version_id);
    let cfg_file = ver_dir.join("loader.json");
    if cfg_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&cfg_file) {
            if let Ok(parsed) = serde_json::from_str::<BedrockInstanceLoaderConfig>(&content) {
                return parsed;
            }
        }
    }
    BedrockInstanceLoaderConfig::default()
}

pub async fn install_bedrock_loader(
    game_root: &Path,
    version_id: &str,
    loader_type: &str,
    loader_version: &str,
) -> Result<String, String> {
    let root = net::absolute_path(game_root);
    let ver_dir = resolve_bedrock_version_dir(&root, version_id);
    if !ver_dir.is_dir() {
        return Err(format!("未找到基岩版版本目录: {}", ver_dir.display()));
    }

    let cache_dir = root.join("bedrock").join("cache");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("创建缓存目录失败: {e}"))?;

    let loader_lower = loader_type.to_lowercase();
    if loader_lower == "levilamina" {
        let zip_url = format!(
            "https://github.com/LiteLDev/LeviLamina/releases/download/v{loader_version}/levilamina-v{loader_version}-client-release-windows-x64.zip"
        );
        let zip_path = cache_dir.join(format!("levilamina-{loader_version}.zip"));

        net::download_file_with_mirrors(&zip_url, &zip_path, None, None, 1, None, None)
            .await
            .map_err(|e| format!("下载 LeviLamina 失败 ({zip_url}): {e}"))?;

        let file = File::open(&zip_path).map_err(|e| format!("打开安装包失败: {e}"))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("解压安装包失败: {e}"))?;

        let mods_dir = ver_dir.join("mods");
        let plugins_dir = ver_dir.join("plugins");
        std::fs::create_dir_all(&mods_dir).map_err(|e| format!("创建模组目录失败: {e}"))?;
        std::fs::create_dir_all(&plugins_dir).map_err(|e| format!("创建插件目录失败: {e}"))?;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("读取压缩文件条目失败: {e}"))?;
            let outpath = match entry.enclosed_name() {
                Some(path) => ver_dir.join(path),
                None => continue,
            };

            if entry.is_dir() {
                std::fs::create_dir_all(&outpath).map_err(|e| format!("创建目录失败: {e}"))?;
            } else {
                if let Some(p) = outpath.parent() {
                    if !p.exists() {
                        std::fs::create_dir_all(p).map_err(|e| format!("创建父目录失败: {e}"))?;
                    }
                }
                let mut outfile =
                    File::create(&outpath).map_err(|e| format!("解压文件失败: {e}"))?;
                std::io::copy(&mut entry, &mut outfile)
                    .map_err(|e| format!("写入文件失败: {e}"))?;
            }
        }

        let cfg = BedrockInstanceLoaderConfig {
            loader_type: Some("levilamina".to_string()),
            loader_version: Some(loader_version.to_string()),
            enabled: true,
        };
        if let Ok(json_str) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(ver_dir.join("loader.json"), json_str);
        }

        Ok(format!(
            "LeviLamina v{loader_version} 已成功安装到基岩版实例 {version_id}！"
        ))
    } else if loader_lower == "amethyst" {
        let zip_url = format!(
            "https://github.com/FreerGit/Amethyst/releases/download/v{loader_version}/Amethyst-Windows.zip"
        );
        let zip_path = cache_dir.join(format!("amethyst-{loader_version}.zip"));

        net::download_file_with_mirrors(&zip_url, &zip_path, None, None, 1, None, None)
            .await
            .map_err(|e| format!("下载 Amethyst 失败 ({zip_url}): {e}"))?;

        if let Ok(file) = File::open(&zip_path) {
            if let Ok(mut archive) = zip::ZipArchive::new(file) {
                let _ = archive.extract(&ver_dir);
            }
        }

        let cfg = BedrockInstanceLoaderConfig {
            loader_type: Some("amethyst".to_string()),
            loader_version: Some(loader_version.to_string()),
            enabled: true,
        };
        if let Ok(json_str) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(ver_dir.join("loader.json"), json_str);
        }

        Ok(format!(
            "Amethyst v{loader_version} 已成功安装到基岩版实例 {version_id}！"
        ))
    } else {
        Err(format!("不支持的基岩版模组加载器类型: {loader_type}"))
    }
}

pub fn get_bedrock_mods(game_root: &Path, version_id: &str) -> Result<Vec<BedrockModItem>, String> {
    let root = net::absolute_path(game_root);
    let ver_dir = resolve_bedrock_version_dir(&root, version_id);
    let mut items = Vec::new();

    let scan_dirs = [
        (ver_dir.join("mods"), "dll_mod"),
        (
            ver_dir.join("config").join("BedrockBoot2").join("mods"),
            "dll_mod",
        ),
        (ver_dir.join("plugins"), "levilamina_plugin"),
    ];

    for (dir, default_type) in scan_dirs {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                let fname = entry.file_name().to_string_lossy().to_string();
                if fname.starts_with('.') {
                    continue;
                }

                let is_disabled = fname.ends_with(".disabled");
                let clean_name = if is_disabled {
                    fname.trim_end_matches(".disabled").to_string()
                } else {
                    fname.clone()
                };

                let is_dll = clean_name.ends_with(".dll");
                let is_pack = clean_name.ends_with(".mcpack") || clean_name.ends_with(".zip");

                if is_dll || is_pack || p.is_dir() {
                    let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let mtime = entry.metadata().and_then(|m| m.modified()).ok();
                    let mtime_str = mtime
                        .map(|t| {
                            let dur = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                            format_iso8601_utc(dur.as_secs())
                        })
                        .unwrap_or_default();

                    let mod_type = if is_dll {
                        "dll_mod"
                    } else if default_type == "levilamina_plugin" {
                        "levilamina_plugin"
                    } else {
                        "behavior_pack"
                    };

                    items.push(BedrockModItem {
                        id: fname.clone(),
                        name: clean_name
                            .replace(".dll", "")
                            .replace(".mcpack", "")
                            .replace(".zip", ""),
                        file_name: fname.clone(),
                        path: p.to_string_lossy().to_string(),
                        mod_type: mod_type.to_string(),
                        enabled: !is_disabled,
                        inject_delay: 0,
                        is_pre_load: is_dll,
                        size: sz,
                        modified_time: mtime_str,
                    });
                }
            }
        }
    }

    Ok(items)
}

pub fn toggle_bedrock_mod(
    game_root: &Path,
    version_id: &str,
    mod_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let root = net::absolute_path(game_root);
    let ver_dir = resolve_bedrock_version_dir(&root, version_id);

    let candidates = [
        ver_dir.join("mods").join(mod_id),
        ver_dir
            .join("config")
            .join("BedrockBoot2")
            .join("mods")
            .join(mod_id),
        ver_dir.join("plugins").join(mod_id),
    ];

    for current_path in candidates {
        if current_path.exists() {
            let fname = current_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let parent = current_path.parent().unwrap();

            if enabled && fname.ends_with(".disabled") {
                let target_name = fname.trim_end_matches(".disabled");
                let target_path = parent.join(target_name);
                std::fs::rename(&current_path, &target_path)
                    .map_err(|e| format!("启用模组失败: {e}"))?;
                return Ok(());
            } else if !enabled && !fname.ends_with(".disabled") {
                let target_name = format!("{fname}.disabled");
                let target_path = parent.join(target_name);
                std::fs::rename(&current_path, &target_path)
                    .map_err(|e| format!("禁用模组失败: {e}"))?;
                return Ok(());
            }
            return Ok(());
        }
    }

    Err(format!("未找到指定的模组文件: {mod_id}"))
}

pub fn delete_bedrock_mod(game_root: &Path, version_id: &str, mod_id: &str) -> Result<(), String> {
    let root = net::absolute_path(game_root);
    let ver_dir = resolve_bedrock_version_dir(&root, version_id);

    let candidates = [
        ver_dir.join("mods").join(mod_id),
        ver_dir
            .join("config")
            .join("BedrockBoot2")
            .join("mods")
            .join(mod_id),
        ver_dir.join("plugins").join(mod_id),
    ];

    for current_path in candidates {
        if current_path.exists() {
            if current_path.is_dir() {
                let _ = std::fs::remove_dir_all(&current_path);
            } else {
                let _ = std::fs::remove_file(&current_path);
            }
            return Ok(());
        }
    }

    Err(format!("未找到指定的模组文件: {mod_id}"))
}

pub fn install_bedrock_mod_file(
    game_root: &Path,
    version_id: &str,
    source_file_path: &str,
) -> Result<String, String> {
    let src = Path::new(source_file_path);
    if !src.is_file() {
        return Err(format!("源模组文件不存在: {source_file_path}"));
    }

    let root = net::absolute_path(game_root);
    let ver_dir = resolve_bedrock_version_dir(&root, version_id);
    let fname = src
        .file_name()
        .ok_or("无效的文件名")?
        .to_string_lossy()
        .to_string();

    let dest_dir = if fname.ends_with(".dll") {
        ver_dir.join("mods")
    } else {
        ver_dir.join("plugins")
    };
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("创建目标目录失败: {e}"))?;

    let dest_file = dest_dir.join(&fname);
    std::fs::copy(src, &dest_file).map_err(|e| format!("复制模组文件失败: {e}"))?;

    Ok(format!("模组 {fname} 已成功安装到基岩版实例 {version_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn test_appx_framework_dependencies_are_parsed() {
        let dir = std::env::temp_dir().join(format!(
            "cobble_appx_deps_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("AppxManifest.xml");
        std::fs::write(
            &manifest,
            r#"<?xml version="1.0"?>
<Package>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17134.0" />
    <PackageDependency Name="Microsoft.VCLibs.140.00" MinVersion="14.0.30704.0" />
    <PackageDependency Name="Microsoft.Services.Store.Engagement" MinVersion="10.0.1610.0" />
  </Dependencies>
</Package>"#,
        )
        .unwrap();

        assert_eq!(
            appx_framework_dependencies(&manifest),
            vec![
                "Microsoft.VCLibs.140.00".to_string(),
                "Microsoft.Services.Store.Engagement".to_string(),
            ]
        );

        let _ = force_remove_dir_all(&dir);
    }

    /// A locally deployed core must not declare framework packages that are not
    /// installed: deployment would abort with 0x80073CF3 and the user would be
    /// pushed back towards the Microsoft Store for a framework.
    #[cfg(target_os = "windows")]
    #[test]
    fn test_missing_appx_dependency_is_stripped_and_backed_up() {
        let dir = std::env::temp_dir().join(format!(
            "cobble_appx_strip_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("AppxManifest.xml");
        let original = r#"<?xml version="1.0"?>
<Package>
  <Identity Name="Microsoft.MinecraftUWP" Publisher="CN=Microsoft Corporation" Version="1.18.3104.0" ProcessorArchitecture="x64" />
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Universal" MinVersion="10.0.17134.0" />
    <PackageDependency Name="Cobble.Test.Missing.Framework" MinVersion="1.0.0.0" />
  </Dependencies>
</Package>"#;
        std::fs::write(&manifest, original).unwrap();

        let removed = strip_missing_appx_dependencies(&manifest);
        assert_eq!(removed, vec!["Cobble.Test.Missing.Framework".to_string()]);

        let patched = std::fs::read_to_string(&manifest).unwrap();
        assert!(!patched.contains("Cobble.Test.Missing.Framework"));
        assert!(patched.contains("TargetDeviceFamily"));
        // The untouched manifest stays available next to the deployed one.
        let backup = dir.join("AppxManifest.factory.xml");
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), original);

        // The patched manifest is valid for deployment: no phantom dependency left.
        assert!(appx_framework_dependencies(&manifest).is_empty());

        let _ = force_remove_dir_all(&dir);
    }

    #[test]
    fn test_get_bedrock_versions() {
        let versions = get_bedrock_versions();
        assert!(!versions.is_empty());
        assert!(versions.iter().any(|v| v.id.starts_with("1.21")));
    }

    #[test]
    fn test_get_curated_bedrock_content() {
        let content = get_curated_bedrock_content();
        assert!(!content.is_empty());
        assert!(content.iter().any(|c| c.content_type == "shader"));
        assert!(content.iter().any(|c| c.content_type == "mod"));
        assert!(content.iter().any(|c| c.content_type == "resourcepack"));
    }

    #[test]
    fn test_parse_bedrockboot_db_json() {
        let sample_json = r#"{
            "CreationTime": "2026-10-25T00:00:00Z",
            "From_mcappx.com": {
                "1.21.60.25": {
                    "Type": "Preview",
                    "BuildType": "GDK",
                    "ID": "1.21.60.25",
                    "Date": "2025-01-23",
                    "Variations": [
                        {
                            "Arch": "x64",
                            "ArchivalStatus": 3,
                            "OSbuild": "18362",
                            "MetaData": [
                                "http://assets1.xboxlive.cn/4/sample/Microsoft.MinecraftWindowsBeta_1.21.60.25_x64__8wekyb3d8bbwe.msixvc"
                            ],
                            "MD5": "8710a04f17d13850d51c2186d3e7acfd"
                        }
                    ]
                },
                "1.20.15": {
                    "Type": "Release",
                    "BuildType": "UWP",
                    "ID": "1.20.15",
                    "Date": "2023-08-16",
                    "Variations": [
                        {
                            "Arch": "x64",
                            "ArchivalStatus": 3,
                            "OSbuild": "10158",
                            "MetaData": [
                                "985d1ee4-0e9d-49de-9a99-e208adc08d0c"
                            ],
                            "MD5": "d045366edce347cfb7b58c9153014551"
                        }
                    ]
                }
            }
        }"#;

        let parsed = parse_bedrockboot_db_json(sample_json, "McAppx 源");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "1.21.60.25");
        assert_eq!(parsed[0].release_type, "preview");
        assert_eq!(parsed[0].build_type.as_deref(), Some("GDK"));
        assert_eq!(
            parsed[0].md5.as_deref(),
            Some("8710a04f17d13850d51c2186d3e7acfd")
        );
        assert_eq!(parsed[1].id, "1.20.15");
        assert_eq!(parsed[1].release_type, "release");
        assert_eq!(parsed[1].build_type.as_deref(), Some("UWP"));
    }

    #[test]
    fn fe3_url_extraction_handles_plain_and_prefixed_elements() {
        // Shape returned by fe3 `GetExtendedUpdateInfo2` (unprefixed `<Url>`).
        let response = r#"<s:Envelope><s:Body><GetExtendedUpdateInfo2Result>
            <FileLocations>
                <FileLocation><FileDigest>abc=</FileDigest><Url>http://dl.delivery.mp.microsoft.com/filestreamingservice/files/aaaaaaaa-1111</Url></FileLocation>
                <FileLocation><FileDigest>def=</FileDigest><Url>http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/bbbbbbbb-2222?P1=123&amp;P2=404&amp;P3=2&amp;P4=xyz</Url></FileLocation>
            </FileLocations></GetExtendedUpdateInfo2Result></s:Body></s:Envelope>"#;
        let urls = extract_fe3_urls(response);
        assert_eq!(urls.len(), 2);
        assert!(
            urls[1].contains("P1=123&P2=404"),
            "entities decoded: {urls:?}"
        );
        assert!(urls[1].starts_with("http://tlu.dl.delivery.mp.microsoft.com/"));

        // Namespaced spelling must not be missed either.
        let prefixed =
            r#"<FileLocation><a:Url>http://dl.delivery.mp.microsoft.com/x</a:Url></FileLocation>"#;
        assert_eq!(
            extract_fe3_urls(prefixed),
            vec!["http://dl.delivery.mp.microsoft.com/x".to_string()]
        );
        assert!(extract_fe3_urls("<Url></Url>").is_empty());
    }

    #[tokio::test]
    async fn test_resolve_bedrock_candidate_urls_with_xboxlive() {
        let direct_url = "http://assets1.xboxlive.cn/4/sample/Microsoft.Minecraft.msixvc";
        let urls = resolve_bedrock_candidate_urls("1.21.60.25", direct_url).await;
        assert!(urls.len() >= 10);
        assert!(urls.iter().any(|u| u.contains("assets2.xboxlive.cn")));
        assert!(urls.iter().any(|u| u.contains("assets1.xboxlive.com")));
        assert!(urls.iter().any(|u| u.contains("xvcf1.xboxlive.com")));
        // A client package must never fall back to the BDS server zip: that is a
        // second, unusable game download for the same version.
        assert!(!urls.iter().any(|u| u.contains("bedrock-server-")));
    }

    #[tokio::test]
    async fn test_delete_bedrock_version_clears_readonly_and_leftovers() {
        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_bds_delro_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let versions = temp_dir.join("bedrock").join("versions");

        // Read-only files must not block the delete (Windows keeps the flag after
        // extracting a package).
        let core_dir = versions.join("1.26.42");
        std::fs::create_dir_all(core_dir.join("data")).unwrap();
        std::fs::write(core_dir.join("Minecraft.Windows.exe"), b"MZ").unwrap();
        let readonly_file = core_dir.join("data").join("chunk.dll");
        std::fs::write(&readonly_file, b"x").unwrap();
        let mut perms = std::fs::metadata(&readonly_file).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&readonly_file, perms).unwrap();

        // An empty folder left by an aborted download must be deletable too, and
        // it must be reported as a leftover instead of vanishing from the UI.
        let empty_dir = versions.join("9.9.9-empty");
        std::fs::create_dir_all(&empty_dir).unwrap();

        let status = get_bedrock_status(&temp_dir);
        assert_eq!(status.leftover_versions, vec!["9.9.9-empty".to_string()]);
        assert_eq!(status.installed_versions, vec!["1.26.42".to_string()]);

        delete_bedrock_version(&temp_dir, "1.26.42").await.unwrap();
        assert!(!core_dir.exists(), "read-only core should be deleted");

        delete_bedrock_version(&temp_dir, "9.9.9-empty")
            .await
            .unwrap();
        assert!(!empty_dir.exists(), "leftover dir should be deleted");

        let _ = force_remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_delete_bedrock_version_rejects_store_client() {
        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_bds_deluwp_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let error = tokio::runtime::Runtime::new().unwrap().block_on(delete_bedrock_version(&temp_dir, "uwp"))
            .expect_err("the Store client cannot be deleted from the launcher");
        assert!(error.contains("Microsoft Store"), "{error}");
        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn test_delete_bedrock_version_reports_locked_files() {
        use std::os::windows::fs::OpenOptionsExt;

        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_bds_dellock_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let core_dir = temp_dir.join("bedrock").join("versions").join("1.26.42");
        std::fs::create_dir_all(&core_dir).unwrap();
        std::fs::write(core_dir.join("Minecraft.Windows.exe"), b"MZ").unwrap();
        let locked = core_dir.join("locked.dll");
        std::fs::write(&locked, b"locked").unwrap();

        // Holding the file without share mode mimics a running game.
        let held = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&locked)
            .unwrap();

        let error = delete_bedrock_version(&temp_dir, "1.26.42")
            .await
            .expect_err("a locked core must not report success");
        assert!(error.contains("删除目录失败"), "{error}");

        drop(held);
        let _ = force_remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_delete_bedrock_version_and_cache() {
        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_bds_del_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let ver_dir = temp_dir.join("bedrock").join("versions").join("1.26.42");
        let cache_dir = temp_dir.join("bedrock").join("cache");
        std::fs::create_dir_all(&ver_dir).unwrap();
        std::fs::create_dir_all(&cache_dir).unwrap();

        let dummy_zip = cache_dir.join("bedrock-server-1.26.42.zip");
        std::fs::write(&dummy_zip, b"dummy zip residue").unwrap();
        let dummy_exe = ver_dir.join("bedrock_server.exe");
        std::fs::write(&dummy_exe, b"dummy exe").unwrap();

        let res = delete_bedrock_version(&temp_dir, "Minecraft 基岩版 1.26.42").await;
        assert!(
            res.is_ok(),
            "delete_bedrock_version should succeed: {:?}",
            res
        );
        assert!(!ver_dir.exists(), "Version directory should be deleted");
        assert!(!dummy_zip.exists(), "Cache zip residue should be deleted");

        let _ = force_remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_fetch_bedrock_loaders() {
        let catalog = fetch_bedrock_loaders("1.21.132").await;
        assert!(
            !catalog.levilamina.is_empty(),
            "LeviLamina catalog should not be empty"
        );
        assert!(catalog
            .levilamina
            .iter()
            .any(|l| l.loader_type == "levilamina"));
        assert!(
            !catalog.amethyst.is_empty(),
            "Amethyst catalog should not be empty"
        );
    }

    #[test]
    fn test_get_bedrock_mods() {
        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_bds_mods_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let ver_dir = temp_dir.join("bedrock").join("versions").join("1.21.132");
        let mods_dir = ver_dir.join("mods");
        std::fs::create_dir_all(&mods_dir).unwrap();
        std::fs::write(mods_dir.join("test_mod.dll"), b"MZ").unwrap();

        let mods = get_bedrock_mods(&temp_dir, "1.21.132").unwrap();
        assert_eq!(mods.len(), 1);
        assert_eq!(mods[0].name, "test_mod");
        assert_eq!(mods[0].mod_type, "dll_mod");

        let _ = force_remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_bds_versions_index_into_items() {
        let index: BdsVersionsIndex = serde_json::from_str(
            r#"{
                "cdn_root": "https://www.minecraft.net/bedrockdedicatedserver",
                "linux": { "versions": ["9.9.9.9"] },
                "windows": {
                    "stable": "1.26.52.3",
                    "preview": "1.26.70.21",
                    "versions": ["1.26.44.3", "1.26.52.3"],
                    "preview_versions": ["1.26.70.21"]
                }
            }"#,
        )
        .unwrap();

        let items = index.into_items("test");
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].id, "1.26.70.21");
        assert_eq!(items[0].release_type, "preview");
        assert_eq!(items[0].build_type.as_deref(), Some("BDS"));
        assert_eq!(
            items[0].download_url,
            "https://www.minecraft.net/bedrockdedicatedserver/bin-win/bedrock-server-1.26.70.21.zip"
        );
        assert_eq!(items[1].id, "1.26.52.3");
        assert_eq!(items[1].release_type, "release");
        assert_eq!(items[2].id, "1.26.44.3");
    }

    #[test]
    fn test_version_ids_match_uses_dot_boundaries() {
        assert!(version_ids_match("1.26.52", "1.26.52.3"));
        assert!(version_ids_match("1.26.52.3", "1.26.52"));
        assert!(!version_ids_match("1.26.5", "1.26.52.3"));
        assert!(!version_ids_match("1.26.201", "1.26.52.3"));
        assert!(!version_ids_match("", "1.26.52.3"));
    }

    /// The list must hold one entry per version folder. A core whose manifest
    /// reports a longer build number than its folder name used to add a second
    /// row pointing at `versions/<manifest version>`, which never exists.
    #[test]
    fn status_lists_one_row_per_version_folder() {
        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_bds_rows_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let core_dir = temp_dir.join("bedrock").join("versions").join("1.18.3104");
        std::fs::create_dir_all(&core_dir).unwrap();
        std::fs::write(core_dir.join("Minecraft.Windows.exe"), b"MZ").unwrap();
        std::fs::write(
            core_dir.join("version.json"),
            r#"{"id":"1.18.3104.0","name":"Minecraft 基岩版 1.18.3104"}"#,
        )
        .unwrap();

        let status = get_bedrock_status(&temp_dir);
        assert_eq!(status.installed_versions, vec!["1.18.3104".to_string()]);
        assert_eq!(status.version_details.len(), 1);
        // The listed id must resolve to the folder that is actually there.
        assert!(resolve_bedrock_version_dir(&temp_dir, "1.18.3104").is_dir());

        let _ = force_remove_dir_all(&temp_dir);
    }

    /// The package identity of a deployed core decides which
    /// `Packages\<PFN>\LocalState` folder is its data folder. Reading it is what
    /// lets an import reach the game before the game has ever run.
    #[cfg(target_os = "windows")]
    #[test]
    fn local_core_identity_names_reads_the_manifest_identity() {
        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_appx_identity_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let core_dir = temp_dir.join("bedrock").join("versions").join("1.18.3104");
        std::fs::create_dir_all(&core_dir).unwrap();
        std::fs::write(
            core_dir.join("AppxManifest.xml"),
            r#"<?xml version="1.0"?>
<Package>
  <Identity Name="Microsoft.MinecraftUWP" Publisher="CN=Microsoft Corporation" Version="1.18.3104.0" ProcessorArchitecture="x64" />
</Package>"#,
        )
        .unwrap();

        assert_eq!(
            local_core_identity_names(&temp_dir),
            vec!["Microsoft.MinecraftUWP".to_string()]
        );

        let _ = force_remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_inspect_and_get_bedrock_status() {
        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_bds_insp_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));

        // 1. Version with version.json and msixvc
        let v1_dir = temp_dir.join("bedrock").join("versions").join("1.21.60.25");
        std::fs::create_dir_all(&v1_dir).unwrap();
        std::fs::write(
            v1_dir.join("version.json"),
            r#"{"id":"1.21.60.25","name":"Minecraft 基岩版 1.21.60.25","packageFile":"1.21.60.25.msixvc"}"#,
        ).unwrap();
        std::fs::write(v1_dir.join("1.21.60.25.msixvc"), b"dummy msixvc").unwrap();

        // 2. Version with nested subfolder (e.g. bedrock-server-1.21.50/bedrock_server.exe)
        let v2_dir = temp_dir.join("bedrock").join("versions").join("1.21.50");
        let v2_sub = v2_dir.join("bedrock-server-1.21.50");
        std::fs::create_dir_all(&v2_sub).unwrap();
        std::fs::write(v2_sub.join("bedrock_server.exe"), b"dummy bds").unwrap();

        // Check inspection directly
        let insp1 = inspect_bedrock_version_dir(&v1_dir);
        assert!(insp1.is_valid);
        assert_eq!(insp1.version_id, "1.21.60.25");
        assert!(insp1.package_file.is_some());

        let insp2 = inspect_bedrock_version_dir(&v2_dir);
        assert!(insp2.is_valid);
        assert!(insp2.main_executable.is_some());
        assert!(insp2.is_server);

        // Check get_bedrock_status
        let status = get_bedrock_status(&temp_dir);
        assert!(status.standalone_installed);
        assert!(status
            .installed_versions
            .contains(&"1.21.60.25".to_string()));
        assert!(status.installed_versions.contains(&"1.21.50".to_string()));

        let _ = force_remove_dir_all(&temp_dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_uwp_launch_plan_covers_first_launch_cases() {
        // Nothing installed: bootstrap the Store client + Xbox runtime
        assert_eq!(
            plan_uwp_launch(&BedrockRuntimeStatus::default()),
            UwpLaunchPlan::BootstrapClient
        );

        // Client installed but Xbox runtime missing: install deps, then launch
        let client_only = BedrockRuntimeStatus {
            minecraft_uwp_installed: true,
            winget_available: true,
            ..Default::default()
        };
        assert_eq!(
            plan_uwp_launch(&client_only),
            UwpLaunchPlan::InstallDepsThenLaunch
        );

        // Fully provisioned: launch straight away
        let ready = BedrockRuntimeStatus {
            xbox_app_installed: true,
            gaming_services_installed: true,
            minecraft_uwp_installed: true,
            winget_available: true,
            ready: true,
        };
        assert_eq!(plan_uwp_launch(&ready), UwpLaunchPlan::LaunchNow);
    }

    #[test]
    fn test_bedrock_runtime_status_probe() {
        // Real Appx / winget probe must complete and stay internally consistent
        let status = get_bedrock_runtime_status(true);
        eprintln!("bedrock runtime status: {status:?}");
        assert_eq!(
            status.ready,
            status.xbox_app_installed
                && status.gaming_services_installed
                && status.minecraft_uwp_installed
        );

        // Cached reads must return the same snapshot within the cache window
        let cached = get_bedrock_runtime_status(false);
        assert_eq!(cached.ready, status.ready);
        assert_eq!(cached.winget_available, status.winget_available);
    }

    #[test]
    fn offline_accounts_pick_the_bds_core_by_default() {
        let root = std::env::temp_dir().join(format!(
            "cobble_offline_bds_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let versions = root.join("bedrock").join("versions");
        let client = versions.join("1.21.90");
        let bds = versions.join("1.21.50");
        std::fs::create_dir_all(&client).unwrap();
        std::fs::create_dir_all(&bds).unwrap();
        std::fs::write(client.join("Minecraft.Windows.exe"), b"").unwrap();
        std::fs::write(bds.join("bedrock_server.exe"), b"").unwrap();

        // Offline accounts pick the BDS core even though the client is newer.
        let chosen = find_installed_standalone_core(&root, true).unwrap();
        assert_eq!(chosen.3, "1.21.50");
        assert!(chosen.2, "the selected core must be a server core");
        assert_eq!(chosen.0, bds.join("bedrock_server.exe")); // Online-capable accounts keep the newest installed core.
        let newest = find_installed_standalone_core(&root, false).unwrap();
        assert_eq!(newest.3, "1.21.90");
        assert!(!newest.2);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn newest_client_core_prefers_downloaded_client_cores() {
        let root = std::env::temp_dir().join(format!(
            "cobble_client_core_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let versions = root.join("bedrock").join("versions");
        let bds = versions.join("1.21.50");
        let uwp = versions.join("1.21.90");
        let gdk = versions.join("1.26.201");
        std::fs::create_dir_all(&bds).unwrap();
        std::fs::create_dir_all(&uwp).unwrap();
        std::fs::create_dir_all(&gdk).unwrap();
        std::fs::write(bds.join("bedrock_server.exe"), b"").unwrap();
        std::fs::write(uwp.join("Minecraft.Windows.exe"), b"").unwrap();
        std::fs::write(gdk.join("1.26.201.msixvc"), b"dummy").unwrap();
        std::fs::write(
            gdk.join("version.json"),
            r#"{"id":"1.26.201","name":"Minecraft 基岩版 1.26.201","packageFile":"1.26.201.msixvc"}"#,
        )
        .unwrap();

        // A BDS server core is never picked as a client core.
        let chosen = newest_client_core_dir(&root).unwrap();
        assert_eq!(chosen.file_name().unwrap(), "1.26.201");

        std::fs::remove_dir_all(&uwp).unwrap();
        std::fs::remove_dir_all(&gdk).unwrap();
        assert!(newest_client_core_dir(&root).is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn appx_manifest_identity_and_application_id_are_parsed() {
        let dir = std::env::temp_dir().join(format!(
            "cobble_appx_manifest_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = dir.join("AppxManifest.xml");
        std::fs::write(
            &manifest,
            r#"<?xml version="1.0"?>
<Package>
  <Identity Name="Microsoft.MinecraftUWP" Publisher="CN=Microsoft Corporation" Version="1.26.201.0" />
  <Applications>
    <Application Id="App" Executable="Minecraft.Windows.exe" />
  </Applications>
</Package>"#,
        )
        .unwrap();

        assert_eq!(
            appx_identity_attr(&manifest, "Name").as_deref(),
            Some("Microsoft.MinecraftUWP")
        );
        assert_eq!(appx_application_id(&manifest).as_deref(), Some("App"));

        let _ = force_remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod pack_install_tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cobble_pack_{tag}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let file = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, data) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap();
    }

    fn manifest(name: &str, uuid: &str, module_type: &str) -> String {
        format!(
            r#"{{"format_version":2,"header":{{"name":"{name}","description":"d","uuid":"{uuid}","version":[1,0,0]}},"modules":[{{"type":"{module_type}","uuid":"{uuid}","version":[1,0,0]}}]}}"#
        )
    }

    fn nested_mcpack(path: &Path) {
        write_zip(
            path,
            &[
                (
                    "manifest.json",
                    manifest(
                        "Nested RP",
                        "99999999-8888-7777-6666-555555555555",
                        "resources",
                    )
                    .as_bytes(),
                ),
                ("textures/nested.png", b"png"),
            ],
        );
    }

    /// An `.mcaddon` bundling a resource pack and a behavior pack must land in
    /// two different folders, each named after its pack and UUID.
    #[test]
    fn installs_resource_and_behavior_packs_into_their_own_folders() {
        let dir = temp_dir("addon");
        let archive = dir.join("Combined.mcaddon");
        write_zip(
            &archive,
            &[
                (
                    "Combined RP/manifest.json",
                    manifest(
                        "Combined RP",
                        "11111111-2222-3333-4444-555555555555",
                        "resources",
                    )
                    .as_bytes(),
                ),
                ("Combined RP/textures/terrain_texture.json", b"{}"),
                (
                    "Combined BP/manifest.json",
                    manifest(
                        "Combined BP",
                        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                        "data",
                    )
                    .as_bytes(),
                ),
                ("Combined BP/entities/zombie.json", b"{}"),
            ],
        );

        let mojang = dir.join("com.mojang");
        std::fs::create_dir_all(&mojang).unwrap();
        let targets = vec![mojang.clone()];
        let mut outcome = InstalledPacks::default();
        install_archive(&archive, &targets, 0, &mut outcome).unwrap();

        let resource_dir = mojang.join("resource_packs").join("Combined_RP_11111111");
        assert!(
            resource_dir.join("manifest.json").is_file(),
            "resource pack missing at {}",
            resource_dir.display()
        );
        assert!(resource_dir.join("textures/terrain_texture.json").is_file());

        let behavior_dir = mojang.join("behavior_packs").join("Combined_BP_aaaaaaaa");
        assert!(
            behavior_dir.join("manifest.json").is_file(),
            "behavior pack missing at {}",
            behavior_dir.display()
        );
        assert!(behavior_dir.join("entities/zombie.json").is_file());
        assert!(outcome.pack_names.contains(&"Combined RP".to_string()));
        assert!(outcome.pack_names.contains(&"Combined BP".to_string()));
        assert!(outcome.pack_kinds.contains(&"资源包"));
        assert!(outcome.pack_kinds.contains(&"行为包"));

        let _ = force_remove_dir_all(&dir);
    }

    /// One pack installed into several `com.mojang` folders (portable, UWP, GDK)
    /// has one physical copy per folder. Disable/delete must find all of them.
    #[test]
    fn finds_every_copy_of_a_pack_across_data_dirs() {
        let dir = temp_dir("copies");
        let client_a = dir.join("client_a");
        let client_b = dir.join("client_b");
        let uuid = "dedededd-1111-2222-3333-444444444444";

        let enabled_copy = client_a.join("resource_packs").join("Shared_1");
        let disabled_copy = client_b
            .join(DISABLED_PACKS_DIR)
            .join("resource_packs")
            .join("Shared_1");
        for copy in [&enabled_copy, &disabled_copy] {
            std::fs::create_dir_all(copy).unwrap();
            std::fs::write(
                copy.join("manifest.json"),
                manifest("Shared", uuid, "resources"),
            )
            .unwrap();
        }
        // A different pack in the same folders must not be swept up.
        let other = client_a.join("resource_packs").join("Other_1");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(
            other.join("manifest.json"),
            manifest("Other", "ffffffff-1111-2222-3333-444444444444", "resources"),
        )
        .unwrap();

        let copies = pack_copy_paths(&[client_a, client_b], uuid, "resource");
        assert_eq!(
            copies.len(),
            2,
            "both data dirs must be covered: {copies:?}"
        );
        assert!(copies.contains(&enabled_copy));
        assert!(copies.contains(&disabled_copy));

        let _ = force_remove_dir_all(&dir);
    }

    /// `min_engine_version` is what makes the game ignore a perfectly installed
    /// pack, so it must be recorded and reported against the local cores.
    #[test]
    fn records_engine_requirement_and_warns_for_old_cores() {
        let dir = temp_dir("engine");
        let portable = dir.join("bedrock").join("games").join("com.mojang");
        std::fs::create_dir_all(portable.join("resource_packs")).unwrap();
        std::fs::create_dir_all(dir.join("bedrock").join("versions").join("1.18.3104")).unwrap();

        let archive = dir.join("Modern.mcpack");
        let body = r#"{"format_version":2,"header":{"name":"Modern Pack","description":"d","uuid":"12341234-1234-1234-1234-123412341234","version":[3,0,1],"min_engine_version":[1,21,0]},"modules":[{"type":"resources","uuid":"43214321-4321-4321-4321-432143214321","version":[3,0,1]}]}"#;
        write_zip(&archive, &[("manifest.json", body.as_bytes())]);

        let result = install_pack_archive_to(&archive, &[portable.clone()]).unwrap();
        assert_eq!(result.engine_version.as_deref(), Some("1.21.0"));

        let warning = engine_requirement_warning(&dir, result.engine_version.as_deref())
            .expect("1.18 core must be reported as too old");
        assert!(warning.contains("1.21.0"));
        assert!(warning.contains("1.18.3104"));

        let listed = get_bedrock_packs(&dir);
        let pack = listed
            .iter()
            .find(|pack| pack.name == "Modern Pack")
            .expect("installed pack is listed");
        assert_eq!(pack.engine_version.as_deref(), Some("1.21.0"));

        // A new enough core makes the pack loadable again.
        std::fs::create_dir_all(dir.join("bedrock").join("versions").join("1.21.60")).unwrap();
        assert!(engine_requirement_warning(&dir, Some("1.21.0")).is_none());

        let _ = force_remove_dir_all(&dir);
    }

    /// A `.mcaddon` may ship a pack as a nested `.mcpack`; it must be extracted
    /// and installed too, not copied verbatim into the enclosing pack.
    #[test]
    fn installs_nested_mcpack_archives() {
        let dir = temp_dir("nested");
        let nested = dir.join("nested.mcpack");
        nested_mcpack(&nested);
        let nested_bytes = std::fs::read(&nested).unwrap();

        let archive = dir.join("Addon.mcaddon");
        write_zip(
            &archive,
            &[
                (
                    "main/manifest.json",
                    manifest("Main BP", "aaaaaaaa-1111-2222-3333-444444444444", "data").as_bytes(),
                ),
                ("main/entities/a.json", b"{}"),
                ("main/packs/nested.mcpack", &nested_bytes),
            ],
        );

        let mojang = dir.join("com.mojang");
        std::fs::create_dir_all(&mojang).unwrap();
        let mut outcome = InstalledPacks::default();
        install_archive(&archive, &[mojang.clone()], 0, &mut outcome).unwrap();

        let nested_dir = mojang.join("resource_packs").join("Nested_RP_99999999");
        assert!(
            nested_dir.join("textures/nested.png").is_file(),
            "nested pack was not installed at {}",
            nested_dir.display()
        );
        // The nested archive itself must not be left behind inside the pack.
        assert!(!mojang
            .join("behavior_packs")
            .join("Main_BP_aaaaaaaa")
            .join("packs/nested.mcpack")
            .exists());

        let _ = force_remove_dir_all(&dir);
    }

    #[test]
    fn installs_mcworld_into_minecraft_worlds() {
        let dir = temp_dir("world");
        let archive = dir.join("Skyblock.mcworld");
        write_zip(
            &archive,
            &[
                ("Skyblock/level.dat", b"level"),
                ("Skyblock/db/000001.ldb", b"db"),
            ],
        );

        let mojang = dir.join("com.mojang");
        std::fs::create_dir_all(&mojang).unwrap();
        let mut outcome = InstalledPacks::default();
        install_archive(&archive, &[mojang.clone()], 0, &mut outcome).unwrap();

        let world_dir = mojang.join("minecraftWorlds").join("Skyblock");
        assert!(world_dir.join("level.dat").is_file());
        assert!(world_dir.join("db/000001.ldb").is_file());
        assert!(outcome.world_names.contains(&"Skyblock".to_string()));

        let _ = force_remove_dir_all(&dir);
    }

    #[test]
    fn rejects_an_archive_without_manifest() {
        let dir = temp_dir("invalid");
        let archive = dir.join("not-a-pack.mcpack");
        write_zip(&archive, &[("readme.txt", b"hello")]);
        let mojang = dir.join("com.mojang");
        std::fs::create_dir_all(&mojang).unwrap();

        let mut outcome = InstalledPacks::default();
        let err = install_archive(&archive, &[mojang], 0, &mut outcome).unwrap_err();
        assert!(err.contains("manifest.json"), "unexpected error: {err}");

        let _ = force_remove_dir_all(&dir);
    }

    /// Manifest names frequently carry Minecraft colour codes (`§dName`). They
    /// must not end up in the folder name or in the launcher's messages.
    #[test]
    fn strips_formatting_codes_from_pack_names_and_folders() {
        let dir = temp_dir("formatting");
        let archive = dir.join("Colored.mcpack");
        write_zip(
            &archive,
            &[(
                "manifest.json",
                manifest(
                    "§dSlime §7Pack",
                    "11111111-2222-3333-4444-555555555555",
                    "resources",
                )
                .as_bytes(),
            )],
        );

        let mojang = dir.join("com.mojang");
        std::fs::create_dir_all(&mojang).unwrap();
        let mut outcome = InstalledPacks::default();
        install_archive(&archive, &[mojang.clone()], 0, &mut outcome).unwrap();

        assert_eq!(outcome.pack_names, vec!["Slime Pack".to_string()]);
        assert!(mojang
            .join("resource_packs")
            .join("Slime_Pack_11111111")
            .join("manifest.json")
            .is_file());

        let _ = force_remove_dir_all(&dir);
    }

    /// Worlds are listed from `minecraftWorlds`, carry their level name and
    /// icon, and can only be deleted from inside that folder.
    #[test]
    fn world_manager_lists_and_deletes_worlds() {
        let dir = std::env::temp_dir().join(format!(
            "cobble_world_manager_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data_dir = dir.join("bedrock").join("games").join("com.mojang");
        let world_dir = data_dir.join("minecraftWorlds").join("Skyblock123");
        std::fs::create_dir_all(&world_dir).unwrap();
        std::fs::write(world_dir.join("level.dat"), b"nbt").unwrap();
        std::fs::write(world_dir.join("levelname.txt"), "§aSkyblock").unwrap();
        std::fs::write(
            world_dir.join("world_icon.jpeg"),
            [0xFFu8, 0xD8, 0xFF, 0xE0, 0, 0x10],
        )
        .unwrap();

        let worlds = get_bedrock_worlds(&dir);
        let listed = worlds
            .iter()
            .find(|world| world.folder == "Skyblock123")
            .expect("world is listed");
        assert_eq!(listed.name, "Skyblock");
        assert_eq!(listed.location, "启动器便携目录");
        assert!(listed
            .icon
            .as_deref()
            .unwrap_or_default()
            .starts_with("data:image/jpeg;base64,"));

        // A path outside `minecraftWorlds` is refused, not deleted.
        let outside = data_dir.join("resource_packs");
        std::fs::create_dir_all(&outside).unwrap();
        assert!(delete_bedrock_world(&dir, &outside.to_string_lossy()).is_err());
        assert!(outside.is_dir());

        delete_bedrock_world(&dir, &listed.path).unwrap();
        assert!(!world_dir.exists());
        assert!(get_bedrock_worlds(&dir)
            .iter()
            .all(|world| world.folder != "Skyblock123"));

        let _ = force_remove_dir_all(&dir);
    }

    /// The pack manager must read real pack folders (not a Java mods folder),
    /// move them in and out of the disabled container, and only ever touch
    /// paths that live inside a pack folder.
    #[test]
    fn pack_manager_lists_toggles_and_deletes_packs() {
        let dir = std::env::temp_dir().join(format!(
            "cobble_pack_manager_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data_dir = dir.join("bedrock").join("games").join("com.mojang");
        let pack_dir = data_dir.join("resource_packs").join("TestPack_1111");
        std::fs::create_dir_all(&pack_dir).unwrap();
        std::fs::write(
            pack_dir.join("manifest.json"),
            r#"{"format_version":2,"header":{"name":"§aTest Pack","description":"A test pack","uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","version":[1,2,3]},"modules":[{"type":"resources","uuid":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}]}"#,
        )
        .unwrap();
        std::fs::write(
            pack_dir.join("pack_icon.png"),
            [0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
        )
        .unwrap();

        let packs = get_bedrock_packs(&dir);
        let listed = packs
            .iter()
            .find(|pack| pack.id == "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
            .expect("pack is listed");
        assert_eq!(listed.name, "Test Pack");
        assert_eq!(listed.version, "1.2.3");
        assert_eq!(listed.pack_type, "resource");
        assert_eq!(listed.description, "A test pack");
        assert!(listed.enabled);
        assert_eq!(listed.location, "启动器便携目录");
        assert!(listed
            .icon
            .as_deref()
            .unwrap_or_default()
            .starts_with("data:image/png;base64,"));

        set_bedrock_pack_enabled(&dir, &listed.path, false).unwrap();
        let disabled = get_bedrock_packs(&dir)
            .into_iter()
            .find(|pack| pack.id == listed.id)
            .expect("disabled pack stays listed");
        assert!(!disabled.enabled);
        assert!(disabled
            .path
            .replace('\\', "/")
            .contains("cobble_disabled_packs/resource_packs/TestPack_1111"));
        assert!(!pack_dir.exists());

        set_bedrock_pack_enabled(&dir, &disabled.path, true).unwrap();
        assert!(pack_dir.join("manifest.json").is_file());

        delete_bedrock_pack(&dir, &pack_dir.to_string_lossy()).unwrap();
        assert!(!pack_dir.exists());

        // A path outside the scanned pack folders is refused, not deleted.
        let outside = dir.join("bedrock").join("games");
        assert!(delete_bedrock_pack(&dir, &outside.to_string_lossy()).is_err());
        assert!(outside.is_dir());

        let _ = force_remove_dir_all(&dir);
    }

    /// Importing from disk must reuse the same unpacking rules as a download:
    /// the pack lands under `resource_packs` and shows up in the manager.
    #[test]
    fn imports_a_pack_file_from_disk() {
        let dir = std::env::temp_dir().join(format!(
            "cobble_pack_import_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let archive = dir.join("Imported Pack.mcpack");
        write_zip(
            &archive,
            &[(
                "manifest.json",
                manifest(
                    "Imported Pack",
                    "12121212-3434-5656-7878-909090909090",
                    "resources",
                )
                .as_bytes(),
            )],
        );

        // Install into the portable folder explicitly: the production wrapper
        // also targets every installed client, and a test must never write
        // into the real %LOCALAPPDATA% game data.
        let portable = dir.join("bedrock").join("games").join("com.mojang");
        let result = install_pack_archive_to(&archive, &[portable.clone()]).unwrap();
        assert!(result.message.contains("已安装"));
        let pack = get_bedrock_packs(&dir)
            .into_iter()
            .find(|pack| pack.id == "12121212-3434-5656-7878-909090909090")
            .expect("imported pack is listed");
        assert_eq!(pack.pack_type, "resource");
        assert!(pack.enabled);

        // Anything that is not a Bedrock archive is refused before unpacking.
        let text = dir.join("notes.txt");
        std::fs::write(&text, b"not a pack").unwrap();
        assert!(install_bedrock_pack_from_file(&dir, &text.to_string_lossy()).is_err());

        let _ = force_remove_dir_all(&dir);
    }

    /// A pack imported before the client created its data folder only exists
    /// in the portable staging area. The launch sync must copy it where the
    /// game reads, and a pack the user disabled must stay disabled.
    #[test]
    fn syncs_portable_packs_and_worlds_to_client_folders() {
        let dir = std::env::temp_dir().join(format!(
            "cobble_portable_sync_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let portable = dir.join("portable");
        let client = dir.join("client");
        let uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

        let pack_dir = portable.join("resource_packs").join("Staged_Pack");
        std::fs::create_dir_all(&pack_dir).unwrap();
        std::fs::write(
            pack_dir.join("manifest.json"),
            manifest("Staged Pack", uuid, "resources"),
        )
        .unwrap();

        let world_dir = portable.join("minecraftWorlds").join("World123");
        std::fs::create_dir_all(&world_dir).unwrap();
        std::fs::write(world_dir.join("level.dat"), b"nbt").unwrap();
        std::fs::write(world_dir.join("levelname.txt"), "Staged World").unwrap();

        assert_eq!(sync_portable_to_targets(&portable, &[client.clone()]), 2);
        assert!(client
            .join("resource_packs")
            .join("Staged_Pack")
            .join("manifest.json")
            .is_file());
        assert!(client
            .join("minecraftWorlds")
            .join("World123")
            .join("level.dat")
            .is_file());

        // Running again copies nothing (the pack and world already exist).
        assert_eq!(sync_portable_to_targets(&portable, &[client.clone()]), 0);

        // A disabled copy in the client means the user switched it off; the
        // sync must not resurrect it.
        let other_client = dir.join("client2");
        let disabled = other_client
            .join(DISABLED_PACKS_DIR)
            .join("resource_packs")
            .join("Staged_Pack");
        std::fs::create_dir_all(&disabled).unwrap();
        std::fs::write(
            disabled.join("manifest.json"),
            manifest("Staged Pack", uuid, "resources"),
        )
        .unwrap();
        sync_portable_to_targets(&portable, &[other_client.clone()]);
        assert!(!other_client
            .join("resource_packs")
            .join("Staged_Pack")
            .exists());

        let _ = force_remove_dir_all(&dir);
    }

    #[test]
    fn refuses_paths_that_escape_the_pack_folder() {
        assert!(safe_relative_path("../../evil.dll").is_none());
        assert!(safe_relative_path("/etc/passwd").is_some());
        assert_eq!(
            safe_relative_path(r"textures\blocks\stone.png"),
            Some(PathBuf::from("textures/blocks/stone.png"))
        );
    }
}
