//! 下载源失败分类与错误链渲染。
//!
//! PCL2 `SourceFail` 依据错误的类别决定"禁用该源"还是"再给它一次机会"；
//! 这里把同样的分类规则集中在 `error.rs`，供引擎的镜像轮换逻辑调用。

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

fn has_status(error: &str, code: u16) -> bool {
    let bare = format!("HTTP {code}");
    let parenthesized = format!("({code})");
    error.contains(&bare) || error.contains(&parenthesized)
}

pub fn classify_source_failure(error: &str) -> SourceFailure {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_failure_classification_matches_pcl2_rules() {
        assert_eq!(
            classify_source_failure("服务器未返回分片数据 (url): HTTP 416"),
            SourceFailure::RangeNotSupported
        );
        assert_eq!(
            classify_source_failure("分片长度不完整: 期望 100, 实际 10"),
            SourceFailure::RangeNotSupported
        );
        assert_eq!(
            classify_source_failure("下载失败: HTTP 404"),
            SourceFailure::Http(404)
        );
        assert_eq!(
            classify_source_failure("HTTP 429"),
            SourceFailure::Http(429)
        );
        assert_eq!(classify_source_failure("空间不足"), SourceFailure::DiskFull);
        assert_eq!(
            classify_source_failure("分片 30 秒没有收到数据"),
            SourceFailure::SlowLink
        );
        assert_eq!(
            classify_source_failure("unexpected"),
            SourceFailure::Unknown
        );
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
}
