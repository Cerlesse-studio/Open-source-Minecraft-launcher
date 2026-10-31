use crate::net;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static JAVA_CACHE: Mutex<Option<(Instant, PathBuf, Vec<JavaInstall>)>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInstall {
    pub path: String,
    pub major: u32,
    pub version: String,
    pub source: String,
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
    if cfg!(windows) {
        "java.exe"
    } else {
        "java"
    }
}

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

fn probe_java(path: &Path, source: &str) -> Option<JavaInstall> {
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
    Some(JavaInstall {
        path: path.to_string_lossy().to_string(),
        major,
        version,
        source: source.to_string(),
    })
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
            for name in ["openjdk", "openjdk@17", "openjdk@21", "openjdk@11", "openjdk@8"] {
                add_candidate(&mut list, base.join(name).join("bin").join(java_exe()), "系统安装");
                add_candidate(&mut list, base.join(name).join("libexec").join("openjdk.jdk").join("Contents").join("Home").join("bin").join(java_exe()), "系统安装");
            }
        }

        // Additional Linux paths
        add_unix_candidates(&mut list, Path::new("/usr/lib64/jvm"), "系统安装");
        add_candidate(&mut list, PathBuf::from("/etc/alternatives/java"), "系统安装");
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
            if cached_root == &root && timestamp.elapsed() < Duration::from_secs(15) {
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
    sorted.sort_by(|a, b| b.major.cmp(&a.major).then_with(|| a.path.cmp(&b.path)));

    if let Ok(mut guard) = JAVA_CACHE.lock() {
        *guard = Some((Instant::now(), root, sorted.clone()));
    }

    sorted
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

/// Returns a Java binary matching `major`, downloading a Temurin JRE when needed.
pub async fn ensure_java(
    root: &Path,
    major: u32,
    preferred: Option<&str>,
    progress: Option<JavaProgressFn>,
) -> Result<PathBuf, String> {
    if let Some(preferred) = preferred.map(str::trim).filter(|p| !p.is_empty()) {
        let path = PathBuf::from(preferred);
        if !path.is_file() {
            return Err(format!("指定的 Java 不存在: {}", path.display()));
        }
        let install = probe_java(&path, "手动指定")
            .ok_or_else(|| format!("无法运行指定的 Java: {}", path.display()))?;
        if install.major != major {
            return Err(format!(
                "这个版本需要 Java {major}，但指定的 Java 是 {}（{}）。请在设置中改用自动检测。",
                install.major, install.version
            ));
        }
        return Ok(path);
    }

    if let Some(path) = find_managed_java(root, major) {
        return Ok(path);
    }

    let installs = detect_java_installations(root);
    if let Some(install) = installs.into_iter().find(|i| i.major == major) {
        return Ok(PathBuf::from(install.path));
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

    emit(
        "prepare",
        0,
        0,
        format!("未检测到 Java {major}，准备自动安装"),
    );

    let release = fetch_adoptium_release(major).await?;
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

    net::download_file_multithreaded(
        &package.link,
        &archive_path,
        None,
        package.size,
        8,
        None,
        Some(&mut on_progress),
    )
    .await?;

    emit("extract", 0, 0, format!("正在解压 Java {display_version}"));

    let archive = archive_path.clone();
    let dest = runtime_dir.clone();
    tokio::task::spawn_blocking(move || {
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
    .map_err(|e| format!("解压任务失败: {e}"))??;

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
