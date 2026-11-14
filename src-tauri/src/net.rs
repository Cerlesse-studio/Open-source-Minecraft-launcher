//! HTTP 基础层与 Mojang 官方源解析。
//!
//! 重构后本模块只保留"网络传输"职责：通用/直连 reqwest 客户端、JSON 拉取、
//! Mojang 官方清单解析。下载引擎（多线程分段、断点续传、镜像轮换、限速、
//! 源健康管理）已迁至 [`crate::download`]，按 rayburst 的模块化架构分层；
//! 下方 `pub use` 兼容层让既有调用方在迁移完成前继续使用 `net::` 路径。

use futures_util::stream::FuturesUnordered;
use futures_util::StreamExt;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CobbleLauncher/0.1.7";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
/// 下载专用：强制直连，忽略系统代理（见 `direct_client`）。
static DIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 通用客户端：接口请求、登录、版本清单都走它，系统代理对它生效。
pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| build_client(false))
}

/// 下载专用客户端：刻意绕开系统代理。
///
/// 系统代理（Clash / Surge 等写入的 `HTTP_PROXY`、`HTTPS_PROXY`）会把每一条
/// 分片连接都绕到远端节点再回来，而 Minecraft 的下载源——官方 CDN、BMCLAPI、
/// 各类 maven 镜像——本身直连就很快；开着代理时整体吞吐往往只剩直连的五分之一。
/// 下载是大流量长连接，绕一圈没有任何好处，所以这里用 `.no_proxy()` 强制直连。
/// 直连确实不通时，下载入口会用带系统代理的 `client()` 再跑一遍
/// （见 `download::engine::proxy_retry_worthwhile`）。
pub fn direct_client() -> &'static reqwest::Client {
    DIRECT_CLIENT.get_or_init(|| build_client(true))
}

fn build_client(direct: bool) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .pool_max_idle_per_host(128)
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600));
    if direct {
        builder = builder.no_proxy();
    }
    builder.build().expect("failed to build http client")
}

/// 优先走直连（绕过系统代理）发起 GET 请求；仅当直连在连接/超时阶段失败时回退到系统代理客户端。
pub async fn get_prefer_direct(
    url: &str,
    timeout: Duration,
) -> Result<reqwest::Response, reqwest::Error> {
    match direct_client().get(url).timeout(timeout).send().await {
        Ok(resp) => Ok(resp),
        Err(err) if err.is_connect() || err.is_timeout() || err.is_request() => {
            client().get(url).timeout(timeout).send().await
        }
        Err(err) => Err(err),
    }
}

// ---------------------------------------------------------------------------
// 下载设置与统计（薄包装，转发给 download::limit）
// ---------------------------------------------------------------------------

/// PCL2 `NetTaskSpeedLimitHigh`: `0` removes the cap (the default).
pub fn set_download_speed_limit(bytes_per_sec: u64) {
    crate::download::set_speed_limit(bytes_per_sec);
}

pub fn download_speed_limit() -> Option<u64> {
    crate::download::speed_limit()
}

/// PCL2 `NetTaskThreadCount`, for the download progress view.
pub fn download_active_threads() -> u32 {
    crate::download::active_threads()
}

// ---------------------------------------------------------------------------
// 下载引擎兼容层：旧 `net::` 路径继续可用（阶段 3 迁移调用点后移除）。
// ---------------------------------------------------------------------------

pub use crate::download::engine::{
    download_file, download_file_with_mirrors, download_file_multithreaded,
    download_file_resumable,
};
pub use crate::download::resume::{resume_progress, resume_sidecar_path};
pub use crate::download::segments::recommended_segments;
pub use crate::download::source::{
    download_threads, get_mirror_urls, per_file_threads, preferred_urls, probe_download_sources,
    set_download_preference, DownloadSourceProbe,
};
pub use crate::download::speed::SpeedSmoother;
pub use crate::download::verify::{looks_complete, sha1_file};

// ---------------------------------------------------------------------------
// JSON 拉取
// ---------------------------------------------------------------------------

/// Trim a response body to a short, char-boundary-safe snippet for messages.
fn body_snippet(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    let mut snippet: String = trimmed.chars().take(160).collect();
    if trimmed.chars().count() > 160 {
        snippet.push('…');
    }
    snippet
}

/// GET a JSON document, retrying transient failures.
///
/// `timeout` applies to the whole exchange including the body, so it must be
/// generous: a Modrinth version list can be over a megabyte, and a body that
/// is cut off mid-transfer only shows up as an opaque decode error otherwise.
pub async fn fetch_json<T: serde::de::DeserializeOwned>(
    url: &str,
    timeout: Duration,
    attempts: u32,
) -> Result<T, String> {
    let attempts = attempts.max(1);
    let mut last_error = String::from("未知错误");

    for attempt in 1..=attempts {
        let response = match get_prefer_direct(url, timeout).await {
            Ok(response) => response,
            Err(err) => {
                last_error = crate::download::error::describe_error(&err);
                if attempt < attempts && (err.is_timeout() || err.is_connect() || err.is_request())
                {
                    tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
                    continue;
                }
                return Err(last_error);
            }
        };

        let status = response.status();
        if !status.is_success() {
            last_error = format!("HTTP {status}");
            let retryable =
                status.is_server_error() || status.as_u16() == 408 || status.as_u16() == 429;
            if attempt < attempts && retryable {
                tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
                continue;
            }
            return Err(last_error);
        }

        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => {
                last_error = crate::download::error::describe_error(&err);
                if attempt < attempts
                    && (err.is_timeout() || err.is_body() || err.is_decode() || err.is_request())
                {
                    tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
                    continue;
                }
                return Err(last_error);
            }
        };

        // A complete body that still fails to deserialize is a schema problem,
        // not a network one, so surface it instead of burning retries.
        return serde_json::from_slice::<T>(&bytes)
            .map_err(|err| format!("响应格式不匹配: {err}；内容开头: {}", body_snippet(&bytes)));
    }

    Err(last_error)
}

// ---------------------------------------------------------------------------
// Official Mojang sources for the Java Edition game body
// ---------------------------------------------------------------------------

/// Both hosts serve the same `version_manifest_v2.json`; `launchermeta` is
/// often faster on congested links, so they are raced.
pub const OFFICIAL_MANIFEST_HOSTS: [&str; 2] =
    ["piston-meta.mojang.com", "launchermeta.mojang.com"];
pub const OFFICIAL_MANIFEST_PATH: &str = "/mc/game/version_manifest_v2.json";
/// Mojang's CDN hosts are NOT interchangeable. Live probes for 1.20.1:
/// - `/v1/objects/<sha1>/client.jar` -> only `piston-data` (others 404)
/// - `/v1/packages/<hash>/<id>.json` -> `piston-meta` + `launchermeta`
pub const OFFICIAL_OBJECT_HOSTS: [&str; 1] = ["piston-data.mojang.com"];
pub const OFFICIAL_PACKAGE_HOSTS: [&str; 2] = ["piston-meta.mojang.com", "launchermeta.mojang.com"];

#[derive(Deserialize)]
struct OfficialManifest {
    versions: Vec<OfficialManifestVersion>,
}

#[derive(Deserialize)]
struct OfficialManifestVersion {
    id: String,
    url: String,
}

#[derive(Deserialize)]
struct OfficialVersionJson {
    #[serde(default)]
    downloads: Option<OfficialDownloads>,
}

#[derive(Deserialize)]
struct OfficialDownloads {
    #[serde(default)]
    client: Option<OfficialArtifact>,
}

#[derive(Deserialize)]
struct OfficialArtifact {
    url: String,
    #[serde(default)]
    sha1: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// Official URLs and checksums for one vanilla Java version.
#[derive(Debug, Clone, Default)]
pub struct OfficialVanillaArtifacts {
    /// Official version JSON URLs, preferred host first.
    pub json_urls: Vec<String>,
    /// Official `client.jar` URL.
    pub client_url: Option<String>,
    pub client_sha1: Option<String>,
    pub client_size: Option<u64>,
}

/// Map an official artifact URL onto the CDN hostnames that actually serve
/// that path (`/v1/objects` vs `/v1/packages`).
pub fn official_object_url_variants(url: &str) -> Vec<String> {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return Vec::new();
    };
    let Some(host) = parsed.host_str() else {
        return Vec::new();
    };
    let hosts: &[&str] = if parsed.path().starts_with("/v1/packages/") {
        &OFFICIAL_PACKAGE_HOSTS
    } else {
        &OFFICIAL_OBJECT_HOSTS
    };
    if !hosts.contains(&host) {
        return Vec::new();
    }
    let mut variants = Vec::new();
    for candidate in hosts {
        let mut rewritten = parsed.clone();
        if rewritten.set_host(Some(candidate)).is_err() {
            continue;
        }
        let value = rewritten.to_string();
        if !variants.contains(&value) {
            variants.push(value);
        }
    }
    variants
}

fn official_artifacts_cache()
-> &'static std::sync::Mutex<std::collections::HashMap<String, OfficialVanillaArtifacts>> {
    static CACHE: OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, OfficialVanillaArtifacts>>,
    > = OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

async fn fetch_official_manifest() -> Option<OfficialManifest> {
    let mut pending = FuturesUnordered::new();
    for host in OFFICIAL_MANIFEST_HOSTS {
        let url = format!("https://{host}{OFFICIAL_MANIFEST_PATH}");
        pending.push(async move {
            fetch_json::<OfficialManifest>(&url, Duration::from_secs(20), 1).await
        });
    }
    while let Some(result) = pending.next().await {
        if let Ok(manifest) = result {
            return Some(manifest);
        }
    }
    None
}

/// Resolve Mojang's official `client.jar` / version JSON for a vanilla
/// version. Returns an empty struct when the official catalogue is
/// unreachable, so callers can still fall back to BMCLAPI. Results are cached
/// per version id for the lifetime of the core process.
pub async fn official_vanilla_artifacts(version_id: &str) -> OfficialVanillaArtifacts {
    let version_id = version_id.trim();
    if version_id.is_empty() {
        return OfficialVanillaArtifacts::default();
    }
    if let Ok(cache) = official_artifacts_cache().lock() {
        if let Some(cached) = cache.get(version_id) {
            return cached.clone();
        }
    }

    let resolved = resolve_official_vanilla_artifacts(version_id).await;
    if let Ok(mut cache) = official_artifacts_cache().lock() {
        cache.insert(version_id.to_string(), resolved.clone());
    }
    resolved
}

async fn resolve_official_vanilla_artifacts(version_id: &str) -> OfficialVanillaArtifacts {
    let Some(manifest) = fetch_official_manifest().await else {
        return OfficialVanillaArtifacts::default();
    };
    let Some(entry) = manifest
        .versions
        .iter()
        .find(|version| version.id == version_id)
    else {
        return OfficialVanillaArtifacts::default();
    };

    let variants = official_object_url_variants(&entry.url);
    let json_urls = if variants.is_empty() {
        vec![entry.url.clone()]
    } else {
        variants
    };

    let mut result = OfficialVanillaArtifacts {
        json_urls: json_urls.clone(),
        ..Default::default()
    };
    for url in &json_urls {
        let Ok(version) = fetch_json::<OfficialVersionJson>(url, Duration::from_secs(20), 1).await
        else {
            continue;
        };
        if let Some(client) = version.downloads.and_then(|downloads| downloads.client) {
            let client_variants = official_object_url_variants(&client.url);
            result.client_url = Some(
                client_variants
                    .first()
                    .cloned()
                    .unwrap_or_else(|| client.url.clone()),
            );
            result.client_sha1 = client.sha1;
            result.client_size = client.size;
        }
        break;
    }
    result
}

// ---------------------------------------------------------------------------
// 通用路径工具
// ---------------------------------------------------------------------------

pub fn absolute_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_artifact_url_variants_follow_path_specific_hosts() {
        let packages = official_object_url_variants(
            "https://piston-meta.mojang.com/v1/packages/abc123/1.20.1.json",
        );
        assert_eq!(packages.len(), OFFICIAL_PACKAGE_HOSTS.len());
        assert!(packages[0].starts_with("https://piston-meta.mojang.com/"));
        assert!(
            packages
                .iter()
                .any(|v| v.starts_with("https://launchermeta.mojang.com/"))
        );

        let objects = official_object_url_variants(
            "https://piston-data.mojang.com/v1/objects/abc123/client.jar",
        );
        assert_eq!(objects.len(), OFFICIAL_OBJECT_HOSTS.len());
        assert_eq!(
            objects[0],
            "https://piston-data.mojang.com/v1/objects/abc123/client.jar"
        );
        assert!(
            official_object_url_variants("https://bmclapi2.bangbang93.com/version/1.20.1/client")
                .is_empty()
        );
    }
}
