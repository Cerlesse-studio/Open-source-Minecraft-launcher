pub mod auth;
pub mod bedrock;
pub mod bedrock_store;
pub mod bridge;
pub mod content;
pub mod download;
pub mod extension;
pub mod java;
pub mod littleskin;
pub mod loaders;
pub mod mcmod;
pub mod minecraft;
pub mod multiplayer;
mod net;
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
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 进程启动后，Java 可能还在加载资源，窗口尚未出现。这里按 PID 枚举
/// Windows 顶层窗口，只有同时满足可见、有标题、无 owner 的窗口才算是
/// 游戏窗口；这样启动页就能在窗口出现前显示“取消启动”，而不是“停止游戏”。
#[cfg(windows)]
mod game_window_probe {
    use std::ffi::c_void;

    type Hwnd = *mut c_void;
    type Bool = i32;
    type Dword = u32;

    const GW_OWNER: u32 = 4;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn EnumWindows(
            callback: Option<unsafe extern "system" fn(Hwnd, isize) -> Bool>,
            l_param: isize,
        ) -> Bool;
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut Dword) -> Dword;
        fn IsWindowVisible(window: Hwnd) -> Bool;
        fn GetWindowTextLengthW(window: Hwnd) -> i32;
        fn GetWindow(window: Hwnd, command: u32) -> Hwnd;
    }

    unsafe extern "system" fn find_game_window(window: Hwnd, l_param: isize) -> Bool {
        let state = unsafe { &mut *(l_param as *mut (u32, bool)) };
        let mut window_pid: Dword = 0;
        unsafe {
            GetWindowThreadProcessId(window, &mut window_pid);
        }
        if window_pid == state.0
            && unsafe { IsWindowVisible(window) } != 0
            && unsafe { GetWindow(window, GW_OWNER) }.is_null()
            && unsafe { GetWindowTextLengthW(window) } > 0
        {
            state.1 = true;
            return 0;
        }
        1
    }

    pub fn visible(pid: u32) -> bool {
        let mut state = (pid, false);
        unsafe {
            EnumWindows(Some(find_game_window), &mut state as *mut _ as isize);
        }
        state.1
    }
}

#[cfg(windows)]
fn game_window_visible(pid: u32) -> bool {
    game_window_probe::visible(pid)
}

#[cfg(not(windows))]
fn game_window_visible(_pid: u32) -> bool {
    false
}

#[derive(Default)]
pub struct InstallState {
    running: Mutex<Option<String>>,
    abort_handle: Mutex<Option<tokio::task::AbortHandle>>,
}

pub struct GameState {
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
    bedrock_running: Arc<AtomicBool>,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
            bedrock_running: Arc::new(AtomicBool::new(false)),
        }
    }
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
    /// 游戏是否已经创建可见窗口。进程刚启动时为 false，窗口出现后变为 true。
    window_visible: bool,
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
    download::set_download_preference(
        &source,
        custom_url.as_deref().unwrap_or(""),
        threads.map(|value| value as usize),
    );
}

/// PCL2 `NetTaskSpeedLimitHigh`. `null` / `0` means unlimited.
fn set_download_speed_limit(bytes_per_second: Option<u64>) {
    download::set_speed_limit(bytes_per_second.unwrap_or(0));
}

/// PCL2 `NetManagerClass` state, exposed for the download progress view.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadStats {
    pub speed_limit_bps: Option<u64>,
    pub active_threads: u32,
    pub thread_limit: u32,
    pub speed_limit_low_bps: u64,
    /// 引擎任务注册表中的活跃下载（PCL2 `NetFile` 状态机视图，阶段 4 激活）。
    pub active_tasks: Vec<download::LoaderTaskView>,
}

fn get_download_stats() -> DownloadStats {
    DownloadStats {
        speed_limit_bps: download::speed_limit(),
        active_threads: download::active_threads(),
        thread_limit: download::thread_limit(),
        speed_limit_low_bps: download::NET_TASK_SPEED_LIMIT_LOW,
        active_tasks: download::active_task_views(),
    }
}

async fn probe_download_sources(custom_url: Option<String>) -> Vec<download::DownloadSourceProbe> {
    download::probe_download_sources(custom_url.as_deref()).await
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

async fn query_version_catalog(
    root: String,
    query: Option<String>,
    betacraft_phase: Option<String>,
    legacy_source: Option<String>,
) -> Result<minecraft::VersionCatalogResult, String> {
    let root = if root.trim().is_empty() {
        default_root_path()
    } else {
        PathBuf::from(root)
    };
    Ok(minecraft::query_version_catalog(
        &root,
        query.as_deref().unwrap_or(""),
        betacraft_phase.as_deref().unwrap_or("all"),
        legacy_source.as_deref().unwrap_or("all"),
    )
    .await)
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
    let response = net::client()
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
    use super::image_mime_from_bytes;

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

async fn download_content_file(
    app: AppHandle,
    request: content::DownloadContentRequest,
) -> Result<content::DownloadContentResult, String> {
    content::download_content_file(Some(&app), request).await
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
    window_ready: Option<Arc<AtomicBool>>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut xml = XmlLogEvent {
            thread: None,
            level: None,
            message: None,
        };
        let mut raw = Vec::new();
        let mut window_start = std::time::Instant::now();
        let mut emitted_in_window = 0usize;
        let mut suppressed_in_window = 0usize;
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
                if let Some(window_ready) = window_ready.as_ref() {
                    // 原生窗口检测在部分环境（无 Windows API、窗口标题为空）
                    // 不可用；渲染线程启动日志是跨平台的补充信号。
                    if line.contains("[Render thread/") || line.contains("LWJGL version") {
                        window_ready.store(true, Ordering::Relaxed);
                    }
                }
                let out_stream = if line.contains("/ERROR]") {
                    "stderr"
                } else {
                    stream
                };
                log.write(out_stream, &line);

                let now = std::time::Instant::now();
                if now.duration_since(window_start) >= Duration::from_millis(16) {
                    if suppressed_in_window > 0 {
                        let _ = app.emit(
                            "game:log",
                            GameLogPayload {
                                stream: "cobble".to_string(),
                                line: format!(
                                    "… [高频输出保护：已折叠 {suppressed_in_window} 行日志，完整日志已写入日志文件]"
                                ),
                            },
                        );
                        suppressed_in_window = 0;
                    }
                    window_start = now;
                    emitted_in_window = 0;
                }

                let is_important = out_stream == "stderr"
                    || line.contains("Exception")
                    || line.contains("Error")
                    || line.contains("WARN");
                if is_important || emitted_in_window < 48 {
                    emitted_in_window += 1;
                    let _ = app.emit(
                        "game:log",
                        GameLogPayload {
                            stream: out_stream.to_string(),
                            line,
                        },
                    );
                } else {
                    suppressed_in_window += 1;
                }
            }
        }
        if suppressed_in_window > 0 {
            let _ = app.emit(
                "game:log",
                GameLogPayload {
                    stream: "cobble".to_string(),
                    line: format!(
                        "… [高频输出保护：已折叠 {suppressed_in_window} 行日志，完整日志已写入日志文件]"
                    ),
                },
            );
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

    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "preparing".to_string(),
            detail: Some("正在检查游戏文件与 Java".to_string()),
            pid: None,
            version_id: Some(request.version_id.clone()),
            window_visible: false,
        },
    );

    let spec: LaunchSpec = minecraft::prepare_launch(&request, emit_progress(&app))
        .await
        .map_err(|error| {
            let _ = app.emit(
                "game:status",
                GameStatus {
                    state: "idle".to_string(),
                    detail: Some(error.clone()),
                    pid: None,
                    version_id: Some(request.version_id.clone()),
                    window_visible: false,
                },
            );
            error
        })?;

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
    launch_log.write("cobble", &format!("已创建游戏进程，PID {pid}"));
    state.stopping.store(false, Ordering::Relaxed);
    let window_ready = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state
        .child
        .lock()
        .map_err(|_| "游戏进程状态不可用".to_string())? = Some(child);

    let mut readers = Vec::new();
    if let Some(stdout) = stdout {
        readers.push(spawn_log_reader(
            app.clone(),
            "stdout",
            stdout,
            launch_log.clone(),
            Some(window_ready.clone()),
        ));
    }
    if let Some(stderr) = stderr {
        readers.push(spawn_log_reader(
            app.clone(),
            "stderr",
            stderr,
            launch_log.clone(),
            Some(window_ready.clone()),
        ));
    }

    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "running".to_string(),
            detail: Some("游戏进程已启动，正在等待游戏窗口…".to_string()),
            pid: Some(pid),
            version_id: Some(request.version_id.clone()),
            window_visible: false,
        },
    );
    let _ = app.emit(
        "game:log",
        GameLogPayload {
            stream: "cobble".to_string(),
            line: format!(
                "使用 Java {} 启动 Minecraft {}（PID {pid}）",
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
                            window_visible: false,
                        },
                    );
                    break;
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });

    // 进程已启动但窗口可能还没出现。轮询窗口状态，出现后单独发一条
    // running，前端据此把“取消启动”切换成“停止游戏”。
    let window_app = app.clone();
    let window_stopping = state.stopping.clone();
    let window_child_slot = state.child.clone();
    let window_flag = window_ready.clone();
    let window_version = request.version_id.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        loop {
            if window_stopping.load(Ordering::Relaxed) {
                return;
            }
            let alive = window_child_slot
                .lock()
                .map(|child| child.is_some())
                .unwrap_or(false);
            if !alive {
                return;
            }
            if window_flag.load(Ordering::Relaxed) || game_window_visible(pid) {
                // stop_game 会先置 stopping 再发 idle；重新确认一次，避免窗口恰好
                // 出现时把刚取消的启动又推回 running。
                let still_alive = window_child_slot
                    .lock()
                    .map(|child| child.is_some())
                    .unwrap_or(false);
                if window_stopping.load(Ordering::Relaxed) || !still_alive {
                    return;
                }
                let _ = window_app.emit(
                    "game:status",
                    GameStatus {
                        state: "running".to_string(),
                        detail: Some("游戏窗口已出现".to_string()),
                        pid: Some(pid),
                        version_id: Some(window_version.clone()),
                        window_visible: true,
                    },
                );
                return;
            }
            if started.elapsed() >= Duration::from_secs(60) {
                let still_alive = window_child_slot
                    .lock()
                    .map(|child| child.is_some())
                    .unwrap_or(false);
                if window_stopping.load(Ordering::Relaxed) || !still_alive {
                    return;
                }
                let _ = window_app.emit(
                    "game:status",
                    GameStatus {
                        state: "running".to_string(),
                        detail: Some("未能确认游戏窗口，但游戏进程仍在运行".to_string()),
                        pid: Some(pid),
                        version_id: Some(window_version.clone()),
                        window_visible: true,
                    },
                );
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
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
            window_visible: false,
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
            window_visible: true,
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
                        window_visible: false,
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
