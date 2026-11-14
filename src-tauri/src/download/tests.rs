//! 引擎集成测试：本地最小 HTTP 服务器验证 Range 分片、续传与回退逻辑，不碰网络。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::engine::{download_file_multithreaded, download_file_resumable};
use super::resume::{ResumeMeta, resume_meta_path};
use super::segments::compute_segments;
use super::verify::{part_path};
use super::resume::resume_progress;

fn fixture_bytes(len: usize) -> Vec<u8> {
    (0..len).map(|index| (index % 251) as u8).collect()
}

fn fixture_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cobble-net-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
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
    /// 启动后的这段时间里每个连接只给 1 KB/s，用来触发慢速看门狗。
    slow_window: Duration,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            honor_range: true,
            stall_segments: false,
            slow_window: Duration::ZERO,
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
    let started = Instant::now();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let bytes = bytes.clone();
            let requests = recorded.clone();
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
                match range {
                    Some((start, end)) if options.honor_range && start < total => {
                        let end = end.min(total - 1);
                        let slice = &bytes[start as usize..=end as usize];
                        let header = format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{total}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                            slice.len()
                        );
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
                        while offset < slice.len() {
                            if slow && started.elapsed() < options.slow_window {
                                let take = (slice.len() - offset).min(1024);
                                if socket
                                    .write_all(&slice[offset..offset + take])
                                    .await
                                    .is_err()
                                {
                                    return;
                                }
                                let _ = socket.flush().await;
                                offset += take;
                                tokio::time::sleep(Duration::from_secs(1)).await;
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

/// 清掉同名文件、`.part` 与旁车文件，保证用例之间互不影响。
fn clean_fixture(name: &str) -> PathBuf {
    let dest = fixture_path(name);
    let part = part_path(&dest);
    for path in [dest.clone(), part.clone(), resume_meta_path(&part)] {
        let _ = std::fs::remove_file(path);
    }
    dest
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

/// 已经下好的分片不会被重新请求：续传只补缺的那几段。
#[tokio::test]
async fn resumes_without_refetching_completed_segments() {
    let payload = Arc::new(fixture_bytes(3_000_000));
    let server = spawn_range_server(payload.clone(), true, false).await;
    let dest = clean_fixture("resume.bin");
    let part = part_path(&dest);
    let total = payload.len() as u64;
    let segments = compute_segments(total, 4);

    // 造一个"下到一半"的现场：第一段已经落盘，旁车文件记着它。
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
