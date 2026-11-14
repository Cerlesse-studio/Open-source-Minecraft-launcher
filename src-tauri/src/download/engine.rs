//! 下载执行引擎：统一的 `download(DownloadRequest)` 入口。
//!
//! 吸收了重构前四条入口（`download_file` / `download_file_with_mirrors` /
//! `download_file_multithreaded` / `download_file_resumable`）的全部行为：
//!
//! 1. 解析下载源列表（显式传入，或按用户偏好生成 BMCLAPI/官方 CDN 镜像链）；
//! 2. 直连客户端逐源尝试（系统代理只会把大流量绕远路）；
//! 3. 每源先探测 HTTP Range：大文件分段并行（看门狗 + 失败分片低并发补抓），
//!    `resume: true` 时把分片布局与完成进度记入断点续传旁车文件；
//! 4. 小文件单流下载（30 秒停滞超时、≤2 MB 内存缓冲、流式 SHA-1）；
//! 5. `FileChecker` 尺寸/SHA-1 校验通过后原子改名提交；
//! 6. 直连失败且属于连接层错误时，整条源链经系统代理客户端重放。
//!
//! 旧的四条入口暂时以薄包装形式保留（签名与行为不变），阶段 3 迁移全部
//! 调用点后删除。

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha1::{Digest, Sha1};
use tokio::fs;
use tokio::io::AsyncWriteExt;

use super::error::{
    classify_source_failure, proxy_retry_worthwhile, should_disable_source, DownloadError,
};
use super::limit::{consume, record_connect, thread_limit, try_acquire_thread};
use super::resume::{discard_partial, read_resume_meta, resume_meta_path, write_resume_meta, ResumeMeta};
use super::segments::{compute_segments, fetch_range_into, probe_range_support, RangeProbe};
use super::source::{is_bmclapi, per_file_threads, preferred_urls, sources_for, NetSource};
use super::types::{
    MAX_RETRIES, MIN_MULTITHREAD_SIZE, SEGMENT_IDLE_TIMEOUT, SEGMENT_MIN_RATE_BYTES,
    SEGMENT_SLOW_GRACE, SEGMENT_WATCHDOG_INTERVAL,
};
use super::verify::{part_path, verify_and_commit};
use super::DownloadRequest;
use crate::net::{client, direct_client};

// ---------------------------------------------------------------------------
// 进度上报：单调钳制（所有旧入口共用的包装语义）
// ---------------------------------------------------------------------------

/// 包装调用方的进度回调：total 只增不减、done 单调递增、delta 非负。
/// 与旧入口逐字节相同的钳制语义，引擎内部只需"每收到一块就上报"。
struct Monotonic<'a> {
    inner: Option<&'a mut (dyn FnMut(u64, u64, u64) + Send)>,
    max_done: u64,
    max_total: u64,
}

impl<'a> Monotonic<'a> {
    fn new(
        inner: Option<&'a mut (dyn FnMut(u64, u64, u64) + Send)>,
        expected_size: Option<u64>,
    ) -> Self {
        Self {
            inner,
            max_done: 0,
            max_total: expected_size.unwrap_or(0),
        }
    }

    fn emit(&mut self, done: u64, total: u64) {
        if total > self.max_total {
            self.max_total = total;
        }
        let clamped_done = if self.max_total > 0 {
            done.min(self.max_total)
        } else {
            done
        };
        let monotonic_done = clamped_done.max(self.max_done);
        let monotonic_delta = monotonic_done.saturating_sub(self.max_done);
        self.max_done = monotonic_done;
        if let Some(cb) = self.inner.as_mut() {
            cb(monotonic_done, self.max_total, monotonic_delta);
        }
    }
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/// 执行一次下载。见模块文档了解完整流程。
pub async fn download(req: DownloadRequest<'_>) -> Result<u64, DownloadError> {
    let threads = req
        .threads
        .unwrap_or_else(|| per_file_threads(req.expected_size))
        .clamp(1, 64);
    let mut progress = Monotonic::new(req.on_progress, req.expected_size);

    // 第一轮直接连：系统代理只会把下载流量绕远路。
    let direct_error = match download_through_sources(
        direct_client(),
        sources_for(req.sources.clone().unwrap_or_else(|| preferred_urls(&req.url))),
        &req.dest,
        req.expected_sha1.as_deref(),
        req.expected_size,
        threads,
        req.resume,
        req.retry_counter,
        &mut progress,
    )
    .await
    {
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
        sources_for(req.sources.clone().unwrap_or_else(|| preferred_urls(&req.url))),
        &req.dest,
        req.expected_sha1.as_deref(),
        req.expected_size,
        threads,
        req.resume,
        req.retry_counter,
        &mut progress,
    )
    .await
}

/// 按 `NetSource` 顺序逐个尝试一条线上的镜像。
///
/// PCL2 `NetFile.Sources`: each mirror keeps its own FailCount / IsFailed /
/// Error, so the failure classification below mirrors `SourceFail` instead
/// of discarding every error but the last one.
#[allow(clippy::too_many_arguments)]
async fn download_through_sources(
    client: &'static reqwest::Client,
    mut sources: Vec<NetSource>,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    resume: bool,
    retry_counter: Option<&AtomicU64>,
    progress: &mut Monotonic<'_>,
) -> Result<u64, DownloadError> {
    let limit = thread_limit();

    let mut fail_count = 0u32;
    let mut last_error: Option<DownloadError> = None;
    for index in 0..sources.len() {
        if sources[index].is_failed {
            continue;
        }
        let candidate = sources[index].url.clone();
        match download_from_source(
            client,
            &candidate,
            dest,
            expected_sha1,
            expected_size,
            threads,
            resume,
            retry_counter,
            progress,
        )
        .await
        {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                let text = err.to_string();
                fail_count += 1;
                let failure = classify_source_failure(&err);
                let disable = should_disable_source(
                    failure,
                    fail_count,
                    0,
                    limit,
                    is_bmclapi(&candidate),
                    false,
                );
                if disable {
                    sources[index].mark_failed(text);
                } else {
                    sources[index].fail_count += 1;
                    sources[index].error = Some(text);
                }
                last_error = Some(err);
            }
        }
    }

    Err(last_error.unwrap_or(DownloadError::NoSource))
}

/// 从单个 URL 下载：探测 Range → 分段并行（或断点续传）→ 单流回退。
#[allow(clippy::too_many_arguments)]
async fn download_from_source(
    client: &'static reqwest::Client,
    url: &str,
    dest: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    threads: usize,
    resume: bool,
    retry_counter: Option<&AtomicU64>,
    progress: &mut Monotonic<'_>,
) -> Result<u64, DownloadError> {
    if let Some(parent) = dest.parent() {
        if !parent.is_dir() {
            fs::create_dir_all(parent).await.map_err(|source| {
                DownloadError::CreateDir {
                    path: parent.display().to_string(),
                    source,
                }
            })?;
        }
    }

    let part = part_path(dest);
    let threads = threads.clamp(1, 64);

    // 大文件（或大小未知）先探测 HTTP Range，尝试分段并行下载。
    let mut segmented_plan: Option<(RangeProbe, Vec<(u64, u64)>)> = None;
    let should_try_segmented = threads > 1
        && expected_size
            .map(|s| s >= MIN_MULTITHREAD_SIZE)
            .unwrap_or(true);
    if should_try_segmented {
        match probe_range_support(client, url, expected_size).await {
            Ok(Some(probe)) => {
                let segments = if probe.total >= MIN_MULTITHREAD_SIZE {
                    compute_segments(probe.total, threads)
                } else {
                    Vec::new()
                };
                if segments.len() > 1 {
                    segmented_plan = Some((probe, segments));
                }
            }
            // 不支持 Range / 探测失败（含 404）：旧实现记一次重试后回退单流。
            Ok(None) => {}
            Err(err) => {
                if let Some(counter) = retry_counter {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
                let _ = err;
            }
        }
    }

    if let Some((probe, segments)) = segmented_plan {
        if resume {
            // 断点续传：分片布局与完成进度记入 `<dest>.part.meta`，
            // 未完成时保留 `.part`，换一条镜像还能接着补。
            return resumable_fetch(
                client,
                &probe.final_url,
                &part,
                dest,
                probe.total,
                segments,
                expected_sha1,
                retry_counter,
                progress,
            )
            .await;
        }
        match segmented_fetch(
            client,
            &probe.final_url,
            &part,
            probe.total,
            &segments,
            retry_counter,
            progress,
        )
        .await
        {
            Ok(Some(downloaded)) => {
                if let Err(err) =
                    verify_and_commit(&part, dest, downloaded, expected_size, expected_sha1, None)
                        .await
                {
                    let _ = fs::remove_file(&part).await;
                    return Err(err);
                }
                return Ok(downloaded);
            }
            // None = 看门狗判定这条线路不适合多线程（慢速镜像）；
            // Err = 分片失败。旧实现：记一次重试，清掉 `.part`，回退单流。
            _ => {
                if let Some(counter) = retry_counter {
                    counter.fetch_add(1, Ordering::Relaxed);
                }
                let _ = fs::remove_file(&part).await;
            }
        }
    } else if resume {
        // 旧 resumable 路径：分不出有意义的分片（不支持 Range / 文件太小）
        // 时，先丢弃旧进度再走单流。
        discard_partial(&part).await;
    }

    // 单流下载，带自动重试。
    single_stream_with_retries(
        client,
        url,
        dest,
        &part,
        expected_sha1,
        expected_size,
        retry_counter,
        progress,
    )
    .await
}

// ---------------------------------------------------------------------------
// 单流下载
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn single_stream_with_retries(
    client: &'static reqwest::Client,
    url: &str,
    dest: &Path,
    part: &Path,
    expected_sha1: Option<&str>,
    expected_size: Option<u64>,
    retry_counter: Option<&AtomicU64>,
    progress: &mut Monotonic<'_>,
) -> Result<u64, DownloadError> {
    let mut last_error: Option<DownloadError> = None;
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
            part,
            expected_size,
            expected_sha1.is_some(),
            progress,
        )
        .await
        {
            Ok((downloaded, inline_sha1)) => {
                match verify_and_commit(
                    part,
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
                        last_error = Some(verify_err);
                        let _ = fs::remove_file(part).await;
                    }
                }
            }
            Err(err) => {
                let is_404 = matches!(&err, DownloadError::Http { status: 404, .. });
                last_error = Some(err);
                let _ = fs::remove_file(part).await;
                if is_404 {
                    break;
                }
            }
        }
    }

    Err(last_error.unwrap_or(DownloadError::NoSource))
}

/// 单连接顺序下载。小于 2 MB 的文件全程走内存缓冲，避免落盘两次。
async fn download_single_stream(
    client: &'static reqwest::Client,
    url: &str,
    part: &Path,
    expected_size: Option<u64>,
    compute_sha1: bool,
    progress: &mut Monotonic<'_>,
) -> Result<(u64, Option<String>), DownloadError> {
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
        .map_err(|source| DownloadError::Transport {
            url: url.to_string(),
            source,
        })?;

    if !response.status().is_success() {
        return Err(DownloadError::Http {
            url: url.to_string(),
            status: response.status().as_u16(),
        });
    }

    let total = response.content_length().or(expected_size).unwrap_or(0);
    const MAX_IN_MEMORY_BYTES: u64 = 2 * 1024 * 1024;
    let buffer_in_ram = total > 0 && total <= MAX_IN_MEMORY_BYTES;

    let mut file = if buffer_in_ram {
        None
    } else {
        Some(
            fs::File::create(part).await.map_err(|source| {
                DownloadError::CreatePart {
                    path: part.display().to_string(),
                    source,
                }
            })?,
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
        .map_err(|_| DownloadError::Stalled {
            url: url.to_string(),
            secs: SEGMENT_IDLE_TIMEOUT.as_secs(),
        })?
    {
        let chunk = chunk.map_err(|source| DownloadError::StreamInterrupted {
            url: url.to_string(),
            source,
        })?;
        let delta = chunk.len() as u64;
        // PCL2 `NetTaskSpeedLimitHigh` token bucket: wait for these bytes
        // before accepting them, so all streams share one global cap.
        consume(delta).await;
        if let Some(ref mut h) = hasher {
            h.update(&chunk);
        }
        if let Some(ref mut f) = file {
            f.write_all(&chunk).await.map_err(|source| {
                DownloadError::WritePart {
                    path: part.display().to_string(),
                    source,
                }
            })?;
        } else if (mem_buf.len() as u64) + delta <= MAX_IN_MEMORY_BYTES {
            mem_buf.extend_from_slice(&chunk);
        } else {
            let mut f = fs::File::create(part).await.map_err(|source| {
                DownloadError::CreatePart {
                    path: part.display().to_string(),
                    source,
                }
            })?;
            if !mem_buf.is_empty() {
                f.write_all(&mem_buf).await.map_err(|source| {
                    DownloadError::WritePart {
                        path: part.display().to_string(),
                        source,
                    }
                })?;
                mem_buf.clear();
            }
            f.write_all(&chunk).await.map_err(|source| {
                DownloadError::WritePart {
                    path: part.display().to_string(),
                    source,
                }
            })?;
            file = Some(f);
        }
        downloaded += delta;
        progress.emit(downloaded, total);
    }

    if let Some(mut f) = file {
        f.flush().await.map_err(|source| {
            DownloadError::WritePart {
                path: part.display().to_string(),
                source,
            }
        })?;
        drop(f);
    } else {
        fs::write(part, &mem_buf).await.map_err(|source| {
            DownloadError::WritePart {
                path: part.display().to_string(),
                source,
            }
        })?;
    }
    let sha1_hex = hasher.map(|h| format!("{:x}", h.finalize()));
    record_connect(started.elapsed().as_millis() as u64);
    Ok((downloaded, sha1_hex))
}

// ---------------------------------------------------------------------------
// 分段并行下载（不断点续传）：看门狗 + 失败分片低并发补抓
// ---------------------------------------------------------------------------

/// 并行抓取全部分片。`Ok(None)` 表示看门狗判定这条线路不适合多线程，
/// 调用方应回退单流。探测与切分已在 `download_from_source` 完成。
#[allow(clippy::too_many_arguments)]
async fn segmented_fetch(
    client: &'static reqwest::Client,
    final_url: &str,
    part: &Path,
    total: u64,
    segments: &[(u64, u64)],
    retry_counter: Option<&AtomicU64>,
    progress: &mut Monotonic<'_>,
) -> Result<Option<u64>, DownloadError> {
    // Pre-allocate the target `.part` file.
    {
        let file = fs::File::create(part).await.map_err(|source| {
            DownloadError::CreateSegmentFile {
                path: part.display().to_string(),
                source,
            }
        })?;
        file.set_len(total).await.map_err(|source| {
            DownloadError::Preallocate {
                path: part.display().to_string(),
                source,
            }
        })?;
    }

    let downloaded = Arc::new(AtomicU64::new(0));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u64, u64)>();

    let segment_futures: Vec<_> = segments
        .iter()
        .copied()
        .map(|(start, end)| {
            let worker_url = final_url.to_string();
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

    // 分片下载启动后的爬坡期内不计速率；总吞吐持续过低说明这条线路
    // 限制并发连接，多开分片反而更慢，放弃并交给单流回退。
    let started = Instant::now();
    let mut ticker = tokio::time::interval(SEGMENT_WATCHDOG_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    let mut max_reported: u64 = 0;
    let mut stalled = false;
    let results = loop {
        tokio::select! {
            biased;
            maybe_msg = rx.recv() => {
                if let Some((current, _delta)) = maybe_msg {
                    let clamped = current.min(total);
                    if clamped > max_reported {
                        max_reported = clamped;
                        progress.emit(max_reported, total);
                    }
                } else {
                    break join_fut.await;
                }
            }
            res = &mut join_fut => {
                while let Ok((current, _delta)) = rx.try_recv() {
                    let clamped = current.min(total);
                    if clamped > max_reported {
                        max_reported = clamped;
                        progress.emit(max_reported, total);
                    }
                }
                break res;
            }
            _ = ticker.tick() => {
                if started.elapsed() < SEGMENT_SLOW_GRACE {
                    continue;
                }
                let done = downloaded.load(Ordering::Relaxed) as f64;
                let elapsed = started.elapsed().as_secs_f64().max(0.001);
                if done / elapsed < SEGMENT_MIN_RATE_BYTES {
                    stalled = true;
                    break Vec::new();
                }
            }
        }
    };

    // 放弃分片时直接丢掉 future，连接会立刻释放；返回 None 表示
    // "这条线路不适合多线程"，交给调用方的单流回退。
    if stalled {
        return Ok(None);
    }

    let mut total_retries: u64 = 0;
    let mut failed_ranges: Vec<(u64, u64, DownloadError)> = Vec::new();
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
                fetch_range_into(client, final_url, part, start, end, &downloaded, &retry_tx);
            tokio::pin!(fetch_fut);
            let attempts = loop {
                tokio::select! {
                    biased;
                    maybe_msg = retry_rx.recv() => {
                        if let Some((current, _delta)) = maybe_msg {
                            let clamped = current.min(total);
                            if clamped > max_reported {
                                max_reported = clamped;
                                progress.emit(max_reported, total);
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
        progress.emit(total, total);
    }

    Ok(Some(total))
}

// ---------------------------------------------------------------------------
// 分段并行下载（断点续传）：分片布局持久化 + 单连接补抓
// ---------------------------------------------------------------------------

/// 支持断点续传的分段下载：分片布局与已完成的分片记在 `<dest>.part.meta`
/// 里，未完成时保留现场，下次（或下一条镜像）接着补，而不是从 0 重来。
#[allow(clippy::too_many_arguments)]
async fn resumable_fetch(
    client: &'static reqwest::Client,
    target_url: &str,
    part: &Path,
    dest: &Path,
    total: u64,
    segments: Vec<(u64, u64)>,
    expected_sha1: Option<&str>,
    retry_counter: Option<&AtomicU64>,
    progress: &mut Monotonic<'_>,
) -> Result<u64, DownloadError> {
    // 有旧进度就沿用它（分片布局必须整套照搬，否则已完成的下标对不上），
    // 否则按当前线程数新建布局并预分配 `.part`。
    let mut meta = match read_resume_meta(part).await {
        Some(meta) if meta.total == total && !meta.segments.is_empty() => meta,
        _ => ResumeMeta {
            total,
            segments: segments.clone(),
            completed: Vec::new(),
            done_bytes: 0,
        },
    };

    let preallocated = fs::metadata(part)
        .await
        .map(|info| info.len() == total)
        .unwrap_or(false);
    if !preallocated {
        discard_partial(part).await;
        let file = fs::File::create(part).await.map_err(|source| {
            DownloadError::CreateSegmentFile {
                path: part.display().to_string(),
                source,
            }
        })?;
        file.set_len(total).await.map_err(|source| {
            DownloadError::Preallocate {
                path: part.display().to_string(),
                source,
            }
        })?;
        meta.completed.clear();
        meta.done_bytes = 0;
        if meta.segments.is_empty() {
            meta.segments = segments;
        }
    }

    write_resume_meta(part, &meta).await?;

    progress.emit(meta.done_bytes.min(total), total);

    // 并行阶段出错（常见于镜像对并发连接的 429）不直接判死：先记下来，
    // 后面用单连接把没下完的分片补上，实在不行才报错。
    let mut parallel_error: Option<DownloadError> = None;

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
            let worker_url = target_url.to_string();
            let part = part.to_path_buf();
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
                            progress.emit(current.min(total), total);
                            let _ = delta;
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
                                write_resume_meta(part, &meta).await?;
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
                        fetch_range_into(client, target_url, part, start, end, &downloaded, &tx);
                    tokio::pin!(fetch);
                    loop {
                        tokio::select! {
                            biased;
                            message = rx.recv() => {
                                if let Some((current, _delta)) = message {
                                    progress.emit(current.min(total), total);
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
                    write_resume_meta(part, &meta).await?;
                }
            }
        }
    }

    if !meta.is_done() {
        // 保留 `.part` 与旁车文件：下次（或下一条镜像）接着补，而不是从 0 重来。
        return Err(parallel_error.unwrap_or(DownloadError::Incomplete));
    }

    verify_and_commit(part, dest, total, Some(total), expected_sha1, None).await?;
    let _ = fs::remove_file(resume_meta_path(part)).await;
    Ok(total)
}

// ---------------------------------------------------------------------------
// 兼容包装：旧的四条入口（阶段 3 迁移调用点后删除）
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
    let mut delta_adapter = move |done: u64, total: u64, _delta: u64| {
        if let Some(cb) = on_bytes.as_mut() {
            cb(done, total);
        }
    };
    download(
        DownloadRequest::new(url, dest)
            .sha1(expected_sha1)
            .size(expected_size)
            .on_progress(&mut delta_adapter),
    )
    .await
    .map_err(|err| err.to_string())
}

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
    let mut request = DownloadRequest::new(url, dest)
        .sha1(expected_sha1)
        .size(expected_size)
        .threads(threads)
        .retry_counter(retry_counter);
    if let Some(callback) = on_progress {
        request = request.on_progress(callback);
    }
    download(request).await.map_err(|err| err.to_string())
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
    let mut request = DownloadRequest::new(url, dest)
        .sha1(expected_sha1)
        .size(expected_size)
        .threads(threads)
        .retry_counter(retry_counter)
        // 旧入口没有镜像链：只试给定 URL（bedrock 等调用方自己轮换候选地址）。
        .sources(vec![url.to_string()]);
    if let Some(callback) = on_progress {
        request = request.on_progress(callback);
    }
    download(request).await.map_err(|err| err.to_string())
}

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
    let mut request = DownloadRequest::new(url, dest)
        .size(expected_size)
        .sha1(expected_sha1)
        .threads(threads)
        .retry_counter(retry_counter)
        .resume(true)
        .sources(vec![url.to_string()]);
    if let Some(callback) = on_progress {
        request = request.on_progress(callback);
    }
    download(request).await.map_err(|err| err.to_string())
}
