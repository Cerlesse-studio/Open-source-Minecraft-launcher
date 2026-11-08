//! PCL2 `ModNet.vb` / `ModLoader.vb` download-engine semantics, ported to Rust.
//!
//! PCL2 models a download as `LoaderDownload` -> `NetFile` -> `NetThread` ->
//! `NetSource`, coordinated by the global `NetManagerClass` (thread cap,
//! token-bucket speed limit, 0.1 s stat refresh). This module owns those
//! concepts; `net.rs` stays the compatibility facade for the launcher's
//! existing callers.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;

/// PCL2 `NetTaskSpeedLimitLow`: below this rate the manager opens more threads.
pub const NET_TASK_SPEED_LIMIT_LOW: u64 = 256 * 1024;
/// PCL2 `NetFile.FilePieceLimit`: a fragment smaller than this is not split.
pub const FILE_PIECE_LIMIT: u64 = 256 * 1024;
/// PCL2 `NetFile.IsNoSplit`: files below 1 MiB are never segmented.
pub const NO_SPLIT_SIZE: u64 = 1024 * 1024;
/// PCL2 `Thread()` read buffer.
pub const NET_BUFFER_SIZE: usize = 16_384;
/// PCL2 `Thread()` timeout: `Min(Max(ConnectAverage, 15000) * (1 + FailCount), 30000)`.
pub const CONNECT_TIMEOUT_FLOOR_MS: u64 = 15_000;
pub const CONNECT_TIMEOUT_CEILING_MS: u64 = 30_000;
/// PCL2 slow-link cutoff: packet gap > 5 s and rate < 1 KiB/s.
pub const SLOW_PACKET_GAP: Duration = Duration::from_secs(5);
pub const SLOW_RATE_BYTES_PER_SEC: u64 = 1024;
/// PCL2 `Merge()` retry: 3 attempts with `500 ms * attempt` backoff.
pub const MERGE_MAX_RETRIES: u32 = 3;
pub const MERGE_RETRY_BASE: Duration = Duration::from_millis(500);

/// PCL2 `NetState`, with the original discriminants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i8)]
pub enum NetState {
    WaitingToCheck = -1,
    WaitingToDownload = 0,
    Connecting = 1,
    Reading = 2,
    Downloading = 3,
    Merging = 4,
    Finished = 5,
    Canceled = 6,
}

/// PCL2 `LoadState` (the `LoaderTask` state machine).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LoadState {
    #[default]
    Waiting,
    Loading,
    Finished,
    Failed,
    Canceled,
}

/// PCL2 `NetSource`: one mirror plus its health counters.
#[derive(Debug, Clone)]
pub struct NetSource {
    pub id: usize,
    pub url: String,
    pub fail_count: u32,
    pub is_failed: bool,
    /// PCL2 `SingleThread`: sources that failed under Range are retried alone.
    pub single_thread: bool,
    pub error: Option<String>,
}

impl NetSource {
    pub fn new(id: usize, url: impl Into<String>) -> Self {
        Self {
            id,
            url: url.into(),
            fail_count: 0,
            is_failed: false,
            single_thread: false,
            error: None,
        }
    }

    pub fn mark_failed(&mut self, error: impl Into<String>) {
        self.fail_count += 1;
        self.error = Some(error.into());
        self.is_failed = true;
    }

    pub fn reset(&mut self) {
        self.fail_count = 0;
        self.is_failed = false;
        self.single_thread = false;
        self.error = None;
    }
}

pub fn sources_for(urls: impl IntoIterator<Item = String>) -> Vec<NetSource> {
    urls.into_iter()
        .enumerate()
        .map(|(id, url)| NetSource::new(id, url))
        .collect()
}

/// PCL2 `SourceFail` classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFailure {
    RangeNotSupported,
    Http(u16),
    SlowLink,
    NoData,
    DiskFull,
    Unknown,
}

fn has_status(error: &str, code: u16) -> bool {
    let bare = format!("HTTP {code}");
    let parenthesized = format!("({code})");
    error.contains(&bare) || error.contains(&parenthesized)
}

pub fn classify_source_failure(error: &str) -> SourceFailure {
    if has_status(error, 416)
        || error.contains("不支持分段")
        || error.contains("服务器未返回分片数据")
        || error.contains("分片长度不完整")
        || error.contains("分片返回字节超出范围")
    {
        return SourceFailure::RangeNotSupported;
    }
    if error.contains("空间不足") {
        return SourceFailure::DiskFull;
    }
    if error.contains("无返回数据") || error.contains("返回的 ContentLength 过多") {
        return SourceFailure::NoData;
    }
    if error.contains("速度过慢")
        || error.contains("没有收到数据")
        || error.contains("停滞")
        || error.contains("超时")
    {
        return SourceFailure::SlowLink;
    }
    for code in [403, 404, 429, 502, 503, 500, 408] {
        if has_status(error, code) {
            return SourceFailure::Http(code);
        }
    }
    SourceFailure::Unknown
}

/// PCL2 `SourceFail`'s "disable this source" decision.
pub fn should_disable_source(
    failure: SourceFailure,
    fail_count: u32,
    downloaded: u64,
    thread_limit: u32,
    is_bmclapi: bool,
    is_merge_failure: bool,
) -> bool {
    if is_merge_failure
        || matches!(
            failure,
            SourceFailure::RangeNotSupported | SourceFailure::NoData | SourceFailure::DiskFull
        )
    {
        return true;
    }
    if let SourceFailure::Http(code) = failure {
        if code == 404 || code == 502 {
            return true;
        }
        // BMCLAPI rate-limits aggressive clients; PCL2 does not ban it for 403/429.
        if (code == 403 || code == 429) && !is_bmclapi {
            return true;
        }
    }
    let threshold = thread_limit.clamp(5, 30);
    (fail_count >= threshold && downloaded < 1) || fail_count > thread_limit + 2
}

pub fn is_bmclapi(url: &str) -> bool {
    url.contains("bmclapi2.bangbang93.com") || url.contains("bmclapi.bangbang93.com")
}

// ---------------------------------------------------------------------------
// Global NetManager state: speed limit, thread counters, connect average
// ---------------------------------------------------------------------------

struct LimitState {
    /// `-1` means unlimited, matching PCL2 `NetTaskSpeedLimitHigh`.
    speed_limit_high: AtomicI64,
    speed_limit_left: AtomicI64,
    last_refill_ms: AtomicU64,
    thread_count: AtomicU32,
    thread_limit: AtomicU32,
    connect_count: AtomicU64,
    connect_time_ms: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn limits() -> &'static LimitState {
    static LIMITS: OnceLock<LimitState> = OnceLock::new();
    LIMITS.get_or_init(|| LimitState {
        speed_limit_high: AtomicI64::new(-1),
        speed_limit_left: AtomicI64::new(-1),
        last_refill_ms: AtomicU64::new(now_ms()),
        thread_count: AtomicU32::new(0),
        thread_limit: AtomicU32::new(u32::MAX),
        connect_count: AtomicU64::new(0),
        connect_time_ms: AtomicU64::new(0),
    })
}

/// `0` (or `None`) = unlimited; otherwise bytes per second.
pub fn set_speed_limit(bytes_per_sec: u64) {
    let state = limits();
    if bytes_per_sec == 0 {
        state.speed_limit_high.store(-1, Ordering::Release);
        state.speed_limit_left.store(-1, Ordering::Release);
    } else {
        let limit = i64::try_from(bytes_per_sec).unwrap_or(i64::MAX);
        state.speed_limit_high.store(limit, Ordering::Release);
        state.speed_limit_left.store(limit, Ordering::Release);
    }
    state.last_refill_ms.store(now_ms(), Ordering::Release);
}

pub fn speed_limit() -> Option<u64> {
    let value = limits().speed_limit_high.load(Ordering::Acquire);
    (value > 0).then_some(value as u64)
}

/// PCL2 `NetTaskThreadLimit = ToolDownloadThread + 1`.
pub fn set_thread_limit(value: usize) {
    let limit = u32::try_from(value.max(1)).unwrap_or(u32::MAX);
    limits().thread_limit.store(limit, Ordering::Release);
}

pub fn thread_limit() -> u32 {
    limits().thread_limit.load(Ordering::Acquire)
}

pub fn active_threads() -> u32 {
    limits().thread_count.load(Ordering::Acquire)
}

/// PCL2 `NetFile.ConnectAverage`, used to scale per-thread connect timeouts.
pub fn record_connect(elapsed_ms: u64) {
    let state = limits();
    state.connect_count.fetch_add(1, Ordering::Relaxed);
    state
        .connect_time_ms
        .fetch_add(elapsed_ms, Ordering::Relaxed);
}

pub fn connect_average_ms() -> Option<u64> {
    let state = limits();
    let count = state.connect_count.load(Ordering::Relaxed);
    (count > 0).then(|| state.connect_time_ms.load(Ordering::Relaxed) / count)
}

pub fn thread_timeout_ms(fail_count: u32) -> u64 {
    let average = connect_average_ms()
        .unwrap_or(CONNECT_TIMEOUT_FLOOR_MS)
        .max(CONNECT_TIMEOUT_FLOOR_MS);
    average
        .saturating_mul(1 + u64::from(fail_count))
        .min(CONNECT_TIMEOUT_CEILING_MS)
}

/// PCL2 refills `NetTaskSpeedLimitLeft` by `limit / 10` every 100 ms;
/// continuous-time equivalent is `limit * elapsed / 1000`, capped at `limit`.
pub fn refill_tokens(limit: i64, elapsed_ms: u64, left: i64) -> i64 {
    if limit <= 0 {
        return -1;
    }
    let add = (limit as u128)
        .saturating_mul(u128::from(elapsed_ms))
        .saturating_div(1000)
        .min(i64::MAX as u128) as i64;
    left.saturating_add(add).min(limit)
}

/// How long to wait when the bucket cannot cover `missing` bytes.
pub fn planned_wait_ms(missing: i64, limit: i64) -> u64 {
    if limit <= 0 || missing <= 0 {
        return 0;
    }
    let millis = ((missing as f64 / limit as f64) * 1000.0).ceil() as u64;
    millis.clamp(16, 100)
}

fn refill(state: &LimitState, limit: i64) {
    let now = now_ms();
    let last = state.last_refill_ms.load(Ordering::Acquire);
    if now <= last {
        return;
    }
    if state
        .last_refill_ms
        .compare_exchange(last, now, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    loop {
        let left = state.speed_limit_left.load(Ordering::Acquire);
        let next = refill_tokens(limit, now - last, left.max(0));
        if state
            .speed_limit_left
            .compare_exchange(left, next, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            return;
        }
    }
}

/// PCL2 token bucket: every chunk waits until its bytes are available.
pub async fn consume(bytes: u64) {
    let state = limits();
    let limit = state.speed_limit_high.load(Ordering::Acquire);
    if limit <= 0 || bytes == 0 {
        return;
    }
    let mut remaining = i64::try_from(bytes).unwrap_or(i64::MAX);
    loop {
        refill(state, limit);
        let left = state.speed_limit_left.load(Ordering::Acquire).max(0);
        if left > 0 {
            let take = left.min(remaining);
            if state
                .speed_limit_left
                .compare_exchange(left, left - take, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                remaining -= take;
                if remaining <= 0 {
                    return;
                }
                continue;
            }
            continue;
        }
        sleep(Duration::from_millis(planned_wait_ms(remaining, limit))).await;
    }
}

/// RAII guard for PCL2 `NetTaskThreadCount`. Soft: when the cap is reached the
/// download still proceeds (PCL2 simply declines to open *more* threads), so
/// existing callers never deadlock.
pub struct ThreadGuard {
    acquired: bool,
}

impl Drop for ThreadGuard {
    fn drop(&mut self) {
        if self.acquired {
            limits().thread_count.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

pub fn try_acquire_thread() -> ThreadGuard {
    let state = limits();
    let limit = state.thread_limit.load(Ordering::Acquire);
    let mut current = state.thread_count.load(Ordering::Acquire);
    while current < limit {
        match state.thread_count.compare_exchange(
            current,
            current + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return ThreadGuard { acquired: true },
            Err(next) => current = next,
        }
    }
    ThreadGuard { acquired: false }
}

// ---------------------------------------------------------------------------
// PCL2 FileChecker / NetFile / output structures
// ---------------------------------------------------------------------------

/// PCL2 `FileChecker{MinSize, ActualSize, Hash, IsJson}`.
#[derive(Debug, Clone, Default)]
pub struct FileChecker {
    pub min_size: Option<u64>,
    pub actual_size: Option<u64>,
    pub sha1: Option<String>,
    pub is_json: bool,
}

impl FileChecker {
    pub fn from_download(expected_size: Option<u64>, expected_sha1: Option<&str>) -> Self {
        Self {
            min_size: None,
            actual_size: expected_size.filter(|size| *size > 0),
            sha1: expected_sha1
                .map(str::trim)
                .filter(|hash| !hash.is_empty())
                .map(str::to_string),
            is_json: false,
        }
    }

    /// Error strings are kept byte-for-byte identical to the pre-refactor
    /// `verify_and_commit`, because callers match on them.
    pub fn check_size(&self, downloaded: u64, dest: &Path) -> Result<(), String> {
        if let Some(min) = self.min_size {
            if min > 0 && downloaded < min {
                return Err(format!(
                    "文件大小不足，获取结果为 {downloaded}，要求至少为 {min}。"
                ));
            }
        }
        if let Some(expected) = self.actual_size {
            if expected > 0 && downloaded != expected {
                return Err(format!(
                    "文件大小不符 {}: 期望 {expected} 字节，实际 {downloaded} 字节",
                    dest.display()
                ));
            }
        }
        Ok(())
    }

    pub fn check_hash(&self, dest: &Path, actual_sha1: &str) -> Result<(), String> {
        if let Some(expected) = &self.sha1 {
            if !expected.is_empty() && !actual_sha1.eq_ignore_ascii_case(expected) {
                return Err(format!("文件校验失败 {}: SHA-1 不匹配", dest.display()));
            }
        }
        Ok(())
    }
}

/// PCL2 `NetFile`. `file_size` uses the VB sentinels: `-2` unknown-yet,
/// `-1` unknown-size.
#[derive(Debug, Clone)]
pub struct NetFile {
    pub local_path: PathBuf,
    pub local_name: String,
    pub sources: Vec<NetSource>,
    pub state: NetState,
    pub file_size: i64,
    pub download_done: u64,
    pub checker: FileChecker,
}

impl NetFile {
    pub fn new(local_path: impl Into<PathBuf>, urls: Vec<String>, checker: FileChecker) -> Self {
        let local_path = local_path.into();
        let local_name = local_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self {
            local_path,
            local_name,
            sources: sources_for(urls),
            state: NetState::WaitingToCheck,
            file_size: -2,
            download_done: 0,
            checker,
        }
    }

    pub fn is_unknown_size(&self) -> bool {
        self.file_size == -1
    }

    pub fn is_no_split(&self) -> bool {
        self.is_unknown_size() || (self.file_size >= 0 && (self.file_size as u64) < NO_SPLIT_SIZE)
    }

    /// PCL2 `HasAvailableSource`.
    pub fn has_available_source(&self) -> bool {
        self.sources.iter().any(|source| !source.is_failed)
    }

    /// PCL2 `GetSource(Id)`: first healthy source at/after `start`, wrapping.
    pub fn first_available_source(&self, start: usize) -> Option<usize> {
        if self.sources.is_empty() || !self.has_available_source() {
            return None;
        }
        let count = self.sources.len();
        (0..count)
            .map(|offset| (start + offset) % count)
            .find(|index| !self.sources[*index].is_failed)
    }

    /// PCL2 `NetFile.Progress`: 5%..98% while downloading, 0.99 while merging.
    pub fn progress(&self) -> f64 {
        match self.state {
            NetState::WaitingToCheck => 0.0,
            NetState::WaitingToDownload => 0.01,
            NetState::Connecting => 0.02,
            NetState::Reading => 0.04,
            NetState::Downloading => {
                let raw = if self.is_unknown_size() {
                    0.5
                } else {
                    self.download_done as f64 / (self.file_size.max(1) as f64).max(1.0)
                };
                (1.0 - (1.0 - raw).powf(0.9)) * 0.93 + 0.05
            }
            NetState::Merging => 0.99,
            NetState::Finished | NetState::Canceled => 1.0,
        }
    }
}

/// PCL2 `LoaderTask` output shape exposed to the UI.
#[derive(Debug, Clone)]
pub struct LoaderTaskView {
    pub name: String,
    pub state: LoadState,
    pub progress: f64,
    pub error: Option<String>,
    pub active_threads: u32,
    pub speed_limit_bps: Option<u64>,
}

impl LoaderTaskView {
    pub fn new(name: impl Into<String>, state: LoadState, progress: f64) -> Self {
        Self {
            name: name.into(),
            state,
            progress,
            error: None,
            active_threads: active_threads(),
            speed_limit_bps: speed_limit(),
        }
    }
}

/// PCL2 `LoaderDownload.OnFail` message: every source's error is listed.
pub fn format_download_failure(local_path: &Path, sources: &[NetSource]) -> String {
    let detail = sources
        .iter()
        .map(|source| {
            format!(
                "{}（{}）",
                source.error.as_deref().unwrap_or("无错误信息。"),
                source.url
            )
        })
        .collect::<Vec<_>>()
        .join("\r\n");
    format!(
        "文件下载失败：{}\r\n各下载源的错误如下：\r\n{detail}",
        local_path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_state_keeps_pcl2_discriminants() {
        assert_eq!(NetState::WaitingToCheck as i8, -1);
        assert_eq!(NetState::WaitingToDownload as i8, 0);
        assert_eq!(NetState::Connecting as i8, 1);
        assert_eq!(NetState::Reading as i8, 2);
        assert_eq!(NetState::Downloading as i8, 3);
        assert_eq!(NetState::Merging as i8, 4);
        assert_eq!(NetState::Finished as i8, 5);
        assert_eq!(NetState::Canceled as i8, 6);
    }

    #[test]
    fn source_failure_classification_matches_pcl2_rules() {
        assert_eq!(
            classify_source_failure("服务器未返回分片数据 (url): HTTP 416"),
            SourceFailure::RangeNotSupported
        );
        assert_eq!(
            classify_source_failure("分片长度不完整: 期望 100, 实际 10"),
            SourceFailure::RangeNotSupported
        );
        assert_eq!(
            classify_source_failure("下载失败: HTTP 404"),
            SourceFailure::Http(404)
        );
        assert_eq!(
            classify_source_failure("HTTP 429"),
            SourceFailure::Http(429)
        );
        assert_eq!(classify_source_failure("空间不足"), SourceFailure::DiskFull);
        assert_eq!(
            classify_source_failure("分片 30 秒没有收到数据"),
            SourceFailure::SlowLink
        );
        assert_eq!(
            classify_source_failure("unexpected"),
            SourceFailure::Unknown
        );
    }

    #[test]
    fn source_disable_rules_keep_bmclapi_rate_limits_retryable() {
        assert!(should_disable_source(SourceFailure::Http(429), 1, 0, 17, true, false) == false);
        assert!(should_disable_source(
            SourceFailure::Http(429),
            1,
            0,
            17,
            false,
            false
        ));
        assert!(should_disable_source(
            SourceFailure::Http(404),
            1,
            10,
            17,
            true,
            false
        ));
        assert!(should_disable_source(
            SourceFailure::RangeNotSupported,
            1,
            10,
            17,
            true,
            false
        ));
        assert!(should_disable_source(
            SourceFailure::Unknown,
            40,
            0,
            17,
            false,
            false
        ));
        assert!(!should_disable_source(
            SourceFailure::Unknown,
            1,
            10,
            17,
            false,
            false
        ));
    }

    #[test]
    fn thread_timeout_scales_with_failures_and_caps_at_30s() {
        assert_eq!(thread_timeout_ms(0), CONNECT_TIMEOUT_FLOOR_MS);
        assert_eq!(thread_timeout_ms(1), CONNECT_TIMEOUT_CEILING_MS);
        assert_eq!(thread_timeout_ms(99), CONNECT_TIMEOUT_CEILING_MS);
    }

    #[test]
    fn token_bucket_refill_matches_pcl2_100ms_tick() {
        assert_eq!(refill_tokens(100_000, 100, 0), 10_000);
        assert_eq!(refill_tokens(100_000, 1000, 0), 100_000);
        assert_eq!(refill_tokens(100_000, 5000, 0), 100_000);
        assert_eq!(refill_tokens(-1, 1000, 0), -1);
        assert_eq!(planned_wait_ms(10_000, 100_000), 100);
        assert_eq!(planned_wait_ms(100, 100_000), 16);
        assert_eq!(planned_wait_ms(0, 100_000), 0);
    }

    #[test]
    fn file_checker_keeps_the_existing_error_messages() {
        let checker = FileChecker::from_download(Some(100), Some("abcd"));
        let dest = Path::new("game.jar");
        assert_eq!(
            checker.check_size(99, dest).unwrap_err(),
            "文件大小不符 game.jar: 期望 100 字节，实际 99 字节"
        );
        assert!(checker.check_size(100, dest).is_ok());
        assert_eq!(
            checker.check_hash(dest, "ffff").unwrap_err(),
            "文件校验失败 game.jar: SHA-1 不匹配"
        );
        assert!(checker.check_hash(dest, "ABCD").is_ok());
    }

    #[test]
    fn net_file_progress_follows_pcl2_curve_and_source_wrap() {
        let mut file = NetFile::new(
            "mods/sodium.jar",
            vec!["https://a".into(), "https://b".into()],
            FileChecker::default(),
        );
        assert_eq!(file.progress(), 0.0);
        assert_eq!(file.first_available_source(0), Some(0));
        file.sources[0].mark_failed("HTTP 404");
        assert_eq!(file.first_available_source(0), Some(1));
        assert_eq!(file.first_available_source(1), Some(1));
        file.sources[1].mark_failed("HTTP 502");
        assert_eq!(file.first_available_source(0), None);
        assert!(!file.has_available_source());

        file.sources[0].reset();
        file.sources[1].reset();
        file.file_size = 100;
        file.download_done = 50;
        file.state = NetState::Downloading;
        assert!((0.05..=0.98).contains(&file.progress()));
        file.state = NetState::Merging;
        assert_eq!(file.progress(), 0.99);
        file.state = NetState::Finished;
        assert_eq!(file.progress(), 1.0);
    }

    #[test]
    fn net_file_no_split_threshold_is_1mib() {
        let mut file = NetFile::new("a.jar", vec!["https://a".into()], FileChecker::default());
        file.file_size = 1024 * 1024 - 1;
        assert!(file.is_no_split());
        file.file_size = 1024 * 1024;
        assert!(!file.is_no_split());
        file.file_size = -1;
        assert!(file.is_no_split());
    }

    #[test]
    fn failure_message_lists_every_source() {
        let mut sources = sources_for(vec!["https://a".into(), "https://b".into()]);
        sources[0].mark_failed("HTTP 404");
        sources[1].mark_failed("超时");
        let message = format_download_failure(Path::new("mods/a.jar"), &sources);
        assert!(message.contains("文件下载失败：mods/a.jar"));
        assert!(message.contains("HTTP 404（https://a）"));
        assert!(message.contains("超时（https://b）"));
        assert!(message.contains("各下载源的错误如下"));
    }

    #[test]
    fn thread_guard_releases_the_slot_on_drop() {
        set_thread_limit(64);
        let before = active_threads();
        {
            let _guard = try_acquire_thread();
            assert_eq!(active_threads(), before + 1);
        }
        assert_eq!(active_threads(), before);
        set_thread_limit(u32::MAX as usize);
    }
}
