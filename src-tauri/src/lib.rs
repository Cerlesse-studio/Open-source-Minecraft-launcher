pub mod bedrock;
pub mod content;
pub mod java;
pub mod loaders;
pub mod minecraft;
mod net;

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

#[tauri::command]
async fn read_skin_as_data_url(path: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("无法读取皮肤文件: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
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
        os: std::env::consts::OS.to_string(),
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
fn get_bedrock_status(app: AppHandle, root: Option<String>) -> Result<bedrock::BedrockStatus, String> {
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
fn get_bedrock_content(category: Option<String>) -> Vec<bedrock::BedrockContentItem> {
    let all = bedrock::get_curated_bedrock_content();
    match category {
        Some(c) if !c.is_empty() && c != "all" => {
            all.into_iter().filter(|i| i.content_type == c).collect()
        }
        _ => all,
    }
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
        bedrock::install_bedrock_version(
            &app_handle,
            &p,
            &ver_id,
            &url,
            api_source.as_deref(),
            th,
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
        Err(e) => Err(format!("基岩版安装任务执行异常: {e}")),
    }
}

#[tauri::command]
async fn cancel_install(
    app: AppHandle,
    state: State<'_, InstallState>,
) -> Result<bool, String> {
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
) -> Result<String, String> {
    let p = match root.filter(|s| !s.trim().is_empty()) {
        Some(s) => PathBuf::from(s),
        None => default_root(&app)?,
    };
    bedrock::launch_bedrock_edition(&p, version_id.as_deref())
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
async fn clean_download_cache(
    app: AppHandle,
    root: Option<String>,
) -> Result<u64, String> {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(InstallState::default())
        .manage(GameState::default())
        .invoke_handler(tauri::generate_handler![
            get_version_manifest,
            get_betacraft_manifest,
            get_installed_versions,
            read_skin_as_data_url,
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
            get_bedrock_status,
            get_bedrock_versions,
            get_bedrock_content,
            install_bedrock_version,
            delete_bedrock_version,
            install_bedrock_pack,
            launch_bedrock,
            clean_download_cache,
            cancel_install,
            get_bedrock_loaders,
            install_bedrock_loader,
            get_bedrock_mods,
            toggle_bedrock_mod,
            delete_bedrock_mod,
            install_bedrock_mod_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
