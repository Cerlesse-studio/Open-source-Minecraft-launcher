pub mod auth;
pub mod bedrock;
pub mod bedrock_store;
pub mod content;
pub mod java;
pub mod loaders;
pub mod mcmod;
pub mod minecraft;
pub mod multiplayer;
mod net;
pub mod platform;
pub mod search_i18n;

use minecraft::{
    InstallProgress, InstallResult, InstalledVersion, LaunchRequest, LaunchSpec, ProgressFn,
    VersionManifest,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Default)]
pub struct InstallState {
    running: Mutex<Option<String>>,
    abort_handle: Mutex<Option<tokio::task::AbortHandle>>,
}

pub struct GameState {
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
}

impl Default for GameState {
    fn default() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
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
}

fn emit_progress(app: &AppHandle) -> ProgressFn {
    let app = app.clone();
    Arc::new(move |progress: InstallProgress| {
        let _ = app.emit("install:progress", progress);
    })
}

fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("无法获取用户目录: {e}"))?;
    let root = home.join(".cobble");
    let _ = std::fs::create_dir_all(&root);
    Ok(root)
}

#[tauri::command]
fn set_download_preference(source: String, custom_url: Option<String>, threads: Option<u32>) {
    net::set_download_preference(
        &source,
        custom_url.as_deref().unwrap_or(""),
        threads.map(|value| value as usize),
    );
}

#[tauri::command]
async fn probe_download_sources(custom_url: Option<String>) -> Vec<net::DownloadSourceProbe> {
    net::probe_download_sources(custom_url.as_deref()).await
}

#[tauri::command]
async fn get_version_manifest(
    root: String,
    force: Option<bool>,
) -> Result<VersionManifest, String> {
    let root = if root.trim().is_empty() {
        PathBuf::from(".cobble")
    } else {
        PathBuf::from(root)
    };
    minecraft::fetch_manifest(&root, force.unwrap_or(false)).await
}

#[tauri::command]
async fn get_betacraft_manifest(
    root: String,
    force: Option<bool>,
) -> Result<VersionManifest, String> {
    let root = if root.trim().is_empty() {
        PathBuf::from(".cobble")
    } else {
        PathBuf::from(root)
    };
    minecraft::fetch_betacraft_manifest(&root, force.unwrap_or(false)).await
}

#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
async fn get_content_versions(
    project_id_or_slug: String,
    game_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<content::ContentVersionItem>, String> {
    content::get_content_versions(project_id_or_slug, game_version, loader).await
}

#[tauri::command]
async fn download_content_file(
    request: content::DownloadContentRequest,
) -> Result<content::DownloadContentResult, String> {
    content::download_content_file(request).await
}

#[tauri::command]
async fn get_version_loaders(mc_version: String) -> Result<loaders::VersionLoadersCatalog, String> {
    loaders::fetch_version_loaders(&mc_version).await
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    stream: &'static str,
    reader: R,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(reader);
        let mut xml = XmlLogEvent {
            thread: None,
            level: None,
            message: None,
        };
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
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
                let _ = app.emit(
                    "game:log",
                    GameLogPayload {
                        stream: stream.to_string(),
                        line,
                    },
                );
            }
        }
    });
}

#[tauri::command]
async fn launch_game(
    app: AppHandle,
    state: State<'_, GameState>,
    request: LaunchRequest,
) -> Result<u32, String> {
    // A signed-in account launches online: the session token is read from the
    // account store instead of travelling through the web UI. Downloading it
    // from the frontend would put a live credential in JavaScript.
    let mut request = request;
    if request.auth.is_none() {
        if let Ok(dir) = account_dir(&app) {
            if let Some(record) = auth::session_for_launch(&dir).await {
                let _ = app.emit(
                    "game:log",
                    GameLogPayload {
                        stream: "cobble".to_string(),
                        line: format!(
                            "使用正版账户 {} 启动（UUID {}）",
                            record.profile.name, record.profile.id
                        ),
                    },
                );
                request.auth = Some(minecraft::LaunchAuth {
                    access_token: record.minecraft.access_token.clone(),
                    uuid: record.profile.id.clone(),
                    name: record.profile.name.clone(),
                    xuid: Some(record.minecraft.xuid.clone()),
                    client_id: Some(record.client_id.clone()),
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

    let mut command = Command::new(&spec.java);
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
            _ => 0x0000_0020, // normal
        };
        command.creation_flags(CREATE_NO_WINDOW | priority_flag);
    }

    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 Java ({}): {e}", spec.java.to_string_lossy()))?;

    let pid = child.id();
    state.stopping.store(false, Ordering::Relaxed);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state
        .child
        .lock()
        .map_err(|_| "游戏进程状态不可用".to_string())? = Some(child);

    if let Some(stdout) = stdout {
        spawn_log_reader(app.clone(), "stdout", stdout);
    }
    if let Some(stderr) = stderr {
        spawn_log_reader(app.clone(), "stderr", stderr);
    }

    let _ = app.emit(
        "game:status",
        GameStatus {
            state: "running".to_string(),
            detail: Some(format!("游戏已启动，Java {}", spec.java_major)),
            pid: Some(pid),
            version_id: Some(request.version_id.clone()),
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
    std::thread::spawn(move || loop {
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
                let requested_stop = stopping.swap(false, Ordering::Relaxed);
                let code = if requested_stop {
                    Some(0)
                } else {
                    status.code()
                };
                let _ = app_handle.emit(
                    "game:exit",
                    GameExitPayload {
                        code,
                        version_id: Some(version_id.clone()),
                    },
                );
                let message = match code {
                    Some(0) => "游戏进程已结束".to_string(),
                    Some(code) => format!("游戏进程已退出（代码 {code}）"),
                    None => "游戏进程已结束".to_string(),
                };
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
            Ok(None) => {}
            Err(_) => break,
        }
    });

    Ok(pid)
}

#[tauri::command]
fn stop_game(state: State<'_, GameState>) -> Result<(), String> {
    let mut slot = state
        .child
        .lock()
        .map_err(|_| "游戏进程状态不可用".to_string())?;
    if let Some(child) = slot.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            state.stopping.store(true, Ordering::Relaxed);
            if let Err(error) = child.kill() {
                state.stopping.store(false, Ordering::Relaxed);
                return Err(format!("无法结束游戏进程: {error}"));
            }
        }
    }
    // The monitor thread reaps the process and emits the exit event.
    Ok(())
}

#[tauri::command]
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

#[tauri::command]
async fn get_bedrock_versions(api_source: Option<String>) -> Vec<bedrock::BedrockVersionItem> {
    bedrock::get_bedrock_versions_async(api_source.as_deref()).await
}

#[tauri::command]
async fn get_bedrock_content(category: Option<String>) -> Vec<bedrock::BedrockContentItem> {
    bedrock::get_bedrock_content_async(category.as_deref()).await
}

#[tauri::command]
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

#[tauri::command]
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
            },
        );
    }

    Ok(aborted)
}

#[tauri::command]
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

    bedrock::install_bedrock_pack(&p, &source, &final_filename).await
}

#[tauri::command]
fn launch_bedrock(
    app: AppHandle,
    version_id: Option<String>,
    root: Option<String>,
    offline_account: Option<bool>,
) -> Result<String, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };

    // One account, both editions. Java gets its session token handed to the JVM;
    // Bedrock cannot be handed a token at all (the UWP/GDK client signs itself
    // in through the Windows/Xbox account, the same way the Store build does), so
    // the launcher's job here is to boot the correct core and report what the
    // shared account is entitled to. The stored account is read synchronously —
    // Bedrock needs no live token, and a network refresh must not delay startup.
    let account = account_dir(&app)
        .ok()
        .and_then(|dir| auth::load_account(&dir));
    if let Some(record) = account.as_ref() {
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

    // Offline accounts default to the BDS core so a fresh install boots something
    // playable without a sign-in; a signed-in account boots a real client core.
    let message = bedrock::launch_bedrock_edition(
        &p,
        version_id.as_deref(),
        Some(&app),
        offline_account.unwrap_or(account.is_none()),
    )?;
    Ok(match account.as_ref() {
        Some(record) => format!(
            "{message} · 账户 {}：{}",
            record.profile.name,
            bedrock_entitlement_note(&record.entitlements)
        ),
        None => message,
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

#[tauri::command]
fn get_bedrock_runtime_status(force: Option<bool>) -> bedrock::BedrockRuntimeStatus {
    bedrock::get_bedrock_runtime_status(force.unwrap_or(false))
}

#[tauri::command]
fn auto_provision_bedrock_runtime(app: AppHandle) -> bedrock::BedrockRuntimeStatus {
    bedrock::provision_bedrock_runtime(Some(&app))
}

#[tauri::command]
fn check_bedrockboot_dependencies(force: Option<bool>) -> bedrock::BedrockFullDependencyReport {
    bedrock::check_bedrockboot_dependencies(force.unwrap_or(false))
}

#[tauri::command]
fn auto_fix_bedrockboot_dependencies(app: AppHandle) -> bedrock::BedrockFullDependencyReport {
    bedrock::auto_fix_bedrockboot_dependencies(Some(&app))
}

#[tauri::command]
fn enable_bedrock_developer_mode() -> Result<(), String> {
    bedrock::enable_developer_mode()
}

#[tauri::command]
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

#[tauri::command]
fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
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

    let dir_str = dir.to_string_lossy().to_string();
    if app.opener().open_path(&dir_str, None::<&str>).is_ok() {
        return Ok(());
    }

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
#[tauri::command]
async fn resolve_mcmod_entry(
    title: String,
    slug: String,
    project_type: String,
) -> Result<Option<mcmod::WikiEntry>, String> {
    Ok(mcmod::find_entry(&title, &slug, &project_type).await)
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("链接为空".to_string());
    }
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("仅支持打开 http/https 链接".to_string());
    }

    if app.opener().open_url(trimmed, None::<&str>).is_ok() {
        return Ok(());
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
async fn clean_download_cache(app: AppHandle, root: Option<String>) -> Result<u64, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::clean_download_cache(&p).await
}

#[tauri::command]
async fn get_bedrock_loaders(mc_version: String) -> Result<bedrock::BedrockLoadersCatalog, String> {
    Ok(bedrock::fetch_bedrock_loaders(&mc_version).await)
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn delete_bedrock_pack(app: AppHandle, path: String, root: Option<String>) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::delete_bedrock_pack(&p, &path)
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
fn delete_bedrock_world(app: AppHandle, path: String, root: Option<String>) -> Result<(), String> {
    let p = match root {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::delete_bedrock_world(&p, &path)
}

#[tauri::command]
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

#[tauri::command]
async fn ms_login_begin(client_id: Option<String>) -> Result<auth::DeviceCodeInfo, String> {
    auth::begin_device_login(client_id.as_deref()).await
}

#[tauri::command]
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

#[tauri::command]
async fn get_ms_account(
    app: AppHandle,
    client_id: Option<String>,
) -> Result<Option<auth::AccountView>, String> {
    let dir = account_dir(&app)?;
    Ok(auth::account_view(&dir, client_id.as_deref()).await)
}

#[tauri::command]
async fn ms_sign_out(app: AppHandle) -> Result<(), String> {
    let dir = account_dir(&app)?;
    auth::clear_account(&dir)
}

/// Label of the launcher-owned Microsoft sign-in window.
const LOGIN_WINDOW_LABEL: &str = "ms-login";

/// Opens the Microsoft sign-in page in a window owned by the launcher.
///
/// This exists because the system browser is usually signed into a Microsoft
/// account already (Edge even ties into the Windows account), and then the
/// sign-in page locks itself to that address with no way to type another one.
/// The launcher's own webview shares none of that session, so the page shows a
/// normal, editable e-mail field every time. Only Microsoft sign-in hosts are
/// accepted — see `auth::is_microsoft_login_url`.
///
/// Must stay `async`. On Windows a synchronous command runs inside WebView2's
/// own IPC callback, so building another webview from there re-enters the
/// message pump and deadlocks: the window appears blank and never loads. Async
/// commands run off the event-loop thread, which is the documented fix.
#[tauri::command]
async fn open_login_window(app: AppHandle, url: String) -> Result<(), String> {
    if !auth::is_microsoft_login_url(&url) {
        return Err("登录窗口只接受微软官方登录页面地址。".to_string());
    }
    let target = url
        .parse()
        .map_err(|error| format!("登录地址无效: {error}"))?;

    // Reuse the window when it is already open (a second code would otherwise
    // stack up windows), just point it at the new page.
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        existing
            .navigate(target)
            .map_err(|error| format!("无法打开登录页面: {error}"))?;
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        LOGIN_WINDOW_LABEL,
        tauri::WebviewUrl::External(target),
    )
    .title("Microsoft 账户登录")
    .inner_size(520.0, 720.0)
    .resizable(true)
    .build()
    .map_err(|error| format!("无法打开登录窗口: {error}"))?;
    Ok(())
}

/// Closes the sign-in window once the login finished (or was abandoned).
#[tauri::command]
fn close_login_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        window
            .close()
            .map_err(|error| format!("无法关闭登录窗口: {error}"))?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 老系统（XP / Vista / 7 / 8 / 8.1）缺少 WebView2 运行时，窗口创建不出来；
    // 先给出明确提示，而不是让用户看到「双击了没反应」。
    if !platform::run_checks() {
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(InstallState::default())
        .manage(GameState::default())
        .manage(multiplayer::MultiplayerState::default())
        .invoke_handler(tauri::generate_handler![
            set_download_preference,
            probe_download_sources,
            get_version_manifest,
            get_betacraft_manifest,
            get_installed_versions,
            read_skin_as_data_url,
            read_home_page_file,
            fetch_home_page,
            get_version_loaders,
            search_content,
            get_content_versions,
            download_content_file,
            install_version,
            delete_version,
            detect_java,
            get_system_info,
            launch_game,
            stop_game,
            open_folder,
            open_url,
            resolve_mcmod_entry,
            get_bedrock_status,
            get_bedrock_versions,
            get_bedrock_content,
            install_bedrock_version,
            delete_bedrock_version,
            install_bedrock_pack,
            launch_bedrock,
            get_bedrock_runtime_status,
            auto_provision_bedrock_runtime,
            check_bedrockboot_dependencies,
            auto_fix_bedrockboot_dependencies,
            enable_bedrock_developer_mode,
            auto_install_bds_fallback,
            clean_download_cache,
            cancel_install,
            get_bedrock_loaders,
            install_bedrock_loader,
            get_bedrock_mods,
            toggle_bedrock_mod,
            delete_bedrock_mod,
            install_bedrock_mod_file,
            get_bedrock_packs,
            set_bedrock_pack_enabled,
            delete_bedrock_pack,
            import_bedrock_pack_file,
            get_java_mods,
            toggle_java_mod,
            delete_java_mod,
            install_java_mod_file,
            get_java_resource_packs,
            toggle_java_resource_pack,
            delete_java_resource_pack,
            install_java_resource_pack_file,
            get_java_worlds,
            delete_java_world,
            install_java_world_file,
            get_bedrock_worlds,
            delete_bedrock_world,
            import_bedrock_world_file,
            ms_login_begin,
            ms_login_poll,
            get_ms_account,
            ms_sign_out,
            open_login_window,
            close_login_window,
            multiplayer::get_multiplayer_status,
            multiplayer::get_multiplayer_peers,
            multiplayer::get_multiplayer_firewall_status,
            multiplayer::setup_multiplayer_firewall,
            multiplayer::get_multiplayer_install_state,
            multiplayer::install_easytier,
            multiplayer::start_multiplayer,
            multiplayer::stop_multiplayer,
            multiplayer::start_room_resources,
            multiplayer::fetch_room_resources,
            multiplayer::get_local_ipv6_addresses,
            multiplayer::read_minecraft_lan_port,
            multiplayer::probe_multiplayer_endpoint,
            multiplayer::probe_minecraft_host,
            multiplayer::start_lan_bridge,
            multiplayer::stop_lan_bridge,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 关掉启动器时一起结束 EasyTier 内核与局域网广播，避免留下
            // 后台进程和仍然可见的「局域网世界」。
            if let tauri::RunEvent::Exit = event {
                let state = app_handle.state::<multiplayer::MultiplayerState>();
                multiplayer::shutdown(&state);
            }
        });
}
