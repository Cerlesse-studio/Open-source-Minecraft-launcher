// Headless end-to-end check for Cobble's download and launch pipeline.
//
// Usage:
//   cargo run --example smoke -- <version> [root] [player] [seconds]
//
// `seconds = 0` installs only. Otherwise the game is started, watched for
// startup markers, and killed after the timeout.

use open_source_minecraft_launcher_lib::minecraft::{
    InstallProgress, LaunchRequest, ProgressFn, install_version, prepare_launch,
};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let version = args.get(1).cloned().unwrap_or_else(|| "1.8.9".to_string());
    let root = PathBuf::from(
        args.get(2)
            .cloned()
            .unwrap_or_else(|| ".tmp/smoke-root".to_string()),
    );
    let player = args.get(3).cloned().unwrap_or_else(|| "Steve".to_string());
    let seconds: u64 = args
        .get(4)
        .and_then(|value| value.parse().ok())
        .unwrap_or(30);

    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let last_stage = Arc::new(Mutex::new(String::new()));
    let progress_state = last_stage.clone();
    let progress: ProgressFn = Arc::new(move |p: InstallProgress| {
        let mut stage = progress_state.lock().unwrap();
        if *stage != p.stage || p.done == p.total || p.done % 100 == 0 {
            println!(
                "[{}] {:>6}/{:<6} {}",
                p.stage,
                p.done,
                if p.total == 0 {
                    "?".to_string()
                } else {
                    p.total.to_string()
                },
                p.detail
            );
            *stage = p.stage.clone();
        }
    });

    println!("Installing Minecraft {version} into {}", root.display());
    let started = std::time::Instant::now();
    let installed = install_version(&root, &version, progress.clone()).await?;
    println!(
        "INSTALL_OK version={} libraries={} assets={} java={} elapsed={:.1}s",
        installed.version_id,
        installed.libraries,
        installed.assets,
        installed.java_major,
        started.elapsed().as_secs_f32()
    );

    if seconds == 0 {
        return Ok(());
    }

    let request = LaunchRequest {
        version_id: version.clone(),
        root: root.to_string_lossy().to_string(),
        player_name: player.clone(),
        memory_mb: Some(2048),
        java_path: None,
        width: Some(854),
        height: Some(480),
        skin_type: None,
        custom_skin_path: None,
        custom_skin_model: None,
        mojang_skin_name: None,
        version_isolation: None,
        window_title: None,
        custom_info: None,
        launcher_visibility: None,
        process_priority: None,
        window_size: None,
        jvm_args: None,
        language: None,
    };

    println!("Preparing Java and launch arguments…");
    let spec = prepare_launch(&request, progress).await?;
    println!("JAVA={} MAJOR={}", spec.java.display(), spec.java_major);
    if std::env::var("COBBLE_DUMP_ARGS").is_ok() {
        println!("CWD={}", spec.cwd.display());
        println!("ARGS={:?}", spec.args);
    }

    let mut child = Command::new(&spec.java)
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start java: {e}"))?;

    let saw_window = Arc::new(AtomicBool::new(false));
    let mut readers = Vec::new();
    let mut pipe =
        |stream: &'static str, reader: Box<dyn std::io::Read + Send>, flag: Arc<AtomicBool>| {
            let handle = std::thread::spawn(move || {
                let reader = BufReader::new(reader);
                for line in reader.lines().map_while(Result::ok) {
                    if line.contains("Setting user")
                        || line.contains("Backend library")
                        || line.contains("LWJGL")
                        || line.contains("OpenAL")
                    {
                        flag.store(true, Ordering::Relaxed);
                    }
                    println!("{stream}| {line}");
                }
            });
            readers.push(handle);
        };

    if let Some(stdout) = child.stdout.take() {
        pipe("out", Box::new(stdout), saw_window.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        pipe("err", Box::new(stderr), saw_window.clone());
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    let mut exit_code = None;
    while std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(300)).await;
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            exit_code = status.code();
            break;
        }
    }

    if exit_code.is_none() {
        println!("LAUNCH_ALIVE  (still running after {seconds}s)");
        let _ = child.kill();
        let _ = child.wait();
    } else {
        println!("EXITED code={exit_code:?}");
    }

    for handle in readers {
        let _ = handle.join();
    }

    if saw_window.load(Ordering::Relaxed) {
        println!("LAUNCH_OK startup markers observed");
        Ok(())
    } else {
        Err("LAUNCH_FAILED no startup markers observed".to_string())
    }
}
