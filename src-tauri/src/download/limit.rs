//! PCL2 `NetManagerClass` 全局并发治理：线程上限、令牌桶限速、连接平均时延。
//!
//! 所有下载线程（单流与分片 worker）都通过 [`try_acquire_thread`] 计入
//! `NetTaskThreadCount`，通过 [`consume`] 共享同一个 `NetTaskSpeedLimitLeft`
//! 预算，与 PCL2 的行为一致。

use std::sync::OnceLock;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::sleep;

/// PCL2 `NetTaskSpeedLimitLow`: below this rate the manager opens more threads.
pub const NET_TASK_SPEED_LIMIT_LOW: u64 = 256 * 1024;
/// PCL2 `Thread()` timeout: `Min(Max(ConnectAverage, 15000) * (1 + FailCount), 30000)`.
pub const CONNECT_TIMEOUT_FLOOR_MS: u64 = 15_000;
pub const CONNECT_TIMEOUT_CEILING_MS: u64 = 30_000;
/// PCL2 slow-link cutoff: packet gap > 5 s and rate < 1 KiB/s.
pub const SLOW_PACKET_GAP: Duration = Duration::from_secs(5);
pub const SLOW_RATE_BYTES_PER_SEC: u64 = 1024;
/// PCL2 `Merge()` retry: 3 attempts with `500 ms * attempt` backoff.
pub const MERGE_MAX_RETRIES: u32 = 3;
pub const MERGE_RETRY_BASE: Duration = Duration::from_millis(500);

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

#[cfg(test)]
mod tests {
    use super::*;

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
