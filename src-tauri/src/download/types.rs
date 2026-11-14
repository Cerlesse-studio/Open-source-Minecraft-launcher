//! 下载引擎共享的尺寸/时间常量与统一请求类型。

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::time::Duration;

/// Files at or above 1 MB are eligible for multi-segment HTTP Range downloading.
pub const MIN_MULTITHREAD_SIZE: u64 = 1_048_576;
/// Each HTTP Range segment downloads at least 512 KB.
pub const MIN_SEGMENT_SIZE: u64 = 512 * 1024;
/// Maximum retries per file or segment before failing.
pub const MAX_RETRIES: u32 = 3;
/// 分片下载启动后的爬坡时间，这段时间内的低速率不算失败。
pub const SEGMENT_SLOW_GRACE: Duration = Duration::from_secs(12);
/// 分片总吞吐持续低于这个值就放弃多线程。不少 GitHub 加速镜像会
/// 严重限制同一 IP 的并发连接，多开分片反而比单连接慢上百倍。
pub const SEGMENT_MIN_RATE_BYTES: f64 = 8.0 * 1024.0;
pub const SEGMENT_WATCHDOG_INTERVAL: Duration = Duration::from_secs(3);
/// 单个分片这么久没收到字节就认为连接已死，重试或退出，避免整体挂住。
pub const SEGMENT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// 统一的下载请求：取代此前四条入口函数各自的 7 个位置参数。
///
/// 带生命周期是为了让调用方零成本借用进度回调与重试计数
/// （现有调用点全部是 `move` + `Arc` 克隆的闭包与 `&AtomicU64` 借用）。
///
/// - [`threads`](DownloadRequest::threads) 缺省时按 `per_file_threads(expected_size)`
///   自动决定（< 1 MB 单连接，未知大小或大文件用用户配置线程数）。
/// - [`sources`](DownloadRequest::sources) 缺省时用 `preferred_urls` 生成
///   自动镜像链（BMCLAPI/官方 CDN/jsDelivr 等回退顺序）；显式传入则只试
///   给定列表（旧 `download_file_multithreaded`/`resumable` 的语义）。
/// - [`resume`](DownloadRequest::resume) 启用断点续传旁车文件。
pub struct DownloadRequest<'a> {
    pub url: String,
    pub dest: PathBuf,
    pub expected_sha1: Option<String>,
    pub expected_size: Option<u64>,
    pub threads: Option<usize>,
    pub sources: Option<Vec<String>>,
    pub resume: bool,
    pub retry_counter: Option<&'a AtomicU64>,
    pub on_progress: Option<&'a mut (dyn FnMut(u64, u64, u64) + Send)>,
}

impl<'a> DownloadRequest<'a> {
    pub fn new(url: impl Into<String>, dest: impl Into<PathBuf>) -> Self {
        Self {
            url: url.into(),
            dest: dest.into(),
            expected_sha1: None,
            expected_size: None,
            threads: None,
            sources: None,
            resume: false,
            retry_counter: None,
            on_progress: None,
        }
    }

    pub fn sha1(mut self, value: Option<&str>) -> Self {
        self.expected_sha1 = value.map(str::to_string);
        self
    }

    pub fn size(mut self, value: Option<u64>) -> Self {
        self.expected_size = value;
        self
    }

    pub fn threads(mut self, value: usize) -> Self {
        self.threads = Some(value);
        self
    }

    pub fn sources(mut self, value: Vec<String>) -> Self {
        self.sources = Some(value);
        self
    }

    pub fn resume(mut self, value: bool) -> Self {
        self.resume = value;
        self
    }

    pub fn retry_counter(mut self, value: Option<&'a AtomicU64>) -> Self {
        self.retry_counter = value;
        self
    }

    pub fn on_progress(
        mut self,
        value: &'a mut (dyn FnMut(u64, u64, u64) + Send),
    ) -> Self {
        self.on_progress = Some(value);
        self
    }
}

