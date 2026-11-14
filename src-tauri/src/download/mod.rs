//! 下载引擎：PCL2 `ModNet.vb` / `ModLoader.vb` 下载语义的 Rust 实现，
//! 按 rayburst 的模块化架构分层组织。
//!
//! PCL2 models a download as `LoaderDownload` -> `NetFile` -> `NetThread` ->
//! `NetSource`, coordinated by the global `NetManagerClass` (thread cap,
//! token-bucket speed limit, 0.1 s stat refresh). `net.rs` stays the
//! compatibility facade for the launcher's existing callers.
//!
//! 模块分层（参考 rayburst `aria2/` + `engine/` + `services/` + `error.rs`）：
//! - [`types`]：尺寸/时间常量与共享类型
//! - [`error`]：源失败分类与错误链渲染
//! - [`limit`]：线程上限、令牌桶限速、连接时延统计（PCL2 `NetManagerClass`）
//! - [`source`]：`NetSource` 健康管理、镜像链、用户下载偏好
//! - [`segments`]：Range 探测、分片切分与单分片 worker
//! - [`resume`]：断点续传旁车元数据
//! - [`verify`]：`FileChecker` 校验与原子提交
//! - [`task`]：PCL2 `NetState`/`NetFile` 任务状态机
//! - [`speed`]：速率显示平滑
//! - [`engine`]：下载执行引擎（多线程分段、续传、镜像轮换、代理升级）

pub mod engine;
pub mod error;
pub mod limit;
pub mod resume;
pub mod segments;
pub mod source;
pub mod speed;
pub mod task;
#[cfg(test)]
mod tests;
pub mod types;
pub mod verify;

// ---------------------------------------------------------------------------
// 公共门面：外部模块统一从 `crate::download` 取用。
// ---------------------------------------------------------------------------

/// 统一下载入口（rayburst 式单一引擎 API）。
pub use engine::download;
pub use error::{classify_source_failure, classify_source_failure_str, proxy_retry_worthwhile, should_disable_source, DownloadError, SourceFailure};
pub use limit::{
    active_threads, consume, record_connect, set_speed_limit, set_thread_limit, speed_limit,
    thread_limit, try_acquire_thread, NET_TASK_SPEED_LIMIT_LOW,
};
pub use resume::{resume_progress, resume_sidecar_path};
pub use segments::{
    compute_segments, parse_content_range_total, probe_range_support, recommended_segments,
    RangeProbe,
};
pub use source::{
    download_threads, get_mirror_urls, per_file_threads, preferred_urls, probe_download_sources,
    set_download_preference, sources_for, DownloadSourceProbe, NetSource,
};
pub use speed::SpeedSmoother;
pub use task::{format_download_failure, LoadState, LoaderTaskView, NetFile, NetState};
pub use types::{DownloadRequest, MAX_RETRIES, MIN_MULTITHREAD_SIZE, MIN_SEGMENT_SIZE, SEGMENT_IDLE_TIMEOUT,
    SEGMENT_MIN_RATE_BYTES, SEGMENT_SLOW_GRACE, SEGMENT_WATCHDOG_INTERVAL};
pub use verify::{looks_complete, sha1_file, FileChecker};
