//! 断点续传：分片布局与完成进度记录在 `<dest>.part.meta` 旁车文件里。
//!
//! 关掉启动器、切换镜像或者重新点一次下载，都只会补下没完成的那几段，
//! 而不是从 0 开始。写入走"临时文件 + 改名"，写一半的 JSON 不会让续传失效。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

/// 断点续传的旁车文件：记下分片布局与已完成的段，和 `.part` 同目录同前缀。
#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct ResumeMeta {
    /// 文件总长度，用来判断旁车文件是否还对得上这条线路。
    pub total: u64,
    /// 分片布局。续传时沿用它，而不是按当前线程数重算，否则已完成的
    /// 下标会对不上。
    pub segments: Vec<(u64, u64)>,
    pub completed: Vec<u32>,
    /// 已完成分片的字节总数，用来在续传时立刻显示"已下载"。
    pub done_bytes: u64,
}

impl ResumeMeta {
    pub fn is_done(&self) -> bool {
        !self.segments.is_empty() && self.completed.len() >= self.segments.len()
    }

    pub fn missing(&self, index: u32) -> bool {
        !self.completed.contains(&index)
    }
}

pub(crate) fn resume_meta_path(part: &Path) -> PathBuf {
    let mut name = part.file_name().unwrap_or_default().to_os_string();
    name.push(".meta");
    part.with_file_name(name)
}

/// `<dest>.part.meta` 的路径：调用方清理续传记录时用得上。
pub fn resume_sidecar_path(dest: &Path) -> PathBuf {
    resume_meta_path(&super::verify::part_path(dest))
}

/// 可续传的进度（已下载字节）。没有 `.part.meta`、或它与当前 `.part`
/// 对不上时返回 `None`，表示只能重头下载。
pub fn resume_progress(dest: &Path) -> Option<u64> {
    let part = super::verify::part_path(dest);
    let text = std::fs::read_to_string(resume_meta_path(&part)).ok()?;
    let meta: ResumeMeta = serde_json::from_str(&text).ok()?;
    let length = std::fs::metadata(&part).ok()?.len();
    if meta.total == 0 || length != meta.total {
        return None;
    }
    (meta.done_bytes > 0).then_some(meta.done_bytes.min(meta.total))
}

pub(super) async fn read_resume_meta(part: &Path) -> Option<ResumeMeta> {
    let text = fs::read_to_string(resume_meta_path(part)).await.ok()?;
    serde_json::from_str(&text).ok()
}

/// 先写临时文件再改名，避免写一半的 JSON 让续传彻底失效。
pub(super) async fn write_resume_meta(part: &Path, meta: &ResumeMeta) -> Result<(), String> {
    let path = resume_meta_path(part);
    let temp = path.with_extension("meta.tmp");
    let text = serde_json::to_string(meta).map_err(|e| format!("进度写入失败: {e}"))?;
    fs::write(&temp, text)
        .await
        .map_err(|e| format!("进度写入失败 {}: {e}", temp.display()))?;
    fs::rename(&temp, &path)
        .await
        .map_err(|e| format!("进度写入失败 {}: {e}", path.display()))?;
    Ok(())
}

/// 丢弃 `.part` 与旁车文件：只有确认无法续传时才能这么做。
pub(super) async fn discard_partial(part: &Path) {
    let _ = fs::remove_file(part).await;
    let _ = fs::remove_file(resume_meta_path(part)).await;
}
