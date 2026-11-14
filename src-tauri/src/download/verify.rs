//! 下载结果校验与落盘提交：PCL2 `FileChecker` 尺寸/SHA-1 校验 + 原子改名。

use std::path::{Path, PathBuf};

use sha1::{Digest, Sha1};
use tokio::fs;

use super::error::DownloadError;

/// PCL2 `FileChecker{MinSize, ActualSize, Hash, IsJson}`.
#[derive(Debug, Clone, Default)]
pub struct FileChecker {
    pub min_size: Option<u64>,
    pub actual_size: Option<u64>,
    pub sha1: Option<String>,
    pub is_json: bool,
}

impl FileChecker {
    pub fn from_download(expected_size: Option<u64>, expected_sha1: Option<&str>) -> Self {
        Self {
            min_size: None,
            actual_size: expected_size.filter(|size| *size > 0),
            sha1: expected_sha1
                .map(str::trim)
                .filter(|hash| !hash.is_empty())
                .map(str::to_string),
            is_json: false,
        }
    }

    /// Error strings are kept byte-for-byte identical to the pre-refactor
    /// `verify_and_commit`, because callers match on them.
    pub fn check_size(&self, downloaded: u64, dest: &Path) -> Result<(), String> {
        if let Some(min) = self.min_size {
            if min > 0 && downloaded < min {
                return Err(format!(
                    "文件大小不足，获取结果为 {downloaded}，要求至少为 {min}。"
                ));
            }
        }
        if let Some(expected) = self.actual_size {
            if expected > 0 && downloaded != expected {
                return Err(format!(
                    "文件大小不符 {}: 期望 {expected} 字节，实际 {downloaded} 字节",
                    dest.display()
                ));
            }
        }
        Ok(())
    }

    pub fn check_hash(&self, dest: &Path, actual_sha1: &str) -> Result<(), String> {
        if let Some(expected) = &self.sha1 {
            if !expected.is_empty() && !actual_sha1.eq_ignore_ascii_case(expected) {
                return Err(format!("文件校验失败 {}: SHA-1 不匹配", dest.display()));
            }
        }
        Ok(())
    }
}

pub async fn sha1_file(path: &Path) -> Result<String, String> {
    let data = fs::read(path)
        .await
        .map_err(|e| format!("无法读取 {}: {e}", path.display()))?;
    Ok(format!("{:x}", Sha1::digest(data)))
}

/// Cheap completeness check used before downloading thousands of assets.
pub fn looks_complete(path: &Path, expected_size: Option<u64>) -> bool {
    match (std::fs::metadata(path), expected_size) {
        (Ok(meta), Some(size)) if size > 0 => meta.is_file() && meta.len() == size,
        (Ok(meta), _) => meta.is_file() && meta.len() > 0,
        _ => false,
    }
}

/// 下载临时文件：与目标同目录同前缀，完成后原子改名到 `dest`。
pub(crate) fn part_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

pub(super) async fn verify_and_commit(
    part: &Path,
    dest: &Path,
    downloaded: u64,
    expected_size: Option<u64>,
    expected_sha1: Option<&str>,
    precomputed_sha1: Option<&str>,
) -> Result<(), DownloadError> {
    // PCL2 `FileChecker{MinSize, ActualSize, Hash, IsJson}`. `check_size` and
    // `check_hash` emit byte-identical error strings to the original verifier.
    let checker = FileChecker::from_download(expected_size, expected_sha1);
    checker
        .check_size(downloaded, dest)
        .map_err(DownloadError::Verify)?;
    if checker.sha1.is_some() {
        if let Some(actual) = precomputed_sha1 {
            checker
                .check_hash(dest, actual)
                .map_err(DownloadError::Verify)?;
        } else {
            let actual = sha1_file(part).await.map_err(DownloadError::Verify)?;
            checker
                .check_hash(dest, &actual)
                .map_err(DownloadError::Verify)?;
        }
    }

    if fs::try_exists(dest).await.unwrap_or(false) {
        let _ = fs::remove_file(dest).await;
    }
    fs::rename(part, dest).await.map_err(|source| {
        DownloadError::CommitRename {
            path: dest.display().to_string(),
            source,
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_checker_keeps_the_existing_error_messages() {
        let checker = FileChecker::from_download(Some(100), Some("abcd"));
        let dest = Path::new("game.jar");
        assert_eq!(
            checker.check_size(99, dest).unwrap_err(),
            "文件大小不符 game.jar: 期望 100 字节，实际 99 字节"
        );
        assert!(checker.check_size(100, dest).is_ok());
        assert_eq!(
            checker.check_hash(dest, "ffff").unwrap_err(),
            "文件校验失败 game.jar: SHA-1 不匹配"
        );
        assert!(checker.check_hash(dest, "ABCD").is_ok());
    }

    #[test]
    fn part_path_sits_beside_the_destination() {
        let part = part_path(Path::new("mods/sodium.jar"));
        assert_eq!(part, Path::new("mods/sodium.jar.part"));
    }
}
