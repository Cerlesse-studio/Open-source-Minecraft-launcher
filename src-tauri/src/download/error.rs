//! 下载引擎的结构化错误（参考 rayburst `error.rs` 的 thiserror 模式）
//! 与 PCL2 源失败分类。
//!
//! PCL2 `SourceFail` 依据错误的类别决定"禁用该源"还是"再给它一次机会"；
//! 这里把同样的分类规则集中在 `error.rs`，供引擎的镜像轮换逻辑调用。
//!
//! `DownloadError` 各变体的 `Display` 输出与重构前的字符串错误逐字节一致：
//! 调用方与测试依赖这些文案（例如 `format!("下载 {last_err}")` 包装与
//! 本地化文案），桥接层（bridge.rs）也继续以字符串形式向前端传递。

use std::fmt;

/// PCL2 `SourceFail` classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceFailure {
    RangeNotSupported,
    Http(u16),
    SlowLink,
    NoData,
    DiskFull,
    Unknown,
}

// ---------------------------------------------------------------------------
// 结构化错误
// ---------------------------------------------------------------------------

/// 下载引擎的统一错误类型。
///
/// 变体命名对应旧的错误文案前缀；`Display` 逐字节还原旧字符串。
/// 源失败分类（[`classify_source_failure`]）与代理重试判定
/// （[`proxy_retry_worthwhile`]）直接按变体结构匹配，不再猜测字符串。
#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    // ---- 单流下载（download_single_stream）----
    #[error("下载请求失败 ({url}): {source}")]
    Transport { url: String, source: reqwest::Error },
    #[error("下载失败 ({url}): HTTP {status}")]
    Http { url: String, status: u16 },
    #[error("下载中断 ({url}): {source}")]
    StreamInterrupted { url: String, source: reqwest::Error },
    #[error("下载停滞超过 {secs} 秒 ({url})")]
    Stalled { url: String, secs: u64 },

    // ---- 分片下载（fetch_range_into / probe_range_support）----
    #[error("分片请求失败 ({url}): {source}")]
    SegmentTransport { url: String, source: reqwest::Error },
    #[error("分片重定向请求失败 ({url}): {source}")]
    SegmentRedirectTransport { url: String, source: reqwest::Error },
    #[error("分片探测失败 ({url}): {source}")]
    ProbeTransport { url: String, source: reqwest::Error },
    #[error("分片重定向探测失败 ({url}): {source}")]
    ProbeRedirectTransport { url: String, source: reqwest::Error },
    #[error("服务器未返回分片数据 ({url}): HTTP {status}")]
    SegmentHttp { url: String, status: u16 },
    #[error("分片 {secs} 秒没有收到数据 ({url})")]
    SegmentStalled { url: String, secs: u64 },
    #[error("分片下载中断 ({url}): {source}")]
    SegmentStreamInterrupted { url: String, source: reqwest::Error },
    #[error("分片返回字节超出范围")]
    SegmentOverflow,
    #[error("分片长度不完整: 期望 {expected}, 实际 {actual}")]
    SegmentShort { expected: u64, actual: u64 },

    // ---- 文件系统（旧文案前缀保留）----
    #[error("无法创建目录 {path}: {source}")]
    CreateDir { path: String, source: std::io::Error },
    #[error("无法写入 {path}: {source}")]
    CreatePart { path: String, source: std::io::Error },
    #[error("写入失败 {path}: {source}")]
    WritePart { path: String, source: std::io::Error },
    #[error("无法创建分片文件 {path}: {source}")]
    CreateSegmentFile { path: String, source: std::io::Error },
    #[error("无法预分配文件空间 {path}: {source}")]
    Preallocate { path: String, source: std::io::Error },
    #[error("无法打开分片文件 {path}: {source}")]
    OpenSegmentFile { path: String, source: std::io::Error },
    #[error("分片定位失败 {path}: {source}")]
    SegmentSeek { path: String, source: std::io::Error },
    #[error("分片写入失败 {path}: {source}")]
    SegmentWrite { path: String, source: std::io::Error },
    #[error("分片刷新失败 {path}: {source}")]
    SegmentFlush { path: String, source: std::io::Error },
    #[error("无法保存 {path}: {source}")]
    CommitRename { path: String, source: std::io::Error },
    #[error("无法读取 {path}: {source}")]
    ReadForHash { path: String, source: std::io::Error },

    // ---- 校验与续传 ----
    /// `FileChecker` 的尺寸/SHA-1 校验失败等已格式化文案（逐字节兼容旧实现）。
    #[error("{0}")]
    Verify(String),
    #[error("进度写入失败: {0}")]
    MetaSerde(String),
    #[error("进度写入失败 {path}: {source}")]
    MetaWrite { path: String, source: std::io::Error },
    #[error("下载未完成，可以继续下载")]
    Incomplete,

    /// 来源列表为空（引擎内部不会出现，防御性保留）。
    #[error("没有可用的下载源")]
    NoSource,
}

impl DownloadError {
    /// 连接层失败（断网、超时、重置）——直连失败后值得用系统代理再试一轮。
    /// 旧实现按文案前缀匹配（`proxy_retry_worthwhile`），这里按变体结构匹配，
    /// 判定结果与旧实现逐条一致。
    pub fn is_transport(&self) -> bool {
        match self {
            DownloadError::Transport { .. }
            | DownloadError::StreamInterrupted { .. }
            | DownloadError::SegmentTransport { .. }
            | DownloadError::SegmentRedirectTransport { .. }
            | DownloadError::ProbeTransport { .. }
            | DownloadError::ProbeRedirectTransport { .. }
            | DownloadError::SegmentStreamInterrupted { .. }
            | DownloadError::Stalled { .. }
            | DownloadError::SegmentStalled { .. }
            | DownloadError::Incomplete => true,
            _ => false,
        }
    }
}

/// 直连失败后，换成系统代理还有没有可能把文件拿回来。
///
/// 只有连接层的问题（连不上、超时、连接被重置、久不出数据）值得再走一次代理：
/// 404 / 403、校验不符、磁盘写满之类的错误，换代理也救不了。
pub fn proxy_retry_worthwhile(error: &DownloadError) -> bool {
    match error {
        // HTTP 状态错误旧实现一律不换代理（文案不命中任何连接层提示）：
        // 404/403/416 显式排除，其余状态码同样换代理也救不了。
        DownloadError::Http { .. } => false,
        // "服务器未返回分片数据"旧实现不命中任何连接层提示，一律不重试。
        DownloadError::SegmentHttp { .. } => false,
        DownloadError::Verify(_) => false,
        error => error.is_transport(),
    }
}

fn http_status_failure(status: u16) -> SourceFailure {
    // 与旧字符串分类一致：只把可重试的响应码归类为 Http，其余视为 Unknown。
    if matches!(status, 403 | 404 | 429 | 502 | 503 | 500 | 408) {
        SourceFailure::Http(status)
    } else {
        SourceFailure::Unknown
    }
}

fn io_failure(source: &std::io::Error) -> SourceFailure {
    // Windows 中文系统的磁盘满报错文案是"磁盘空间不足"。 (os error 112)。
    if source.raw_os_error() == Some(112) || source.to_string().contains("空间不足") {
        SourceFailure::DiskFull
    } else {
        SourceFailure::Unknown
    }
}

/// PCL2 `SourceFail` 分类：按 `DownloadError` 的变体结构直接判定。
pub fn classify_source_failure(error: &DownloadError) -> SourceFailure {
    match error {
        // 服务器不支持/未按约定返回 Range 数据。
        DownloadError::Http { status: 416, .. } => SourceFailure::RangeNotSupported,
        DownloadError::Http { status, .. } => http_status_failure(*status),
        DownloadError::SegmentHttp { .. } => SourceFailure::RangeNotSupported,
        DownloadError::SegmentOverflow | DownloadError::SegmentShort { .. } => {
            SourceFailure::RangeNotSupported
        }
        // 停滞（分片/单流空闲超时）。
        DownloadError::Stalled { .. } | DownloadError::SegmentStalled { .. } => {
            SourceFailure::SlowLink
        }
        // reqwest 传输层：超时按慢线路处理，其余 Unknown（与旧分类一致）。
        DownloadError::Transport { source, .. }
        | DownloadError::StreamInterrupted { source, .. }
        | DownloadError::SegmentTransport { source, .. }
        | DownloadError::SegmentRedirectTransport { source, .. }
        | DownloadError::ProbeTransport { source, .. }
        | DownloadError::ProbeRedirectTransport { source, .. }
        | DownloadError::SegmentStreamInterrupted { source, .. } => {
            if source.is_timeout() {
                SourceFailure::SlowLink
            } else {
                SourceFailure::Unknown
            }
        }
        DownloadError::CreateDir { source, .. }
        | DownloadError::CreatePart { source, .. }
        | DownloadError::WritePart { source, .. }
        | DownloadError::CreateSegmentFile { source, .. }
        | DownloadError::Preallocate { source, .. }
        | DownloadError::OpenSegmentFile { source, .. }
        | DownloadError::SegmentSeek { source, .. }
        | DownloadError::SegmentWrite { source, .. }
        | DownloadError::SegmentFlush { source, .. }
        | DownloadError::CommitRename { source, .. }
        | DownloadError::ReadForHash { source, .. } => io_failure(source),
        // 校验不符、续传元数据损坏等：换源也无济于事，归为 Unknown（旧实现同）。
        _ => SourceFailure::Unknown,
    }
}

fn has_status(error: &str, code: u16) -> bool {
    let bare = format!("HTTP {code}");
    let parenthesized = format!("({code})");
    error.contains(&bare) || error.contains(&parenthesized)
}

/// 旧版字符串分类器：供测试对照与文本型错误（如第三方包装）兜底使用。
pub fn classify_source_failure_str(error: &str) -> SourceFailure {
    if has_status(error, 416)
        || error.contains("不支持分段")
        || error.contains("服务器未返回分片数据")
        || error.contains("分片长度不完整")
        || error.contains("分片返回字节超出范围")
    {
        return SourceFailure::RangeNotSupported;
    }
    if error.contains("空间不足") {
        return SourceFailure::DiskFull;
    }
    if error.contains("无返回数据") || error.contains("返回的 ContentLength 过多") {
        return SourceFailure::NoData;
    }
    if error.contains("速度过慢")
        || error.contains("没有收到数据")
        || error.contains("停滞")
        || error.contains("超时")
    {
        return SourceFailure::SlowLink;
    }
    for code in [403, 404, 429, 502, 503, 500, 408] {
        if has_status(error, code) {
            return SourceFailure::Http(code);
        }
    }
    SourceFailure::Unknown
}

/// PCL2 `SourceFail`'s "disable this source" decision.
pub fn should_disable_source(
    failure: SourceFailure,
    fail_count: u32,
    downloaded: u64,
    thread_limit: u32,
    is_bmclapi: bool,
    is_merge_failure: bool,
) -> bool {
    if is_merge_failure
        || matches!(
            failure,
            SourceFailure::RangeNotSupported | SourceFailure::NoData | SourceFailure::DiskFull
        )
    {
        return true;
    }
    if let SourceFailure::Http(code) = failure {
        if code == 404 || code == 502 {
            return true;
        }
        // BMCLAPI rate-limits aggressive clients; PCL2 does not ban it for 403/429.
        if (code == 403 || code == 429) && !is_bmclapi {
            return true;
        }
    }
    let threshold = thread_limit.clamp(5, 30);
    (fail_count >= threshold && downloaded < 1) || fail_count > thread_limit + 2
}

/// Render an error together with its full source chain.
///
/// `reqwest` only prints its own wrapper message ("error decoding response
/// body") through `Display`, which hides the real cause (a timeout, a reset,
/// or a serde mismatch). Walk the chain so the UI can show what happened.
pub(crate) fn describe_error(err: &(dyn std::error::Error + 'static)) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(inner) = source {
        let detail = inner.to_string();
        if !detail.is_empty() && !text.contains(&detail) {
            text.push_str(&format!(" ({detail})"));
        }
        source = inner.source();
    }
    text
}

/// 便于日志输出的 trait 别名：`DownloadError` 实现了 `std::error::Error`。
impl fmt::Display for SourceFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_classification_matches_the_legacy_string_rules() {
        let http_416 = DownloadError::Http {
            url: "https://a".into(),
            status: 416,
        };
        assert_eq!(classify_source_failure(&http_416), SourceFailure::RangeNotSupported);
        let segment_http_404 = DownloadError::SegmentHttp {
            url: "https://a".into(),
            status: 404,
        };
        // 旧实现里"服务器未返回分片数据: HTTP 404"按前缀命中 RangeNotSupported。
        assert_eq!(
            classify_source_failure(&segment_http_404),
            SourceFailure::RangeNotSupported
        );
        let stalled = DownloadError::SegmentStalled {
            url: "https://a".into(),
            secs: 30,
        };
        assert_eq!(classify_source_failure(&stalled), SourceFailure::SlowLink);
        let not_found = DownloadError::Http {
            url: "https://a".into(),
            status: 404,
        };
        assert_eq!(classify_source_failure(&not_found), SourceFailure::Http(404));
        let other_status = DownloadError::Http {
            url: "https://a".into(),
            status: 418,
        };
        assert_eq!(classify_source_failure(&other_status), SourceFailure::Unknown);
    }

    #[test]
    fn proxy_retry_decision_matches_the_legacy_hint_table() {
        let build = |status: u16| DownloadError::Http {
            url: "https://a".into(),
            status,
        };
        // 404/403/416 与校验失败不值得换代理。
        assert!(!proxy_retry_worthwhile(&build(404)));
        assert!(!proxy_retry_worthwhile(&build(403)));
        assert!(!proxy_retry_worthwhile(&build(416)));
        assert!(!proxy_retry_worthwhile(&DownloadError::Verify("SHA-1 不匹配".into())));
        // 其他 HTTP 状态码旧实现同样不换代理（文案不命中任何连接层提示）。
        assert!(!proxy_retry_worthwhile(&build(500)));
        assert!(!proxy_retry_worthwhile(&build(429)));
        // 连接层/停滞/未完成这类传输层失败值得换代理。
        assert!(proxy_retry_worthwhile(&DownloadError::Incomplete));
        assert!(proxy_retry_worthwhile(&DownloadError::Stalled {
            url: "https://a".into(),
            secs: 30,
        }));
        // 分片数据异常/未按约定返回：换代理也救不了。
        assert!(!proxy_retry_worthwhile(&DownloadError::SegmentOverflow));
        assert!(!proxy_retry_worthwhile(&DownloadError::SegmentHttp {
            url: "https://a".into(),
            status: 500,
        }));
    }

    #[test]
    fn source_failure_classification_matches_pcl2_rules() {
        assert_eq!(
            classify_source_failure_str("服务器未返回分片数据 (url): HTTP 416"),
            SourceFailure::RangeNotSupported
        );
        assert_eq!(
            classify_source_failure_str("分片长度不完整: 期望 100, 实际 10"),
            SourceFailure::RangeNotSupported
        );
        assert_eq!(
            classify_source_failure_str("下载失败: HTTP 404"),
            SourceFailure::Http(404)
        );
        assert_eq!(classify_source_failure_str("HTTP 429"), SourceFailure::Http(429));
        assert_eq!(classify_source_failure_str("空间不足"), SourceFailure::DiskFull);
        assert_eq!(
            classify_source_failure_str("分片 30 秒没有收到数据"),
            SourceFailure::SlowLink
        );
        assert_eq!(classify_source_failure_str("unexpected"), SourceFailure::Unknown);
    }

    #[test]
    fn source_disable_rules_keep_bmclapi_rate_limits_retryable() {
        assert!(should_disable_source(SourceFailure::Http(429), 1, 0, 17, true, false) == false);
        assert!(should_disable_source(
            SourceFailure::Http(429),
            1,
            0,
            17,
            false,
            false
        ));
        assert!(should_disable_source(
            SourceFailure::Http(404),
            1,
            10,
            17,
            true,
            false
        ));
        assert!(should_disable_source(
            SourceFailure::RangeNotSupported,
            1,
            10,
            17,
            true,
            false
        ));
        assert!(should_disable_source(
            SourceFailure::Unknown,
            40,
            0,
            17,
            false,
            false
        ));
        assert!(!should_disable_source(
            SourceFailure::Unknown,
            1,
            10,
            17,
            false,
            false
        ));
    }

    #[test]
    fn display_strings_match_the_legacy_messages_byte_for_byte() {
        let cases: Vec<(DownloadError, &str)> = vec![
            (
                DownloadError::Http {
                    url: "https://a/f.bin".into(),
                    status: 404,
                },
                "下载失败 (https://a/f.bin): HTTP 404",
            ),
            (
                DownloadError::SegmentShort {
                    expected: 100,
                    actual: 10,
                },
                "分片长度不完整: 期望 100, 实际 10",
            ),
            (
                DownloadError::SegmentOverflow,
                "分片返回字节超出范围",
            ),
            (
                DownloadError::Stalled {
                    url: "https://a".into(),
                    secs: 30,
                },
                "下载停滞超过 30 秒 (https://a)",
            ),
            (
                DownloadError::SegmentHttp {
                    url: "https://a".into(),
                    status: 403,
                },
                "服务器未返回分片数据 (https://a): HTTP 403",
            ),
            (DownloadError::Incomplete, "下载未完成，可以继续下载"),
            (DownloadError::Verify("文件校验失败 x.jar: SHA-1 不匹配".into()), "文件校验失败 x.jar: SHA-1 不匹配"),
        ];
        for (error, expected) in cases {
            assert_eq!(error.to_string(), expected, "error={error:?}");
        }
    }
}
