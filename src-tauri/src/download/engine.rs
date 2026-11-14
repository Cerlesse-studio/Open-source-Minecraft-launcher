//! 下载执行引擎：多线程分段下载、断点续传、镜像轮换与直连→代理升级。
//!
//! 阶段 1（骨架迁移）：四条历史入口（`download_file` / `download_file_with_mirrors` /
//! `download_file_multithreaded` / `download_file_resumable`）原样平移自 `net.rs`，
//! 行为不变；阶段 2 将由统一的 `DownloadRequest` 入口取代。

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha1::{Digest, Sha1};
use tokio::fs;
use tokio::io::AsyncWriteExt;

use super::error::{classify_source_failure, should_disable_source};
use super::limit::{consume, record_connect, thread_limit, try_acquire_thread};
use super::resume::{ResumeMeta, discard_partial, read_resume_meta, resume_meta_path, write_resume_meta};
use super::segments::{compute_segments, fetch_range_into, probe_range_support};
use super::source::{NetSource, is_bmclapi, per_file_threads, preferred_urls, sources_for};
use super::types::{
    MAX_RETRIES, MIN_MULTITHREAD_SIZE, SEGMENT_IDLE_TIMEOUT, SEGMENT_MIN_RATE_BYTES,
    SEGMENT_SLOW_GRACE, SEGMENT_WATCHDOG_INTERVAL,
};
use super::verify::{part_path, verify_and_commit};
use crate::net::{client, direct_client};

// ---------------------------------------------------------------------------
// 直连失败后，换成系统代理还有没有可能把文件拿回来。
// ---------------------------------------------------------------------------

/// 只有连接层的问题（连不上、超时、连接被重置、久不出数据）值得再走一次代理：
/// 404 / 403、校验不符、磁盘写满之类的错误，换代理也救不了。
fn proxy_retry_worthwhile(error: &str) -> bool {
    if error.contains("HTTP 404")
        || error.contains("HTTP 403")
        || error.contains("HTTP 416")
        || error.contains("空间不足")
        || error.contains("SHA1")
    {
        return false;
    }
    const CONNECT_HINTS: [&str; 10] = [
        "下载请求失败",
        "分片请求失败",
        "分片重定向请求失败",
        "分片探测失败",
        "分片重定向探测失败",
        "下载中断",
        "分片下载中断",
        "下载停滞",
        "没有收到数据",
        "下载未完成",
    ];
    if CONNECT_HINTS.iter().any(|hint| error.contains(hint)) {
        return true;
    }
    let lower = error.to_ascii_lowercase();
    [
        "error sending request",
        "timed out",
        "connect",
        "dns",
        "reset by peer",
        "unexpected eof",
    ]
    .iter()
    .any(|hint| lower.contains(hint))
}

// ---------------------------------------------------------------------------
// 入口 1：download_file（简单包装，自动线程数）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 入口 2：download_file_with_mirrors（镜像链轮换）
// ---------------------------------------------------------------------------

/// Download a file to `dest`, with automatic mirror fallback if the primary URL fails or returns 404.
pub async fn download_file_with_mirrors<'a>(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    let mut raw_progress = on_progress;
    let mut max_done: u64 = 0;
    let mut max_total: u64 = expected_size.unwrap_or(0);
    let mut monotonic_cb = |done: u64, total: u64, _delta: u64| {
        if total > max_total {
            max_total = total;
        }
        let clamped_done = if max_total > 0 {
            done.min(max_total)
        } else {
            done
        };
        let monotonic_done = clamped_done.max(max_done);
        let monotonic_delta = monotonic_done.saturating_sub(max_done);
        max_done = monotonic_done;
        if let Some(cb) = raw_progress.as_mut() {
            cb(monotonic_done, max_total, monotonic_delta);
        }
    };
    let mut progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send)> =
        Some(&mut monotonic_cb);

    // 第一轮直接连：系统代理只会把下载流量绕远路。
    let direct = download_through_sources(
        direct_client(),
        sources_for(preferred_urls(url)),
        dest,
        expected_sha1,
        expected_size,
        threads,
        retry_counter,
        &mut progress,
    )
    .await;

    let direct_error = match direct {
        Ok(bytes) => return Ok(bytes),
        Err(err) => err,
    };

    // 直连被挡（只能走代理的网络、代理软件把直连流量丢进黑洞）时，用系统代理
    // 把整条镜像链再跑一遍；404、校验不符这类错误换代理也没用，直接返回。
    if !proxy_retry_worthwhile(&direct_error) {
        return Err(direct_error);
    }
    download_through_sources(
        client(),
        sources_for(preferred_urls(url)),
        dest,
        expected_sha1,
        expected_size,
        threads,
        retry_counter,
        &mut progress,
    )
    .await
}

/// 按 `NetSource` 顺序逐个尝试一条线上的镜像。
async fn download_through_sources<'a>(
    client: &'static reqwest::Client,
    mut sources: Vec<NetSource>,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    on_progress: &mut Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    // PCL2 `NetFile.Sources`: each mirror keeps its own FailCount / IsFailed /
    // Error, so the failure classification below mirrors `SourceFail` instead
    // of discarding every error but the last one.
    let thread_limit = thread_limit();

    let mut last_error = String::new();
    let mut fail_count = 0u32;
    for index in 0..sources.len() {
        if sources[index].is_failed {
            continue;
        }
        let candidate = sources[index].url.clone();
        match download_multithreaded_via(
            client,
            &candidate,
            dest,
            expected_sha1,
            expected_size,
            threads,
            retry_counter,
            on_progress,
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                last_error = err.clone();
                fail_count += 1;
                let failure = classify_source_failure(&err);
                let disable = should_disable_source(
                    failure,
                    fail_count,
                    0,
                    thread_limit,
                    is_bmclapi(&candidate),
                    false,
                );
                if disable {
                    sources[index].mark_failed(err);
                } else {
                    sources[index].fail_count += 1;
                    sources[index].error = Some(err);
                }
            }
        }
    }

    // The error contract is unchanged: callers still receive the last error
    // string (and `err.contains("HTTP 404")` keeps working). The PCL2-style
    // per-source report is available via `format_download_failure`.
    Err(last_error)
}

// ---------------------------------------------------------------------------
// 入口 3：download_file_multithreaded（单 URL 多线程，无镜像链）
// ---------------------------------------------------------------------------

/// Multi-threaded file downloader with HTTP Range segmentation and automatic retries.
///
/// - When `threads > 1` and the file is at least `MIN_MULTITHREAD_SIZE`, probes the server
///   for `Accept-Ranges` / `206 Partial Content` support and splits the download into
///   concurrent byte-range segments.
/// - Automatically falls back to single-stream download if the server does not support
///   byte ranges.
/// - Retries transient network failures with exponential backoff.
/// - Calls `on_progress(done_bytes, total_bytes, delta_bytes)` as chunks arrive.
/// - Downloads run on `direct_client()`, i.e. outside the system proxy; only a
///   connect-level failure escalates to the proxy-equipped `client()`.
pub async fn download_file_multithreaded<'a>(
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    let mut raw_progress = on_progress;
    let mut max_done: u64 = 0;
    let mut max_total: u64 = expected_size.unwrap_or(0);
    let mut monotonic_cb = |done: u64, total: u64, _delta: u64| {
        if total > max_total {
            max_total = total;
        }
        let clamped_done = if max_total > 0 {
            done.min(max_total)
        } else {
            done
        };
        let monotonic_done = clamped_done.max(max_done);
        let monotonic_delta = monotonic_done.saturating_sub(max_done);
        max_done = monotonic_done;
        if let Some(cb) = raw_progress.as_mut() {
            cb(monotonic_done, max_total, monotonic_delta);
        }
    };
    let mut progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send)> =
        Some(&mut monotonic_cb);
    match download_multithreaded_via(
        direct_client(),
        url,
        dest,
        expected_sha1,
        expected_size,
        threads,
        retry_counter,
        &mut progress,
    )
    .await
    {
        Err(direct_error) if proxy_retry_worthwhile(&direct_error) => {
            download_multithreaded_via(
                client(),
                url,
                dest,
                expected_sha1,
                expected_size,
                threads,
                retry_counter,
                &mut progress,
            )
            .await
        }
        result => result,
    }
}

async fn download_multithreaded_via<'a>(
    client: &'static reqwest::Client,
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    on_progress: &mut Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        if !parent.is_dir() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("无法创建目录 {}: {e}", parent.display()))?;
        }
    }

    let part = part_path(dest);
    let threads = threads.clamp(1, 64);

    // Try segmented multi-threaded download for large files when multiple threads are allowed.
    // When expected_size is unknown (None), still probe HTTP Range so large downloads (Bedrock cores, etc.) auto-accelerate.
    let should_try_segmented = threads > 1
        && expected_size
            .map(|s| s >= MIN_MULTITHREAD_SIZE)
            .unwrap_or(true);

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
                client,
                url,
                &part,
                expected_size,
                threads,
                retry_counter,
                Some(&mut tracked_cb),
            );
            tokio::pin!(fut);

            let started = Instant::now();
            let mut ticker = tokio::time::interval(SEGMENT_WATCHDOG_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            ticker.tick().await;

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
                        let done = segmented_progress.load(Ordering::Relaxed) as f64;
                        let elapsed = started.elapsed().as_secs_f64().max(0.001);
                        if done / elapsed < SEGMENT_MIN_RATE_BYTES {
                            stalled = true;
                            break;
                        }
                    }
                }
            }
            // 放弃分片时直接丢掉 future，连接会立刻释放；返回 None 表示
            // "这条线路不适合多线程"，交给下面的单连接流程。
            if stalled { None } else { outcome }
        };

        match segmented_result {
            Some(Ok(Some(downloaded))) => {
                if let Err(err) =
                    verify_and_commit(&part, dest, downloaded, expected_size, expected_sha1, None)
                        .await
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
    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            if let Some(counter) = retry_counter {
                counter.fetch_add(1, Ordering::Relaxed);
            }
            tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt))).await;
        }

        match download_single_stream(
            client,
            url,
            &part,
            expected_size,
            expected_sha1.is_some(),
            on_progress.as_mut().map(|cb| &mut **cb),
        )
        .await
        {
            Ok((downloaded, inline_sha1)) => {
                match verify_and_commit(
                    &part,
                    dest,
                    downloaded,
                    expected_size,
                    expected_sha1,
                    inline_sha1.as_deref(),
                )
                .await
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

// ---------------------------------------------------------------------------
// 入口 4：download_file_resumable（断点续传）
// ---------------------------------------------------------------------------

/// 支持断点续传的多线程下载。
///
/// 分片布局与已完成的分片记在 `<dest>.part.meta` 里：关掉启动器、切换镜像或者
/// 重新点一次下载，都只会补下没完成的那几段，而不是从 0 开始。线路限制并发连接
/// 时（GitHub 加速镜像上很常见），会自动改成单连接把剩余分片顺序补完。
pub async fn download_file_resumable<'a>(
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
    expected_sha1: Option<&str>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    let mut raw_progress = on_progress;
    let mut max_done: u64 = 0;
    let mut max_total: u64 = expected_size.unwrap_or(0);
    let mut monotonic_cb = |done: u64, total: u64, _delta: u64| {
        if total > max_total {
            max_total = total;
        }
        let clamped_done = if max_total > 0 {
            done.min(max_total)
        } else {
            done
        };
        let monotonic_done = clamped_done.max(max_done);
        let monotonic_delta = monotonic_done.saturating_sub(max_done);
        max_done = monotonic_done;
        if let Some(cb) = raw_progress.as_mut() {
            cb(monotonic_done, max_total, monotonic_delta);
        }
    };
    let mut progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send)> =
        Some(&mut monotonic_cb);
    match download_resumable_via(
        direct_client(),
        url,
        dest,
        expected_size,
        expected_sha1,
        threads,
        retry_counter,
        &mut progress,
    )
    .await
    {
        Err(direct_error) if proxy_retry_worthwhile(&direct_error) => {
            download_resumable_via(
                client(),
                url,
                dest,
                expected_size,
                expected_sha1,
                threads,
                retry_counter,
                &mut progress,
            )
            .await
        }
        result => result,
    }
}

async fn download_resumable_via<'a>(
    client: &'static reqwest::Client,
    url: &str,
    dest: &Path,
    expected_size: Option<u64>,
    expected_sha1: Option<&str>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    on_progress: &mut Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<u64, String> {
    if let Some(parent) = dest.parent() {
        if !parent.is_dir() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("无法创建目录 {}: {e}", parent.display()))?;
        }
    }

    let part = part_path(dest);
    let threads = threads.clamp(1, 64);

    // 先确认这条线路支不支持 Range，顺便拿到总长度与最终重定向目标
    let probe_opt = probe_range_support(client, url, expected_size).await?;
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
        return download_multithreaded_via(
            client,
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
                fetch_range_into(client, &worker_url, &part, start, end, &downloaded, &tx)
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
                    let done = downloaded.load(Ordering::Relaxed) as f64;
                    let elapsed = started.elapsed().as_secs_f64().max(0.001);
                    if done / elapsed < SEGMENT_MIN_RATE_BYTES {
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
                        fetch_range_into(client, &target_url, &part, start, end, &downloaded, &tx);
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

    verify_and_commit(&part, dest, total, Some(total), expected_sha1, None).await?;
    let _ = fs::remove_file(resume_meta_path(&part)).await;
    Ok(total)
}

// ---------------------------------------------------------------------------
// 单流下载与分段下载编排
// ---------------------------------------------------------------------------

async fn download_single_stream<'a>(
    client: &'static reqwest::Client,
    url: &str,
    part: &Path,
    expected_size: Option<u64>,
    compute_sha1: bool,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<(u64, Option<String>), String> {
    // PCL2 `NetTaskThreadCount` + `ConnectAverage` bookkeeping.
    let _thread = try_acquire_thread();
    let started = Instant::now();
    let response = client
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
    const MAX_IN_MEMORY_BYTES: u64 = 2 * 1024 * 1024;
    let buffer_in_ram = total > 0 && total <= MAX_IN_MEMORY_BYTES;

    let mut file = if buffer_in_ram {
        None
    } else {
        Some(
            fs::File::create(part)
                .await
                .map_err(|e| format!("无法写入 {}: {e}", part.display()))?,
        )
    };
    let mut mem_buf = if buffer_in_ram {
        Vec::with_capacity(total as usize)
    } else {
        Vec::new()
    };
    let mut hasher = compute_sha1.then(Sha1::new);

    let mut downloaded: u64 = 0;
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
        let delta = chunk.len() as u64;
        // PCL2 `NetTaskSpeedLimitHigh` token bucket: wait for these bytes
        // before accepting them, so all streams share one global cap.
        consume(delta).await;
        if let Some(ref mut h) = hasher {
            h.update(&chunk);
        }
        if let Some(ref mut f) = file {
            f.write_all(&chunk)
                .await
                .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
        } else if (mem_buf.len() as u64) + delta <= MAX_IN_MEMORY_BYTES {
            mem_buf.extend_from_slice(&chunk);
        } else {
            let mut f = fs::File::create(part)
                .await
                .map_err(|e| format!("无法写入 {}: {e}", part.display()))?;
            if !mem_buf.is_empty() {
                f.write_all(&mem_buf)
                    .await
                    .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
                mem_buf.clear();
            }
            f.write_all(&chunk)
                .await
                .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
            file = Some(f);
        }
        downloaded += delta;
        if let Some(cb) = on_progress.as_mut() {
            cb(downloaded, total, delta);
        }
    }

    if let Some(mut f) = file {
        f.flush()
            .await
            .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
        drop(f);
    } else {
        fs::write(part, &mem_buf)
            .await
            .map_err(|e| format!("写入失败 {}: {e}", part.display()))?;
    }
    let sha1_hex = hasher.map(|h| format!("{:x}", h.finalize()));
    record_connect(started.elapsed().as_millis() as u64);
    Ok((downloaded, sha1_hex))
}

/// Probes whether the server supports HTTP Range requests and, if so, downloads the file
/// in parallel byte segments. Returns `Ok(None)` if Range is not supported.
async fn try_segmented_download<'a>(
    client: &'static reqwest::Client,
    url: &str,
    part: &Path,
    expected_size: Option<u64>,
    threads: usize,
    retry_counter: Option<&AtomicU64>,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send + 'a)>,
) -> Result<Option<u64>, String> {
    let Some(probe) = probe_range_support(client, url, expected_size).await? else {
        return Ok(None);
    };

    let total = probe.total;
    let final_url = probe.final_url;

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
            let worker_url = final_url.clone();
            let part = part.to_path_buf();
            let downloaded = downloaded.clone();
            let tx = tx.clone();
            async move {
                let res =
                    fetch_range_into(client, &worker_url, &part, start, end, &downloaded, &tx)
                        .await;
                ((start, end), res)
            }
        })
        .collect();

    drop(tx);

    let join_fut = futures_util::future::join_all(segment_futures);
    tokio::pin!(join_fut);

    let mut max_reported: u64 = 0;
    let results = loop {
        tokio::select! {
             biased;
             maybe_msg = rx.recv() => {
                 if let Some((current, _delta)) = maybe_msg {
                     let clamped = current.min(total);
                     if clamped > max_reported {
                         let monotonic_delta = clamped - max_reported;
                         max_reported = clamped;
                         if let Some(cb) = on_progress.as_mut() {
                             cb(max_reported, total, monotonic_delta);
                         }
                     }
                 } else {
                     break join_fut.await;
                 }
             }
             res = &mut join_fut => {
                 while let Ok((current, _delta)) = rx.try_recv() {
                     let clamped = current.min(total);
                     if clamped > max_reported {
                         let monotonic_delta = clamped - max_reported;
                         max_reported = clamped;
                         if let Some(cb) = on_progress.as_mut() {
                             cb(max_reported, total, monotonic_delta);
                         }
                     }
                 }
                 break res;
             }
        }
    };

    let mut total_retries: u64 = 0;
    let mut failed_ranges: Vec<(u64, u64, String)> = Vec::new();
    let mut succeeded_count: usize = 0;

    for ((start, end), res) in results {
        match res {
            Ok(attempts) => {
                succeeded_count += 1;
                total_retries += u64::from(attempts);
            }
            Err(err) => {
                failed_ranges.push((start, end, err));
            }
        }
    }

    if total_retries > 0 {
        if let Some(counter) = retry_counter {
            counter.fetch_add(total_retries, Ordering::Relaxed);
        }
    }

    // 若部分分片因 CDN 并发限流（429/503/瞬断）失败，但已有分片成功落盘，
    // 绝不丢弃已下载的 `.part` 从 0 重来，而是以低并发把剩余失败分片逐一补完！
    if !failed_ranges.is_empty() {
        if succeeded_count == 0 {
            return Err(failed_ranges.remove(0).2);
        }
        for (start, end, _first_err) in failed_ranges {
            let (retry_tx, mut retry_rx) = tokio::sync::mpsc::unbounded_channel::<(u64, u64)>();
            let fetch_fut =
                fetch_range_into(client, &final_url, part, start, end, &downloaded, &retry_tx);
            tokio::pin!(fetch_fut);
            let attempts = loop {
                tokio::select! {
                    biased;
                    maybe_msg = retry_rx.recv() => {
                        if let Some((current, _delta)) = maybe_msg {
                            let clamped = current.min(total);
                            if clamped > max_reported {
                                let monotonic_delta = clamped - max_reported;
                                max_reported = clamped;
                                if let Some(cb) = on_progress.as_mut() {
                                    cb(max_reported, total, monotonic_delta);
                                }
                            }
                        }
                    }
                    res = &mut fetch_fut => break res?,
                }
            };
            if let Some(counter) = retry_counter {
                counter.fetch_add(u64::from(attempts) + 1, Ordering::Relaxed);
            }
        }
    }

    if max_reported < total {
        let delta = total - max_reported;
        if let Some(cb) = on_progress.as_mut() {
            cb(total, total, delta);
        }
    }

    Ok(Some(total))
}
