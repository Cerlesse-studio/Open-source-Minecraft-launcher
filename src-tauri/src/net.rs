use futures_util::StreamExt;
use reqwest::header::RANGE;
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::fs;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 CobbleLauncher/0.1.6";

/// Files at or above 1 MB are eligible for multi-segment HTTP Range downloading.
const MIN_MULTITHREAD_SIZE: u64 = 1_048_576;
/// Each HTTP Range segment downloads at least 512 KB.
const MIN_SEGMENT_SIZE: u64 = 512 * 1024;
/// Maximum retries per file or segment before failing.
const MAX_RETRIES: u32 = 3;
/// 分片下载启动后的爬坡时间，这段时间内的低速率不算失败。
const SEGMENT_SLOW_GRACE: Duration = Duration::from_secs(12);
/// 分片总吞吐持续低于这个值就放弃多线程。不少 GitHub 加速镜像会
/// 严重限制同一 IP 的并发连接，多开分片反而比单连接慢上百倍。
const SEGMENT_MIN_RATE_BYTES: f64 = 8.0 * 1024.0;
const SEGMENT_WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);
/// 单个分片这么久没收到字节就认为连接已死，重试或退出，避免整体挂住。
const SEGMENT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
/// 分块下载的目标块大小：块比“每线程一段”小得多，一条连接卡住或被
/// 限速时只会拖住一个小区块，其余连接随时可以把它剩下的活接走。
const CHUNK_TARGET_BYTES: u64 = 4 * 1024 * 1024;
/// 块至少要跑这么久才好拿别人的速度当参照，否则新块会被误判成“太慢”。
const CHUNK_SLOW_MIN_AGE: Duration = Duration::from_secs(3);
/// 块级监督周期：看每个活跃块最近的进展。
const CHUNK_SUPERVISE_INTERVAL: Duration = Duration::from_secs(1);
/// 一个块这么久没有任何新字节就判定连接卡死，回收剩余区间重新排队。
const CHUNK_STALL_WINDOW: Duration = Duration::from_secs(6);
/// 慢于同龄块最快速度的这个比例就算异常，回收它剩下的区间。
const CHUNK_SLOW_RATIO: f64 = 0.25;
/// 同一个区间最多回收几次：镜像按 IP 限速时重发也快不起来，别无限循环。
const CHUNK_MAX_RECLAIMS: u32 = 3;
/// 看门狗用的滑动窗口长度。累计平均速度会被前期的快速阶段掩盖，
/// 必须看“最近几秒”的实际吞吐，否则后期骤降要几分钟才能发现。
const SPEED_WINDOW: Duration = Duration::from_secs(4);
/// 版本清单、资源索引这类“安装必经”的元数据：它们通常只有几百 KB，
/// 达不到普通文件的分片门槛，但在这条线路上单连接要十几二十秒。
/// 允许它们按更小的块并行下载，把这段等待压到几秒。
const METADATA_MIN_TOTAL: u64 = 128 * 1024;
const METADATA_MIN_SEGMENT: u64 = 64 * 1024;
/// 单个候选地址拿元数据的时间上限：慢到连块并行都拉不回来就换镜像，
/// 不能让一个挂死的地址把整个安装卡住。
const METADATA_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(10);
/// 最后一个候选地址的宽限：它已经是最后的希望，宁可慢也不要失败。
const METADATA_LAST_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(45);
/// 单连接“吊着不死”的判死窗口：代理/镜像有时会保留连接，却每几十秒才挤
/// 一点字节。这种连接不报错、不超时，却让文件永远下不完，必须按窗口平均
/// 速率判死，让外层换镜像或重试。
const SINGLE_STREAM_RATE_WINDOW: Duration = Duration::from_secs(30);
const SINGLE_STREAM_MIN_RATE_BYTES: f64 = 512.0;
/// 被限速（429/503）时不消耗普通重试次数，单独给几次机会：这时问题不在
/// 文件本身，而在并发太高或需要等待，立刻判死只会让整个下载失败。
const MAX_RATE_LIMIT_RETRIES: u32 = 5;
/// 单个主机（镜像/代理）允许的最大并发连接数。默认不设限（与用户线程数一致），
/// 只有被限速过才往下调。
const HOST_GATE_MAX_CONNECTIONS: usize = 64;
/// 被限速过的主机连续成功这么多次后才允许把并发加回一条。
const HOST_GATE_RAMP_SUCCESSES: usize = 8;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static API_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 单个主机（镜像/代理）的连接闸门。
///
/// 加速镜像与自建代理几乎都是按 IP 限并发的：一次开十几条连接过去，它们会
/// 直接回 429/503。之前遇到这种响应只是原样重试、连接数一点都不降，表现出来
/// 就是“卡在限速上”——文件下不动，也结束不了。这里给每个主机记一个可调上限：
/// 被限速就减半（最少 1 条），连续成功若干次再慢慢加回来。
struct HostGate {
    /// 当前允许同时进行的连接数。
    limit: AtomicUsize,
    /// 此刻占用中的连接数。
    active: AtomicUsize,
    /// 连续成功次数，攒够一轮才 +1。
    ok_streak: AtomicUsize,
}

impl HostGate {
    fn new() -> Self {
        Self {
            limit: AtomicUsize::new(HOST_GATE_MAX_CONNECTIONS),
            active: AtomicUsize::new(0),
            ok_streak: AtomicUsize::new(0),
        }
    }
}

static HOST_GATES: OnceLock<std::sync::Mutex<HashMap<String, Arc<HostGate>>>> = OnceLock::new();

/// 闸门按 `主机:端口` 归档：不同源是不同配额，测试里每个本地服务器也各算一个。
fn host_key(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    Some(match parsed.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    })
}

fn host_gate(url: &str) -> Option<Arc<HostGate>> {
    let key = host_key(url)?;
    let mut gates = HOST_GATES
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .ok()?;
    Some(
        gates
            .entry(key)
            .or_insert_with(|| Arc::new(HostGate::new()))
            .clone(),
    )
}

/// 一个统计窗口里的平均速率是不是低到“实际上没在下载”。
fn stream_rate_is_too_low(bytes: u64, elapsed: Duration) -> bool {
    if elapsed < SINGLE_STREAM_RATE_WINDOW {
        return false;
    }
    (bytes as f64 / elapsed.as_secs_f64().max(0.001)) < SINGLE_STREAM_MIN_RATE_BYTES
}

/// 归还连接用的凭据，`Drop` 时把占用数减回去。
struct HostSlot {
    gate: Option<Arc<HostGate>>,
}

impl Drop for HostSlot {
    fn drop(&mut self) {
        if let Some(gate) = self.gate.take() {
            gate.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// 在当前主机的并发额度里占一个位置；额度满了就排队等着，而不是继续加压。
async fn acquire_host_slot(url: &str) -> Option<HostSlot> {
    let gate = host_gate(url)?;
    loop {
        let limit = gate.limit.load(Ordering::SeqCst).max(1);
        let active = gate.active.load(Ordering::SeqCst);
        if active < limit
            && gate
                .active
                .compare_exchange(active, active + 1, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            return Some(HostSlot { gate: Some(gate) });
        }
        tokio::time::sleep(Duration::from_millis(60)).await;
    }
}

/// 被限速：把该主机的并发减半并清零成功计数。
fn penalize_host(url: &str) {
    if let Some(gate) = host_gate(url) {
        let current = gate.limit.load(Ordering::SeqCst).max(1);
        gate.limit.store((current / 2).max(1), Ordering::SeqCst);
        gate.ok_streak.store(0, Ordering::SeqCst);
    }
}

/// 当前允许给这个主机开多少条连接（没被限速过就是全局上限）。
fn host_connection_limit(url: &str) -> usize {
    host_gate(url)
        .map(|gate| gate.limit.load(Ordering::SeqCst).clamp(1, HOST_GATE_MAX_CONNECTIONS))
        .unwrap_or(HOST_GATE_MAX_CONNECTIONS)
}

/// 一次完整成功：攒够一轮就把并发加回一条（上限仍是全局最大值）。
fn note_host_success(url: &str) {
    if let Some(gate) = host_gate(url) {
        let streak = gate.ok_streak.fetch_add(1, Ordering::SeqCst) + 1;
        if streak >= HOST_GATE_RAMP_SUCCESSES {
            gate.ok_streak.store(0, Ordering::SeqCst);
            let _ = gate.limit.fetch_update(
                Ordering::SeqCst,
                Ordering::SeqCst,
                |current| {
                    Some((current + 1).min(HOST_GATE_MAX_CONNECTIONS))
                },
            );
        }
    }
}

/// 把响应里的 `Retry-After`（秒）拼到错误文本里，方便重试时按服务端要求等待。
fn retry_after_suffix(response: &reqwest::Response) -> String {
    response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| format!(" retry-after={}", seconds.min(60)))
        .unwrap_or_default()
}

/// 这条错误是不是“被限速”；是的话返回该等多久再试。
fn rate_limit_wait(error: &str) -> Option<Duration> {
    let limited = error.contains("HTTP 429")
        || error.contains("HTTP 503")
        || error.contains("HTTP 509")
        || error.contains("Too Many Requests");
    if !limited {
        return None;
    }
    let seconds = error
        .split("retry-after=")
        .nth(1)
        .map(|rest| {
            rest.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
        })
        .and_then(|digits| digits.parse::<u64>().ok())
        .unwrap_or(1);
    Some(Duration::from_secs(seconds.clamp(1, 10)))
}

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

/// `client()` with `Accept-Encoding: gzip, deflate` for JSON/text API calls.
///
/// Without the header every catalogue answer travelled uncompressed: a
/// CurseForge search page is 250 KB of JSON and this link delivers ~30 KB/s,
/// so one search took ten seconds — that is what made browsing content feel
/// stalled. Gzipped it is 40 KB and under three seconds. Binary downloads keep
/// using `client()`: a `Content-Encoding` there would break byte-range offsets.
pub fn api_client() -> &'static reqwest::Client {
    API_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .pool_max_idle_per_host(64)
            .tcp_nodelay(true)
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(600))
            .gzip(true)
            .deflate(true)
            .build()
            .expect("failed to build http client")
    })
}

/// `source` is one of `official_ap` / `microsoft` / `bmclapi` / `custom`;
/// `custom_url` is the BMCLAPI-compatible base the user typed in; `threads` is
/// clamped to 1–64.
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

/// 单个文件可用的分片线程数。
///
/// 小于 1 MB 的文件分不出有意义的分片，直接单连接；未知大小或大文件
/// 使用用户配置的线程数，由下载器先探测 Range 再决定是否真的分段。
/// 这样所有下载入口（客户端、依赖库、资源、安装器、运行时）都遵守同一套
/// 多线程策略，不会再出现某个入口固定单线程的情况。
pub fn per_file_threads(size: Option<u64>) -> usize {
    let configured = download_threads().clamp(1, 64);
    match size {
        Some(total) if total < MIN_MULTITHREAD_SIZE => 1,
        _ => configured,
    }
}

fn is_bmclapi(url: &str) -> bool {
    url.contains("bmclapi2.bangbang93.com") || url.contains("bmclapi.bangbang93.com")
}

/// Whether Microsoft itself hosts the file: Mojang's meta/manifest/launcher
/// hosts, the asset and library CDNs, and the Xbox/Store delivery hosts that
/// serve Bedrock packages. Third-party Maven repositories (Fabric, Forge,
/// Quilt, NeoForge) and the community mirrors are deliberately excluded.
fn is_microsoft_official(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    const OFFICIAL_DOMAINS: [&str; 5] = [
        "mojang.com",
        "minecraft.net",
        "minecraftservices.com",
        "xboxlive.com",
        "xboxlive.cn",
    ];
    OFFICIAL_DOMAINS
        .iter()
        .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
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

    let (bmclapi, official): (Vec<String>, Vec<String>) = chain
        .into_iter()
        .partition(|candidate| is_bmclapi(candidate));

    let mut ordered = match mode.as_str() {
        // 微软官方：官方资源只从 Microsoft 自己的域名下载，绝不改道第三方镜像。
        // 第三方 Maven（Fabric、Forge、Quilt、NeoForge）与 BetaCraft 远古资源
        // 本身没有官方地址，仍保留它们的镜像回退，否则加载器依赖装不上。
        "microsoft" => {
            if is_microsoft_official(url) {
                official
                    .into_iter()
                    .filter(|candidate| is_microsoft_official(candidate))
                    .collect()
            } else {
                let mut list = official;
                list.extend(bmclapi);
                list.extend(custom);
                list
            }
        }
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
    let bytes = fetch_json_bytes(url, timeout, attempts).await?;
    // A complete body that still fails to deserialize is a schema problem,
    // not a network one, so surface it instead of retrying.
    serde_json::from_slice::<T>(&bytes)
        .map_err(|err| format!("响应格式不匹配: {err}；内容开头: {}", body_snippet(&bytes)))
}

/// GET a response body with the JSON fetch's retry policy, but without parsing.
/// The metadata cache stores these bytes so a later hit needs no network at all.
pub async fn fetch_json_bytes(
    url: &str,
    timeout: Duration,
    attempts: u32,
) -> Result<Vec<u8>, String> {
    let attempts = attempts.max(1);
    let mut last_error = String::from("未知错误");

    for attempt in 1..=attempts {
        let response = match api_client().get(url).timeout(timeout).send().await {
            Ok(response) => response,
            Err(err) => {
                last_error = describe_error(&err);
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

        return Ok(bytes.to_vec());
    }

    Err(last_error)
}

/// GET a text/HTML/XML response body without retries layered on top.
/// Used by the metadata cache, which keeps the previous copy for fallbacks.
pub async fn fetch_text_bytes(url: &str, timeout: Duration) -> Result<Vec<u8>, String> {
    let response = api_client()
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|err| format!("请求失败: {}", describe_error(&err)))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|err| format!("读取响应失败: {}", describe_error(&err)))
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
        per_file_threads(expected_size),
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
    } else if let Some(path) = trimmed.strip_prefix("https://maven.quiltmc.org/repository/release/") {
        // Quilt 加载器的库此前没有任何镜像回退，官方源一慢就只能干等。
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
            mirrors.push(format!(
                "https://maven.quiltmc.org/repository/release/{path}"
            ));
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
    } else if let Some(path) = trimmed.strip_prefix("https://authlib-injector.yushi.moe/") {
        // authlib-injector（外置登录必需）的官方 artifact 服务在国内很慢，
        // BMCLAPI 镜像了同样的路径；校验和仍以官方 JSON 为准。
        mirrors.push(format!(
            "https://bmclapi2.bangbang93.com/mirrors/authlib-injector/{path}"
        ));
    } else if let Some(path) = trimmed.strip_prefix("https://bmclapi2.bangbang93.com/mirrors/authlib-injector/") {
        mirrors.push(format!("https://authlib-injector.yushi.moe/{path}"));
    } else if trimmed.contains("github.com/") && trimmed.contains("/releases/download/") {
        mirrors.push(format!("https://ghproxy.net/{trimmed}"));
        mirrors.push(format!("https://gh-proxy.com/{trimmed}"));
        mirrors.push(trimmed.replace(
            "https://github.com/",
            "https://github1.roundstudio.top/https://github.com/",
        ));
    } else if let Some(rest) = trimmed.strip_prefix("https://raw.githubusercontent.com/") {
        let parts: Vec<&str> = rest.splitn(4, '/').collect();
        if parts.len() == 4 {
            let (owner, repo, branch, path) = (parts[0], parts[1], parts[2], parts[3]);
            mirrors.push(format!("https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"));
            mirrors.push(format!("https://fastly.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"));
            mirrors.push(format!("https://gcore.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"));
        }
        mirrors.push(format!("https://ghproxy.net/{trimmed}"));
        mirrors.push(format!("https://gh-proxy.com/{trimmed}"));
    } else if let Some(rest) = trimmed.strip_prefix("https://cdn.jsdelivr.net/gh/") {
        mirrors.push(format!("https://fastly.jsdelivr.net/gh/{rest}"));
        mirrors.push(format!("https://gcore.jsdelivr.net/gh/{rest}"));
        if let Some((repo_part, path)) = rest.split_once('/') {
            if let Some((owner, repo_and_branch)) = repo_part.split_once('/') {
                let (repo, branch) = match repo_and_branch.split_once('@') {
                    Some((r, b)) => (r, b),
                    None => (repo_and_branch, "master"),
                };
                mirrors.push(format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"));
                mirrors.push(format!("https://ghproxy.net/https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"));
            }
        }
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

/// 关键元数据（版本清单、资源索引）专用：文件不大，但位于安装必经路径上，
/// 慢线路上单连接要十几二十秒。这里允许按更小的块并行下载，失败自动换镜像。
pub async fn download_metadata(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
) -> Result<u64, String> {
    let candidate_urls = preferred_urls(url);
    let mut last_error = String::new();
    for (index, candidate) in candidate_urls.iter().enumerate() {
        let attempt = download_file_multithreaded_with(
            candidate,
            dest,
            expected_sha1,
            expected_size,
            threads,
            None,
            threads,
            METADATA_MIN_TOTAL,
            METADATA_MIN_SEGMENT,
            None,
            None,
        );
        // 最后一个候选地址不再急着放弃：线路真很慢时宁可多等一会，
        // 也不要让安装直接失败。
        let last = index + 1 == candidate_urls.len();
        let budget = if last {
            METADATA_LAST_ATTEMPT_TIMEOUT
        } else {
            METADATA_ATTEMPT_TIMEOUT
        };
        match tokio::time::timeout(budget, attempt).await {
            Ok(Ok(bytes)) => return Ok(bytes),
            Ok(Err(err)) => last_error = err,
            Err(_) => {
                last_error = format!("{candidate} 超过 {} 秒没有下完", budget.as_secs())
            }
        }
    }
    Err(last_error)
}

/// 客户端 Jar 这类“必须下完才算装好”的大文件：连接上限可以在下载途中抬高
/// （依赖库/资源阶段收尾后把连接让过来）。`max_workers` 是它最终可能吃到的
/// 连接数，块数按它切分，否则不够块时抬高上限也没用。
pub async fn download_file_with_mirrors_growing<'a>(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    limit: &Arc<AtomicUsize>,
    max_workers: usize,
    retry_counter: Option<&AtomicU64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    let candidate_urls = preferred_urls(url);
    let mut last_error = String::new();
    for candidate in &candidate_urls {
        let threads = limit.load(Ordering::Relaxed).clamp(1, 64);
        match download_file_multithreaded_with(
            candidate,
            dest,
            expected_sha1,
            expected_size,
            threads,
            Some(limit),
            max_workers,
            MIN_MULTITHREAD_SIZE,
            MIN_SEGMENT_SIZE,
            retry_counter,
            on_progress.as_mut().map(|cb| &mut **cb),
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(err) => last_error = err,
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
    on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    download_file_multithreaded_with(
        url,
        dest,
        expected_sha1,
        expected_size,
        threads,
        None,
        threads,
        MIN_MULTITHREAD_SIZE,
        MIN_SEGMENT_SIZE,
        retry_counter,
        on_progress,
    )
    .await
}

/// 通用实现：`thread_limit` 允许调用方在下载途中抬高连接数，`min_total` / 
/// `min_segment` 允许关键元数据在低于 1 MB 时也切块并行。
#[allow(clippy::too_many_arguments)]
async fn download_file_multithreaded_with<'a>(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    thread_limit: Option<&Arc<AtomicUsize>>,
    max_workers: usize,
    min_total: u64,
    min_segment: u64,
    retry_counter: Option<&AtomicU64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("无法创建目录 {}: {e}", parent.display()))?;
    }

    let part = part_path(dest);
    let threads = threads.clamp(1, 64);

    // Try segmented multi-threaded download for large files when multiple threads are allowed.
    // When expected_size is unknown (None), still probe HTTP Range so large downloads (Bedrock cores, etc.) auto-accelerate.
    let should_try_segmented = (threads > 1 || thread_limit.is_some())
        && expected_size.map(|s| s >= min_total).unwrap_or(true);

    if should_try_segmented {
        let segmented_progress = Arc::new(AtomicU64::new(0));
        let segmented_result = {
            let tracked = segmented_progress.clone();
            let mut forward = on_progress.as_mut().map(|cb| &mut **cb);
            let mut tracked_cb = move |done: u64, total: u64, delta: u64| {
                tracked.store(done, Ordering::Relaxed);
                if let Some(cb) = forward.as_mut() {
                    cb(done, total, delta);
                }
            };

            let fut = try_segmented_download(
                url,
                &part,
                expected_size,
                threads,
                thread_limit,
                max_workers,
                min_total,
                min_segment,
                retry_counter,
                Some(&mut tracked_cb),
            );
            tokio::pin!(fut);

            let started = Instant::now();
            let mut ticker = tokio::time::interval(SEGMENT_WATCHDOG_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticker.tick().await;
            let mut window = SpeedWindow::new(SPEED_WINDOW);
            // 先存一个起点采样：宽限期结束时就能算出真实速率，
            // 不用再白等一个完整周期。
            window.sample(0, started);

            let mut stalled = false;
            let mut outcome = None;
            loop {
                tokio::select! {
                    res = &mut fut => {
                        outcome = Some(res);
                        break;
                    }
                    _ = ticker.tick() => {
                        if started.elapsed() < SEGMENT_SLOW_GRACE {
                            continue;
                        }
                        // 只看最近几秒：累计平均值在“前期快、后期骤降”时
                        // 会被前半段拉高，永远发现不了骤降。
                        window.sample(segmented_progress.load(Ordering::Relaxed), Instant::now());
                        if window.rate().is_some_and(|rate| rate < SEGMENT_MIN_RATE_BYTES) {
                            stalled = true;
                            break;
                        }
                    }
                }
            }
            // 放弃分片时直接丢掉 future，连接会立刻释放；返回 None 表示
            // “这条线路不适合多线程”，交给下面的单连接流程。
            if stalled { None } else { outcome }
        };

        match segmented_result {
            Some(Ok(Some(downloaded))) => {
                if let Err(err) =
                    verify_and_commit(&part, dest, downloaded, expected_size, expected_sha1).await
                {
                    let _ = fs::remove_file(&part).await;
                    return Err(err);
                }
                return Ok(downloaded);
            }
            Some(Ok(None)) => {
                // Server did not support Range or size was unsuitable; fall back to single stream.
            }
            _ => {
                // Segmented download failed or was too slow mid-flight; clean up
                // and fall back to single stream with retries.
                if let Some(counter) = retry_counter {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
                let _ = fs::remove_file(&part).await;
            }
        }
    }

    // Single-stream download with automatic retries.
    let mut last_error = String::new();
    let mut attempt: u32 = 0;
    // 被限速另算：这时降低并发、等一会儿能通，直接算失败反而让整个文件重来。
    let mut rate_limited: u32 = 0;
    while attempt < MAX_RETRIES && rate_limited <= MAX_RATE_LIMIT_RETRIES {
        if attempt + rate_limited > 0 {
            if let Some(counter) = retry_counter {
                counter.fetch_add(1, Ordering::Relaxed);
            }
            tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt.max(1)))).await;
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
                if let Some(wait) = rate_limit_wait(&last_error) {
                    penalize_host(url);
                    rate_limited += 1;
                    tokio::time::sleep(wait).await;
                    continue;
                }
                attempt += 1;
            }
        }
    }

    Err(last_error)
}

/// 支持断点续传的多线程下载。
///
/// 分片布局与已完成的分片记在 `<dest>.part.meta` 里：关掉启动器、切换镜像或者
/// 重新点一次下载，都只会补下没完成的那几段，而不是从 0 开始。线路限制并发连接
/// 时（GitHub 加速镜像上很常见），会自动改成单连接把剩余分片顺序补完。
#[derive(Debug, Clone)]
pub struct RangeProbe {
    pub final_url: String,
    pub total: u64,
}

/// Probes whether the server supports HTTP Range requests and resolves the final URL
/// (following redirects while preserving byte-range capabilities).
pub async fn probe_range_support(
    url: &str,
    expected_size: Option<u64>,
) -> Result<Option<RangeProbe>, String> {
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

    let final_url = probe.url().to_string();

    if probe.status() == reqwest::StatusCode::PARTIAL_CONTENT {
        let total = probe
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range_total)
            .or(expected_size)
            .unwrap_or(0);
        drop(probe);
        if total > 0 {
            return Ok(Some(RangeProbe { final_url, total }));
        }
    } else {
        // When reqwest follows cross-origin redirects (e.g. BMCLAPI, Mojang, Adoptium, Azure CDN),
        // it strips the Range header per standard HTTP client security policy, causing the
        // destination server to return 200 OK.
        // If the URL was redirected, probe the terminal destination URL directly with Range.
        let total_hint = probe
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .or(expected_size);
        drop(probe);

        if final_url != url {
            let direct = client()
                .get(&final_url)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .header(RANGE, "bytes=0-0")
                .send()
                .await
                .map_err(|e| format!("分片重定向探测失败 ({final_url}): {e}"))?;

            let terminal_url = direct.url().to_string();
            if direct.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                let total = direct
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_content_range_total)
                    .or(total_hint)
                    .unwrap_or(0);
                drop(direct);
                if total > 0 {
                    return Ok(Some(RangeProbe {
                        final_url: terminal_url,
                        total,
                    }));
                }
            }
        }
    }

    Ok(None)
}

pub async fn download_file_resumable<'a>(
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
    expected_sha1: Option<&str>,
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
    let threads = threads.clamp(1, 64);

    // 先确认这条线路支不支持 Range，顺便拿到总长度与最终重定向目标
    let probe_opt = probe_range_support(url, expected_size).await?;
    let (total, target_url) = match probe_opt {
        Some(probe) => (probe.total, probe.final_url),
        None => (0, url.to_string()),
    };

    let segments = if total >= MIN_MULTITHREAD_SIZE {
        compute_segments(total, threads)
    } else {
        Vec::new()
    };

    if segments.len() <= 1 {
        discard_partial(&part).await;
        return download_file_multithreaded(
            url,
            dest,
            expected_sha1,
            expected_size,
            threads,
            retry_counter,
            on_progress,
        )
        .await;
    }

    // 有旧进度就沿用它（分片布局必须整套照搬，否则已完成的下标对不上），
    // 否则按当前线程数新建布局并预分配 `.part`。
    let mut meta = match read_resume_meta(&part).await {
        Some(meta) if meta.total == total && !meta.segments.is_empty() => meta,
        _ => ResumeMeta {
            total,
            segments: segments.clone(),
            completed: Vec::new(),
            done_bytes: 0,
        },
    };

    let preallocated = fs::metadata(&part)
        .await
        .map(|info| info.len() == total)
        .unwrap_or(false);
    if !preallocated {
        discard_partial(&part).await;
        let file = fs::File::create(&part)
            .await
            .map_err(|e| format!("无法创建分片文件 {}: {e}", part.display()))?;
        file.set_len(total)
            .await
            .map_err(|e| format!("无法预分配文件空间 {}: {e}", part.display()))?;
        meta.completed.clear();
        meta.done_bytes = 0;
        if meta.segments.is_empty() {
            meta.segments = segments;
        }
    }

    write_resume_meta(&part, &meta).await?;

    if let Some(cb) = on_progress.as_mut() {
        cb(meta.done_bytes.min(total), total, 0);
    }

    // 并行阶段出错（常见于镜像对并发连接的 429）不直接判死：先记下来，
    // 后面用单连接把没下完的分片补上，实在不行才报错。
    let mut parallel_error: Option<String> = None;

    if !meta.is_done() {
        let pending: Vec<(u32, u64, u64)> = meta
            .segments
            .iter()
            .enumerate()
            .filter(|(index, _)| meta.missing(*index as u32))
            .map(|(index, range)| (index as u32, range.0, range.1))
            .collect();

        let downloaded = Arc::new(AtomicU64::new(meta.done_bytes.min(total)));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, u64)>();
        let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<(u32, u64)>();

        let mut tasks = tokio::task::JoinSet::new();
        for (index, start, end) in &pending {
            let worker_url = target_url.clone();
            let part = part.clone();
            let downloaded = downloaded.clone();
            let tx = tx.clone();
            let done_tx = done_tx.clone();
            let (index, start, end) = (*index, *start, *end);
            tasks.spawn(async move {
                fetch_range_into(&worker_url, &part, start, end, &downloaded, &tx, None)
                    .await
                    .map(|attempts| {
                        let _ = done_tx.send((index, end - start + 1));
                        attempts
                    })
            });
        }

        let mut progress_open = true;
        let mut completion_open = true;
        let started = Instant::now();
        let mut ticker = tokio::time::interval(SEGMENT_WATCHDOG_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await;
        let mut window = SpeedWindow::new(SPEED_WINDOW);
        let window_seed = meta.done_bytes;
        window.sample(window_seed, started);

        while !meta.is_done() {
            tokio::select! {
                biased;
                message = rx.recv(), if progress_open => {
                    match message {
                        Some((current, delta)) => {
                            if let Some(cb) = on_progress.as_mut() {
                                cb(current.min(total), total, delta);
                            }
                        }
                        None => progress_open = false,
                    }
                }
                finished = done_rx.recv(), if completion_open => {
                    match finished {
                        Some((index, len)) => {
                            if meta.missing(index) {
                                meta.completed.push(index);
                                meta.done_bytes += len;
                                write_resume_meta(&part, &meta).await?;
                            }
                        }
                        None => completion_open = false,
                    }
                }
                joined = tasks.join_next() => {
                    match joined {
                        Some(Ok(Ok(attempts))) => {
                            if attempts > 0 {
                                if let Some(counter) = retry_counter {
                                    counter.fetch_add(u64::from(attempts), Ordering::Relaxed);
                                }
                            }
                        }
                        Some(Ok(Err(error))) => {
                            parallel_error = Some(error);
                            break;
                        }
                        Some(Err(_)) => {}
                        None => break,
                    }
                }
                _ = ticker.tick() => {
                    if started.elapsed() < SEGMENT_SLOW_GRACE {
                        continue;
                    }
                    // 同样只看滑动窗口，不拿累计平均值当唯一依据。
                    window.sample(downloaded.load(Ordering::Relaxed), Instant::now());
                    if window.rate().is_some_and(|rate| rate < SEGMENT_MIN_RATE_BYTES) {
                        break;
                    }
                }
            }
        }

        tasks.abort_all();
        while let Ok((index, len)) = done_rx.try_recv() {
            if meta.missing(index) {
                meta.completed.push(index);
                meta.done_bytes += len;
            }
        }

        if !meta.is_done() {
            let remaining: Vec<(u32, u64, u64)> = meta
                .segments
                .iter()
                .enumerate()
                .filter(|(index, _)| meta.missing(*index as u32))
                .map(|(index, range)| (index as u32, range.0, range.1))
                .collect();

            for (index, start, end) in remaining {
                // 一边补这一片，一边把分片里的进度报出去：慢线路上单连接可能
                // 要拉几分钟，不能等到整片结束才有动静。
                let attempts = {
                    let fetch =
                        fetch_range_into(&target_url, &part, start, end, &downloaded, &tx, None);
                    tokio::pin!(fetch);
                    loop {
                        tokio::select! {
                            biased;
                            message = rx.recv() => {
                                if let Some((current, delta)) = message {
                                    if let Some(cb) = on_progress.as_mut() {
                                        cb(current.min(total), total, delta);
                                    }
                                }
                            }
                            result = &mut fetch => break result,
                        }
                    }
                };
                let attempts = attempts?;
                if attempts > 0 {
                    if let Some(counter) = retry_counter {
                        counter.fetch_add(u64::from(attempts), Ordering::Relaxed);
                    }
                }
                if meta.missing(index) {
                    meta.completed.push(index);
                    meta.done_bytes += end - start + 1;
                    write_resume_meta(&part, &meta).await?;
                }
            }
        }
    }

    if !meta.is_done() {
        // 保留 `.part` 与旁车文件：下次（或下一条镜像）接着补，而不是从 0 重来。
        return Err(parallel_error.unwrap_or_else(|| "下载未完成，可以继续下载".to_string()));
    }

    verify_and_commit(&part, dest, total, Some(total), expected_sha1).await?;
    let _ = fs::remove_file(resume_meta_path(&part)).await;
    Ok(total)
}

async fn download_single_stream<'a>(
    url: &str,
    part: &Path,
    expected_size: Option<u64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    // 单连接也要排进该线路的并发额度：十几个小文件同时开拉，对按 IP 限速的
    // 镜像来说和分片没有区别。
    let _slot = acquire_host_slot(url).await;
    let response = client()
        .get(url)
        // Binary payloads must stay byte-exact for checksum verification, so
        // never let transparent decompression touch them.
        .header(reqwest::header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|e| format!("下载请求失败 ({url}): {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let retry_after = retry_after_suffix(&response);
        return Err(format!("下载失败 ({url}): HTTP {status}{retry_after}"));
    }

    let total = response.content_length().or(expected_size).unwrap_or(0);
    let mut file = fs::File::create(part)
        .await
        .map_err(|e| format!("无法写入 {}: {e}", part.display()))?;

    let mut downloaded: u64 = 0;
    let mut window_started = Instant::now();
    let mut window_bytes: u64 = 0;
    let mut stream = response.bytes_stream();
    // Java 版由数千个小文件组成，绝大多数走这条单连接流程：此前这里没有
    // 任何停滞检测，一个卡住的文件会占住 worker 直到 600 秒全局超时。
    // 与分片下载保持一致，30 秒收不到字节就直接报错，重试或换镜像。
    while let Some(chunk) = tokio::time::timeout(SEGMENT_IDLE_TIMEOUT, stream.next())
        .await
        .map_err(|_| {
            format!(
                "下载停滞超过 {} 秒 ({url})",
                SEGMENT_IDLE_TIMEOUT.as_secs()
            )
        })?
    {
        let chunk = chunk.map_err(|e| format!("下载中断 ({url}): {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
        let delta = chunk.len() as u64;
        downloaded += delta;
        window_bytes += delta;
        if let Some(cb) = on_progress.as_mut() {
            cb(downloaded, total, delta);
        }
        if stream_rate_is_too_low(window_bytes, window_started.elapsed()) {
            return Err(format!(
                "下载速率过低（{:.0} B/S, {url}），换镜像重试",
                window_bytes as f64 / window_started.elapsed().as_secs_f64().max(0.001)
            ));
        }
        if window_started.elapsed() >= SINGLE_STREAM_RATE_WINDOW {
            window_started = Instant::now();
            window_bytes = 0;
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
    drop(file);
    note_host_success(url);
    Ok(downloaded)
}

/// 断点续传的旁车文件：记下分片布局与已完成的段，和 `.part` 同目录同前缀。
#[derive(Serialize, Deserialize, Clone, Default)]
struct ResumeMeta {
    /// 文件总长度，用来判断旁车文件是否还对得上这条线路。
    total: u64,
    /// 分片布局。续传时沿用它，而不是按当前线程数重算，否则已完成的
    /// 下标会对不上。
    segments: Vec<(u64, u64)>,
    completed: Vec<u32>,
    /// 已完成分片的字节总数，用来在续传时立刻显示“已下载”。
    done_bytes: u64,
}

impl ResumeMeta {
    fn is_done(&self) -> bool {
        !self.segments.is_empty() && self.completed.len() >= self.segments.len()
    }

    fn missing(&self, index: u32) -> bool {
        !self.completed.contains(&index)
    }
}

fn resume_meta_path(part: &Path) -> PathBuf {
    let mut name = part.file_name().unwrap_or_default().to_os_string();
    name.push(".meta");
    part.with_file_name(name)
}

/// `<dest>.part.meta` 的路径：调用方清理续传记录时用得上。
pub fn resume_sidecar_path(dest: &Path) -> PathBuf {
    resume_meta_path(&part_path(dest))
}

/// 可续传的进度（已下载字节）。没有 `.part.meta`、或它与当前 `.part`
/// 对不上时返回 `None`，表示只能重头下载。
pub fn resume_progress(dest: &Path) -> Option<u64> {
    let part = part_path(dest);
    let text = std::fs::read_to_string(resume_meta_path(&part)).ok()?;
    let meta: ResumeMeta = serde_json::from_str(&text).ok()?;
    let length = std::fs::metadata(&part).ok()?.len();
    if meta.total == 0 || length != meta.total {
        return None;
    }
    (meta.done_bytes > 0).then_some(meta.done_bytes.min(meta.total))
}

async fn read_resume_meta(part: &Path) -> Option<ResumeMeta> {
    let text = fs::read_to_string(resume_meta_path(part)).await.ok()?;
    serde_json::from_str(&text).ok()
}

/// 先写临时文件再改名，避免写一半的 JSON 让续传彻底失效。
async fn write_resume_meta(part: &Path, meta: &ResumeMeta) -> Result<(), String> {
    let path = resume_meta_path(part);
    let temp = path.with_extension("meta.tmp");
    let text = serde_json::to_string(meta).map_err(|e| format!("进度写入失败: {e}"))?;
    fs::write(&temp, text)
        .await
        .map_err(|e| format!("进度写入失败 {}: {e}", temp.display()))?;
    fs::rename(&temp, &path)
        .await
        .map_err(|e| format!("进度写入失败 {}: {e}", path.display()))?;
    Ok(())
}

/// 丢弃 `.part` 与旁车文件：只有确认无法续传时才能这么做。
async fn discard_partial(part: &Path) {
    let _ = fs::remove_file(part).await;
    let _ = fs::remove_file(resume_meta_path(part)).await;
}

/// 清掉 `dest` 这次下载留下的半成品（`.part` 与续传旁车文件）。
/// 用户取消内容下载后调用，已经落盘的正式文件不受影响。
///
/// 被中止的下载可能还有一次写入在阻塞线程里没结束，Windows 上删除这种
/// 仍被打开的文件会报共享冲突。只试一次就会把半成品永久留在盘上，所以
/// 这里短暂重试几次（最多 ~0.6 秒），文件一旦被清掉就立刻返回。
pub async fn discard_partial_files(dest: &Path) {
    let part = part_path(dest);
    let meta = resume_meta_path(&part);
    for delay in [0, 20, 40, 80, 160, 320] {
        if delay > 0 {
            tokio::time::sleep(Duration::from_millis(delay)).await;
        }
        discard_partial(&part).await;
        let part_left = fs::try_exists(&part).await.unwrap_or(false);
        let meta_left = fs::try_exists(&meta).await.unwrap_or(false);
        if !part_left && !meta_left {
            return;
        }
    }
}

/// 下载一个字节区间并写进 `.part` 的对应偏移，失败时按 `MAX_RETRIES`
/// 重试；重试前把自己这次写入的字节从总进度里扣回去。
///
/// `progress` 记录“本次尝试已写入多少字节”（每次重试归零），监督者靠它
/// 算出某个块最近几秒有没有进展，从而决定要不要把剩余区间回收给别的连接。
async fn fetch_range_into(
    url: &str,
    part: &Path,
    start: u64,
    end: u64,
    downloaded: &AtomicU64,
    tx: &tokio::sync::mpsc::UnboundedSender<(u64, u64)>,
    progress: Option<&AtomicU64>,
) -> Result<u32, String> {
    let expected_len = end - start + 1;
    let mut last_err = String::new();
    let mut attempts: u32 = 0;
    let mut rate_limited: u32 = 0;
    loop {
        if attempts >= MAX_RETRIES && rate_limited >= MAX_RATE_LIMIT_RETRIES {
            break;
        }
        if attempts + rate_limited > 0 {
            let backoff = (200 * u64::from(attempts.max(1))).min(1_500);
            tokio::time::sleep(Duration::from_millis(backoff)).await;
        }
        // 先在这条线路的并发额度里占位：同一个镜像被所有分片一起猛拉，
        // 正是它按 IP 限速的直接原因。
        let _slot = acquire_host_slot(url).await;
        let mut written_this_attempt: u64 = 0;
        if let Some(progress) = progress {
            progress.store(0, Ordering::Relaxed);
        }
        let res: Result<(), String> = async {
            let response = client()
                .get(url)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .header(RANGE, format!("bytes={start}-{end}"))
                .send()
                .await
                .map_err(|e| format!("分片请求失败 ({url}): {e}"))?;

            // If a redirect occurred and the target returned 200 (due to Range header being stripped on redirect),
            // reissue the Range request directly to the redirected target.
            let redirected_url = response.url().to_string();
            let response = if response.status() == reqwest::StatusCode::OK && redirected_url != url
            {
                drop(response);
                client()
                    .get(&redirected_url)
                    .header(reqwest::header::ACCEPT_ENCODING, "identity")
                    .header(RANGE, format!("bytes={start}-{end}"))
                    .send()
                    .await
                    .map_err(|e| format!("分片重定向请求失败 ({redirected_url}): {e}"))?
            } else {
                response
            };

            if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
                let status = response.status();
                let retry_after = retry_after_suffix(&response);
                return Err(format!(
                    "服务器未返回分片数据 ({url}): HTTP {status}{retry_after}"
                ));
            }

            let mut file = fs::OpenOptions::new()
                .write(true)
                .open(part)
                .await
                .map_err(|e| format!("无法打开分片文件 {}: {e}", part.display()))?;
            file.seek(SeekFrom::Start(start))
                .await
                .map_err(|e| format!("分片定位失败 {}: {e}", part.display()))?;

            let mut stream = response.bytes_stream();
            loop {
                let next = tokio::time::timeout(SEGMENT_IDLE_TIMEOUT, stream.next())
                    .await
                    .map_err(|_| {
                        format!(
                            "分片 {} 秒没有收到数据 ({url})",
                            SEGMENT_IDLE_TIMEOUT.as_secs()
                        )
                    })?;
                let Some(chunk) = next else {
                    break;
                };
                let chunk = chunk.map_err(|e| format!("分片下载中断 ({url}): {e}"))?;
                let len = chunk.len() as u64;
                if written_this_attempt + len > expected_len {
                    return Err("分片返回字节超出范围".to_string());
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("分片写入失败 {}: {e}", part.display()))?;
                written_this_attempt += len;
                if let Some(progress) = progress {
                    progress.store(written_this_attempt, Ordering::Relaxed);
                }
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
            Ok(()) => {
                note_host_success(url);
                return Ok(attempts + rate_limited);
            }
            Err(error) => {
                if written_this_attempt > 0 {
                    downloaded.fetch_sub(written_this_attempt, Ordering::Relaxed);
                }
                if let Some(wait) = rate_limit_wait(&error) {
                    // 被限速：把这个主机的并发减半，按服务端要求等一会儿，
                    // 而不是用同样的连接数立刻又撞上去。
                    penalize_host(url);
                    rate_limited += 1;
                    last_err = error;
                    tokio::time::sleep(wait).await;
                    continue;
                }
                attempts += 1;
                last_err = error;
            }
        }
    }
    Err(last_err)
}

/// 单个活跃分块的状态，供每秒一次的监督使用。
struct ChunkRun {
    start: u64,
    end: u64,
    reclaims: u32,
    /// 本次尝试已写入的字节数，由下载任务实时更新。
    written: Arc<AtomicU64>,
    last_written: u64,
    /// 最近一次有新字节的时刻（判断“彻底卡死”）。
    last_advanced: Instant,
    /// 最近一次统计时刻与算出的瞬时速率（判断“比别人慢很多”）。
    last_sample: Instant,
    rate: f64,
    started: Instant,
    handle: tokio::task::AbortHandle,
}

/// 把进度计数器减去 `amount`，不把计数器减到下溢。
fn sub_saturating(counter: &AtomicU64, amount: u64) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(amount))
    });
}

/// 收回进展明显落后或彻底卡住的块：中止它、把它剩下的区间放回队列头部，
/// 让空闲连接立刻接走。
///
/// 这一步是“整体速度突然掉到单连接水平”的直接解药：一条连接变慢/假死时，
/// 它占着的那段区间不再需要等它慢慢拉完，也不会拖住整份文件。
fn supervise_chunks(
    runs: &mut Vec<ChunkRun>,
    queue: &mut std::collections::VecDeque<(u64, u64, u32)>,
    downloaded: &AtomicU64,
    reference: &mut f64,
) {
    let now = Instant::now();
    let mut current = 0.0f64;
    for run in runs.iter_mut() {
        let written = run.written.load(Ordering::Relaxed);
        let elapsed = now.duration_since(run.last_sample).as_secs_f64().max(0.001);
        let delta = written.saturating_sub(run.last_written);
        run.rate = delta as f64 / elapsed;
        if delta > 0 {
            run.last_advanced = now;
        }
        run.last_written = written;
        run.last_sample = now;
        if now.duration_since(run.started) >= CHUNK_SLOW_MIN_AGE {
            current = current.max(run.rate);
        }
    }
    // 参照取“迄今为止见到过的好线路速度”：好块下完离场后它的速率仍要
    // 留着当基准，否则剩下的慢块就再也没东西可以比了。
    *reference = reference.max(current);

    let mut keep = Vec::with_capacity(runs.len());
    for run in runs.drain(..) {
        let age = now.duration_since(run.started);
        let idle = now.duration_since(run.last_advanced);
        // “比别人慢很多”需要参照；“彻底没有新字节”不需要：块已经下完离场时
        // 参照速率为零，这时候假死的那一块反而最需要被收回来。
        let too_slow = *reference > 0.0
            && age >= CHUNK_SLOW_MIN_AGE
            && run.rate < *reference * CHUNK_SLOW_RATIO;
        if run.reclaims < CHUNK_MAX_RECLAIMS && (too_slow || idle >= CHUNK_STALL_WINDOW) {
            run.handle.abort();
            let written = run.written.load(Ordering::Relaxed);
            sub_saturating(downloaded, written);
            let resume_at = run.start.saturating_add(written);
            if resume_at <= run.end {
                queue.push_front((resume_at, run.end, run.reclaims + 1));
            }
            continue;
        }
        keep.push(run);
    }
    *runs = keep;
}

/// Probes whether the server supports HTTP Range requests and, if so, downloads the file
/// in parallel byte chunks. Returns `Ok(None)` if Range is not supported.
///
/// 所有连接共用一个块队列：谁先下完谁接着领下一块，慢连接只影响它手上
/// 那一小块，超时/明显偏慢时剩余区间会被收回重发。
async fn try_segmented_download<'a>(
    url: &str,
    part: &Path,
    expected_size: Option<u64>,
    threads: usize,
    // 调用方可以在下载途中抬高连接上限（其它阶段收尾后把连接让出来）。
    thread_limit: Option<&Arc<AtomicUsize>>,
    max_workers: usize,
    min_total: u64,
    min_segment: u64,
    retry_counter: Option<&AtomicU64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<Option<u64>, String> {
    let Some(probe) = probe_range_support(url, expected_size).await? else {
        return Ok(None);
    };

    let total = probe.total;
    let final_url = probe.final_url;

    if total < min_total {
        return Ok(None);
    }

    let chunks = compute_chunks_with(total, max_workers.max(threads), min_segment);
    if chunks.len() <= 1 {
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
    let mut queue: std::collections::VecDeque<(u64, u64, u32)> =
        chunks.into_iter().map(|(start, end)| (start, end, 0)).collect();
    let fixed_workers = threads.clamp(1, 64);
    let mut runs: Vec<ChunkRun> = Vec::new();
    let mut tasks: tokio::task::JoinSet<(u64, Result<u32, String>)> = tokio::task::JoinSet::new();
    let mut ticker = tokio::time::interval(CHUNK_SUPERVISE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    let mut attempts_total: u64 = 0;
    let mut progress_open = true;
    let mut failure: Option<String> = None;
    // 参照速率：由下完的块（以及活着的快块）不断抬高，用来识别“明显比别人慢”。
    let mut reference_rate = 0.0f64;

    loop {
        // 每轮都重新读一次上限：调用方把连接让出来以后，这里立刻多用几条；
        // 线路被限速过的话，再把它自己的并发额度当上限——多开的连接只会在
        // 闸门前干等，还会被监督当成“卡死”回收。
        let workers = match thread_limit {
            Some(limit) => limit.load(Ordering::Relaxed),
            None => fixed_workers,
        }
        .clamp(1, 64)
        .min(host_connection_limit(&final_url))
        .min(queue.len() + tasks.len())
        .max(1);
        while tasks.len() < workers {
            let Some((start, end, reclaims)) = queue.pop_front() else {
                break;
            };
            let written = Arc::new(AtomicU64::new(0));
            let handle = {
                let worker_url = final_url.clone();
                let part = part.to_path_buf();
                let downloaded = downloaded.clone();
                let tx = tx.clone();
                let written = written.clone();
                tasks.spawn(async move {
                    let outcome = fetch_range_into(
                        &worker_url,
                        &part,
                        start,
                        end,
                        &downloaded,
                        &tx,
                        Some(&written),
                    )
                    .await;
                    (start, outcome)
                })
            };
            let now = Instant::now();
            runs.push(ChunkRun {
                start,
                end,
                reclaims,
                written,
                last_written: 0,
                last_advanced: now,
                last_sample: now,
                rate: 0.0,
                started: now,
                handle,
            });
        }

        if queue.is_empty() && runs.is_empty() {
            break;
        }

        tokio::select! {
            biased;
            maybe_msg = rx.recv(), if progress_open => {
                match maybe_msg {
                    Some((current, delta)) => {
                        if let Some(cb) = on_progress.as_mut() {
                            cb(current.min(total), total, delta);
                        }
                    }
                    None => progress_open = false,
                }
            }
            joined = tasks.join_next(), if !tasks.is_empty() => {
                match joined {
                    Some(Ok((start, Ok(attempts)))) => {
                        attempts_total += u64::from(attempts);
                        if let Some(run) = runs.iter().find(|run| run.start == start) {
                            let secs = run.started.elapsed().as_secs_f64().max(0.001);
                            let len = (run.end - run.start + 1) as f64;
                            reference_rate = reference_rate.max(len / secs);
                        }
                        runs.retain(|run| run.start != start);
                    }
                    Some(Ok((start, Err(error)))) => {
                        runs.retain(|run| run.start != start);
                        failure = Some(error);
                        break;
                    }
                    // 被回收而中止的块：区间已经重新入队，状态在回收时清掉了。
                    Some(Err(_)) => {}
                    None => {}
                }
            }
            _ = ticker.tick() => {
                supervise_chunks(&mut runs, &mut queue, &downloaded, &mut reference_rate);
                // 任务表空了却还挂着块：那条任务的区间被丢了（任务 panic 或被
                // 外部中止）。不把区间放回去，这个循环就永远等不到“队列与块表
                // 同时清空”，下载会卡在收尾阶段结束不了。
                if tasks.is_empty() && !runs.is_empty() {
                    let orphans: Vec<ChunkRun> = runs.drain(..).collect();
                    let mut fatal = false;
                    for run in orphans {
                        if run.reclaims >= CHUNK_MAX_RECLAIMS {
                            fatal = true;
                        } else {
                            queue.push_back((run.start, run.end, run.reclaims + 1));
                        }
                    }
                    if fatal {
                        failure = Some("分片任务异常退出，剩余区间无法继续下载".to_string());
                        break;
                    }
                }
            }
        }
    }

    // 被中止/未收尾的任务在这里统一放手，连接立刻释放。
    tasks.shutdown().await;

    if let Some(error) = failure {
        return Err(error);
    }
    if !queue.is_empty() || !runs.is_empty() {
        return Err("分片下载未能覆盖全部区间".to_string());
    }
    if let Some(counter) = retry_counter {
        if attempts_total > 0 {
            counter.fetch_add(attempts_total, Ordering::Relaxed);
        }
    }
    // Drain any remaining progress notifications.
    while let Ok((current, delta)) = rx.try_recv() {
        if let Some(cb) = on_progress.as_mut() {
            cb(current.min(total), total, delta);
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

/// 分块调度用的切块：目标 4 MB 一块，至少每个连接分到一块，
/// 并且保证每块不小于 `MIN_SEGMENT_SIZE`。
///
/// 块比分片小程序得多，一条慢连接最多拖住一个块，而不是整份文件的
/// 1/线程数——这正是下载中途速度“莫名骤降”的主因。
/// 与 `compute_chunks` 相同，但允许更小的分块（元数据文件用）。
pub fn compute_chunks_with(total: u64, workers: usize, min_segment: u64) -> Vec<(u64, u64)> {
    if total == 0 {
        return Vec::new();
    }
    let workers = workers.clamp(1, 64);
    let by_target = (total / CHUNK_TARGET_BYTES).max(1) as usize;
    let count = by_target.max(workers).min(512);
    compute_segments_with(total, count, min_segment)
}

pub fn compute_segments(total: u64, max_threads: usize) -> Vec<(u64, u64)> {
    compute_segments_with(total, max_threads, MIN_SEGMENT_SIZE)
}

pub fn compute_segments_with(total: u64, max_threads: usize, min_segment: u64) -> Vec<(u64, u64)> {
    if total == 0 {
        return Vec::new();
    }
    let min_segment = min_segment.max(1);
    let max_by_size = (total / min_segment).max(1) as usize;
    let count = max_threads.clamp(1, 64).min(max_by_size);
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
        None if max_threads > 1 => max_threads.clamp(1, 16) as u32,
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

/// 平滑下载速率显示：各下载链路原来直接上报“距上次推送的字节差 / 时间差”，
/// 小文件收尾、建连换源的空隙里就会在 0 和突发峰值之间反复横跳。
/// 这里做指数移动平均（EMA），停顿时向 0 衰减而不是直接归零或跳回全局平均。
#[derive(Debug, Clone)]
pub struct SpeedSmoother {
    smooth: f64,
}

impl SpeedSmoother {
    pub fn new() -> Self {
        Self { smooth: 0.0 }
    }

    /// 输入一次瞬时速率采样，返回平滑后的显示值。
    /// `elapsed_ms` 是该采样的统计窗口：窗口太小（<30ms，多为任务收尾时
    /// 被强制推送的一帧）时不更新，避免单帧尖峰把显示值顶飞。
    pub fn update(&mut self, instant_bps: u64, elapsed_ms: u64) -> u64 {
        if elapsed_ms >= 30 {
            let value = instant_bps as f64;
            if value > 0.0 {
                if self.smooth <= 0.0 {
                    self.smooth = value;
                } else {
                    self.smooth += (value - self.smooth) * 0.4;
                }
            } else {
                self.smooth *= 0.6;
                if self.smooth < 512.0 {
                    self.smooth = 0.0;
                }
            }
        }
        self.smooth as u64
    }

    pub fn current(&self) -> u64 {
        self.smooth as u64
    }
}

impl Default for SpeedSmoother {
    fn default() -> Self {
        Self::new()
    }
}

/// 滑动窗口吞吐统计，供下载看门狗判定“最近真的慢了”。
///
/// 原来看门狗用的是 `累计字节 / 总耗时`：一个文件前面下得快、后面骤降时，
/// 平均值要靠很久才会低于阈值，表现出来的就是“卡在那儿不动也不换方案”。
/// 这里只保留窗口内的采样点，算出最近几秒的实际速率。
#[derive(Debug)]
struct SpeedWindow {
    window: Duration,
    samples: std::collections::VecDeque<(Instant, u64)>,
}

impl SpeedWindow {
    fn new(window: Duration) -> Self {
        Self {
            window,
            samples: std::collections::VecDeque::new(),
        }
    }

    /// 记一个采样点（`total` 是累计已下载字节），并丢掉窗口外的旧样本。
    fn sample(&mut self, total: u64, now: Instant) {
        self.samples.push_back((now, total));
        while self.samples.len() > 2 {
            let Some(&(oldest, _)) = self.samples.front() else {
                break;
            };
            if now.duration_since(oldest) > self.window {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    /// 最近窗口内的字节/秒；样本不足两个时返回 `None`，不急着下结论。
    fn rate(&self) -> Option<f64> {
        let (first_at, first) = *self.samples.front()?;
        let (last_at, last) = *self.samples.back()?;
        let elapsed = last_at.duration_since(first_at).as_secs_f64();
        if elapsed <= 0.0 || self.samples.len() < 2 {
            return None;
        }
        Some(last.saturating_sub(first) as f64 / elapsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手动测速探针：跑真实 CDN 的分片下载并打印吞吐，用来验证连接模型改动。
    /// `cargo test --lib -- --ignored --nocapture manual_segment_throughput`
    #[tokio::test]
    #[ignore = "manual throughput probe against a real CDN"]
    async fn manual_segment_throughput_probe() {
        const URL: &str = "https://piston-data.mojang.com/v1/objects/0f275bc1547d01fa5f56ba34bdc87d981ee12daf/client.jar";
        const SIZE: u64 = 10_180_113;
        let dir = std::env::temp_dir().join("cobble-throughput-probe");
        let _ = std::fs::remove_dir_all(&dir);
        let dest = dir.join("client.jar");
        let mut progress = |_done: u64, _total: u64, _delta: u64| {};
        let started = Instant::now();
        let bytes = download_file_with_mirrors(
            URL,
            &dest,
            None,
            Some(SIZE),
            16,
            None,
            Some(&mut progress),
        )
        .await
        .unwrap();
        let secs = started.elapsed().as_secs_f64();
        println!(
            "probe: {bytes} bytes in {secs:.2}s = {:.0} KB/s",
            bytes as f64 / 1024.0 / secs
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn speed_smoother_converges_without_jumping() {
        let mut smoother = SpeedSmoother::new();
        // 首个采样直接采用，避免从 0 爬升的迟滞。
        assert_eq!(smoother.update(10_000_000, 120), 10_000_000);
        // 同量级抖动只会小幅跟随，不会照单全收。
        let second = smoother.update(12_000_000, 120);
        assert!(second > 10_000_000 && second < 12_000_000, "second={second}");
        // 极小窗口的收尾帧不更新，避免单帧尖峰。
        let frozen = smoother.current();
        assert_eq!(smoother.update(90_000_000, 5), frozen);
        // 停顿逐次衰减而不是直接归零。
        let decayed = smoother.update(0, 2000);
        assert!(decayed > 0 && decayed < frozen, "decayed={decayed}");
        // 长时间停顿最终归零。
        for _ in 0..30 {
            smoother.update(0, 2000);
        }
        assert_eq!(smoother.current(), 0);
    }

    #[test]
    fn parses_content_range_header() {
        assert_eq!(
            parse_content_range_total("bytes 0-0/31457280"),
            Some(31_457_280)
        );
        assert_eq!(parse_content_range_total("bytes 0-1023/*"), None);
        assert_eq!(parse_content_range_total("invalid"), None);
    }

    /// 内容目录的 JSON 现在带 `Accept-Encoding`：没有它，一个 CurseForge 搜索
    /// 页的 250 KB 未压缩 JSON 在本机线路上要十秒。这条测试用本地服务器确认
    /// 请求声明了 gzip，并且压缩后的响应体被正常解码。
    #[tokio::test]
    async fn json_fetch_requests_gzip_and_decodes_a_compressed_body() {
        use std::io::Write as _;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let mut head = Vec::new();
            loop {
                let read = socket.read(&mut buf).await.unwrap();
                if read == 0 {
                    break;
                }
                head.extend_from_slice(&buf[..read]);
                if head.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&head).to_ascii_lowercase();
            let accepts_gzip = request
                .lines()
                .any(|line| line.starts_with("accept-encoding:") && line.contains("gzip"));

            let body = br#"{"value":42}"#;
            let (payload, encoding) = if accepts_gzip {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(body).unwrap();
                (encoder.finish().unwrap(), "gzip")
            } else {
                (body.to_vec(), "identity")
            };
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nContent-Encoding: {encoding}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(&payload).await;
            let _ = socket.flush().await;
            accepts_gzip
        });

        let value: serde_json::Value = fetch_json(
            &format!("http://{addr}/search.json"),
            Duration::from_secs(5),
            1,
        )
        .await
        .unwrap();
        assert_eq!(value["value"], 42);
        assert!(
            server.await.unwrap(),
            "fetch_json 必须声明支持 gzip，否则目录 JSON 以未压缩方式传输"
        );
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
    fn github_raw_url_falls_back_to_jsdelivr_and_proxies() {
        let mirrors = get_mirror_urls(
            "https://raw.githubusercontent.com/Cerlesse-studio/Open-source-Minecraft-launcher/main/docs/images/logo.png",
        );
        assert!(mirrors.contains(
            &"https://cdn.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/logo.png"
                .to_string()
        ));
        assert!(mirrors.contains(
            &"https://fastly.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/logo.png"
                .to_string()
        ));
        assert!(mirrors.contains(
            &"https://gcore.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/logo.png"
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

    /// `preferred_urls` reads process-wide download settings, so every test that
    /// changes them has to hold this lock instead of racing another test.
    static PREFERENCE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn preferred_urls_follow_the_selected_source() {
        let _guard = PREFERENCE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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
        assert_eq!(preferred_urls(url).first().map(String::as_str), Some(url));
    }

    #[test]
    fn microsoft_source_keeps_official_files_off_third_party_mirrors() {
        let _guard = PREFERENCE_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let library =
            "https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar";
        set_download_preference("microsoft", "", None);
        assert_eq!(preferred_urls(library), vec![library.to_string()]);

        // 官方 CDN 模式才允许把同一个文件回退到 BMCLAPI。
        set_download_preference("official_ap", "", None);
        assert!(preferred_urls(library)
            .iter()
            .any(|candidate| is_bmclapi(candidate)));

        // Fabric 的 Maven 不是 Microsoft 托管的，它的镜像回退必须保留。
        let fabric = "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar";
        set_download_preference("microsoft", "", None);
        let fabric_urls = preferred_urls(fabric);
        assert_eq!(fabric_urls.first().map(String::as_str), Some(fabric));
        assert!(fabric_urls.iter().any(|candidate| is_bmclapi(candidate)));

        set_download_preference("official_ap", "", None);
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

    /// 本地最小 HTTP 服务器：只用于验证 Range 分片、续传与回退逻辑，不碰网络。
    struct RangeServer {
        url: String,
        /// 服务端收到过的 Range 请求（含探测），用来断言没重复下已完成的分片。
        requests: Arc<std::sync::Mutex<Vec<(u64, u64)>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for RangeServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    #[derive(Clone, Copy)]
    struct ServerOptions {
        honor_range: bool,
        stall_segments: bool,
        /// 启动后的这段时间里每个连接只给 `slow_rate_bytes`/s，用来触发慢速看门狗。
        slow_window: Duration,
        /// 慢速窗口内每个连接每秒允许多少字节（默认 1 KB/s）。
        slow_rate_bytes: u64,
        /// 第一个非探测的分块请求只回头不回体（模拟一条中途假死的连接）。
        stall_first_chunk_once: bool,
        /// 第一个非探测的分块请求慢到 32 KB/s（模拟一条没死但被严重限速的连接）。
        slow_first_chunk_once: bool,
        /// 前 N 个非探测请求回 429（模拟镜像/代理按 IP 限并发）。
        rate_limit_first: usize,
        /// 429 响应的 `Retry-After` 秒数。
        rate_limit_retry_after: u64,
    }

    impl Default for ServerOptions {
        fn default() -> Self {
            Self {
                honor_range: true,
                stall_segments: false,
                slow_window: Duration::ZERO,
                slow_rate_bytes: 1024,
                stall_first_chunk_once: false,
                slow_first_chunk_once: false,
                rate_limit_first: 0,
                rate_limit_retry_after: 1,
            }
        }
    }

    async fn spawn_range_server(
        bytes: Arc<Vec<u8>>,
        honor_range: bool,
        stall_segments: bool,
    ) -> RangeServer {
        spawn_range_server_with(
            bytes,
            ServerOptions {
                honor_range,
                stall_segments,
                ..Default::default()
            },
        )
        .await
    }

    async fn spawn_range_server_with(bytes: Arc<Vec<u8>>, options: ServerOptions) -> RangeServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let stalled_once = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let limited_served = Arc::new(std::sync::Mutex::new(0usize));
        let started = Instant::now();
        let task = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let bytes = bytes.clone();
                let requests = recorded.clone();
                let stalled_once = stalled_once.clone();
                let limited_served = limited_served.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = vec![0u8; 4096];
                    let mut head = Vec::new();
                    loop {
                        let Ok(read) = socket.read(&mut buf).await else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        head.extend_from_slice(&buf[..read]);
                        if head.windows(4).any(|window| window == b"\r\n\r\n") {
                            break;
                        }
                    }

                    let request = String::from_utf8_lossy(&head).to_string();
                    let mut range: Option<(u64, u64)> = None;
                    for line in request.lines() {
                        let lower = line.to_ascii_lowercase();
                        if let Some(spec) = lower.strip_prefix("range:") {
                            let spec = spec.trim().trim_start_matches("bytes=");
                            if let Some((start, end)) = spec.split_once('-') {
                                let start: u64 = start.trim().parse().unwrap_or(0);
                                let end: u64 = end
                                    .trim()
                                    .parse()
                                    .unwrap_or(bytes.len().saturating_sub(1) as u64);
                                range = Some((start, end));
                            }
                        }
                    }

                    if let Some(range) = range {
                        requests.lock().unwrap().push(range);
                    }

                    let total = bytes.len() as u64;
                    let probe = range == Some((0, 0));
                    // 先模拟“按 IP 限速”：前几个真请求直接 429，带上 Retry-After。
                    let rate_limited = if options.rate_limit_first > 0 && !probe {
                        let mut served = limited_served.lock().unwrap();
                        if *served < options.rate_limit_first {
                            *served += 1;
                            true
                        } else {
                            false
                        }
                    } else {
                        false
                    };
                    if rate_limited {
                        let body = b"rate limited";
                        let header = format!(
                            "HTTP/1.1 429 Too Many Requests\r\nRetry-After: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            options.rate_limit_retry_after.max(1),
                            body.len()
                        );
                        if socket.write_all(header.as_bytes()).await.is_err() {
                            return;
                        }
                        let _ = socket.write_all(body).await;
                        let _ = socket.flush().await;
                        return;
                    }
                    match range {
                        Some((start, end)) if options.honor_range && start < total => {
                            let end = end.min(total - 1);
                            let slice = &bytes[start as usize..=end as usize];
                            let header = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{total}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                                slice.len()
                            );
                            // 探测（0-0）照常返回；模拟一条假死连接：只回头不回体。
                            if options.stall_first_chunk_once
                                && !probe
                                && !stalled_once.swap(true, Ordering::SeqCst)
                            {
                                let _ = socket.write_all(header.as_bytes()).await;
                                let _ = socket.flush().await;
                                tokio::time::sleep(Duration::from_secs(60)).await;
                                return;
                            }
                            if options.slow_first_chunk_once
                                && !probe
                                && !stalled_once.swap(true, Ordering::SeqCst)
                            {
                                if socket.write_all(header.as_bytes()).await.is_err() {
                                    return;
                                }
                                let mut offset = 0usize;
                                while offset < slice.len() {
                                    let take = (slice.len() - offset).min(4096);
                                    if socket
                                        .write_all(&slice[offset..offset + take])
                                        .await
                                        .is_err()
                                    {
                                        return;
                                    }
                                    let _ = socket.flush().await;
                                    offset += take;
                                    tokio::time::sleep(Duration::from_millis(128)).await;
                                }
                                return;
                            }
                            // 探测（0-0）照常返回，分片请求挂着不给数据。
                            if options.stall_segments && !probe {
                                let _ = socket.write_all(header.as_bytes()).await;
                                let _ = socket.flush().await;
                                tokio::time::sleep(Duration::from_secs(60)).await;
                                return;
                            }
                            if socket.write_all(header.as_bytes()).await.is_err() {
                                return;
                            }
                            let slow = options.slow_window > Duration::ZERO && !probe;
                            let mut offset = 0usize;
                            // 每 100 ms 写 rate/10 字节 ⇒ 每条连接大约 rate B/s。
                            let step = (options.slow_rate_bytes / 10).max(1) as usize;
                            while offset < slice.len() {
                                if slow && started.elapsed() < options.slow_window {
                                    let take = (slice.len() - offset).min(step);
                                    if socket
                                        .write_all(&slice[offset..offset + take])
                                        .await
                                        .is_err()
                                    {
                                        return;
                                    }
                                    let _ = socket.flush().await;
                                    offset += take;
                                    tokio::time::sleep(Duration::from_millis(100)).await;
                                } else {
                                    let _ = socket.write_all(&slice[offset..]).await;
                                    break;
                                }
                            }
                            let _ = socket.flush().await;
                        }
                        _ => {
                            let mut response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
                            )
                            .into_bytes();
                            response.extend_from_slice(&bytes);
                            let _ = socket.write_all(&response).await;
                            let _ = socket.flush().await;
                        }
                    }
                });
            }
        });
        RangeServer {
            url: format!("http://{addr}/fixture.bin"),
            requests,
            task,
        }
    }

    fn fixture_bytes(len: usize) -> Vec<u8> {
        (0..len).map(|index| (index % 251) as u8).collect()
    }

    fn fixture_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cobble-net-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[tokio::test]
    async fn segmented_download_reassembles_ranges_in_order() {
        let payload = Arc::new(fixture_bytes(3_000_000));
        let server = spawn_range_server(payload.clone(), true, false).await;
        let dest = fixture_path("segmented.bin");
        let _ = std::fs::remove_file(&dest);

        let size = download_file_multithreaded(
            &server.url,
            &dest,
            None,
            Some(payload.len() as u64),
            4,
            None,
            None,
        )
        .await
        .expect("segmented download should succeed");

        assert_eq!(size, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        let _ = std::fs::remove_file(&dest);
    }

    #[tokio::test]
    async fn falls_back_to_single_stream_without_range_support() {
        let payload = Arc::new(fixture_bytes(1_500_000));
        let server = spawn_range_server(payload.clone(), false, false).await;
        let dest = fixture_path("single.bin");
        let _ = std::fs::remove_file(&dest);

        let size = download_file_multithreaded(
            &server.url,
            &dest,
            None,
            Some(payload.len() as u64),
            4,
            None,
            None,
        )
        .await
        .expect("single stream fallback should succeed");

        assert_eq!(size, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        let _ = std::fs::remove_file(&dest);
    }

    /// 镜像限制并发时会拖住分片：看门狗必须在几十秒内放弃分片并回退单连接，
    /// 而不是一直挂着。
    #[tokio::test]
    async fn stalled_segments_fall_back_to_single_stream() {
        let payload = Arc::new(fixture_bytes(3_000_000));
        let server = spawn_range_server(payload.clone(), true, true).await;
        let dest = fixture_path("stalled.bin");
        let _ = std::fs::remove_file(&dest);

        let size = tokio::time::timeout(
            Duration::from_secs(90),
            download_file_multithreaded(
                &server.url,
                &dest,
                None,
                Some(payload.len() as u64),
                4,
                None,
                None,
            ),
        )
        .await
        .expect("watchdog must not hang forever")
        .expect("single stream fallback should succeed");

        assert_eq!(size, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        let _ = std::fs::remove_file(&dest);
    }

    /// 前期下得很快、后期完全停住时，累计平均速度仍然很高，看门狗如果只看
    /// 平均值就永远不会响——这正是“随机位置骤降却恢复不了”的成因。
    #[test]
    fn speed_window_notices_a_late_stall() {
        let start = Instant::now();
        let mut window = SpeedWindow::new(SPEED_WINDOW);
        window.sample(0, start);
        window.sample(60_000_000, start + Duration::from_secs(10));
        window.sample(60_000_000, start + Duration::from_secs(14));

        let rate = window.rate().expect("窗口内应有两个样本");
        assert!(rate < 1.0, "最近窗口应该看到停滞，实际 {rate}");

        let cumulative = 60_000_000.0 / 14.0;
        assert!(
            cumulative > 4_000_000.0,
            "同一组数据用累计平均值看仍然很快（{cumulative} B/s），说明必须看窗口"
        );
    }

    /// 一条连接假死（收了请求头却不回字节）不能拖住整份文件：它手上的块
    /// 会在几秒后被收回、交给别的连接重发。旧实现要等 30 秒 idle 超时，
    /// 然后整轮分片失败、丢掉 `.part` 用单连接从头重下。
    #[tokio::test]
    async fn a_dead_connection_does_not_hold_the_whole_file() {
        let payload = Arc::new(fixture_bytes(8_000_000));
        let server = spawn_range_server_with(
            payload.clone(),
            ServerOptions {
                honor_range: true,
                stall_first_chunk_once: true,
                ..Default::default()
            },
        )
        .await;
        let dest = clean_fixture("dead-connection.bin");

        let started = Instant::now();
        let size = tokio::time::timeout(
            Duration::from_secs(40),
            download_file_multithreaded(
                &server.url,
                &dest,
                None,
                Some(payload.len() as u64),
                4,
                None,
                None,
            ),
        )
        .await
        .expect("不能挂死")
        .expect("假死一条连接也应该能下完");
        let elapsed = started.elapsed();

        assert_eq!(size, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        assert!(
            elapsed < Duration::from_secs(20),
            "回收假死连接后应该几秒内下完，实际 {elapsed:?}"
        );

        let requests = server.requests.lock().unwrap().clone();
        let unique: std::collections::HashSet<(u64, u64)> = requests.iter().copied().collect();
        assert!(
            requests.len() > unique.len(),
            "假死连接上的区间应该被重新请求一次"
        );
        let _ = std::fs::remove_file(&dest);
    }

    /// 一条没死但被严重限速的连接：它手上的块要比其他人慢很多，同样要被
    /// 收回去重发，否则它就变成整份文件的尾巴。
    #[tokio::test]
    async fn a_throttled_connection_gets_its_chunk_taken_away() {
        let payload = Arc::new(fixture_bytes(4_000_000));
        let server = spawn_range_server_with(
            payload.clone(),
            ServerOptions {
                honor_range: true,
                slow_first_chunk_once: true,
                ..Default::default()
            },
        )
        .await;
        let dest = clean_fixture("throttled-connection.bin");

        let started = Instant::now();
        let size = tokio::time::timeout(
            Duration::from_secs(60),
            download_file_multithreaded(
                &server.url,
                &dest,
                None,
                Some(payload.len() as u64),
                4,
                None,
                None,
            ),
        )
        .await
        .expect("不能挂死")
        .expect("限速连接不应该让整个文件失败");
        let elapsed = started.elapsed();

        assert_eq!(size, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        // 不回收的话这一块 1 MB 要跑 30 秒以上。
        assert!(
            elapsed < Duration::from_secs(15),
            "慢块应该被回收给别的连接，实际 {elapsed:?}"
        );
        // 回收是从“已写入的位置”接着算的，所以重发的是一段子区间，按请求数判断。
        let fetch_requests = server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|range| **range != (0, 0))
            .count();
        assert!(
            fetch_requests > 4,
            "被限速的区间应该被收回重发，实际请求 {fetch_requests} 次"
        );
        let _ = std::fs::remove_file(&dest);
    }

    /// 版本清单/资源索引这类“安装必经”的 100–500 KB 元数据，旧实现走单连接，
    /// 慢线路上要十几二十秒。`download_metadata` 要把它们切块并行拉，
    /// 同时保持字节完全一致。
    #[tokio::test]
    async fn metadata_is_downloaded_over_parallel_ranges() {
        let payload = Arc::new(fixture_bytes(512 * 1024));
        let server = spawn_range_server_with(
            payload.clone(),
            ServerOptions {
                slow_window: Duration::from_secs(60),
                // 每条连接 64 KB/s：单连接要 8 秒，8 条连接约 1 秒。
                slow_rate_bytes: 64 * 1024,
                ..Default::default()
            },
        )
        .await;
        let dest = clean_fixture("metadata-index.json");

        let started = Instant::now();
        let bytes = download_metadata(&server.url, &dest, None, Some(payload.len() as u64), 8)
            .await
            .expect("元数据并行下载应当成功");
        let elapsed = started.elapsed();
        println!("metadata 512 KB via 8 ranges: {elapsed:?} (single stream on this server: ~8s)");

        assert_eq!(bytes, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        assert!(
            elapsed < Duration::from_secs(4),
            "500 KB 走 8 条连接不该要 {elapsed:?}（单连接要 8 秒）"
        );
        let fetches = server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|range| **range != (0, 0))
            .count();
        assert!(
            fetches > 1,
            "应当切块并行，实际只发了 {fetches} 个数据请求"
        );
        let _ = std::fs::remove_file(&dest);
    }

    /// 核心 Jar 开始时只有一小份连接；其它阶段下完把连接让过来以后，
    /// 它手上的上限要被立刻用上（旧实现整份文件只拿到 initial 那几条）。
    #[tokio::test]
    async fn a_raised_connection_limit_is_used_mid_download() {
        let payload = Arc::new(fixture_bytes(4_000_000));
        let server = spawn_range_server_with(
            payload.clone(),
            ServerOptions {
                slow_window: Duration::from_secs(120),
                // 每条连接 512 KB/s：4 MB 单连接要 8 秒，8 条连接约 1 秒。
                slow_rate_bytes: 512 * 1024,
                ..Default::default()
            },
        )
        .await;
        let dest = clean_fixture("growing-client.jar");
        let limit = Arc::new(AtomicUsize::new(1));

        let started = Instant::now();
        let download = download_file_with_mirrors_growing(
            &server.url,
            &dest,
            None,
            Some(payload.len() as u64),
            &limit,
            8,
            None,
            None,
        );
        tokio::pin!(download);
        let raise = async {
            tokio::time::sleep(Duration::from_millis(400)).await;
            // 依赖库/资源阶段收尾：把让出来的连接接到核心 Jar 上。
            limit.store(8, Ordering::Relaxed);
        };
        let (result, _) = tokio::join!(download, raise);
        let elapsed = started.elapsed();
        let size = result.expect("抬高上限后应当能下完");
        println!("4 MB client jar, limit 1→8 after 400ms: {elapsed:?} (single connection on this server: ~8s)");

        assert_eq!(size, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        assert!(
            elapsed < Duration::from_secs(6),
            "连接上限抬高后应该明显变快，实际 {elapsed:?}（单连接要 8 秒）"
        );
        let _ = std::fs::remove_file(&dest);
    }

    /// 清掉同名文件、`.part` 与旁车文件，保证用例之间互不影响。
    fn clean_fixture(name: &str) -> PathBuf {
        let dest = fixture_path(name);
        let part = part_path(&dest);
        for path in [dest.clone(), part.clone(), resume_meta_path(&part)] {
            let _ = std::fs::remove_file(path);
        }
        dest
    }

    /// 已经下好的分片不会被重新请求：续传只补缺的那几段。
    #[tokio::test]
    async fn resumes_without_refetching_completed_segments() {
        let payload = Arc::new(fixture_bytes(3_000_000));
        let server = spawn_range_server(payload.clone(), true, false).await;
        let dest = clean_fixture("resume.bin");
        let part = part_path(&dest);
        let total = payload.len() as u64;
        let segments = compute_segments(total, 4);

        // 造一个“下到一半”的现场：第一段已经落盘，旁车文件记着它。
        {
            use std::io::Write;
            let file = std::fs::File::create(&part).unwrap();
            file.set_len(total).unwrap();
            drop(file);
            let mut first = std::fs::OpenOptions::new().write(true).open(&part).unwrap();
            let (start, end) = segments[0];
            first
                .write_all(&payload[start as usize..=end as usize])
                .unwrap();
            first.flush().unwrap();
        }
        let meta = ResumeMeta {
            total,
            segments: segments.clone(),
            completed: vec![0],
            done_bytes: segments[0].1 - segments[0].0 + 1,
        };
        std::fs::write(
            resume_meta_path(&part),
            serde_json::to_string(&meta).unwrap(),
        )
        .unwrap();
        assert_eq!(resume_progress(&dest), Some(meta.done_bytes));

        let size = download_file_resumable(&server.url, &dest, None, None, 4, None, None)
            .await
            .expect("续传应该成功");

        assert_eq!(size, total);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        assert!(!part.exists(), "完成后 .part 应该已经被改名");
        assert!(!resume_meta_path(&part).exists(), "旁车文件应该被清掉");

        let requests = server.requests.lock().unwrap().clone();
        let first_hits = requests.iter().filter(|item| **item == segments[0]).count();
        assert_eq!(first_hits, 0, "已完成的分片不应再被请求");
        for range in segments.iter().skip(1) {
            let hits = requests.iter().filter(|item| *item == range).count();
            assert_eq!(hits, 1, "分片 {range:?} 应该只请求一次");
        }
    }

    /// `.part` 丢了或被改坏时不能相信旁车文件，必须重下。
    #[tokio::test]
    async fn restarts_when_partial_file_is_missing() {
        let payload = Arc::new(fixture_bytes(2_000_000));
        let server = spawn_range_server(payload.clone(), true, false).await;
        let dest = clean_fixture("mismatch.bin");
        let part = part_path(&dest);
        let total = payload.len() as u64;

        // 只有旁车文件、没有对应的 `.part`：应判为无效进度。
        let meta = ResumeMeta {
            total,
            segments: compute_segments(total, 4),
            completed: vec![0, 1],
            done_bytes: 1_000_000,
        };
        std::fs::write(
            resume_meta_path(&part),
            serde_json::to_string(&meta).unwrap(),
        )
        .unwrap();
        assert_eq!(resume_progress(&dest), None);

        let size = download_file_resumable(&server.url, &dest, None, None, 4, None, None)
            .await
            .expect("应该重头下完");

        assert_eq!(size, total);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        assert_eq!(resume_progress(&dest), None);
    }

    /// 线路并发被限制、多线程速率过低时：放弃分片，改成单连接把剩余分片补完，
    /// 不能整段重下，也不能挂死。
    #[tokio::test]
    async fn slow_parallel_pass_finishes_remaining_ranges_on_one_connection() {
        let payload = Arc::new(fixture_bytes(3_000_000));
        let server = spawn_range_server_with(
            payload.clone(),
            ServerOptions {
                honor_range: true,
                stall_segments: false,
                // 前 13 秒每个连接只有 1 KB/s：多线程总速率会低于看门狗下限。
                slow_window: Duration::from_secs(13),
                ..Default::default()
            },
        )
        .await;
        let dest = clean_fixture("slow-line.bin");

        let size = tokio::time::timeout(
            Duration::from_secs(120),
            download_file_resumable(&server.url, &dest, None, None, 4, None, None),
        )
        .await
        .expect("不能挂死")
        .expect("慢线路也要下完");

        assert_eq!(size, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);

        // 被判太慢的分片会在单连接阶段重发一次，所以能看到重复的 Range 请求。
        let requests = server.requests.lock().unwrap().clone();
        let unique: std::collections::HashSet<(u64, u64)> = requests.iter().copied().collect();
        assert!(
            requests.len() > unique.len(),
            "应该有分片先被放弃、再由单连接补下"
        );
    }

    /// 服务器不认 Range 时仍然要能下载（退回普通单连接流程）。
    #[tokio::test]
    async fn resumable_falls_back_without_range_support() {
        let payload = Arc::new(fixture_bytes(1_500_000));
        let server = spawn_range_server(payload.clone(), false, false).await;
        let dest = clean_fixture("no-range.bin");

        let size = download_file_resumable(&server.url, &dest, None, None, 4, None, None)
            .await
            .expect("不支持 Range 也要能下载");

        assert_eq!(size, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        assert!(!part_path(&dest).exists());
    }

    /// 单连接被“吊着”的判死规则：窗口内平均速率极低才算，短时间慢不算。
    #[test]
    fn trickling_single_stream_is_judged_too_slow() {
        assert!(stream_rate_is_too_low(
            4,
            SINGLE_STREAM_RATE_WINDOW + Duration::from_secs(1)
        ));
        assert!(!stream_rate_is_too_low(
            4,
            SINGLE_STREAM_RATE_WINDOW - Duration::from_secs(1)
        ));
        assert!(!stream_rate_is_too_low(
            64 * 1024,
            SINGLE_STREAM_RATE_WINDOW + Duration::from_secs(1)
        ));
    }

    #[test]
    fn rate_limit_responses_are_recognised_with_their_retry_after() {
        assert_eq!(
            rate_limit_wait("服务器未返回分片数据 (http://x): HTTP 429 retry-after=3"),
            Some(Duration::from_secs(3))
        );
        assert_eq!(
            rate_limit_wait("下载失败 (http://x): HTTP 429"),
            Some(Duration::from_secs(1))
        );
        assert_eq!(
            rate_limit_wait("下载失败 (http://x): HTTP 503"),
            Some(Duration::from_secs(1))
        );
        assert!(rate_limit_wait("下载失败 (http://x): HTTP 404").is_none());
    }

    /// 被限速的主机要减并发，连续成功后再慢慢加回来，不能一直拿满额硬撞。
    #[tokio::test]
    async fn rate_limited_host_gets_a_lower_connection_cap() {
        let url = "http://127.0.0.1:6553/never";
        assert_eq!(host_connection_limit(url), HOST_GATE_MAX_CONNECTIONS);

        penalize_host(url);
        assert_eq!(host_connection_limit(url), HOST_GATE_MAX_CONNECTIONS / 2);

        // 额度内的连接能立刻拿到，超出额度也不会卡死（攒够成功数就回升）。
        let slot = acquire_host_slot(url).await;
        assert!(slot.is_some());
        drop(slot);

        for _ in 0..HOST_GATE_RAMP_SUCCESSES {
            note_host_success(url);
        }
        assert!(host_connection_limit(url) > HOST_GATE_MAX_CONNECTIONS / 2);
    }

    /// 单个代理/镜像按 IP 限并发（429 + Retry-After）：旧实现只会用同样的
    /// 连接数原样重试，文件卡在限速上结束不了。现在应该降低并发、等一会儿再
    /// 重试，并且最终把文件完整下完。
    #[tokio::test]
    async fn rate_limited_proxy_is_retried_with_fewer_connections() {
        let payload = Arc::new(fixture_bytes(2_000_000));
        let server = spawn_range_server_with(
            payload.clone(),
            ServerOptions {
                rate_limit_first: 6,
                rate_limit_retry_after: 1,
                ..Default::default()
            },
        )
        .await;
        let dest = clean_fixture("rate-limited.bin");

        let bytes = tokio::time::timeout(
            Duration::from_secs(60),
            download_file_multithreaded(
                &server.url,
                &dest,
                None,
                Some(payload.len() as u64),
                8,
                None,
                None,
            ),
        )
        .await
        .expect("被限速也不能挂死")
        .expect("被限速后应当降并发重试成功");

        assert_eq!(bytes, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), *payload);
        let cap = host_connection_limit(&server.url);
        println!("after 429s the mirror is capped at {cap} connections (was 8)");
        assert!(
            cap < 8,
            "被 429 过的镜像并发上限应该降下来，实际 {cap}"
        );
        let _ = std::fs::remove_file(&dest);
    }
}
