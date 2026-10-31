use crate::java::{self, JavaProgressFn};
use crate::net;
use futures_util::future::try_join_all;
use md5::{Digest as Md5Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const VERSION_MANIFEST_URL: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub const BETACRAFT_MANIFEST_URL: &str =
    "https://files.betacraft.uk/launcher/v2/assets/version_manifest_v2.json";
pub const RESOURCES_URL: &str = "https://resources.download.minecraft.net";
pub const LIBRARIES_URL: &str = "https://libraries.minecraft.net";

pub type ProgressFn = Arc<dyn Fn(InstallProgress) + Send + Sync>;

// ---------------------------------------------------------------------------
// Manifest / metadata types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionManifest {
    pub latest: LatestVersions,
    pub versions: Vec<VersionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatestVersions {
    pub release: String,
    pub snapshot: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub url: String,
    pub time: Option<String>,
    pub release_time: Option<String>,
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub installed_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mc_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optifine_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fabric_api_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveDownloadTask {
    pub worker_id: usize,
    pub name: String,
    pub stage: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub segments: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageProgress {
    pub stage: String,
    pub label: String,
    pub status: String,
    pub done_files: u64,
    pub total_files: u64,
    pub done_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub version_id: String,
    pub stage: String,
    pub done: u64,
    pub total: u64,
    pub detail: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub threads: usize,
    pub active_threads: usize,
    pub skipped_files: u64,
    pub retried_files: u64,
    pub active_tasks: Vec<ActiveDownloadTask>,
    pub stages: Vec<StageProgress>,
}

impl InstallProgress {
    pub fn basic(
        version_id: impl Into<String>,
        stage: impl Into<String>,
        done: u64,
        total: u64,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            version_id: version_id.into(),
            stage: stage.into(),
            done,
            total,
            detail: detail.into(),
            downloaded_bytes: 0,
            total_bytes: 0,
            speed_bps: 0,
            threads: 1,
            active_threads: 0,
            skipped_files: 0,
            retried_files: 0,
            active_tasks: Vec::new(),
            stages: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub version_id: String,
    pub version_type: String,
    pub libraries: usize,
    pub assets: usize,
    pub java_major: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionDetail {
    pub id: String,
    #[serde(rename = "type", default)]
    pub version_type: Option<String>,
    #[serde(rename = "mainClass")]
    pub main_class: String,
    #[serde(default)]
    pub libraries: Vec<Library>,
    #[serde(rename = "assetIndex")]
    pub asset_index: Option<AssetIndexRef>,
    pub assets: Option<String>,
    #[serde(rename = "javaVersion")]
    pub java_version: Option<JavaVersion>,
    pub downloads: Option<VersionDownloads>,
    pub arguments: Option<Arguments>,
    #[serde(rename = "minecraftArguments")]
    pub minecraft_arguments: Option<String>,
    pub logging: Option<Logging>,
    #[serde(rename = "inheritsFrom")]
    pub inherits_from: Option<String>,
    #[serde(
        rename = "clientVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub mc_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
    #[serde(
        rename = "loaderVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub loader_version: Option<String>,
    #[serde(
        rename = "optifineVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub optifine_version: Option<String>,
    #[serde(
        rename = "fabricApiVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub fabric_api_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JavaVersion {
    #[serde(rename = "majorVersion")]
    pub major_version: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionDownloads {
    pub client: Option<Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetIndexRef {
    pub id: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub total_size: Option<u64>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Arguments {
    #[serde(default)]
    pub game: Vec<ArgumentValue>,
    #[serde(default)]
    pub jvm: Vec<ArgumentValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Library {
    pub name: String,
    pub downloads: Option<LibraryDownloads>,
    pub natives: Option<HashMap<String, String>>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryDownloads {
    pub artifact: Option<Artifact>,
    #[serde(default, deserialize_with = "deserialize_classifiers")]
    pub classifiers: Option<HashMap<String, Artifact>>,
}

/// Betacraft's patched version JSONs store a `__comment` string inside
/// `downloads.classifiers` (1.6.x ARM natives). Keep only well-formed artifact
/// objects so the whole version still parses.
fn deserialize_classifiers<'de, D>(
    deserializer: D,
) -> Result<Option<HashMap<String, Artifact>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<HashMap<String, serde_json::Value>>::deserialize(deserializer)?;
    Ok(raw.map(|entries| {
        entries
            .into_iter()
            .filter_map(|(name, value)| {
                serde_json::from_value::<Artifact>(value)
                    .ok()
                    .map(|artifact| (name, artifact))
            })
            .collect()
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub path: Option<String>,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub action: String,
    #[serde(default)]
    pub os: Option<OsRule>,
    #[serde(default)]
    pub features: Option<HashMap<String, bool>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsRule {
    pub name: Option<String>,
    pub arch: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Logging {
    pub client: Option<LoggingClient>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoggingClient {
    pub argument: Option<String>,
    pub file: Option<LogFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogFile {
    pub id: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetIndex {
    #[serde(default)]
    pub objects: HashMap<String, AssetObject>,
    #[serde(rename = "virtual", default)]
    pub virtual_: bool,
    #[serde(rename = "map_to_resources", default)]
    pub map_to_resources: bool,
}

impl AssetIndex {
    fn is_virtual(&self) -> bool {
        self.virtual_ || self.map_to_resources
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AssetObject {
    pub hash: String,
    pub size: u64,
    /// Betacraft indexes point pruned legacy assets at their own mirror
    /// (`https://resources.betacraft.uk/..`), which Mojang's CDN no longer serves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone)]
struct FileJob {
    url: String,
    dest: PathBuf,
    sha1: Option<String>,
    size: Option<u64>,
    verify_existing: bool,
}

#[derive(Default, Clone)]
struct LibraryPlan {
    jobs: Vec<FileJob>,
    classpath: Vec<PathBuf>,
    native_jars: Vec<PathBuf>,
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

fn os_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86" => "x86",
        "x86_64" => "x86_64",
        "aarch64" => "arm64",
        _ => "x86_64",
    }
}

fn rule_matches(rule: &Rule, features: &HashMap<String, bool>) -> bool {
    if let Some(os) = &rule.os {
        if let Some(name) = &os.name {
            if name != os_name() && !(name == "osx" && cfg!(target_os = "macos")) {
                return false;
            }
        }
        if let Some(arch) = &os.arch {
            if arch != os_arch() {
                return false;
            }
        }
        if let Some(version) = &os.version {
            if !os_version_matches(version) {
                return false;
            }
        }
    }
    if let Some(required) = &rule.features {
        for (key, value) in required {
            if features.get(key).copied().unwrap_or(false) != *value {
                return false;
            }
        }
    }
    true
}

#[cfg(not(target_os = "windows"))]
fn os_version_matches(_pattern: &str) -> bool {
    // Only Windows currently uses os.version rules in vanilla Minecraft.
    true
}

#[cfg(target_os = "windows")]
fn os_version_matches(pattern: &str) -> bool {
    // Rules only use simple patterns like "^10\\." or "^1\\.".
    let trimmed = pattern.trim_start_matches('^').trim_end_matches('\\');
    let trimmed = trimmed.trim_end_matches('.');
    if trimmed.is_empty() {
        return true;
    }
    // Cobble supports Windows 10 and 11; there is no need to shell out to
    // read the exact build number for the handful of rules that use this.
    trimmed == "10" || trimmed == "11" || trimmed.starts_with("10")
}

fn rules_allow(rules: &[Rule], features: &HashMap<String, bool>) -> bool {
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        if rule_matches(rule, features) {
            allowed = rule.action == "allow";
        }
    }
    allowed
}

// ---------------------------------------------------------------------------
// Paths & manifest
// ---------------------------------------------------------------------------

fn versions_dir(root: &Path) -> PathBuf {
    root.join("versions")
}

fn version_dir(root: &Path, id: &str) -> PathBuf {
    versions_dir(root).join(id)
}

fn assets_dir(root: &Path) -> PathBuf {
    root.join("assets")
}

fn libraries_dir(root: &Path) -> PathBuf {
    root.join("libraries")
}

fn safe_version_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.contains(':')
        || trimmed.contains('*')
        || trimmed.contains('?')
        || trimmed.contains('"')
        || trimmed.contains('<')
        || trimmed.contains('>')
        || trimmed.contains('|')
    {
        return Err("版本或文件夹名称包含非法字符".to_string());
    }
    Ok(())
}

pub async fn fetch_manifest(root: &Path, force: bool) -> Result<VersionManifest, String> {
    let root = net::absolute_path(root);
    let root = root.as_path();
    let cache = root.join("meta").join("version_manifest_v2.json");

    // The manifest is a large, slowly changing download. Serve a local copy
    // immediately; the version library's refresh button forces a fresh one.
    if !force {
        if let Ok(text) = tokio::fs::read_to_string(&cache).await {
            if let Ok(manifest) = serde_json::from_str::<VersionManifest>(&text) {
                return Ok(manifest);
            }
        }
    }

    let fetched = async {
        // Respect the selected mirror and keep the automatic fallback chain.
        let manifest_urls = net::preferred_urls(VERSION_MANIFEST_URL);
        let mut last_err = String::new();
        for u in manifest_urls {
            match net::client()
                .get(&u)
                .timeout(Duration::from_secs(4))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => {
                    if let Ok(text) = response.text().await {
                        if let Ok(manifest) = serde_json::from_str::<VersionManifest>(&text) {
                            return Ok::<_, String>((manifest, text));
                        }
                    }
                }
                Ok(response) => {
                    last_err = format!("HTTP {}", response.status());
                }
                Err(e) => {
                    last_err = e.to_string();
                }
            }
        }
        Err(format!("版本清单请求失败: {last_err}"))
    }
    .await;

    match fetched {
        Ok((manifest, text)) => {
            if let Some(parent) = cache.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = tokio::fs::write(&cache, text).await;
            Ok(manifest)
        }
        Err(error) => {
            if let Ok(text) = tokio::fs::read_to_string(&cache).await {
                if let Ok(manifest) = serde_json::from_str::<VersionManifest>(&text) {
                    return Ok(manifest);
                }
            }
            Err(error)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BetaCraftManifest {
    pub trim_at: Option<String>,
    #[serde(default)]
    pub versions: Vec<BetaCraftVersionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BetaCraftVersionSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub url: String,
    pub time: Option<String>,
    pub release_time: Option<String>,
    pub phase: Option<String>,
    pub protocol_version: Option<serde_json::Value>,
}

pub async fn fetch_betacraft_manifest(root: &Path, force: bool) -> Result<VersionManifest, String> {
    let root = net::absolute_path(root);
    let root = root.as_path();
    let cache = root.join("meta").join("betacraft_version_manifest_v2.json");

    if !force {
        if let Ok(text) = tokio::fs::read_to_string(&cache).await {
            if let Ok(manifest) = serde_json::from_str::<VersionManifest>(&text) {
                return Ok(manifest);
            }
        }
    }

    let fetched = async {
        let response = net::client()
            .get(BETACRAFT_MANIFEST_URL)
            .send()
            .await
            .map_err(|e| format!("无法连接 BetaCraft 版本服务: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "BetaCraft 版本清单请求失败: HTTP {}",
                response.status()
            ));
        }
        let text = response
            .text()
            .await
            .map_err(|e| format!("读取 BetaCraft 版本清单失败: {e}"))?;
        let raw: BetaCraftManifest =
            serde_json::from_str(&text).map_err(|e| format!("BetaCraft 版本清单解析失败: {e}"))?;

        let versions: Vec<VersionSummary> = raw
            .versions
            .into_iter()
            .map(|v| {
                let phase_str = v.phase.clone().unwrap_or_else(|| "legacy".to_string());
                let mapped_type = match phase_str.as_str() {
                    "beta" => "old_beta".to_string(),
                    "alpha" | "infdev" | "indev" | "classic" | "pre-classic" => {
                        "old_alpha".to_string()
                    }
                    "oddballs" => "april_fools".to_string(),
                    "post-1.0" => v.version_type.clone(),
                    _ => v.version_type.clone(),
                };
                VersionSummary {
                    id: v.id,
                    version_type: mapped_type,
                    url: v.url,
                    time: v.time,
                    release_time: v.release_time,
                    sha1: None,
                    phase: v.phase,
                    source: Some("betacraft".to_string()),
                }
            })
            .collect();

        let manifest = VersionManifest {
            latest: LatestVersions {
                release: "1.7.10".to_string(),
                snapshot: "b1.8.1".to_string(),
            },
            versions,
        };
        Ok::<_, String>(manifest)
    }
    .await;

    match fetched {
        Ok(manifest) => {
            if let Some(parent) = cache.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            if let Ok(serialized) = serde_json::to_string(&manifest) {
                let _ = tokio::fs::write(&cache, serialized).await;
            }
            Ok(manifest)
        }
        Err(error) => {
            if let Ok(text) = tokio::fs::read_to_string(&cache).await {
                if let Ok(manifest) = serde_json::from_str::<VersionManifest>(&text) {
                    return Ok(manifest);
                }
            }
            Err(error)
        }
    }
}

fn game_dir(root: &Path, id: &str) -> PathBuf {
    version_dir(root, id)
}

pub fn list_installed(root: &Path) -> Result<Vec<InstalledVersion>, String> {
    let root = net::absolute_path(root);
    let dir = versions_dir(&root);
    let mut result = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(result),
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        let dir = entry.path();
        let json_path = if dir.join(format!("{id}.json")).is_file() {
            dir.join(format!("{id}.json"))
        } else if dir.join("version.json").is_file() {
            dir.join("version.json")
        } else {
            continue;
        };
        let parsed_detail = std::fs::read_to_string(&json_path)
            .ok()
            .and_then(|text| serde_json::from_str::<VersionDetail>(&text).ok());
        let jar_exists = dir.join(format!("{id}.jar")).is_file()
            || std::fs::read_dir(&dir)
                .map(|mut it| {
                    it.any(|e| {
                        e.map(|e| {
                            e.path()
                                .extension()
                                .and_then(|x| x.to_str())
                                .map(|x| x == "jar")
                                .unwrap_or(false)
                        })
                        .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
            || parsed_detail
                .as_ref()
                .and_then(|d| d.inherits_from.as_ref())
                .map(|parent| {
                    versions_dir(&root)
                        .join(parent)
                        .join(format!("{parent}.jar"))
                        .is_file()
                })
                .unwrap_or(false);
        if !jar_exists {
            continue;
        }
        let version_type = parsed_detail
            .as_ref()
            .and_then(|detail| detail.version_type.clone())
            .unwrap_or_else(|| "release".to_string());
        let mc_version = parsed_detail
            .as_ref()
            .and_then(|d| d.mc_version.clone())
            .or_else(|| parsed_detail.as_ref().and_then(|d| d.inherits_from.clone()));
        let (loader, loader_version) = if parsed_detail
            .as_ref()
            .and_then(|d| d.loader.clone())
            .is_some()
        {
            (
                parsed_detail.as_ref().and_then(|d| d.loader.clone()),
                parsed_detail
                    .as_ref()
                    .and_then(|d| d.loader_version.clone()),
            )
        } else {
            let mut detected = (None, None);
            if let Some(detail) = &parsed_detail {
                for lib in &detail.libraries {
                    if lib.name.starts_with("net.minecraftforge:forge:") {
                        let parts: Vec<&str> = lib.name.split(':').collect();
                        if parts.len() >= 3 {
                            let fver = parts[2];
                            let lver = fver.split('-').nth(1).unwrap_or(fver);
                            detected = (Some("forge".to_string()), Some(lver.to_string()));
                            break;
                        }
                    } else if lib.name.starts_with("net.neoforged:neoforge:") {
                        let parts: Vec<&str> = lib.name.split(':').collect();
                        if parts.len() >= 3 {
                            detected = (Some("neoforge".to_string()), Some(parts[2].to_string()));
                            break;
                        }
                    } else if lib.name.starts_with("net.fabricmc:fabric-loader:") {
                        let parts: Vec<&str> = lib.name.split(':').collect();
                        if parts.len() >= 3 {
                            detected = (Some("fabric".to_string()), Some(parts[2].to_string()));
                            break;
                        }
                    }
                }
            }
            detected
        };
        let optifine_version = parsed_detail
            .as_ref()
            .and_then(|d| d.optifine_version.clone());
        let fabric_api_version = parsed_detail
            .as_ref()
            .and_then(|d| d.fabric_api_version.clone());
        let installed_at = std::fs::metadata(&json_path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        result.push(InstalledVersion {
            id,
            version_type,
            installed_at,
            mc_version,
            loader,
            loader_version,
            optifine_version,
            fabric_api_version,
        });
    }
    result.sort_by(|a, b| b.installed_at.cmp(&a.installed_at));
    Ok(result)
}

pub async fn delete_version(root: &Path, version_id: &str) -> Result<(), String> {
    let clean_id = version_id.trim().trim_start_matches("Minecraft ").trim();
    safe_version_id(clean_id)?;
    let root = net::absolute_path(root);
    let target = versions_dir(&root).join(clean_id);
    if target.is_dir() {
        crate::bedrock::force_remove_dir_all(&target)
            .map_err(|e| format!("删除版本目录失败: {e}"))?;
        Ok(())
    } else {
        Err(format!("版本目录不存在: {}", target.display()))
    }
}

fn required_java_major(version: &VersionDetail) -> u32 {
    version
        .java_version
        .as_ref()
        .and_then(|j| j.major_version)
        .unwrap_or(8)
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async fn load_version(root: &Path, summary: &VersionSummary) -> Result<VersionDetail, String> {
    safe_version_id(&summary.id)?;
    let cache_dir = root.join("meta").join("versions");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("无法创建版本缓存目录: {e}"))?;
    let json_path = cache_dir.join(format!("{}.json", summary.id));

    if let Ok(text) = tokio::fs::read_to_string(&json_path).await {
        if let Ok(detail) = serde_json::from_str::<VersionDetail>(&text) {
            if detail.id == summary.id {
                return Ok(detail);
            }
        }
    }

    net::download_file(
        &summary.url,
        &json_path,
        summary.sha1.as_deref(),
        None,
        None,
    )
    .await
    .map_err(|e| format!("下载版本信息失败: {e}"))?;

    let text = tokio::fs::read_to_string(&json_path)
        .await
        .map_err(|e| format!("读取版本信息失败: {e}"))?;
    let detail: VersionDetail =
        serde_json::from_str(&text).map_err(|e| format!("版本信息解析失败: {e}"))?;
    Box::pin(resolve_inherits_from(root, detail)).await
}

pub fn library_conflict_key(lib: &Library) -> String {
    let base = lib.name.split('@').next().unwrap_or(&lib.name);
    let parts: Vec<&str> = base.split(':').collect();
    let group = parts.first().copied().unwrap_or("");
    let artifact = parts.get(1).copied().unwrap_or("");
    let classifier = parts.get(3).copied().unwrap_or("");
    let has_natives_map = lib.natives.as_ref().map(|n| !n.is_empty()).unwrap_or(false);
    format!(
        "{group}:{artifact}:{classifier}:{}",
        if has_natives_map { "natives" } else { "jar" }
    )
}

fn native_library_matches_current_arch(name: &str) -> bool {
    if !name.contains(":natives-") {
        return true;
    }
    #[cfg(target_arch = "x86_64")]
    {
        if name.contains("-x86") && !name.contains("x86_64") {
            return false;
        }
        if name.contains("-arm64") || name.contains("-aarch64") {
            return false;
        }
    }
    #[cfg(target_arch = "x86")]
    {
        if name.contains("-arm64") || name.contains("-aarch64") || name.contains("x86_64") {
            return false;
        }
    }
    #[cfg(target_arch = "aarch64")]
    {
        if name.contains("-x86") {
            return false;
        }
    }
    true
}

pub async fn resolve_inherits_from(
    root: &Path,
    mut version: VersionDetail,
) -> Result<VersionDetail, String> {
    let Some(parent_id) = version.inherits_from.clone() else {
        return Ok(version);
    };

    // 1. Try local versions/<parent_id>/<parent_id>.json
    let parent_json_path = version_dir(root, &parent_id).join(format!("{parent_id}.json"));
    let parent_text = if let Ok(text) = tokio::fs::read_to_string(&parent_json_path).await {
        text
    } else {
        // 2. Try meta/versions/<parent_id>.json or meta/versions/<parent_id>/<parent_id>.json
        let meta_flat = root
            .join("meta")
            .join("versions")
            .join(format!("{parent_id}.json"));
        let meta_nested = root
            .join("meta")
            .join("versions")
            .join(&parent_id)
            .join(format!("{parent_id}.json"));
        if let Ok(text) = tokio::fs::read_to_string(&meta_flat).await {
            text
        } else if let Ok(text) = tokio::fs::read_to_string(&meta_nested).await {
            text
        } else {
            // 3. Fetch from manifest
            let manifest = fetch_manifest(root, false).await?;
            let summary = manifest
                .versions
                .iter()
                .find(|v| v.id == parent_id)
                .ok_or_else(|| format!("无法找到父版本 {parent_id}"))?;
            let detail = Box::pin(load_version(root, summary)).await?;
            serde_json::to_string(&detail).map_err(|e| e.to_string())?
        }
    };

    let parent_detail: VersionDetail = serde_json::from_str(&parent_text)
        .map_err(|e| format!("解析父版本 {parent_id} 配置失败: {e}"))?;

    // Recursively resolve in case the parent also inherits
    let parent_detail = Box::pin(resolve_inherits_from(root, parent_detail)).await?;

    if version.asset_index.is_none() {
        version.asset_index = parent_detail.asset_index;
    }
    if version.assets.is_none() {
        version.assets = parent_detail.assets;
    }
    if version.downloads.is_none() {
        version.downloads = parent_detail.downloads;
    }
    if version.java_version.is_none() {
        version.java_version = parent_detail.java_version;
    }
    if version.mc_version.is_none() {
        version.mc_version = parent_detail.mc_version.or(Some(parent_id.clone()));
    }
    if version.logging.is_none() {
        version.logging = parent_detail.logging;
    }

    // Merge arguments:
    if let Some(parent_args) = parent_detail.arguments {
        let child_args = version.arguments.get_or_insert_with(|| Arguments {
            game: Vec::new(),
            jvm: Vec::new(),
        });
        // JVM arguments: parent JVM args first, then child JVM args (matching merge_profile_into_version)
        let mut combined_jvm = parent_args.jvm;
        combined_jvm.extend(child_args.jvm.drain(..));
        child_args.jvm = combined_jvm;

        // Game arguments: parent game args (standard Mojang args) followed by child args
        let mut combined_game = parent_args.game;
        combined_game.extend(child_args.game.drain(..));
        child_args.game = combined_game;
    } else if version.arguments.is_none() {
        version.arguments = parent_detail.arguments;
    }

    if version.minecraft_arguments.is_none() {
        version.minecraft_arguments = parent_detail.minecraft_arguments;
    }

    // Combine libraries: child libraries come first, then parent libraries (dedup by group:artifact:classifier:natives)
    let mut combined = Vec::new();
    let mut child_keys = std::collections::HashSet::new();
    for lib in version.libraries {
        let key = library_conflict_key(&lib);
        if child_keys.insert(key) {
            combined.push(lib);
        }
    }
    for plib in parent_detail.libraries {
        let key = library_conflict_key(&plib);
        if !child_keys.contains(&key) {
            combined.push(plib);
        }
    }
    version.libraries = combined;

    Ok(version)
}

fn classifier_for(lib: &Library) -> Option<String> {
    let natives = lib.natives.as_ref()?;
    let key = natives
        .get(os_name())
        .or_else(|| natives.get("windows").filter(|_| cfg!(windows)))?;
    let arch = if cfg!(target_arch = "x86") {
        "32"
    } else {
        "64"
    };
    Some(key.replace("${arch}", arch))
}

fn maven_artifact_from_name(name: &str) -> Option<(String, String, String, String)> {
    let (base, extension) = match name.split_once('@') {
        Some((base, ext)) => (base, ext.to_string()),
        None => (name, "jar".to_string()),
    };
    let parts: Vec<&str> = base.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let group = parts[0];
    let artifact = parts[1];
    let version = parts[2];
    let classifier = parts.get(3).copied();
    let group_path = group.replace('.', "/");
    let mut file_name = format!("{artifact}-{version}");
    if let Some(classifier) = classifier {
        file_name.push('-');
        file_name.push_str(classifier);
    }
    file_name.push('.');
    file_name.push_str(&extension);
    let rel = format!("{group_path}/{artifact}/{version}/{file_name}");
    let url = if group.starts_with("net.minecraftforge") {
        format!("https://maven.minecraftforge.net/{rel}")
    } else if group.starts_with("net.neoforged") {
        format!("https://maven.neoforged.net/releases/{rel}")
    } else if group.starts_with("net.fabricmc") {
        format!("https://maven.fabricmc.net/{rel}")
    } else if group.starts_with("org.quiltmc") {
        format!("https://maven.quiltmc.org/repository/release/{rel}")
    } else {
        format!("{LIBRARIES_URL}/{rel}")
    };
    Some((
        rel,
        url,
        file_name,
        classifier.unwrap_or_default().to_string(),
    ))
}

fn artifact_job(artifact: &Artifact, base: &Path, name: &str) -> Option<FileJob> {
    let path = artifact
        .path
        .clone()
        .or_else(|| maven_artifact_from_name(name).map(|(rel, _, _, _)| rel))?;

    // Check if the library is a local generated target (e.g. Forge :client or :server)
    if name.contains(":client") || name.contains(":server") {
        let is_empty_url = artifact
            .url
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty();
        if is_empty_url
            || name.starts_with("net.minecraftforge:forge:")
            || name.starts_with("net.neoforged:neoforge:")
        {
            return None;
        }
    }

    let raw_url = artifact.url.as_deref().unwrap_or("").trim();
    let url = if !raw_url.is_empty() {
        raw_url.to_string()
    } else if artifact.url.is_none() {
        let (_, default_url, _, _) = maven_artifact_from_name(name)?;
        default_url
    } else {
        return None;
    };

    Some(FileJob {
        url,
        dest: base.join(path),
        sha1: artifact.sha1.clone(),
        size: artifact.size,
        verify_existing: true,
    })
}

fn plan_libraries(
    root: &Path,
    version: &VersionDetail,
    features: &HashMap<String, bool>,
) -> LibraryPlan {
    let mut plan = LibraryPlan::default();
    let libraries = libraries_dir(root);
    let mut seen = HashSet::new();
    let mut seen_ga = HashSet::new();

    for lib in &version.libraries {
        if !rules_allow(&lib.rules, features) || !native_library_matches_current_arch(&lib.name) {
            continue;
        }

        let downloads = lib.downloads.as_ref();
        let mut native_jar = None;
        let ga_key = {
            let base = lib.name.split('@').next().unwrap_or(&lib.name);
            let parts: Vec<&str> = base.split(':').collect();
            format!(
                "{}:{}:{}",
                parts.first().copied().unwrap_or(""),
                parts.get(1).copied().unwrap_or(""),
                parts.get(3).copied().unwrap_or("")
            )
        };

        if let Some(classifier) = classifier_for(lib) {
            if let Some(artifact) = downloads
                .and_then(|d| d.classifiers.as_ref())
                .and_then(|c| c.get(&classifier))
            {
                if let Some(job) = artifact_job(artifact, &libraries, &lib.name) {
                    native_jar = Some(job.dest.clone());
                    plan.jobs.push(job);
                }
            }
        }

        if let Some(artifact) = downloads.and_then(|d| d.artifact.as_ref()) {
            if seen_ga.insert(ga_key) {
                let path = artifact
                    .path
                    .clone()
                    .or_else(|| maven_artifact_from_name(&lib.name).map(|(rel, _, _, _)| rel));
                if let Some(rel) = path {
                    let dest = libraries.join(rel);
                    if seen.insert(dest.clone()) {
                        plan.classpath.push(dest);
                    }
                }
                if let Some(job) = artifact_job(artifact, &libraries, &lib.name) {
                    plan.jobs.push(job);
                }
            }
        } else if downloads.is_none() {
            if let Some((rel, default_url, _, classifier)) = maven_artifact_from_name(&lib.name) {
                if seen_ga.insert(ga_key) {
                    let dest = libraries.join(&rel);
                    let url = match lib.url.as_deref() {
                        Some(repo) if !repo.trim().is_empty() => {
                            let trimmed = repo.trim_end_matches('/');
                            if trimmed.ends_with(".jar") {
                                trimmed.to_string()
                            } else {
                                format!("{trimmed}/{rel}")
                            }
                        }
                        _ => default_url,
                    };
                    if seen.insert(dest.clone()) {
                        plan.classpath.push(dest.clone());
                        plan.jobs.push(FileJob {
                            url,
                            dest,
                            sha1: lib.sha1.clone(),
                            size: lib.size,
                            verify_existing: lib.sha1.is_some(),
                        });
                        if !classifier.is_empty() && classifier.starts_with("natives-") {
                            native_jar = Some(libraries.join(rel));
                        }
                    }
                }
            }
        }

        // 1.19+ ships natives as separate libraries named `...:natives-windows`.
        if lib.name.contains(":natives-") {
            if let Some(artifact) = downloads.and_then(|d| d.artifact.as_ref()) {
                if let Some(job) = artifact_job(artifact, &libraries, &lib.name) {
                    native_jar = Some(job.dest.clone());
                    if let Some(existing) = plan.jobs.iter().find(|j| j.dest == job.dest) {
                        let _ = existing;
                    } else {
                        plan.jobs.push(job);
                    }
                }
            }
        }

        if let Some(path) = native_jar {
            if !plan.native_jars.contains(&path) {
                plan.native_jars.push(path);
            }
        }
    }

    // Keep classpath order stable, drop duplicates.
    let mut seen_paths = HashSet::new();
    plan.classpath.retain(|p| seen_paths.insert(p.clone()));
    plan
}

pub const DEFAULT_DOWNLOAD_THREADS: usize = 16;

struct DownloadTracker {
    version_id: String,
    threads: usize,
    started_at: Instant,
    progress: ProgressFn,
    network_bytes: AtomicU64,
    skipped_files: AtomicU64,
    retried_files: AtomicU64,
    active_tasks: Mutex<HashMap<usize, ActiveDownloadTask>>,
    stages: Mutex<Vec<StageProgress>>,
    speed_samples: Mutex<VecDeque<(Instant, u64)>>,
    last_emit: Mutex<Instant>,
}

impl DownloadTracker {
    fn new(version_id: &str, threads: usize, has_addons: bool, progress: ProgressFn) -> Arc<Self> {
        let now = Instant::now();
        let mut stages = vec![
            StageProgress {
                stage: "prepare".to_string(),
                label: "解析版本与资源清单".to_string(),
                status: "active".to_string(),
                done_files: 0,
                total_files: if has_addons { 4 } else { 3 },
                done_bytes: 0,
                total_bytes: 0,
            },
            StageProgress {
                stage: "client".to_string(),
                label: "客户端核心 Jar".to_string(),
                status: "pending".to_string(),
                done_files: 0,
                total_files: 1,
                done_bytes: 0,
                total_bytes: 0,
            },
            StageProgress {
                stage: "libraries".to_string(),
                label: "运行依赖库与原生库".to_string(),
                status: "pending".to_string(),
                done_files: 0,
                total_files: 0,
                done_bytes: 0,
                total_bytes: 0,
            },
            StageProgress {
                stage: "assets".to_string(),
                label: "游戏资源与音频文件".to_string(),
                status: "pending".to_string(),
                done_files: 0,
                total_files: 0,
                done_bytes: 0,
                total_bytes: 0,
            },
        ];
        if has_addons {
            stages.push(StageProgress {
                stage: "addons".to_string(),
                label: "模组加载器与附加工具".to_string(),
                status: "pending".to_string(),
                done_files: 0,
                total_files: 1,
                done_bytes: 0,
                total_bytes: 0,
            });
        }
        let mut samples = VecDeque::with_capacity(32);
        samples.push_back((now, 0));
        Arc::new(Self {
            version_id: version_id.to_string(),
            threads: threads.clamp(1, 64),
            started_at: now,
            progress,
            network_bytes: AtomicU64::new(0),
            skipped_files: AtomicU64::new(0),
            retried_files: AtomicU64::new(0),
            active_tasks: Mutex::new(HashMap::new()),
            stages: Mutex::new(stages),
            speed_samples: Mutex::new(samples),
            last_emit: Mutex::new(now - Duration::from_secs(1)),
        })
    }

    fn set_stage_plan(&self, stage_id: &str, total_files: u64, total_bytes: u64) {
        if let Ok(mut stages) = self.stages.lock() {
            if let Some(s) = stages.iter_mut().find(|s| s.stage == stage_id) {
                s.total_files = total_files;
                s.total_bytes = total_bytes;
            }
        }
    }

    fn set_stage_status(&self, stage_id: &str, status: &str) {
        if let Ok(mut stages) = self.stages.lock() {
            if let Some(s) = stages.iter_mut().find(|s| s.stage == stage_id) {
                s.status = status.to_string();
                if status == "done" {
                    s.done_files = s.total_files;
                    s.done_bytes = s.total_bytes.max(s.done_bytes);
                }
            }
        }
    }

    fn add_stage_completed(&self, stage_id: &str, files: u64, bytes: u64) -> (u64, u64) {
        if let Ok(mut stages) = self.stages.lock() {
            if let Some(s) = stages.iter_mut().find(|s| s.stage == stage_id) {
                s.done_files = (s.done_files + files).min(s.total_files.max(s.done_files + files));
                s.done_bytes += bytes;
                if s.total_bytes < s.done_bytes {
                    s.total_bytes = s.done_bytes;
                }
                return (s.done_files, s.total_files);
            }
        }
        (0, 0)
    }

    fn set_worker_task(&self, worker_id: usize, task: Option<ActiveDownloadTask>) {
        if let Ok(mut map) = self.active_tasks.lock() {
            match task {
                Some(t) => {
                    map.insert(worker_id, t);
                }
                None => {
                    map.remove(&worker_id);
                }
            }
        }
    }

    fn update_worker_bytes(&self, worker_id: usize, done_bytes: u64, total_bytes: u64, delta: u64) {
        if delta > 0 {
            self.network_bytes.fetch_add(delta, Ordering::Relaxed);
        }
        if let Ok(mut map) = self.active_tasks.lock() {
            if let Some(task) = map.get_mut(&worker_id) {
                task.done_bytes = done_bytes;
                if total_bytes > 0 {
                    task.total_bytes = total_bytes;
                }
            }
        }
    }

    fn sample_speed(&self) -> u64 {
        let now = Instant::now();
        let net_total = self.network_bytes.load(Ordering::Relaxed);
        let Ok(mut samples) = self.speed_samples.lock() else {
            return 0;
        };
        samples.push_back((now, net_total));
        let window = Duration::from_millis(2000);
        while samples.len() > 2 {
            if let Some((front_time, _)) = samples.front() {
                if now.duration_since(*front_time) > window {
                    samples.pop_front();
                } else {
                    break;
                }
            }
        }
        if let Some((oldest_time, oldest_bytes)) = samples.front() {
            let elapsed = now.duration_since(*oldest_time).as_secs_f64();
            let diff = net_total.saturating_sub(*oldest_bytes);
            if elapsed >= 0.08 && diff > 0 {
                return (diff as f64 / elapsed) as u64;
            }
        }
        let total_elapsed = now.duration_since(self.started_at).as_secs_f64();
        if total_elapsed >= 0.1 && net_total > 0 {
            (net_total as f64 / total_elapsed) as u64
        } else {
            0
        }
    }

    fn build_snapshot(
        &self,
        stage: &str,
        done: u64,
        total: u64,
        detail: String,
    ) -> InstallProgress {
        let mut active_list: Vec<ActiveDownloadTask> = self
            .active_tasks
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default();
        active_list.sort_by_key(|t| t.worker_id);

        let active_threads = active_list
            .iter()
            .map(|t| (t.segments as usize).max(1))
            .sum::<usize>()
            .min(self.threads);

        let mut stages_snapshot = self.stages.lock().map(|s| s.clone()).unwrap_or_default();

        // Include in-flight bytes of active tasks in their corresponding stage snapshot.
        for s in &mut stages_snapshot {
            let in_flight: u64 = active_list
                .iter()
                .filter(|t| t.stage == s.stage)
                .map(|t| t.done_bytes)
                .sum();
            let effective = s.done_bytes + in_flight;
            s.done_bytes = if s.total_bytes > 0 {
                effective.min(s.total_bytes)
            } else {
                effective
            };
        }

        let downloaded_bytes: u64 = stages_snapshot.iter().map(|s| s.done_bytes).sum();
        let total_bytes: u64 = stages_snapshot.iter().map(|s| s.total_bytes).sum();
        let speed_bps = self.sample_speed();
        active_list.truncate(32);

        InstallProgress {
            version_id: self.version_id.clone(),
            stage: stage.to_string(),
            done,
            total,
            detail,
            downloaded_bytes,
            total_bytes: total_bytes.max(downloaded_bytes),
            speed_bps,
            threads: self.threads,
            active_threads,
            skipped_files: self.skipped_files.load(Ordering::Relaxed),
            retried_files: self.retried_files.load(Ordering::Relaxed),
            active_tasks: active_list,
            stages: stages_snapshot,
        }
    }

    fn emit_now(&self, stage: &str, done: u64, total: u64, detail: impl Into<String>) {
        if let Ok(mut last) = self.last_emit.lock() {
            *last = Instant::now();
        }
        let snapshot = self.build_snapshot(stage, done, total, detail.into());
        (self.progress)(snapshot);
    }

    fn emit_throttled(&self, stage: &str, done: u64, total: u64, detail: impl Into<String>) {
        let should_emit = if let Ok(mut last) = self.last_emit.lock() {
            if last.elapsed() >= Duration::from_millis(90) {
                *last = Instant::now();
                true
            } else {
                false
            }
        } else {
            false
        };
        if should_emit {
            let snapshot = self.build_snapshot(stage, done, total, detail.into());
            (self.progress)(snapshot);
        }
    }
}

async fn download_jobs_with_tracker(
    jobs: Vec<FileJob>,
    stage: &str,
    tracker: &Arc<DownloadTracker>,
    concurrency: usize,
    worker_offset: usize,
) -> Result<(u64, u64), String> {
    let total = jobs.len() as u64;
    tracker.set_stage_status(stage, "active");

    if total == 0 {
        tracker.set_stage_status(stage, "done");
        tracker.emit_now(stage, 0, 0, "无需下载");
        return Ok((0, 0));
    }

    let done = Arc::new(AtomicU64::new(0));
    let skipped = Arc::new(AtomicU64::new(0));
    let queue = Arc::new(Mutex::new(VecDeque::from(jobs)));
    let worker_count = concurrency.clamp(1, 64).min(total as usize).max(1);

    let mut workers = Vec::with_capacity(worker_count);
    for idx in 1..=worker_count {
        let worker_id = worker_offset + idx;
        let queue = queue.clone();
        let tracker = tracker.clone();
        let done = done.clone();
        let skipped = skipped.clone();
        let stage = stage.to_string();

        workers.push(async move {
            loop {
                let job = {
                    let mut guard = queue.lock().map_err(|_| "下载队列状态异常".to_string())?;
                    guard.pop_front()
                };
                let Some(job) = job else {
                    break;
                };

                let name = job
                    .dest
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();

                let mut was_skipped = false;
                if net::looks_complete(&job.dest, job.size) {
                    was_skipped = true;
                    if job.verify_existing {
                        if let Some(expected) = &job.sha1 {
                            if !expected.is_empty() {
                                match net::sha1_file(&job.dest).await {
                                    Ok(actual) if actual.eq_ignore_ascii_case(expected) => {}
                                    _ => {
                                        was_skipped = false;
                                    }
                                }
                            }
                        }
                    }
                }

                let file_bytes: u64;
                if !was_skipped {
                    let file_threads = if job.size.unwrap_or(0) >= 1_048_576 {
                        (worker_count / 2).clamp(2, 6)
                    } else {
                        1
                    };
                    let segments = net::recommended_segments(job.size, file_threads);
                    tracker.set_worker_task(
                        worker_id,
                        Some(ActiveDownloadTask {
                            worker_id,
                            name: name.clone(),
                            stage: stage.clone(),
                            done_bytes: 0,
                            total_bytes: job.size.unwrap_or(0),
                            segments,
                        }),
                    );

                    let tracker_ref = tracker.clone();
                    let stage_ref = stage.clone();
                    let name_ref = name.clone();
                    let done_ref = done.clone();
                    let mut on_progress = move |done_b: u64, total_b: u64, delta: u64| {
                        tracker_ref.update_worker_bytes(worker_id, done_b, total_b, delta);
                        let current_done = done_ref.load(Ordering::Relaxed);
                        tracker_ref.emit_throttled(
                            &stage_ref,
                            current_done,
                            total,
                            name_ref.clone(),
                        );
                    };

                    let downloaded_res = net::download_file_with_mirrors(
                        &job.url,
                        &job.dest,
                        job.sha1.as_deref(),
                        job.size,
                        file_threads,
                        Some(&tracker.retried_files),
                        Some(&mut on_progress),
                    )
                    .await;

                    tracker.set_worker_task(worker_id, None);
                    file_bytes = downloaded_res?;
                } else {
                    skipped.fetch_add(1, Ordering::Relaxed);
                    tracker.skipped_files.fetch_add(1, Ordering::Relaxed);
                    file_bytes = job
                        .size
                        .or_else(|| std::fs::metadata(&job.dest).ok().map(|m| m.len()))
                        .unwrap_or(0);
                }

                let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                tracker.add_stage_completed(&stage, 1, file_bytes);

                if finished == total {
                    tracker.emit_now(&stage, finished, total, name);
                } else {
                    tracker.emit_throttled(&stage, finished, total, name);
                }
            }
            Ok::<(), String>(())
        });
    }

    if let Err(err) = try_join_all(workers).await {
        tracker.set_stage_status(stage, "error");
        return Err(err);
    }

    tracker.set_stage_status(stage, "done");
    tracker.emit_now(stage, total, total, "完成");

    Ok((
        done.load(Ordering::Relaxed),
        skipped.load(Ordering::Relaxed),
    ))
}

fn extract_natives(jars: &[PathBuf], natives_dir: &Path) -> Result<usize, String> {
    if natives_dir.exists() {
        std::fs::remove_dir_all(natives_dir).map_err(|e| format!("无法清理 natives 目录: {e}"))?;
    }
    std::fs::create_dir_all(natives_dir).map_err(|e| format!("无法创建 natives 目录: {e}"))?;

    let mut count = 0;
    for jar in jars {
        let file = match std::fs::File::open(jar) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let mut archive = match zip::ZipArchive::new(file) {
            Ok(archive) => archive,
            Err(_) => continue,
        };
        for i in 0..archive.len() {
            let mut entry = match archive.by_index(i) {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            if name.starts_with("META-INF/")
                || name.contains("..")
                || name.ends_with(".git")
                || name.ends_with(".sha1")
            {
                continue;
            }
            let lower_name = name.to_lowercase();
            #[cfg(target_arch = "x86_64")]
            if (lower_name.contains("/x86/") && !lower_name.contains("/x86_64/"))
                || lower_name.contains("/arm64/")
                || lower_name.contains("/aarch64/")
            {
                continue;
            }
            #[cfg(target_arch = "aarch64")]
            if lower_name.contains("/x86/")
                || lower_name.contains("/x64/")
                || lower_name.contains("/x86_64/")
            {
                continue;
            }
            let Some(file_name) = Path::new(&name).file_name() else {
                continue;
            };
            let dest = natives_dir.join(file_name);
            let Ok(mut out) = std::fs::File::create(&dest) else {
                continue;
            };
            if std::io::copy(&mut entry, &mut out).is_ok() {
                count += 1;
            }
        }
    }
    Ok(count)
}

async fn copy_asset_tree(
    objects: &HashMap<String, AssetObject>,
    objects_dir: &Path,
    dest: &Path,
) -> Result<(), String> {
    let objects = objects.clone();
    let objects_dir = objects_dir.to_path_buf();
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建资源目录: {e}"))?;
        for (name, object) in objects {
            if name.contains("..") || name.starts_with('/') {
                continue;
            }
            let source = objects_dir.join(&object.hash[0..2]).join(&object.hash);
            let target = dest.join(&name);
            if target.is_file() {
                continue;
            }
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("无法创建资源目录: {e}"))?;
            }
            if std::fs::hard_link(&source, &target).is_err() {
                std::fs::copy(&source, &target).map_err(|e| format!("无法复制资源 {name}: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("整理资源任务失败: {e}"))?
}

struct PreparedAssets {
    index_id: String,
    index: AssetIndex,
    jobs: Vec<FileJob>,
    total_bytes: u64,
}

/// Object URL for an asset index entry. Betacraft indexes carry an explicit
/// per-object URL for assets Mojang pruned from its CDN; using the official
/// resources host for those returns HTTP 404 mid-install.
fn asset_object_url(hash: &str, object: &AssetObject) -> String {
    if let Some(url) = object.url.as_deref() {
        if url.starts_with("http://") || url.starts_with("https://") {
            return url.to_string();
        }
    }
    let prefix = hash.get(0..2).unwrap_or("00");
    format!("{RESOURCES_URL}/{prefix}/{hash}")
}

async fn prepare_assets_plan(
    root: &Path,
    version: &VersionDetail,
) -> Result<Option<PreparedAssets>, String> {
    let Some(index_ref) = &version.asset_index else {
        return Ok(None);
    };
    let indexes = assets_dir(root).join("indexes");
    tokio::fs::create_dir_all(&indexes)
        .await
        .map_err(|e| format!("无法创建资源索引目录: {e}"))?;
    let index_path = indexes.join(format!("{}.json", index_ref.id));

    // Betacraft rewrites the indexes it serves (pruned assets get their own
    // mirror URL), so the sha1/size recorded in the version JSON describe
    // Mojang's original file and never match. Verifying them would both fail
    // the install and re-download the index on every attempt.
    let patched_index = index_ref.url.contains("betacraft.uk");

    let mut need_download = true;
    if patched_index {
        need_download = !net::looks_complete(&index_path, None);
    } else if net::looks_complete(&index_path, index_ref.size) {
        if let Some(expected) = &index_ref.sha1 {
            if let Ok(actual) = net::sha1_file(&index_path).await {
                need_download = !actual.eq_ignore_ascii_case(expected);
            }
        } else {
            need_download = false;
        }
    }
    if need_download {
        let (expected_sha1, expected_size) = if patched_index {
            (None, None)
        } else {
            (index_ref.sha1.as_deref(), index_ref.size)
        };
        net::download_file(
            &index_ref.url,
            &index_path,
            expected_sha1,
            expected_size,
            None,
        )
        .await?;
    }

    let text = tokio::fs::read_to_string(&index_path)
        .await
        .map_err(|e| format!("读取资源索引失败: {e}"))?;
    let index: AssetIndex =
        serde_json::from_str(&text).map_err(|e| format!("资源索引解析失败: {e}"))?;

    let mut unique: HashMap<String, AssetObject> = HashMap::new();
    for object in index.objects.values() {
        unique
            .entry(object.hash.clone())
            .and_modify(|existing| {
                // Duplicate names for one hash: keep the entry carrying a URL.
                if existing.url.is_none() && object.url.is_some() {
                    existing.url = object.url.clone();
                }
            })
            .or_insert_with(|| object.clone());
    }

    let objects_dir = assets_dir(root).join("objects");
    let mut jobs = Vec::with_capacity(unique.len());
    let mut total_bytes: u64 = 0;
    for (hash, object) in &unique {
        let prefix = hash.get(0..2).unwrap_or("00");
        total_bytes += object.size;
        jobs.push(FileJob {
            url: asset_object_url(hash, object),
            dest: objects_dir.join(prefix).join(hash),
            sha1: Some(hash.clone()),
            size: Some(object.size),
            verify_existing: false,
        });
    }
    jobs.sort_by(|a, b| a.dest.cmp(&b.dest));

    Ok(Some(PreparedAssets {
        index_id: index_ref.id.clone(),
        index,
        jobs,
        total_bytes,
    }))
}

async fn ensure_assets_with_tracker(
    root: &Path,
    prepared: Option<PreparedAssets>,
    instance_dir: &Path,
    tracker: &Arc<DownloadTracker>,
    concurrency: usize,
    worker_offset: usize,
) -> Result<usize, String> {
    let Some(prepared) = prepared else {
        tracker.set_stage_status("assets", "done");
        return Ok(0);
    };
    let count = prepared.jobs.len();
    let objects_dir = assets_dir(root).join("objects");

    download_jobs_with_tracker(prepared.jobs, "assets", tracker, concurrency, worker_offset)
        .await?;

    if prepared.index.is_virtual() {
        tracker.emit_now("assets", count as u64, count as u64, "整理旧版资源目录");
        if prepared.index.virtual_ {
            let dest = assets_dir(root).join("virtual").join(&prepared.index_id);
            copy_asset_tree(&prepared.index.objects, &objects_dir, &dest).await?;
        }
        if prepared.index.map_to_resources {
            copy_asset_tree(
                &prepared.index.objects,
                &objects_dir,
                &instance_dir.join("resources"),
            )
            .await?;
        }
    }

    Ok(count)
}

async fn download_client_with_tracker(
    root: &Path,
    version: &VersionDetail,
    tracker: &Arc<DownloadTracker>,
    concurrency: usize,
    worker_offset: usize,
) -> Result<(), String> {
    let Some(client) = version.downloads.as_ref().and_then(|d| d.client.as_ref()) else {
        return Err("这个版本没有提供客户端文件".to_string());
    };
    tracker.set_stage_status("client", "active");

    let dest = version_dir(root, &version.id).join(format!("{}.jar", version.id));
    let total = client.size.unwrap_or(0);

    if net::looks_complete(&dest, client.size) {
        let valid = if let Some(expected) = &client.sha1 {
            net::sha1_file(&dest)
                .await
                .map(|actual| actual.eq_ignore_ascii_case(expected))
                .unwrap_or(false)
        } else {
            true
        };
        if valid {
            tracker.skipped_files.fetch_add(1, Ordering::Relaxed);
            tracker.add_stage_completed("client", 1, total);
            tracker.set_stage_status("client", "done");
            tracker.emit_now("client", total.max(1), total.max(1), "客户端已存在（跳过）");
            return Ok(());
        }
    }

    let worker_id = worker_offset + 1;
    let client_threads = concurrency.clamp(1, 8);
    let segments = net::recommended_segments(client.size, client_threads);
    let jar_name = format!("{}.jar", version.id);
    tracker.set_worker_task(
        worker_id,
        Some(ActiveDownloadTask {
            worker_id,
            name: jar_name.clone(),
            stage: "client".to_string(),
            done_bytes: 0,
            total_bytes: total,
            segments,
        }),
    );

    tracker.emit_now("client", 0, total, format!("下载 {jar_name}"));

    let tracker_for_bytes = tracker.clone();
    let mut on_progress = move |done: u64, reported_total: u64, delta: u64| {
        let total = if reported_total > 0 {
            reported_total
        } else {
            total
        };
        tracker_for_bytes.update_worker_bytes(worker_id, done, total, delta);
        tracker_for_bytes.emit_throttled(
            "client",
            done,
            total,
            format!(
                "{:.1} / {:.1} MB",
                done as f64 / 1_048_576.0,
                total as f64 / 1_048_576.0
            ),
        );
    };

    let res = net::download_file_with_mirrors(
        client.url.as_deref().unwrap_or_default(),
        &dest,
        client.sha1.as_deref(),
        client.size,
        client_threads,
        Some(&tracker.retried_files),
        Some(&mut on_progress),
    )
    .await;

    tracker.set_worker_task(worker_id, None);
    let downloaded = match res {
        Ok(b) => b,
        Err(err) => {
            tracker.set_stage_status("client", "error");
            return Err(err);
        }
    };

    tracker.add_stage_completed("client", 1, downloaded.max(total));
    tracker.set_stage_status("client", "done");
    tracker.emit_now("client", total.max(1), total.max(1), "客户端下载完成");
    Ok(())
}

async fn download_log_config(
    root: &Path,
    version: &VersionDetail,
) -> Result<Option<PathBuf>, String> {
    let Some(file) = version
        .logging
        .as_ref()
        .and_then(|l| l.client.as_ref())
        .and_then(|c| c.file.as_ref())
    else {
        return Ok(None);
    };
    let dest = assets_dir(root).join("log_configs").join(&file.id);
    if !net::looks_complete(&dest, file.size) {
        net::download_file(&file.url, &dest, file.sha1.as_deref(), file.size, None).await?;
    }
    Ok(Some(dest))
}

pub async fn install_version(
    root: &Path,
    version_id: &str,
    progress: ProgressFn,
) -> Result<InstallResult, String> {
    install_version_with_options(root, version_id, None, None, progress).await
}

pub async fn install_version_with_options(
    root: &Path,
    version_id: &str,
    concurrency: Option<usize>,
    selection: Option<crate::loaders::LoaderSelection>,
    progress: ProgressFn,
) -> Result<InstallResult, String> {
    let root = net::absolute_path(root);
    let root = root.as_path();
    let clean_version_id = version_id.strip_prefix("betacraft:").unwrap_or(version_id);
    safe_version_id(clean_version_id)?;

    let selection = selection.unwrap_or_default();
    let instance_id = selection
        .instance_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(clean_version_id)
        .to_string();
    safe_version_id(&instance_id)?;

    let has_addons = selection.has_any_addon();
    let prepare_steps = if has_addons { 4 } else { 3 };
    let threads = concurrency.unwrap_or(DEFAULT_DOWNLOAD_THREADS).clamp(1, 64);

    let tracker = DownloadTracker::new(&instance_id, threads, has_addons, progress);
    tracker.emit_now("prepare", 0, prepare_steps, "读取版本清单");

    let is_betacraft_prefixed = version_id.starts_with("betacraft:");
    let mut summary = None;

    if !is_betacraft_prefixed {
        if let Ok(manifest) = fetch_manifest(root, false).await {
            summary = manifest
                .versions
                .into_iter()
                .find(|v| v.id == clean_version_id);
        }
    }

    if summary.is_none() {
        if let Ok(b_manifest) = fetch_betacraft_manifest(root, false).await {
            summary = b_manifest
                .versions
                .into_iter()
                .find(|v| v.id == clean_version_id);
        }
    }

    if summary.is_none() {
        if !is_betacraft_prefixed {
            if let Ok(manifest) = fetch_manifest(root, true).await {
                summary = manifest
                    .versions
                    .into_iter()
                    .find(|v| v.id == clean_version_id);
            }
        }
        if summary.is_none() {
            if let Ok(b_manifest) = fetch_betacraft_manifest(root, true).await {
                summary = b_manifest
                    .versions
                    .into_iter()
                    .find(|v| v.id == clean_version_id);
            }
        }
    }

    let summary = summary.ok_or_else(|| format!("版本清单中找不到 {clean_version_id}"))?;
    tracker.add_stage_completed("prepare", 1, 0);
    tracker.emit_now(
        "prepare",
        1,
        prepare_steps,
        format!("解析版本配置 {}.json", summary.id),
    );

    let mut version = load_version(root, &summary).await?;
    if version.inherits_from.is_some() {
        version = resolve_inherits_from(root, version).await?;
    }
    tracker.add_stage_completed("prepare", 1, 0);

    let instance_dir = game_dir(root, &instance_id);
    tokio::fs::create_dir_all(&instance_dir)
        .await
        .map_err(|e| format!("无法创建游戏目录: {e}"))?;

    version.mc_version = Some(clean_version_id.to_string());
    version.id = instance_id.clone();
    version.optifine_version = selection
        .optifine_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    version.fabric_api_version = selection
        .fabric_api_version
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);

    let mut extra_mod_jobs = Vec::new();
    if has_addons {
        tracker.emit_now("prepare", 2, prepare_steps, "获取模组加载器与附加工具配置");
        let extra_mods = crate::loaders::prepare_addons(
            root,
            &instance_dir,
            clean_version_id,
            &mut version,
            &selection,
        )
        .await
        .map_err(|e| {
            tracker.set_stage_status("prepare", "error");
            e
        })?;
        for m in extra_mods {
            let verify_existing = m.sha1.is_some();
            extra_mod_jobs.push(FileJob {
                url: m.url,
                dest: m.dest,
                sha1: m.sha1,
                size: m.size,
                verify_existing,
            });
        }
        tracker.add_stage_completed("prepare", 1, 0);
    }

    // Write the merged version JSON to versions/<instance_id>/<instance_id>.json
    let instance_json_path = instance_dir.join(format!("{instance_id}.json"));
    let serialized =
        serde_json::to_string_pretty(&version).map_err(|e| format!("序列化版本配置失败: {e}"))?;
    tokio::fs::write(&instance_json_path, serialized)
        .await
        .map_err(|e| format!("保存版本配置失败: {e}"))?;

    let features: HashMap<String, bool> = HashMap::new();
    let plan = plan_libraries(root, &version, &features);

    let client_bytes = version
        .downloads
        .as_ref()
        .and_then(|d| d.client.as_ref())
        .and_then(|c| c.size)
        .unwrap_or(0);
    let libs_bytes: u64 = plan.jobs.iter().filter_map(|j| j.size).sum();
    let initial_assets_bytes = version
        .asset_index
        .as_ref()
        .and_then(|a| a.total_size)
        .unwrap_or(0);

    tracker.set_stage_plan("client", 1, client_bytes);
    tracker.set_stage_plan("libraries", plan.jobs.len() as u64, libs_bytes);
    tracker.set_stage_plan("assets", 0, initial_assets_bytes);
    if has_addons {
        let addon_bytes: u64 = extra_mod_jobs.iter().filter_map(|j| j.size).sum();
        tracker.set_stage_plan("addons", (extra_mod_jobs.len() as u64).max(1), addon_bytes);
    }
    tracker.emit_now(
        "prepare",
        prepare_steps - 1,
        prepare_steps,
        "获取资源索引清单",
    );

    let prepared_assets = prepare_assets_plan(root, &version).await?;
    if let Some(ref assets_plan) = prepared_assets {
        tracker.set_stage_plan(
            "assets",
            assets_plan.jobs.len() as u64,
            assets_plan.total_bytes.max(initial_assets_bytes),
        );
    }
    tracker.add_stage_completed("prepare", 1, 0);
    tracker.set_stage_status("prepare", "done");

    let client_threads = if threads <= 4 {
        1
    } else {
        2.min(threads / 8).max(2)
    };
    let available = threads.saturating_sub(1);
    let (libs_threads, assets_threads, addons_threads) = if has_addons {
        let addon = (available * 2 / 10).clamp(1, 8);
        let rem = available.saturating_sub(addon);
        let libs = (rem * 45 / 100).max(1);
        let assets = rem.saturating_sub(libs).max(1);
        (libs, assets, addon)
    } else {
        let libs = (available * 45 / 100).max(1);
        let assets = available.saturating_sub(libs).max(1);
        (libs, assets, 0)
    };

    let client_offset = 0;
    let libs_offset = 1;
    let assets_offset = libs_offset + libs_threads;
    let addons_offset = assets_offset + assets_threads;

    tracker.set_stage_status("client", "active");
    tracker.set_stage_status("libraries", "active");
    tracker.set_stage_status("assets", "active");
    if has_addons {
        tracker.set_stage_status("addons", "active");
    }

    let client_task = {
        let tracker = tracker.clone();
        let root = root.to_path_buf();
        let version = version.clone();
        async move {
            download_client_with_tracker(&root, &version, &tracker, client_threads, client_offset)
                .await?;
            let _ = download_log_config(&root, &version).await?;
            Ok::<(), String>(())
        }
    };

    let libraries_task = {
        let tracker = tracker.clone();
        let plan = plan.clone();
        let instance_dir = instance_dir.clone();
        async move {
            tracker.emit_now("libraries", 0, plan.jobs.len() as u64, "准备依赖库");
            let (library_count, _) = download_jobs_with_tracker(
                plan.jobs,
                "libraries",
                &tracker,
                libs_threads,
                libs_offset,
            )
            .await?;

            let natives_dir = instance_dir.join("natives");
            let native_jars = plan.native_jars;
            tokio::task::spawn_blocking(move || extract_natives(&native_jars, &natives_dir))
                .await
                .map_err(|e| format!("解压 natives 任务失败: {e}"))??;

            Ok::<usize, String>(library_count as usize)
        }
    };

    let assets_task = {
        let tracker = tracker.clone();
        let root = root.to_path_buf();
        let instance_dir = instance_dir.clone();
        async move {
            ensure_assets_with_tracker(
                &root,
                prepared_assets,
                &instance_dir,
                &tracker,
                assets_threads,
                assets_offset,
            )
            .await
        }
    };

    let addons_task = {
        let tracker = tracker.clone();
        let instance_dir = instance_dir.clone();
        async move {
            if has_addons {
                if extra_mod_jobs.is_empty() {
                    tracker.add_stage_completed("addons", 1, 0);
                    tracker.set_stage_status("addons", "done");
                    tracker.emit_now("addons", 1, 1, "模组加载器配置已完成");
                } else {
                    let mods_dir = instance_dir.join("mods");
                    let _ = tokio::fs::create_dir_all(&mods_dir).await;
                    download_jobs_with_tracker(
                        extra_mod_jobs,
                        "addons",
                        &tracker,
                        addons_threads,
                        addons_offset,
                    )
                    .await?;
                }
            }
            Ok::<(), String>(())
        }
    };

    let (_client_res, libs_res, assets_res, _addons_res) =
        tokio::try_join!(client_task, libraries_task, assets_task, addons_task)?;

    if has_addons {
        if let (Some(loader_type), Some(loader_ver)) =
            (version.loader.as_deref(), version.loader_version.as_deref())
        {
            if loader_type == "forge" || loader_type == "neoforge" {
                tracker.emit_now("addons", 1, 1, "正在通过安装器构建模组核心");
                // Ensure vanilla jar exists at versions/<clean_version_id>/<clean_version_id>.jar
                let base_ver_dir = root.join("versions").join(clean_version_id);
                let base_jar = base_ver_dir.join(format!("{clean_version_id}.jar"));
                let inst_jar = instance_dir.join(format!("{instance_id}.jar"));
                if !base_jar.is_file() && inst_jar.is_file() {
                    let _ = tokio::fs::create_dir_all(&base_ver_dir).await;
                    let _ = tokio::fs::copy(&inst_jar, &base_jar).await;
                }
                let _ = crate::loaders::ensure_forge_or_neoforge_client_jar(
                    root,
                    clean_version_id,
                    loader_type,
                    loader_ver,
                    None,
                )
                .await;
            }
        }
    }

    tracker.emit_now("done", 1, 1, "游戏文件已就绪");

    Ok(InstallResult {
        version_id: version.id.clone(),
        version_type: version
            .version_type
            .clone()
            .unwrap_or_else(|| summary.version_type.clone()),
        libraries: libs_res,
        assets: assets_res,
        java_major: required_java_major(&version),
    })
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub version_id: String,
    pub root: String,
    pub player_name: String,
    pub memory_mb: Option<u64>,
    pub java_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub skin_type: Option<String>,
    pub custom_skin_path: Option<String>,
    pub custom_skin_model: Option<String>,
    pub mojang_skin_name: Option<String>,
    pub version_isolation: Option<String>,
    pub window_title: Option<String>,
    pub custom_info: Option<String>,
    pub launcher_visibility: Option<String>,
    pub process_priority: Option<String>,
    pub window_size: Option<String>,
    pub jvm_args: Option<String>,
    /// Locale code such as `zh_cn`; written to `options.txt` before start-up.
    pub language: Option<String>,
    /// Microsoft account session. `None` launches an offline account, which
    /// keeps the legacy dummy session the game accepts in single-player.
    #[serde(default)]
    pub auth: Option<LaunchAuth>,
    /// The player picked the offline account: never fall back to the stored
    /// Microsoft session, even though the user is still signed in.
    #[serde(default)]
    pub offline: bool,
}

/// Credentials handed to the game when the user signed in with a real account.
/// Built by the account module after the Xbox -> Minecraft exchange.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAuth {
    pub access_token: String,
    /// Profile UUID from Mojang; empty falls back to the offline UUID.
    #[serde(default)]
    pub uuid: String,
    /// Profile name; empty falls back to the configured player name.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub xuid: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
}

/// The six auth values the launch arguments are built from.
#[derive(Debug, Clone, PartialEq)]
struct AuthVars {
    name: String,
    uuid: String,
    access_token: String,
    xuid: String,
    client_id: String,
    user_type: String,
}

/// Online sessions use the profile identity and `msa`; offline sessions keep
/// the legacy placeholders the game tolerates without a network session.
fn auth_vars(request: &LaunchRequest, fallback_uuid: &str, fallback_name: &str) -> AuthVars {
    match request.auth.as_ref() {
        Some(auth) => {
            let name = if auth.name.trim().is_empty() {
                fallback_name.to_string()
            } else {
                auth.name.trim().to_string()
            };
            AuthVars {
                name,
                uuid: if auth.uuid.trim().is_empty() {
                    fallback_uuid.to_string()
                } else {
                    auth.uuid.trim().to_string()
                },
                access_token: auth.access_token.trim().to_string(),
                xuid: auth.xuid.clone().unwrap_or_default(),
                client_id: auth.client_id.clone().unwrap_or_default(),
                user_type: "msa".to_string(),
            }
        }
        None => AuthVars {
            name: fallback_name.to_string(),
            uuid: fallback_uuid.to_string(),
            access_token: "0".to_string(),
            xuid: String::new(),
            client_id: String::new(),
            user_type: "legacy".to_string(),
        },
    }
}

#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub java: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub java_major: u32,
}

fn is_alex_uuid(bytes: &[u8; 16]) -> bool {
    let most_sig = u64::from_be_bytes(bytes[0..8].try_into().unwrap_or([0; 8]));
    let least_sig = u64::from_be_bytes(bytes[8..16].try_into().unwrap_or([0; 8]));
    let hilo = most_sig ^ least_sig;
    let hash = ((hilo >> 32) ^ hilo) as i32;
    (hash & 1) == 1
}

pub fn offline_uuid(name: &str) -> String {
    offline_uuid_with_skin(name, None)
}

pub fn offline_uuid_with_skin(name: &str, skin_type: Option<&str>) -> String {
    let digest = Md5::digest(format!("OfflinePlayer:{name}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest);
    bytes[6] = (bytes[6] & 0x0f) | 0x30;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    match skin_type {
        Some("steve") => {
            if is_alex_uuid(&bytes) {
                bytes[15] ^= 1;
            }
        }
        Some("alex") => {
            if !is_alex_uuid(&bytes) {
                bytes[15] ^= 1;
            }
        }
        _ => {}
    }

    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

pub fn format_uuid_with_hyphens(uuid: &str) -> String {
    let clean = uuid.replace('-', "").trim().to_string();
    if clean.len() == 32 {
        format!(
            "{}-{}-{}-{}-{}",
            &clean[0..8],
            &clean[8..12],
            &clean[12..16],
            &clean[16..20],
            &clean[20..32]
        )
    } else {
        uuid.to_string()
    }
}

async fn fetch_mojang_textures_by_id_or_name(
    uuid: Option<&str>,
    name: &str,
) -> Option<(String, String, String)> {
    let id = if let Some(u) = uuid.filter(|s| !s.trim().is_empty()) {
        u.replace('-', "").trim().to_string()
    } else {
        let profile_url = format!("https://api.mojang.com/users/profiles/minecraft/{name}");
        let resp = tokio::time::timeout(
            Duration::from_secs(5),
            net::client().get(&profile_url).send(),
        )
        .await
        .ok()?
        .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let val: serde_json::Value = resp.json().await.ok()?;
        val.get("id")?.as_str()?.to_string()
    };

    let session_url =
        format!("https://sessionserver.mojang.com/session/minecraft/profile/{id}?unsigned=false");
    let s_resp = tokio::time::timeout(
        Duration::from_secs(5),
        net::client().get(&session_url).send(),
    )
    .await
    .ok()?
    .ok()?;
    if !s_resp.status().is_success() {
        return None;
    }
    let s_val: serde_json::Value = s_resp.json().await.ok()?;
    let properties = s_val.get("properties")?.as_array()?;
    for prop in properties {
        if prop.get("name")?.as_str()? == "textures" {
            let val = prop.get("value")?.as_str()?.to_string();
            let sig = prop
                .get("signature")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            return Some((val, sig, id));
        }
    }
    None
}

#[allow(dead_code)]
async fn fetch_mojang_textures(name: &str) -> Option<(String, String, String)> {
    fetch_mojang_textures_by_id_or_name(None, name).await
}

async fn setup_custom_skin_pack(root: &Path, version_id: &str, skin_path: &Path) {
    let pack_dir = game_dir(root, version_id)
        .join("resourcepacks")
        .join("OfflineSkinPack");
    let wide_dir = pack_dir
        .join("assets")
        .join("minecraft")
        .join("textures")
        .join("entity")
        .join("player")
        .join("wide");
    let slim_dir = pack_dir
        .join("assets")
        .join("minecraft")
        .join("textures")
        .join("entity")
        .join("player")
        .join("slim");
    let legacy_dir = pack_dir
        .join("assets")
        .join("minecraft")
        .join("textures")
        .join("entity");

    let _ = tokio::fs::create_dir_all(&wide_dir).await;
    let _ = tokio::fs::create_dir_all(&slim_dir).await;
    let _ = tokio::fs::create_dir_all(&legacy_dir).await;

    let mcmeta = serde_json::json!({
        "pack": {
            "pack_format": 9,
            "description": "离线皮肤材质包 (由启动器自动生成)"
        }
    });
    let _ = tokio::fs::write(pack_dir.join("pack.mcmeta"), mcmeta.to_string()).await;

    let _ = tokio::fs::copy(skin_path, legacy_dir.join("steve.png")).await;
    let _ = tokio::fs::copy(skin_path, legacy_dir.join("alex.png")).await;
    let _ = tokio::fs::copy(skin_path, wide_dir.join("steve.png")).await;
    let _ = tokio::fs::copy(skin_path, slim_dir.join("alex.png")).await;

    let options_txt = game_dir(root, version_id).join("options.txt");
    if let Ok(content) = tokio::fs::read_to_string(&options_txt).await {
        if content.contains("resourcePacks:") {
            if !content.contains("OfflineSkinPack") {
                let updated = content.replace(
                    "resourcePacks:[",
                    "resourcePacks:[\"file/OfflineSkinPack\",",
                );
                let _ = tokio::fs::write(&options_txt, updated).await;
            }
        } else {
            let updated =
                format!("{content}\nresourcePacks:[\"file/OfflineSkinPack\",\"vanilla\"]\n");
            let _ = tokio::fs::write(&options_txt, updated).await;
        }
    } else {
        let default_options = "resourcePacks:[\"file/OfflineSkinPack\",\"vanilla\"]\n";
        let _ = tokio::fs::write(&options_txt, default_options).await;
    }
}

fn valid_player_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= 16
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn classpath_separator() -> &'static str {
    if cfg!(windows) {
        ";"
    } else {
        ":"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArgumentValue {
    Plain(String),
    Complex {
        #[serde(default)]
        rules: Vec<Rule>,
        value: Option<serde_json::Value>,
    },
}

fn collect_arguments(
    args: &[ArgumentValue],
    features: &HashMap<String, bool>,
    vars: &HashMap<String, String>,
) -> Vec<String> {
    let mut out = Vec::new();
    for arg in args {
        match arg {
            ArgumentValue::Plain(value) => {
                out.push(substitute(value, vars));
            }
            ArgumentValue::Complex { rules, value } => {
                if !rules_allow(rules, features) {
                    continue;
                }
                let Some(value) = value else {
                    continue;
                };
                match value {
                    serde_json::Value::String(s) => out.push(substitute(s, vars)),
                    serde_json::Value::Array(items) => {
                        for item in items {
                            if let Some(s) = item.as_str() {
                                out.push(substitute(s, vars));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    out
}

/// Whether the version accepts `--width` / `--height` / `--fullscreen`.
///
/// Modern metadata declares them in `arguments`; legacy metadata only carries
/// them in its `minecraftArguments` template when the client supports them at
/// all. Passing a window size to 1.5.2 or Beta makes those clients choke before
/// a window is created.
fn window_size_supported(version: &VersionDetail) -> bool {
    if version.arguments.is_some() {
        return true;
    }
    if let Some(template) = version.minecraft_arguments.as_deref() {
        if template.contains("--width") || template.contains("--height") {
            return true;
        }
    }
    release_supports_window_args(&version.id)
}

/// Releases 1.6+ and snapshots from 13w16a on accept `--width`/`--height`;
/// 1.5.2 and older (and Alpha/Beta/Infdev ids) do not.
fn release_supports_window_args(id: &str) -> bool {
    let id = id.trim();
    if let Some(rest) = id.strip_prefix("1.") {
        let minor: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(minor) = minor.parse::<u32>() {
            return minor >= 6;
        }
        return false;
    }

    // Snapshots use ids like `13w16a`; 13w16a was the first 1.6 snapshot.
    let (year_part, rest) = id.split_at(id.len().min(2));
    let Ok(year) = year_part.parse::<u32>() else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('w') else {
        return false;
    };
    let week: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    let Ok(week) = week.parse::<u32>() else {
        return false;
    };
    year > 13 || (year == 13 && week >= 16)
}

/// Drop `--width` / `--height` pairs that ended up with an empty value, plus
/// stray empty arguments. Legacy metadata (and the Betacraft archive) always
/// emits the resolution pair, even when the launcher has no custom size, and a
/// blank value makes old clients fail before the window appears.
fn strip_empty_window_args(args: &mut Vec<String>) {
    let mut kept = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if matches!(arg.as_str(), "--width" | "--height")
            && args
                .get(index + 1)
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
        {
            index += 2;
            continue;
        }
        if arg.is_empty() {
            index += 1;
            continue;
        }
        kept.push(arg.clone());
        index += 1;
    }
    *args = kept;
}

fn substitute(input: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find('}') {
            let key = &after[..end];
            if let Some(value) = vars.get(key) {
                out.push_str(value);
            }
            rest = &after[end + 1..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

fn asset_game_dir(root: &Path, version: &VersionDetail) -> String {
    let index = version
        .asset_index
        .as_ref()
        .map(|i| i.id.clone())
        .or_else(|| version.assets.clone())
        .unwrap_or_else(|| "legacy".to_string());
    let path = assets_dir(root).join("virtual").join(&index);
    path.to_string_lossy().to_string()
}

pub fn is_modded_version(version: &VersionDetail) -> bool {
    let main = &version.main_class;
    if main.contains("fabric")
        || main.contains("forge")
        || main.contains("neoforge")
        || main.contains("quilt")
        || main.contains("optifine")
    {
        return true;
    }
    for lib in &version.libraries {
        let name = &lib.name;
        if name.starts_with("net.fabricmc:")
            || name.starts_with("net.minecraftforge:")
            || name.starts_with("net.neoforged:")
            || name.starts_with("org.quiltmc:")
            || name.starts_with("optifine:")
        {
            return true;
        }
    }
    false
}

fn build_launch_spec(
    root: &Path,
    version: &VersionDetail,
    java: PathBuf,
    java_major: u32,
    request: &LaunchRequest,
    user_properties_override: Option<String>,
    mojang_uuid_override: Option<String>,
) -> Result<LaunchSpec, String> {
    // A signed-in account plays under its profile name, not under whatever the
    // launcher's offline nickname field happens to hold.
    let configured_name = request.player_name.trim().to_string();
    let player_name = request
        .auth
        .as_ref()
        .map(|auth| auth.name.trim())
        .filter(|name| !name.is_empty())
        .unwrap_or(configured_name.as_str())
        .to_string();
    if !valid_player_name(&player_name) {
        return Err("游戏昵称只能包含英文字母、数字和下划线，长度 1-16 位".to_string());
    }

    let instance_dir = game_dir(root, &version.id);
    if !instance_dir.is_dir() {
        return Err("版本尚未安装完成".to_string());
    }
    let client_jar = if instance_dir.join(format!("{}.jar", version.id)).is_file() {
        instance_dir.join(format!("{}.jar", version.id))
    } else if let Some(parent) = &version.inherits_from {
        game_dir(root, parent).join(format!("{parent}.jar"))
    } else if let Some(mc_ver) = &version.mc_version {
        game_dir(root, mc_ver).join(format!("{mc_ver}.jar"))
    } else {
        instance_dir.join(format!("{}.jar", version.id))
    };
    if !client_jar.is_file() {
        return Err("客户端 jar 不存在，请重新安装该版本".to_string());
    }

    let version_isolation = request.version_isolation.as_deref().unwrap_or("all");
    let target_game_dir = match version_isolation {
        "none" => root.to_path_buf(),
        "modded" => {
            if is_modded_version(version) {
                instance_dir.clone()
            } else {
                root.to_path_buf()
            }
        }
        _ => instance_dir.clone(), // "all"
    };

    let window_size_mode = request.window_size.as_deref().unwrap_or("default");
    let mut features = HashMap::new();
    let custom_resolution = if window_size_mode == "custom"
        || (window_size_mode == "default" && request.width.is_some() && request.height.is_some())
    {
        request
            .width
            .zip(request.height)
            .filter(|(w, h)| *w >= 320 && *h >= 240)
    } else {
        None
    };
    features.insert(
        "has_custom_resolution".to_string(),
        custom_resolution.is_some(),
    );
    features.insert("is_demo_user".to_string(), false);
    features.insert("has_quick_plays_support".to_string(), false);
    features.insert("is_quick_play_singleplayer".to_string(), false);
    features.insert("is_quick_play_multiplayer".to_string(), false);
    features.insert("is_quick_play_realms".to_string(), false);

    let memory = request.memory_mb.unwrap_or(4096).clamp(512, 65536);
    let skin_type = request.skin_type.as_deref().unwrap_or("random");
    let uuid = match request.auth.as_ref().map(|auth| auth.uuid.trim()) {
        Some(online_uuid) if !online_uuid.is_empty() => format_uuid_with_hyphens(online_uuid),
        _ => mojang_uuid_override
            .unwrap_or_else(|| offline_uuid_with_skin(&player_name, Some(skin_type))),
    };
    let assets_index_name = version
        .asset_index
        .as_ref()
        .map(|i| i.id.clone())
        .or_else(|| version.assets.clone())
        .unwrap_or_else(|| "legacy".to_string());

    let plan = plan_libraries(root, version, &features);
    let mut classpath = plan.classpath;
    let client_jar_filename = client_jar
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    classpath.push(client_jar);
    let classpath_string = classpath
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(classpath_separator());

    let natives_dir = instance_dir.join("natives");
    std::fs::create_dir_all(&natives_dir).map_err(|e| format!("无法创建 natives 目录: {e}"))?;
    let has_native_binaries = std::fs::read_dir(&natives_dir)
        .ok()
        .map(|entries| {
            entries.flatten().any(|e| {
                e.path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "dll" | "so" | "dylib"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if !has_native_binaries && !plan.native_jars.is_empty() {
        let _ = extract_natives(&plan.native_jars, &natives_dir);
    }

    let mut vars: HashMap<String, String> = HashMap::new();
    let insert = |vars: &mut HashMap<String, String>, k: &str, v: String| {
        vars.insert(k.to_string(), v);
    };
    // LegacyFix (used by the Betacraft archive) reads this for the window icon.
    // An empty value is not an error there, but passing `-Dlf.icon=` logs a
    // failure, so the variable is only filled when the instance ships an icon.
    let instance_icon = ["icon.png", "icon.jpg", "icon.jpeg"]
        .iter()
        .map(|name| instance_dir.join(name))
        .find(|path| path.is_file())
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    insert(&mut vars, "instance_icon", instance_icon);
    let credentials = auth_vars(request, &uuid, &player_name);
    insert(&mut vars, "auth_player_name", credentials.name.clone());
    insert(&mut vars, "version_name", version.id.clone());
    insert(
        &mut vars,
        "game_directory",
        target_game_dir.to_string_lossy().to_string(),
    );
    insert(
        &mut vars,
        "assets_root",
        assets_dir(root).to_string_lossy().to_string(),
    );
    insert(&mut vars, "game_assets", asset_game_dir(root, version));
    insert(&mut vars, "assets_index_name", assets_index_name);
    insert(&mut vars, "auth_uuid", credentials.uuid.clone());
    insert(
        &mut vars,
        "auth_access_token",
        credentials.access_token.clone(),
    );
    insert(
        &mut vars,
        "auth_session",
        format!("token:{}:{}", credentials.access_token, credentials.uuid),
    );
    insert(&mut vars, "user_type", credentials.user_type.clone());
    let user_props = user_properties_override.unwrap_or_else(|| "{}".to_string());
    insert(&mut vars, "user_properties", user_props);
    insert(&mut vars, "clientid", credentials.client_id.clone());
    insert(&mut vars, "auth_xuid", credentials.xuid.clone());
    insert(
        &mut vars,
        "version_type",
        version
            .version_type
            .clone()
            .unwrap_or_else(|| "release".to_string()),
    );
    let custom_info = request
        .custom_info
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("PCL");
    insert(&mut vars, "launcher_name", custom_info.to_string());
    insert(
        &mut vars,
        "launcher_version",
        env!("CARGO_PKG_VERSION").to_string(),
    );
    insert(
        &mut vars,
        "natives_directory",
        natives_dir.to_string_lossy().to_string(),
    );
    insert(
        &mut vars,
        "library_directory",
        libraries_dir(root).to_string_lossy().to_string(),
    );
    insert(&mut vars, "classpath", classpath_string);
    insert(
        &mut vars,
        "classpath_separator",
        classpath_separator().to_string(),
    );
    if let Some((w, h)) = custom_resolution {
        insert(&mut vars, "resolution_width", w.to_string());
        insert(&mut vars, "resolution_height", h.to_string());
    } else {
        insert(&mut vars, "resolution_width", String::new());
        insert(&mut vars, "resolution_height", String::new());
    }
    insert(&mut vars, "profile_name", player_name.to_string());

    let mut jvm_args: Vec<String> = vec![
        format!("-Xms{}M", (memory / 2).clamp(512, 2048)),
        format!("-Xmx{memory}M"),
        format!("-Dminecraft.launcher.brand={custom_info}"),
    ];
    let legacy_template = version.arguments.is_none();
    let window_args_supported = window_size_supported(version);

    if let Some(title) = request.window_title.as_deref().map(str::trim) {
        if !title.is_empty() && title != "默认" {
            jvm_args.push(format!("-Dorg.lwjgl.opengl.Window.title={title}"));
        }
    }

    if let Some(arguments) = &version.arguments {
        let version_jvm = collect_arguments(&arguments.jvm, &features, &vars);
        for mut arg in version_jvm {
            if arg.starts_with("-Xmx") || arg.starts_with("-Xms") {
                continue;
            }
            if arg.starts_with("-DignoreList=") && !client_jar_filename.is_empty() {
                if !arg.contains(&client_jar_filename) {
                    arg.push(',');
                    arg.push_str(&client_jar_filename);
                }
            }
            // `${instance_icon}` collapses to nothing without an icon file;
            // drop the resulting empty system property instead of handing
            // LegacyFix a blank path it will complain about.
            if arg == "-Dlf.icon=" {
                continue;
            }
            jvm_args.push(arg);
        }
    }

    let has_cp = jvm_args.iter().any(|a| a == "-cp" || a == "-classpath");
    if !has_cp {
        jvm_args.push("-cp".to_string());
        jvm_args.push(vars.get("classpath").cloned().unwrap_or_default());
    }
    let has_library_path = jvm_args.iter().any(|a| a.contains("-Djava.library.path="));
    if !has_library_path {
        jvm_args.push(format!(
            "-Djava.library.path={}",
            natives_dir.to_string_lossy()
        ));
    }

    if let Some(logging) = version
        .logging
        .as_ref()
        .and_then(|l| l.client.as_ref())
        .filter(|c| c.argument.is_some())
    {
        if let Some(file) = &logging.file {
            let path = assets_dir(root).join("log_configs").join(&file.id);
            if path.is_file() {
                let mut log_vars = vars.clone();
                log_vars.insert("path".to_string(), path.to_string_lossy().to_string());
                let args = collect_arguments(
                    &[ArgumentValue::Plain(
                        logging.argument.clone().unwrap_or_default(),
                    )],
                    &features,
                    &log_vars,
                );
                jvm_args.extend(args);
            }
        }
    }

    if let Some(extra_jvm) = request.jvm_args.as_deref().map(str::trim) {
        for arg in extra_jvm.split_whitespace() {
            if !arg.is_empty() {
                jvm_args.push(arg.to_string());
            }
        }
    }

    jvm_args.push(version.main_class.clone());

    let mut game_args = if let Some(arguments) = &version.arguments {
        collect_arguments(&arguments.game, &features, &vars)
    } else if let Some(legacy) = &version.minecraft_arguments {
        legacy
            .split_whitespace()
            .map(|part| substitute(part, &vars))
            .collect()
    } else {
        Vec::new()
    };

    // Versions built from a `minecraftArguments` template (1.12.2 and older)
    // already receive exactly the arguments they understand — 1.5.2 and older
    // even take the user name and session as positional values — so nothing is
    // appended for them. Modern metadata gets the usual fallbacks.
    if !legacy_template {
        if !game_args.iter().any(|a| a == "--username") {
            game_args.extend(["--username".into(), vars["auth_player_name"].clone()]);
        }
        if !game_args.iter().any(|a| a == "--version") {
            game_args.extend(["--version".into(), version.id.clone()]);
        }
        if !game_args.iter().any(|a| a == "--gameDir") {
            game_args.extend(["--gameDir".into(), vars["game_directory"].clone()]);
        }
        if !game_args.iter().any(|a| a == "--assetsDir") {
            game_args.extend(["--assetsDir".into(), vars["assets_root"].clone()]);
        }
        if !game_args.iter().any(|a| a == "--assetIndex") {
            game_args.extend(["--assetIndex".into(), vars["assets_index_name"].clone()]);
        }
        if !game_args.iter().any(|a| a == "--uuid") {
            game_args.extend(["--uuid".into(), vars["auth_uuid"].clone()]);
        }
        if !game_args.iter().any(|a| a == "--accessToken") {
            game_args.extend(["--accessToken".into(), vars["auth_access_token"].clone()]);
        }
    }

    // The Betacraft archive feeds `--width ${resolution_width}` through even when
    // no resolution was chosen; an empty value makes the game (and LegacyFix's
    // applet launcher) fail before the window opens. Same for `--height`.
    strip_empty_window_args(&mut game_args);

    if window_args_supported {
        if window_size_mode == "fullscreen" {
            if !game_args.iter().any(|a| a == "--fullscreen") {
                game_args.push("--fullscreen".to_string());
            }
        } else if let Some((w, h)) = custom_resolution {
            if !game_args.iter().any(|a| a == "--width") {
                game_args.extend(["--width".into(), w.to_string()]);
            }
            if !game_args.iter().any(|a| a == "--height") {
                game_args.extend(["--height".into(), h.to_string()]);
            }
        }
    }

    let mut args = jvm_args;
    args.extend(game_args);

    Ok(LaunchSpec {
        java,
        args,
        cwd: target_game_dir,
        java_major,
    })
}

pub async fn prepare_launch(
    request: &LaunchRequest,
    progress: ProgressFn,
) -> Result<LaunchSpec, String> {
    let root = net::absolute_path(&PathBuf::from(&request.root));
    let root = root.as_path();
    safe_version_id(&request.version_id)?;

    // Prefer the locally installed version JSON so launching works offline.
    let local_json =
        version_dir(root, &request.version_id).join(format!("{}.json", request.version_id));
    let version = match tokio::fs::read_to_string(&local_json).await {
        Ok(text) => {
            let detail = serde_json::from_str::<VersionDetail>(&text)
                .map_err(|e| format!("本地版本信息损坏: {e}"))?;
            resolve_inherits_from(root, detail).await?
        }
        Err(_) => {
            let manifest = fetch_manifest(root, false).await?;
            let summary = manifest
                .versions
                .iter()
                .find(|v| v.id == request.version_id)
                .ok_or_else(|| format!("版本清单中找不到 {}", request.version_id))?;
            load_version(root, summary).await?
        }
    };
    let java_major = required_java_major(&version);

    progress(InstallProgress::basic(
        request.version_id.clone(),
        "java",
        0,
        0,
        format!("正在检查 Java {java_major}"),
    ));

    let version_id = request.version_id.clone();
    let app_progress = progress.clone();
    let java_progress: JavaProgressFn = Arc::new(move |p| {
        let mut item = InstallProgress::basic(
            version_id.clone(),
            "java",
            p.done,
            p.total,
            p.detail.clone(),
        );
        if p.stage == "download" {
            item.downloaded_bytes = p.done;
            item.total_bytes = p.total;
            item.threads = 8;
            item.active_threads = if p.done < p.total { 8 } else { 0 };
            if p.done < p.total {
                item.active_tasks.push(ActiveDownloadTask {
                    worker_id: 1,
                    name: format!("temurin-jre-{java_major}"),
                    stage: "java".to_string(),
                    done_bytes: p.done,
                    total_bytes: p.total,
                    segments: 8,
                });
            }
        }
        app_progress(item);
    });

    let java = java::ensure_java(
        root,
        java_major,
        request.java_path.as_deref(),
        Some(java_progress),
    )
    .await?;

    progress(InstallProgress::basic(
        request.version_id.clone(),
        "launch",
        0,
        1,
        "正在启动游戏",
    ));

    let skin_type = request.skin_type.as_deref().unwrap_or("random");
    let mut user_properties_override = None;
    let mut mojang_uuid_override = None;

    if skin_type == "custom" {
        if let Some(path_str) = &request.custom_skin_path {
            let p = Path::new(path_str);
            if p.is_file() {
                setup_custom_skin_pack(root, &request.version_id, p).await;
            }
        }
    } else {
        let is_online = request.auth.is_some();
        if is_online || skin_type == "mojang" {
            let (target_uuid, target_name) = if let Some(auth) = request.auth.as_ref() {
                (Some(auth.uuid.as_str()), auth.name.as_str())
            } else {
                (
                    None,
                    request
                        .mojang_skin_name
                        .as_deref()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or(&request.player_name),
                )
            };

            if let Some((val, sig, raw_uuid)) = fetch_mojang_textures_by_id_or_name(target_uuid, target_name).await {
                user_properties_override = Some(
                    serde_json::json!({
                        "textures": [{
                            "value": val,
                            "signature": sig
                        }]
                    })
                    .to_string(),
                );
                if raw_uuid.len() == 32 {
                    mojang_uuid_override = Some(format_uuid_with_hyphens(&raw_uuid));
                }
            }
        }
    }

    let (is_forge_like, loader_kind, loader_ver) = {
        if let (Some(l), Some(lv)) = (&version.loader, &version.loader_version) {
            (l == "forge" || l == "neoforge", l.clone(), lv.clone())
        } else {
            let mut detected = None;
            for lib in &version.libraries {
                if lib.name.starts_with("net.minecraftforge:forge:") {
                    let parts: Vec<&str> = lib.name.split(':').collect();
                    if parts.len() >= 3 {
                        let fver = parts[2];
                        let loader_ver = fver.split('-').nth(1).unwrap_or(fver).to_string();
                        detected = Some(("forge".to_string(), loader_ver));
                        break;
                    }
                } else if lib.name.starts_with("net.neoforged:neoforge:") {
                    let parts: Vec<&str> = lib.name.split(':').collect();
                    if parts.len() >= 3 {
                        detected = Some(("neoforge".to_string(), parts[2].to_string()));
                        break;
                    }
                }
            }
            if let Some((l, lv)) = detected {
                (true, l, lv)
            } else {
                (false, String::new(), String::new())
            }
        }
    };

    if is_forge_like {
        let clean_mc = version.mc_version.as_deref().unwrap_or(&version.id);
        let clean_mc = clean_mc.split('-').next().unwrap_or(clean_mc);
        progress(InstallProgress::basic(
            request.version_id.clone(),
            "prepare",
            0,
            1,
            "正在检查并构建模组核心".to_string(),
        ));
        crate::loaders::ensure_forge_or_neoforge_client_jar(
            root,
            clean_mc,
            &loader_kind,
            &loader_ver,
            Some(&java),
        )
        .await?;
    }

    let spec = build_launch_spec(
        root,
        &version,
        java,
        java_major,
        request,
        user_properties_override,
        mojang_uuid_override,
    )?;
    Ok(spec)
}

// ---------------------------------------------------------------------------
// Java Mod Management
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaModItem {
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub path: String,
    pub enabled: bool,
    pub size: u64,
    pub modified_time: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub mod_loader: Option<String>,
    /// Icon shipped inside the jar, inlined as a `data:` URL so the list can
    /// render it without exposing an asset protocol or a temp-file path.
    #[serde(default)]
    pub icon_data_url: Option<String>,
}

/// Mods always live with the instance they were installed for; there is no
/// shared `<root>/mods` folder, because the game only reads the mods folder of
/// the game directory it is launched with.
pub fn resolve_java_mods_dir(root: &Path, version_id: &str) -> PathBuf {
    root.join("versions").join(version_id).join("mods")
}

/// Drop the launcher's old shared `mods` folder once it is empty.
///
/// Downloads used to fall back to `<root>/mods` when no instance matched a
/// file. Every mod now goes to `versions/<id>/mods`, so the shared folder is
/// dead weight; jars still sitting in it belong to the player and are left
/// alone.
fn prune_legacy_global_mods(root: &Path) {
    let legacy = root.join("mods");
    if !legacy.is_dir() {
        return;
    }
    let empty = std::fs::read_dir(&legacy)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if empty {
        let _ = std::fs::remove_dir(&legacy);
    }
}

pub fn get_java_mods(root: &Path, version_id: &str) -> Result<Vec<JavaModItem>, String> {
    let mut mods = Vec::new();
    let mut seen_files = HashSet::new();

    prune_legacy_global_mods(root);
    let dirs = [root.join("versions").join(version_id).join("mods")];

    for dir in &dirs {
        if !dir.is_dir() {
            continue;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let file_name = entry.file_name().to_string_lossy().to_string();
            let lower = file_name.to_lowercase();
            let is_jar = lower.ends_with(".jar");
            let is_disabled = lower.ends_with(".disabled") || lower.ends_with(".dis");

            if !is_jar && !is_disabled {
                continue;
            }

            if seen_files.contains(&file_name) {
                continue;
            }
            seen_files.insert(file_name.clone());

            let enabled = !is_disabled;
            let meta = std::fs::metadata(&p).ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let modified_time = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| {
                    let secs = d.as_secs();
                    let dt = chrono_format_timestamp(secs);
                    dt
                })
                .unwrap_or_else(|| "未知时间".to_string());

            let mut mod_id = file_name
                .trim_end_matches(".disabled")
                .trim_end_matches(".dis")
                .trim_end_matches(".jar")
                .to_string();
            let mut mod_name = mod_id.clone();
            let mut mod_version = None;
            let mut mod_desc = None;
            let mut mod_loader = None;
            let mut icon_data_url = None;

            // Read the jar's own metadata: it carries the real display name,
            // version, description and icon, which keeps the list readable even
            // for Forge/NeoForge jars whose file name is a long coordinate.
            if let Ok(file) = std::fs::File::open(&p) {
                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                    let meta = read_jar_mod_metadata(&mut archive);
                    if let Some(id) = meta.id.as_deref().filter(|id| !id.is_empty()) {
                        mod_id = id.to_string();
                    }
                    if let Some(name) = meta.name.as_deref().filter(|name| !name.is_empty()) {
                        mod_name = name.to_string();
                    }
                    mod_version = meta.version.clone();
                    mod_desc = meta.description.clone();
                    mod_loader = meta.loader.clone();
                    icon_data_url =
                        read_mod_icon_data_url(&mut archive, &mod_id, meta.icon_path.as_deref());
                }
            }

            mods.push(JavaModItem {
                id: mod_id,
                name: mod_name,
                file_name,
                path: p.to_string_lossy().to_string(),
                enabled,
                size,
                modified_time,
                version: mod_version,
                description: mod_desc,
                mod_loader,
                icon_data_url,
            });
        }
    }

    mods.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(mods)
}

/// Metadata read out of a mod jar, whichever loader wrote it.
#[derive(Debug, Default)]
struct JarModMetadata {
    id: Option<String>,
    name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    loader: Option<String>,
    /// Path of the icon inside the jar, when the loader metadata names one.
    icon_path: Option<String>,
}

fn read_zip_text(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    use std::io::Read;
    let mut entry = archive.by_name(name).ok()?;
    // Metadata files are tiny; refuse anything that looks like a mislabelled blob.
    if entry.size() > 8 * 1024 * 1024 {
        return None;
    }
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Fabric/Quilt declare `icon` either as a path or as a size -> path map; keep
/// the largest entry so the list gets the sharpest picture available.
fn json_icon_path(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    if let Some(path) = value.as_str() {
        let path = path.trim();
        return (!path.is_empty()).then(|| path.to_string());
    }
    value
        .as_object()?
        .iter()
        .filter_map(|(size, path)| {
            let path = path.as_str()?.trim();
            if path.is_empty() {
                return None;
            }
            Some((size.parse::<u64>().unwrap_or(0), path.to_string()))
        })
        .max_by_key(|(size, _)| *size)
        .map(|(_, path)| path)
}

fn read_jar_mod_metadata(archive: &mut zip::ZipArchive<std::fs::File>) -> JarModMetadata {
    let mut meta = JarModMetadata::default();

    if let Some(text) = read_zip_text(archive, "fabric.mod.json") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            meta.loader = Some("Fabric".to_string());
            meta.id = json_string(&v, "id");
            meta.name = json_string(&v, "name");
            meta.version = json_string(&v, "version");
            meta.description = json_string(&v, "description")
                .map(|d| normalize_mod_description(&d))
                .filter(|d| !d.is_empty());
            meta.icon_path = json_icon_path(v.get("icon"));
            return meta;
        }
    }

    if let Some(text) = read_zip_text(archive, "quilt.mod.json") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            meta.loader = Some("Quilt".to_string());
            if let Some(q) = v.get("quilt_loader") {
                meta.id = json_string(q, "id");
                meta.version = json_string(q, "version");
                if let Some(metadata) = q.get("metadata") {
                    meta.name = json_string(metadata, "name");
                    meta.description = json_string(metadata, "description")
                        .map(|d| normalize_mod_description(&d))
                        .filter(|d| !d.is_empty());
                    meta.icon_path = json_icon_path(metadata.get("icon"));
                }
            }
            return meta;
        }
    }

    for (entry, loader) in [
        ("META-INF/neoforge.mods.toml", "NeoForge"),
        ("META-INF/mods.toml", "Forge"),
    ] {
        if let Some(text) = read_zip_text(archive, entry) {
            meta.loader = Some(loader.to_string());
            if let Some(parsed) = parse_forge_mods_toml(&text) {
                meta.id = parsed.mod_id;
                meta.name = parsed.display_name;
                meta.version = parsed.version;
                meta.description = parsed.description;
                meta.icon_path = parsed.logo_file;
            }
            return meta;
        }
    }

    if let Some(text) = read_zip_text(archive, "mcmod.info") {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            let first = match &v {
                serde_json::Value::Array(items) => items.first().cloned(),
                other => Some(other.clone()),
            };
            if let Some(entry) = first {
                meta.loader = Some("Forge".to_string());
                meta.id = json_string(&entry, "modid");
                meta.name = json_string(&entry, "name");
                meta.version = json_string(&entry, "version");
                meta.description = json_string(&entry, "description")
                    .map(|d| normalize_mod_description(&d))
                    .filter(|d| !d.is_empty());
                meta.icon_path = json_string(&entry, "logoFile");
            }
        }
    }

    meta
}

#[derive(Debug, Default)]
struct ForgeModsToml {
    mod_id: Option<String>,
    display_name: Option<String>,
    version: Option<String>,
    description: Option<String>,
    logo_file: Option<String>,
}

/// Minimal reader for the `[[mods]]` table of `mods.toml`.
///
/// The launcher needs only a handful of fields, so this avoids pulling in a TOML
/// dependency; it understands the value forms mod metadata actually uses: bare
/// values, `"..."`, `'...'` and the multi-line `'''...'''` / `"""..."""`.
fn parse_forge_mods_toml(text: &str) -> Option<ForgeModsToml> {
    let block = first_toml_table(text, "[[mods]]")?;
    let mut out = ForgeModsToml::default();
    let mut offset = 0usize;

    while offset < block.len() {
        let line_end = block[offset..]
            .find('\n')
            .map(|i| offset + i)
            .unwrap_or(block.len());
        let line = &block[offset..line_end];
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            offset = line_end + 1;
            continue;
        }
        let Some(eq) = line.find('=') else {
            offset = line_end + 1;
            continue;
        };
        let key = line[..eq].trim();
        let (value, consumed) = read_toml_value(&block[offset + eq + 1..]);
        offset = offset + eq + 1 + consumed.max(1);

        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        match key {
            "modId" => out.mod_id = Some(value.to_string()),
            "displayName" => out.display_name = Some(value.to_string()),
            "version" => out.version = Some(value.to_string()),
            "description" => out.description = Some(normalize_mod_description(value)),
            "logoFile" => out.logo_file = Some(value.to_string()),
            _ => {}
        }
    }

    Some(out)
}

/// A TOML line without its trailing `#` comment.
fn toml_line_without_comment(line: &str) -> &str {
    let trimmed = line.trim();
    match trimmed.find('#') {
        Some(index) => trimmed[..index].trim(),
        None => trimmed,
    }
}

/// Byte range of the first TOML table with the given header.
fn first_toml_table<'a>(text: &'a str, header: &str) -> Option<&'a str> {
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        if toml_line_without_comment(line) == header {
            let body_start = offset + line.len();
            let mut end = text.len();
            let mut cursor = body_start;
            for next in text[body_start..].split_inclusive('\n') {
                if next.trim_start().starts_with('[') {
                    end = cursor;
                    break;
                }
                cursor += next.len();
            }
            return Some(&text[body_start..end]);
        }
        offset += line.len();
    }
    None
}

/// Reads one TOML value and reports how many bytes of `text` it consumed.
fn read_toml_value(text: &str) -> (String, usize) {
    let start = text.len() - text.trim_start().len();
    let body = &text[start..];

    for delim in ["'''", "\"\"\""] {
        if let Some(inner) = body.strip_prefix(delim) {
            if let Some(end) = inner.find(delim) {
                return (inner[..end].to_string(), start + end + delim.len() * 2);
            }
            return (inner.to_string(), text.len());
        }
    }

    let quote = match body.as_bytes().first().copied() {
        Some(b) if b == b'"' || b == 0x27 => b as char,
        _ => {
            let end = body.find('\n').unwrap_or(body.len());
            let raw = body[..end].split(" #").next().unwrap_or("").trim();
            return (raw.to_string(), start + end);
        }
    };

    let mut out = String::new();
    let mut consumed = 1usize;
    let mut escaped = false;
    for ch in body[1..].chars() {
        consumed += ch.len_utf8();
        if escaped {
            out.push(match ch {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                '\\' => '\\',
                '"' => '"',
                other => other,
            });
            escaped = false;
            continue;
        }
        if ch == '\\' && quote == '"' {
            escaped = true;
            continue;
        }
        if ch == quote {
            return (out, start + consumed);
        }
        out.push(ch);
    }
    (out, text.len())
}

/// Strips Minecraft formatting codes (`§a`, `§l`, …) and collapses whitespace so
/// a description fits on a single list line.
fn normalize_mod_description(text: &str) -> String {
    let mut stripped = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '§' {
            chars.next();
            continue;
        }
        stripped.push(if ch == '\n' || ch == '\r' || ch == '\t' {
            ' '
        } else {
            ch
        });
    }
    let joined = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(280).collect()
}

/// Icons are small; anything larger is almost certainly not one.
const MAX_MOD_ICON_BYTES: u64 = 512 * 1024;

fn image_mime_for_path(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower.ends_with(".gif") {
        Some("image/gif")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else if lower.ends_with(".svg") {
        Some("image/svg+xml")
    } else {
        None
    }
}

fn bytes_look_like_image(bytes: &[u8], mime: &str) -> bool {
    match mime {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G']),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF8"),
        "image/webp" => bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "image/svg+xml" => {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_string();
            head.trim_start_matches('\u{feff}')
                .trim_start()
                .starts_with('<')
        }
        _ => false,
    }
}

/// Pulls a mod's icon out of its jar as a `data:` URL.
///
/// Loader metadata points at the icon (`fabric.mod.json` `icon`, `mods.toml`
/// `logoFile`); everything else is guessed from the conventional locations so a
/// jar without metadata still gets a picture instead of an empty tile.
fn read_mod_icon_data_url(
    archive: &mut zip::ZipArchive<std::fs::File>,
    mod_id: &str,
    declared: Option<&str>,
) -> Option<String> {
    use base64::Engine;
    use std::io::Read;

    let mut candidates: Vec<String> = Vec::new();
    if let Some(declared) = declared {
        let cleaned = declared
            .trim()
            .trim_start_matches("./")
            .trim_start_matches('/');
        if !cleaned.is_empty() {
            candidates.push(cleaned.to_string());
        }
    }
    for name in ["icon.png", "logo.png", "icon.jpg", "logo.jpg"] {
        candidates.push(name.to_string());
    }
    if !mod_id.is_empty() {
        for name in ["icon", "logo"] {
            for ext in ["png", "jpg", "jpeg", "gif", "webp"] {
                candidates.push(format!("assets/{mod_id}/{name}.{ext}"));
            }
        }
    }

    for candidate in candidates {
        let Some(mime) = image_mime_for_path(&candidate) else {
            continue;
        };
        let Ok(mut entry) = archive.by_name(&candidate) else {
            continue;
        };
        let size = entry.size();
        if size == 0 || size > MAX_MOD_ICON_BYTES {
            continue;
        }
        let mut bytes = Vec::with_capacity(size as usize);
        if entry.read_to_end(&mut bytes).is_err() {
            continue;
        }
        if !bytes_look_like_image(&bytes, mime) {
            continue;
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Some(format!("data:{mime};base64,{encoded}"));
    }

    None
}

fn chrono_format_timestamp(secs: u64) -> String {
    let days = secs / 86400;
    let rem_secs = secs % 86400;
    let hours = rem_secs / 3600;
    let minutes = (rem_secs % 3600) / 60;
    // Simple year-month-day approximation since UNIX epoch
    let mut year = 1970;
    let mut day_count = days;
    loop {
        let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
        let days_in_year = if is_leap { 366 } else { 365 };
        if day_count >= days_in_year {
            day_count -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }
    let is_leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    let month_days = [
        31,
        if is_leap { 29 } else { 28 },
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
    for &d in &month_days {
        if day_count >= d {
            day_count -= d;
            month += 1;
        } else {
            break;
        }
    }
    let day = day_count + 1;
    format!("{year:04}-{month:02}-{day:02} {hours:02}:{minutes:02}")
}

pub fn toggle_java_mod(
    root: &Path,
    version_id: &str,
    file_name: &str,
    enable: bool,
) -> Result<(), String> {
    let dirs = [resolve_java_mods_dir(root, version_id)];

    for dir in &dirs {
        let target = dir.join(file_name);
        if target.is_file() {
            let new_name = if enable {
                if file_name.ends_with(".disabled") {
                    file_name.trim_end_matches(".disabled").to_string()
                } else if file_name.ends_with(".dis") {
                    file_name.trim_end_matches(".dis").to_string()
                } else {
                    file_name.to_string()
                }
            } else {
                if !file_name.ends_with(".disabled") && !file_name.ends_with(".dis") {
                    format!("{file_name}.disabled")
                } else {
                    file_name.to_string()
                }
            };

            let new_path = dir.join(&new_name);
            if new_path != target {
                std::fs::rename(&target, &new_path)
                    .map_err(|e| format!("重命名模组文件失败: {e}"))?;
            }
            return Ok(());
        }
    }

    Err(format!("未找到指定模组文件: {file_name}"))
}

pub fn delete_java_mod(root: &Path, version_id: &str, file_name: &str) -> Result<(), String> {
    let dirs = [resolve_java_mods_dir(root, version_id)];

    for dir in &dirs {
        let target = dir.join(file_name);
        if target.is_file() {
            std::fs::remove_file(&target).map_err(|e| format!("删除模组文件失败: {e}"))?;
            return Ok(());
        }
    }

    Err(format!("未找到指定模组文件: {file_name}"))
}

pub fn install_java_mod_file(
    root: &Path,
    version_id: &str,
    src_path: &Path,
) -> Result<String, String> {
    if !src_path.is_file() {
        return Err("源模组文件不存在".to_string());
    }
    let file_name = src_path
        .file_name()
        .ok_or_else(|| "源文件名无效".to_string())?
        .to_string_lossy()
        .to_string();

    let target_dir = root.join("versions").join(version_id).join("mods");
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建模组目录失败: {e}"))?;

    let dest = target_dir.join(&file_name);
    std::fs::copy(src_path, &dest).map_err(|e| format!("复制模组文件失败: {e}"))?;

    Ok(format!("已成功安装模组: {file_name}"))
}

// ---------------------------------------------------------------------------
// Java Resource Packs & Worlds
// ---------------------------------------------------------------------------
//
// Both live in the game directory the instance is actually launched with
// (`versions/<id>` for isolated versions, the shared root when isolation is off),
// unlike mods which this launcher always keeps inside the instance. Java also
// records the *enabled* pack list in `options.txt`, so the manager edits that
// list instead of only renaming files: a pack sitting on disk is still off in
// game until the game is told to load it.

/// Game directory Java reads for this instance, mirroring the launch code.
pub fn resolve_java_game_dir(root: &Path, version_id: &str, isolation: Option<&str>) -> PathBuf {
    let root = net::absolute_path(root);
    let instance = root.join("versions").join(version_id);
    match isolation
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("all")
    {
        "none" => root,
        "modded" => {
            if version_dir_is_modded(&instance) {
                instance
            } else {
                root
            }
        }
        _ => instance,
    }
}

/// Whether the installed version carries a mod loader, read from its own json.
fn version_dir_is_modded(instance: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(instance) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(detail) = serde_json::from_str::<VersionDetail>(&text) {
            return is_modded_version(&detail);
        }
        let lower = text.to_lowercase();
        if ["fabric", "forge", "quilt", "optifine"]
            .iter()
            .any(|marker| lower.contains(marker))
        {
            return true;
        }
    }
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaPackItem {
    /// File (or folder) name inside `resourcepacks`, unique per instance.
    pub id: String,
    pub name: String,
    pub file_name: String,
    pub path: String,
    pub enabled: bool,
    pub size: u64,
    pub modified_time: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub pack_format: Option<i64>,
    #[serde(default)]
    pub icon_data_url: Option<String>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaWorldItem {
    /// Save folder name, unique per game directory.
    pub id: String,
    pub name: String,
    pub folder: String,
    pub path: String,
    pub size: u64,
    pub modified_time: String,
    #[serde(default)]
    pub icon_data_url: Option<String>,
}

fn file_modified_text(meta: &std::fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|delta| chrono_format_timestamp(delta.as_secs()))
        .unwrap_or_else(|| "未知时间".to_string())
}

fn dir_total_size(dir: &Path, depth: u8) -> u64 {
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
                total += dir_total_size(&entry.path(), depth + 1);
            } else {
                total += meta.len();
            }
        }
    }
    total
}

fn read_text_lines(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .map(|text| {
            text.lines()
                .map(|line| line.trim_end_matches('\r').to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn write_text_lines(path: &Path, lines: &[String]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建游戏目录失败: {e}"))?;
    }
    let mut text = lines.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    std::fs::write(path, text).map_err(|e| format!("写入 {} 失败: {e}", path.display()))
}

/// `zh-CN` / `ZH_cn` / `zh` -> `zh_cn`.
///
/// Minecraft stores locales as `<language>_<region>` in lower case, so anything
/// else the user may type has to be normalised before it reaches `options.txt`
/// (`lang:zh-CN` is not a language the game knows).
fn normalize_locale(raw: &str) -> Option<String> {
    let cleaned = raw.trim().replace('-', "_");
    if cleaned.is_empty() {
        return None;
    }
    let mut parts = cleaned.split('_');
    let language = parts.next()?.to_ascii_lowercase();
    if language.len() < 2
        || language.len() > 3
        || !language.chars().all(|c| c.is_ascii_alphabetic())
    {
        return None;
    }
    let region = parts.next().unwrap_or("").to_ascii_lowercase();
    if region.is_empty() {
        return Some(language);
    }
    if region.len() < 2 || region.len() > 4 || !region.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(format!("{language}_{region}"))
}

/// Applies the language picked in the version settings to the folder the game
/// actually runs in, returning the code that was written.
///
/// It must be the `LaunchSpec::cwd` (the resolved `--gameDir`), not always
/// `versions/<id>`: with "no isolation" the game reads the root `options.txt`,
/// and writing anywhere else would look like the setting did nothing.
pub fn apply_launch_language(game_dir: &Path, language: Option<&str>) -> Option<String> {
    let code = normalize_locale(language?)?;
    apply_game_language(game_dir, &code);
    Some(code)
}

/// Writes `lang:<code>` into the instance's `options.txt`.
///
/// Java rewrites options.txt whenever the player changes something in game, and
/// only reads it on start-up, so an explicit locale here means "start in this
/// language" without touching any other option.
fn apply_game_language(game_dir: &Path, code: &str) {
    let options_path = game_dir.join("options.txt");
    let mut lines = read_text_lines(&options_path);
    let entry = format!("lang:{code}");
    match lines.iter_mut().find(|line| line.starts_with("lang:")) {
        Some(line) => *line = entry,
        None => lines.push(entry),
    }
    let _ = write_text_lines(&options_path, &lines);
}

/// Read one `key:[...]` JSON array out of `options.txt` lines.
fn options_json_list(lines: &[String], key: &str) -> Option<Vec<String>> {
    let prefix = format!("{key}:");
    lines.iter().find_map(|line| {
        let rest = line.strip_prefix(&prefix)?;
        serde_json::from_str::<Vec<String>>(rest.trim()).ok()
    })
}

fn set_options_json_list(lines: &mut Vec<String>, key: &str, values: &[String]) {
    let serialized = serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string());
    let prefix = format!("{key}:");
    for line in lines.iter_mut() {
        if line.starts_with(&prefix) {
            *line = format!("{prefix}{serialized}");
            return;
        }
    }
    lines.push(format!("{prefix}{serialized}"));
}

/// Resource packs selected in `options.txt`, with the game default as fallback.
fn selected_resource_packs(game_dir: &Path) -> Vec<String> {
    let lines = read_text_lines(&game_dir.join("options.txt"));
    options_json_list(&lines, "resourcePacks").unwrap_or_else(|| vec!["vanilla".to_string()])
}

/// One selected-pack entry points at this file/folder.
///
/// The game writes pack ids as `file/<name>`; older or hand-edited options.txt
/// files sometimes carry the bare name, so both forms are recognised.
fn resource_pack_entry_matches(entry: &str, file_name: &str) -> bool {
    entry
        .trim()
        .trim_start_matches("file/")
        .eq_ignore_ascii_case(file_name)
}

#[derive(Deserialize)]
struct PackMcmetaFile {
    pack: Option<PackMetaSection>,
}

#[derive(Deserialize)]
struct PackMetaSection {
    #[serde(default)]
    pack_format: Option<i64>,
    #[serde(default)]
    description: Option<serde_json::Value>,
}

/// `description` is either a plain string or a chat component tree.
fn pack_description_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => normalize_mod_description(text),
        serde_json::Value::Array(items) => {
            let joined: String = items.iter().map(pack_description_text).collect();
            normalize_mod_description(&joined)
        }
        serde_json::Value::Object(map) => {
            let mut parts = String::new();
            if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                parts.push_str(text);
            }
            if let Some(extra) = map.get("extra") {
                parts.push_str(&pack_description_text(extra));
            }
            normalize_mod_description(&parts)
        }
        _ => String::new(),
    }
}

fn parse_pack_mcmeta(text: &str) -> (Option<i64>, String) {
    let Ok(parsed) = serde_json::from_str::<PackMcmetaFile>(text) else {
        return (None, String::new());
    };
    let Some(pack) = parsed.pack else {
        return (None, String::new());
    };
    (
        pack.pack_format,
        pack.description
            .as_ref()
            .map(pack_description_text)
            .unwrap_or_default(),
    )
}

fn image_file_data_url(path: &Path) -> Option<String> {
    use base64::Engine;

    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_MOD_ICON_BYTES {
        return None;
    }
    let mime = image_mime_for_path(&path.to_string_lossy())?;
    let bytes = std::fs::read(path).ok()?;
    if !bytes_look_like_image(&bytes, mime) {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn zip_image_data_url(archive: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Option<String> {
    use base64::Engine;
    use std::io::Read;

    let mime = image_mime_for_path(name)?;
    let mut entry = archive.by_name(name).ok()?;
    if entry.size() == 0 || entry.size() > MAX_MOD_ICON_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut bytes).ok()?;
    if !bytes_look_like_image(&bytes, mime) {
        return None;
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

pub fn get_java_resource_packs(
    root: &Path,
    version_id: &str,
    isolation: Option<&str>,
) -> Vec<JavaPackItem> {
    let game_dir = resolve_java_game_dir(root, version_id, isolation);
    let packs_dir = game_dir.join("resourcepacks");
    let Ok(entries) = std::fs::read_dir(&packs_dir) else {
        return Vec::new();
    };
    let selected = selected_resource_packs(&game_dir);
    let mut packs = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let lower = file_name.to_lowercase();
        if file_name.starts_with('.') {
            continue;
        }
        // `name.zip.disabled` files are leftovers from launchers that toggled
        // packs by renaming; Minecraft never loads them.
        if lower.ends_with(".disabled") || lower.ends_with(".dis") {
            continue;
        }
        let is_dir = path.is_dir();
        if !is_dir && !lower.ends_with(".zip") {
            continue;
        }

        let (name, description, pack_format, icon) = if is_dir {
            let meta_text = std::fs::read_to_string(path.join("pack.mcmeta")).ok();
            let (format, description) = meta_text
                .as_deref()
                .map(parse_pack_mcmeta)
                .unwrap_or((None, String::new()));
            (
                file_name.clone(),
                description,
                format,
                image_file_data_url(&path.join("pack.png")),
            )
        } else {
            let mut found = (file_name.clone(), String::new(), None, None);
            if let Ok(file) = std::fs::File::open(&path) {
                if let Ok(mut archive) = zip::ZipArchive::new(file) {
                    if let Some(text) = read_zip_text(&mut archive, "pack.mcmeta") {
                        let (format, description) = parse_pack_mcmeta(&text);
                        found.1 = description;
                        found.2 = format;
                    }
                    found.3 = zip_image_data_url(&mut archive, "pack.png");
                }
            }
            found
        };

        let meta = entry.metadata().ok();
        let size = match &meta {
            Some(meta) if meta.is_dir() => dir_total_size(&path, 0),
            Some(meta) => meta.len(),
            None => 0,
        };
        let modified_time = meta
            .as_ref()
            .map(file_modified_text)
            .unwrap_or_else(|| "未知时间".to_string());
        let enabled = selected
            .iter()
            .any(|item| resource_pack_entry_matches(item, &file_name));

        packs.push(JavaPackItem {
            id: file_name.clone(),
            name,
            file_name,
            path: path.to_string_lossy().to_string(),
            enabled,
            size,
            modified_time,
            description,
            pack_format,
            icon_data_url: icon,
            is_dir,
        });
    }

    packs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    packs
}

/// Enabled/disabled state of a Java resource pack lives in `options.txt`, so
/// this rewrites that one list instead of touching the pack files.
pub fn toggle_java_resource_pack(
    root: &Path,
    version_id: &str,
    file_name: &str,
    enable: bool,
    isolation: Option<&str>,
) -> Result<(), String> {
    let game_dir = resolve_java_game_dir(root, version_id, isolation);
    let safe_name = Path::new(file_name)
        .file_name()
        .ok_or_else(|| "资源包名称无效".to_string())?
        .to_string_lossy()
        .to_string();
    if safe_name != file_name {
        return Err("资源包名称无效".to_string());
    }
    if !game_dir.join("resourcepacks").join(&safe_name).exists() {
        return Err(format!("未找到资源包: {safe_name}"));
    }

    let options_path = game_dir.join("options.txt");
    let mut lines = read_text_lines(&options_path);
    let entry = format!("file/{safe_name}");
    let mut packs =
        options_json_list(&lines, "resourcePacks").unwrap_or_else(|| vec!["vanilla".to_string()]);

    if enable {
        if !packs
            .iter()
            .any(|pack| resource_pack_entry_matches(pack, &safe_name))
        {
            packs.push(entry.clone());
        }
    } else {
        packs.retain(|pack| !resource_pack_entry_matches(pack, &safe_name));
    }
    set_options_json_list(&mut lines, "resourcePacks", &packs);

    // An incompatible pack stays "on" through the other list, so drop it there
    // too when it is turned off.
    if let Some(mut incompatible) = options_json_list(&lines, "incompatibleResourcePacks") {
        let before = incompatible.len();
        incompatible.retain(|pack| !resource_pack_entry_matches(pack, &safe_name));
        if incompatible.len() != before {
            set_options_json_list(&mut lines, "incompatibleResourcePacks", &incompatible);
        }
    }

    write_text_lines(&options_path, &lines)
}

pub fn delete_java_resource_pack(
    root: &Path,
    version_id: &str,
    file_name: &str,
    isolation: Option<&str>,
) -> Result<(), String> {
    let game_dir = resolve_java_game_dir(root, version_id, isolation);
    let path = game_dir.join("resourcepacks").join(file_name);
    if path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        != Some(file_name.to_string())
    {
        return Err("资源包名称无效".to_string());
    }
    if path.is_dir() {
        crate::bedrock::force_remove_dir_all(&path).map_err(|e| format!("删除资源包失败: {e}"))?;
    } else if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("删除资源包失败: {e}"))?;
    } else {
        return Err(format!("未找到资源包: {file_name}"));
    }

    // A deleted pack must not stay selected in options.txt.
    let options_path = game_dir.join("options.txt");
    if options_path.is_file() {
        let mut lines = read_text_lines(&options_path);
        if let Some(mut packs) = options_json_list(&lines, "resourcePacks") {
            let before = packs.len();
            packs.retain(|pack| !resource_pack_entry_matches(pack, file_name));
            if packs.len() != before {
                set_options_json_list(&mut lines, "resourcePacks", &packs);
                write_text_lines(&options_path, &lines)?;
            }
        }
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("创建目录失败: {e}"))?;
    let entries = std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if from.is_file() {
            std::fs::copy(&from, &to).map_err(|e| format!("复制文件失败: {e}"))?;
        }
    }
    Ok(())
}

fn unique_target(parent: &Path, stem: &str) -> PathBuf {
    let mut dest = parent.join(stem);
    let mut suffix = 2;
    while dest.exists() && suffix < 1000 {
        dest = parent.join(format!("{stem}_{suffix}"));
        suffix += 1;
    }
    dest
}

pub fn install_java_resource_pack_file(
    root: &Path,
    version_id: &str,
    file_path: &str,
    isolation: Option<&str>,
) -> Result<String, String> {
    let game_dir = resolve_java_game_dir(root, version_id, isolation);
    let packs_dir = game_dir.join("resourcepacks");
    std::fs::create_dir_all(&packs_dir).map_err(|e| format!("创建资源包目录失败: {e}"))?;

    let source = net::absolute_path(Path::new(file_path));
    if source.is_dir() {
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "resourcepack".to_string());
        let dest = unique_target(&packs_dir, &name);
        copy_dir_recursive(&source, &dest)?;
        return Ok(format!("已导入资源包文件夹: {}", dest.display()));
    }
    if !source.is_file() {
        return Err(format!("资源包文件不存在: {file_path}"));
    }
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "resourcepack.zip".to_string());
    if !name.to_lowercase().ends_with(".zip") {
        return Err("请选择 .zip 资源包或包含 pack.mcmeta 的文件夹".to_string());
    }
    let dest = packs_dir.join(&name);
    if dest.exists() {
        return Err(format!("资源包里已经有同名文件: {name}"));
    }
    std::fs::copy(&source, &dest).map_err(|e| format!("复制资源包失败: {e}"))?;
    Ok(format!("已导入资源包: {}", dest.display()))
}

pub fn get_java_worlds(
    root: &Path,
    version_id: &str,
    isolation: Option<&str>,
) -> Vec<JavaWorldItem> {
    let game_dir = resolve_java_game_dir(root, version_id, isolation);
    let saves_dir = game_dir.join("saves");
    let Ok(entries) = std::fs::read_dir(&saves_dir) else {
        return Vec::new();
    };

    let mut worlds = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("level.dat").is_file() {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().to_string();
        let name = std::fs::read_to_string(path.join("levelname.txt"))
            .map(|text| normalize_mod_description(&text))
            .ok()
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| folder.clone());
        let meta = entry.metadata().ok();
        worlds.push(JavaWorldItem {
            id: folder.clone(),
            name,
            folder,
            path: path.to_string_lossy().to_string(),
            size: dir_total_size(&path, 0),
            modified_time: meta
                .as_ref()
                .map(file_modified_text)
                .unwrap_or_else(|| "未知时间".to_string()),
            icon_data_url: image_file_data_url(&path.join("icon.png")),
        });
    }

    worlds.sort_by(|a, b| b.modified_time.cmp(&a.modified_time));
    worlds
}

pub fn delete_java_world(
    root: &Path,
    version_id: &str,
    folder: &str,
    isolation: Option<&str>,
) -> Result<(), String> {
    let game_dir = resolve_java_game_dir(root, version_id, isolation);
    let saves_dir = game_dir.join("saves");
    let target = saves_dir.join(folder);
    if target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        != Some(folder.to_string())
        || !target.is_dir()
        || !target.join("level.dat").is_file()
    {
        return Err(format!("未找到存档: {folder}"));
    }
    crate::bedrock::force_remove_dir_all(&target).map_err(|e| format!("删除存档失败: {e}"))
}

/// Extract a world archive into `dest`, dropping the wrapper folder when the
/// archive wraps the files in one directory (the shape `.zip` exports use).
fn extract_world_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    use std::io::Read;

    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开存档压缩包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取存档压缩包失败: {e}"))?;
    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|entry| entry.name().to_string())
        })
        .collect();

    let prefix = names
        .iter()
        .find_map(|name| {
            let lower = name.to_lowercase();
            if lower == "level.dat" {
                return Some(String::new());
            }
            if lower.ends_with("/level.dat") {
                let parent = &name[..name.len() - "/level.dat".len()];
                if !parent.contains('/') {
                    return Some(format!("{parent}/"));
                }
            }
            None
        })
        .ok_or_else(|| "压缩包里没有 level.dat，这不是我的世界存档".to_string())?;

    std::fs::create_dir_all(dest).map_err(|e| format!("创建存档目录失败: {e}"))?;
    for name in &names {
        if !name.starts_with(&prefix) {
            continue;
        }
        let relative = &name[prefix.len()..];
        if relative.is_empty() || relative.starts_with("__MACOSX/") {
            continue;
        }
        let safe = Path::new(relative)
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)));
        if !safe {
            return Err("存档压缩包包含非法路径".to_string());
        }
        let target = dest.join(relative);
        if name.ends_with('/') {
            std::fs::create_dir_all(&target).map_err(|e| format!("创建存档目录失败: {e}"))?;
            continue;
        }
        let mut entry = archive
            .by_name(name)
            .map_err(|e| format!("读取存档文件失败: {e}"))?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建存档目录失败: {e}"))?;
        }
        let mut out =
            std::fs::File::create(&target).map_err(|e| format!("写入存档文件失败: {e}"))?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|e| format!("读取存档文件失败: {e}"))?;
            if read == 0 {
                break;
            }
            std::io::Write::write_all(&mut out, &buffer[..read])
                .map_err(|e| format!("写入存档文件失败: {e}"))?;
        }
    }
    Ok(())
}

pub fn install_java_world_file(
    root: &Path,
    version_id: &str,
    file_path: &str,
    isolation: Option<&str>,
) -> Result<String, String> {
    let game_dir = resolve_java_game_dir(root, version_id, isolation);
    let saves_dir = game_dir.join("saves");
    std::fs::create_dir_all(&saves_dir).map_err(|e| format!("创建存档目录失败: {e}"))?;

    let source = net::absolute_path(Path::new(file_path));
    if source.is_dir() {
        if !source.join("level.dat").is_file() {
            return Err("所选文件夹里没有 level.dat，请选择存档文件夹本身".to_string());
        }
        let name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "world".to_string());
        let dest = unique_target(&saves_dir, &name);
        copy_dir_recursive(&source, &dest)?;
        return Ok(format!("已导入存档: {}", dest.display()));
    }
    if !source.is_file() {
        return Err(format!("存档文件不存在: {file_path}"));
    }
    let name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "world.zip".to_string());
    if !name.to_lowercase().ends_with(".zip") {
        return Err("请选择 .zip 存档或存档文件夹".to_string());
    }
    let stem = Path::new(&name)
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "world".to_string());
    let dest = unique_target(&saves_dir, &stem);
    extract_world_zip(&source, &dest)?;
    Ok(format!("已导入存档: {}", dest.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_known_and_unknown_arguments() {
        let mut vars = HashMap::new();
        vars.insert("natives_directory".to_string(), "C:\\natives".to_string());
        vars.insert("classpath".to_string(), "a.jar;b.jar".to_string());
        assert_eq!(
            substitute("-Djava.library.path=${natives_directory}/java", &vars),
            "-Djava.library.path=C:\\natives/java"
        );
        assert_eq!(substitute("${missing}", &vars), "");
        assert_eq!(substitute("plain", &vars), "plain");
    }

    fn version_from(json: serde_json::Value) -> VersionDetail {
        serde_json::from_value(json).expect("version detail")
    }

    #[test]
    fn window_size_is_only_passed_to_versions_that_accept_it() {
        let beta = version_from(serde_json::json!({
            "id": "b1.7.3",
            "mainClass": "net.minecraft.client.Minecraft",
            "minecraftArguments": "${auth_player_name} ${auth_session} --gameDir ${game_directory} --assetsDir ${game_assets}"
        }));
        assert!(!window_size_supported(&beta));

        let old = version_from(serde_json::json!({
            "id": "1.5.2",
            "mainClass": "net.minecraft.client.Minecraft",
            "minecraftArguments": "${auth_player_name} ${auth_session} --gameDir ${game_directory} --assetsDir ${game_assets}"
        }));
        assert!(!window_size_supported(&old));

        let newer = version_from(serde_json::json!({
            "id": "1.7.10",
            "mainClass": "net.minecraft.client.Minecraft",
            "minecraftArguments": "--username ${auth_player_name} --version ${version_name}"
        }));
        assert!(window_size_supported(&newer));

        let snapshot = version_from(serde_json::json!({
            "id": "13w16a",
            "mainClass": "net.minecraft.client.Minecraft",
            "minecraftArguments": "--username ${auth_player_name}"
        }));
        assert!(window_size_supported(&snapshot));

        let older_snapshot = version_from(serde_json::json!({
            "id": "12w40a",
            "mainClass": "net.minecraft.client.Minecraft",
            "minecraftArguments": "--username ${auth_player_name}"
        }));
        assert!(!window_size_supported(&older_snapshot));

        let modern = version_from(serde_json::json!({
            "id": "inf-20100227-1433",
            "mainClass": "uk.betacraft.legacyfix.LegacyFixLauncher",
            "arguments": { "game": [], "jvm": [] }
        }));
        assert!(window_size_supported(&modern));
    }

    #[test]
    fn strips_empty_window_arguments_from_legacy_metadata() {
        let mut args: Vec<String> = [
            "--username",
            "Steve",
            "--width",
            "",
            "--height",
            "",
            "--version",
            "1.5.2",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        strip_empty_window_args(&mut args);
        assert_eq!(args, vec!["--username", "Steve", "--version", "1.5.2"]);
    }

    #[test]
    fn keeps_a_custom_window_size() {
        let mut args: Vec<String> = ["--width", "1280", "--height", "720"]
            .iter()
            .map(|value| value.to_string())
            .collect();
        strip_empty_window_args(&mut args);
        assert_eq!(args, vec!["--width", "1280", "--height", "720"]);
    }

    #[test]
    fn respects_conditional_argument_features() {
        let args: Vec<ArgumentValue> = serde_json::from_value(serde_json::json!([
            "--username",
            "${auth_player_name}",
            {
                "rules": [{ "action": "allow", "features": { "has_custom_resolution": true } }],
                "value": ["--width", "${resolution_width}", "--height", "${resolution_height}"]
            }
        ]))
        .unwrap();
        let mut vars = HashMap::new();
        vars.insert("auth_player_name".to_string(), "Steve".to_string());
        vars.insert("resolution_width".to_string(), "854".to_string());
        vars.insert("resolution_height".to_string(), "480".to_string());

        let without = collect_arguments(&args, &HashMap::new(), &vars);
        assert_eq!(without, vec!["--username", "Steve"]);

        let mut features = HashMap::new();
        features.insert("has_custom_resolution".to_string(), true);
        let with = collect_arguments(&args, &features, &vars);
        assert_eq!(
            with,
            vec!["--username", "Steve", "--width", "854", "--height", "480"]
        );
    }

    #[test]
    fn offline_uuid_is_deterministic() {
        assert_eq!(
            offline_uuid("Steve"),
            "5627dd98-e6be-3c21-b8a8-e92344183641"
        );
        assert_ne!(offline_uuid("Steve"), offline_uuid("Alex"));
    }

    #[test]
    fn online_accounts_replace_offline_credentials() {
        let request = |auth: Option<LaunchAuth>| LaunchRequest {
            version_id: "1.21.8".to_string(),
            root: "C:\\games".to_string(),
            player_name: "OfflineName".to_string(),
            memory_mb: None,
            java_path: None,
            width: None,
            height: None,
            skin_type: None,
            custom_skin_path: None,
            custom_skin_model: None,
            mojang_skin_name: None,
            version_isolation: None,
            window_title: None,
            custom_info: None,
            launcher_visibility: None,
            process_priority: None,
            window_size: None,
            jvm_args: None,
            language: None,
            auth,
            offline: false,
        };

        let offline = auth_vars(&request(None), "offline-uuid", "OfflineName");
        assert_eq!(offline.access_token, "0");
        assert_eq!(offline.user_type, "legacy");
        assert_eq!(offline.uuid, "offline-uuid");
        assert!(offline.xuid.is_empty());
        assert!(offline.client_id.is_empty());

        let online = auth_vars(
            &request(Some(LaunchAuth {
                access_token: "mc-session".to_string(),
                uuid: "069a79f444e94726a5befca90e38aaf5".to_string(),
                name: "Notch".to_string(),
                xuid: Some("2535410000000000".to_string()),
                client_id: Some("launcher-client".to_string()),
            })),
            "offline-uuid",
            "OfflineName",
        );
        assert_eq!(online.access_token, "mc-session");
        // The profile identity wins: the game rejects a mismatched name/UUID
        // against the session token.
        assert_eq!(online.name, "Notch");
        assert_eq!(online.uuid, "069a79f444e94726a5befca90e38aaf5");
        assert_eq!(online.user_type, "msa");
        assert_eq!(online.xuid, "2535410000000000");
        assert_eq!(online.client_id, "launcher-client");

        // A session without profile fields must not produce empty arguments.
        let partial = auth_vars(
            &request(Some(LaunchAuth {
                access_token: "token".to_string(),
                uuid: "  ".to_string(),
                name: String::new(),
                xuid: None,
                client_id: None,
            })),
            "offline-uuid",
            "OfflineName",
        );
        assert_eq!(partial.name, "OfflineName");
        assert_eq!(partial.uuid, "offline-uuid");
        assert_eq!(partial.user_type, "msa");
    }

    #[test]
    fn player_name_validation() {
        assert!(valid_player_name("Steve_01"));
        assert!(!valid_player_name(""));
        assert!(!valid_player_name("Steve Smith"));
        assert!(!valid_player_name("Steve-01"));
        assert!(!valid_player_name("12345678901234567"));
    }

    #[test]
    fn maven_coordinates_build_a_download_path() {
        let (path, url, _, _) =
            maven_artifact_from_name("org.lwjgl:lwjgl:3.4.3:natives-windows").unwrap();
        assert_eq!(
            path,
            "org/lwjgl/lwjgl/3.4.3/lwjgl-3.4.3-natives-windows.jar"
        );
        assert!(url.starts_with("https://libraries.minecraft.net/"));

        let (f_path, f_url, _, _) =
            maven_artifact_from_name("net.minecraftforge:forgespi:8.0.0").unwrap();
        assert_eq!(
            f_path,
            "net/minecraftforge/forgespi/8.0.0/forgespi-8.0.0.jar"
        );
        assert!(f_url.starts_with("https://maven.minecraftforge.net/"));

        let artifact = Artifact {
            path: Some(
                "net/minecraftforge/forge/1.21.11-61.2.4/forge-1.21.11-61.2.4-client.jar"
                    .to_string(),
            ),
            url: Some("".to_string()),
            sha1: None,
            size: None,
        };
        assert!(artifact_job(
            &artifact,
            Path::new("test"),
            "net.minecraftforge:forge:1.21.11-61.2.4:client"
        )
        .is_none());
    }

    #[test]
    fn test_betacraft_manifest_parsing_and_mapping() {
        let sample_json = r#"{
            "trim_at": "1.7.10",
            "versions": [
                {
                    "id": "b1.7.3",
                    "url": "https://files.betacraft.uk/launcher/v2/assets/jsons/b1.7.3.json",
                    "releaseTime": "2011-07-08T07:43:51+00:00",
                    "time": "2011-07-08T07:32:16+00:00",
                    "protocolVersion": "beta_14",
                    "type": "release",
                    "phase": "beta"
                },
                {
                    "id": "c0.0.14a_08",
                    "url": "https://files.betacraft.uk/launcher/v2/assets/jsons/c0.0.14a_08.json",
                    "releaseTime": "2009-05-28T20:37:40+00:00",
                    "time": "2009-05-28T20:37:40+00:00",
                    "type": "release",
                    "phase": "classic"
                }
            ]
        }"#;

        let parsed: BetaCraftManifest = serde_json::from_str(sample_json).unwrap();
        assert_eq!(parsed.versions.len(), 2);
        assert_eq!(parsed.versions[0].id, "b1.7.3");
        assert_eq!(parsed.versions[0].phase.as_deref(), Some("beta"));
        assert_eq!(parsed.versions[1].id, "c0.0.14a_08");
        assert_eq!(parsed.versions[1].phase.as_deref(), Some("classic"));
    }

    #[test]
    fn betacraft_asset_urls_are_used_before_the_mojang_cdn() {
        let index: AssetIndex = serde_json::from_str(
            r#"{
                "objects": {
                    "newsound/random/bow.ogg": {
                        "hash": "f1b527e059bb4abe3aed3acf6b5eb96f40b07f67",
                        "size": 8589,
                        "url": "https://resources.betacraft.uk/f1/f1b527e059bb4abe3aed3acf6b5eb96f40b07f67"
                    },
                    "sound/random/click.ogg": {
                        "hash": "022e48005197b37f0caa53e8051c8a266eeae15e",
                        "size": 9796
                    }
                }
            }"#,
        )
        .unwrap();

        let betacraft_object = &index.objects["newsound/random/bow.ogg"];
        assert_eq!(
            asset_object_url(&betacraft_object.hash, betacraft_object),
            "https://resources.betacraft.uk/f1/f1b527e059bb4abe3aed3acf6b5eb96f40b07f67"
        );

        let plain_object = &index.objects["sound/random/click.ogg"];
        assert_eq!(
            asset_object_url(&plain_object.hash, plain_object),
            "https://resources.download.minecraft.net/02/022e48005197b37f0caa53e8051c8a266eeae15e"
        );
    }

    #[test]
    fn betacraft_classifier_comment_does_not_break_parsing() {
        // Verbatim shape from Betacraft's 1.6.4 version JSON.
        let downloads: LibraryDownloads = serde_json::from_str(
            r#"{
                "classifiers": {
                    "__comment": "Add arm natives for linux and windows",
                    "natives-windows": {
                        "path": "org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar",
                        "sha1": "33b2a5c2d5d0a6a0f2a5b0b0ad1c8bb1e3e2f6a2",
                        "size": 1234,
                        "url": "https://libraries.minecraft.net/org/lwjgl/lwjgl/lwjgl-platform/2.9.4-nightly-20150209/lwjgl-platform-2.9.4-nightly-20150209-natives-windows.jar"
                    }
                }
            }"#,
        )
        .unwrap();

        let classifiers = downloads.classifiers.unwrap();
        assert_eq!(classifiers.len(), 1);
        assert!(classifiers.contains_key("natives-windows"));
    }

    #[test]
    fn library_conflict_key_preserves_classifiers_and_filters_foreign_arch() {
        let base_lwjgl = Library {
            name: "org.lwjgl:lwjgl:3.3.3".to_string(),
            downloads: None,
            url: None,
            sha1: None,
            size: None,
            natives: None,
            rules: Vec::new(),
        };
        let natives_lwjgl = Library {
            name: "org.lwjgl:lwjgl:3.3.3:natives-windows".to_string(),
            downloads: None,
            url: None,
            sha1: None,
            size: None,
            natives: None,
            rules: Vec::new(),
        };
        assert_ne!(
            library_conflict_key(&base_lwjgl),
            library_conflict_key(&natives_lwjgl)
        );
        assert!(native_library_matches_current_arch(
            "org.lwjgl:lwjgl:3.3.3:natives-windows"
        ));
        #[cfg(target_arch = "x86_64")]
        {
            assert!(!native_library_matches_current_arch(
                "org.lwjgl:lwjgl:3.3.3:natives-windows-x86"
            ));
            assert!(!native_library_matches_current_arch(
                "org.lwjgl:lwjgl:3.3.3:natives-windows-arm64"
            ));
        }
    }

    #[test]
    fn test_java_mod_management() {
        let temp_dir = std::env::temp_dir().join(format!(
            "oml_test_jmods_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let ver_mods = temp_dir.join("versions").join("1.20.1-Fabric").join("mods");
        std::fs::create_dir_all(&ver_mods).unwrap();
        let mod_file = ver_mods.join("test_mod.jar");
        std::fs::write(&mod_file, b"dummy jar").unwrap();

        // Check get_java_mods
        let list = get_java_mods(&temp_dir, "1.20.1-Fabric").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].file_name, "test_mod.jar");
        assert!(list[0].enabled);

        // Toggle disabled
        toggle_java_mod(&temp_dir, "1.20.1-Fabric", "test_mod.jar", false).unwrap();
        let list2 = get_java_mods(&temp_dir, "1.20.1-Fabric").unwrap();
        assert_eq!(list2.len(), 1);
        assert_eq!(list2[0].file_name, "test_mod.jar.disabled");
        assert!(!list2[0].enabled);

        // Toggle enabled
        toggle_java_mod(&temp_dir, "1.20.1-Fabric", "test_mod.jar.disabled", true).unwrap();
        let list3 = get_java_mods(&temp_dir, "1.20.1-Fabric").unwrap();
        assert_eq!(list3.len(), 1);
        assert_eq!(list3[0].file_name, "test_mod.jar");
        assert!(list3[0].enabled);

        // Delete mod
        delete_java_mod(&temp_dir, "1.20.1-Fabric", "test_mod.jar").unwrap();
        let list4 = get_java_mods(&temp_dir, "1.20.1-Fabric").unwrap();
        assert_eq!(list4.len(), 0);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_forge_mods_toml_parsing() {
        // Mirrors the shape real Forge jars ship: CRLF endings, trailing `#`
        // comments after every value and after the table header itself.
        let text = concat!(
            "modLoader = \"javafml\" #mandatory\r\n",
            "license = \"All Rights Reserved\" # comment\r\n",
            "[[mods]] #mandatory\r\n",
            "modId = \"xaerominimap\" #mandatory\r\n",
            "version = \"26.6.0\" #mandatory\r\n",
            "displayName = \"Xaero's Minimap\" #mandatory\r\n",
            "logoFile = \"assets/xaerominimap/icon.png\"\r\n",
            "description = '''A minimap for Minecraft.\r\n",
            "It shows §epoints of interest§r on the map.''' #mandatory\r\n",
            "[[dependencies.xaerominimap]] #optional\r\n",
            "    modId = \"forge\" #mandatory\r\n",
        );

        let parsed = parse_forge_mods_toml(text).expect("mods table");
        assert_eq!(parsed.mod_id.as_deref(), Some("xaerominimap"));
        assert_eq!(parsed.display_name.as_deref(), Some("Xaero's Minimap"));
        assert_eq!(parsed.version.as_deref(), Some("26.6.0"));
        assert_eq!(
            parsed.logo_file.as_deref(),
            Some("assets/xaerominimap/icon.png")
        );
        assert_eq!(
            parsed.description.as_deref(),
            Some("A minimap for Minecraft. It shows points of interest on the map.")
        );
    }

    #[test]
    fn test_java_mod_icon_and_forge_metadata() {
        use std::io::Write;

        let temp_dir = std::env::temp_dir().join(format!(
            "oml_test_modicon_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let mods_dir = temp_dir.join("versions").join("1.21.1-forge").join("mods");
        std::fs::create_dir_all(&mods_dir).unwrap();

        let png: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, b'I', b'H', b'D', b'R',
        ];

        let jar_path = mods_dir.join("xaerominimap-forge-1.21.1-26.6.0.jar");
        {
            let file = std::fs::File::create(&jar_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            writer.start_file("META-INF/mods.toml", options).unwrap();
            writer
                .write_all(
                    br#"[[mods]]
modId="xaerominimap"
version="26.6.0"
displayName="Xaero's Minimap"
logoFile="assets/xaerominimap/icon.png"
description="A minimap."
"#,
                )
                .unwrap();
            writer
                .start_file("assets/xaerominimap/icon.png", options)
                .unwrap();
            writer.write_all(png).unwrap();
            writer.finish().unwrap();
        }

        let list = get_java_mods(&temp_dir, "1.21.1-forge").unwrap();
        assert_eq!(list.len(), 1);
        let item = &list[0];
        assert_eq!(item.name, "Xaero's Minimap");
        assert_eq!(item.version.as_deref(), Some("26.6.0"));
        assert_eq!(item.mod_loader.as_deref(), Some("Forge"));
        assert_eq!(item.description.as_deref(), Some("A minimap."));
        let icon = item.icon_data_url.as_deref().expect("icon extracted");
        assert!(icon.starts_with("data:image/png;base64,"), "{icon}");

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    fn temp_test_dir(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "{prefix}_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Isolated instances read `versions/<id>`, but turning isolation off moves
    /// the game directory (packs, saves, screenshots) back to the shared root.
    #[test]
    fn game_dir_follows_version_isolation() {
        let temp = temp_test_dir("oml_test_gamedir");
        let instance = temp.join("versions").join("1.20.1-fabric");
        std::fs::create_dir_all(&instance).unwrap();
        std::fs::write(
            instance.join("1.20.1-fabric.json"),
            r#"{"id":"1.20.1-fabric","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[]}"#,
        )
        .unwrap();
        let vanilla = temp.join("versions").join("1.20.1");
        std::fs::create_dir_all(&vanilla).unwrap();
        std::fs::write(
            vanilla.join("1.20.1.json"),
            r#"{"id":"1.20.1","mainClass":"net.minecraft.client.main.Main","libraries":[]}"#,
        )
        .unwrap();

        assert_eq!(
            resolve_java_game_dir(&temp, "1.20.1-fabric", Some("all")),
            net::absolute_path(&instance)
        );
        assert_eq!(
            resolve_java_game_dir(&temp, "1.20.1-fabric", Some("none")),
            net::absolute_path(&temp)
        );
        // Only modded instances are isolated in "modded" mode.
        assert_eq!(
            resolve_java_game_dir(&temp, "1.20.1-fabric", Some("modded")),
            net::absolute_path(&instance)
        );
        assert_eq!(
            resolve_java_game_dir(&temp, "1.20.1", Some("modded")),
            net::absolute_path(&temp)
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// Java enables resource packs through `options.txt`; the manager edits that
    /// list instead of renaming files, and deletion clears the entry too.
    #[test]
    fn resource_pack_toggle_edits_options_txt() {
        let temp = temp_test_dir("oml_test_packs");
        let instance = temp.join("versions").join("1.20.1-fabric");
        let pack_dir = instance.join("resourcepacks").join("Cartoon");
        std::fs::create_dir_all(&pack_dir).unwrap();
        std::fs::write(
            pack_dir.join("pack.mcmeta"),
            r#"{"pack":{"pack_format":15,"description":{"text":"Cartoon","extra":[]}}}"#,
        )
        .unwrap();
        std::fs::write(
            pack_dir.join("pack.png"),
            [0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
        )
        .unwrap();
        std::fs::write(
            instance.join("options.txt"),
            "lang:zh_cn\nfov:0.5\nresourcePacks:[\"vanilla\"]\n",
        )
        .unwrap();

        let listed = get_java_resource_packs(&temp, "1.20.1-fabric", Some("all"));
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Cartoon");
        assert_eq!(listed[0].pack_format, Some(15));
        assert!(!listed[0].enabled);
        assert!(listed[0]
            .icon_data_url
            .as_deref()
            .unwrap_or_default()
            .starts_with("data:image/png;base64,"));

        // A hand-edited options.txt may list the bare name instead of
        // `file/<name>`; both mean the same pack.
        std::fs::write(
            instance.join("options.txt"),
            "resourcePacks:[\"vanilla\",\"Cartoon\"]\n",
        )
        .unwrap();
        assert!(get_java_resource_packs(&temp, "1.20.1-fabric", Some("all"))[0].enabled);
        std::fs::write(
            instance.join("options.txt"),
            "lang:zh_cn\nfov:0.5\nresourcePacks:[\"vanilla\"]\n",
        )
        .unwrap();

        toggle_java_resource_pack(&temp, "1.20.1-fabric", "Cartoon", true, Some("all")).unwrap();
        let options = std::fs::read_to_string(instance.join("options.txt")).unwrap();
        assert!(
            options.contains("resourcePacks:[\"vanilla\",\"file/Cartoon\"]"),
            "{options}"
        );
        // Unrelated options survive the rewrite.
        assert!(options.contains("lang:zh_cn") && options.contains("fov:0.5"));
        assert!(get_java_resource_packs(&temp, "1.20.1-fabric", Some("all"))[0].enabled);

        toggle_java_resource_pack(&temp, "1.20.1-fabric", "Cartoon", false, Some("all")).unwrap();
        let options = std::fs::read_to_string(instance.join("options.txt")).unwrap();
        assert!(options.contains("resourcePacks:[\"vanilla\"]"), "{options}");
        assert!(!get_java_resource_packs(&temp, "1.20.1-fabric", Some("all"))[0].enabled);

        delete_java_resource_pack(&temp, "1.20.1-fabric", "Cartoon", Some("all")).unwrap();
        assert!(!pack_dir.exists());
        assert!(get_java_resource_packs(&temp, "1.20.1-fabric", Some("all")).is_empty());

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// The language picked in the version settings must be in `options.txt`
    /// before Java starts: the game only reads `lang:` at start-up.
    #[test]
    fn game_language_is_written_into_options_txt() {
        let temp = temp_test_dir("oml_test_lang");
        std::fs::create_dir_all(&temp).unwrap();
        std::fs::write(
            temp.join("options.txt"),
            "lang:en_us\nfov:0.5\nresourcePacks:[\"vanilla\"]\n",
        )
        .unwrap();

        assert_eq!(normalize_locale("ZH-CN").as_deref(), Some("zh_cn"));
        assert_eq!(normalize_locale(" ja_jp ").as_deref(), Some("ja_jp"));
        assert_eq!(normalize_locale("en").as_deref(), Some("en"));
        assert_eq!(normalize_locale(""), None);
        assert_eq!(normalize_locale("not a locale!"), None);

        apply_game_language(&temp, "zh_cn");
        let options = std::fs::read_to_string(temp.join("options.txt")).unwrap();
        assert!(options.contains("lang:zh_cn"), "{options}");
        assert!(!options.contains("lang:en_us"), "{options}");
        // Only the language changes; every other option is preserved.
        assert!(options.contains("fov:0.5"), "{options}");
        assert!(options.contains("resourcePacks:[\"vanilla\"]"), "{options}");

        // A version that was never started has no options.txt yet: the option
        // is created and nothing else is invented.
        let fresh = temp.join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        apply_game_language(&fresh, "ja_jp");
        assert_eq!(
            std::fs::read_to_string(fresh.join("options.txt"))
                .unwrap()
                .trim(),
            "lang:ja_jp"
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    /// A world zip that wraps everything in one folder (what `.zip` exports
    /// produce) must land directly in `saves/<name>`, with `level.dat` on top.
    #[test]
    fn world_zip_import_strips_wrapper_folder() {
        use std::io::Write;

        let temp = temp_test_dir("oml_test_worlds");
        let zip_path = temp.join("Skyblock.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            writer.start_file("Skyblock/level.dat", options).unwrap();
            writer.write_all(b"nbt").unwrap();
            writer
                .start_file("Skyblock/levelname.txt", options)
                .unwrap();
            writer.write_all("空岛生存".as_bytes()).unwrap();
            writer.finish().unwrap();
        }

        install_java_world_file(&temp, "1.20.1", &zip_path.to_string_lossy(), Some("all")).unwrap();

        let worlds = get_java_worlds(&temp, "1.20.1", Some("all"));
        assert_eq!(worlds.len(), 1);
        assert_eq!(worlds[0].name, "空岛生存");
        assert!(PathBuf::from(&worlds[0].path).join("level.dat").is_file());

        // Only the save folder itself can be deleted; a case-mismatched or
        // traversing name is refused instead of removing something else.
        assert!(delete_java_world(&temp, "1.20.1", "../versions", Some("all")).is_err());
        delete_java_world(&temp, "1.20.1", &worlds[0].folder, Some("all")).unwrap();
        assert!(get_java_worlds(&temp, "1.20.1", Some("all")).is_empty());

        let _ = std::fs::remove_dir_all(&temp);
    }
}
