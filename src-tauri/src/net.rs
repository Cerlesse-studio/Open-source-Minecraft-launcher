use futures_util::StreamExt;
use futures_util::future::try_join_all;
use reqwest::header::RANGE;
use sha1::{Digest, Sha1};
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::fs;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

pub const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CobbleLauncher/0.0.7";

/// Files at or above 1 MB are eligible for multi-segment HTTP Range downloading.
const MIN_MULTITHREAD_SIZE: u64 = 1_048_576;
/// Each HTTP Range segment downloads at least 512 KB.
const MIN_SEGMENT_SIZE: u64 = 512 * 1024;
/// Maximum retries per file or segment before failing.
const MAX_RETRIES: u32 = 3;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Chosen mirror family, optional custom base URL and the thread count used by
/// downloads that do not carry their own (mods, resource packs, pack archives).
/// The frontend pushes them down on startup and whenever the setting changes.
#[derive(Clone)]
struct DownloadPreference {
    source: String,
    custom_url: String,
    threads: usize,
}

static DOWNLOAD_PREFERENCE: OnceLock<std::sync::RwLock<DownloadPreference>> = OnceLock::new();

fn preference_lock() -> &'static std::sync::RwLock<DownloadPreference> {
    DOWNLOAD_PREFERENCE.get_or_init(|| {
        std::sync::RwLock::new(DownloadPreference {
            source: "official_ap".to_string(),
            custom_url: String::new(),
            threads: 16,
        })
    })
}

pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .pool_max_idle_per_host(64)
            .tcp_nodelay(true)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .build()
            .expect("failed to build http client")
    })
}

/// `source` is one of `official_ap` / `bmclapi` / `custom`; `custom_url` is the
/// BMCLAPI-compatible base the user typed in; `threads` is clamped to 1–64.
pub fn set_download_preference(source: &str, custom_url: &str, threads: Option<usize>) {
    let mut guard = preference_lock()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.source = source.trim().to_string();
    guard.custom_url = custom_url.trim().trim_end_matches('/').to_string();
    if let Some(threads) = threads {
        guard.threads = threads.clamp(1, 64);
    }
}

fn download_preference() -> DownloadPreference {
    preference_lock()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Thread count content downloads should use when the caller has no own value.
pub fn download_threads() -> usize {
    download_preference().threads
}

fn is_bmclapi(url: &str) -> bool {
    url.contains("bmclapi2.bangbang93.com") || url.contains("bmclapi.bangbang93.com")
}

/// Rewrite a BMCLAPI URL onto the user's BMCLAPI-compatible mirror base.
fn rewrite_to_custom_mirror(url: &str, base: &str) -> Option<String> {
    if !is_bmclapi(url) {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    let mut rewritten = format!("{base}{}", parsed.path());
    if let Some(query) = parsed.query() {
        rewritten.push('?');
        rewritten.push_str(query);
    }
    Some(rewritten)
}

/// Candidate URLs in the order they should be attempted: the chosen source
/// family first, the rest kept as the automatic 404/offline fallback.
pub fn preferred_urls(url: &str) -> Vec<String> {
    let mut chain = vec![url.to_string()];
    for mirror in get_mirror_urls(url) {
        if !chain.contains(&mirror) {
            chain.push(mirror);
        }
    }

    let preference = download_preference();
    let mode = preference.source;
    let custom_base = preference.custom_url;
    let mut custom = Vec::new();
    if !custom_base.is_empty() {
        for candidate in &chain {
            if let Some(rewritten) = rewrite_to_custom_mirror(candidate, &custom_base) {
                if rewritten != *candidate && !custom.contains(&rewritten) {
                    custom.push(rewritten);
                }
            }
        }
    }

    let (bmclapi, official): (Vec<String>, Vec<String>) =
        chain.into_iter().partition(|candidate| is_bmclapi(candidate));

    let mut ordered = match mode.as_str() {
        "bmclapi" => {
            let mut list = bmclapi;
            list.extend(custom);
            list.extend(official);
            list
        }
        "custom" => {
            let mut list = custom;
            list.extend(bmclapi);
            list.extend(official);
            list
        }
        _ => {
            let mut list = official;
            list.extend(bmclapi);
            list.extend(custom);
            list
        }
    };

    let mut seen: Vec<String> = Vec::new();
    ordered.retain(|candidate| {
        if seen.contains(candidate) {
            false
        } else {
            seen.push(candidate.clone());
            true
        }
    });
    ordered
}

/// One mirror's reachability and round-trip time, measured against its version
/// manifest. Serialized in camelCase for the settings page.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSourceProbe {
    pub source: String,
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

pub async fn probe_download_sources(custom_url: Option<&str>) -> Vec<DownloadSourceProbe> {
    const MANIFEST_PATH: &str = "/mc/game/version_manifest_v2.json";
    let mut targets = vec![
        (
            "official_ap",
            format!("https://piston-meta.mojang.com{MANIFEST_PATH}"),
        ),
        (
            "bmclapi",
            format!("https://bmclapi2.bangbang93.com{MANIFEST_PATH}"),
        ),
    ];
    let custom_base = custom_url.unwrap_or("").trim().trim_end_matches('/');
    if !custom_base.is_empty() {
        targets.push(("custom", format!("{custom_base}{MANIFEST_PATH}")));
    }

    let probes = targets.into_iter().map(|(source, url)| async move {
        let started = std::time::Instant::now();
        let response = client()
            .get(&url)
            .timeout(Duration::from_secs(6))
            .header(RANGE, "bytes=0-1023")
            .send()
            .await;
        let latency_ms = started.elapsed().as_millis() as u64;
        match response {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 206 => {
                DownloadSourceProbe {
                    source: source.to_string(),
                    ok: true,
                    latency_ms,
                    error: None,
                }
            }
            Ok(resp) => DownloadSourceProbe {
                source: source.to_string(),
                ok: false,
                latency_ms,
                error: Some(format!("HTTP {}", resp.status())),
            },
            Err(err) => DownloadSourceProbe {
                source: source.to_string(),
                ok: false,
                latency_ms,
                error: Some(describe_error(&err)),
            },
        }
    });

    futures_util::future::join_all(probes).await
}

/// Render an error together with its full source chain.
///
/// `reqwest` only prints its own wrapper message ("error decoding response
/// body") through `Display`, which hides the real cause (a timeout, a reset,
/// or a serde mismatch). Walk the chain so the UI can show what happened.
fn describe_error(err: &(dyn std::error::Error + 'static)) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(inner) = source {
        let detail = inner.to_string();
        if !detail.is_empty() && !text.contains(&detail) {
            text.push_str(&format!(" ({detail})"));
        }
        source = inner.source();
    }
    text
}

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
        let response = match client().get(url).timeout(timeout).send().await {
            Ok(response) => response,
            Err(err) => {
                last_error = describe_error(&err);
                if attempt < attempts && (err.is_timeout() || err.is_connect() || err.is_request()) {
                    tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
                    continue;
                }
                return Err(last_error);
            }
        };

        let status = response.status();
        if !status.is_success() {
            last_error = format!("HTTP {status}");
            let retryable = status.is_server_error()
                || status.as_u16() == 408
                || status.as_u16() == 429;
            if attempt < attempts && retryable {
                tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
                continue;
            }
            return Err(last_error);
        }

        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => {
                last_error = describe_error(&err);
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
        return serde_json::from_slice::<T>(&bytes).map_err(|err| {
            format!("响应格式不匹配: {err}；内容开头: {}", body_snippet(&bytes))
        });
    }

    Err(last_error)
}

/// Download a file to `dest`, verifying its SHA-1 when provided.
/// The write is atomic: data lands in a `.part` file first.
pub async fn download_file(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    mut on_bytes: Option<&mut (dyn FnMut(u64, u64) + Send)>,
) -> Result<u64, String> {
    let mut delta_adapter = |done: u64, total: u64, _delta: u64| {
        if let Some(cb) = on_bytes.as_mut() {
            cb(done, total);
        }
    };
    download_file_with_mirrors(
        url,
        dest,
        expected_sha1,
        expected_size,
        1,
        None,
        Some(&mut delta_adapter),
    )
    .await
}

/// Returns alternative mirror URLs for known official Minecraft/BMCLAPI/Fabric/Forge/XboxLive CDNs
/// to transparently prevent 404 or connection failures.
pub fn get_mirror_urls(url: &str) -> Vec<String> {
    let mut mirrors = Vec::new();
    let trimmed = url.trim();

    if trimmed.contains("xboxlive") {
        if let Ok(parsed) = reqwest::Url::parse(trimmed) {
            let path_and_query = match parsed.query() {
                Some(q) => format!("{}?{}", parsed.path(), q),
                None => parsed.path().to_string(),
            };
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
            for host in xbox_hosts {
                let candidate = format!("http://{host}{path_and_query}");
                if candidate != trimmed && !mirrors.contains(&candidate) {
                    mirrors.push(candidate);
                }
            }
        }
    } else if let Some(path) = trimmed.strip_prefix("https://libraries.minecraft.net/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
        mirrors.push(format!("https://maven.fabricmc.net/{path}"));
        mirrors.push(format!("https://maven.minecraftforge.net/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("http://libraries.minecraft.net/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://resources.betacraft.uk/") {
        // Betacraft's legacy-asset mirror is the primary URL from its own index;
        // fall back to Mojang and BMCLAPI when the mirror is unavailable.
        mirrors.push(format!("https://resources.download.minecraft.net/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/assets/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://resources.download.minecraft.net/") {
        // Legacy objects (beta/alpha sound & music, pre-1.6 langs) were pruned
        // from Mojang's CDN and now answer 404 mid-install. Betacraft keeps them
        // under the same hash layout, so it is the first fallback there.
        mirrors.push(format!("https://resources.betacraft.uk/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/assets/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("http://resources.download.minecraft.net/") {
        mirrors.push(format!("https://resources.betacraft.uk/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/assets/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://piston-meta.mojang.com/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://piston-data.mojang.com/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://launcher.mojang.com/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://launchermeta.mojang.com/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://maven.fabricmc.net/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://maven.minecraftforge.net/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://maven.neoforged.net/releases/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
        mirrors.push(format!("https://maven.minecraftforge.net/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://bmclapi2.bangbang93.com/maven/") {
        if path.starts_with("net/minecraftforge/") {
            mirrors.push(format!("https://maven.minecraftforge.net/{path}"));
        } else if path.starts_with("net/neoforged/") {
            mirrors.push(format!("https://maven.neoforged.net/releases/{path}"));
        } else if path.starts_with("net/fabricmc/") {
            mirrors.push(format!("https://maven.fabricmc.net/{path}"));
        } else if path.starts_with("org/quiltmc/") {
            mirrors.push(format!("https://maven.quiltmc.org/repository/release/{path}"));
        } else {
            mirrors.push(format!("https://libraries.minecraft.net/{path}"));
            mirrors.push(format!("https://maven.fabricmc.net/{path}"));
            mirrors.push(format!("https://maven.minecraftforge.net/{path}"));
        }
    } else if let Some(path) = trimmed.strip_prefix("https://bmclapi2.bangbang93.com/assets/") {
        mirrors.push(format!("https://resources.download.minecraft.net/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://bmclapi2.bangbang93.com/") {
        mirrors.push(format!("https://piston-data.mojang.com/{path}"));
        mirrors.push(format!("https://piston-meta.mojang.com/{path}"));
    } else if trimmed.contains("github.com/") && trimmed.contains("/releases/download/") {
        mirrors.push(format!("https://ghproxy.net/{trimmed}"));
        mirrors.push(format!("https://gh-proxy.com/{trimmed}"));
        mirrors.push(trimmed.replace("https://github.com/", "https://github1.roundstudio.top/https://github.com/"));
    }

    mirrors
}

/// Download a file to `dest`, with automatic mirror fallback if the primary URL fails or returns 404.
pub async fn download_file_with_mirrors<'a>(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    let candidate_urls = preferred_urls(url);

    let mut last_error = String::new();
    for candidate in &candidate_urls {
        match download_file_multithreaded(
            candidate,
            dest,
            expected_sha1,
            expected_size,
            threads,
            retry_counter,
            on_progress.as_mut().map(|cb| &mut **cb),
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                last_error = err;
            }
        }
    }

    Err(last_error)
}

/// Multi-threaded file downloader with HTTP Range segmentation and automatic retries.
///
/// - When `threads > 1` and the file is at least `MIN_MULTITHREAD_SIZE`, probes the server
///   for `Accept-Ranges` / `206 Partial Content` support and splits the download into
///   concurrent byte-range segments.
/// - Automatically falls back to single-stream download if the server does not support
///   byte ranges.
/// - Retries transient network failures with exponential backoff.
/// - Calls `on_progress(done_bytes, total_bytes, delta_bytes)` as chunks arrive.
pub async fn download_file_multithreaded<'a>(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("无法创建目录 {}: {e}", parent.display()))?;
    }

    let part = part_path(dest);
    let threads = threads.clamp(1, 16);

    // Try segmented multi-threaded download for large files when multiple threads are allowed.
    // When expected_size is unknown (None), still probe HTTP Range so large downloads (Bedrock cores, etc.) auto-accelerate.
    let should_try_segmented =
        threads > 1 && expected_size.map(|s| s >= MIN_MULTITHREAD_SIZE).unwrap_or(true);

    if should_try_segmented {
        match try_segmented_download(
            url,
            &part,
            expected_size,
            threads,
            retry_counter,
            on_progress.as_mut().map(|cb| &mut **cb),
        )
        .await
        {
            Ok(Some(downloaded)) => {
                if let Err(err) = verify_and_commit(&part, dest, downloaded, expected_size, expected_sha1).await {
                    let _ = fs::remove_file(&part).await;
                    return Err(err);
                }
                return Ok(downloaded);
            }
            Ok(None) => {
                // Server did not support Range or size was unsuitable; fall back to single stream.
            }
            Err(_) => {
                // Segmented download failed mid-flight; clean up and fall back to single stream with retries.
                if let Some(counter) = retry_counter {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
                let _ = fs::remove_file(&part).await;
            }
        }
    }

    // Single-stream download with automatic retries.
    let mut last_error = String::new();
    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            if let Some(counter) = retry_counter {
                counter.fetch_add(1, Ordering::Relaxed);
            }
            tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt))).await;
        }

        match download_single_stream(
            url,
            &part,
            expected_size,
            on_progress.as_mut().map(|cb| &mut **cb),
        )
        .await
        {
            Ok(downloaded) => {
                match verify_and_commit(&part, dest, downloaded, expected_size, expected_sha1).await
                {
                    Ok(()) => return Ok(downloaded),
                    Err(verify_err) => {
                        last_error = verify_err;
                        let _ = fs::remove_file(&part).await;
                    }
                }
            }
            Err(err) => {
                let is_404 = err.contains("HTTP 404");
                last_error = err;
                let _ = fs::remove_file(&part).await;
                if is_404 {
                    break;
                }
            }
        }
    }

    Err(last_error)
}

async fn download_single_stream<'a>(
    url: &str,
    part: &Path,
    expected_size: Option<u64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    let response = client()
        .get(url)
        // Binary payloads must stay byte-exact for checksum verification, so
        // never let transparent decompression touch them.
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|e| format!("下载请求失败 ({url}): {e}"))?;

    if !response.status().is_success() {
        return Err(format!("下载失败 ({url}): HTTP {}", response.status()));
    }

    let total = response.content_length().or(expected_size).unwrap_or(0);
    let mut file = fs::File::create(part)
        .await
        .map_err(|e| format!("无法写入 {}: {e}", part.display()))?;

    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断 ({url}): {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
        let delta = chunk.len() as u64;
        downloaded += delta;
        if let Some(cb) = on_progress.as_mut() {
            cb(downloaded, total, delta);
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
    drop(file);
    Ok(downloaded)
}

/// Probes whether the server supports HTTP Range requests and, if so, downloads the file
/// in parallel byte segments. Returns `Ok(None)` if Range is not supported.
async fn try_segmented_download<'a>(
    url: &str,
    part: &Path,
    expected_size: Option<u64>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<Option<u64>, String> {
    // Probe with a 1-byte range request to verify 206 Partial Content support and total length.
    let probe = client()
        .get(url)
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| format!("分片探测失败 ({url}): {e}"))?;

    if probe.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("下载失败 ({url}): HTTP 404"));
    }

    if probe.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Ok(None);
    }

    let total = probe
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_range_total)
        .or(expected_size)
        .unwrap_or(0);

    drop(probe);

    if total < MIN_MULTITHREAD_SIZE {
        return Ok(None);
    }

    let segments = compute_segments(total, threads);
    if segments.len() <= 1 {
        return Ok(None);
    }

    // Pre-allocate the target `.part` file.
    {
        let file = fs::File::create(part)
            .await
            .map_err(|e| format!("无法创建分片文件 {}: {e}", part.display()))?;
        file.set_len(total)
            .await
            .map_err(|e| format!("无法预分配文件空间 {}: {e}", part.display()))?;
    }

    let downloaded = Arc::new(AtomicU64::new(0));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, u64)>();

    let segment_futures: Vec<_> = segments
        .into_iter()
        .map(|(start, end)| {
            let url = url.to_string();
            let part = part.to_path_buf();
            let downloaded = downloaded.clone();
            let tx = tx.clone();
            async move {
                let expected_len = end - start + 1;
                let mut last_err = String::new();
                for attempt in 0..MAX_RETRIES {
                    if attempt > 0 {
                        tokio::time::sleep(Duration::from_millis(200 * u64::from(attempt))).await;
                    }
                    let mut written_this_attempt: u64 = 0;
                    let res: Result<(), String> = async {
                        let response = client()
                            .get(&url)
                            .header(reqwest::header::ACCEPT_ENCODING, "identity")
                            .header(RANGE, format!("bytes={start}-{end}"))
                            .send()
                            .await
                            .map_err(|e| format!("分片请求失败 ({url}): {e}"))?;

                        if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                            return Err(format!(
                                "服务器未返回分片数据 ({url}): HTTP {}",
                                response.status()
                            ));
                        }

                        let mut file = fs::OpenOptions::new()
                            .write(true)
                            .open(&part)
                            .await
                            .map_err(|e| format!("无法打开分片文件 {}: {e}", part.display()))?;
                        file.seek(SeekFrom::Start(start))
                            .await
                            .map_err(|e| format!("分片定位失败 {}: {e}", part.display()))?;

                        let mut stream = response.bytes_stream();
                        while let Some(chunk) = stream.next().await {
                            let chunk = chunk.map_err(|e| format!("分片下载中断 ({url}): {e}"))?;
                            let len = chunk.len() as u64;
                            if written_this_attempt + len > expected_len {
                                return Err("分片返回字节超出范围".to_string());
                            }
                            file.write_all(&chunk)
                                .await
                                .map_err(|e| format!("分片写入失败 {}: {e}", part.display()))?;
                            written_this_attempt += len;
                            let current = downloaded.fetch_add(len, Ordering::Relaxed) + len;
                            let _ = tx.send((current, len));
                        }

                        if written_this_attempt != expected_len {
                            return Err(format!(
                                "分片长度不完整: 期望 {expected_len}, 实际 {written_this_attempt}"
                            ));
                        }

                        file.flush()
                            .await
                            .map_err(|e| format!("分片刷新失败 {}: {e}", part.display()))?;
                        Ok(())
                    }
                    .await;

                    match res {
                        Ok(()) => return Ok::<u32, String>(attempt),
                        Err(e) => {
                            last_err = e;
                            if written_this_attempt > 0 {
                                downloaded.fetch_sub(written_this_attempt, Ordering::Relaxed);
                            }
                        }
                    }
                }
                Err(last_err)
            }
        })
        .collect();

    drop(tx);

    let join_fut = try_join_all(segment_futures);
    tokio::pin!(join_fut);

    loop {
        tokio::select! {
             biased;
             maybe_msg = rx.recv() => {
                 if let Some((current, delta)) = maybe_msg {
                     if let Some(cb) = on_progress.as_mut() {
                         cb(current.min(total), total, delta);
                     }
                 } else {
                     break;
                 }
             }
             res = &mut join_fut => {
                 let attempts = res?;
                 if let Some(counter) = retry_counter {
                     let retries: u64 = attempts.into_iter().map(u64::from).sum();
                     if retries > 0 {
                         counter.fetch_add(retries, Ordering::Relaxed);
                     }
                 }
                 // Drain any remaining progress notifications.
                 while let Ok((current, delta)) = rx.try_recv() {
                     if let Some(cb) = on_progress.as_mut() {
                         cb(current.min(total), total, delta);
                     }
                 }
                 return Ok(Some(total));
             }
        }
    }

    let attempts = join_fut.await?;
    if let Some(counter) = retry_counter {
        let retries: u64 = attempts.into_iter().map(u64::from).sum();
        if retries > 0 {
            counter.fetch_add(retries, Ordering::Relaxed);
        }
    }
    Ok(Some(total))
}

async fn verify_and_commit(
    part: &Path,
    dest: &Path,
    downloaded: u64,
    expected_size: Option<u64>,
    expected_sha1: Option<&str>,
) -> Result<(), String> {
    if let Some(expected) = expected_size {
        if expected > 0 && downloaded != expected {
            return Err(format!(
                "文件大小不符 {}: 期望 {expected} 字节，实际 {downloaded} 字节",
                dest.display()
            ));
        }
    }

    if let Some(expected) = expected_sha1 {
        if !expected.is_empty() {
            let actual = sha1_file(part).await?;
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(format!("文件校验失败 {}: SHA-1 不匹配", dest.display()));
            }
        }
    }

    if fs::try_exists(dest).await.unwrap_or(false) {
        let _ = fs::remove_file(dest).await;
    }
    fs::rename(part, dest)
        .await
        .map_err(|e| format!("无法保存 {}: {e}", dest.display()))?;
    Ok(())
}

pub fn compute_segments(total: u64, max_threads: usize) -> Vec<(u64, u64)> {
    if total == 0 {
        return Vec::new();
    }
    let max_by_size = (total / MIN_SEGMENT_SIZE).max(1) as usize;
    let count = max_threads.clamp(1, 16).min(max_by_size);
    if count <= 1 {
        return vec![(0, total - 1)];
    }
    let chunk = total / (count as u64);
    let mut ranges = Vec::with_capacity(count);
    for i in 0..count {
        let start = (i as u64) * chunk;
        let end = if i + 1 == count {
            total - 1
        } else {
            (i as u64 + 1) * chunk - 1
        };
        ranges.push((start, end));
    }
    ranges
}

pub fn parse_content_range_total(header_value: &str) -> Option<u64> {
    // Format: "bytes 0-0/123456"
    let (_, total_str) = header_value.rsplit_once('/')?;
    let trimmed = total_str.trim();
    if trimmed == "*" {
        return None;
    }
    trimmed.parse::<u64>().ok()
}

pub fn recommended_segments(size: Option<u64>, max_threads: usize) -> u32 {
    match size {
        Some(total) if total >= MIN_MULTITHREAD_SIZE && max_threads > 1 => {
            compute_segments(total, max_threads).len() as u32
        }
        _ => 1,
    }
}

pub async fn sha1_file(path: &Path) -> Result<String, String> {
    let data = fs::read(path)
        .await
        .map_err(|e| format!("无法读取 {}: {e}", path.display()))?;
    Ok(format!("{:x}", Sha1::digest(data)))
}

/// Cheap completeness check used before downloading thousands of assets.
pub fn absolute_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn looks_complete(path: &Path, expected_size: Option<u64>) -> bool {
    match (std::fs::metadata(path), expected_size) {
        (Ok(meta), Some(size)) if size > 0 => meta.is_file() && meta.len() == size,
        (Ok(meta), _) => meta.is_file() && meta.len() > 0,
        _ => false,
    }
}

fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_content_range_header() {
        assert_eq!(
            parse_content_range_total("bytes 0-0/31457280"),
            Some(31_457_280)
        );
        assert_eq!(parse_content_range_total("bytes 0-1023/*"), None);
        assert_eq!(parse_content_range_total("invalid"), None);
    }

    #[test]
    fn betacraft_asset_mirror_falls_back_to_mojang_and_bmclapi() {
        let mirrors = get_mirror_urls(
            "https://resources.betacraft.uk/02/022e48005197b37f0caa53e8051c8a266eeae15e",
        );
        assert!(mirrors.contains(
            &"https://resources.download.minecraft.net/02/022e48005197b37f0caa53e8051c8a266eeae15e"
                .to_string()
        ));
        assert!(mirrors.contains(
            &"https://bmclapi2.bangbang93.com/assets/02/022e48005197b37f0caa53e8051c8a266eeae15e"
                .to_string()
        ));
    }

    #[test]
    fn pruned_mojang_asset_falls_back_to_betacraft() {
        let mirrors = get_mirror_urls(
            "https://resources.download.minecraft.net/f1/f1b527e059bb4abe3aed3acf6b5eb96f40b07f67",
        );
        assert_eq!(
            mirrors.first().map(String::as_str),
            Some("https://resources.betacraft.uk/f1/f1b527e059bb4abe3aed3acf6b5eb96f40b07f67")
        );
    }

    #[test]
    fn preferred_urls_follow_the_selected_source() {
        let url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

        set_download_preference("official_ap", "", Some(16));
        let official = preferred_urls(url);
        assert_eq!(official.first().map(String::as_str), Some(url));

        set_download_preference("bmclapi", "", None);
        let bmclapi = preferred_urls(url);
        assert!(is_bmclapi(&bmclapi[0]));

        set_download_preference("custom", "https://mirror.example.com/", Some(8));
        let custom = preferred_urls(url);
        assert_eq!(download_threads(), 8);
        assert_eq!(
            custom.first().map(String::as_str),
            Some("https://mirror.example.com/mc/game/version_manifest_v2.json")
        );

        set_download_preference("official_ap", "", None);
        assert_eq!(
            preferred_urls(url).first().map(String::as_str),
            Some(url)
        );
    }

    #[test]
    fn splits_bytes_into_contiguous_non_overlapping_segments() {
        let total = 10_000_000;
        let segments = compute_segments(total, 8);
        assert_eq!(segments.len(), 8);
        assert_eq!(segments.first().unwrap().0, 0);
        assert_eq!(segments.last().unwrap().1, total - 1);
        let mut expected_start = 0;
        let mut sum = 0;
        for (start, end) in segments {
            assert_eq!(start, expected_start);
            assert!(end >= start);
            sum += end - start + 1;
            expected_start = end + 1;
        }
        assert_eq!(sum, total);
    }
}
