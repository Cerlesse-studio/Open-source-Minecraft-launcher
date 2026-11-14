//! 下载引擎共享的尺寸与时间常量。

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
