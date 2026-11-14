//! PCL2 下载任务状态机：`NetState` / `LoadState` / `NetFile` 与任务视图。
//!
//! PCL2 用 `NetState` 描述单个文件在下载管线中的阶段（判别值与 VB 原版
//! 保持一致），用 `LoadState` 描述整个 `LoaderTask` 的生死。引擎在阶段 4
//! 接入这套状态机：每次下载持有一个 `NetFile`，真实驱动状态转移与字节记账。

use std::path::Path;

/// PCL2 `NetState`, with the original discriminants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i8)]
pub enum NetState {
    WaitingToCheck = -1,
    WaitingToDownload = 0,
    Connecting = 1,
    Reading = 2,
    Downloading = 3,
    Merging = 4,
    Finished = 5,
    Canceled = 6,
}

/// PCL2 `LoadState` (the `LoaderTask` state machine).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LoadState {
    #[default]
    Waiting,
    Loading,
    Finished,
    Failed,
    Canceled,
}

/// PCL2 `NetFile.FilePieceLimit`: a fragment smaller than this is not split.
pub const FILE_PIECE_LIMIT: u64 = 256 * 1024;
/// PCL2 `NetFile.IsNoSplit`: files below 1 MiB are never segmented.
pub const NO_SPLIT_SIZE: u64 = 1024 * 1024;

/// PCL2 `NetFile`. `file_size` uses the VB sentinels: `-2` unknown-yet,
/// `-1` unknown-size.
#[derive(Debug, Clone)]
pub struct NetFile {
    pub local_path: std::path::PathBuf,
    pub local_name: String,
    pub sources: Vec<super::source::NetSource>,
    pub state: NetState,
    pub file_size: i64,
    pub download_done: u64,
    pub checker: super::verify::FileChecker,
}

impl NetFile {
    pub fn new(
        local_path: impl Into<std::path::PathBuf>,
        urls: Vec<String>,
        checker: super::verify::FileChecker,
    ) -> Self {
        let local_path = local_path.into();
        let local_name = local_path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        Self {
            local_path,
            local_name,
            sources: super::source::sources_for(urls),
            state: NetState::WaitingToCheck,
            file_size: -2,
            download_done: 0,
            checker,
        }
    }

    pub fn is_unknown_size(&self) -> bool {
        self.file_size == -1
    }

    pub fn is_no_split(&self) -> bool {
        self.is_unknown_size() || (self.file_size >= 0 && (self.file_size as u64) < NO_SPLIT_SIZE)
    }

    /// PCL2 `HasAvailableSource`.
    pub fn has_available_source(&self) -> bool {
        self.sources.iter().any(|source| !source.is_failed)
    }

    /// PCL2 `GetSource(Id)`: first healthy source at/after `start`, wrapping.
    pub fn first_available_source(&self, start: usize) -> Option<usize> {
        if self.sources.is_empty() || !self.has_available_source() {
            return None;
        }
        let count = self.sources.len();
        (0..count)
            .map(|offset| (start + offset) % count)
            .find(|index| !self.sources[*index].is_failed)
    }

    /// PCL2 `NetFile.Progress`: 5%..98% while downloading, 0.99 while merging.
    pub fn progress(&self) -> f64 {
        match self.state {
            NetState::WaitingToCheck => 0.0,
            NetState::WaitingToDownload => 0.01,
            NetState::Connecting => 0.02,
            NetState::Reading => 0.04,
            NetState::Downloading => {
                let raw = if self.is_unknown_size() {
                    0.5
                } else {
                    self.download_done as f64 / (self.file_size.max(1) as f64).max(1.0)
                };
                (1.0 - (1.0 - raw).powf(0.9)) * 0.93 + 0.05
            }
            NetState::Merging => 0.99,
            NetState::Finished | NetState::Canceled => 1.0,
        }
    }
}

/// PCL2 `LoaderTask` output shape exposed to the UI.
#[derive(Debug, Clone)]
pub struct LoaderTaskView {
    pub name: String,
    pub state: LoadState,
    pub progress: f64,
    pub error: Option<String>,
    pub active_threads: u32,
    pub speed_limit_bps: Option<u64>,
}

impl LoaderTaskView {
    pub fn new(name: impl Into<String>, state: LoadState, progress: f64) -> Self {
        Self {
            name: name.into(),
            state,
            progress,
            error: None,
            active_threads: super::limit::active_threads(),
            speed_limit_bps: super::limit::speed_limit(),
        }
    }
}

/// PCL2 `LoaderDownload.OnFail` message: every source's error is listed.
pub fn format_download_failure(local_path: &Path, sources: &[super::source::NetSource]) -> String {
    let detail = sources
        .iter()
        .map(|source| {
            format!(
                "{}（{}）",
                source.error.as_deref().unwrap_or("无错误信息。"),
                source.url
            )
        })
        .collect::<Vec<_>>()
        .join("\r\n");
    format!(
        "文件下载失败：{}\r\n各下载源的错误如下：\r\n{detail}",
        local_path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_state_keeps_pcl2_discriminants() {
        assert_eq!(NetState::WaitingToCheck as i8, -1);
        assert_eq!(NetState::WaitingToDownload as i8, 0);
        assert_eq!(NetState::Connecting as i8, 1);
        assert_eq!(NetState::Reading as i8, 2);
        assert_eq!(NetState::Downloading as i8, 3);
        assert_eq!(NetState::Merging as i8, 4);
        assert_eq!(NetState::Finished as i8, 5);
        assert_eq!(NetState::Canceled as i8, 6);
    }

    #[test]
    fn net_file_progress_follows_pcl2_curve_and_source_wrap() {
        let mut file = NetFile::new(
            "mods/sodium.jar",
            vec!["https://a".into(), "https://b".into()],
            super::super::verify::FileChecker::default(),
        );
        assert_eq!(file.progress(), 0.0);
        assert_eq!(file.first_available_source(0), Some(0));
        file.sources[0].mark_failed("HTTP 404");
        assert_eq!(file.first_available_source(0), Some(1));
        assert_eq!(file.first_available_source(1), Some(1));
        file.sources[1].mark_failed("HTTP 502");
        assert_eq!(file.first_available_source(0), None);
        assert!(!file.has_available_source());

        file.sources[0].reset();
        file.sources[1].reset();
        file.file_size = 100;
        file.download_done = 50;
        file.state = NetState::Downloading;
        assert!((0.05..=0.98).contains(&file.progress()));
        file.state = NetState::Merging;
        assert_eq!(file.progress(), 0.99);
        file.state = NetState::Finished;
        assert_eq!(file.progress(), 1.0);
    }

    #[test]
    fn net_file_no_split_threshold_is_1mib() {
        let mut file = NetFile::new(
            "a.jar",
            vec!["https://a".into()],
            super::super::verify::FileChecker::default(),
        );
        file.file_size = 1024 * 1024 - 1;
        assert!(file.is_no_split());
        file.file_size = 1024 * 1024;
        assert!(!file.is_no_split());
        file.file_size = -1;
        assert!(file.is_no_split());
    }

    #[test]
    fn failure_message_lists_every_source() {
        let mut sources = super::super::source::sources_for(vec![
            "https://a".into(),
            "https://b".into(),
        ]);
        sources[0].mark_failed("HTTP 404");
        sources[1].mark_failed("超时");
        let message = format_download_failure(Path::new("mods/a.jar"), &sources);
        assert!(message.contains("文件下载失败：mods/a.jar"));
        assert!(message.contains("HTTP 404（https://a）"));
        assert!(message.contains("超时（https://b）"));
        assert!(message.contains("各下载源的错误如下"));
    }
}
