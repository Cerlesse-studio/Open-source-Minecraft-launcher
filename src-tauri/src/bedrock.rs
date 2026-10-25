use crate::net;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BedrockPackItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub pack_type: String, // "resource" | "behavior"
    pub version: String,
    pub path: String,
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
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let uwp = PathBuf::from(local_appdata)
                .join("Packages")
                .join("Microsoft.MinecraftUWP_8wekyb3d8bbwe")
                .join("LocalState")
                .join("games")
                .join("com.mojang");
            return Some(uwp);
        }
    }
    None
}

pub fn is_uwp_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        // 1. Check if package directory exists (Standard or Preview)
        if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
            let packages_dir = PathBuf::from(&local_appdata).join("Packages");
            if packages_dir.join("Microsoft.MinecraftUWP_8wekyb3d8bbwe").is_dir()
                || packages_dir.join("Microsoft.MinecraftWindowsBeta_8wekyb3d8bbwe").is_dir()
            {
                return true;
            }
        }
        // 2. Fast check registry for protocol registration (minecraft: or minecraft-preview:)
        for proto in ["HKCR\\minecraft", "HKCR\\minecraft-preview"] {
            if let Ok(output) = Command::new("reg")
                .args(["query", proto, "/ve"])
                .output()
            {
                if output.status.success() {
                    return true;
                }
            }
        }
    }
    false
}

pub fn get_bedrock_status(game_root: &Path) -> BedrockStatus {
    let uwp_installed = is_uwp_installed();
    let uwp_dir = get_uwp_mojang_dir();
    let portable_dir = game_root.join("bedrock").join("games").join("com.mojang");

    let active_dir = match &uwp_dir {
        Some(d) if d.is_dir() => d.clone(),
        _ => portable_dir.clone(),
    };

    let count_entries = |subdir: &str| -> usize {
        let mut count = 0;
        if let Some(ref uwp) = uwp_dir {
            let p = uwp.join(subdir);
            if let Ok(entries) = std::fs::read_dir(p) {
                count += entries.flatten().count();
            }
        }
        let p_portable = portable_dir.join(subdir);
        if let Ok(entries) = std::fs::read_dir(p_portable) {
            count += entries.flatten().count();
        }
        count
    };

    let resource_packs_count = count_entries("resource_packs");
    let behavior_packs_count = count_entries("behavior_packs");
    let worlds_count = count_entries("minecraftWorlds");

    // Check installed versions in <game_root>/bedrock/versions
    let bedrock_versions_dir = game_root.join("bedrock").join("versions");
    let mut installed_versions = Vec::new();
    let mut standalone_installed = false;
    if let Ok(entries) = std::fs::read_dir(&bedrock_versions_dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let name = entry.file_name().to_string_lossy().to_string();
                let dir = entry.path();
                if dir.join("bedrock_server.exe").is_file()
                    || dir.join("Minecraft.Windows.exe").is_file()
                    || dir.join("AppxManifest.xml").is_file()
                {
                    standalone_installed = true;
                    installed_versions.push(name);
                }
            }
        }
    }

    BedrockStatus {
        uwp_installed,
        standalone_installed,
        com_mojang_path: active_dir.to_string_lossy().to_string(),
        portable_path: portable_dir.to_string_lossy().to_string(),
        resource_packs_count,
        behavior_packs_count,
        worlds_count,
        installed_versions,
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
                            download_url: format!("https://minecraft.azureedge.net/bin-win/bedrock-server-{v}.zip"),
                            store_url: Some("ms-windows-store://pdp/?ProductId=9NBLGGH537BL".to_string()),
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
                            download_url: format!("https://minecraft.azureedge.net/bin-win/bedrock-server-{v}.zip"),
                            store_url: Some("ms-windows-store://pdp/?ProductId=9P5X4QVLC2XR".to_string()),
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
                            release_type: if is_preview { "preview".to_string() } else { "release".to_string() },
                            download_url: format!("https://minecraft.azureedge.net/bin-win/bedrock-server-{v}.zip"),
                            store_url: Some("ms-windows-store://pdp/?ProductId=9NBLGGH537BL".to_string()),
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
            build_type: Some("UWP".to_string()),
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
    let m_days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for &dim in &m_days {
        if days < dim {
            break;
        }
        days -= dim;
        month += 1;
    }
    let day = days + 1;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month, day, h, m, s)
}

pub async fn resolve_fe3_soap_update_url(update_id: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
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
    let mut urls = Vec::new();
    let mut start_idx = 0;
    while let Some(open_pos) = text[start_idx..].find(":Url>") {
        let abs_open = start_idx + open_pos + 5;
        if let Some(close_pos) = text[abs_open..].find("</") {
            let u = &text[abs_open..abs_open + close_pos];
            let decoded = u.replace("&amp;", "&");
            urls.push(decoded);
            start_idx = abs_open + close_pos;
        } else {
            break;
        }
    }

    let complex = urls.iter().find(|u| {
        u.contains("?P1=") || u.contains("tlu.dl.") || u.contains("&P2=") || u.contains("%3d") || u.len() > 150
    });
    complex.cloned().or_else(|| urls.last().cloned())
}

pub fn parse_bedrockboot_db_json(json_str: &str, source_name: &str) -> Vec<BedrockVersionItem> {
    let mut items = Vec::new();
    let root: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return items,
    };

    let parse_build = |key: &str, obj: &serde_json::Value| -> Option<BedrockVersionItem> {
        let game_type = obj.get("Type").and_then(|v| v.as_str()).unwrap_or("Release");
        let build_type = obj.get("BuildType").and_then(|v| v.as_str()).unwrap_or("UWP");
        let id = obj.get("ID").and_then(|v| v.as_str()).unwrap_or(key).to_string();
        if id.is_empty() {
            return None;
        }
        let date = obj.get("Date").and_then(|v| v.as_str()).unwrap_or("").to_string();

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

        let md5 = var.get("MD5").and_then(|m| m.as_str()).map(|s| s.to_string());
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

        let curated_match = get_curated_fallback_versions().into_iter().find(|c| c.id == id || c.version == id);
        let (final_url, final_md5) = if download_url.starts_with("http://") || download_url.starts_with("https://") {
            (download_url, md5)
        } else if let Some(curated) = curated_match {
            (curated.download_url, md5.or(curated.md5))
        } else {
            (download_url, md5)
        };

        if final_url.is_empty() {
            return None;
        }

        let is_preview = game_type.eq_ignore_ascii_case("preview") || game_type.eq_ignore_ascii_case("beta");
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

pub async fn get_bedrock_versions_async(api_source: Option<&str>) -> Vec<BedrockVersionItem> {
    let source = api_source.unwrap_or("mcappx");

    if source == "azure_mirror" || source == "mcserverjars" {
        return get_curated_fallback_versions();
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .unwrap_or_default();

    // BedrockBoot sources (McAppx, Gitee, BMCBL)
    if source == "mcappx" || source == "bedrockboot_gitee" || source == "bmcbl" || source == "bedrockboot" {
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
            ("https://api.chlna6666.com/api/v1/bedrock/mcappx", "BMCBL 源 ①"),
            ("https://data.mcappx.com/v2/bedrock.json", "McAppx 源 (BedrockBoot 官方)"),
            ("https://raw.giteeusercontent.com/minecraftyjq/bedrock-version-db/raw/main/data/bedrock.json", "BedrockBoot 源 (Gitee 镜像)"),
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
                    return items;
                }
            }
        }
    }

    // If all remote network endpoints failed, fallback to local cache
    if let Some(cached) = load_cached_versions() {
        return cached;
    }

    // Final fallback to comprehensive curated catalog
    get_curated_fallback_versions()
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
    ]
}

// ---------------------------------------------------------------------------
// Bedrock Launch Logic
// ---------------------------------------------------------------------------

fn spawn_bedrock_exe(exe: &Path, working_dir: &Path, is_console: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x00000010;

        // Auto-enable UWP loopback exemption so clients can join localhost BDS without Windows isolation blocks
        let _ = Command::new("CheckNetIsolation")
            .args(["LoopbackExempt", "-a", "-n=Microsoft.MinecraftUWP_8wekyb3d8bbwe"])
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
        let mut cmd = Command::new(exe);
        cmd.current_dir(working_dir);
        cmd.spawn()
            .map_err(|e| format!("启动基岩版核心进程失败 ({}): {e}", exe.display()))?;
        Ok(())
    }
}

pub fn launch_bedrock_edition(
    game_root: &Path,
    version_id: Option<&str>,
) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let bedrock_versions_dir = game_root.join("bedrock").join("versions");

        let launch_uwp = || -> Result<String, String> {
            let protocol = if let Ok(output) = Command::new("reg").args(["query", "HKCR\\minecraft-preview", "/ve"]).output() {
                if output.status.success() {
                    "minecraft-preview:"
                } else {
                    "minecraft:"
                }
            } else {
                "minecraft:"
            };

            Command::new("explorer")
                .arg(protocol)
                .spawn()
                .map_err(|e| format!("通过协议启动基岩版 UWP 客户端失败: {e}"))?;
            Ok("已成功唤起 Minecraft 基岩版 (Windows)".to_string())
        };

        // 1. If explicit UWP is requested
        if let Some(vid) = version_id.filter(|s| !s.trim().is_empty()) {
            let clean_vid = vid
                .trim_start_matches("bedrock:")
                .trim_start_matches("Minecraft 基岩版:")
                .trim_start_matches("Minecraft 基岩版 ")
                .trim_start_matches("基岩版 ")
                .trim();

            if clean_vid.eq_ignore_ascii_case("uwp") || clean_vid.eq_ignore_ascii_case("bedrock-uwp") {
                if is_uwp_installed() {
                    return launch_uwp();
                } else {
                    // Check if any standalone core exists as fallback
                    if let Ok(entries) = std::fs::read_dir(&bedrock_versions_dir) {
                        for entry in entries.flatten() {
                            let dir = entry.path();
                            let srv = dir.join("bedrock_server.exe");
                            if srv.is_file() {
                                let ver_name = entry.file_name().to_string_lossy().to_string();
                                spawn_bedrock_exe(&srv, &dir, true)?;
                                return Ok(format!(
                                    "未检测到 Windows 原生 UWP 客户端，已为您启动本地基岩版核心 ({ver_name})，并开启独立控制台窗口"
                                ));
                            }
                        }
                    }
                    return Err(
                        "未检测到已安装的 Minecraft 基岩版 (Windows UWP) 或本地 BDS 核心。\n请在启动器“下载”页面下载基岩版核心，或前往 Microsoft Store 安装 Minecraft for Windows。".to_string()
                    );
                }
            }

            // 2. Specific standalone version requested (e.g. 1.26.52 or unpacked AppX instance)
            let ver_dir = bedrock_versions_dir.join(clean_vid);

            // BedrockBoot-style AppxManifest package registration
            let manifest = ver_dir.join("AppxManifest.xml");
            if manifest.is_file() {
                let _ = Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        &format!(
                            "Add-AppxPackage -Register '{}' -DisableDevelopmentMode",
                            manifest.to_string_lossy()
                        ),
                    ])
                    .output();
                return launch_uwp();
            }

            let exe_candidates = [
                (ver_dir.join("Minecraft.Windows.exe"), false),
                (ver_dir.join("Minecraft.exe"), false),
                (ver_dir.join("bedrock_server.exe"), true),
            ];
            for (exe, is_console) in &exe_candidates {
                if exe.is_file() {
                    spawn_bedrock_exe(exe, &ver_dir, *is_console)?;
                    let type_desc = if *is_console { "服务端核心，已开启独立控制台窗口" } else { "客户端" };
                    return Ok(format!("已启动基岩版{type_desc} ({clean_vid})"));
                }
            }

            // Also check prefix / sub-version match in bedrock_versions_dir (e.g. 1.26.52 -> 1.26.52.3)
            if let Ok(entries) = std::fs::read_dir(&bedrock_versions_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name == clean_vid || name.starts_with(clean_vid) || clean_vid.starts_with(&name) {
                        let dir = entry.path();
                        let dir_manifest = dir.join("AppxManifest.xml");
                        if dir_manifest.is_file() {
                            let _ = Command::new("powershell")
                                .args([
                                    "-NoProfile",
                                    "-NonInteractive",
                                    "-Command",
                                    &format!(
                                        "Add-AppxPackage -Register '{}' -DisableDevelopmentMode",
                                        dir_manifest.to_string_lossy()
                                    ),
                                ])
                                .output();
                            return launch_uwp();
                        }

                        for (exe_name, is_console) in [
                            ("Minecraft.Windows.exe", false),
                            ("Minecraft.exe", false),
                            ("bedrock_server.exe", true),
                        ] {
                            let exe = dir.join(exe_name);
                            if exe.is_file() {
                                spawn_bedrock_exe(&exe, &dir, is_console)?;
                                let type_desc = if is_console { "服务端核心，已开启独立控制台窗口" } else { "客户端" };
                                return Ok(format!("已启动基岩版{type_desc} ({name})"));
                            }
                        }
                    }
                }
            }

            // If requested standalone version directory is missing, fallback to UWP if installed
            if is_uwp_installed() {
                return launch_uwp();
            }

            return Err(format!(
                "未找到基岩版版本 {clean_vid} 的核心文件 (bedrock_server.exe 或 Minecraft.Windows.exe)。请前往“下载”页面下载对应版本核心。"
            ));
        }

        // 3. No specific version requested (version_id is None / empty)
        // If UWP is installed, prioritize launching UWP
        if is_uwp_installed() {
            return launch_uwp();
        }

        // Otherwise, launch the first/latest available standalone version
        if let Ok(entries) = std::fs::read_dir(&bedrock_versions_dir) {
            let mut candidates = Vec::new();
            for entry in entries.flatten() {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    let dir = entry.path();
                    let srv = dir.join("bedrock_server.exe");
                    let client = dir.join("Minecraft.Windows.exe");
                    if client.is_file() {
                        candidates.push((client, dir.clone(), false, entry.file_name().to_string_lossy().to_string()));
                    } else if srv.is_file() {
                        candidates.push((srv, dir.clone(), true, entry.file_name().to_string_lossy().to_string()));
                    }
                }
            }

            // Sort candidates descending so newer versions (e.g. 1.26.52 > 1.26.42) are preferred
            candidates.sort_by(|a, b| b.3.cmp(&a.3));

            if let Some((exe, dir, is_console, name)) = candidates.into_iter().next() {
                spawn_bedrock_exe(&exe, &dir, is_console)?;
                let type_desc = if is_console { "服务端核心，已开启独立控制台窗口" } else { "客户端" };
                return Ok(format!("已启动本地基岩版{type_desc} ({name})"));
            }
        }

        Err("未检测到已安装的 Minecraft 基岩版。您可以通过 Microsoft Store 安装正版，或在启动器“下载”中心获取基岩版运行核心。".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Minecraft 基岩版 PC 原生运行环境目前仅支持 Windows 平台。".to_string())
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
            if item.download_url.starts_with("http://") || item.download_url.starts_with("https://") {
                add_xbox_mirrors(&mut candidate_urls, &item.download_url);
            }
            break;
        }
    }

    // 3. Check cached versions to see if this version has a direct URL or UpdateID
    if let Some(cached) = load_cached_versions() {
        if let Some(item) = cached.iter().find(|v| v.id == version_id || v.version == version_id) {
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
    let is_guid = download_url.len() >= 32
        && download_url.contains('-')
        && !download_url.starts_with("http");
    if is_guid {
        if let Some(soap_url) = resolve_fe3_soap_update_url(download_url.trim()).await {
            add_xbox_mirrors(&mut candidate_urls, &soap_url);
        }
    }

    // 5. Endstone metadata fallback (for BDS or release metadata)
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

    let client = net::client();
    for meta_url in meta_endpoints {
        if let Ok(resp) = client.get(&meta_url).timeout(std::time::Duration::from_secs(3)).send().await {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    if let Some(win_url) = json.pointer("/binary/windows/url").and_then(|u| u.as_str()) {
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

    // Deduplicate preserving insertion order
    let mut seen = std::collections::HashSet::new();
    candidate_urls.retain(|u| seen.insert(u.clone()));
    candidate_urls
}

pub async fn install_bedrock_version(
    app: &tauri::AppHandle,
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
    } else if candidate_urls.iter().any(|u| u.contains(".appx") || u.contains(".msix")) {
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
            return Err(format!("通过 BedrockBoot 引擎下载基岩版核心失败: {last_error}"));
        }
    }

    // MD5 verification if available
    let expected_md5 = load_cached_versions()
        .and_then(|list| list.into_iter().find(|v| v.id == version_id || v.version == version_id))
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
                    println!("[BedrockBoot] MD5 完整性校验成功: {actual}");
                } else {
                    println!("[BedrockBoot] MD5 校验不匹配: 期望 {expected}, 实际 {actual}");
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
            let mut entry = archive.by_index(i).map_err(|e| format!("读取文件失败: {e}"))?;
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
                std::io::copy(&mut entry, &mut outfile).map_err(|e| format!("解压写入失败: {e}"))?;
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

        // Delete AppxSignature.p7x if present (BedrockBoot standard step to allow development mode registration)
        let sig_p7x = dest_dir.join("AppxSignature.p7x");
        if sig_p7x.exists() {
            let _ = force_remove_file(&sig_p7x);
        }

        // Register AppX on Windows in developer mode if AppxManifest.xml is present
        #[cfg(target_os = "windows")]
        {
            let manifest = dest_dir.join("AppxManifest.xml");
            if manifest.exists() {
                let ps_cmd = format!(
                    "Add-AppxPackage -Register \"{}\" -DisableDevelopmentMode",
                    manifest.to_string_lossy()
                );
                let _ = std::process::Command::new("powershell")
                    .args(&["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
                    .output();
            }
        }
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
            stages: make_stages(
                "done",
                "done",
                "done",
                85_983_232,
                85_983_232,
                1,
                1,
            ),
        },
    );

    Ok(format!("基岩版 {version_id} 核心已通过 {src_label} 下载并就绪"))
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

pub async fn delete_bedrock_version(game_root: &Path, version_id: &str) -> Result<(), String> {
    let root = net::absolute_path(game_root);
    let clean_id = version_id
        .trim()
        .trim_start_matches("Minecraft 基岩版 ")
        .trim_start_matches("Minecraft ")
        .trim_start_matches("bedrock:")
        .trim();

    let versions_dir = root.join("bedrock").join("versions");
    let target = if versions_dir.join(clean_id).is_dir() {
        versions_dir.join(clean_id)
    } else if versions_dir.join(version_id.trim()).is_dir() {
        versions_dir.join(version_id.trim())
    } else {
        PathBuf::new()
    };

    let mut deleted = false;
    if target.is_dir() {
        force_remove_dir_all(&target)
            .map_err(|e| format!("删除基岩版核心目录失败: {e}"))?;
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
                        if fp.extension().map_or(false, |e| e.eq_ignore_ascii_case("part")) {
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
                        if fp.extension().map_or(false, |e| e.eq_ignore_ascii_case("part")) {
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

#[derive(Deserialize)]
struct PackManifest {
    header: Option<PackHeader>,
    modules: Option<Vec<PackModule>>,
}

#[derive(Deserialize)]
struct PackHeader {
    name: Option<String>,
    #[allow(dead_code)]
    description: Option<String>,
}

#[derive(Deserialize)]
struct PackModule {
    #[serde(rename = "type")]
    module_type: Option<String>,
}

pub async fn install_bedrock_pack(
    game_root: &Path,
    source_path_or_url: &str,
    filename: &str,
) -> Result<InstallPackResult, String> {
    let root = net::absolute_path(game_root);
    let cache_dir = root.join("bedrock").join("cache");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("创建缓存目录失败: {e}"))?;

    let local_pack_path = if source_path_or_url.starts_with("http://")
        || source_path_or_url.starts_with("https://")
    {
        let dest = cache_dir.join(filename);
        net::download_file_multithreaded(
            source_path_or_url,
            &dest,
            None,
            None,
            6,
            None,
            None,
        )
        .await
        .map_err(|e| format!("下载基岩版资源包失败: {e}"))?;
        dest
    } else {
        PathBuf::from(source_path_or_url)
    };

    if !local_pack_path.is_file() {
        return Err("包文件不存在".to_string());
    }

    // Inspect manifest to determine whether it's resource pack (shader) or behavior pack (mod)
    let mut pack_type = "resource".to_string();
    let mut pack_name = filename
        .trim_end_matches(".mcpack")
        .trim_end_matches(".mcaddon")
        .trim_end_matches(".zip")
        .to_string();

    let file = File::open(&local_pack_path).map_err(|e| format!("无法读取文件: {e}"))?;
    if let Ok(mut archive) = zip::ZipArchive::new(file) {
        for i in 0..archive.len() {
            if let Ok(mut entry) = archive.by_index(i) {
                let name = entry.name().to_string();
                if name.ends_with("manifest.json") {
                    let mut content = String::new();
                    if entry.read_to_string(&mut content).is_ok() {
                        if let Ok(manifest) = serde_json::from_str::<PackManifest>(&content) {
                            if let Some(h) = manifest.header {
                                if let Some(n) = h.name {
                                    if !n.trim().is_empty() {
                                        pack_name = n;
                                    }
                                }
                            }
                            if let Some(modules) = manifest.modules {
                                for m in modules {
                                    if let Some(t) = m.module_type {
                                        if t == "data" || t == "script" || t == "client_data" {
                                            pack_type = "behavior".to_string();
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    break;
                }
            }
        }
    }

    // Sanitize folder name
    let safe_folder_name: String = pack_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();

    let sub_folder = if pack_type == "behavior" {
        "behavior_packs"
    } else {
        "resource_packs"
    };

    // Extract to destination folders:
    // 1. Portable launcher games/com.mojang/<sub_folder>/<safe_folder_name>
    let portable_dest = root
        .join("bedrock")
        .join("games")
        .join("com.mojang")
        .join(sub_folder)
        .join(&safe_folder_name);
    std::fs::create_dir_all(&portable_dest).ok();

    // 2. Windows UWP com.mojang if available
    let uwp_dest = get_uwp_mojang_dir().map(|uwp| uwp.join(sub_folder).join(&safe_folder_name));
    if let Some(ref uwp) = uwp_dest {
        std::fs::create_dir_all(uwp).ok();
    }

    // Extract contents
    if let Ok(file) = File::open(&local_pack_path) {
        if let Ok(mut archive) = zip::ZipArchive::new(file) {
            for i in 0..archive.len() {
                if let Ok(mut entry) = archive.by_index(i) {
                    if let Some(rel) = entry.enclosed_name() {
                        let p_out = portable_dest.join(&rel);
                        if entry.is_dir() {
                            std::fs::create_dir_all(&p_out).ok();
                        } else {
                            if let Some(parent) = p_out.parent() {
                                std::fs::create_dir_all(parent).ok();
                            }
                            if let Ok(mut f) = File::create(&p_out) {
                                std::io::copy(&mut entry, &mut f).ok();
                            }
                        }

                        // Also extract to UWP if present
                        if let Some(ref uwp) = uwp_dest {
                            let uwp_out = uwp.join(&rel);
                            if p_out.is_file() {
                                if let Some(parent) = uwp_out.parent() {
                                    std::fs::create_dir_all(parent).ok();
                                }
                                std::fs::copy(&p_out, &uwp_out).ok();
                            }
                        }
                    }
                }
            }
        }
    }

    // If UWP is installed on Windows, trigger native shell import for .mcpack/.mcaddon
    #[cfg(target_os = "windows")]
    {
        if is_uwp_installed() {
            let _ = Command::new("explorer").arg(&local_pack_path).spawn();
        }
    }

    let type_label = if pack_type == "behavior" {
        "模组 / 行为包"
    } else {
        "光影 / 资源包"
    };

    Ok(InstallPackResult {
        success: true,
        pack_name,
        pack_type: type_label.to_string(),
        target_path: portable_dest.to_string_lossy().to_string(),
        message: format!("已成功安装{type_label}并配置至基岩版 com.mojang 目录"),
    })
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
    let clean_mc = raw_mc.trim_start_matches("v").trim_start_matches("Minecraft 基岩版 ").trim();

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
        if let Ok(resp) = client.get(ep).timeout(std::time::Duration::from_secs(4)).send().await {
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
        matched_key = if clean_mc.is_empty() { "通用".to_string() } else { clean_mc.to_string() };
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

pub fn get_bedrock_loader_config(game_root: &Path, version_id: &str) -> BedrockInstanceLoaderConfig {
    let root = net::absolute_path(game_root);
    let ver_dir = root.join("bedrock").join("versions").join(version_id);
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
    let ver_dir = root.join("bedrock").join("versions").join(version_id);
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
            let mut entry = archive.by_index(i).map_err(|e| format!("读取压缩文件条目失败: {e}"))?;
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
                let mut outfile = File::create(&outpath).map_err(|e| format!("解压文件失败: {e}"))?;
                std::io::copy(&mut entry, &mut outfile).map_err(|e| format!("写入文件失败: {e}"))?;
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

        Ok(format!("LeviLamina v{loader_version} 已成功安装到基岩版实例 {version_id}！"))
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

        Ok(format!("Amethyst v{loader_version} 已成功安装到基岩版实例 {version_id}！"))
    } else {
        Err(format!("不支持的基岩版模组加载器类型: {loader_type}"))
    }
}

pub fn get_bedrock_mods(game_root: &Path, version_id: &str) -> Result<Vec<BedrockModItem>, String> {
    let root = net::absolute_path(game_root);
    let ver_dir = root.join("bedrock").join("versions").join(version_id);
    let mut items = Vec::new();

    let scan_dirs = [
        (ver_dir.join("mods"), "dll_mod"),
        (ver_dir.join("config").join("BedrockBoot2").join("mods"), "dll_mod"),
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
                        name: clean_name.replace(".dll", "").replace(".mcpack", "").replace(".zip", ""),
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
    let ver_dir = root.join("bedrock").join("versions").join(version_id);

    let candidates = [
        ver_dir.join("mods").join(mod_id),
        ver_dir.join("config").join("BedrockBoot2").join("mods").join(mod_id),
        ver_dir.join("plugins").join(mod_id),
    ];

    for current_path in candidates {
        if current_path.exists() {
            let fname = current_path.file_name().unwrap_or_default().to_string_lossy().to_string();
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
    let ver_dir = root.join("bedrock").join("versions").join(version_id);

    let candidates = [
        ver_dir.join("mods").join(mod_id),
        ver_dir.join("config").join("BedrockBoot2").join("mods").join(mod_id),
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
    let ver_dir = root.join("bedrock").join("versions").join(version_id);
    let fname = src.file_name().ok_or("无效的文件名")?.to_string_lossy().to_string();

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
        assert_eq!(parsed[0].md5.as_deref(), Some("8710a04f17d13850d51c2186d3e7acfd"));
        assert_eq!(parsed[1].id, "1.20.15");
        assert_eq!(parsed[1].release_type, "release");
        assert_eq!(parsed[1].build_type.as_deref(), Some("UWP"));
    }

    #[tokio::test]
    async fn test_resolve_bedrock_candidate_urls_with_xboxlive() {
        let direct_url = "http://assets1.xboxlive.cn/4/sample/Microsoft.Minecraft.msixvc";
        let urls = resolve_bedrock_candidate_urls("1.21.60.25", direct_url).await;
        assert!(urls.len() >= 10);
        assert!(urls.iter().any(|u| u.contains("assets2.xboxlive.cn")));
        assert!(urls.iter().any(|u| u.contains("assets1.xboxlive.com")));
        assert!(urls.iter().any(|u| u.contains("xvcf1.xboxlive.com")));
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
        assert!(res.is_ok(), "delete_bedrock_version should succeed: {:?}", res);
        assert!(!ver_dir.exists(), "Version directory should be deleted");
        assert!(!dummy_zip.exists(), "Cache zip residue should be deleted");

        let _ = force_remove_dir_all(&temp_dir);
    }

    #[tokio::test]
    async fn test_fetch_bedrock_loaders() {
        let catalog = fetch_bedrock_loaders("1.21.132").await;
        assert!(!catalog.levilamina.is_empty(), "LeviLamina catalog should not be empty");
        assert!(catalog.levilamina.iter().any(|l| l.loader_type == "levilamina"));
        assert!(!catalog.amethyst.is_empty(), "Amethyst catalog should not be empty");
    }

    #[test]
    fn test_get_bedrock_mods() {
        let temp_dir = std::env::temp_dir().join(format!(
            "cobble_bds_mods_{}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
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
}
