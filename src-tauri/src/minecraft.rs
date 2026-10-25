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
    #[serde(rename = "clientVersion", default, skip_serializing_if = "Option::is_none")]
    pub mc_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loader: Option<String>,
    #[serde(rename = "loaderVersion", default, skip_serializing_if = "Option::is_none")]
    pub loader_version: Option<String>,
    #[serde(rename = "optifineVersion", default, skip_serializing_if = "Option::is_none")]
    pub optifine_version: Option<String>,
    #[serde(rename = "fabricApiVersion", default, skip_serializing_if = "Option::is_none")]
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
    pub classifiers: Option<HashMap<String, Artifact>>,
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
        let response = net::client()
            .get(VERSION_MANIFEST_URL)
            .send()
            .await
            .map_err(|e| format!("无法连接 Mojang 版本服务: {e}"))?;
        if !response.status().is_success() {
            return Err(format!("版本清单请求失败: HTTP {}", response.status()));
        }
        let text = response
            .text()
            .await
            .map_err(|e| format!("读取版本清单失败: {e}"))?;
        let manifest: VersionManifest =
            serde_json::from_str(&text).map_err(|e| format!("版本清单解析失败: {e}"))?;
        Ok::<_, String>((manifest, text))
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
                .unwrap_or(false);
        if !jar_exists {
            continue;
        }
        let parsed_detail = std::fs::read_to_string(&json_path)
            .ok()
            .and_then(|text| serde_json::from_str::<VersionDetail>(&text).ok());
        let version_type = parsed_detail
            .as_ref()
            .and_then(|detail| detail.version_type.clone())
            .unwrap_or_else(|| "release".to_string());
        let mc_version = parsed_detail.as_ref().and_then(|d| d.mc_version.clone());
        let loader = parsed_detail.as_ref().and_then(|d| d.loader.clone());
        let loader_version = parsed_detail.as_ref().and_then(|d| d.loader_version.clone());
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
    safe_version_id(version_id)?;
    let root = net::absolute_path(root);
    let target = versions_dir(&root).join(version_id);
    if target.is_dir() {
        tokio::fs::remove_dir_all(&target)
            .await
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
    serde_json::from_str::<VersionDetail>(&text).map_err(|e| format!("版本信息解析失败: {e}"))
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
    let url = format!("{LIBRARIES_URL}/{rel}");
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
    let url = artifact
        .url
        .clone()
        .or_else(|| maven_artifact_from_name(name).map(|(_, url, _, _)| url))?;
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

    for lib in &version.libraries {
        if !rules_allow(&lib.rules, features) {
            continue;
        }

        let downloads = lib.downloads.as_ref();
        let mut native_jar = None;

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
            if let Some(job) = artifact_job(artifact, &libraries, &lib.name) {
                if seen.insert(job.dest.clone()) {
                    plan.classpath.push(job.dest.clone());
                    plan.jobs.push(job);
                }
            }
        } else if downloads.is_none() {
            if let Some((rel, default_url, _, classifier)) = maven_artifact_from_name(&lib.name) {
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
    fn new(
        version_id: &str,
        threads: usize,
        has_addons: bool,
        progress: ProgressFn,
    ) -> Arc<Self> {
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

        let mut stages_snapshot = self
            .stages
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();

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

                    let downloaded_res = net::download_file_multithreaded(
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
            if name.starts_with("META-INF/") || name.contains("..") {
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

    let mut need_download = true;
    if net::looks_complete(&index_path, index_ref.size) {
        if let Some(expected) = &index_ref.sha1 {
            if let Ok(actual) = net::sha1_file(&index_path).await {
                need_download = !actual.eq_ignore_ascii_case(expected);
            }
        } else {
            need_download = false;
        }
    }
    if need_download {
        net::download_file(
            &index_ref.url,
            &index_path,
            index_ref.sha1.as_deref(),
            index_ref.size,
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
            .or_insert_with(|| object.clone());
    }

    let objects_dir = assets_dir(root).join("objects");
    let mut jobs = Vec::with_capacity(unique.len());
    let mut total_bytes: u64 = 0;
    for (hash, object) in &unique {
        let prefix = hash.get(0..2).unwrap_or("00");
        total_bytes += object.size;
        jobs.push(FileJob {
            url: format!("{RESOURCES_URL}/{prefix}/{hash}"),
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

    download_jobs_with_tracker(
        prepared.jobs,
        "assets",
        tracker,
        concurrency,
        worker_offset,
    )
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

    let res = net::download_file_multithreaded(
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
    tracker.emit_now(
        "client",
        total.max(1),
        total.max(1),
        "客户端下载完成",
    );
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
    safe_version_id(version_id)?;

    let selection = selection.unwrap_or_default();
    let instance_id = selection
        .instance_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(version_id)
        .to_string();
    safe_version_id(&instance_id)?;

    let has_addons = selection.has_any_addon();
    let prepare_steps = if has_addons { 4 } else { 3 };
    let threads = concurrency.unwrap_or(DEFAULT_DOWNLOAD_THREADS).clamp(1, 64);

    let tracker = DownloadTracker::new(&instance_id, threads, has_addons, progress);
    tracker.emit_now("prepare", 0, prepare_steps, "读取版本清单");

    let mut manifest = fetch_manifest(root, false).await?;
    if !manifest
        .versions
        .iter()
        .any(|version| version.id == version_id)
    {
        manifest = fetch_manifest(root, true).await?;
    }
    let summary = manifest
        .versions
        .iter()
        .find(|v| v.id == version_id)
        .ok_or_else(|| format!("版本清单中找不到 {version_id}"))?;
    tracker.add_stage_completed("prepare", 1, 0);
    tracker.emit_now(
        "prepare",
        1,
        prepare_steps,
        format!("解析版本配置 {version_id}.json"),
    );

    let mut version = load_version(root, summary).await?;
    if version.inherits_from.is_some() {
        tracker.set_stage_status("prepare", "error");
        return Err("暂不支持安装基于 inheritsFrom 的模组版本".to_string());
    }
    tracker.add_stage_completed("prepare", 1, 0);

    let instance_dir = game_dir(root, &instance_id);
    tokio::fs::create_dir_all(&instance_dir)
        .await
        .map_err(|e| format!("无法创建游戏目录: {e}"))?;

    version.mc_version = Some(version_id.to_string());
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
        tracker.emit_now(
            "prepare",
            2,
            prepare_steps,
            "获取模组加载器与附加工具配置",
        );
        let extra_mods = crate::loaders::prepare_addons(
            root,
            &instance_dir,
            version_id,
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
    let serialized = serde_json::to_string_pretty(&version)
        .map_err(|e| format!("序列化版本配置失败: {e}"))?;
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
        tracker.set_stage_plan(
            "addons",
            (extra_mod_jobs.len() as u64).max(1),
            addon_bytes,
        );
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

    let client_threads = if threads <= 4 { 1 } else { 2.min(threads / 8).max(2) };
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
            download_client_with_tracker(&root, &version, &tracker, client_threads, client_offset).await?;
            let _ = download_log_config(&root, &version).await?;
            Ok::<(), String>(())
        }
    };

    let libraries_task = {
        let tracker = tracker.clone();
        let plan = plan.clone();
        let instance_dir = instance_dir.clone();
        async move {
            tracker.emit_now(
                "libraries",
                0,
                plan.jobs.len() as u64,
                "准备依赖库",
            );
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

    let (_client_res, libs_res, assets_res, _addons_res) = tokio::try_join!(
        client_task,
        libraries_task,
        assets_task,
        addons_task
    )?;

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

async fn fetch_mojang_textures(name: &str) -> Option<(String, String, String)> {
    let profile_url = format!("https://api.mojang.com/users/profiles/minecraft/{name}");
    let resp = tokio::time::timeout(
        Duration::from_secs(3),
        net::client().get(&profile_url).send(),
    )
    .await
    .ok()?
    .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let val: serde_json::Value = resp.json().await.ok()?;
    let id = val.get("id")?.as_str()?;

    let session_url = format!(
        "https://sessionserver.mojang.com/session/minecraft/profile/{id}?unsigned=false"
    );
    let s_resp = tokio::time::timeout(
        Duration::from_secs(3),
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
            let sig = prop.get("signature").and_then(|s| s.as_str()).unwrap_or("").to_string();
            return Some((val, sig, id.to_string()));
        }
    }
    None
}

async fn setup_custom_skin_pack(root: &Path, version_id: &str, skin_path: &Path) {
    let pack_dir = game_dir(root, version_id).join("resourcepacks").join("OfflineSkinPack");
    let wide_dir = pack_dir.join("assets").join("minecraft").join("textures").join("entity").join("player").join("wide");
    let slim_dir = pack_dir.join("assets").join("minecraft").join("textures").join("entity").join("player").join("slim");
    let legacy_dir = pack_dir.join("assets").join("minecraft").join("textures").join("entity");

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
                let updated = content.replace("resourcePacks:[", "resourcePacks:[\"file/OfflineSkinPack\",");
                let _ = tokio::fs::write(&options_txt, updated).await;
            }
        } else {
            let updated = format!("{content}\nresourcePacks:[\"file/OfflineSkinPack\",\"vanilla\"]\n");
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
    if cfg!(windows) { ";" } else { ":" }
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

fn resolve_libraries(root: &Path, version: &VersionDetail) -> Vec<PathBuf> {
    let features = HashMap::new();
    plan_libraries(root, version, &features).classpath
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

pub fn build_launch_spec(
    root: &Path,
    version: &VersionDetail,
    java: PathBuf,
    java_major: u32,
    request: &LaunchRequest,
    user_properties_override: Option<String>,
    mojang_uuid_override: Option<String>,
) -> Result<LaunchSpec, String> {
    let player_name = request.player_name.trim();
    if !valid_player_name(player_name) {
        return Err("游戏昵称只能包含英文字母、数字和下划线，长度 1-16 位".to_string());
    }

    let instance_dir = game_dir(root, &version.id);
    if !instance_dir.is_dir() {
        return Err("版本尚未安装完成".to_string());
    }
    if !instance_dir.join(format!("{}.jar", version.id)).is_file() {
        return Err("客户端 jar 不存在，请重新安装该版本".to_string());
    }

    let mut features = HashMap::new();
    let custom_resolution = request
        .width
        .zip(request.height)
        .filter(|(w, h)| *w >= 320 && *h >= 240);
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
    let uuid = mojang_uuid_override.unwrap_or_else(|| offline_uuid_with_skin(player_name, Some(skin_type)));
    let assets_index_name = version
        .asset_index
        .as_ref()
        .map(|i| i.id.clone())
        .or_else(|| version.assets.clone())
        .unwrap_or_else(|| "legacy".to_string());

    let mut classpath = resolve_libraries(root, version);
    classpath.push(instance_dir.join(format!("{}.jar", version.id)));
    let classpath_string = classpath
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(classpath_separator());

    let natives_dir = instance_dir.join("natives");
    std::fs::create_dir_all(&natives_dir).map_err(|e| format!("无法创建 natives 目录: {e}"))?;

    let mut vars: HashMap<String, String> = HashMap::new();
    let insert = |vars: &mut HashMap<String, String>, k: &str, v: String| {
        vars.insert(k.to_string(), v);
    };
    insert(&mut vars, "auth_player_name", player_name.to_string());
    insert(&mut vars, "version_name", version.id.clone());
    insert(
        &mut vars,
        "game_directory",
        instance_dir.to_string_lossy().to_string(),
    );
    insert(
        &mut vars,
        "assets_root",
        assets_dir(root).to_string_lossy().to_string(),
    );
    insert(&mut vars, "game_assets", asset_game_dir(root, version));
    insert(&mut vars, "assets_index_name", assets_index_name);
    insert(&mut vars, "auth_uuid", uuid.clone());
    insert(&mut vars, "auth_access_token", "0".to_string());
    insert(&mut vars, "auth_session", format!("token:0:{uuid}"));
    insert(&mut vars, "user_type", "legacy".to_string());
    let user_props = user_properties_override.unwrap_or_else(|| "{}".to_string());
    insert(&mut vars, "user_properties", user_props);
    insert(&mut vars, "clientid", String::new());
    insert(&mut vars, "auth_xuid", String::new());
    insert(
        &mut vars,
        "version_type",
        version
            .version_type
            .clone()
            .unwrap_or_else(|| "release".to_string()),
    );
    insert(&mut vars, "launcher_name", "Cobble".to_string());
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
    ];

    if let Some(arguments) = &version.arguments {
        let version_jvm = collect_arguments(&arguments.jvm, &features, &vars);
        for arg in version_jvm {
            if arg.starts_with("-Xmx") || arg.starts_with("-Xms") {
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
        game_args.extend(["--accessToken".into(), "0".into()]);
    }

    let mut args = jvm_args;
    args.extend(game_args);

    Ok(LaunchSpec {
        java,
        args,
        cwd: instance_dir,
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
        Ok(text) => serde_json::from_str::<VersionDetail>(&text)
            .map_err(|e| format!("本地版本信息损坏: {e}"))?,
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
    } else if skin_type == "mojang" {
        let target_name = request
            .mojang_skin_name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&request.player_name);
        if let Some((val, sig, raw_uuid)) = fetch_mojang_textures(target_name).await {
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
                mojang_uuid_override = Some(format!(
                    "{}-{}-{}-{}-{}",
                    &raw_uuid[0..8],
                    &raw_uuid[8..12],
                    &raw_uuid[12..16],
                    &raw_uuid[16..20],
                    &raw_uuid[20..32]
                ));
            }
        }
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
    }
}
