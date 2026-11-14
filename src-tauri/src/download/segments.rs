//! HTTP Range 分段下载的数学与单分片 worker。
//!
//! `probe_range_support` 探测服务器是否支持 `206 Partial Content` 并解析重定向
//! 后的最终 URL；`compute_segments` 把文件切成连续不重叠的分片；
//! `fetch_range_into` 是单个分片的下载 worker（带重试、限速令牌桶与停滞超时）。

use std::io::SeekFrom;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::RANGE;
use tokio::fs;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use super::limit::{consume, try_acquire_thread};
use super::types::{MAX_RETRIES, SEGMENT_IDLE_TIMEOUT, MIN_SEGMENT_SIZE};

/// 支持断点续传的多线程下载探测结果。
#[derive(Debug, Clone)]
pub struct RangeProbe {
    pub final_url: String,
    pub total: u64,
}

/// Probes whether the server supports HTTP Range requests and resolves the final URL
/// (following redirects while preserving byte-range capabilities).
pub async fn probe_range_support(
    client: &'static reqwest::Client,
    url: &str,
    expected_size: Option<u64>,
) -> Result<Option<RangeProbe>, String> {
    let probe = client
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
            let direct = client
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

/// 把总长度 `total` 切成至多 `max_threads` 个连续分片，每片不小于
/// `MIN_SEGMENT_SIZE`（除非文件本身更小）。
pub fn compute_segments(total: u64, max_threads: usize) -> Vec<(u64, u64)> {
    if total == 0 {
        return Vec::new();
    }
    let max_by_size = (total / MIN_SEGMENT_SIZE).max(1) as usize;
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

/// UI 展示用：预计会切成多少段（未探测前按尺寸估算）。
pub fn recommended_segments(size: Option<u64>, max_threads: usize) -> u32 {
    match size {
        Some(total) if total >= super::types::MIN_MULTITHREAD_SIZE && max_threads > 1 => {
            compute_segments(total, max_threads).len() as u32
        }
        None if max_threads > 1 => max_threads.clamp(1, 16) as u32,
        _ => 1,
    }
}

/// 单个分片的下载 worker：把 `bytes={start}-{end}` 写入 `.part` 的对应偏移。
/// 返回实际使用的重试次数（首次成功为 0），供调用方记账 `retried_files`。
pub(super) async fn fetch_range_into(
    client: &'static reqwest::Client,
    url: &str,
    part: &std::path::Path,
    start: u64,
    end: u64,
    downloaded: &AtomicU64,
    tx: &tokio::sync::mpsc::UnboundedSender<(u64, u64)>,
) -> Result<u32, String> {
    // PCL2 `NetTaskThreadCount`: every Range worker counts towards the global cap.
    let _thread = try_acquire_thread();
    let expected_len = end - start + 1;
    let mut last_err = String::new();
    for attempt in 0..MAX_RETRIES {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(200 * u64::from(attempt))).await;
        }
        let mut written_this_attempt: u64 = 0;
        let res: Result<(), String> = async {
            let response = client
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
                client
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
                return Err(format!(
                    "服务器未返回分片数据 ({url}): HTTP {}",
                    response.status()
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
                // PCL2 global token bucket: segmented and single-stream
                // transfers share the same `NetTaskSpeedLimitLeft` budget.
                consume(len).await;
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
            Ok(()) => return Ok(attempt),
            Err(error) => {
                // 429 / 503：镜像在限速（并发太高时很常见），退避后再试。
                if error.contains("HTTP 429") || error.contains("HTTP 503") {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                last_err = error;
                if written_this_attempt > 0 {
                    downloaded.fetch_sub(written_this_attempt, Ordering::Relaxed);
                }
            }
        }
    }
    Err(last_err)
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
