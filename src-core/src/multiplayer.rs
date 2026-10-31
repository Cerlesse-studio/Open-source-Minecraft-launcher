//! 基于 EasyTier 内核的联机功能。
//!
//! 启动器在这里做三件事：
//! 1. 下载并管理官方 `easytier-core` 可执行文件（与 MCTier 同样的思路）；
//! 2. 用共享的网络名/密钥把一个虚拟局域网建立起来，家庭宽带的公网 IPv6
//!    直接充当 P2P 入口，不依赖中转服务器；
//! 3. 把好友的 Minecraft 服务器探测出来，并在本机 `127.0.0.1` 上做一层
//!    TCP 代理 + 局域网广播，让远端的存档出现在「多人游戏 → 局域网」里。
//!
//! 游戏本身仍然走 EasyTier 的虚拟网卡；这里的代理只是为了让 Minecraft
//! 的局域网发现机制能看见对方的世界。

use crate::net;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::process::{Child, Command};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 启动器固定下载的 EasyTier 发行版。固定版本比「总是取最新」更可控：
/// 镜像、参数和日志格式都经过验证，升级时只需要改这一处。
pub const EASYTIER_VERSION: &str = "v2.6.4";

/// Minecraft Java 版的局域网发现地址与端口。
const LAN_ANNOUNCE_TARGET: &str = "224.0.2.60:4445";
const LAN_ANNOUNCE_INTERVAL: Duration = Duration::from_millis(1500);

/// 默认的 EasyTier 监听端口（TCP/UDP）。
const DEFAULT_LISTEN_PORT: u16 = 11010;

#[derive(Default, Clone)]
struct RuntimeInfo {
    network_name: Option<String>,
    overlay_ipv4: Option<String>,
    pid: Option<u32>,
    /// 仅本机的 RPC 端口，`easytier-cli` 用它读取在线成员。
    rpc_port: Option<u16>,
    /// 仅本机的 SOCKS5 端口。内核以无 TUN 方式运行时，本机没有虚拟网卡，
    /// 访问房间里的虚拟地址只能走这个内核自带的代理入口。
    socks_port: Option<u16>,
}

struct LanBridge {
    host: String,
    port: u16,
    local_port: u16,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

/// 房主的房间资源清单服务。只返回服务器自己扫描出的 JSON，
/// 不接收访客提供的路径，也不暴露游戏目录。
struct RoomResourceServer {
    port: u16,
    version_id: String,
    secret: String,
    token: String,
    manifest: Arc<Mutex<String>>,
    task: tokio::task::JoinHandle<()>,
}

/// EasyTier 子进程、网络状态、安装任务和局域网桥接的生命周期都放在这里。
#[derive(Default)]
pub struct MultiplayerState {
    child: Mutex<Option<Child>>,
    runtime: Mutex<RuntimeInfo>,
    bridges: Mutex<Vec<LanBridge>>,
    monitor: Mutex<Option<tokio::task::JoinHandle<()>>>,
    install: Mutex<MultiplayerInstallState>,
    /// 安装状态的落盘位置由游戏目录决定，安装开始时记下来。
    install_root: Mutex<Option<PathBuf>>,
    /// 房主房间资源清单的 HTTP 服务；停房/退出时会一起结束。
    resources: Mutex<Option<RoomResourceServer>>,
    /// 串行化“启动资源服务”和“停止房间”，避免关房后扫描任务又把服务拉起来。
    resources_gate: Mutex<()>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MultiplayerStatus {
    installed: bool,
    version: Option<String>,
    running: bool,
    network_name: Option<String>,
    overlay_ipv4: Option<String>,
    pid: Option<u32>,
    core_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MultiplayerLog {
    stream: String,
    line: String,
}

/// 内核安装任务。它挂在后端而不是页面上：离开联机页、切到下载页
/// 都不会丢失进度，重新进入时用 `get_multiplayer_install_state` 恢复；
/// 启动器重启后由 `<游戏目录>/easytier/install-state.json` 恢复。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MultiplayerInstallState {
    active: bool,
    stage: String,
    detail: String,
    done_bytes: u64,
    total_bytes: u64,
    speed_bps: u64,
    threads: usize,
    version: String,
    error: Option<String>,
    started_at: u64,
    finished_at: Option<u64>,
    /// 磁盘上有可续传的 `.part`，重新点下载是从断点继续而不是重头开始。
    #[serde(default)]
    resumable: bool,
    /// 已下载的字节数，用于“已下载 X MB，可继续”的提示。
    #[serde(default)]
    partial_bytes: u64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MultiplayerConfig {
    network_name: String,
    network_secret: String,
    overlay_ipv4: String,
    /// 形如 `tcp://[240e:...]:11010`，通常是好友（或本机）的公网地址。
    peers: Vec<String>,
    #[serde(default)]
    listen_port: Option<u16>,
    /// 房主给访客设的总带宽上限（字节/秒），`None` / 0 表示不限。
    #[serde(default)]
    recv_bps_limit: Option<u64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalIpv6Address {
    address: String,
    interface: String,
    /// 2000::/3 全球单播地址：只有这类地址能从公网直连。
    global: bool,
    /// 隐私扩展生成的临时地址会随时间轮换，不适合写进分享码。
    temporary: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MinecraftHostStatus {
    ok: bool,
    motd: String,
    version: String,
    online: u32,
    max: u32,
    latency_ms: u32,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LanBridgeInfo {
    host: String,
    port: u16,
    local_port: u16,
    connect_address: String,
}

/// 房间里的另一台设备，来自 `easytier-cli peer` 的默认主机名与虚拟地址。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplayerPeer {
    hostname: String,
    ipv4: String,
    latency_ms: u32,
    /// `p2p` / `relay` / `local` 这类链路类型，未知时为空字符串。
    cost: String,
    /// `udp` / `tcp` / `wg` 等实际传输协议。
    tunnel: String,
    /// 是不是本机节点。
    is_self: bool,
}

/// Windows 防火墙对本机联机端口的放行状态。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MultiplayerFirewallStatus {
    supported: bool,
    ready: bool,
    detail: String,
}

/// 房间资源列表里的一项。只含展示需要的字段，不含本机路径。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoomResourceItem {
    name: String,
    file_name: String,
    enabled: bool,
    size: u64,
}

/// 房主选中版本的模组、光影包、资源包快照。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoomResources {
    version_id: String,
    mods: Vec<RoomResourceItem>,
    shaders: Vec<RoomResourceItem>,
    resource_packs: Vec<RoomResourceItem>,
    updated_at: u64,
    /// 房主的局域网端口。只输 IPv6 加入的访客靠它认出要连哪个端口；
    /// 旧版本不认这个字段，反序列化时按 `None` 处理。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_port: Option<u16>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RoomResourcesInfo {
    port: u16,
    token: String,
    resources: RoomResources,
}

// ---------------------------------------------------------------------------
// 安装与状态
// ---------------------------------------------------------------------------

fn easytier_dir(root: &Path) -> PathBuf {
    root.join("easytier")
}

fn core_binary(root: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "easytier-core.exe"
    } else {
        "easytier-core"
    };
    easytier_dir(root).join(name)
}

fn cli_binary(root: &Path) -> PathBuf {
    let name = if cfg!(windows) {
        "easytier-cli.exe"
    } else {
        "easytier-cli"
    };
    easytier_dir(root).join(name)
}

/// 内核运行必需的随包文件（不带扩展名的按 `name` / `name.exe` 两种写法都认）。
///
/// Windows 版 `easytier-core.exe` 在加载阶段就依赖同目录的 `Packet.dll`
/// （Npcap）；只解出两个 exe 时内核会在启动后几百毫秒内退出，房间刚建好就
/// 显示「网络已断开」，所以“只看到 exe”不能算安装完成。
///
/// `wintun.dll` 也在同一份发行包里，解压时会被保留；但它在创建 TUN 网卡时
/// 才加载，且 PATH 里的同名 DLL（比如 Cloudflare WARP 自带的 Cloudflare
/// 签名版）也能被找到，所以不把它当作“已就绪”的硬条件，只在启动失败时提示。
#[cfg(windows)]
const REQUIRED_KERNEL_STEMS: &[&str] = &["easytier-core", "easytier-cli", "Packet.dll"];
#[cfg(not(windows))]
const REQUIRED_KERNEL_STEMS: &[&str] = &["easytier-core", "easytier-cli"];

fn kernel_file_present(dir: &Path, stem: &str) -> bool {
    dir.join(stem).is_file() || dir.join(format!("{stem}.exe")).is_file()
}

fn missing_kernel_files(dir: &Path) -> Vec<&'static str> {
    REQUIRED_KERNEL_STEMS
        .iter()
        .copied()
        .filter(|stem| !kernel_file_present(dir, stem))
        .collect()
}

/// 安装目录是否完整。只看 exe 会把缺 DLL 的半成品当成“已就绪”。
fn kernel_dir_ok(dir: &Path) -> bool {
    missing_kernel_files(dir).is_empty()
}

fn kernel_installed(root: &Path) -> bool {
    kernel_dir_ok(&easytier_dir(root))
}

fn installed_version(root: &Path) -> Option<String> {
    std::fs::read_to_string(easytier_dir(root).join("version.txt"))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// 随安装包内置的 EasyTier 目录（见 `tauri.conf.json` 的 `bundle.resources`）。
///
/// 开发模式和安装后的目录布局不一样：开发时资源在
/// `src-tauri/resources/easytier`，打包后在安装目录的 `resources/easytier`。
/// 两个位置都找一遍，`tauri dev` 和安装版就都不需要联网下载内核。
fn bundled_kernel_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources").join("easytier"));
        candidates.push(dir.join("easytier"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("resources").join("easytier"));
        }
    }
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("easytier"),
    );
    candidates.into_iter().find(|dir| kernel_dir_ok(dir))
}

/// 内核随安装包分发：第一次用到时直接拷到游戏目录，不再走下载流程。
/// 已经有完整内核时什么也不做，返回 `Ok(false)`。
fn install_kernel_from_bundle(app: &AppHandle, root: &Path) -> Result<bool, String> {
    if kernel_installed(root) {
        return Ok(false);
    }
    let Some(source) = bundled_kernel_dir(app) else {
        return Ok(false);
    };
    copy_kernel_dir(&source, &easytier_dir(root))?;
    Ok(true)
}

/// 把一份完整的内核目录拷到游戏目录。
fn copy_kernel_dir(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target)
        .map_err(|error| format!("无法创建内核目录 {}：{error}", target.display()))?;
    let entries = std::fs::read_dir(source)
        .map_err(|error| format!("无法读取内置内核 {}：{error}", source.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        // 上一版只解出 exe 的半成品会被当成“已安装”，所以逐文件覆盖。
        if !path.is_file() {
            continue;
        }
        let dest = target.join(entry.file_name());
        std::fs::copy(&path, &dest)
            .map_err(|error| format!("释放内置内核失败（{}）：{error}", dest.display()))?;
    }
    let _ = std::fs::write(target.join("version.txt"), EASYTIER_VERSION);
    if !kernel_dir_ok(target) {
        return Err(format!(
            "内置 EasyTier 不完整，缺少 {}",
            missing_kernel_files(target).join("、")
        ));
    }
    Ok(())
}

fn release_asset_name() -> Result<String, String> {
    let os = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        other => return Err(format!("EasyTier 暂不支持当前系统: {other}")),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        // 官方只为 Windows 提供 32 位发行包。
        "x86" if os == "windows" => "i686",
        other => return Err(format!("EasyTier 暂不支持当前架构: {other}")),
    };
    Ok(format!("easytier-{os}-{arch}-{EASYTIER_VERSION}.zip"))
}

fn status_of(root: &Path, state: &MultiplayerState) -> MultiplayerStatus {
    let core = core_binary(root);
    let installed = kernel_installed(root);
    let runtime = state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let running = runtime.pid.is_some()
        && state
            .child
            .lock()
            .map(|child| child.is_some())
            .unwrap_or(false);
    MultiplayerStatus {
        installed,
        version: installed_version(root),
        running,
        network_name: runtime.network_name,
        overlay_ipv4: runtime.overlay_ipv4,
        pid: runtime.pid,
        core_path: installed.then(|| core.display().to_string()),
    }
}

fn emit_status(app: &AppHandle, state: &MultiplayerState, root: &Path) {
    let _ = app.emit("multiplayer:status", status_of(root, state));
}

fn emit_log(app: &AppHandle, stream: &str, line: impl Into<String>) {
    let _ = app.emit(
        "multiplayer:log",
        MultiplayerLog {
            stream: stream.to_string(),
            line: line.into(),
        },
    );
}

fn extract_binaries(zip_path: &Path, dir: &Path) -> Result<u32, String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|error| format!("无法打开 EasyTier 压缩包: {error}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| format!("EasyTier 压缩包无效: {error}"))?;
    let mut extracted = 0u32;
    for index in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(index) else {
            continue;
        };
        let Some(name) = Path::new(entry.name())
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        else {
            continue;
        };
        // 发行包根目录可能带一层文件夹，只看文件名即可；其余文件
        // （说明文档、签名、macOS 的 _CodeSignature）一律忽略。
        // `.dll` / `.sys` 不能少：Windows 上的 TUN 虚拟网卡依赖随包
        // 提供的 wintun.dll（以及 WinDivert 的驱动文件）。
        if !(name == "easytier-core"
            || name == "easytier-core.exe"
            || name == "easytier-cli"
            || name == "easytier-cli.exe"
            || name.ends_with(".dll")
            || name.ends_with(".sys"))
        {
            continue;
        }
        let target = dir.join(&name);
        let mut out = std::fs::File::create(&target)
            .map_err(|error| format!("无法写入 {}: {error}", target.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|error| format!("解压 EasyTier 失败: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
        }
        extracted += 1;
    }
    // 压缩包被截断时 zip 仍能打开，后面的条目会读失败并被跳过；只检查
    // 内核 exe 会把这种半成品当成功，运行起来却因缺 DLL 立刻退出。
    if extracted == 0 {
        return Err("EasyTier 压缩包里没有找到内核文件".to_string());
    }
    if !kernel_dir_ok(dir) {
        let missing = missing_kernel_files(dir);
        return Err(format!(
            "EasyTier 压缩包不完整，缺少 {}（请重新下载内核）",
            missing.join("、")
        ));
    }
    Ok(extracted)
}

const INSTALL_EMIT_INTERVAL: Duration = Duration::from_millis(250);
/// 一个下载线路这么久没有收到任何字节就换下一条。GitHub 直连在部分网络
/// 会一直挂着不报错，没有这个看门狗，安装会永远停在“正在下载”。
const DOWNLOAD_STALL_TIMEOUT: Duration = Duration::from_secs(30);

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// 内核压缩包与安装状态落在游戏目录的 `easytier/` 下。
fn kernel_zip(root: &Path) -> PathBuf {
    easytier_dir(root).join("easytier-core.zip")
}

fn install_state_path(root: &Path) -> PathBuf {
    easytier_dir(root).join("install-state.json")
}

/// 磁盘上可续传的字节数（`.part` + `.part.meta`）。
fn partial_progress(root: &Path) -> Option<u64> {
    net::resume_progress(&kernel_zip(root))
}

/// 上次运行留下的任务。还在下载中的记录会变成“已中断、可继续”。
fn load_persisted_install(root: &Path) -> Option<MultiplayerInstallState> {
    let text = std::fs::read_to_string(install_state_path(root)).ok()?;
    let mut state: MultiplayerInstallState = serde_json::from_str(&text).ok()?;
    if state.active {
        state.active = false;
        state.stage = "paused".to_string();
        state.detail = "上次下载被中断，可以继续下载".to_string();
        state.speed_bps = 0;
        state.finished_at = Some(now_millis());
    }
    // 已完成的旧任务不必再占着下载页，重新安装时会被覆盖。
    if state.stage != "paused" && state.stage != "error" {
        return None;
    }
    Some(state)
}

fn save_install_state(root: &Path, state: &MultiplayerInstallState) {
    let Ok(text) = serde_json::to_string(state) else {
        return;
    };
    let dir = easytier_dir(root);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(install_state_path(root), text);
}

fn install_snapshot(state: &MultiplayerState) -> MultiplayerInstallState {
    state
        .install
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn update_install(
    state: &MultiplayerState,
    update: impl FnOnce(&mut MultiplayerInstallState),
) -> MultiplayerInstallState {
    let snapshot = {
        let mut guard = state
            .install
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        update(&mut guard);
        guard.clone()
    };
    if let Some(root) = state
        .install_root
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        save_install_state(&root, &snapshot);
    }
    snapshot
}

fn emit_install(app: &AppHandle, state: &MultiplayerState) {
    let _ = app.emit("multiplayer:install", install_snapshot(state));
}

/// 读取当前的安装任务：本进程里没有任务时，从磁盘恢复上次中断的记录。
#[tauri::command]
pub fn get_multiplayer_install_state(
    root: String,
    state: tauri::State<'_, MultiplayerState>,
) -> MultiplayerInstallState {
    let root_path = PathBuf::from(&root);
    {
        let mut guard = state
            .install_root
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(root_path.clone());
    }

    if install_snapshot(&state).stage.is_empty() {
        if let Some(persisted) = load_persisted_install(&root_path) {
            let mut guard = state
                .install
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *guard = persisted;
        }
    }

    let mut snapshot = install_snapshot(&state);
    if let Some(partial) = partial_progress(&root_path) {
        snapshot.done_bytes = snapshot.done_bytes.max(partial);
        snapshot.partial_bytes = partial;
        snapshot.resumable = true;
    } else {
        snapshot.partial_bytes = 0;
        snapshot.resumable = false;
    }
    snapshot
}

/// 官方下载页提供的 GitHub 加速入口优先，再接官方地址与其余镜像。
fn easytier_download_urls(url: &str) -> Vec<String> {
    let mut candidates = vec![
        format!("https://ghfast.top/{url}"),
        format!("https://cdn.gh-proxy.org/{url}"),
        format!("https://edgeone.gh-proxy.org/{url}"),
        url.to_string(),
    ];
    for mirror in net::get_mirror_urls(url) {
        if !candidates.contains(&mirror) {
            candidates.push(mirror);
        }
    }
    candidates
}

/// 用多线程 Range 下载一条线路，并在长时间没有进度时主动放弃。
async fn download_candidate(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    threads: usize,
    label: &str,
) -> Result<u64, String> {
    let last_activity = Arc::new(Mutex::new(Instant::now()));
    let activity_cb = last_activity.clone();
    let progress_app = app.clone();
    let label = label.to_string();
    let mut last_emit = Instant::now() - INSTALL_EMIT_INTERVAL;
    let mut last_done = 0u64;
    let mut last_speed = 0u64;

    let mut on_progress = move |done: u64, total: u64, _delta: u64| {
        *activity_cb
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Instant::now();
        if last_emit.elapsed() < INSTALL_EMIT_INTERVAL && (total == 0 || done < total) {
            return;
        }
        let elapsed = last_emit.elapsed().as_secs_f64().max(0.001);
        if done >= last_done {
            last_speed = ((done - last_done) as f64 / elapsed) as u64;
        }
        last_done = done;
        last_emit = Instant::now();

        let state = progress_app.state::<MultiplayerState>();
        update_install(state.inner(), |install| {
            install.stage = "download".to_string();
            install.detail = format!("正在下载 EasyTier {EASYTIER_VERSION}（{label}）");
            install.done_bytes = done;
            install.total_bytes = total;
            install.speed_bps = last_speed;
            install.resumable = true;
            install.partial_bytes = done;
        });
        emit_install(&progress_app, &state);
    };

    // 断点续传版下载器：切换线路或重启启动器后只补没完成的分片。
    let mut download = Box::pin(net::download_file_resumable(
        url,
        dest,
        None,
        None,
        threads,
        None,
        Some(&mut on_progress),
    ));
    let mut ticker = tokio::time::interval(Duration::from_secs(5));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;

    loop {
        tokio::select! {
            result = &mut download => return result,
            _ = ticker.tick() => {
                let idle = last_activity
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .elapsed();
                if idle >= DOWNLOAD_STALL_TIMEOUT {
                    return Err(format!("{} 秒没有收到数据", idle.as_secs()));
                }
            }
        }
    }
}

/// 下载并解压官方 EasyTier 内核。已安装或正在下载时不会重复开始。
#[tauri::command]
pub async fn install_easytier(
    app: AppHandle,
    root: String,
    state: tauri::State<'_, MultiplayerState>,
) -> Result<MultiplayerStatus, String> {
    let root_path = PathBuf::from(&root);
    let dir = easytier_dir(&root_path);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("无法创建 EasyTier 目录: {error}"))?;

    if kernel_installed(&root_path)
        && installed_version(&root_path).as_deref() == Some(EASYTIER_VERSION)
    {
        return Ok(status_of(&root_path, &state));
    }

    let asset = release_asset_name()?;
    let url = format!(
        "https://github.com/EasyTier/EasyTier/releases/download/{EASYTIER_VERSION}/{asset}"
    );
    let zip_path = kernel_zip(&root_path);
    let threads = net::download_threads().clamp(1, 16);
    // 有 `.part` 就接着下：换线路、重启启动器都不会从 0 开始。
    let resumed = partial_progress(&root_path).unwrap_or(0);

    {
        let mut guard = state
            .install_root
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *guard = Some(root_path.clone());
    }

    // 同一个内核只允许一个下载任务：重复进入页面或重复点击不会
    // 再开一条下载，而是直接读当前进度。
    if install_snapshot(&state).active {
        return Err("EasyTier 正在下载中，请稍候".to_string());
    }
    update_install(&state, |install| {
        *install = MultiplayerInstallState {
            active: true,
            stage: "download".to_string(),
            detail: if resumed > 0 {
                format!("继续下载 EasyTier {EASYTIER_VERSION}")
            } else {
                "正在连接下载线路".to_string()
            },
            threads,
            version: EASYTIER_VERSION.trim_start_matches('v').to_string(),
            started_at: now_millis(),
            resumable: resumed > 0,
            partial_bytes: resumed,
            ..Default::default()
        };
    });
    emit_install(&app, &state);

    let candidates = easytier_download_urls(&url);
    let mut last_error = String::new();
    let mut downloaded = false;
    for (index, candidate) in candidates.iter().enumerate() {
        let label = format!("线路 {}/{}", index + 1, candidates.len());
        let partial = partial_progress(&root_path).unwrap_or(0);
        update_install(&state, |install| {
            install.detail = if partial > 0 {
                format!("继续下载（{label}）")
            } else {
                format!("正在连接{label}")
            };
            install.done_bytes = partial;
            install.total_bytes = 0;
            install.speed_bps = 0;
            install.resumable = partial > 0;
            install.partial_bytes = partial;
        });
        emit_install(&app, &state);

        match download_candidate(&app, candidate, &zip_path, threads, &label).await {
            Ok(_) => {
                downloaded = true;
                break;
            }
            Err(error) => {
                last_error = error.clone();
                emit_log(&app, "cobble", format!("{label} 失败：{error}"));
                // `.part` 与旁车文件留着，下一条线路或下次点击可以接着下。
                let partial = partial_progress(&root_path).unwrap_or(0);
                update_install(&state, |install| {
                    install.resumable = partial > 0;
                    install.partial_bytes = partial;
                    install.done_bytes = install.done_bytes.max(partial);
                });
            }
        }
    }

    if !downloaded {
        let message = if last_error.is_empty() {
            "下载 EasyTier 失败".to_string()
        } else {
            format!("下载 EasyTier 失败：{last_error}")
        };
        let partial = partial_progress(&root_path).unwrap_or(0);
        update_install(&state, |install| {
            install.active = false;
            install.stage = "error".to_string();
            install.detail = message.clone();
            install.error = Some(message.clone());
            install.speed_bps = 0;
            install.finished_at = Some(now_millis());
            install.resumable = partial > 0;
            install.partial_bytes = partial;
        });
        emit_install(&app, &state);
        return Err(message);
    }

    update_install(&state, |install| {
        install.stage = "extract".to_string();
        install.detail = "正在解压 EasyTier 内核".to_string();
        install.speed_bps = 0;
    });
    emit_install(&app, &state);
    emit_log(&app, "cobble", "下载完成，正在解压 EasyTier 内核");

    let dir_for_extract = dir.clone();
    let zip_for_extract = zip_path.clone();
    let extracted =
        tokio::task::spawn_blocking(move || extract_binaries(&zip_for_extract, &dir_for_extract))
            .await
            .map_err(|error| format!("解压 EasyTier 失败: {error}"))?;

    if let Err(error) = extracted {
        // 压缩包本身有问题就别留着，下次重新下载（并清掉旧的续传记录）。
        let _ = tokio::fs::remove_file(&zip_path).await;
        let _ = tokio::fs::remove_file(net::resume_sidecar_path(&zip_path)).await;
        update_install(&state, |install| {
            install.active = false;
            install.stage = "error".to_string();
            install.detail = error.clone();
            install.error = Some(error.clone());
            install.finished_at = Some(now_millis());
            install.resumable = false;
            install.partial_bytes = 0;
        });
        emit_install(&app, &state);
        return Err(error);
    }

    let _ = tokio::fs::remove_file(&zip_path).await;
    tokio::fs::write(dir.join("version.txt"), EASYTIER_VERSION)
        .await
        .map_err(|error| format!("无法写入 EasyTier 版本标记: {error}"))?;

    update_install(&state, |install| {
        install.active = false;
        install.stage = "done".to_string();
        install.detail = format!("EasyTier {EASYTIER_VERSION} 已就绪");
        install.done_bytes = install.total_bytes.max(install.done_bytes);
        install.speed_bps = 0;
        install.error = None;
        install.finished_at = Some(now_millis());
        install.resumable = false;
        install.partial_bytes = 0;
    });
    emit_install(&app, &state);

    let status = status_of(&root_path, &state);
    if !status.installed {
        return Err("EasyTier 内核解压后仍然找不到可执行文件".to_string());
    }
    let _ = app.emit("multiplayer:status", status.clone());
    Ok(status)
}

#[tauri::command]
pub fn get_multiplayer_status(
    app: AppHandle,
    root: String,
    state: tauri::State<'_, MultiplayerState>,
) -> MultiplayerStatus {
    let root_path = PathBuf::from(&root);
    match install_kernel_from_bundle(&app, &root_path) {
        Ok(true) => emit_log(
            &app,
            "cobble",
            format!("已释放内置 EasyTier {EASYTIER_VERSION}"),
        ),
        Ok(false) => {}
        Err(error) => emit_log(&app, "cobble", error),
    }
    emit_status(&app, &state, &root_path);
    status_of(&root_path, &state)
}

// ---------------------------------------------------------------------------
// 网络启停
// ---------------------------------------------------------------------------

fn spawn_log_reader<R>(app: AppHandle, stream: &'static str, reader: R)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if !line.trim().is_empty() {
                        emit_log(&app, stream, line);
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
    });
}

fn node_is_running(state: &MultiplayerState) -> bool {
    state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .network_name
        .is_some()
}

fn stop_resources(state: &MultiplayerState) {
    if let Some(server) = state
        .resources
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        server.task.abort();
    }
}

fn stop_bridges(state: &MultiplayerState) {
    let mut bridges = state
        .bridges
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for bridge in bridges.drain(..) {
        for task in bridge.tasks {
            task.abort();
        }
    }
}

/// 结束内核进程并清空运行状态。事件由调用方补发（这里拿不到 root）。
fn stop_node(state: &MultiplayerState) {
    let _gate = state
        .resources_gate
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(monitor) = state
        .monitor
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        monitor.abort();
    }
    if let Some(mut child) = state
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        let _ = child.start_kill();
    }
    *state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = RuntimeInfo::default();
    stop_resources(state);
    stop_bridges(state);
}

/// 应用退出时调用：不要让 EasyTier 内核在后台变成孤儿进程。
pub fn shutdown(state: &MultiplayerState) {
    stop_node(state);
}

fn normalize_peer(peer: &str) -> Result<String, String> {
    let trimmed = peer.trim();
    if trimmed.is_empty() {
        return Err("连接地址为空".to_string());
    }
    // 允许直接粘贴 `[240e::1]:11010` / `240e::1`，统一补成 EasyTier 的 URI。
    if trimmed.contains("://") {
        return Ok(trimmed.to_string());
    }
    let (host, port) = if let Some(rest) = trimmed.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(format!("IPv6 地址缺少右方括号: {trimmed}"));
        };
        let host = &rest[..end];
        let port = rest[end + 1..]
            .strip_prefix(':')
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(DEFAULT_LISTEN_PORT);
        (host.to_string(), port)
    } else {
        match trimmed.rsplit_once(':') {
            Some((host, _)) if host.contains(':') => (trimmed.to_string(), DEFAULT_LISTEN_PORT),
            Some((host, port)) => (
                host.to_string(),
                port.parse::<u16>().unwrap_or(DEFAULT_LISTEN_PORT),
            ),
            None => (trimmed.to_string(), DEFAULT_LISTEN_PORT),
        }
    };
    let host = host.trim_matches(|c| c == '[' || c == ']');
    if host.contains(':') {
        Ok(format!("tcp://[{host}]:{port}"))
    } else {
        Ok(format!("tcp://{host}:{port}"))
    }
}

/// 房主设置的访客带宽上限（字节/秒）。0 / `None` 表示不限。
fn recv_bps_limit(config: &MultiplayerConfig) -> Option<u64> {
    config.recv_bps_limit.filter(|limit| *limit > 0)
}

/// 内核命令行。单独抽出来是为了能测：房主/访客哪些设置会真的落到 EasyTier 上。
fn core_args(
    config: &MultiplayerConfig,
    listeners: &str,
    peers: &[String],
    rpc_port: u16,
    socks_port: u16,
) -> Vec<String> {
    let mut args = vec![
        "--network-name".to_string(),
        config.network_name.trim().to_string(),
        "--network-secret".to_string(),
        config.network_secret.trim().to_string(),
        "--ipv4".to_string(),
        config.overlay_ipv4.trim().to_string(),
        // 无 TUN 模式：不创建虚拟网卡，因此不需要管理员权限。
        // 房主的虚拟地址由内核的用户态协议栈直接转到本机服务；
        // 访客要访问房间里的地址时，统一从 `--socks5` 这个本机入口走。
        "--no-tun".to_string(),
        "true".to_string(),
        "--use-smoltcp".to_string(),
        "true".to_string(),
        "--socks5".to_string(),
        socks_port.to_string(),
        "--listeners".to_string(),
        listeners.to_string(),
        // 只监听本机回环：房间成员列表靠它读取，同时不把管理接口
        // 暴露给局域网或虚拟网络里的其他人。
        "--rpc-portal".to_string(),
        rpc_port.to_string(),
        "--console-log-level".to_string(),
        "info".to_string(),
        "--multi-thread".to_string(),
        "--latency-first".to_string(),
    ];
    if let Some(limit) = recv_bps_limit(config) {
        args.push("--instance-recv-bps-limit".to_string());
        args.push(limit.to_string());
    }
    if !peers.is_empty() {
        args.push("--peers".to_string());
        args.push(peers.join(","));
    }
    args
}

/// 只有真的拿到退出状态才算内核结束。
///
/// `try_wait` 偶发报错时如果当成退出，就会把房主正在服务的内核杀掉，
/// 于是服务器上的房主自己也看到「网络已断开」，所有访客一起掉线。
fn kernel_finished(result: std::io::Result<Option<std::process::ExitStatus>>) -> bool {
    matches!(result, Ok(Some(_)))
}

#[tauri::command]
pub async fn start_multiplayer(
    app: AppHandle,
    root: String,
    config: MultiplayerConfig,
    state: tauri::State<'_, MultiplayerState>,
) -> Result<MultiplayerStatus, String> {
    let root_path = PathBuf::from(&root);
    match install_kernel_from_bundle(&app, &root_path) {
        Ok(true) => emit_log(
            &app,
            "cobble",
            format!("已释放内置 EasyTier {EASYTIER_VERSION}"),
        ),
        Ok(false) => {}
        Err(error) => emit_log(&app, "cobble", error),
    }
    let core = core_binary(&root_path);
    let kernel_dir = easytier_dir(&root_path);
    if !kernel_dir_ok(&kernel_dir) {
        let missing = missing_kernel_files(&kernel_dir);
        return Err(if core.is_file() {
            format!(
                "EasyTier 内核文件不完整（缺少 {}），请在联机页重新下载内核",
                missing.join("、")
            )
        } else {
            "还没有安装 EasyTier 内核，请先下载".to_string()
        });
    }

    let name = config.network_name.trim();
    if name.is_empty() {
        return Err("网络名称不能为空".to_string());
    }
    let secret = config.network_secret.trim();
    if secret.len() < 6 {
        return Err("网络密钥至少需要 6 位，否则陌生人可以加入".to_string());
    }
    let overlay = config.overlay_ipv4.trim();
    overlay
        .parse::<std::net::Ipv4Addr>()
        .map_err(|_| format!("虚拟 IPv4 地址无效: {overlay}"))?;
    let listen_port = config.listen_port.unwrap_or(DEFAULT_LISTEN_PORT).max(1);
    let rpc_port = free_local_port();
    // 内核自带的 SOCKS5 入口。两个端口都取自系统临时分配，撞车时再换一个。
    let mut socks_port = free_local_port();
    while socks_port == rpc_port || socks_port == listen_port {
        socks_port = free_local_port();
    }

    // 房主不填任何对等节点，只负责监听并等待访客直连；
    // 访客则只把房主的 IPv6 入口放进 peers。
    let peers = config
        .peers
        .iter()
        .filter(|peer| !peer.trim().is_empty())
        .map(|peer| normalize_peer(peer))
        .collect::<Result<Vec<_>, _>>()?;

    let mut listeners = format!("tcp://[::]:{listen_port},udp://[::]:{listen_port}");
    if !has_ipv6_binding() {
        listeners = format!("tcp://0.0.0.0:{listen_port},udp://0.0.0.0:{listen_port}");
    }

    stop_node(&state);
    emit_log(
        &app,
        "cobble",
        format!("启动 EasyTier（{EASYTIER_VERSION}）…"),
    );

    let mut command = Command::new(&core);
    command
        .current_dir(easytier_dir(&root_path))
        .args(core_args(&config, &listeners, &peers, rpc_port, socks_port))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    emit_log(&app, "cobble", format!("监听 {listeners}"));
    if !peers.is_empty() {
        emit_log(
            &app,
            "cobble",
            format!("初始对等节点: {}", peers.join(", ")),
        );
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 EasyTier 内核: {error}"))?;
    let pid = child.id();
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(app.clone(), "stdout", stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(app.clone(), "stderr", stderr);
    }

    *state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = RuntimeInfo {
        network_name: Some(name.to_string()),
        overlay_ipv4: Some(overlay.to_string()),
        pid,
        rpc_port: Some(rpc_port),
        socks_port: Some(socks_port),
    };
    *state
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(child);

    // 缺运行库、端口被占用、拿不到 TUN 权限时，内核会在几百毫秒内退出。
    // 先把这一点确认掉：否则界面会先进房间，再被「网络已断开」顶回来。
    tokio::time::sleep(Duration::from_millis(600)).await;
    let early_exit = {
        let mut guard = state
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(Some(status)) => Some(status.to_string()),
                _ => None,
            },
            None => None,
        }
    };
    if let Some(code) = early_exit {
        {
            let mut guard = state
                .child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(mut child) = guard.take() {
                let _ = child.start_kill();
            }
        }
        {
            let _gate = state
                .resources_gate
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *state
                .runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = RuntimeInfo::default();
            stop_resources(&state);
        }
        stop_bridges(&state);
        emit_status(&app, &state, &root_path);
        return Err(format!(
            "EasyTier 内核启动后立即退出（{code}）。常见原因：内核文件不完整（缺少 Packet.dll）、监听端口 {listen_port} 被其他程序占用。"
        ));
    }

    let status = status_of(&root_path, &state);
    let _ = app.emit("multiplayer:status", status.clone());

    // 轮询子进程状态：内核退出（缺少管理员权限、端口被占用等）时及时
    // 把界面切回未启动，并把真实原因留在日志里。
    //
    // 只有 `Ok(Some(_))` 才算真的退出：`try_wait` 偶发报错（句柄被安全软件
    // 短暂占用、系统繁忙）时如果当成退出，就会把房主正在服务的内核杀掉，
    // 于是房主自己看到「网络已断开」，访客全部掉线。
    let monitor_app = app.clone();
    let monitor_root = root_path.clone();
    let monitor = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(700)).await;
            let state = monitor_app.state::<MultiplayerState>();
            let exited = {
                let mut guard = state
                    .child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                match guard.as_mut() {
                    // 还在跑，或者这次读不出来：都继续等下一轮。
                    Some(child) => kernel_finished(child.try_wait()),
                    None => true,
                }
            };
            if !exited {
                continue;
            }
            {
                let mut guard = state
                    .child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(mut child) = guard.take() {
                    let _ = child.start_kill();
                }
            }
            {
                let _gate = state
                    .resources_gate
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                *state
                    .runtime
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = RuntimeInfo::default();
                stop_resources(&state);
            }
            stop_bridges(&state);
            emit_log(&monitor_app, "cobble", "EasyTier 已停止，联机网络已断开");
            emit_status(&monitor_app, &state, &monitor_root);
            break;
        }
    });
    *state
        .monitor
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(monitor);

    Ok(status)
}

#[tauri::command]
pub fn stop_multiplayer(
    app: AppHandle,
    root: String,
    state: tauri::State<'_, MultiplayerState>,
) -> MultiplayerStatus {
    stop_node(&state);
    emit_log(&app, "cobble", "已断开联机网络");
    let status = status_of(&PathBuf::from(&root), &state);
    let _ = app.emit("multiplayer:status", status.clone());
    status
}

// ---------------------------------------------------------------------------
// 房间资源清单（房主提供，访客经虚拟网络读取）
// ---------------------------------------------------------------------------

/// 版本 ID 会参与目录拼接，必须挡住路径分隔符和 `..`。
fn safe_version_id(version_id: &str) -> bool {
    let value = version_id.trim();
    !value.is_empty()
        && value.len() <= 64
        && value != "."
        && value != ".."
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains(':')
        && !value.contains('\0')
}

fn valid_resource_token(token: &str) -> bool {
    (8..=64).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// 资源令牌只需要防止陌生人扫端口就能读到文件清单，不需要密码学级随机；
/// 用系统时间、进程号和线程名做 SHA-1，避免再引入一个随机数依赖。
fn new_resource_token() -> String {
    let mut hasher = Sha1::new();
    hasher.update(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_le_bytes(),
    );
    hasher.update(std::process::id().to_le_bytes());
    hasher.update(std::thread::current().name().unwrap_or("cobble").as_bytes());
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn split_disabled(file_name: &str) -> (&str, bool) {
    let lower = file_name.to_lowercase();
    if lower.ends_with(".disabled") {
        (&file_name[..file_name.len() - ".disabled".len()], false)
    } else if lower.ends_with(".dis") {
        (&file_name[..file_name.len() - ".dis".len()], false)
    } else {
        (file_name, true)
    }
}

fn strip_suffix_ci<'a>(name: &'a str, suffix: &str) -> &'a str {
    if name.to_lowercase().ends_with(suffix) {
        &name[..name.len() - suffix.len()]
    } else {
        name
    }
}

fn sort_resource_items(items: &mut [RoomResourceItem]) {
    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
}

fn scan_room_mods(root: &Path, version_id: &str) -> Vec<RoomResourceItem> {
    let dir = crate::minecraft::resolve_java_mods_dir(root, version_id);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        let (base, enabled) = split_disabled(&file_name);
        if !base.to_lowercase().ends_with(".jar") {
            continue;
        }
        let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        items.push(RoomResourceItem {
            name: strip_suffix_ci(base, ".jar").to_string(),
            file_name,
            enabled,
            size,
        });
    }
    sort_resource_items(&mut items);
    items
}

fn room_dir_size(dir: &Path, depth: u8) -> u64 {
    if depth > 4 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                return 0;
            };
            if meta.is_dir() {
                room_dir_size(&path, depth + 1)
            } else {
                meta.len()
            }
        })
        .sum()
}

fn scan_room_shaders(game_dir: &Path) -> Vec<RoomResourceItem> {
    let dir = game_dir.join("shaderpacks");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') {
            continue;
        }
        let (base, enabled) = split_disabled(&file_name);
        let is_dir = path.is_dir();
        if !is_dir && !base.to_lowercase().ends_with(".zip") {
            continue;
        }
        let size = if is_dir {
            room_dir_size(&path, 0)
        } else {
            entry.metadata().map(|meta| meta.len()).unwrap_or(0)
        };
        items.push(RoomResourceItem {
            name: strip_suffix_ci(base, ".zip").to_string(),
            file_name,
            enabled,
            size,
        });
    }
    sort_resource_items(&mut items);
    items
}

fn scan_room_resource_packs(
    root: &Path,
    version_id: &str,
    isolation: Option<&str>,
) -> Vec<RoomResourceItem> {
    crate::minecraft::get_java_resource_packs(root, version_id, isolation)
        .into_iter()
        .map(|pack| RoomResourceItem {
            name: pack.name,
            file_name: pack.file_name,
            enabled: pack.enabled,
            size: pack.size,
        })
        .collect()
}

fn scan_room_resources(
    root: &Path,
    version_id: &str,
    isolation: Option<&str>,
) -> RoomResources {
    let game_dir = crate::minecraft::resolve_java_game_dir(root, version_id, isolation);
    RoomResources {
        version_id: version_id.to_string(),
        mods: scan_room_mods(root, version_id),
        shaders: scan_room_shaders(&game_dir),
        resource_packs: scan_room_resource_packs(root, version_id, isolation),
        updated_at: now_millis(),
        host_port: None,
    }
}

async fn write_room_response(
    socket: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &str,
) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

/// 只接受 `GET /room.json?key=<token>`，其余请求一律 403/404。
async fn serve_room_resources(
    listener: TcpListener,
    token: String,
    manifest: Arc<Mutex<String>>,
) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(pair) => pair,
            Err(_) => break,
        };
        let token = token.clone();
        let manifest = manifest.clone();
        tokio::spawn(async move {
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                match tokio::time::timeout(Duration::from_secs(3), socket.read(&mut chunk)).await {
                    Ok(Ok(0)) | Err(_) | Ok(Err(_)) => return,
                    Ok(Ok(size)) => {
                        request.extend_from_slice(&chunk[..size]);
                        if request.windows(4).any(|window| window == b"\r\n\r\n")
                            || request.len() >= 8192
                        {
                            break;
                        }
                    }
                }
            }

            let head = String::from_utf8_lossy(&request);
            let line = head.lines().next().unwrap_or("");
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");
            if method != "GET" {
                write_room_response(&mut socket, "405 Method Not Allowed", "text/plain", "method")
                    .await;
                return;
            }
            let Some(query) = path.strip_prefix("/room.json?") else {
                write_room_response(&mut socket, "404 Not Found", "text/plain", "not found")
                    .await;
                return;
            };
            let authorized = query.split('&').any(|pair| {
                let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
                key == "key" && value == token
            });
            if !authorized {
                write_room_response(&mut socket, "403 Forbidden", "text/plain", "forbidden")
                    .await;
                return;
            }
            let body = manifest
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            write_room_response(
                &mut socket,
                "200 OK",
                "application/json; charset=utf-8",
                &body,
            )
            .await;
        });
    }
}

/// 房主启动资源清单服务。版本、密钥和令牌都没变时复用原端口，
/// 只更新清单内容；这样重进房间页不会让已发出去的分享码失效。
#[tauri::command]
pub async fn start_room_resources(
    root: String,
    version_id: String,
    isolation: Option<String>,
    secret: String,
    token: Option<String>,
    port: Option<u16>,
    host_port: Option<u16>,
    state: tauri::State<'_, MultiplayerState>,
) -> Result<RoomResourcesInfo, String> {
    let root_path = PathBuf::from(&root);
    let version_id = version_id.trim().to_string();
    if !safe_version_id(&version_id) {
        return Err("房间版本无效".to_string());
    }
    let secret = secret.trim().to_string();
    if secret.len() < 6 {
        return Err("房间密钥太短，无法启动资源列表".to_string());
    }
    let requested_token = token.unwrap_or_default().trim().to_string();
    let token = if valid_resource_token(&requested_token) {
        requested_token
    } else {
        new_resource_token()
    };

    let scan_root = root_path.clone();
    let scan_version = version_id.clone();
    let scan_isolation = isolation.clone();
    let mut resources = tokio::task::spawn_blocking(move || {
        scan_room_resources(&scan_root, &scan_version, scan_isolation.as_deref())
    })
    .await
    .map_err(|error| format!("读取房间资源失败: {error}"))?;
    // 只输 IPv6 的访客不知道局域网端口，靠清单里的这一项认出来。
    resources.host_port = host_port.filter(|port| *port > 0);
    let manifest_text = serde_json::to_string(&resources)
        .map_err(|error| format!("生成房间资源清单失败: {error}"))?;

    // 扫描期间用户可能已经离开房间；先确认网络还在，避免关房后又把
    // 资源服务拉起来。下面的 bind 是 await，不能一直持有 std Mutex。
    {
        let _gate = state
            .resources_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !node_is_running(&state) {
            return Err("联机网络已断开，资源列表未启动".to_string());
        }
        let mut guard = state
            .resources
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(server) = guard.as_ref() {
            if server.version_id == version_id && server.secret == secret && server.token == token {
                *server
                    .manifest
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = manifest_text;
                return Ok(RoomResourcesInfo {
                    port: server.port,
                    token: server.token.clone(),
                    resources,
                });
            }
        }
        if let Some(previous) = guard.take() {
            previous.task.abort();
        }
    }

    let requested_port = port.unwrap_or(0);
    let listener = match TcpListener::bind(("0.0.0.0", requested_port)).await {
        Ok(listener) => listener,
        Err(error) if requested_port != 0 => {
            TcpListener::bind(("0.0.0.0", 0)).await.map_err(|fallback| {
                format!(
                    "无法启动房间资源列表（端口 {requested_port}: {error}；随机端口: {fallback}）"
                )
            })?
        }
        Err(error) => return Err(format!("无法启动房间资源列表: {error}")),
    };
    let actual_port = listener
        .local_addr()
        .map_err(|error| format!("无法读取房间资源端口: {error}"))?
        .port();
    let manifest = Arc::new(Mutex::new(manifest_text));
    // bind 期间房间可能被关掉；在同一个 gate 里做最后一次检查并登记服务，
    // stop_node / 内核退出监测会等待这里完成，然后立刻把它停掉。
    let _gate = state
        .resources_gate
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !node_is_running(&state) {
        return Err("联机网络已断开，资源列表未启动".to_string());
    }
    let task = tokio::spawn(serve_room_resources(
        listener,
        token.clone(),
        manifest.clone(),
    ));
    let server = RoomResourceServer {
        port: actual_port,
        version_id,
        secret,
        token: token.clone(),
        manifest,
        task,
    };
    if let Some(previous) = state
        .resources
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .replace(server)
    {
        previous.task.abort();
    }

    Ok(RoomResourcesInfo {
        port: actual_port,
        token,
        resources,
    })
}

/// 访客用虚拟地址访问房主的资源清单；请求由 Rust 发出，避免 webview 的
/// 混合内容/CORS 限制，也顺便绕开了系统代理。
#[tauri::command]
pub async fn fetch_room_resources(
    host: String,
    port: u16,
    token: String,
    state: tauri::State<'_, MultiplayerState>,
) -> Result<RoomResources, String> {
    let socks = runtime_socks_port(&state)
        .ok_or_else(|| "联机网络还没启动，先加入房间再读取资源列表".to_string())?;
    fetch_room_resources_inner(host, port, token, socks).await
}

async fn fetch_room_resources_inner(
    host: String,
    port: u16,
    token: String,
    socks: u16,
) -> Result<RoomResources, String> {
    let host = host.trim().trim_matches(|character| character == '[' || character == ']');
    if host.is_empty()
        || host.contains('/')
        || host.contains('\\')
        || host.contains('?')
        || host.contains('#')
        || host.contains('@')
        || host.chars().any(char::is_whitespace)
    {
        return Err("房主的虚拟地址无效".to_string());
    }
    if port == 0 {
        return Err("房主没有开启房间资源列表".to_string());
    }
    let token = token.trim();
    if !valid_resource_token(token) {
        return Err("分享码里的房间资源密钥无效".to_string());
    }
    let mut stream = dial_room(socks, &host, port).await?;
    let host_header = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let request = format!(
        "GET /room.json?key={token} HTTP/1.1\r\nHost: {host_header}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| format!("请求房间资源列表失败：{error}"))?;

    let mut raw = Vec::new();
    match tokio::time::timeout(Duration::from_secs(8), stream.read_to_end(&mut raw)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => return Err(format!("读取房间资源列表失败：{error}")),
        Err(_) => return Err("读取房间资源列表超时".to_string()),
    }
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| "房主的房间资源列表响应不完整".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");
    match status {
        "200" => {}
        "403" => return Err("分享码里的房间资源密钥已失效，让房主重新发码".to_string()),
        other => return Err(format!("房主拒绝了房间资源列表（HTTP {other}）")),
    }
    serde_json::from_str::<RoomResources>(body)
        .map_err(|error| format!("房间资源列表格式不对: {error}"))
}

/// 有 IPv6 协议栈时才监听 `[::]`（Windows 默认双栈，同时接受 IPv4）。
fn has_ipv6_binding() -> bool {
    std::net::TcpListener::bind("[::]:0").is_ok()
}

/// 让系统临时分配一个本机端口给 RPC。避开固定 15888：同一台机器上
/// 可能还开着 MCTier 或另一个启动器，固定端口会撞车。
fn free_local_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(15888)
}

/// 当前内核给的 SOCKS5 入口；没在运行时返回 `None`。
fn runtime_socks_port(state: &MultiplayerState) -> Option<u16> {
    state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .socks_port
}

/// 本机地址不需要经过虚拟网络，直接连更可靠。
fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost") || host.starts_with("127.") || host == "::1"
}

/// 通过内核的 SOCKS5 端口连接虚拟网里的地址（CONNECT 命令，免认证）。
///
/// 无 TUN 模式下 `10.126.126.x` 在本机系统里根本没有路由，只有内核知道
/// 怎么把包送到对端，所以访客侧的所有连接都得从这里走。
async fn socks5_connect(proxy_port: u16, host: &str, port: u16) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", proxy_port))
        .await
        .map_err(|error| format!("连不上本机联机代理（127.0.0.1:{proxy_port}）：{error}"))?;
    let _ = stream.set_nodelay(true);

    stream
        .write_all(&[0x05, 0x01, 0x00])
        .await
        .map_err(|error| format!("联机代理握手失败：{error}"))?;
    let mut greeting = [0u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(|error| format!("联机代理没有应答：{error}"))?;
    if greeting[0] != 0x05 || greeting[1] != 0x00 {
        return Err("联机代理不支持免认证 SOCKS5".to_string());
    }

    let mut request = vec![0x05u8, 0x01, 0x00];
    match host.parse::<std::net::Ipv4Addr>() {
        Ok(address) => {
            request.push(0x01);
            request.extend_from_slice(&address.octets());
        }
        Err(_) => {
            let bytes = host.as_bytes();
            if bytes.is_empty() || bytes.len() > 255 {
                return Err(format!("代理目标地址无效: {host}"));
            }
            request.push(0x03);
            request.push(bytes.len() as u8);
            request.extend_from_slice(bytes);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|error| format!("提交代理目标失败：{error}"))?;

    let mut reply = [0u8; 4];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|error| format!("读取代理应答失败：{error}"))?;
    if reply[0] != 0x05 {
        return Err("联机代理应答格式不对".to_string());
    }
    if reply[1] != 0x00 {
        return Err(format!(
            "联机代理拒绝连接到 {host}:{port}（SOCKS5 错误码 {}）",
            reply[1]
        ));
    }
    // 应答尾巴带一个绑定地址，按地址类型吃掉，不然会污染后续数据。
    match reply[3] {
        0x01 => {
            let mut address = [0u8; 4];
            stream
                .read_exact(&mut address)
                .await
                .map_err(|error| format!("读取代理绑定地址失败：{error}"))?;
        }
        0x04 => {
            let mut address = [0u8; 16];
            stream
                .read_exact(&mut address)
                .await
                .map_err(|error| format!("读取代理绑定地址失败：{error}"))?;
        }
        0x03 => {
            let mut length = [0u8; 1];
            stream
                .read_exact(&mut length)
                .await
                .map_err(|error| format!("读取代理绑定地址失败：{error}"))?;
            let mut address = vec![0u8; length[0] as usize];
            stream
                .read_exact(&mut address)
                .await
                .map_err(|error| format!("读取代理绑定地址失败：{error}"))?;
        }
        other => return Err(format!("联机代理返回了未知地址类型 {other}")),
    }
    let mut bound_port = [0u8; 2];
    stream
        .read_exact(&mut bound_port)
        .await
        .map_err(|error| format!("读取代理绑定端口失败：{error}"))?;
    Ok(stream)
}

/// 连到房间里的某个地址：本机地址直接连，其余走内核的 SOCKS5 入口。
///
/// 代理失败时再试一次本机直连：房主把本机局域网地址（例如自己的
/// `192.168.x.x`）加进列表时，虚拟网络里本来就没有这个地址，直连才是对的。
async fn dial_room(socks_port: u16, host: &str, port: u16) -> Result<TcpStream, String> {
    if is_loopback_host(host) {
        return TcpStream::connect((host, port))
            .await
            .map_err(|error| format!("无法连接 {host}:{port}（{error}）"));
    }
    let via_proxy = socks5_connect(socks_port, host, port).await;
    match via_proxy {
        Ok(stream) => Ok(stream),
        Err(proxy_error) => match TcpStream::connect((host, port)).await {
            Ok(stream) => Ok(stream),
            Err(_) => Err(proxy_error),
        },
    }
}

// ---------------------------------------------------------------------------
// 房间成员（easytier-cli）
// ---------------------------------------------------------------------------

fn json_str<'a>(
    map: &'a serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| map.get(*key))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn json_u32(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u32> {
    keys.iter().find_map(|key| map.get(*key)).and_then(|value| {
        value
            .as_u64()
            .map(|number| number as u32)
            .or_else(|| value.as_f64().map(|number| number.max(0.0).round() as u32))
            .or_else(|| {
                value
                    .as_str()
                    .and_then(|text| text.parse::<f64>().ok())
                    .map(|number| number.max(0.0).round() as u32)
            })
    })
}

fn json_label(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| map.get(*key))
        .map(|value| match value {
            serde_json::Value::String(text) => text.trim().to_string(),
            serde_json::Value::Number(number) => number.to_string(),
            serde_json::Value::Object(inner) => json_label(inner, &["cost", "value", "type"]),
            _ => String::new(),
        })
        .unwrap_or_default()
}

/// EasyTier 不同版本的 JSON 键名略有差异：`ipv4` / `virtual_ipv4`，
/// 字段可能平铺，也可能包在 `peer` + `route` 里。这里只认“有主机名、
/// 有虚拟地址”的对象，避免把路由的下一跳当成另一台设备。
fn peer_from_map(map: &serde_json::Map<String, serde_json::Value>) -> Option<MultiplayerPeer> {
    let ipv4 = json_str(map, &["ipv4", "virtual_ipv4", "virtualIpv4"])?;
    // 某些版本会带 `/24` 前缀，只保留地址本身才能和分享码里的值对上。
    let ipv4 = ipv4.split('/').next().unwrap_or(ipv4).trim();
    if ipv4.is_empty() {
        return None;
    }
    let hostname = json_str(map, &["hostname", "host_name"])?;
    Some(MultiplayerPeer {
        hostname: hostname.to_string(),
        ipv4: ipv4.to_string(),
        latency_ms: json_u32(map, &["lat_ms", "latency_ms"]).unwrap_or(0),
        cost: json_label(map, &["cost"]),
        tunnel: json_label(map, &["tunnel_proto", "tunnel"]),
        is_self: false,
    })
}

fn collect_peers(value: &serde_json::Value, out: &mut Vec<MultiplayerPeer>) {
    match value {
        serde_json::Value::Object(map) => {
            // 常见形状：`{ peer: { hostname, virtual_ipv4 }, lat_ms, cost }`。
            // 延迟和链路类型在外层，主机名和地址在内层。
            if let Some(peer_value) = map.get("peer") {
                if let Some(peer_map) = peer_value.as_object() {
                    if let Some(mut peer) = peer_from_map(peer_map) {
                        peer.latency_ms =
                            json_u32(map, &["lat_ms", "latency_ms"]).unwrap_or(peer.latency_ms);
                        let cost = json_label(map, &["cost"]);
                        if !cost.is_empty() {
                            peer.cost = cost;
                        }
                        let tunnel = json_label(map, &["tunnel_proto", "tunnel"]);
                        if !tunnel.is_empty() {
                            peer.tunnel = tunnel;
                        }
                        out.push(peer);
                        return;
                    }
                }
            }
            if let Some(peer) = peer_from_map(map) {
                out.push(peer);
                return;
            }
            for child in map.values() {
                collect_peers(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_peers(item, out);
            }
        }
        _ => {}
    }
}

fn parse_peer_list(text: &str) -> Result<Vec<MultiplayerPeer>, String> {
    let start = text
        .find(|character| character == '{' || character == '[')
        .ok_or_else(|| "easytier-cli 没有返回 JSON".to_string())?;
    let json = &text[start..];
    let end = json
        .rfind(|character| character == '}' || character == ']')
        .map(|index| index + 1)
        .unwrap_or(json.len());
    let value: serde_json::Value =
        serde_json::from_str(&json[..end]).map_err(|error| format!("解析房间成员失败: {error}"))?;

    let mut raw = Vec::new();
    collect_peers(&value, &mut raw);

    // 同一台设备可能同时出现在 `node_info`、`peer` 和 `route` 里，
    // 按虚拟地址合并；保留信息更全的一条。
    let mut peers: Vec<MultiplayerPeer> = Vec::new();
    for peer in raw {
        if let Some(existing) = peers.iter_mut().find(|item| item.ipv4 == peer.ipv4) {
            if existing.hostname.is_empty() {
                existing.hostname = peer.hostname;
            }
            if existing.latency_ms == 0 {
                existing.latency_ms = peer.latency_ms;
            }
            if existing.cost.is_empty() {
                existing.cost = peer.cost;
            }
            if existing.tunnel.is_empty() {
                existing.tunnel = peer.tunnel;
            }
        } else {
            peers.push(peer);
        }
    }
    Ok(peers)
}

/// 读取房间里的在线设备。只在本机回环上跑 CLI，不对外开放任何接口。
#[tauri::command]
pub async fn get_multiplayer_peers(
    root: String,
    state: tauri::State<'_, MultiplayerState>,
) -> Result<Vec<MultiplayerPeer>, String> {
    let root_path = PathBuf::from(&root);
    let (running, own_ipv4, rpc_port) = {
        let runtime = state
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let running = runtime.pid.is_some()
            && state
                .child
                .lock()
                .map(|child| child.is_some())
                .unwrap_or(false);
        (running, runtime.overlay_ipv4, runtime.rpc_port)
    };
    if !running {
        return Ok(Vec::new());
    }
    let Some(port) = rpc_port else {
        return Err("内核没有开放本机 RPC 端口".to_string());
    };
    let cli = cli_binary(&root_path);
    if !cli.is_file() {
        return Err("当前内核没有附带 easytier-cli，请重新下载内核".to_string());
    }

    let mut command = Command::new(&cli);
    command
        .current_dir(easytier_dir(&root_path))
        .arg("-p")
        .arg(format!("127.0.0.1:{port}"))
        .arg("-o")
        .arg("json")
        .arg("peer")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| "读取房间成员超时".to_string())?
        .map_err(|error| format!("无法运行 easytier-cli: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("easytier-cli 退出码 {:?}", output.status.code())
        } else {
            detail.to_string()
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut peers = parse_peer_list(&stdout)?;
    for peer in &mut peers {
        peer.is_self = own_ipv4.as_deref() == Some(peer.ipv4.as_str());
    }
    peers.sort_by(|left, right| {
        right.is_self.cmp(&left.is_self).then_with(|| {
            left.hostname
                .to_lowercase()
                .cmp(&right.hostname.to_lowercase())
        })
    });
    Ok(peers)
}

// ---------------------------------------------------------------------------
// Windows 防火墙
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// PowerShell 的 `-EncodedCommand` 接受 UTF-16LE 的 Base64；这样路径里的
/// 空格、引号和中文都不会在多层 `Start-Process` 参数里被拆坏。
#[cfg(windows)]
fn encode_powershell(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(windows)]
async fn run_powershell_encoded(script: &str) -> Result<String, String> {
    let encoded = encode_powershell(script);
    let mut command = Command::new("powershell");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .await
        .map_err(|error| format!("无法运行 PowerShell: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.trim();
        return Err(if detail.is_empty() {
            format!("PowerShell 退出码 {:?}", output.status.code())
        } else {
            detail.to_string()
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[cfg(windows)]
fn firewall_variables(
    core: &Path,
    launcher: &Path,
    listen_port: u16,
    host_port: u16,
    overlay: &str,
) -> String {
    let mut script = String::new();
    script.push_str("$ErrorActionPreference = 'SilentlyContinue'\n");
    script.push_str(&format!(
        "$core = {}\n",
        ps_quote(&core.display().to_string())
    ));
    script.push_str(&format!(
        "$launcher = {}\n",
        ps_quote(&launcher.display().to_string())
    ));
    script.push_str(&format!("$listen = '{listen_port}'\n"));
    script.push_str(&format!("$hostPort = {host_port}\n"));
    script.push_str(&format!("$overlay = {}\n", ps_quote(overlay)));
    script
}

#[cfg(windows)]
fn firewall_status_script(
    core: &Path,
    launcher: &Path,
    listen_port: u16,
    host_port: u16,
    overlay: &str,
) -> String {
    let mut script = firewall_variables(core, launcher, listen_port, host_port, overlay);
    script.push_str(
        r#"$profiles = Get-NetFirewallProfile -ErrorAction SilentlyContinue
if ($null -eq $profiles) { 'unknown'; exit }
if (@($profiles | Where-Object { [string]$_.Enabled -eq 'True' }).Count -eq 0) { 'disabled'; exit }
if (@($profiles | Where-Object { [string]$_.AllowInboundRules -eq 'False' }).Count -gt 0) { 'blocked'; exit }
$ok = $true
foreach ($name in @('Cobble EasyTier TCP','Cobble EasyTier UDP')) {
  $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $rule) { $ok = $false; break }
  if ([string]$rule.Enabled -ne 'True' -or [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Allow') { $ok = $false; break }
  $port = $rule | Get-NetFirewallPortFilter
  if ([string]$port.LocalPort -ne $listen) { $ok = $false; break }
}
if ($ok) { 'ready' } else { 'missing' }
"#,
    );
    script
}

#[cfg(windows)]
fn firewall_setup_script(core: &Path, launcher: &Path, listen_port: u16, host_port: u16, overlay: &str) -> String {
    let mut script = firewall_variables(core, launcher, listen_port, host_port, overlay);
    script.push_str("$ErrorActionPreference = 'Stop'\n");
    script.push_str(
        // 无 TUN 模式只需要放行内核自己的监听端口：虚拟网卡上的
        // Minecraft 端口、启动器进程都不再对外开入站。
        r#"foreach ($name in @('Cobble EasyTier TCP','Cobble EasyTier UDP')) {
  Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
}
foreach ($proto in @('TCP','UDP')) {
  New-NetFirewallRule -DisplayName "Cobble EasyTier $proto" -Direction Inbound -Action Allow -Protocol $proto -LocalPort $listen -Profile Any -Enabled True | Out-Null
}
'ok'
"#,
    );
    script
}

#[cfg(windows)]
fn normalize_overlay(overlay: &str) -> &str {
    let overlay = overlay.trim();
    if overlay.parse::<std::net::Ipv4Addr>().is_ok() {
        overlay
    } else {
        ""
    }
}

/// 检查 Windows 防火墙是否已放行 EasyTier 的 TCP/UDP 监听端口，以及
/// 虚拟网卡上的 Minecraft 端口。只读查询，不需要管理员权限。
#[tauri::command]
pub async fn get_multiplayer_firewall_status(
    root: String,
    listen_port: u32,
    host_port: u32,
    overlay_ipv4: String,
) -> Result<MultiplayerFirewallStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (root, listen_port, host_port, overlay_ipv4);
        Ok(MultiplayerFirewallStatus {
            supported: false,
            ready: false,
            detail: "自动放行仅支持 Windows；其他系统请手动允许 TCP/UDP 端口。".to_string(),
        })
    }
    #[cfg(windows)]
    {
        let core = core_binary(&PathBuf::from(&root));
        if !core.is_file() {
            return Ok(MultiplayerFirewallStatus {
                supported: true,
                ready: false,
                detail: "还没有安装 EasyTier 内核".to_string(),
            });
        }
        let overlay = normalize_overlay(&overlay_ipv4);
        let launcher = std::env::current_exe().unwrap_or_default();
        let listen_port = listen_port.clamp(1, 65_535) as u16;
        let host_port = host_port.min(65_535) as u16;
        let script = firewall_status_script(&core, &launcher, listen_port, host_port, overlay);
        match tokio::time::timeout(Duration::from_secs(20), run_powershell_encoded(&script)).await {
            Ok(Ok(text)) => {
                let text = text.trim();
                let disabled = text.eq_ignore_ascii_case("disabled");
                let unknown = text.eq_ignore_ascii_case("unknown");
                let blocked = text.eq_ignore_ascii_case("blocked");
                let ready = disabled || text.eq_ignore_ascii_case("ready");
                Ok(MultiplayerFirewallStatus {
                    supported: true,
                    ready,
                    detail: if disabled {
                        "Windows 防火墙已关闭，无需放行".to_string()
                    } else if blocked {
                        "Windows 防火墙设置了「阻止所有入站连接」，请先在防火墙设置中取消"
                            .to_string()
                    } else if unknown {
                        "无法读取 Windows 防火墙配置，请手动放行 TCP/UDP 端口".to_string()
                    } else if ready {
                        String::new()
                    } else {
                        "Windows 防火墙尚未放行 EasyTier 或房间资源端口".to_string()
                    },
                })
            }
            Ok(Err(error)) => Ok(MultiplayerFirewallStatus {
                supported: true,
                ready: false,
                detail: format!("无法读取 Windows 防火墙：{error}"),
            }),
            Err(_) => Ok(MultiplayerFirewallStatus {
                supported: true,
                ready: false,
                detail: "读取 Windows 防火墙超时".to_string(),
            }),
        }
    }
}

/// 一键写入放行规则：EasyTier 主程序 + 监听端口；房主还额外放行
/// 虚拟地址上的 Minecraft 端口，避免把游戏端口暴露到公网 IPv6。
#[tauri::command]
pub async fn setup_multiplayer_firewall(
    root: String,
    listen_port: u32,
    host_port: u32,
    overlay_ipv4: String,
) -> Result<MultiplayerFirewallStatus, String> {
    #[cfg(not(windows))]
    {
        let _ = (root, listen_port, host_port, overlay_ipv4);
        Err("自动放行仅支持 Windows".to_string())
    }
    #[cfg(windows)]
    {
        let core = core_binary(&PathBuf::from(&root));
        if !core.is_file() {
            return Err("还没有安装 EasyTier 内核，无法放行".to_string());
        }
        let overlay = normalize_overlay(&overlay_ipv4);
        let launcher = std::env::current_exe().unwrap_or_default();
        let listen_port = listen_port.clamp(1, 65_535) as u16;
        let host_port = host_port.min(65_535) as u16;
        let script = firewall_setup_script(&core, &launcher, listen_port, host_port, overlay);
        // 不再弹管理员授权：安装包会在安装时把端口规则写好。启动器
        // 恰好以管理员身份运行时，这里会真的补写缺失的规则。
        run_powershell_encoded(&script).await.map_err(|error| {
            format!("写防火墙规则需要管理员权限（安装版会在安装时自动放行）：{error}")
        })?;

        // UAC 被取消时外部 PowerShell 可能仍然以 0 退出，所以再用只读
        // 查询确认规则真的写进去了。
        let check = firewall_status_script(&core, &launcher, listen_port, host_port, overlay);
        match tokio::time::timeout(Duration::from_secs(20), run_powershell_encoded(&check)).await {
            Ok(Ok(text)) => {
                let text = text.trim();
                let disabled = text.eq_ignore_ascii_case("disabled");
                if disabled || text.eq_ignore_ascii_case("ready") {
                    Ok(MultiplayerFirewallStatus {
                        supported: true,
                        ready: true,
                        detail: if disabled {
                            "Windows 防火墙已关闭，无需放行".to_string()
                        } else {
                            String::new()
                        },
                    })
                } else if text.eq_ignore_ascii_case("blocked") {
                    Err(
                        "Windows 防火墙设置了「阻止所有入站连接」，请先在防火墙设置中取消"
                            .to_string(),
                    )
                } else if text.eq_ignore_ascii_case("unknown") {
                    Err("无法读取 Windows 防火墙配置，请手动放行 TCP/UDP 端口".to_string())
                } else {
                    Err("规则没有生效：当前权限写不进防火墙，请用安装版重新安装一次".to_string())
                }
            }
            Ok(Err(error)) => Err(format!("无法确认防火墙规则：{error}")),
            Err(_) => Err("确认防火墙规则超时".to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// 本机 IPv6 地址
// ---------------------------------------------------------------------------

fn is_global_ipv6(address: &str) -> bool {
    let first = address.split(':').next().unwrap_or("");
    match u16::from_str_radix(first, 16) {
        Ok(value) => (value & 0xe000) == 0x2000,
        Err(_) => false,
    }
}

fn parse_ipv6_lines(text: &str) -> Vec<LocalIpv6Address> {
    let mut found: Vec<LocalIpv6Address> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("fe80") || line.contains("fe80") {
            continue;
        }
        let mut parts = line.split('|');
        let Some(address) = parts
            .next()
            .map(str::trim)
            .filter(|value| value.contains(':'))
        else {
            continue;
        };
        if address == "::1" || address.starts_with("fe80") {
            continue;
        }
        let interface = parts.next().map(str::trim).unwrap_or("").to_string();
        let origin = parts.next().map(str::trim).unwrap_or("");
        let address = address.split('%').next().unwrap_or(address).to_string();
        if found.iter().any(|entry| entry.address == address) {
            continue;
        }
        let global = is_global_ipv6(&address);
        let temporary = origin.eq_ignore_ascii_case("random")
            || origin.eq_ignore_ascii_case("temporary")
            || origin.eq_ignore_ascii_case("true");
        found.push(LocalIpv6Address {
            address,
            interface,
            global,
            temporary,
        });
    }
    // 公网地址在前；同样是公网时，稳定的地址排在临时地址前面。
    found.sort_by_key(|entry| (!entry.global, entry.temporary));
    found
}

#[cfg(windows)]
async fn read_ipv6_addresses() -> String {
    let script = "Get-NetIPAddress -AddressFamily IPv6 | Where-Object { $_.IPAddress -ne '::1' -and $_.IPAddress -notlike 'fe80*' } | ForEach-Object { $_.IPAddress + '|' + $_.InterfaceAlias + '|' + $_.SuffixOrigin }";
    let mut command = Command::new("powershell");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    match command.output().await {
        Ok(output) => String::from_utf8_lossy(&output.stdout).to_string(),
        Err(_) => String::new(),
    }
}

#[cfg(target_os = "linux")]
async fn read_ipv6_addresses() -> String {
    match Command::new("ip")
        .args(["-o", "-6", "addr", "show", "scope", "global"])
        .output()
        .await
    {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut lines = Vec::new();
            for line in text.lines() {
                // `2: eth0    inet6 2001:db8::1/64 scope global ...`
                let mut fields = line.split_whitespace();
                let _index = fields.next();
                let interface = fields.next().unwrap_or("").trim_end_matches(':');
                let mut address = "";
                let mut expect_address = false;
                for field in fields {
                    if expect_address {
                        address = field;
                        break;
                    }
                    if field == "inet6" {
                        expect_address = true;
                    }
                }
                if !address.is_empty() {
                    // `temporary` 是内核为 RFC 4941 地址打的标记。
                    let temporary = line.split_whitespace().any(|field| field == "temporary");
                    lines.push(format!(
                        "{}|{}|{}",
                        address.split('/').next().unwrap_or(address),
                        interface,
                        temporary
                    ));
                }
            }
            lines.join("\n")
        }
        Err(_) => String::new(),
    }
}

#[cfg(target_os = "macos")]
async fn read_ipv6_addresses() -> String {
    match Command::new("ifconfig").output().await {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout);
            let mut lines = Vec::new();
            let mut interface = String::new();
            for line in text.lines() {
                if !line.starts_with(char::is_whitespace) {
                    interface = line.split(':').next().unwrap_or("").to_string();
                    continue;
                }
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("inet6 ") {
                    let address = rest.split_whitespace().next().unwrap_or("");
                    if !address.is_empty() && address != "::1" && !address.starts_with("fe80") {
                        let temporary = trimmed.contains("temporary");
                        lines.push(format!(
                            "{}|{}|{}",
                            address.split('%').next().unwrap_or(address),
                            interface,
                            temporary
                        ));
                    }
                }
            }
            lines.join("\n")
        }
        Err(_) => String::new(),
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
async fn read_ipv6_addresses() -> String {
    String::new()
}

#[tauri::command]
pub async fn get_local_ipv6_addresses() -> Vec<LocalIpv6Address> {
    let text = read_ipv6_addresses().await;
    parse_ipv6_lines(&text)
}

// ---------------------------------------------------------------------------
// Minecraft 服务器列表探测（Server List Ping）
// ---------------------------------------------------------------------------

/// 当前协议版本，只用于握手；服务器会用状态响应里的真实版本来回答。
const PING_PROTOCOL: i32 = 765;

fn write_varint(buffer: &mut Vec<u8>, mut value: i32) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value = ((value as u32) >> 7) as i32;
        if value != 0 {
            byte |= 0x80;
        }
        buffer.push(byte);
        if value == 0 {
            break;
        }
    }
}

fn write_string(buffer: &mut Vec<u8>, text: &str) {
    write_varint(buffer, text.len() as i32);
    buffer.extend_from_slice(text.as_bytes());
}

fn read_varint_from(buffer: &[u8], cursor: &mut usize) -> Option<i32> {
    let mut result = 0i32;
    for shift in 0..5 {
        let byte = *buffer.get(*cursor)?;
        *cursor += 1;
        result |= ((byte & 0x7f) as i32) << (7 * shift);
        if byte & 0x80 == 0 {
            return Some(result);
        }
    }
    None
}

fn strip_format_codes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '§' {
            chars.next();
            continue;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

fn flatten_chat(value: &serde_json::Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(items) = value.as_array() {
        return items.iter().map(flatten_chat).collect::<Vec<_>>().join("");
    }
    if let Some(object) = value.as_object() {
        let mut out = String::new();
        // 1.20.3+ 的组件是 `{"type":"text","text":...}`，旧组件是 `{"text":...}`。
        if let Some(text) = object.get("text").and_then(|item| item.as_str()) {
            out.push_str(text);
        }
        if let Some(extra) = object.get("extra") {
            out.push_str(&flatten_chat(extra));
        }
        return out;
    }
    String::new()
}

fn normalize_host(host: &str) -> String {
    let trimmed = host.trim();
    trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(trimmed)
        .to_string()
}

async fn ping_server(
    host: &str,
    port: u16,
    socks_port: Option<u16>,
) -> Result<MinecraftHostStatus, String> {
    let started = Instant::now();
    let target = normalize_host(host);
    if target.is_empty() {
        return Err("地址不能为空".to_string());
    }

    // 房间里的虚拟地址没有虚拟网卡可走，要借内核的 SOCKS5 入口。
    let connect = async {
        match socks_port {
            Some(proxy) => dial_room(proxy, &target, port).await,
            None => TcpStream::connect((target.as_str(), port))
                .await
                .map_err(|error| format!("无法连接 {target}:{port}（{error}）")),
        }
    };
    let mut stream = match tokio::time::timeout(Duration::from_secs(6), connect).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => return Err(error),
        Err(_) => return Err(format!("连接 {target}:{port} 超时")),
    };
    let _ = stream.set_nodelay(true);

    let mut handshake = Vec::new();
    write_varint(&mut handshake, 0);
    write_varint(&mut handshake, PING_PROTOCOL);
    write_string(&mut handshake, &target);
    handshake.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut handshake, 1);

    let mut packet = Vec::new();
    write_varint(&mut packet, handshake.len() as i32);
    packet.extend_from_slice(&handshake);
    packet.extend_from_slice(&[0x01, 0x00]);

    let io = async {
        stream.write_all(&packet).await?;
        stream.flush().await?;
        let mut length = [0u8; 1];
        stream.read_exact(&mut length).await?;
        // 手写 varint 读取，避免把整个流缓冲进来。
        let mut length_bytes = vec![length[0]];
        while length_bytes.last().is_some_and(|byte| byte & 0x80 != 0) {
            let mut next = [0u8; 1];
            stream.read_exact(&mut next).await?;
            length_bytes.push(next[0]);
        }
        let mut cursor = 0usize;
        let len = read_varint_from(&length_bytes, &mut cursor)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad length"))?;
        if !(1..=2_097_152).contains(&len) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "unreasonable packet length",
            ));
        }
        let mut body = vec![0u8; len as usize];
        stream.read_exact(&mut body).await?;
        Ok::<Vec<u8>, std::io::Error>(body)
    };

    let body = match tokio::time::timeout(Duration::from_secs(5), io).await {
        Ok(Ok(body)) => body,
        Ok(Err(error)) => return Err(format!("读取服务器状态失败（{error}）")),
        Err(_) => return Err("服务器响应超时".to_string()),
    };

    let mut cursor = 0usize;
    let _packet_id = read_varint_from(&body, &mut cursor).ok_or("响应格式无效")?;
    let json_len = read_varint_from(&body, &mut cursor).ok_or("响应格式无效")?;
    if json_len <= 0 || cursor + json_len as usize > body.len() {
        return Err("服务器返回的状态无效".to_string());
    }
    let json = std::str::from_utf8(&body[cursor..cursor + json_len as usize])
        .map_err(|_| "服务器状态不是有效的 UTF-8".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|error| format!("解析服务器状态失败: {error}"))?;

    let motd = value
        .get("description")
        .map(flatten_chat)
        .map(|text| strip_format_codes(&text))
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "Minecraft 服务器".to_string());
    let version = value
        .get("version")
        .and_then(|item| item.get("name"))
        .and_then(|item| item.as_str())
        .unwrap_or("未知版本")
        .to_string();
    let online = value
        .get("players")
        .and_then(|item| item.get("online"))
        .and_then(|item| item.as_u64())
        .unwrap_or(0) as u32;
    let max = value
        .get("players")
        .and_then(|item| item.get("max"))
        .and_then(|item| item.as_u64())
        .unwrap_or(0) as u32;

    Ok(MinecraftHostStatus {
        ok: true,
        motd,
        version,
        online,
        max,
        latency_ms: started.elapsed().as_millis().min(u32::MAX as u128) as u32,
        error: None,
    })
}

/// 从 `tcp://[240e::1]:11010` 这类入口里取出主机和端口。
fn endpoint_host_port(peer: &str) -> Result<(String, u16), String> {
    let normalized = normalize_peer(peer)?;
    let rest = normalized
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(normalized.as_str());
    let rest = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let (host, port) = if let Some(rest) = rest.strip_prefix('[') {
        let Some((host, tail)) = rest.split_once(']') else {
            return Err("IPv6 地址缺少右方括号".to_string());
        };
        let port = tail
            .strip_prefix(':')
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(DEFAULT_LISTEN_PORT);
        (host.to_string(), port)
    } else if let Some((host, port)) = rest.rsplit_once(':') {
        let port = port.parse::<u16>().unwrap_or(DEFAULT_LISTEN_PORT);
        (host.to_string(), port)
    } else {
        (rest.to_string(), DEFAULT_LISTEN_PORT)
    };
    if host.is_empty() {
        return Err("连接地址为空".to_string());
    }
    Ok((host, port))
}

/// 直接探测房主的 EasyTier 监听端口。
///
/// 房主关房后，访客本机的 EasyTier 可能要几次 ping 超时才会把对方
/// 从成员列表里删掉（可能长达几分钟），但房主的监听端口会立刻消失。
/// 这个检查只做一次 TCP 连接，用来判断房间是否还真的开着。
#[tauri::command]
pub async fn probe_multiplayer_endpoint(peer: String) -> Option<bool> {
    let scheme = peer
        .trim()
        .split_once("://")
        .map(|(scheme, _)| scheme.to_ascii_lowercase())
        .unwrap_or_else(|| "tcp".to_string());
    // UDP / WireGuard 入口不能用 TCP 探测，交给成员列表判断。
    if scheme != "tcp" {
        return None;
    }
    let (host, port) = endpoint_host_port(&peer).ok()?;
    let connect = TcpStream::connect((host.as_str(), port));
    Some(matches!(
        tokio::time::timeout(Duration::from_secs(3), connect).await,
        Ok(Ok(_))
    ))
}

/// Minecraft 的「对局域网开放」会写进本次启动的 `logs/latest.log`：
/// 现代版本是 `Started serving on 54321`，旧版是
/// `Local game hosted on port 54321`。`latest.log` 每次启动都会重写，
/// 所以最后一条公告就是当前这一局的端口；看到 `Stopping server`
/// 说明局域网已经关了。
fn lan_port_from_log(text: &str) -> Option<u16> {
    for line in text.lines().rev() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("stopping server") {
            return None;
        }
        for marker in ["started serving on", "local game hosted on port"] {
            let Some(index) = lower.find(marker) else {
                continue;
            };
            let mut tail = line[index + marker.len()..].trim_start();
            if tail
                .get(..4)
                .map(|prefix| prefix.eq_ignore_ascii_case("port"))
                .unwrap_or(false)
            {
                tail = &tail[4..];
            }
            let tail = tail.trim_start_matches(|value: char| value == ':' || value.is_whitespace());
            let digits: String = tail
                .chars()
                .take_while(|value| value.is_ascii_digit())
                .collect();
            if let Ok(port) = digits.parse::<u16>() {
                if port > 0 {
                    return Some(port);
                }
            }
        }
    }
    None
}

/// 只读日志末尾，避免日志变大后每次轮询都把整个文件读一遍。
fn read_lan_log_tail(path: &Path, max_bytes: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(max_bytes);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// 读取当前这一局 Minecraft 对局域网开放的端口。
///
/// 版本隔离会改变游戏目录：`all` 在 `versions/<id>/logs`，`none` 在
/// 根目录的 `logs`，`modded` 则只有模组版本才隔离。直接复用启动时的
/// 目录解析，避免读错日志。
#[tauri::command]
pub async fn read_minecraft_lan_port(
    root: String,
    version_id: String,
    isolation: Option<String>,
) -> Option<u16> {
    if root.trim().is_empty() || version_id.trim().is_empty() {
        return None;
    }
    let game_dir = crate::minecraft::resolve_java_game_dir(
        Path::new(&root),
        version_id.trim(),
        isolation.as_deref(),
    );
    let text = read_lan_log_tail(&game_dir.join("logs").join("latest.log"), 1024 * 1024)?;
    lan_port_from_log(&text)
}

#[tauri::command]
pub async fn probe_minecraft_host(
    host: String,
    port: u16,
    state: tauri::State<'_, MultiplayerState>,
) -> Result<MinecraftHostStatus, String> {
    Ok(
        match ping_server(&host, port, runtime_socks_port(&state)).await {
            Ok(status) => status,
            Err(error) => MinecraftHostStatus {
                ok: false,
                motd: String::new(),
                version: String::new(),
                online: 0,
                max: 0,
                latency_ms: 0,
                error: Some(error),
            },
        },
    )
}

// ---------------------------------------------------------------------------
// 局域网桥接：让远端世界出现在「多人游戏 → 局域网」里
// ---------------------------------------------------------------------------

fn sanitize_lan_text(text: &str) -> String {
    text.replace('[', "(")
        .replace(']', ")")
        .chars()
        .filter(|ch| !ch.is_control())
        .take(120)
        .collect()
}

#[tauri::command]
pub async fn start_lan_bridge(
    app: AppHandle,
    state: tauri::State<'_, MultiplayerState>,
    host: String,
    port: u16,
    motd: Option<String>,
) -> Result<LanBridgeInfo, String> {
    if state
        .runtime
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .pid
        .is_none()
    {
        return Err("请先启动联机网络，再显示好友的世界".to_string());
    }
    let target_host = normalize_host(&host);
    if target_host.is_empty() {
        return Err("地址不能为空".to_string());
    }
    let socks = runtime_socks_port(&state)
        .ok_or_else(|| "联机网络还没启动，先启动网络再显示好友的世界".to_string())?;

    if let Some(existing) = state
        .bridges
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .find(|bridge| bridge.host == target_host && bridge.port == port)
    {
        return Ok(LanBridgeInfo {
            host: existing.host.clone(),
            port: existing.port,
            local_port: existing.local_port,
            connect_address: format!("127.0.0.1:{}", existing.local_port),
        });
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("无法在本机打开代理端口: {error}"))?;
    let local_port = listener
        .local_addr()
        .map_err(|error| format!("无法读取代理端口: {error}"))?
        .port();

    let proxy_app = app.clone();
    let proxy_host = target_host.clone();
    let accept_task = tokio::spawn(async move {
        loop {
            let Ok((inbound, _)) = listener.accept().await else {
                break;
            };
            let host = proxy_host.clone();
            let app = proxy_app.clone();
            tokio::spawn(async move {
                let connect = dial_room(socks, &host, port);
                let Ok(Ok(mut outbound)) =
                    tokio::time::timeout(Duration::from_secs(8), connect).await
                else {
                    emit_log(&app, "proxy", format!("连接 {host}:{port} 失败"));
                    return;
                };
                let mut inbound = inbound;
                let _ = outbound.set_nodelay(true);
                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
            });
        }
    });

    let label = motd
        .as_deref()
        .map(sanitize_lan_text)
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| format!("{target_host} 的世界"));
    let payload = format!("[MOTD]{label}[/MOTD][AD]{local_port}[/AD]");
    let announce_task = tokio::spawn(async move {
        let Ok(socket) = UdpSocket::bind("0.0.0.0:0").await else {
            return;
        };
        let _ = socket.set_broadcast(true);
        loop {
            let _ = socket
                .send_to(payload.as_bytes(), LAN_ANNOUNCE_TARGET)
                .await;
            // 有些系统不回送组播到本机回环，再直接发一份给 127.0.0.1。
            let _ = socket.send_to(payload.as_bytes(), "127.0.0.1:4445").await;
            tokio::time::sleep(LAN_ANNOUNCE_INTERVAL).await;
        }
    });

    state
        .bridges
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .push(LanBridge {
            host: target_host.clone(),
            port,
            local_port,
            tasks: vec![accept_task, announce_task],
        });

    emit_log(
        &app,
        "cobble",
        format!("已在局域网广播 {target_host}:{port}（本机 127.0.0.1:{local_port}）"),
    );

    Ok(LanBridgeInfo {
        host: target_host,
        port,
        local_port,
        connect_address: format!("127.0.0.1:{local_port}"),
    })
}

#[tauri::command]
pub fn stop_lan_bridge(
    app: AppHandle,
    state: tauri::State<'_, MultiplayerState>,
    local_port: u16,
) -> bool {
    let mut bridges = state
        .bridges
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(index) = bridges
        .iter()
        .position(|bridge| bridge.local_port == local_port)
    {
        let bridge = bridges.remove(index);
        for task in bridge.tasks {
            task.abort();
        }
        emit_log(
            &app,
            "cobble",
            format!("已停止局域网广播 127.0.0.1:{local_port}"),
        );
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_wait_errors_do_not_stop_the_kernel() {
        assert!(!kernel_finished(Ok(None)), "内核还在跑");
        assert!(
            !kernel_finished(Err(std::io::Error::other("busy"))),
            "偶发读失败不能当成退出"
        );
    }

    #[test]
    fn varints_round_trip() {
        for value in [0i32, 1, 127, 128, 255, 300, 25565, 2_097_151] {
            let mut buffer = Vec::new();
            write_varint(&mut buffer, value);
            let mut cursor = 0usize;
            assert_eq!(read_varint_from(&buffer, &mut cursor), Some(value));
            assert_eq!(cursor, buffer.len());
        }
    }

    #[test]
    fn chat_components_flatten_to_plain_text() {
        let value: serde_json::Value =
            serde_json::from_str(r#"{"text":"A","extra":[{"text":"B"},{"text":"C"}]}"#).unwrap();
        assert_eq!(flatten_chat(&value), "ABC");
        let legacy: serde_json::Value = serde_json::from_str(r#""§aHello §rworld""#).unwrap();
        assert_eq!(strip_format_codes(&flatten_chat(&legacy)), "Hello world");
    }

    #[test]
    fn ipv6_detection_marks_only_global_unicast() {
        assert!(is_global_ipv6("240e:3b5:1234::1"));
        assert!(is_global_ipv6("2001:db8::1"));
        assert!(!is_global_ipv6("fe80::1"));
        assert!(!is_global_ipv6("fd00::1"));
        assert!(!is_global_ipv6("::1"));
    }
    #[test]
    fn ipv6_output_is_parsed_and_sorted() {
        let text = "fe80::1|以太网|Link\nfd00::5|Tailscale|Random\n240e:3b5::99|WLAN|Random\n240e:3b5::20|WLAN|Link\n240e:3b5::20|WLAN|Link\n::1|Loopback|Other";
        let parsed = parse_ipv6_lines(text);
        assert_eq!(parsed.len(), 3);
        // 稳定的公网地址排最前，临时公网地址次之，内网地址最后。
        assert_eq!(parsed[0].address, "240e:3b5::20");
        assert!(parsed[0].global);
        assert!(!parsed[0].temporary);
        assert_eq!(parsed[1].address, "240e:3b5::99");
        assert!(parsed[1].temporary);
        assert_eq!(parsed[2].address, "fd00::5");
        assert!(!parsed[2].global);
    }

    #[test]
    fn peers_accept_raw_and_uri_forms() {
        assert_eq!(
            normalize_peer("tcp://[240e:3b5::20]:11010").unwrap(),
            "tcp://[240e:3b5::20]:11010"
        );
        assert_eq!(
            normalize_peer("[240e:3b5::20]:11223").unwrap(),
            "tcp://[240e:3b5::20]:11223"
        );
        assert_eq!(
            normalize_peer("240e:3b5::20").unwrap(),
            "tcp://[240e:3b5::20]:11010"
        );
        assert_eq!(
            normalize_peer("public.easytier.cn:11010").unwrap(),
            "tcp://public.easytier.cn:11010"
        );
    }

    #[test]
    fn endpoint_parser_keeps_ipv6_intact() {
        assert_eq!(
            endpoint_host_port("tcp://[240e:3b5::20]:11223").unwrap(),
            ("240e:3b5::20".to_string(), 11223)
        );
        assert_eq!(
            endpoint_host_port("240e:3b5::20").unwrap(),
            ("240e:3b5::20".to_string(), 11010)
        );
        assert_eq!(
            endpoint_host_port("tcp://127.0.0.1:25565").unwrap(),
            ("127.0.0.1".to_string(), 25565)
        );
    }

    /// 房主关房后监听端口会消失；用本地监听器验证探测结果不会看反。
    #[tokio::test]
    async fn endpoint_probe_detects_a_live_listener() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accept = tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        assert_eq!(
            probe_multiplayer_endpoint(format!("tcp://127.0.0.1:{port}")).await,
            Some(true),
            "正在监听的端口应探测成功"
        );
        accept.await.unwrap();
        assert_eq!(
            probe_multiplayer_endpoint(format!("tcp://127.0.0.1:{port}")).await,
            Some(false),
            "监听器关闭后应探测失败"
        );
        assert_eq!(
            probe_multiplayer_endpoint("udp://127.0.0.1:11010".to_string()).await,
            None,
            "UDP 入口不能拿 TCP 结果下结论"
        );
    }

    /// 现代/旧版日志各有一种端口公告；关掉局域网后不能再返回旧端口。
    #[test]
    fn reads_the_lan_port_from_a_minecraft_log() {
        assert_eq!(
            lan_port_from_log("[12:00:00] [Server thread/INFO]: Started serving on 52341"),
            Some(52341)
        );
        assert_eq!(
            lan_port_from_log("[12:00:00] [Server thread/INFO]: Local game hosted on port 25565"),
            Some(25565)
        );
        assert_eq!(
            lan_port_from_log(
                "[12:00:00] [Server thread/INFO]: Started serving on 52341\n[12:10:00] [Server thread/INFO]: Stopping server"
            ),
            None
        );
        // 关掉后重新开放时，最后一条公告才是当前端口。
        assert_eq!(
            lan_port_from_log(
                "[12:00:00] [Server thread/INFO]: Started serving on 52341\n[12:05:00] [Server thread/INFO]: Stopping server\n[12:06:00] [Server thread/INFO]: Started serving on 52342"
            ),
            Some(52342)
        );
    }

    /// 版本隔离为 all 时日志在 versions/<id>/logs；命令要能读到真实文件。
    #[tokio::test]
    async fn reads_the_lan_port_from_the_isolated_game_dir() {
        let root = std::env::temp_dir().join(format!("cobble-lan-log-{}", std::process::id()));
        let logs = root.join("versions").join("1.21.8").join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("latest.log"),
            "[12:00:00] [Server thread/INFO]: Started serving on 52341\n",
        )
        .unwrap();

        assert_eq!(
            read_minecraft_lan_port(
                root.to_string_lossy().to_string(),
                "1.21.8".to_string(),
                Some("all".to_string())
            )
            .await,
            Some(52341)
        );
        assert_eq!(
            read_minecraft_lan_port(
                root.to_string_lossy().to_string(),
                "1.21.8".to_string(),
                Some("none".to_string())
            )
            .await,
            None
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// 只解出两个 exe、缺 Packet.dll 的安装必须算「未就绪」，
    /// 否则开房时内核会在加载阶段退出，房间刚建就显示网络已断开。
    #[test]
    fn incomplete_kernel_install_is_not_ready() {
        let dir = std::env::temp_dir().join(format!(
            "cobble-kernel-check-{}-{}",
            std::process::id(),
            now_millis()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        assert!(!kernel_dir_ok(&dir));
        assert_eq!(missing_kernel_files(&dir).len(), REQUIRED_KERNEL_STEMS.len());

        for stem in REQUIRED_KERNEL_STEMS {
            std::fs::write(dir.join(stem), b"stub").unwrap();
        }
        assert!(kernel_dir_ok(&dir));
        assert!(missing_kernel_files(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lan_payload_cannot_break_the_protocol() {
        assert_eq!(
            sanitize_lan_text("A[/MOTD][AD]1[/AD]"),
            "A(/MOTD)(AD)1(/AD)"
        );
    }

    /// 起一个本地假服务器，确认 Server List Ping 的握手/读取/解析整条链路。
    #[tokio::test]
    async fn reads_a_real_status_packet() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut scratch = [0u8; 512];
            let _ = stream.read(&mut scratch).await;
            let json = r#"{"version":{"name":"1.21.8","protocol":767},"players":{"online":2,"max":8},"description":{"text":"Test World","extra":[{"text":"!"}]}}"#;
            let mut body = Vec::new();
            write_varint(&mut body, 0);
            write_string(&mut body, json);
            let mut packet = Vec::new();
            write_varint(&mut packet, body.len() as i32);
            packet.extend(body);
            let _ = stream.write_all(&packet).await;
        });

        let status = ping_server("127.0.0.1", port, None).await.unwrap();
        assert_eq!(status.motd, "Test World!");
        assert_eq!(status.version, "1.21.8");
        assert_eq!((status.online, status.max), (2, 8));
    }

    /// 房主的权限设置要真的传给内核：带宽上限会落成
    /// `--instance-recv-bps-limit`，0 表示不限；访客才带 `--peers`。
    #[test]
    fn host_bandwidth_limit_reaches_the_core_args() {
        let host = MultiplayerConfig {
            network_name: "cobble-demo".to_string(),
            network_secret: "s3cret-value".to_string(),
            overlay_ipv4: "10.126.126.5".to_string(),
            peers: Vec::new(),
            listen_port: Some(11010),
            recv_bps_limit: Some(1_250_000),
        };
        let host_args = core_args(&host, "tcp://[::]:11010", &[], 15888, 15889);
        let rpc = host_args
            .iter()
            .position(|arg| arg == "--rpc-portal")
            .expect("成员列表要有 RPC 端口");
        assert_eq!(host_args.get(rpc + 1).map(String::as_str), Some("15888"));
        let flag = host_args
            .iter()
            .position(|arg| arg == "--instance-recv-bps-limit")
            .expect("带宽上限要传给内核");
        assert_eq!(host_args.get(flag + 1).map(String::as_str), Some("1250000"));
        assert!(
            !host_args.iter().any(|arg| arg == "--peers"),
            "房主不把自己当访客"
        );

        let mut guest = host.clone();
        guest.recv_bps_limit = Some(0);
        let guest_args = core_args(
            &guest,
            "tcp://[::]:11010",
            &["tcp://[240e:3b5::20]:11010".to_string()],
            15888,
            15889,
        );
        assert!(
            !guest_args
                .iter()
                .any(|arg| arg == "--instance-recv-bps-limit"),
            "不限时不该带这个开关"
        );
        assert!(guest_args.iter().any(|arg| arg == "--peers"));

        // 无 TUN 才能免管理员：三个开关必须在房主/访客两边都带上。
        for args in [&host_args, &guest_args] {
            assert!(args.iter().any(|arg| arg == "--no-tun"), "不能创建虚拟网卡");
            assert!(args.iter().any(|arg| arg == "--use-smoltcp"));
            let socks = args
                .iter()
                .position(|arg| arg == "--socks5")
                .expect("要有本机 SOCKS5 入口");
            assert_eq!(args.get(socks + 1).map(String::as_str), Some("15889"));
        }
    }

    /// 安装包自带的内核能直接展开到游戏目录，不靠网络下载。
    #[test]
    fn bundled_kernel_is_copied_into_the_game_dir() {
        let root =
            std::env::temp_dir().join(format!("cobble-bundle-kernel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let source = root.join("bundle");
        std::fs::create_dir_all(&source).unwrap();
        for stem in REQUIRED_KERNEL_STEMS {
            let name = if cfg!(windows) && !stem.contains('.') {
                format!("{stem}.exe")
            } else {
                stem.to_string()
            };
            std::fs::write(source.join(name), b"stub").unwrap();
        }

        copy_kernel_dir(&source, &easytier_dir(&root)).unwrap();
        assert!(kernel_installed(&root));
        assert_eq!(installed_version(&root).as_deref(), Some(EASYTIER_VERSION));

        // 不完整的“内核包”不能当成安装成功。
        let broken = root.join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("easytier-core.exe"), b"stub").unwrap();
        assert!(copy_kernel_dir(&broken, &root.join("broken-out")).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 无 TUN 模式下访客只能靠内核的 SOCKS5 入口访问房间，
    /// 这里用一个假代理确认握手和目标地址都拼对了。
    #[tokio::test]
    async fn socks5_tunnel_reports_the_requested_target() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(String::new()));
        let recorder = seen.clone();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut greeting = [0u8; 3];
            stream.read_exact(&mut greeting).await.unwrap();
            stream.write_all(&[0x05, 0x00]).await.unwrap();
            let mut head = [0u8; 4];
            stream.read_exact(&mut head).await.unwrap();
            let mut address = [0u8; 4];
            stream.read_exact(&mut address).await.unwrap();
            let mut port_bytes = [0u8; 2];
            stream.read_exact(&mut port_bytes).await.unwrap();
            *recorder.lock().unwrap() = format!(
                "{}.{}.{}.{}:{}",
                address[0],
                address[1],
                address[2],
                address[3],
                u16::from_be_bytes(port_bytes)
            );
            stream
                .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await
                .unwrap();
        });

        let mut tunnel = socks5_connect(port, "10.126.126.7", 25565).await.unwrap();
        tunnel.write_all(b"ping").await.unwrap();
        assert_eq!(*seen.lock().unwrap(), "10.126.126.7:25565");
    }

    /// 启动器被关掉时还在跑的任务，下次打开应该显示成“已中断、可继续”，
    /// 而不是当成本次会话的新任务。
    #[test]
    fn interrupted_install_restores_as_paused_task() {
        let root =
            std::env::temp_dir().join(format!("cobble-easytier-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let running = MultiplayerInstallState {
            active: true,
            stage: "download".to_string(),
            detail: "正在下载".to_string(),
            done_bytes: 4_000_000,
            total_bytes: 32_657_720,
            speed_bps: 400_000,
            threads: 8,
            version: "2.6.4".to_string(),
            started_at: 1,
            ..Default::default()
        };
        save_install_state(&root, &running);

        let restored = load_persisted_install(&root).expect("应该恢复出中断的任务");
        assert!(!restored.active);
        assert_eq!(restored.stage, "paused");
        assert_eq!(restored.done_bytes, 4_000_000);
        assert_eq!(restored.threads, 8);

        // 已完成的旧任务不再占着下载页。
        save_install_state(
            &root,
            &MultiplayerInstallState {
                stage: "done".to_string(),
                ..Default::default()
            },
        );
        assert!(load_persisted_install(&root).is_none());

        // 失败的任务留着，用户可以点重试。
        save_install_state(
            &root,
            &MultiplayerInstallState {
                stage: "error".to_string(),
                error: Some("线路超时".to_string()),
                ..Default::default()
            },
        );
        assert!(load_persisted_install(&root).is_some());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 官方包保留一层目录：内核、CLI、wintun.dll、Packet.dll 必须解出来，
    /// 说明文档丢掉。
    #[test]
    fn extracts_core_and_network_drivers_from_release_zip() {
        use std::io::Write;

        let dir =
            std::env::temp_dir().join(format!("cobble-easytier-extract-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("release.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                (
                    "easytier-windows-x86_64/easytier-core.exe",
                    b"CORE".as_slice(),
                ),
                (
                    "easytier-windows-x86_64/easytier-cli.exe",
                    b"CLI".as_slice(),
                ),
                ("easytier-windows-x86_64/wintun.dll", b"WINTUN".as_slice()),
                ("easytier-windows-x86_64/Packet.dll", b"NPCAP".as_slice()),
                (
                    "easytier-windows-x86_64/WinDivert64.sys",
                    b"DRIVER".as_slice(),
                ),
                ("easytier-windows-x86_64/README.md", b"docs".as_slice()),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(body).unwrap();
            }
            writer.finish().unwrap();
        }

        let out = dir.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let count = extract_binaries(&zip_path, &out).unwrap();
        assert_eq!(count, 5);
        assert!(out.join("easytier-core.exe").is_file());
        assert!(out.join("wintun.dll").is_file());
        assert!(out.join("Packet.dll").is_file());
        assert!(out.join("WinDivert64.sys").is_file());
        assert!(!out.join("README.md").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 防火墙脚本走 `-EncodedCommand`，先确认 UTF-16LE 编码和 PowerShell
    /// 启动链路是通的；这个测试只读，不会改系统防火墙。
    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_encoded_command_round_trips() {
        let output = run_powershell_encoded("'encoded-ok'").await.unwrap();
        assert_eq!(output.trim(), "encoded-ok");
    }

    /// 状态查询脚本必须是只读的，并且能在真实 PowerShell 里跑出四种结果之一。
    #[cfg(windows)]
    #[tokio::test]
    async fn firewall_status_script_is_read_only() {
        let notepad = Path::new(r"C:\Windows\System32\notepad.exe");
        let script = firewall_status_script(notepad, notepad, 59_999, 0, "");
        let output = run_powershell_encoded(&script).await.unwrap();
        assert!(
            matches!(
                output.trim(),
                "ready" | "missing" | "disabled" | "blocked" | "unknown"
            ),
            "unexpected firewall status: {output}"
        );
    }

    /// EasyTier 2.6 的 JSON 外层是 `node_info` + `peer_routes`，延迟在
    /// 条目外层、主机名和虚拟地址在 `peer` 里；路由里的重复项要合并掉。
    #[test]
    fn parses_peer_list_from_cli_json() {
        let json = r#"{
            "node_info": { "hostname": "cobble-host", "virtual_ipv4": "10.126.126.5" },
            "peer_routes": [
                {
                    "peer": { "hostname": "MCTier-Studio", "virtual_ipv4": "10.126.126.7" },
                    "lat_ms": 18.4,
                    "cost": "p2p",
                    "tunnel_proto": "udp"
                },
                {
                    "route": { "hostname": "MCTier-Studio", "virtual_ipv4": "10.126.126.7" },
                    "lat_ms": 18.4
                }
            ]
        }"#;
        let peers = parse_peer_list(json).unwrap();
        assert_eq!(peers.len(), 2);
        assert!(peers
            .iter()
            .any(|peer| peer.hostname == "cobble-host" && peer.ipv4 == "10.126.126.5"));
        let guest = peers
            .iter()
            .find(|peer| peer.hostname == "MCTier-Studio")
            .expect("访客要在列表里");
        assert_eq!(guest.ipv4, "10.126.126.7");
        assert_eq!(guest.latency_ms, 18);
        assert_eq!(guest.cost, "p2p");
        assert_eq!(guest.tunnel, "udp");
    }

    /// 房主的资源快照按版本目录读取，且停用的模组/光影仍要列出来，
    /// 这样访客看到的是和房主一致的清单。
    #[test]
    fn scans_room_resources_for_the_selected_version() {
        let root = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!(
                "cobble-room-resources-{}-{}",
                std::process::id(),
                now_millis()
            ));
        let _ = std::fs::remove_dir_all(&root);
        let instance = root.join("versions").join("1.21.1");
        for dir in ["mods", "shaderpacks", "resourcepacks"] {
            std::fs::create_dir_all(instance.join(dir)).unwrap();
        }
        std::fs::write(instance.join("mods/Sodium.jar"), b"mod").unwrap();
        std::fs::write(instance.join("mods/Disabled.jar.disabled"), b"mod").unwrap();
        std::fs::write(instance.join("mods/readme.txt"), b"ignore").unwrap();
        std::fs::write(instance.join("shaderpacks/BSL.zip"), b"shader").unwrap();
        std::fs::write(instance.join("shaderpacks/Off.zip.disabled"), b"shader").unwrap();
        std::fs::write(instance.join("resourcepacks/Faithful.zip"), b"pack").unwrap();

        let resources = scan_room_resources(&root, "1.21.1", Some("all"));
        assert_eq!(resources.version_id, "1.21.1");
        assert_eq!(resources.mods.len(), 2);
        assert!(resources.mods.iter().any(|item| item.name == "Sodium" && item.enabled));
        assert!(resources
            .mods
            .iter()
            .any(|item| item.name == "Disabled" && !item.enabled));
        assert_eq!(resources.shaders.len(), 2);
        assert!(resources.shaders.iter().any(|item| item.name == "BSL" && item.enabled));
        assert!(resources.shaders.iter().any(|item| !item.enabled));
        assert_eq!(resources.resource_packs.len(), 1);
        assert_eq!(resources.resource_packs[0].file_name, "Faithful.zip");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 资源服务只能拿到清单，不能拿任意路径；错误令牌必须是 403。
    #[tokio::test]
    async fn room_resource_server_requires_the_share_token() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "abcdef123456".to_string();
        let manifest = Arc::new(Mutex::new(r#"{"versionId":"1.21.1"}"#.to_string()));
        let task = tokio::spawn(serve_room_resources(listener, token.clone(), manifest));
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();

        let ok = client
            .get(format!("http://127.0.0.1:{port}/room.json?key={token}"))
            .send()
            .await
            .unwrap();
        assert!(ok.status().is_success());
        assert!(ok.text().await.unwrap().contains("1.21.1"));

        let denied = client
            .get(format!("http://127.0.0.1:{port}/room.json?key=wrong-token"))
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status().as_u16(), 403);

        task.abort();
    }

    /// 访客侧命令能解析房主返回的 JSON，并且令牌不对时不会读到清单。
    #[tokio::test]
    async fn fetches_room_resources_through_the_token_endpoint() {
        let resources = RoomResources {
            version_id: "1.21.1".to_string(),
            host_port: Some(25565),
            mods: vec![RoomResourceItem {
                name: "Sodium".to_string(),
                file_name: "Sodium.jar".to_string(),
                enabled: true,
                size: 10,
            }],
            shaders: Vec::new(),
            resource_packs: Vec::new(),
            updated_at: 1,
        };
        let manifest = Arc::new(Mutex::new(serde_json::to_string(&resources).unwrap()));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = "abcdef123456".to_string();
        let task = tokio::spawn(serve_room_resources(
            listener,
            token.clone(),
            manifest,
        ));

        // 本机回环不走代理，所以这里传 0 也能直接连到假房主。
        let fetched = fetch_room_resources_inner("127.0.0.1".to_string(), port, token, 0)
            .await
            .unwrap();
        assert_eq!(fetched.version_id, "1.21.1");
        assert_eq!(fetched.mods.len(), 1);
        assert_eq!(fetched.mods[0].name, "Sodium");
        // 只输 IPv6 的访客就是从这一项认出房主的局域网端口的。
        assert_eq!(fetched.host_port, Some(25565));

        let denied = fetch_room_resources_inner(
            "127.0.0.1".to_string(),
            port,
            "wrongtoken123".to_string(),
            0,
        )
        .await;
        assert!(denied.is_err());

        task.abort();
    }

    /// 旧房主（或旧版启动器）的清单里没有 `hostPort`，解析不能因此失败。
    #[test]
    fn room_manifest_without_host_port_still_parses() {
        let json = r#"{
            "versionId": "1.21.1",
            "mods": [],
            "shaders": [],
            "resourcePacks": [],
            "updatedAt": 7
        }"#;
        let parsed: RoomResources = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.version_id, "1.21.1");
        assert_eq!(parsed.host_port, None);

        // 有端口时序列化成 camelCase，访客兜底读的就是这个键。
        let mut with_port = parsed;
        with_port.host_port = Some(25566);
        let text = serde_json::to_string(&with_port).unwrap();
        assert!(text.contains("\"hostPort\":25566"), "{text}");
    }

    /// 多实例输出是 `[{ instance_id, result: { ... } }]`，不能因此漏掉成员。
    #[test]
    fn parses_peer_list_from_wrapped_instances() {
        let json = r#"[
            {
                "instance_id": "a1",
                "instance_name": "default",
                "result": {
                    "peer_routes": [
                        { "peer": { "hostname": "Steam-Deck", "ipv4": "10.126.126.9" }, "lat_ms": 42, "cost": "relay" }
                    ]
                }
            }
        ]"#;
        let peers = parse_peer_list(json).unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].hostname, "Steam-Deck");
        assert_eq!(peers[0].ipv4, "10.126.126.9");
        assert_eq!(peers[0].latency_ms, 42);
        assert_eq!(peers[0].cost, "relay");
    }
}
