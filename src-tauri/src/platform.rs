//! Windows 老系统兼容性检查。
//!
//! 启动器基于 Tauri 2 + WebView2。WebView2 运行时只提供 Windows 10 及以上
//! 版本；微软从 Edge 109 起停止了对 Windows 7 / 8 / 8.1 的支持，Tauri 2.12
//! 也正式移除了 Windows 7 支持（新版 WebView2 安装器在 Win7 上直接加载失败）。
//! 在 XP / Vista / 7 / 8 / 8.1 上运行时窗口根本创建不出来，而 release 构建
//! 没有控制台，用户只会看到「双击了没反应」。
//!
//! 这里在创建窗口之前先检查系统版本与 WebView2 运行时，用系统消息框把原因
//! 和处理办法直接告诉用户。设置 `OSML_SKIP_COMPAT_CHECK=1` 可跳过检查。

/// WebView2 运行时的产品 GUID（微软文档里的固定值）。
const WEBVIEW2_CLIENT: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// 微软官方的 WebView2 常青版下载入口。
#[cfg(windows)]
const WEBVIEW2_DOWNLOAD: &str = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

#[cfg(windows)]
const MB_OK: u32 = 0x0000_0000;
#[cfg(windows)]
const MB_YESNO: u32 = 0x0000_0004;
#[cfg(windows)]
const MB_ICONERROR: u32 = 0x0000_0010;
#[cfg(windows)]
const MB_ICONWARNING: u32 = 0x0000_0030;
#[cfg(windows)]
const IDYES: i32 = 6;

/// 特殊环境（例如塞了固定版本运行时的旧系统）可以跳过检查。
pub fn skip_requested() -> bool {
    matches!(
        std::env::var("OSML_SKIP_COMPAT_CHECK"),
        Ok(value) if value == "1" || value.eq_ignore_ascii_case("true")
    )
}

/// 启动前检查：返回 `false` 表示已经提示过用户，不要再创建窗口。
pub fn run_checks() -> bool {
    if skip_requested() {
        return true;
    }

    #[cfg(not(windows))]
    {
        true
    }

    #[cfg(windows)]
    {
        match windows_version() {
            Some((major, _, _)) if major >= 10 => {}
            Some((major, minor, build)) => {
                let text = format!(
                    "当前系统：{}\n\n\
                     启动器基于 Tauri 2 与 Microsoft Edge WebView2 构建，官方只支持 \
                     Windows 10 / 11（64 位）。\n\n\
                     Windows XP、Vista、7、8、8.1 已经没有可用的 WebView2 运行时：\
                     微软从 Edge 109 起停止为这些系统更新 WebView2，Tauri 2.12 也正式\
                     移除了 Windows 7 支持，窗口在这些系统上无法创建。\n\n\
                     请升级到 Windows 10 或 Windows 11 后再使用。",
                    version_label(major, minor, build)
                );
                message_box("无法在这个 Windows 版本上运行", &text, MB_OK | MB_ICONERROR);
                return false;
            }
            // 读不到版本号时不拦，交给 Tauri 自己尝试，避免误伤。
            None => {}
        }

        if webview2_version().is_none() {
            let text = "启动器需要 Microsoft Edge WebView2 运行时，但当前系统里没有检测到它。\n\n\
                        它是 Windows 10 / 11 上的系统组件，缺失时启动器无法创建窗口。\n\n\
                        点击「是」打开微软官方下载页面，安装完成后重新打开启动器即可。";
            if message_box("缺少 WebView2 运行时", text, MB_YESNO | MB_ICONWARNING) == IDYES {
                open_url(WEBVIEW2_DOWNLOAD);
            }
            return false;
        }

        true
    }
}

/// 给界面和日志用的系统名称，例如 `Windows 11（10.0.26100）`。
pub fn os_label() -> String {
    #[cfg(windows)]
    {
        if let Some((major, minor, build)) = windows_version() {
            return version_label(major, minor, build);
        }
        return "Windows".to_string();
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("sw_vers").arg("-productVersion").output() {
            let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !ver.is_empty() {
                return format!("macOS {ver}");
            }
        }
        return "macOS".to_string();
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            for line in content.lines() {
                if let Some(val) = line.strip_prefix("PRETTY_NAME=") {
                    return val.trim_matches('"').trim().to_string();
                }
            }
        }
        return "Linux".to_string();
    }
    #[allow(unreachable_code)]
    std::env::consts::OS.to_string()
}

/// Windows 版本号；读不到时返回 `None`。
#[cfg(windows)]
pub fn windows_version() -> Option<(u32, u32, u32)> {
    #[repr(C)]
    struct OsVersionInfoW {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform_id: u32,
        csd_version: [u16; 128],
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        /// `GetVersionEx` 会按兼容性清单撒谎，`RtlGetVersion` 拿到的才是真实版本。
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }

    let mut info = OsVersionInfoW {
        size: std::mem::size_of::<OsVersionInfoW>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform_id: 0,
        csd_version: [0; 128],
    };
    // SAFETY: 结构体布局与 RtlGetVersion 期望的 RTL_OSVERSIONINFOW 一致，
    // `size` 已按该结构体大小初始化，指针指向栈上有效内存。
    let status = unsafe { RtlGetVersion(&mut info) };
    if status < 0 {
        return None;
    }
    Some((info.major, info.minor, info.build))
}

/// 把版本号换成用户看得懂的系统名称。
#[cfg_attr(not(windows), allow(dead_code))]
fn version_label(major: u32, minor: u32, build: u32) -> String {
    let name = match (major, minor) {
        (5, 0) => "Windows 2000",
        (5, 1) => "Windows XP",
        (5, 2) => "Windows XP x64 / Server 2003",
        (6, 0) => "Windows Vista",
        (6, 1) => "Windows 7",
        (6, 2) => "Windows 8",
        (6, 3) => "Windows 8.1",
        (10, _) if build >= 22000 => "Windows 11",
        (10, _) => "Windows 10",
        _ => "Windows",
    };
    format!("{name}（{major}.{minor}.{build}）")
}

/// 已安装的 WebView2 运行时版本；没有安装时返回 `None`。
pub fn webview2_version() -> Option<String> {
    #[cfg(windows)]
    {
        // 注册表是官方推荐的做法：每机器安装（64 位视图 / 32 位视图）与每用户安装
        // 各有一个位置。
        for key in [
            format!(r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"),
            format!(r"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"),
            format!(r"HKCU\Software\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"),
        ] {
            if let Some(version) = reg_query_pv(&key) {
                return Some(version);
            }
        }
        // 注册表被清理工具写坏时，退回检查运行时目录。
        runtime_folder_version()
    }

    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn reg_query_pv(key: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let output = Command::new("reg.exe")
        .args(["query", key, "/v", "pv"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_pv(&String::from_utf8_lossy(&output.stdout))
}

/// 从 `reg query` 的输出里取出 `pv` 的值。
///
/// 输出形如 `    pv    REG_SZ    120.0.2210.91`。这里不依赖值类型名，只认
/// 「以数字和点组成」的最后一个字段，免得受系统语言影响。
fn parse_pv(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("pv ") && !trimmed.starts_with("pv\t") {
            continue;
        }
        let value = trimmed.split_whitespace().last()?;
        if !value.contains('.') || !value.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
            continue;
        }
        // `0.0.0.0` 是微软约定的「未安装」。
        if value == "0.0.0.0" {
            return None;
        }
        return Some(value.to_string());
    }
    None
}

#[cfg(windows)]
fn runtime_folder_version() -> Option<String> {
    use std::path::PathBuf;

    let mut roots = Vec::new();
    for variable in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(variable) {
            roots.push(
                PathBuf::from(base)
                    .join("Microsoft")
                    .join("EdgeWebView")
                    .join("Application"),
            );
        }
    }

    let mut best: Option<(Vec<u32>, String)> = None;
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.join("msedgewebview2.exe").is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let parts: Vec<u32> = name
                .split('.')
                .filter_map(|part| part.parse::<u32>().ok())
                .collect();
            if parts.len() != 4 {
                continue;
            }
            if best.as_ref().is_none_or(|(current, _)| parts > *current) {
                best = Some((parts, name));
            }
        }
    }
    best.map(|(_, name)| name)
}

#[cfg(windows)]
fn wide(text: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(windows)]
fn message_box(title: &str, text: &str, flags: u32) -> i32 {
    #[link(name = "user32")]
    unsafe extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            flags: u32,
        ) -> i32;
    }

    // 调试构建时也写到终端，方便开发时定位。
    if cfg!(debug_assertions) {
        eprintln!("[兼容性检查] {title}: {text}");
    }
    let text = wide(text);
    let title = wide(title);
    // SAFETY: 两个指针都指向以 0 结尾的有效 UTF-16 缓冲区，调用期间一直存活。
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), flags) }
}

#[cfg(windows)]
fn open_url(url: &str) {
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn ShellExecuteW(
            hwnd: *mut core::ffi::c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show: i32,
        ) -> isize;
    }

    let operation = wide("open");
    let url = wide(url);
    // SAFETY: 字符串指针都以 0 结尾且在调用期间存活；其余参数允许为空。
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // SW_SHOWNORMAL
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_windows_names_are_explained() {
        assert!(version_label(5, 1, 2600).starts_with("Windows XP"));
        assert!(version_label(6, 1, 7601).starts_with("Windows 7"));
        assert!(version_label(6, 3, 9600).starts_with("Windows 8.1"));
        assert!(version_label(10, 0, 19045).starts_with("Windows 10"));
        assert!(version_label(10, 0, 26100).starts_with("Windows 11"));
    }

    #[test]
    fn parses_the_installed_runtime_version() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\...\r\n    pv    REG_SZ    120.0.2210.91\r\n\r\n";
        assert_eq!(parse_pv(output), Some("120.0.2210.91".to_string()));
    }

    #[test]
    fn treats_placeholder_and_missing_values_as_not_installed() {
        assert_eq!(parse_pv("    pv    REG_SZ    0.0.0.0\r\n"), None);
        assert_eq!(parse_pv("错误: 系统找不到指定的注册表项或值。\r\n"), None);
    }
}
