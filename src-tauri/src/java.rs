use std::time::SystemTime;

static PROBED_JAVA_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, (SystemTime, JavaInstall)>>,
> = std::sync::OnceLock::new();

fn probe_cache()
-> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, (SystemTime, JavaInstall)>> {
    PROBED_JAVA_CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}
use crate::net;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static JAVA_CACHE: Mutex<Option<(Instant, PathBuf, Vec<JavaInstall>)>> = Mutex::new(None);

/// Result of probing whether a Java binary accepts a set of tuning flags.
/// Vendor JVMs (OpenJ9, some embedded runtimes) reject HotSpot-only options and
/// exit before Minecraft starts, so the launcher must ask instead of assuming.
static JVM_FLAG_SUPPORT: std::sync::OnceLock<
    Mutex<std::collections::HashMap<(PathBuf, String), bool>>,
> = std::sync::OnceLock::new();

fn jvm_flag_cache() -> &'static Mutex<std::collections::HashMap<(PathBuf, String), bool>> {
    JVM_FLAG_SUPPORT.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Installing the same runtime twice at once used to let one task delete the
/// extraction directory while the other was still writing into it, leaving a
/// half-populated JRE that later launches treated as valid. Serialise runtime
/// provisioning; the download is rare enough that the extra wait is invisible.
static JAVA_INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstall {
    pub path: String,
    pub major: u32,
    pub version: String,
    pub source: String,
    #[serde(default)]
    pub is_64bit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaProgress {
    pub stage: String,
    pub done: u64,
    pub total: u64,
    pub detail: String,
}

pub type JavaProgressFn = Arc<dyn Fn(JavaProgress) + Send + Sync>;

#[derive(Deserialize)]
struct AdoptiumRelease {
    binary: AdoptiumBinary,
    version: AdoptiumVersion,
}

#[derive(Deserialize)]
struct AdoptiumBinary {
    package: AdoptiumPackage,
}

#[derive(Deserialize)]
struct AdoptiumPackage {
    link: String,
    name: String,
    size: Option<u64>,
}

#[derive(Deserialize)]
struct AdoptiumVersion {
    semver: Option<String>,
}

fn java_exe() -> &'static str {
    if cfg!(windows) { "java.exe" } else { "java" }
}

pub fn clean_java_env(cmd: &mut Command) {
    cmd.env_remove("_JAVA_OPTIONS");
    cmd.env_remove("JAVA_TOOL_OPTIONS");
    cmd.env_remove("JAVA_OPTIONS");
    cmd.env_remove("IBM_JAVA_OPTIONS");
}

fn no_window(cmd: &mut Command) {
    clean_java_env(cmd);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

pub fn probe_java(path: &Path, source: &str) -> Option<JavaInstall> {
    let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    if let Ok(guard) = probe_cache().lock() {
        if let Some((cached_mtime, install)) = guard.get(path) {
            if *cached_mtime == mtime {
                let mut res = install.clone();
                res.source = source.to_string();
                return Some(res);
            }
        }
    }

    let mut cmd = Command::new(path);
    cmd.arg("-version");
    no_window(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let marker = "version \"";
    let start = text.find(marker)? + marker.len();
    let end = text[start..].find('"')? + start;
    let version = text[start..end].to_string();
    let mut parts = version.split(['.', '_', '-', '+']);
    let first = parts.next()?;
    let major: u32 = if first == "1" {
        parts.next()?.parse().ok()?
    } else {
        first.parse().ok()?
    };

    let lower_text = text.to_ascii_lowercase();
    let path_lower = path.to_string_lossy().to_ascii_lowercase();
    let is_x86_dir = path_lower.contains("program files (x86)") || path_lower.contains("syswow64");
    let is_64bit = if lower_text.contains("64-bit")
        || lower_text.contains("x86_64")
        || lower_text.contains("amd64")
        || lower_text.contains("aarch64")
        || lower_text.contains("arm64")
    {
        true
    } else if is_x86_dir || lower_text.contains("client vm") || lower_text.contains("32-bit") {
        false
    } else {
        !cfg!(windows) && cfg!(target_pointer_width = "64")
    };

    let install = JavaInstall {
        path: path.to_string_lossy().to_string(),
        major,
        version,
        source: source.to_string(),
        is_64bit,
    };
    if let Ok(mut guard) = probe_cache().lock() {
        guard.insert(path.to_path_buf(), (mtime, install.clone()));
    }
    Some(install)
}

fn add_candidate(list: &mut Vec<(PathBuf, &'static str)>, path: PathBuf, source: &'static str) {
    if path.is_file() {
        list.push((path, source));
    }
}

#[cfg(windows)]
fn add_bin_candidates(
    list: &mut Vec<(PathBuf, &'static str)>,
    base: &Path,
    source: &'static str,
    depth: u8,
) {
    if depth == 0 || !base.is_dir() {
        return;
    }
    add_candidate(list, base.join("bin").join(java_exe()), source);
    if depth == 1 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            add_candidate(list, path.join("bin").join(java_exe()), source);
        }
    }
}

#[cfg(not(windows))]
fn add_unix_candidates(list: &mut Vec<(PathBuf, &'static str)>, base: &Path, source: &'static str) {
    if !base.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Linux / Unix standard: <jdk>/bin/java
            add_candidate(list, path.join("bin").join(java_exe()), source);
            // macOS bundle standard: <jdk>.jdk/Contents/Home/bin/java
            add_candidate(
                list,
                path.join("Contents")
                    .join("Home")
                    .join("bin")
                    .join(java_exe()),
                source,
            );
        }
    }
}

fn candidate_paths(root: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut list: Vec<(PathBuf, &'static str)> = Vec::new();

    if let Ok(home) = std::env::var("JAVA_HOME") {
        add_candidate(
            &mut list,
            PathBuf::from(home).join("bin").join(java_exe()),
            "JAVA_HOME",
        );
    }

    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            add_candidate(&mut list, dir.join(java_exe()), "PATH");
        }
    }

    let managed = root.join("runtime");
    for (path, source) in find_all_java(&managed, 5) {
        list.push((path, source));
    }

    #[cfg(windows)]
    {
        let mut bases: Vec<PathBuf> = Vec::new();
        for var in ["ProgramFiles", "ProgramW6432"] {
            if let Ok(dir) = std::env::var(var) {
                let base = PathBuf::from(dir);
                bases.push(base.join("Java"));
                bases.push(base.join("Eclipse Adoptium"));
                bases.push(base.join("Microsoft"));
                bases.push(base.join("Zulu"));
                bases.push(base.join("BellSoft"));
                bases.push(base.join("Amazon Corretto"));
                bases.push(base.join("Semeru"));
                bases.push(base.join("GraalVM"));
                bases.push(base.join("Common Files").join("Oracle").join("Java"));
            }
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let base = PathBuf::from(local);
            bases.push(base.join("Programs").join("Eclipse Adoptium"));
            bases.push(base.join("Programs").join("Java"));
            bases.push(base.join("Programs").join("Microsoft"));
            bases.push(base.join("Programs").join("Zulu"));
            bases.push(base.join("Programs").join("Amazon Corretto"));
            bases.push(base.join("JetBrains"));
            bases.push(base.join("Programs").join("IntelliJ IDEA"));
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            let base = PathBuf::from(home);
            bases.push(base.join(".jdks"));
            bases.push(base.join("scoop").join("apps"));
            bases.push(base.join("AppData").join("Local").join("Programs"));
        }
        for base in bases {
            add_bin_candidates(&mut list, &base, "系统安装", 2);
        }
        // javapath shims on older Oracle installs
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            add_candidate(
                &mut list,
                PathBuf::from(program_files)
                    .join("Common Files")
                    .join("Oracle")
                    .join("Java")
                    .join("javapath")
                    .join("java.exe"),
                "系统安装",
            );
        }
    }

    #[cfg(not(windows))]
    {
        let mac_home = PathBuf::from("/Library/Java/JavaVirtualMachines");
        add_unix_candidates(&mut list, &mac_home, "系统安装");
        add_unix_candidates(&mut list, Path::new("/usr/lib/jvm"), "系统安装");
        if let Ok(home) = std::env::var("HOME") {
            let base = PathBuf::from(home);
            add_unix_candidates(&mut list, &base.join(".jdks"), "系统安装");
            add_unix_candidates(
                &mut list,
                &base
                    .join("Library")
                    .join("Java")
                    .join("JavaVirtualMachines"),
                "系统安装",
            );
            add_unix_candidates(
                &mut list,
                &base.join(".sdkman").join("candidates").join("java"),
                "系统安装",
            );
        }
        add_candidate(&mut list, PathBuf::from("/usr/bin/java"), "系统安装");
        add_candidate(&mut list, PathBuf::from("/usr/local/bin/java"), "系统安装");

        // macOS Homebrew OpenJDK paths
        for brew_base in ["/opt/homebrew/opt", "/usr/local/opt"] {
            let base = Path::new(brew_base);
            for name in [
                "openjdk",
                "openjdk@17",
                "openjdk@21",
                "openjdk@11",
                "openjdk@8",
            ] {
                add_candidate(
                    &mut list,
                    base.join(name).join("bin").join(java_exe()),
                    "系统安装",
                );
                add_candidate(
                    &mut list,
                    base.join(name)
                        .join("libexec")
                        .join("openjdk.jdk")
                        .join("Contents")
                        .join("Home")
                        .join("bin")
                        .join(java_exe()),
                    "系统安装",
                );
            }
        }

        // Additional Linux paths
        add_unix_candidates(&mut list, Path::new("/usr/lib64/jvm"), "系统安装");
        add_candidate(
            &mut list,
            PathBuf::from("/etc/alternatives/java"),
            "系统安装",
        );
    }

    list
}

fn find_all_java(dir: &Path, depth: u8) -> Vec<(PathBuf, &'static str)> {
    let mut found = Vec::new();
    if depth == 0 || !dir.is_dir() {
        return found;
    }
    add_candidate(
        &mut found,
        dir.join("bin").join(java_exe()),
        "Cobble 运行时",
    );
    let Ok(entries) = std::fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(find_all_java(&path, depth - 1));
        }
    }
    found
}

pub fn detect_java_installations(root: &Path) -> Vec<JavaInstall> {
    let root = net::absolute_path(root);

    if let Ok(guard) = JAVA_CACHE.lock() {
        if let Some((timestamp, ref cached_root, ref cached_installs)) = *guard {
            if cached_root == &root && timestamp.elapsed() < Duration::from_secs(300) {
                return cached_installs.clone();
            }
        }
    }

    let candidates = candidate_paths(&root);
    let mut seen_paths = HashSet::new();
    let mut unique_candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    for (path, source) in candidates {
        let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen_paths.insert(key) {
            unique_candidates.push((path, source));
        }
    }

    let installs = std::thread::scope(|s| {
        let handles: Vec<_> = unique_candidates
            .into_iter()
            .map(|(path, source)| s.spawn(move || probe_java(&path, source)))
            .collect();
        let mut results = Vec::new();
        for h in handles {
            if let Ok(Some(install)) = h.join() {
                results.push(install);
            }
        }
        results
    });

    let mut sorted = installs;
    sorted.sort_by(|a, b| {
        b.is_64bit
            .cmp(&a.is_64bit)
            .then_with(|| b.major.cmp(&a.major))
            .then_with(|| a.path.cmp(&b.path))
    });

    if let Ok(mut guard) = JAVA_CACHE.lock() {
        *guard = Some((Instant::now(), root, sorted.clone()));
    }

    sorted
}

/// Checks the selected Java once per process with the exact flags the launcher
/// intends to add. A rejected flag set means "launch without tuning" instead of
/// a hard exit code 1 with no game log.
pub fn jvm_flags_supported(java: &Path, flags: &[&str]) -> bool {
    if flags.is_empty() {
        return true;
    }
    let key = std::fs::canonicalize(java).unwrap_or_else(|_| java.to_path_buf());
    let cache_key = (key, flags.join(" "));
    if let Ok(cache) = jvm_flag_cache().lock() {
        if let Some(supported) = cache.get(&cache_key) {
            return *supported;
        }
    }

    let mut command = Command::new(java);
    clean_java_env(&mut command);
    command
        .args(flags)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let supported = match command.spawn() {
        Ok(mut child) => {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => break status.success(),
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break false;
                    }
                }
            }
        }
        Err(_) => false,
    };

    if let Ok(mut cache) = jvm_flag_cache().lock() {
        cache.insert(cache_key, supported);
    }
    supported
}

pub fn find_managed_java(root: &Path, major: u32) -> Option<PathBuf> {
    let dir = root.join("runtime").join(format!("temurin-{major}"));
    let found = find_all_java(&dir, 5);
    found.into_iter().map(|(path, _)| path).find(|path| {
        probe_java(path, "Cobble 运行时")
            .map(|install| install.major == major)
            .unwrap_or(false)
    })
}

fn adoptium_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

fn adoptium_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "aarch64",
        "x86" => "x86",
        _ => "x64",
    }
}

async fn fetch_adoptium_release(major: u32) -> Result<AdoptiumRelease, String> {
    let url = format!(
        "https://api.adoptium.net/v3/assets/latest/{major}/hotspot?architecture={}&image_type=jre&os={}&vendor=eclipse",
        adoptium_arch(),
        adoptium_os()
    );
    let releases = net::client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("无法连接 Java 下载服务: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Java 下载服务返回错误: {e}"))?
        .json::<Vec<AdoptiumRelease>>()
        .await
        .map_err(|e| format!("无法解析 Java 下载信息: {e}"))?;
    releases
        .into_iter()
        .next()
        .ok_or_else(|| format!("找不到适用于当前系统的 Java {major} 运行时"))
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("无法打开 Java 压缩包: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("无法读取 Java 压缩包: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("无法解压 Java 运行时: {e}"))?;
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        let out = dest.join(path);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败: {e}"))?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            let mut writer =
                std::fs::File::create(&out).map_err(|e| format!("写入 Java 文件失败: {e}"))?;
            std::io::copy(&mut entry, &mut writer)
                .map_err(|e| format!("解压 Java 运行时失败: {e}"))?;
        }
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("无法打开 Java 压缩包: {e}"))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(dest)
        .map_err(|e| format!("解压 Java 运行时失败: {e}"))?;
    Ok(())
}

/// Whether `runtime` can run a version whose metadata asks for `required`.
///
/// Class files are forward compatible, so a newer Java can always *load* the
/// game. In practice versions that need Java 16+ (1.17+) run fine on newer
/// LTS releases, while Java 8 era versions (LWJGL 2, legacy Forge/LaunchWrapper)
/// break on Java 9+ and must stay on 8.
pub fn runtime_compatible(required: u32, runtime: u32) -> bool {
    if runtime == required {
        return true;
    }
    runtime > required && required >= 16
}

/// Picks the closest compatible installed runtime (lowest newer major first,
/// 64-bit preferred) when the exact major is unavailable.
fn compatible_fallback(installs: &[JavaInstall], major: u32) -> Option<PathBuf> {
    let mut candidates: Vec<&JavaInstall> = installs
        .iter()
        .filter(|i| runtime_compatible(major, i.major))
        .filter(|i| i.is_64bit || !cfg!(target_pointer_width = "64"))
        .collect();
    candidates.sort_by(|a, b| a.major.cmp(&b.major));
    candidates.first().map(|i| PathBuf::from(&i.path))
}

/// Returns a Java binary matching `major`, downloading a Temurin JRE when needed.
pub async fn ensure_java(
    root: &Path,
    major: u32,
    preferred: Option<&str>,
    progress: Option<JavaProgressFn>,
) -> Result<PathBuf, String> {
    let emit_note = |detail: String| {
        if let Some(progress) = &progress {
            progress(JavaProgress {
                stage: "prepare".to_string(),
                done: 0,
                total: 0,
                detail,
            });
        }
    };

    if let Some(preferred) = preferred.map(str::trim).filter(|p| !p.is_empty()) {
        let path = PathBuf::from(preferred);
        match probe_java(&path, "手动指定") {
            Some(install) if runtime_compatible(major, install.major) => return Ok(path),
            Some(install) if install.major < major => {
                // Guaranteed UnsupportedClassVersionError — never launch it.
                emit_note(format!(
                    "指定的 Java {}（{}）低于该版本要求的 Java {major}，已自动改用兼容的 Java",
                    install.major, install.version
                ));
            }
            Some(install) => {
                emit_note(format!(
                    "该版本需要 Java {major}，指定的 Java {} 可能导致旧版本/旧模组加载器崩溃，已自动改用 Java {major}",
                    install.major
                ));
            }
            None => {
                emit_note(format!(
                    "指定的 Java 不存在或无法运行（{}），已自动改用检测到的 Java",
                    path.display()
                ));
            }
        }
    }

    if let Some(path) = find_managed_java(root, major) {
        return Ok(path);
    }

    let installs = detect_java_installations(root);
    // 在 64 位系统环境下，必须优先选择 64 位 Java，避免 32 位内存寻址上限（4G 堆崩溃）
    if let Some(install) = installs.iter().find(|i| i.major == major && i.is_64bit) {
        return Ok(PathBuf::from(&install.path));
    }

    // 若操作系统本身为 32 位，则允许匹配 32 位 Java
    if !cfg!(target_pointer_width = "64") {
        if let Some(install) = installs.iter().find(|i| i.major == major) {
            return Ok(PathBuf::from(&install.path));
        }
    }

    let _install_guard = JAVA_INSTALL_LOCK.lock().await;
    // Another launch may have finished installing this runtime while we waited.
    if let Some(path) = find_managed_java(root, major) {
        return Ok(path);
    }
    let installs = detect_java_installations(root);
    if let Some(install) = installs.iter().find(|i| i.major == major && i.is_64bit) {
        return Ok(PathBuf::from(&install.path));
    }
    if !cfg!(target_pointer_width = "64") {
        if let Some(install) = installs.iter().find(|i| i.major == major) {
            return Ok(PathBuf::from(&install.path));
        }
    }

    let emit = |stage: &str, done: u64, total: u64, detail: String| {
        if let Some(progress) = &progress {
            progress(JavaProgress {
                stage: stage.to_string(),
                done,
                total,
                detail,
            });
        }
    };

    let is_upgrade_from_32bit = installs.iter().any(|i| i.major == major && !i.is_64bit);
    let prepare_detail = if is_upgrade_from_32bit {
        format!("系统仅有 32 位 Java {major}（无法分配大内存），正在自动安装官方 64 位运行时")
    } else {
        format!("未检测到可用的 Java {major}，准备自动安装")
    };

    emit(
        "prepare",
        0,
        0,
        prepare_detail,
    );

    let release = match fetch_adoptium_release(major).await {
        Ok(rel) => rel,
        Err(e) => {
            // 下载失败或离线时：先用同版本的 32 位 Java，再用兼容的更高版本 Java
            if let Some(fallback_32) = installs.iter().find(|i| i.major == major) {
                return Ok(PathBuf::from(&fallback_32.path));
            }
            if let Some(path) = compatible_fallback(&installs, major) {
                emit(
                    "prepare",
                    0,
                    0,
                    format!("无法下载 Java {major}（{e}），已改用本机兼容的 Java"),
                );
                return Ok(path);
            }
            return Err(e);
        }
    };
    let package = release.binary.package;
    let runtime_dir = root.join("runtime").join(format!("temurin-{major}"));
    let cache_dir = root.join("runtime").join("cache");
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .map_err(|e| format!("无法创建运行时目录: {e}"))?;
    let archive_path = cache_dir.join(&package.name);

    let total = package.size.unwrap_or(0);
    let display_version = release
        .version
        .semver
        .clone()
        .unwrap_or_else(|| major.to_string());
    emit(
        "download",
        0,
        total,
        format!("正在下载 Java {display_version}"),
    );

    let progress_clone = progress.clone();
    let last_emit = std::sync::Mutex::new(Instant::now());
    let download_version = display_version.clone();
    let mut on_progress = move |done: u64, total: u64, _delta: u64| {
        if let Some(progress) = &progress_clone {
            let mut last = last_emit.lock().unwrap();
            if last.elapsed() < Duration::from_millis(120) && done < total {
                return;
            }
            *last = Instant::now();
            progress(JavaProgress {
                stage: "download".to_string(),
                done,
                total,
                detail: format!("正在下载 Java {download_version}"),
            });
        }
    };

    // Adoptium 的包链接一般指向 GitHub Releases，国内直连经常很慢甚至超时。
    // 走带镜像回退的下载器，失败时能自动切到加速镜像，而不是让用户干等。
    let download_result = net::download_file_with_mirrors(
        &package.link,
        &archive_path,
        None,
        package.size,
        net::download_threads().clamp(2, 32),
        None,
        Some(&mut on_progress),
    )
    .await;
    if let Err(error) = download_result {
        let _ = std::fs::remove_file(&archive_path);
        if let Some(path) = compatible_fallback(&installs, major) {
            emit(
                "prepare",
                0,
                0,
                format!("Java {major} 下载失败（{error}），已改用本机兼容的 Java"),
            );
            return Ok(path);
        }
        return Err(error);
    }

    emit("extract", 0, 0, format!("正在解压 Java {display_version}"));

    let archive = archive_path.clone();
    let dest = runtime_dir.clone();
    let extract_result = tokio::task::spawn_blocking(move || {
        if dest.exists() {
            let _ = std::fs::remove_dir_all(&dest);
        }
        std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建 Java 安装目录: {e}"))?;
        if archive.extension().and_then(|e| e.to_str()) == Some("zip") {
            extract_zip(&archive, &dest)
        } else {
            extract_tar_gz(&archive, &dest)
        }
    })
    .await
    .map_err(|e| format!("解压任务失败: {e}"))
    .and_then(|inner| inner);
    if let Err(error) = extract_result {
        // A corrupt archive or half-extracted runtime must not be reused by
        // the next launch; clear both so it downloads cleanly again.
        let _ = std::fs::remove_file(&archive_path);
        let _ = std::fs::remove_dir_all(&runtime_dir);
        if let Some(path) = compatible_fallback(&installs, major) {
            emit(
                "prepare",
                0,
                0,
                format!("Java {major} 解压失败（{error}），已改用本机兼容的 Java"),
            );
            return Ok(path);
        }
        return Err(error);
    }

    let _ = std::fs::remove_file(&archive_path);

    let java = find_all_java(&runtime_dir, 5)
        .into_iter()
        .map(|(path, _)| path)
        .find(|path| {
            probe_java(path, "Cobble 运行时")
                .map(|install| install.major == major)
                .unwrap_or(false)
        })
        .ok_or_else(|| "Java 安装完成，但没有找到可用的 java 可执行文件".to_string())?;

    emit(
        "done",
        total,
        total,
        format!("Java {display_version} 已就绪"),
    );
    if let Ok(mut guard) = JAVA_CACHE.lock() {
        *guard = None;
    }
    Ok(java)
}

pub fn detect_installs_for_ui(root: &Path) -> Vec<JavaInstall> {
    detect_java_installations(root)
}
