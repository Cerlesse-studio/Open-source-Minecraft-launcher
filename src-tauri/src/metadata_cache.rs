//! 资源元数据的磁盘缓存（参考 PCL2 的「缓存优先」）。
//!
//! 目录页、搜索页、版本列表这些 JSON 每次打开都重新请求，在这条线路上就是
//! 一到十秒的空白；断网时更是直接报错。这里把它们按请求键落到磁盘：
//!
//! * 新鲜（未超过 TTL）→ 直接返回，不发网络请求；
//! * 过期 → 重新请求，成功后覆盖；**请求失败时回退到旧数据**，界面不会白屏；
//! * 同一请求并发多次 → 只真正发一次，其余等结果。
//!
//! 缓存键与数据都放在 `<配置目录>/metadata-cache/`，文件修改时间就是抓取时间，
//! 因此不需要额外的索引文件。写入先落到 `.tmp` 再改名，写到一半崩溃也不会
//! 留下半截 JSON。

use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// 缓存文件名的哈希前缀长度：40 位十六进制里取 24 位足够避免碰撞。
const HASH_CHARS: usize = 24;

fn default_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        // 测试与内嵌场景可以用环境变量隔离，不污染真实配置目录。
        if let Some(custom) = std::env::var_os("OSML_METADATA_CACHE") {
            let path = PathBuf::from(custom);
            let _ = std::fs::create_dir_all(&path);
            return path;
        }
        let base = std::env::var_os("OSML_CONFIG")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("LOCALAPPDATA").map(PathBuf::from))
            .unwrap_or_else(std::env::temp_dir);
        let path = base.join("metadata-cache");
        let _ = std::fs::create_dir_all(&path);
        path
    })
}

fn safe_namespace(namespace: &str) -> String {
    let cleaned: String = namespace
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "cache".to_string()
    } else {
        cleaned
    }
}

fn entry_path(dir: &Path, namespace: &str, key: &str) -> PathBuf {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let hash = &digest[..HASH_CHARS.min(digest.len())];
    dir.join(format!("{}-{hash}.json", safe_namespace(namespace)))
}

fn read_at(dir: &Path, namespace: &str, key: &str, ttl: Option<Duration>) -> Option<Vec<u8>> {
    let path = entry_path(dir, namespace, key);
    let metadata = std::fs::metadata(&path).ok()?;
    if let Some(ttl) = ttl {
        // 取不到修改时间（或被改成未来时间）时按新鲜处理，宁可少发一次请求。
        let age = metadata.modified().ok().and_then(|time| time.elapsed().ok());
        if age.is_some_and(|age| age > ttl) {
            return None;
        }
    }
    std::fs::read(&path).ok()
}

async fn store_at(dir: &Path, namespace: &str, key: &str, body: &[u8]) {
    if let Err(error) = tokio::fs::create_dir_all(dir).await {
        let _ = error;
        return;
    }
    let path = entry_path(dir, namespace, key);
    let temp = path.with_extension("json.tmp");
    if tokio::fs::write(&temp, body).await.is_ok() && tokio::fs::rename(&temp, &path).await.is_err()
    {
        let _ = tokio::fs::remove_file(&temp).await;
    }
}

/// 同一请求键的并发锁：多个界面同时要同一份数据时只打一次网络。
async fn inflight_lock(lock_key: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    let map = LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let mut guard = map.lock().await;
    // 键数量随浏览历史增长，超过上限就整体清空；清空只影响“合并请求”的命中率。
    if guard.len() > 512 {
        guard.clear();
    }
    guard
        .entry(lock_key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 缓存优先地取一份 JSON。
///
/// * `namespace` + `key` 组成缓存键（`key` 通常是完整 URL）；
/// * `ttl` 内直接读磁盘，不联网；
/// * 联网失败时返回上一次成功的结果，只有完全没有旧数据才返回错误。
pub async fn fetch_json<T: serde::de::DeserializeOwned>(
    namespace: &str,
    key: &str,
    url: &str,
    ttl: Duration,
    timeout: Duration,
    attempts: u32,
) -> Result<T, String> {
    fetch_json_in(
        default_dir(),
        namespace,
        key,
        url,
        ttl,
        timeout,
        attempts,
    )
    .await
}

async fn fetch_json_in<T: serde::de::DeserializeOwned>(
    dir: &Path,
    namespace: &str,
    key: &str,
    url: &str,
    ttl: Duration,
    timeout: Duration,
    attempts: u32,
) -> Result<T, String> {
    if let Some(bytes) = read_at(dir, namespace, key, Some(ttl)) {
        match serde_json::from_slice::<T>(&bytes) {
            Ok(value) => return Ok(value),
            // 旧缓存本身坏了：删掉重新取，不能一直拿到同一份坏数据。
            Err(_) => {
                let _ = std::fs::remove_file(entry_path(dir, namespace, key));
            }
        }
    }

    let lock = inflight_lock(&entry_path(dir, namespace, key).to_string_lossy()).await;
    let _guard = lock.lock().await;

    // 等锁期间别的任务可能已经把新数据写好了。
    if let Some(bytes) = read_at(dir, namespace, key, Some(ttl)) {
        if let Ok(value) = serde_json::from_slice::<T>(&bytes) {
            return Ok(value);
        }
    }

    match crate::net::fetch_json_bytes(url, timeout, attempts).await {
        Ok(bytes) => {
            let value: T = serde_json::from_slice(&bytes)
                .map_err(|e| format!("响应格式不匹配: {e}（{url}）"))?;
            store_at(dir, namespace, key, &bytes).await;
            Ok(value)
        }
        Err(error) => match read_at(dir, namespace, key, None) {
            // 断网 / 超时：用上一次的数据顶上，比整页报错有用得多。
            Some(bytes) => match serde_json::from_slice::<T>(&bytes) {
                Ok(value) => Ok(value),
                Err(_) => Err(error),
            },
            None => Err(error),
        },
    }
}

/// 读一份仍然新鲜的缓存（不联网）。调用方要自己组合请求逻辑时用这个。
pub fn cached_json<T: serde::de::DeserializeOwned>(
    namespace: &str,
    key: &str,
    ttl: Duration,
) -> Option<T> {
    let bytes = read_at(default_dir(), namespace, key, Some(ttl))?;
    serde_json::from_slice(&bytes).ok()
}

/// 读一份过期缓存，只在请求失败时的兜底路径里使用。
pub fn cached_json_any<T: serde::de::DeserializeOwned>(
    namespace: &str,
    key: &str,
) -> Option<T> {
    let bytes = read_at(default_dir(), namespace, key, None)?;
    serde_json::from_slice(&bytes).ok()
}

/// 把一次成功响应写进缓存（供自己管理请求链路的调用方使用）。
pub async fn store(namespace: &str, key: &str, body: &[u8]) {
    store_at(default_dir(), namespace, key, body).await;
}

/// 缓存优先地取一段文本（HTML、XML 之类不需要 JSON 解析的响应）。
pub async fn fetch_text(
    namespace: &str,
    key: &str,
    url: &str,
    ttl: Duration,
    timeout: Duration,
) -> Result<String, String> {
    let dir = default_dir();
    if let Some(bytes) = read_at(dir, namespace, key, Some(ttl)) {
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }

    let lock = inflight_lock(&entry_path(dir, namespace, key).to_string_lossy()).await;
    let _guard = lock.lock().await;

    if let Some(bytes) = read_at(dir, namespace, key, Some(ttl)) {
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }

    match crate::net::fetch_text_bytes(url, timeout).await {
        Ok(bytes) => {
            store_at(dir, namespace, key, &bytes).await;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }
        Err(error) => match read_at(dir, namespace, key, None) {
            Some(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            None => Err(error),
        },
    }
}

/// 删掉全部缓存（设置页的「清理缓存」用得上）。
pub async fn clear() {
    let dir = default_dir();
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let _ = tokio::fs::remove_file(entry.path()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cobble-metadata-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
    struct Payload {
        value: u32,
    }

    /// TTL 内的缓存必须直接命中，不再发网络请求。
    #[tokio::test]
    async fn a_fresh_entry_is_served_without_touching_the_network() {
        let dir = temp_dir("fresh");
        let body = serde_json::to_vec(&Payload { value: 7 }).unwrap();
        store_at(&dir, "modrinth", "https://example.invalid/x", &body).await;

        // 用不可达地址也应当命中缓存。
        let hit: Payload = fetch_json_in(
            &dir,
            "modrinth",
            "https://example.invalid/x",
            "http://127.0.0.1:1/x",
            Duration::from_secs(3600),
            Duration::from_millis(300),
            1,
        )
        .await
        .unwrap();
        assert_eq!(hit, Payload { value: 7 });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 网络失败时必须回退到过期缓存，而不是把错误抛给界面。
    #[tokio::test]
    async fn a_stale_entry_rescues_a_failed_refresh() {
        let dir = temp_dir("stale");
        let body = serde_json::to_vec(&Payload { value: 42 }).unwrap();
        store_at(&dir, "curseforge", "v1/mods/search", &body).await;

        let hit: Payload = fetch_json_in(
            &dir,
            "curseforge",
            "v1/mods/search",
            "http://127.0.0.1:1/search",
            // TTL 为 0 表示缓存已过期，会真的去请求那个不可达地址。
            Duration::ZERO,
            Duration::from_millis(300),
            1,
        )
        .await
        .expect("断网时应当用旧数据顶上");
        assert_eq!(hit, Payload { value: 42 });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 从来没有缓存过、网络又失败时，错误必须原样返回（不能假装成功）。
    #[tokio::test]
    async fn a_cold_miss_still_reports_the_network_error() {
        let dir = temp_dir("cold");
        let result: Result<Payload, String> = fetch_json_in(
            &dir,
            "modrinth",
            "https://example.invalid/none",
            "http://127.0.0.1:1/none",
            Duration::from_secs(60),
            Duration::from_millis(300),
            1,
        )
        .await;
        assert!(result.is_err(), "没有旧数据时必须把错误交给调用方");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 损坏的缓存文件要被丢弃并重新请求，而不是一直报解析错误。
    #[tokio::test]
    async fn a_corrupt_entry_is_discarded() {
        let dir = temp_dir("corrupt");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = entry_path(&dir, "modrinth", "broken");
        tokio::fs::write(&path, b"{not json").await.unwrap();
        assert!(read_at(&dir, "modrinth", "broken", None).is_some());
        let result: Result<Payload, String> = fetch_json_in(
            &dir,
            "modrinth",
            "broken",
            "http://127.0.0.1:1/broken",
            Duration::from_secs(60),
            Duration::from_millis(300),
            1,
        )
        .await;
        assert!(result.is_err());
        assert!(!path.exists(), "坏缓存应当被删除");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
