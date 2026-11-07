pub mod auth;
pub mod bedrock;
pub mod bedrock_store;
pub mod bridge;
pub mod content;
pub mod extension;
pub mod java;
pub mod littleskin;
pub mod loaders;
pub mod mcmod;
pub mod metadata_cache;
pub mod minecraft;
pub mod multiplayer;
mod net;
pub mod pcl;
pub mod platform;
pub mod search_i18n;

use crate::bridge::{AppHandle, State};
use minecraft::{
    InstallProgress, InstallResult, InstalledVersion, LaunchRequest, LaunchSpec, ProgressFn,
    VersionManifest,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct InstallState {
    running: Mutex<Option<String>>,
    abort_handle: Mutex<Option<tokio::task::AbortHandle>>,
    /// 模组/光影/资源包/地图这类内容下载的任务句柄。它们故意和版本安装分开：
    /// 取消一次资源下载不能顺带把正在安装的版本也停掉，反之也一样。
    content: Mutex<std::collections::HashMap<String, ContentTask>>,
}

/// 一个正在进行的资源下载：取消时要中止它、回传事件名，并清掉半成品。
struct ContentTask {
    id: String,
    title: String,
    filename: String,
    project_type: String,
    root: PathBuf,
    abort: tokio::task::AbortHandle,
}

impl InstallState {
    fn register_content(&self, task: ContentTask) {
        if let Ok(mut guard) = self.content.lock() {
            guard.insert(task.id.clone(), task);
        }
    }

    /// 只摘掉自己那一条：同一时间可能有多个内容下载在跑。
    fn release_content(&self, id: &str) {
        if let Ok(mut guard) = self.content.lock() {
            guard.remove(id);
        }
    }

    /// 取消一个指定任务，或者（id 为空时）全部内容下载。
    fn take_content(&self, id: Option<&str>) -> Vec<ContentTask> {
        let Ok(mut guard) = self.content.lock() else {
            return Vec::new();
        };
        match id {
            Some(id) => guard.remove(id).into_iter().collect(),
            None => guard.drain().map(|(_, task)| task).collect(),
        }
    }
}

pub struct GameState {
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
    bedrock_running: Arc<AtomicBool>,
    /// 用户在「正在启动…」阶段点取消时唤醒等待中的启动流程。
    launch_cancel: Arc<tokio::sync::Notify>,
    /// 粘性标记：取消请求可能比启动流程进入等待更早到达，光靠 `Notify`
    /// 会漏掉那一次唤醒。
    launch_cancelled: Arc<AtomicBool>,
    /// 游戏的 OpenGL 窗口是否已经创建。进程起来不等于能玩：Java 在窗口出现
    /// 前还要初始化 LWJGL，这段时间按钮必须是「取消启动」而不是「停止运行」。
    window_ready: Arc<AtomicBool>,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
            bedrock_running: Arc::new(AtomicBool::new(false)),
            launch_cancel: Arc::new(tokio::sync::Notify::new()),
            launch_cancelled: Arc::new(AtomicBool::new(false)),
            window_ready: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// Minecraft 创建 OpenGL 窗口时打印的日志行。它们按顺序出现在标准输出里：
/// 1.13+ 是 `Backend library: LWJGL version …`，1.12 及更早是
/// `LWJGL Version: …`，之后才是资源管理器与声音系统。看到任意一条就说明
/// 窗口已经在桌面上了。
const GAME_WINDOW_MARKERS: [&str; 5] = [
    "backend library: lwjgl",
    "lwjgl version",
    "reloading resourcemanager",
    "openal initialized",
    "sound engine started",
];

/// 窗口迟迟检测不到时的兜底：90 秒后按运行中处理，免得按钮永远停在
/// 「取消启动」上（例如自定义日志配置把这几行吞掉了）。
const GAME_WINDOW_TIMEOUT: Duration = Duration::from_secs(90);

fn line_shows_game_window(line: &str) -> bool {
    let lower = line.to_lowercase();
    GAME_WINDOW_MARKERS
        .iter()
        .any(|marker| lower.contains(marker))
}

/// 窗口出现的信号，由日志读取线程与超时兜底共享。
#[derive(Clone)]
struct WindowSignal {
    ready: Arc<AtomicBool>,
    pid: u32,
    version_id: String,
    java_major: u32,
}

/// 把状态从「正在启动」切成「运行中」，前端据此才会显示「停止运行」。
/// 只会生效一次：`ready` 用 swap 而非 store。
fn announce_game_running(app: &AppHandle, signal: &WindowSignal, detail: String) {
    if signal.ready.swap(true, Ordering::Relaxed) {
        return;
    }
    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "running".to_string(),
            detail: Some(detail),
            pid: Some(signal.pid),
            version_id: Some(signal.version_id.clone()),
        },
    );
}

/// 用户主动取消启动时的返回文案；前端据此静默处理，不当成启动失败弹错。
pub const LAUNCH_CANCELLED: &str = "已取消启动";

/// 等到用户取消启动为止；已经取消过就立即返回。
async fn wait_launch_cancel(notify: &tokio::sync::Notify, cancelled: &AtomicBool) {
    if cancelled.load(Ordering::Relaxed) {
        return;
    }
    notify.notified().await;
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallRequest {
    version_id: String,
    root: String,
    concurrency: Option<usize>,
    selection: Option<loaders::LoaderSelection>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JavaStatus {
    path: String,
    major: u32,
    version: String,
    source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    default_root: String,
    os: String,
    arch: String,
    java_installs: Vec<JavaStatus>,
    game_running: bool,
    launcher_version: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GameStatus {
    state: String,
    detail: Option<String>,
    pid: Option<u32>,
    version_id: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GameLogPayload {
    stream: String,
    line: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GameExitPayload {
    code: Option<i32>,
    version_id: Option<String>,
    /// Persistent launch log, so an exit before Minecraft's own logging starts
    /// is still diagnosable after the console has been cleared.
    #[serde(skip_serializing_if = "Option::is_none")]
    log_path: Option<String>,
    /// Last Java/Minecraft error lines, attached to the exit notification.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

fn emit_progress(app: &AppHandle) -> ProgressFn {
    let app = app.clone();
    Arc::new(move |progress: InstallProgress| {
        let _ = app.emit("install:progress", progress);
    })
}

pub fn default_root_path() -> PathBuf {
    if let Ok(game_dir) = std::env::var("OSML_GAME_DIR") {
        let trimmed = game_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(launcher_dir) = std::env::var("OSML_LAUNCHER_DIR") {
        let trimmed = launcher_dir.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join(".minecraft");
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if parent.file_name().and_then(|n| n.to_str()) == Some("core") {
                if let Some(grandparent) = parent.parent() {
                    if grandparent.file_name().and_then(|n| n.to_str()) == Some("resources") {
                        if let Some(app_root) = grandparent.parent() {
                            return app_root.join(".minecraft");
                        }
                    }
                    return grandparent.join(".minecraft");
                }
            }
            return parent.join(".minecraft");
        }
    }
    PathBuf::from(".minecraft")
}

pub fn default_root(_app: &AppHandle) -> Result<PathBuf, String> {
    let root = default_root_path();
    let _ = std::fs::create_dir_all(&root);
    Ok(root)
}

fn set_download_preference(source: String, custom_url: Option<String>, threads: Option<u32>) {
    net::set_download_preference(
        &source,
        custom_url.as_deref().unwrap_or(""),
        threads.map(|value| value as usize),
    );
}

async fn probe_download_sources(custom_url: Option<String>) -> Vec<net::DownloadSourceProbe> {
    net::probe_download_sources(custom_url.as_deref()).await
}

async fn get_version_manifest(
    root: String,
    force: Option<bool>,
) -> Result<VersionManifest, String> {
    let root = if root.trim().is_empty() {
        default_root_path()
    } else {
        PathBuf::from(root)
    };
    let _ = std::fs::create_dir_all(&root);
    minecraft::fetch_manifest(&root, force.unwrap_or(false)).await
}

async fn get_betacraft_manifest(
    root: String,
    force: Option<bool>,
) -> Result<VersionManifest, String> {
    let root = if root.trim().is_empty() {
        default_root_path()
    } else {
        PathBuf::from(root)
    };
    let _ = std::fs::create_dir_all(&root);
    minecraft::fetch_betacraft_manifest(&root, force.unwrap_or(false)).await
}

fn get_installed_versions(root: String) -> Result<Vec<InstalledVersion>, String> {
    minecraft::list_installed(&PathBuf::from(root))
}

/// Skins are always PNG, but the same command feeds the custom wallpaper, which
/// may be a JPEG/WebP/GIF. Tagging those bytes as `image/png` makes stricter
/// webviews (WKWebView) refuse to paint the image, so the type comes from the
/// file's magic bytes instead of the extension.
fn image_mime_from_bytes(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        "image/png"
    }
}

async fn read_skin_as_data_url(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("无法读取图片文件: {e}"))?;
    let mime = image_mime_from_bytes(&bytes);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// Custom home pages are rendered as a single in-memory document, so anything
/// past this size is a mistake (or an asset bundle) rather than a page.
const MAX_HOME_PAGE_BYTES: u64 = 4 * 1024 * 1024;

/// Read the player's custom home page from disk as UTF-8 text.
async fn read_home_page_file(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请先在设置中选择主页文件".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_file() {
        return Err(format!("找不到主页文件: {}", path.display()));
    }
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("无法读取主页文件: {e}"))?
        .len();
    if size > MAX_HOME_PAGE_BYTES {
        return Err(format!(
            "主页文件过大 ({:.1} MB)，上限 4 MB",
            size as f64 / 1_048_576.0
        ));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("无法读取主页文件: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Fetch an online home page as text. Doing this in Rust rather than the webview
/// keeps the request clear of CORS, which would reject most hosts.
async fn fetch_home_page(url: String) -> Result<String, String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("主页地址需要以 http:// 或 https:// 开头".to_string());
    }
    let response = net::api_client()
        .get(trimmed)
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(|e| format!("无法连接主页地址: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("主页地址返回 HTTP {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取主页内容失败: {e}"))?;
    if bytes.len() as u64 > MAX_HOME_PAGE_BYTES {
        return Err("主页内容超过 4 MB，已停止加载".to_string());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        image_mime_from_bytes, line_shows_game_window, wait_launch_cancel, ContentTask,
        InstallState, CONTENT_DOWNLOAD_CANCELLED,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    /// 已经点过取消再进入等待时必须立即返回，不能把启动流程挂住。
    #[tokio::test]
    async fn launch_cancel_returns_at_once_when_already_requested() {
        let notify = tokio::sync::Notify::new();
        let cancelled = AtomicBool::new(true);
        tokio::time::timeout(
            Duration::from_millis(100),
            wait_launch_cancel(&notify, &cancelled),
        )
        .await
        .expect("取消标记已置位时不应该继续等待");
    }

    /// 取消请求可能比启动流程更早到达：`notify_one` 留的许可要能唤醒后来的等待。
    #[tokio::test]
    async fn launch_cancel_notification_wakes_a_late_waiter() {
        let notify = tokio::sync::Notify::new();
        let cancelled = AtomicBool::new(false);
        notify.notify_one();
        tokio::time::timeout(
            Duration::from_millis(100),
            wait_launch_cancel(&notify, &cancelled),
        )
        .await
        .expect("已经有取消许可时应当立即返回");
        assert!(!cancelled.load(Ordering::Relaxed));
    }

    /// 窗口判定要覆盖各代 Minecraft 的日志：1.13+ 的 `Backend library`、
    /// 1.12 及更早的 `LWJGL Version`，以及紧随其后的资源管理与声音初始化。
    #[test]
    fn window_markers_cover_every_minecraft_generation() {
        assert!(line_shows_game_window(
            "[Render thread/INFO]: Backend library: LWJGL version 3.3.3+5"
        ));
        assert!(line_shows_game_window(
            "[Client thread/INFO]: LWJGL Version: 2.9.4"
        ));
        assert!(line_shows_game_window(
            "[Render thread/INFO]: Reloading ResourceManager: vanilla"
        ));
        assert!(line_shows_game_window(
            "[Render thread/INFO]: OpenAL initialized on device OpenAL Soft"
        ));
        // 启动早期与普通日志都不能让按钮提前变成「停止运行」。
        assert!(!line_shows_game_window("[main/INFO]: Setting user: Steve"));
        assert!(!line_shows_game_window(
            "[main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.0"
        ));
        assert!(!line_shows_game_window(
            "[Render thread/INFO]: Loaded 1421 recipes"
        ));
    }

    /// 真取消：本地服务器慢慢滴数据，中途点取消，下载 Future 必须结束、
    /// 返回取消错误，并且 `.part` 被清掉（不能留下占空间的半成品）。
    #[tokio::test]
    async fn cancelling_a_content_download_stops_it_and_cleans_the_partial() {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let total: u64 = 8 * 1024 * 1024;
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 2048];
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
                    // 不返回 206、不理会 Range：下载器会退回单连接，然后被
                    // 这条慢速连接卡在半路。
                    let header = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nContent-Type: application/zip\r\nConnection: close\r\n\r\n"
                    );
                    if socket.write_all(header.as_bytes()).await.is_err() {
                        return;
                    }
                    let chunk = vec![0u8; 1024];
                    loop {
                        if socket.write_all(&chunk).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                });
            }
        });

        let root = std::env::temp_dir().join(format!("cobble-cancel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let state = Arc::new(InstallState::default());
        let app = crate::bridge::AppHandle::default();

        let request = crate::content::DownloadContentRequest {
            root: root.to_string_lossy().to_string(),
            instance_id: None,
            project_type: "shader".to_string(),
            url: format!("http://{addr}/big.zip"),
            filename: "big.zip".to_string(),
            sha1: None,
            size: Some(total),
            title: "Big Shader".to_string(),
            game_versions: Vec::new(),
            loader: None,
            isolation: None,
            source_project_id: None,
            source_file_id: None,
            source_version: None,
        };

        let canceller = {
            let app = app.clone();
            let state = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(500)).await;
                crate::cancel_content_download(
                    app,
                    state.as_ref(),
                    Some("content:shader:big.zip".to_string()),
                )
                .await
            })
        };

        let result = crate::download_content_file(app.clone(), state.as_ref(), request).await;
        let cancelled = canceller.await.unwrap().unwrap();
        assert!(cancelled, "正在下载的任务应当可以被取消");
        assert_eq!(
            result.expect_err("取消后下载必须返回错误"),
            CONTENT_DOWNLOAD_CANCELLED
        );
        let part = root.join("shaderpacks").join("big.zip.part");
        assert!(!part.exists(), "{part:?} 应当已被清理");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 分片（多线程）下载中途取消时，`set_len` 预分配到全尺寸的 `.part` 也必须
    /// 被删掉：这是用户最容易看到的那种“取消后还留着一份大缓存”。
    #[tokio::test]
    async fn cancelling_a_segmented_download_removes_the_preallocated_partial() {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        const TOTAL: u64 = 8 * 1024 * 1024;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
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
                    let text = String::from_utf8_lossy(&head).to_string();
                    let range = text.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("range")
                            .then(|| value.trim().to_string())
                    });
                    let (start, end) = match range
                        .as_deref()
                        .and_then(|value| value.strip_prefix("bytes="))
                    {
                        Some(spec) => {
                            let (from, to) = spec.split_once('-').unwrap_or((spec, ""));
                            (
                                from.trim().parse::<u64>().unwrap_or(0),
                                to.trim()
                                    .parse::<u64>()
                                    .unwrap_or(TOTAL - 1)
                                    .min(TOTAL - 1),
                            )
                        }
                        None => (0, TOTAL - 1),
                    };
                    let len = end.saturating_sub(start) + 1;
                    let header = if range.is_some() {
                        format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{TOTAL}\r\nContent-Length: {len}\r\nContent-Type: application/zip\r\nConnection: close\r\n\r\n"
                        )
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {TOTAL}\r\nContent-Type: application/zip\r\nConnection: close\r\n\r\n"
                        )
                    };
                    if socket.write_all(header.as_bytes()).await.is_err() {
                        return;
                    }
                    let chunk = vec![0u8; 1024];
                    let mut sent = 0u64;
                    while sent < len {
                        let step = std::cmp::min(chunk.len() as u64, len - sent) as usize;
                        if socket.write_all(&chunk[..step]).await.is_err() {
                            return;
                        }
                        sent += step as u64;
                        tokio::time::sleep(Duration::from_millis(30)).await;
                    }
                });
            }
        });

        let root =
            std::env::temp_dir().join(format!("cobble-cancel-seg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let state = Arc::new(InstallState::default());
        let app = crate::bridge::AppHandle::default();

        let request = crate::content::DownloadContentRequest {
            root: root.to_string_lossy().to_string(),
            instance_id: None,
            project_type: "shader".to_string(),
            url: format!("http://{addr}/big.zip"),
            filename: "big.zip".to_string(),
            sha1: None,
            size: Some(TOTAL),
            title: "Big Shader".to_string(),
            game_versions: Vec::new(),
            loader: None,
            isolation: None,
            source_project_id: None,
            source_file_id: None,
            source_version: None,
        };

        let shaderpacks = root.join("shaderpacks");
        let canceller = {
            let app = app.clone();
            let state = state.clone();
            let shaderpacks = shaderpacks.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(600)).await;
                // 取消前看一眼：分段引擎已经把 `.pcl-part` / `.pcl-seg-*`
                // 落盘，这正是取消后必须删掉的那份“缓存”。
                let seen = temp_bytes(&shaderpacks, "big.zip");
                let cancelled = crate::cancel_content_download(
                    app,
                    state.as_ref(),
                    Some("content:shader:big.zip".to_string()),
                )
                .await
                .unwrap();
                (cancelled, seen)
            })
        };

        let result = crate::download_content_file(app.clone(), state.as_ref(), request).await;
        let (cancelled, seen) = canceller.await.unwrap();
        assert!(cancelled, "分片下载也应当可以被取消");
        assert!(seen > 0, "取消时应当已经有正在写入的临时分片");
        assert_eq!(
            result.expect_err("取消后下载必须返回错误"),
            CONTENT_DOWNLOAD_CANCELLED
        );
        // `.part`、`.pcl-part`、`.pcl-seg-*`、`.pcl-resume.json` 都是半成品，
        // 取消后一个都不能留。
        let leftovers: Vec<String> = std::fs::read_dir(&shaderpacks)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .filter(|name| {
                        name.starts_with("big.zip.part") || name.starts_with("big.zip.pcl-")
                    })
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "取消后不应留下半成品，实际还剩 {leftovers:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 目录里属于 `filename` 的临时文件总大小（分段引擎的 `.pcl-*` 与旧后级的
    /// `.part`）。
    fn temp_bytes(dir: &std::path::Path, filename: &str) -> u64 {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        name.starts_with(&format!("{filename}.pcl-"))
                            || name.starts_with(&format!("{filename}.part"))
                    })
                    .map(|entry| entry.metadata().map(|meta| meta.len()).unwrap_or(0))
                    .sum()
            })
            .unwrap_or(0)
    }

    /// 取消内容下载只能摘掉内容任务：版本安装的句柄与运行标记必须原样保留，
    /// 否则下一个模组下载会与安装流程抢同一个中止句柄。
    #[tokio::test]
    async fn cancelling_content_keeps_the_version_install_untouched() {
        let state = InstallState::default();
        *state.running.lock().unwrap() = Some("1.21.1".to_string());

        let running = tokio::spawn(async { tokio::time::sleep(Duration::from_secs(30)).await });
        state.register_content(ContentTask {
            id: "content:mod:sodium.jar".to_string(),
            title: "Sodium".to_string(),
            filename: "sodium.jar".to_string(),
            project_type: "mod".to_string(),
            root: PathBuf::from("C:/game"),
            abort: running.abort_handle(),
        });

        let taken = state.take_content(Some("content:mod:sodium.jar"));
        assert_eq!(taken.len(), 1);
        assert!(state.take_content(None).is_empty());
        assert_eq!(state.running.lock().unwrap().as_deref(), Some("1.21.1"));
        running.abort();
    }

    /// 没有 `id` 时取消全部内容任务，且同一个 id 不会被摘两次。
    #[tokio::test]
    async fn cancelling_all_content_tasks_drains_the_registry() {
        let state = InstallState::default();
        let mut spawned = Vec::new();
        for (id, filename) in [
            ("content:mod:a.jar", "a.jar"),
            ("content:shader:b.zip", "b.zip"),
        ] {
            let task = tokio::spawn(async { tokio::time::sleep(Duration::from_secs(30)).await });
            state.register_content(ContentTask {
                id: id.to_string(),
                title: filename.to_string(),
                filename: filename.to_string(),
                project_type: "mod".to_string(),
                root: PathBuf::from("C:/game"),
                abort: task.abort_handle(),
            });
            spawned.push(task);
        }
        assert_eq!(state.take_content(None).len(), 2);
        assert!(state.take_content(Some("content:mod:a.jar")).is_empty());
        for task in spawned {
            task.abort();
        }
    }

    #[test]
    fn wallpaper_data_urls_declare_the_real_image_type() {
        assert_eq!(
            image_mime_from_bytes(&[0x89, b'P', b'N', b'G', 0x0D]),
            "image/png"
        );
        assert_eq!(
            image_mime_from_bytes(&[0xFF, 0xD8, 0xFF, 0xE0]),
            "image/jpeg"
        );
        assert_eq!(image_mime_from_bytes(b"GIF89a"), "image/gif");
        assert_eq!(image_mime_from_bytes(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(image_mime_from_bytes(b"BM6\0\0\0"), "image/bmp");
        // Unknown payloads keep the historical PNG tag (skin uploads).
        assert_eq!(image_mime_from_bytes(b"not an image"), "image/png");
    }
}

async fn search_content(
    query: String,
    project_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    sort: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<content::SearchContentResult, String> {
    content::search_content(
        query,
        project_type,
        game_version,
        loader,
        sort,
        offset.unwrap_or(0),
        limit.unwrap_or(20),
    )
    .await
}

async fn get_content_versions(
    project_id_or_slug: String,
    game_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<content::ContentVersionItem>, String> {
    content::get_content_versions(project_id_or_slug, game_version, loader).await
}

/// 用户取消资源下载时的返回文案；前端据此静默处理，不当成下载失败弹错。
pub const CONTENT_DOWNLOAD_CANCELLED: &str = "下载已取消";

async fn download_content_file(
    app: AppHandle,
    state: State<'_, InstallState>,
    request: content::DownloadContentRequest,
) -> Result<content::DownloadContentResult, String> {
    // 与 content 内部生成的 id 保持一致，下载页与详情页都能拿它来取消。
    let filename = PathBuf::from(&request.filename)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| request.filename.clone());
    let task_id = format!("content:{}:{}", request.project_type, filename);
    let project_type = request.project_type.clone();
    let title = if request.title.trim().is_empty() {
        filename.clone()
    } else {
        request.title.clone()
    };

    let root = PathBuf::from(&request.root);
    let app_handle = app.clone();
    let task = tokio::spawn(async move {
        content::download_content_file(Some(&app_handle), request).await
    });

    state.register_content(ContentTask {
        id: task_id.clone(),
        title,
        filename,
        project_type,
        root,
        abort: task.abort_handle(),
    });

    let join_res = task.await;
    state.release_content(&task_id);

    match join_res {
        Ok(res) => res,
        Err(e) if e.is_cancelled() => Err(CONTENT_DOWNLOAD_CANCELLED.to_string()),
        Err(e) => Err(format!("资源下载任务执行异常: {e}")),
    }
}

/// 取消模组/光影/资源包/地图下载（`id` 为空时取消全部）。
///
/// 中止任务后把 `.part` 半成品删掉，并回传 `cancelled` 事件让下载页立刻移除
/// 这个任务（与版本安装的取消语义一致：不留失败记录）。
async fn cancel_content_download(
    app: AppHandle,
    state: State<'_, InstallState>,
    id: Option<String>,
) -> Result<bool, String> {
    let wanted = id.as_deref().map(str::trim).filter(|id| !id.is_empty());
    let tasks = state.take_content(wanted);
    if tasks.is_empty() {
        return Ok(false);
    }

    for task in &tasks {
        task.abort.abort();
    }
    for task in tasks {
        // 先让界面把这个任务摘掉，再等被中止的 future 真正 drop（文件句柄关闭），
        // 否则紧接着的删除可能碰上还开着的 `.part`。
        let _ = app.emit(
            "content:progress",
            content::ContentProgressPayload {
                id: task.id.clone(),
                title: task.title.clone(),
                filename: task.filename.clone(),
                project_type: task.project_type.clone(),
                stage: "cancelled".to_string(),
                detail: "下载已取消".to_string(),
                done_bytes: 0,
                total_bytes: 0,
                speed_bps: 0,
                threads: 0,
                error: None,
            },
        );
        for _ in 0..3 {
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
        content::discard_content_partial(&task.root, &task.filename, &task.project_type).await;
    }
    Ok(true)
}

async fn check_java_world_update(
    project_id: String,
    current_file_id: String,
) -> Result<content::JavaMapUpdate, String> {
    content::check_java_world_update(project_id, current_file_id).await
}

async fn get_version_loaders(mc_version: String) -> Result<loaders::VersionLoadersCatalog, String> {
    loaders::fetch_version_loaders(&mc_version).await
}

/// Preflight for the launch button: lists classpath/native files Java would
/// need that are missing (or empty) so the UI can repair them before starting.
async fn check_version_files(
    root: String,
    version_id: String,
) -> Result<minecraft::VersionFileReport, String> {
    minecraft::check_version_files(&PathBuf::from(root), &version_id).await
}

async fn install_version(
    app: AppHandle,
    state: State<'_, InstallState>,
    request: InstallRequest,
) -> Result<InstallResult, String> {
    let target_label = request
        .selection
        .as_ref()
        .and_then(|s| s.instance_name.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&request.version_id)
        .to_string();

    {
        let mut running = state
            .running
            .lock()
            .map_err(|_| "安装状态不可用".to_string())?;
        if let Some(active) = running.as_ref() {
            return Err(format!("正在安装 {active}，请等待当前任务完成"));
        }
        *running = Some(target_label);
    }

    let app_handle = app.clone();
    let root_path = PathBuf::from(&request.root);
    let version_id = request.version_id.clone();
    let concurrency = request.concurrency;
    let selection = request.selection.clone();

    let task = tokio::spawn(async move {
        minecraft::install_version_with_options(
            &root_path,
            &version_id,
            concurrency,
            selection,
            emit_progress(&app_handle),
        )
        .await
    });

    if let Ok(mut guard) = state.abort_handle.lock() {
        *guard = Some(task.abort_handle());
    }

    let join_res = task.await;

    if let Ok(mut running) = state.running.lock() {
        *running = None;
    }
    if let Ok(mut guard) = state.abort_handle.lock() {
        *guard = None;
    }

    match join_res {
        Ok(res) => res,
        Err(e) if e.is_cancelled() => Err("下载任务已被用户取消或暂停".to_string()),
        Err(e) => Err(format!("安装任务执行异常: {e}")),
    }
}

fn detect_java(root: String) -> Vec<JavaStatus> {
    java::detect_installs_for_ui(&PathBuf::from(root))
        .into_iter()
        .map(|install| JavaStatus {
            path: install.path,
            major: install.major,
            version: install.version,
            source: install.source,
        })
        .collect()
}

fn get_system_info(app: AppHandle, state: State<'_, GameState>) -> Result<SystemInfo, String> {
    let root = default_root(&app)?;
    let java_installs = java::detect_installs_for_ui(&root)
        .into_iter()
        .map(|install| JavaStatus {
            path: install.path,
            major: install.major,
            version: install.version,
            source: install.source,
        })
        .collect();
    let game_running = state
        .child
        .lock()
        .map(|child| child.is_some())
        .unwrap_or(false);
    Ok(SystemInfo {
        default_root: root.to_string_lossy().to_string(),
        os: platform::os_label(),
        arch: std::env::consts::ARCH.to_string(),
        java_installs,
        game_running,
        launcher_version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

fn xml_attribute(line: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=\"");
    let start = line.find(&needle)? + needle.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn xml_message(line: &str) -> Option<String> {
    if let Some(start) = line.find("<![CDATA[") {
        let rest = &line[start + 9..];
        let end = rest.find("]]>")?;
        return Some(rest[..end].to_string());
    }
    let start = line.find("<log4j:Message>")? + "<log4j:Message>".len();
    let rest = &line[start..];
    let end = rest.find("</log4j:Message>")?;
    Some(rest[..end].to_string())
}

/// Legacy versions print log4j XML events to stdout. Rebuild them into the
/// familiar `[thread/LEVEL]: message` shape so the console stays readable.
struct XmlLogEvent {
    thread: Option<String>,
    level: Option<String>,
    message: Option<String>,
}

impl XmlLogEvent {
    fn feed(&mut self, line: &str) -> Option<String> {
        let trimmed = line.trim_start();
        if trimmed.starts_with("<log4j:Event") {
            self.thread = xml_attribute(trimmed, "thread");
            self.level = xml_attribute(trimmed, "level");
            self.message = None;
            return None;
        }
        if self.thread.is_some() || self.level.is_some() {
            if let Some(message) = xml_message(trimmed) {
                self.message = Some(message);
                return None;
            }
            if trimmed.starts_with("</log4j:Event") {
                let thread = self.thread.take().unwrap_or_else(|| "main".to_string());
                let level = self.level.take().unwrap_or_else(|| "INFO".to_string());
                let message = self.message.take();
                return message.map(|message| format!("[{thread}/{level}]: {message}"));
            }
            // Suppress the remaining XML scaffolding.
            return None;
        }
        None
    }
}

const LAUNCH_LOG_TAIL: usize = 240;

/// Writes a launch log next to the game files and keeps a bounded tail for the
/// exit notification. JVM flag errors happen before Minecraft creates
/// `logs/latest.log`, so without this file a process that exits with code 1
/// leaves no trace at all.
struct LaunchLog {
    path: Option<PathBuf>,
    file: Mutex<Option<std::fs::File>>,
    tail: Mutex<std::collections::VecDeque<String>>,
}

impl LaunchLog {
    fn create(root: &std::path::Path, version_id: &str) -> Arc<Self> {
        let dir = root.join("logs").join("launcher");
        let _ = std::fs::create_dir_all(&dir);
        let safe_name: String = version_id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        let file_name = if safe_name.is_empty() {
            "unknown".to_string()
        } else {
            safe_name
        };
        let path = dir.join(format!("{file_name}.log"));
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .ok();
        let log = Arc::new(Self {
            path: file.as_ref().map(|_| path.clone()),
            file: Mutex::new(file),
            tail: Mutex::new(std::collections::VecDeque::new()),
        });
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0);
        log.write(
            "cobble",
            &format!("=== 启动 {version_id}（unix {stamp}） ==="),
        );
        log
    }

    fn write(&self, stream: &str, line: &str) {
        let clipped: String = line.chars().take(4000).collect();
        if let Ok(mut guard) = self.file.lock() {
            if let Some(file) = guard.as_mut() {
                let _ = writeln!(file, "[{stream}] {clipped}");
                // Flush every line: a JVM that aborts on an invalid flag exits
                // before any buffered writer would normally be dropped.
                let _ = file.flush();
            }
        }
        if let Ok(mut tail) = self.tail.lock() {
            tail.push_back(format!("[{stream}] {clipped}"));
            while tail.len() > LAUNCH_LOG_TAIL {
                tail.pop_front();
            }
        }
    }

    fn path_string(&self) -> Option<String> {
        self.path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
    }

    fn tail_for_error(&self, limit: usize) -> Option<String> {
        let tail = self.tail.lock().ok()?;
        let important: Vec<&String> = tail
            .iter()
            .filter(|line| {
                let lower = line.to_lowercase();
                lower.contains("error")
                    || lower.contains("exception")
                    || lower.contains("caused by")
                    || lower.contains("could not")
                    || lower.contains("failed")
                    || lower.contains("unsupported")
                    || lower.contains("错误")
                    || lower.contains("失败")
                    || line.starts_with("[stderr]")
            })
            .collect();
        let mut chosen: Vec<&str> = if important.is_empty() {
            tail.iter().rev().take(limit).map(String::as_str).collect()
        } else {
            important
                .iter()
                .rev()
                .take(limit)
                .map(|line| line.as_str())
                .collect()
        };
        chosen.reverse();
        if chosen.is_empty() {
            None
        } else {
            Some(chosen.join("\n"))
        }
    }

    fn diagnose_error(&self) -> Option<String> {
        let tail = self.tail.lock().ok()?;
        let all_text = tail.iter().cloned().collect::<Vec<_>>().join("\n");
        let lower = all_text.to_lowercase();

        let mut diagnosis = Vec::new();
        if lower.contains("conflicting collector combinations") || lower.contains("multiple garbage collectors selected") {
            diagnosis.push("【诊断提示】检测到 JVM 参数中配置了多个互斥的垃圾收集器导致 VM 冲突。启动器已提供智能参数仲裁，您也可以检查版本设置中的自定义 JVM 参数，移除多余的 -XX:+Use...GC 选项。".to_string());
        } else if lower.contains("incompatible minimum and maximum heap sizes") {
            diagnosis.push("【诊断提示】初始堆内存 (-Xms) 高于最大堆内存 (-Xmx) 导致 JVM 初始化冲突。启动器已开启自动纠错，建议检查自定义参数中是否存在手写的 -Xms 或 -Xmx。".to_string());
        } else if lower.contains("unrecognized vm option") || (lower.contains("could not create the java virtual machine") && lower.contains("vm option")) {
            diagnosis.push("【诊断提示】检测到不被当前 Java 版本支持的无效或废弃 VM 选项。建议检查版本设置中的自定义 JVM 参数，移除过时的优化选项。".to_string());
        } else if lower.contains("the specified size exceeds the maximum representable size")
            || (lower.contains("could not create the java virtual machine") && lower.contains("-xmx"))
        {
            diagnosis.push("【诊断提示】当前使用的是 32 位 Java 运行环境，无法分配大堆内存。建议在设置中切换为“自动检测”，启动器将为您自动下载官方 64 位 Java 运行时。".to_string());
        } else if lower.contains("could not reserve enough space") {
            diagnosis.push("【诊断提示】系统可用内存不足，无法预分配 JVM 内存。请关闭其他大型应用，或在版本设置中调小最大内存。".to_string());
        } else if lower.contains("unsupportedclassversionerror") || lower.contains("has been compiled by a more recent version") {
            diagnosis.push("【诊断提示】当前 Java 版本过低，无法运行此 Minecraft 版本。请在设置中选择更高版本的 Java（例如 Java 17 或 21）或切换为“自动检测”。".to_string());
        } else if lower.contains("pixel format not accelerated") || lower.contains("glfw error 65542") || lower.contains("wgl: the driver does not appear to support opengl") {
            diagnosis.push("【诊断提示】显卡驱动不支持 OpenGL 硬件加速或未安装显卡驱动。请更新显卡驱动程序。".to_string());
        } else if lower.contains("modresolutionexception") || lower.contains("missingmandatorydependenciesexception") || lower.contains("incompatiblemodsexception") {
            diagnosis.push("【诊断提示】检测到模组依赖缺失或冲突。请检查模组列表中提示缺失的前置 Mod，确保模组版本与当前游戏版本完全匹配。".to_string());
        }

        if diagnosis.is_empty() {
            None
        } else {
            Some(diagnosis.join("\n"))
        }
    }
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    stream: &'static str,
    reader: R,
    log: Arc<LaunchLog>,
    window: Option<WindowSignal>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut xml = XmlLogEvent {
            thread: None,
            level: None,
            message: None,
        };
        let mut raw = Vec::new();
        loop {
            raw.clear();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            if raw.last() == Some(&b'\n') {
                raw.pop();
            }
            if raw.last() == Some(&b'\r') {
                raw.pop();
            }
            // Decode lossily instead of `lines()`: Java on a non-UTF-8 Windows
            // console can emit GBK bytes, and `lines()` stops at the first
            // invalid one, silently cutting off the error that explains a
            // process that exited with code 1.
            let line = String::from_utf8_lossy(&raw).into_owned();
            let in_xml_event = xml.thread.is_some() || xml.level.is_some();
            let formatted = if in_xml_event || line.trim_start().starts_with("<log4j:Event") {
                xml.feed(&line)
            } else {
                Some(line)
            };
            if let Some(line) = formatted {
                let stream = if line.contains("/ERROR]") {
                    "stderr"
                } else {
                    stream
                };
                // 窗口出现的判定要先于 `line` 被移动进事件负载。
                if let Some(signal) = window.as_ref() {
                    if !signal.ready.load(Ordering::Relaxed) && line_shows_game_window(&line) {
                        announce_game_running(
                            &app,
                            signal,
                            format!("游戏已启动，Java {}", signal.java_major),
                        );
                    }
                }
                log.write(stream, &line);
                let _ = app.emit(
                    "game:log",
                    GameLogPayload {
                        stream: stream.to_string(),
                        line,
                    },
                );
            }
        }
    })
}

async fn launch_game(
    app: AppHandle,
    state: State<'_, GameState>,
    request: LaunchRequest,
) -> Result<u32, String> {
    // A signed-in account launches online: the session token is read from the
    // account store instead of travelling through the web UI. Downloading it
    // from the frontend would put a live credential in JavaScript.
    // Microsoft and LittleSkin keep separate slots; the UI tells the launch
    // which login method to use via `auth_provider`.
    let mut request = request;
    if request.auth.is_none() && !request.offline {
        if let Ok(dir) = account_dir(&app) {
            let want_littleskin = request.auth_provider.as_deref() == Some("littleskin");
            let record = if want_littleskin {
                auth::littleskin_session_for_launch(&dir).await
            } else {
                auth::session_for_launch(&dir).await
            };
            if let Some(record) = record {
                let external = record.is_external();
                let _ = app.emit(
                    "game:log",
                    GameLogPayload {
                        stream: "cobble".to_string(),
                        line: if external {
                            format!(
                                "使用 LittleSkin 外置登录启动：{}（UUID {}）",
                                record.profile.name, record.profile.id
                            )
                        } else {
                            format!(
                                "使用正版账户 {} 启动（UUID {}）",
                                record.profile.name, record.profile.id
                            )
                        },
                    },
                );
                if external {
                    // 没有 injector 就登不进外置登录服务器，宁可先修好再启动。
                    let injector = littleskin::ensure_injector(&dir).await.map_err(|error| {
                        format!("外置登录需要 authlib-injector，但准备失败: {error}")
                    })?;
                    request.authlib_injector = Some(injector.to_string_lossy().to_string());
                }
                request.auth = Some(minecraft::LaunchAuth {
                    access_token: record.minecraft.access_token.clone(),
                    uuid: record.profile.id.clone(),
                    name: record.profile.name.clone(),
                    xuid: Some(record.minecraft.xuid.clone()),
                    client_id: Some(record.client_id.clone()),
                    user_type: Some(if external { "mojang" } else { "msa" }.to_string()),
                    yggdrasil_api: record.yggdrasil_api.clone(),
                });
            }
        }
    }
    if state
        .child
        .lock()
        .map(|child| child.is_some())
        .unwrap_or(false)
    {
        return Err("游戏已经在运行".to_string());
    }

    // 一次新的启动从干净状态开始，否则上一次取消的标记会影响这一次。
    state.launch_cancelled.store(false, Ordering::Relaxed);

    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "preparing".to_string(),
            detail: Some("正在检查游戏文件与 Java".to_string()),
            pid: None,
            version_id: Some(request.version_id.clone()),
        },
    );

    // 准备阶段可能很慢（补文件、下 Java、跑加载器安装器），这里让它与
    // 「取消启动」赛跑：用户一取消就丢掉准备中的 Future，在途下载随之中断。
    let prepare = minecraft::prepare_launch(&request, emit_progress(&app));
    tokio::pin!(prepare);
    let spec: LaunchSpec = tokio::select! {
        result = &mut prepare => result.map_err(|error| {
            let _ = app.emit(
                "game:status",
                GameStatus {
                    state: "idle".to_string(),
                    detail: Some(error.clone()),
                    pid: None,
                    version_id: Some(request.version_id.clone()),
                },
            );
            error
        })?,
        _ = wait_launch_cancel(&state.launch_cancel, &state.launch_cancelled) => {
            let _ = app.emit(
                "game:status",
                GameStatus {
                    state: "idle".to_string(),
                    detail: Some(LAUNCH_CANCELLED.to_string()),
                    pid: None,
                    version_id: Some(request.version_id.clone()),
                },
            );
            return Err(LAUNCH_CANCELLED.to_string());
        }
    };

    // The language picked in the version settings is read from options.txt at
    // start-up, so it has to be on disk before the process is spawned.
    if let Some(code) = minecraft::apply_launch_language(&spec.cwd, request.language.as_deref()) {
        let _ = app.emit(
            "game:log",
            GameLogPayload {
                stream: "cobble".to_string(),
                line: format!("已设置游戏语言: {code}"),
            },
        );
    }

    let launch_log = LaunchLog::create(std::path::Path::new(&request.root), &request.version_id);
    launch_log.write(
        "cobble",
        &format!("Java {}：{}", spec.java_major, spec.java.display()),
    );
    launch_log.write("cobble", &format!("工作目录：{}", spec.cwd.display()));

    let java_install = crate::java::probe_java(&spec.java, "运行自检");
    let is_64bit = java_install.as_ref().map(|i| i.is_64bit).unwrap_or(true);
    if !is_64bit {
        let warn_msg = "[提示] 检测到当前 Java 为 32 位版本，启动器已自动将最大堆内存安全限制为 1024M 防止闪退；建议在设置中开启“自动检测”以下载 64 位 Java 运行时。";
        launch_log.write("cobble", warn_msg);
        let _ = app.emit(
            "game:log",
            GameLogPayload {
                stream: "cobble".to_string(),
                line: warn_msg.to_string(),
            },
        );
    }

    // 记录 JVM 参数仲裁与保护信息
    for note in &spec.notes {
        launch_log.write("cobble", &format!("[VM 保护] {note}"));
        let _ = app.emit(
            "game:log",
            GameLogPayload {
                stream: "cobble".to_string(),
                line: format!("[VM 保护] {note}"),
            },
        );
    }

    // 检查并隔离外部干扰环境变量（_JAVA_OPTIONS / JAVA_TOOL_OPTIONS）
    let has_java_opts_env = std::env::var("_JAVA_OPTIONS").is_ok()
        || std::env::var("JAVA_TOOL_OPTIONS").is_ok()
        || std::env::var("JAVA_OPTIONS").is_ok();
    if has_java_opts_env {
        let env_warn = "[安全保护] 检测到系统环境变量中存在 _JAVA_OPTIONS / JAVA_TOOL_OPTIONS，已在游戏进程中自动隔离清除，杜绝外部 VM 参数冲突与强制内存限制。";
        launch_log.write("cobble", env_warn);
        let _ = app.emit(
            "game:log",
            GameLogPayload {
                stream: "cobble".to_string(),
                line: env_warn.to_string(),
            },
        );
    }

    // 准备完成后、进程真正起来前再确认一次：用户可能刚好在这时点了取消。
    if state.launch_cancelled.load(Ordering::Relaxed) {
        let _ = app.emit(
            "game:status",
            GameStatus {
                state: "idle".to_string(),
                detail: Some(LAUNCH_CANCELLED.to_string()),
                pid: None,
                version_id: Some(request.version_id.clone()),
            },
        );
        return Err(LAUNCH_CANCELLED.to_string());
    }

    let mut command = Command::new(&spec.java);
    crate::java::clean_java_env(&mut command);
    command
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        let priority_flag = match request.process_priority.as_deref() {
            Some("realtime") => 0x0000_0100,
            Some("high") => 0x0000_0080,
            Some("above_normal") => 0x0000_8000,
            Some("below_normal") => 0x0000_4000,
            Some("low") => 0x0000_0040,
            Some("normal") => 0x0000_0020,
            _ => 0x0000_8000, // above_normal by default for maximized gaming CPU allocation
        };
        command.creation_flags(CREATE_NO_WINDOW | priority_flag);
    }

    let mut child = command.spawn().map_err(|error| {
        let message = format!("无法启动 Java ({}): {error}", spec.java.to_string_lossy());
        launch_log.write("cobble", &message);
        match launch_log.path_string() {
            Some(path) => format!("{message}。启动日志：{path}"),
            None => message,
        }
    })?;

    let pid = child.id();
    // 进程刚起来就发现被取消：立刻结束它，别让用户看到“取消了却还是进了游戏”。
    if state.launch_cancelled.load(Ordering::Relaxed) {
        let _ = child.kill();
        let _ = child.wait();
        launch_log.write("cobble", "启动已被取消，游戏进程已结束");
        let _ = app.emit(
            "game:status",
            GameStatus {
                state: "idle".to_string(),
                detail: Some(LAUNCH_CANCELLED.to_string()),
                pid: None,
                version_id: Some(request.version_id.clone()),
            },
        );
        return Err(LAUNCH_CANCELLED.to_string());
    }
    launch_log.write("cobble", &format!("已创建游戏进程，PID {pid}"));
    state.stopping.store(false, Ordering::Relaxed);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state
        .child
        .lock()
        .map_err(|_| "游戏进程状态不可用".to_string())? = Some(child);

    // 新一次启动：窗口还没出现。状态暂时留在「正在启动」，等日志里的窗口标记
    // （或超时兜底）才切到「运行中」，那时才会出现「停止运行」按钮。
    state.window_ready.store(false, Ordering::Relaxed);
    let window_signal = WindowSignal {
        ready: state.window_ready.clone(),
        pid,
        version_id: request.version_id.clone(),
        java_major: spec.java_major,
    };

    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        readers.push(spawn_log_reader(
            app.clone(),
            "stdout",
            stdout,
            launch_log.clone(),
            Some(window_signal.clone()),
        ));
    }
    if let Some(stderr) = stderr {
        readers.push(spawn_log_reader(
            app.clone(),
            "stderr",
            stderr,
            launch_log.clone(),
            Some(window_signal.clone()),
        ));
    }

    // 进程已起来但窗口还没出现：状态还在 preparing，先把详情文案换成看得懂的
    // 一句话，界面就会一直显示「取消启动」直到窗口真的弹出来。
    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "preparing".to_string(),
            detail: Some("游戏进程已启动，等待游戏窗口出现…".to_string()),
            pid: Some(pid),
            version_id: Some(request.version_id.clone()),
        },
    );
    let _ = app.emit(
        "game:log",
        GameLogPayload {
            stream: "cobble".to_string(),
            line: format!(
                "使用 Java {} 启动 Minecraft {}（PID {pid}），等待游戏窗口出现…",
                spec.java_major, request.version_id
            ),
        },
    );

    let child_slot = state.child.clone();
    let stopping = state.stopping.clone();
    let app_handle = app.clone();
    let version_id = request.version_id.clone();
    let mut readers = Some(readers);
    let watcher_log = launch_log.clone();
    let watcher_window = window_signal.clone();
    let window_started = Instant::now();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(400));
            let mut slot = match child_slot.lock() {
                Ok(slot) => slot,
                Err(_) => break,
            };
            let Some(child) = slot.as_mut() else {
                break;
            };
            match child.try_wait() {
                Ok(Some(status)) => {
                    *slot = None;
                    watcher_window.ready.store(false, Ordering::Relaxed);
                    drop(slot);
                    // Drain both pipes before reporting the exit; otherwise the
                    // toast can race ahead of the JVM's actual error message.
                    if let Some(handles) = readers.take() {
                        for handle in handles {
                            let _ = handle.join();
                        }
                    }
                    let requested_stop = stopping.swap(false, Ordering::Relaxed);
                    let code = if requested_stop {
                        Some(0)
                    } else {
                        status.code()
                    };
                    let detail = if code == Some(0) {
                        None
                    } else {
                        let error_lines = watcher_log.tail_for_error(12);
                        let diagnosis = watcher_log.diagnose_error();
                        match (diagnosis, error_lines) {
                            (Some(diag), Some(lines)) => {
                                Some(format!("{}\n\n原始日志摘要：\n{}", diag, lines))
                            }
                            (Some(diag), None) => Some(diag),
                            (None, Some(lines)) => Some(lines),
                            (None, None) => None,
                        }
                    };
                    let log_path = watcher_log.path_string();
                    let _ = app_handle.emit(
                        "game:exit",
                        GameExitPayload {
                            code,
                            version_id: Some(version_id.clone()),
                            log_path: log_path.clone(),
                            detail: detail.clone(),
                        },
                    );
                    let message = match code {
                        Some(0) => "游戏进程已结束".to_string(),
                        Some(code) => format!("游戏进程已退出（代码 {code}）"),
                        None => "游戏进程已结束".to_string(),
                    };
                    let message = match &log_path {
                        Some(path) => format!("{message}。启动日志：{path}"),
                        None => message,
                    };
                    watcher_log.write("cobble", &message);
                    let _ = app_handle.emit(
                        "game:log",
                        GameLogPayload {
                            stream: "cobble".to_string(),
                            line: message,
                        },
                    );
                    let _ = app_handle.emit(
                        "game:status",
                        GameStatus {
                            state: "idle".to_string(),
                            detail: None,
                            pid: None,
                            version_id: Some(version_id.clone()),
                        },
                    );
                    break;
                }
                Ok(None) => {
                    // 兜底：日志里始终没出现窗口标记（自定义日志配置、精简版
                    // JVM 等），也不能让按钮永远停在「取消启动」。
                    if window_started.elapsed() >= GAME_WINDOW_TIMEOUT {
                        announce_game_running(
                            &app_handle,
                            &watcher_window,
                            format!(
                                "未能检测到游戏窗口，按运行中处理（PID {}）",
                                watcher_window.pid
                            ),
                        );
                    }
                }
                Err(_) => break,
            }
        }
    });

    Ok(pid)
}

#[cfg(target_os = "windows")]
fn is_bedrock_process_running() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let check_exe = |name: &str| -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {name}"), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(out) = out {
            let s = String::from_utf8_lossy(&out.stdout).to_lowercase();
            s.contains(&name.to_lowercase())
        } else {
            false
        }
    };

    check_exe("Minecraft.Windows.exe")
        || check_exe("bedrock_server.exe")
        || check_exe("bedrock_server_mod.exe")
}

#[cfg(not(target_os = "windows"))]
fn is_bedrock_process_running() -> bool {
    for pattern in [
        "bedrock_server",
        "mcpelauncher-client",
        "mcpelauncher-ui",
        "MCPELauncher",
    ] {
        if let Ok(output) = std::process::Command::new("pgrep")
            .args(["-f", pattern])
            .output()
        {
            if output.status.success() && !output.stdout.is_empty() {
                return true;
            }
        }
    }
    false
}

fn stop_game(app: AppHandle, state: State<'_, GameState>) -> Result<(), String> {
    state.stopping.store(true, Ordering::Relaxed);
    state.bedrock_running.store(false, Ordering::Relaxed);
    state.window_ready.store(false, Ordering::Relaxed);

    let mut slot = state
        .child
        .lock()
        .map_err(|_| "游戏进程状态不可用".to_string())?;
    if let Some(child) = slot.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            let _ = child.kill();
        }
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "Minecraft.Windows.exe", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "bedrock_server.exe", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();

        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "bedrock_server_mod.exe", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }

    #[cfg(not(target_os = "windows"))]
    {
        for pattern in [
            "bedrock_server",
            "mcpelauncher-client",
            "mcpelauncher-ui",
            "MCPELauncher",
        ] {
            let _ = std::process::Command::new("pkill")
                .args(["-9", "-f", pattern])
                .output();
        }
    }

    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "idle".to_string(),
            detail: None,
            pid: None,
            version_id: None,
        },
    );
    let _ = app.emit(
        "game:exit",
        GameExitPayload {
            code: Some(0),
            version_id: None,
            log_path: None,
            detail: None,
        },
    );
    let _ = app.emit(
        "game:log",
        GameLogPayload {
            stream: "cobble".to_string(),
            line: "已向游戏进程发送强制终止指令并结束运行".to_string(),
        },
    );

    Ok(())
}

fn get_bedrock_status(
    app: AppHandle,
    root: Option<String>,
) -> Result<bedrock::BedrockStatus, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    Ok(bedrock::get_bedrock_status(&p))
}

async fn get_bedrock_versions(api_source: Option<String>) -> Vec<bedrock::BedrockVersionItem> {
    bedrock::get_bedrock_versions_async(api_source.as_deref()).await
}

async fn get_bedrock_content(category: Option<String>) -> Vec<bedrock::BedrockContentItem> {
    bedrock::get_bedrock_content_async(category.as_deref()).await
}

async fn install_bedrock_version(
    app: AppHandle,
    state: State<'_, InstallState>,
    version_id: String,
    download_url: Option<String>,
    root: Option<String>,
    api_source: Option<String>,
    threads: Option<usize>,
) -> Result<String, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };

    let target_label = format!("bedrock:{version_id}");
    {
        let mut running = state
            .running
            .lock()
            .map_err(|_| "安装状态不可用".to_string())?;
        if let Some(active) = running.as_ref() {
            return Err(format!("正在安装 {active}，请等待当前任务完成"));
        }
        *running = Some(target_label);
    }

    let app_handle = app.clone();
    let ver_id = version_id.clone();
    let url = download_url.unwrap_or_default();
    let th = threads.unwrap_or(8);

    let task = tokio::spawn(async move {
        bedrock::install_bedrock_version(&app_handle, &p, &ver_id, &url, api_source.as_deref(), th)
            .await
    });

    if let Ok(mut guard) = state.abort_handle.lock() {
        *guard = Some(task.abort_handle());
    }

    let join_res = task.await;

    if let Ok(mut running) = state.running.lock() {
        *running = None;
    }
    if let Ok(mut guard) = state.abort_handle.lock() {
        *guard = None;
    }

    match join_res {
        Ok(res) => res,
        Err(e) if e.is_cancelled() => Err("下载任务已被用户取消或暂停".to_string()),
        Err(e) => Err(format!("基岩版安装任务执行异常: {e}")),
    }
}

async fn cancel_install(app: AppHandle, state: State<'_, InstallState>) -> Result<bool, String> {
    let mut aborted = false;
    if let Ok(mut guard) = state.abort_handle.lock() {
        if let Some(handle) = guard.take() {
            handle.abort();
            aborted = true;
        }
    }
    let version_name = if let Ok(mut running) = state.running.lock() {
        running.take()
    } else {
        None
    };

    if let Some(name) = version_name {
        let _ = app.emit(
            "install:progress",
            minecraft::InstallProgress {
                version_id: name,
                stage: "cancelled".to_string(),
                done: 0,
                total: 1,
                detail: "下载已取消/已暂停".to_string(),
                downloaded_bytes: 0,
                total_bytes: 0,
                speed_bps: 0,
                threads: 0,
                active_threads: 0,
                skipped_files: 0,
                retried_files: 0,
                active_tasks: vec![],
                stages: vec![],
                file_logs: vec![],
            },
        );
    }

    Ok(aborted)
}

/// 取消「正在启动…」：唤醒启动流程，并中止启动前那次自动补文件的下载任务。
async fn cancel_launch(
    app: AppHandle,
    state: State<'_, GameState>,
    install: State<'_, InstallState>,
) -> Result<bool, String> {
    // 窗口已经出现（界面已经切成「停止运行」）就不算取消启动了，否则会把
    // 正在运行的游戏状态错误地标成 idle。进程起来了但窗口还没出现仍算启动中：
    // 那时按钮就是「取消启动」，用户应当能直接结束它。
    let process_running = state
        .child
        .lock()
        .map(|mut child| {
            child.as_mut().is_some_and(|process| {
                matches!(process.try_wait(), Ok(None))
            })
        })
        .unwrap_or(false);
    if process_running && state.window_ready.load(Ordering::Relaxed) {
        return Err("游戏已经开始运行，请用「停止运行」结束它".to_string());
    }

    state.launch_cancelled.store(true, Ordering::Relaxed);
    state.launch_cancel.notify_one();

    // 启动前的「自动补全缺失文件」就是一次安装任务，一起中止。
    let aborted_install = cancel_install(app.clone(), install).await.unwrap_or(false);

    if process_running {
        // 进程已在跑但游戏窗口还没出现：直接结束它，不然用户只能干等它开花。
        state.stopping.store(true, Ordering::Relaxed);
        if let Ok(mut slot) = state.child.lock() {
            if let Some(child) = slot.as_mut() {
                let _ = child.kill();
            }
        }
        let _ = app.emit(
            "game:log",
            GameLogPayload {
                stream: "cobble".to_string(),
                line: "取消启动：已结束尚未显示窗口的游戏进程".to_string(),
            },
        );
    }

    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "idle".to_string(),
            detail: Some(LAUNCH_CANCELLED.to_string()),
            pid: None,
            version_id: None,
        },
    );
    let _ = app.emit(
        "game:log",
        GameLogPayload {
            stream: "cobble".to_string(),
            line: "用户取消了本次启动".to_string(),
        },
    );

    Ok(aborted_install)
}

async fn install_bedrock_pack(
    app: AppHandle,
    source: String,
    filename: Option<String>,
    root: Option<String>,
) -> Result<bedrock::InstallPackResult, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };

    let final_filename = filename.unwrap_or_else(|| {
        PathBuf::from(&source)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "pack.mcpack".to_string())
    });

    bedrock::install_bedrock_pack(&p, &source, &final_filename, None).await
}

fn launch_bedrock(
    app: AppHandle,
    state: State<'_, GameState>,
    version_id: Option<String>,
    root: Option<String>,
    offline_account: Option<bool>,
    player_name: Option<String>,
) -> Result<String, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };

    let account = account_dir(&app)
        .ok()
        .and_then(|dir| auth::load_account(&dir));
    let is_offline = offline_account.unwrap_or(account.is_none());

    // Synchronize username into Bedrock options.txt (mp_username)
    let sync_name = if !is_offline {
        account
            .as_ref()
            .map(|r| r.profile.name.as_str())
            .or(player_name.as_deref())
    } else {
        player_name.as_deref()
    };
    if let Some(name) = sync_name {
        bedrock::sync_bedrock_username(&p, name);
    }

    if let Some(record) = account.as_ref() {
        if !is_offline {
            let _ = app.emit(
                "game:log",
                GameLogPayload {
                    stream: "cobble".to_string(),
                    line: format!(
                        "使用正版账户 {} 启动基岩版（{}）",
                        record.profile.name,
                        bedrock_entitlement_note(&record.entitlements)
                    ),
                },
            );
        }
    }

    let message =
        bedrock::launch_bedrock_edition(&p, version_id.as_deref(), Some(&app), is_offline)?;

    // Mark bedrock as running
    state.stopping.store(false, Ordering::Relaxed);
    state.bedrock_running.store(true, Ordering::Relaxed);

    let vid = version_id
        .clone()
        .unwrap_or_else(|| "bedrock-uwp".to_string());

    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "running".to_string(),
            detail: Some("Minecraft 基岩版正在运行".to_string()),
            pid: None,
            version_id: Some(vid.clone()),
        },
    );

    let app_handle = app.clone();
    let bedrock_running_flag = state.bedrock_running.clone();
    let stopping_flag = state.stopping.clone();
    let target_vid = vid.clone();

    std::thread::spawn(move || {
        // Wait 3.5s for process to initialize before polling
        std::thread::sleep(Duration::from_millis(3500));
        while bedrock_running_flag.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(1000));
            if !bedrock_running_flag.load(Ordering::Relaxed) {
                break;
            }
            if !is_bedrock_process_running() {
                bedrock_running_flag.store(false, Ordering::Relaxed);
                let requested_stop = stopping_flag.swap(false, Ordering::Relaxed);
                let code = if requested_stop { Some(0) } else { None };

                let _ = app_handle.emit(
                    "game:exit",
                    GameExitPayload {
                        code,
                        version_id: Some(target_vid.clone()),
                        log_path: None,
                        detail: None,
                    },
                );
                let _ = app_handle.emit(
                    "game:log",
                    GameLogPayload {
                        stream: "cobble".to_string(),
                        line: "Minecraft 基岩版游戏进程已结束".to_string(),
                    },
                );
                let _ = app_handle.emit(
                    "game:status",
                    GameStatus {
                        state: "idle".to_string(),
                        detail: None,
                        pid: None,
                        version_id: Some(target_vid.clone()),
                    },
                );
                break;
            }
        }
    });

    Ok(if !is_offline {
        match account.as_ref() {
            Some(record) => format!(
                "{message} · 账户 {}：{}",
                record.profile.name,
                bedrock_entitlement_note(&record.entitlements)
            ),
            None => message,
        }
    } else {
        message
    })
}

/// What the shared Microsoft account means for a Bedrock start-up. The Windows
/// client signs in on its own, so this only states whether the account owns the
/// edition and what to do when it does not.
fn bedrock_entitlement_note(entitlements: &auth::Entitlements) -> &'static str {
    if entitlements.bedrock {
        "该账户已拥有基岩版"
    } else if entitlements.game_pass {
        "Game Pass 有效期内可游玩基岩版"
    } else {
        "该账户暂无基岩版授权，需要在 Windows 商店登录同一账户"
    }
}

fn get_bedrock_runtime_status(force: Option<bool>) -> bedrock::BedrockRuntimeStatus {
    bedrock::get_bedrock_runtime_status(force.unwrap_or(false))
}

fn auto_provision_bedrock_runtime(app: AppHandle) -> bedrock::BedrockRuntimeStatus {
    bedrock::provision_bedrock_runtime(Some(&app))
}

fn check_bedrockboot_dependencies(force: Option<bool>) -> bedrock::BedrockFullDependencyReport {
    bedrock::check_bedrockboot_dependencies(force.unwrap_or(false))
}

fn auto_fix_bedrockboot_dependencies(app: AppHandle) -> bedrock::BedrockFullDependencyReport {
    bedrock::auto_fix_bedrockboot_dependencies(Some(&app))
}

fn enable_bedrock_developer_mode() -> Result<(), String> {
    bedrock::enable_developer_mode()
}

async fn auto_install_bds_fallback(
    app: AppHandle,
    version_id: String,
    root: Option<String>,
) -> Result<String, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::find_or_install_bds_fallback(&app, &p, &version_id).await
}

fn open_folder(_app: AppHandle, path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录路径为空".to_string());
    }

    let target = PathBuf::from(trimmed);
    let dir = if target.exists() {
        if target.is_file() {
            target
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| target.clone())
        } else {
            target
        }
    } else {
        std::fs::create_dir_all(&target)
            .map_err(|e| format!("无法创建目录 {}: {e}", target.display()))?;
        target
    };

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("无法通过资源管理器打开目录: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("无法通过 Finder 打开目录: {e}"))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("无法打开目录: {e}"))?;
        return Ok(());
    }
}

/// Open an http(s) link in the user's default browser.
///
/// The frontend only ever passes project pages it built itself (Modrinth,
/// CurseForge, MC 百科), so the scheme check is a guard against a malformed
/// or malicious value rather than a general-purpose URL allowlist.
/// Look up the MC 百科 page of a Java project.
///
/// Returns `None` when the search page has no entry whose English name matches
/// the project, so the UI can fall back to the search URL instead of opening an
/// unrelated mod page.
async fn resolve_mcmod_entry(
    title: String,
    slug: String,
    project_type: String,
) -> Result<Option<mcmod::WikiEntry>, String> {
    Ok(mcmod::find_entry(&title, &slug, &project_type).await)
}

fn open_url(_app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("链接为空".to_string());
    }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("仅支持打开 http/https 链接".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .spawn()
            .map_err(|e| format!("无法打开浏览器: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("无法打开浏览器: {e}"))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("无法打开浏览器: {e}"))?;
        return Ok(());
    }
}

async fn delete_version(
    app: AppHandle,
    version_id: String,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::delete_version(&p, &version_id).await
}

async fn delete_bedrock_version(
    app: AppHandle,
    version_id: String,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::delete_bedrock_version(&p, &version_id).await
}

async fn clean_download_cache(app: AppHandle, root: Option<String>) -> Result<u64, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::clean_download_cache(&p).await
}

async fn get_bedrock_loaders(mc_version: String) -> Result<bedrock::BedrockLoadersCatalog, String> {
    Ok(bedrock::fetch_bedrock_loaders(&mc_version).await)
}

async fn install_bedrock_loader(
    app: AppHandle,
    version_id: String,
    loader_type: String,
    loader_version: String,
    root: Option<String>,
) -> Result<String, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::install_bedrock_loader(&p, &version_id, &loader_type, &loader_version).await
}

fn get_bedrock_mods(
    app: AppHandle,
    version_id: String,
    root: Option<String>,
) -> Result<Vec<bedrock::BedrockModItem>, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::get_bedrock_mods(&p, &version_id)
}

fn toggle_bedrock_mod(
    app: AppHandle,
    version_id: String,
    mod_id: String,
    enabled: bool,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::toggle_bedrock_mod(&p, &version_id, &mod_id, enabled)
}

fn delete_bedrock_mod(
    app: AppHandle,
    version_id: String,
    mod_id: String,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::delete_bedrock_mod(&p, &version_id, &mod_id)
}

fn install_bedrock_mod_file(
    app: AppHandle,
    version_id: String,
    file_path: String,
    root: Option<String>,
) -> Result<String, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::install_bedrock_mod_file(&p, &version_id, &file_path)
}

fn get_bedrock_packs(
    app: AppHandle,
    root: Option<String>,
) -> Result<Vec<bedrock::BedrockPackItem>, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    Ok(bedrock::get_bedrock_packs(&p))
}

fn set_bedrock_pack_enabled(
    app: AppHandle,
    path: String,
    enabled: bool,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::set_bedrock_pack_enabled(&p, &path, enabled)
}

fn delete_bedrock_pack(app: AppHandle, path: String, root: Option<String>) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::delete_bedrock_pack(&p, &path)
}

fn import_bedrock_pack_file(
    app: AppHandle,
    file_path: String,
    root: Option<String>,
) -> Result<bedrock::InstallPackResult, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::install_bedrock_pack_from_file(&p, &file_path)
}

fn get_java_mods(
    app: AppHandle,
    version_id: String,
    root: Option<String>,
) -> Result<Vec<minecraft::JavaModItem>, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::get_java_mods(&p, &version_id)
}

fn toggle_java_mod(
    app: AppHandle,
    version_id: String,
    file_name: String,
    enabled: bool,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::toggle_java_mod(&p, &version_id, &file_name, enabled)
}

fn delete_java_mod(
    app: AppHandle,
    version_id: String,
    file_name: String,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::delete_java_mod(&p, &version_id, &file_name)
}

fn install_java_mod_file(
    app: AppHandle,
    version_id: String,
    file_path: String,
    root: Option<String>,
) -> Result<String, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::install_java_mod_file(&p, &version_id, std::path::Path::new(&file_path))
}

fn get_java_resource_packs(
    app: AppHandle,
    version_id: String,
    isolation: Option<String>,
    root: Option<String>,
) -> Result<Vec<minecraft::JavaPackItem>, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    Ok(minecraft::get_java_resource_packs(
        &p,
        &version_id,
        isolation.as_deref(),
    ))
}

fn toggle_java_resource_pack(
    app: AppHandle,
    version_id: String,
    file_name: String,
    enabled: bool,
    isolation: Option<String>,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::toggle_java_resource_pack(&p, &version_id, &file_name, enabled, isolation.as_deref())
}

fn delete_java_resource_pack(
    app: AppHandle,
    version_id: String,
    file_name: String,
    isolation: Option<String>,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::delete_java_resource_pack(&p, &version_id, &file_name, isolation.as_deref())
}

fn install_java_resource_pack_file(
    app: AppHandle,
    version_id: String,
    file_path: String,
    isolation: Option<String>,
    root: Option<String>,
) -> Result<String, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::install_java_resource_pack_file(&p, &version_id, &file_path, isolation.as_deref())
}

fn get_java_worlds(
    app: AppHandle,
    version_id: String,
    isolation: Option<String>,
    root: Option<String>,
) -> Result<Vec<minecraft::JavaWorldItem>, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    Ok(minecraft::get_java_worlds(
        &p,
        &version_id,
        isolation.as_deref(),
    ))
}

fn delete_java_world(
    app: AppHandle,
    version_id: String,
    folder: String,
    isolation: Option<String>,
    root: Option<String>,
) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::delete_java_world(&p, &version_id, &folder, isolation.as_deref())
}

fn install_java_world_file(
    app: AppHandle,
    version_id: String,
    file_path: String,
    isolation: Option<String>,
    root: Option<String>,
) -> Result<String, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    minecraft::install_java_world_file(&p, &version_id, &file_path, isolation.as_deref())
}

fn get_bedrock_worlds(
    app: AppHandle,
    root: Option<String>,
) -> Result<Vec<bedrock::BedrockWorldItem>, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    Ok(bedrock::get_bedrock_worlds(&p))
}

fn delete_bedrock_world(app: AppHandle, path: String, root: Option<String>) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::delete_bedrock_world(&p, &path)
}

fn import_bedrock_world_file(
    app: AppHandle,
    file_path: String,
    root: Option<String>,
) -> Result<bedrock::InstallPackResult, String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::import_bedrock_world_file(&p, &file_path)
}

/// Signed-in Microsoft account data lives with the launcher, not inside a game
/// root, so changing roots does not sign the user out.
fn account_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|error| format!("无法定位启动器数据目录: {error}"))
}

async fn ms_login_begin(client_id: Option<String>) -> Result<auth::DeviceCodeInfo, String> {
    auth::begin_device_login(client_id.as_deref()).await
}

async fn ms_login_poll(
    app: AppHandle,
    device_code: String,
    client_id: Option<String>,
) -> Result<auth::AccountPoll, String> {
    let dir = account_dir(&app)?;
    match auth::poll_device_login(client_id.as_deref(), &device_code).await? {
        auth::DeviceOutcome::Pending => Ok(auth::AccountPoll::pending()),
        auth::DeviceOutcome::SlowDown => Ok(auth::AccountPoll::slow_down()),
        auth::DeviceOutcome::Done(record) => {
            auth::store_account(&dir, &record)?;
            Ok(auth::AccountPoll::success(&record))
        }
    }
}

async fn get_ms_account(
    app: AppHandle,
    client_id: Option<String>,
) -> Result<Option<auth::AccountView>, String> {
    let dir = account_dir(&app)?;
    // 只读微软自己的槽位；LittleSkin 有独立的槽位和命令。
    Ok(auth::account_view(&dir, client_id.as_deref()).await)
}

async fn get_littleskin_account(
    app: AppHandle,
) -> Result<Option<littleskin::LittleSkinView>, String> {
    let dir = account_dir(&app)?;
    Ok(auth::littleskin_account_view(&dir).await)
}

// ---------------------------------------------------------------------------
// LittleSkin（外置登录）
// ---------------------------------------------------------------------------

async fn littleskin_login_begin(client_id: String) -> Result<auth::DeviceCodeInfo, String> {
    littleskin::begin_device_login(&client_id).await
}

async fn littleskin_login_poll(
    app: AppHandle,
    device_code: String,
    client_id: String,
) -> Result<littleskin::LoginPoll, String> {
    let dir = account_dir(&app)?;
    let outcome = littleskin::poll_device_login(&client_id, &device_code).await?;
    if let littleskin::LoginOutcome::Done(record) = &outcome {
        auth::store_littleskin_account(&dir, record)?;
    }
    Ok(outcome.into_poll())
}

fn littleskin_cancel_login(pending_id: String) {
    littleskin::cancel_pending(&pending_id);
}

async fn littleskin_select_profile(
    app: AppHandle,
    pending_id: String,
    uuid: String,
) -> Result<littleskin::LoginPoll, String> {
    let dir = account_dir(&app)?;
    let record = littleskin::select_profile(&pending_id, &uuid).await?;
    auth::store_littleskin_account(&dir, &record)?;
    Ok(littleskin::LoginPoll::success(&record))
}

async fn ms_sign_out(app: AppHandle) -> Result<(), String> {
    let dir = account_dir(&app)?;
    auth::clear_account(&dir)
}

async fn littleskin_sign_out(app: AppHandle) -> Result<(), String> {
    let dir = account_dir(&app)?;
    auth::clear_littleskin_account(&dir)
}

pub async fn list_extensions(
    app: AppHandle,
    root: Option<String>,
) -> Result<Vec<extension::ExtensionItem>, String> {
    extension::list_extensions(&app, root.as_deref())
}

pub async fn install_extension_zip(
    app: AppHandle,
    zip_path: String,
    root: Option<String>,
) -> Result<extension::ExtensionItem, String> {
    extension::install_extension_zip(&app, &zip_path, root.as_deref())
}

pub async fn install_extension_dir(
    app: AppHandle,
    dir_path: String,
    root: Option<String>,
) -> Result<extension::ExtensionItem, String> {
    extension::install_extension_dir(&app, &dir_path, root.as_deref())
}

pub async fn toggle_extension(
    app: AppHandle,
    id: String,
    enabled: bool,
    root: Option<String>,
) -> Result<(), String> {
    extension::toggle_extension(&app, &id, enabled, root.as_deref())
}

pub async fn uninstall_extension(
    app: AppHandle,
    id: String,
    root: Option<String>,
) -> Result<(), String> {
    extension::uninstall_extension(&app, &id, root.as_deref())
}

pub async fn export_extension_zip(
    app: AppHandle,
    id: String,
    target_path: String,
    root: Option<String>,
) -> Result<String, String> {
    extension::export_extension_zip(&app, &id, &target_path, root.as_deref())
}

pub async fn create_sample_extension(
    app: AppHandle,
    target_dir: Option<String>,
    root: Option<String>,
) -> Result<String, String> {
    extension::create_sample_extension(&app, target_dir.as_deref(), root.as_deref())
}

pub async fn execute_extension_rust(
    app: AppHandle,
    id: String,
    fn_name: String,
    payload: serde_json::Value,
    root: Option<String>,
) -> Result<serde_json::Value, String> {
    extension::execute_extension_rust(&app, &id, &fn_name, payload, root.as_deref())
}
