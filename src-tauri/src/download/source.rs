//! 下载源管理：PCL2 `NetSource` 健康状态、镜像链生成与用户下载偏好。
//!
//! PCL2 把一个文件的多个镜像建模为各自带 `FailCount` / `IsFailed` / `Error`
//! 的 `NetSource`；这里的 `NetSource` 与镜像链生成（`get_mirror_urls`、
//! `preferred_urls`）共同决定"先试哪个源、坏源要不要禁用"。

use std::sync::OnceLock;

use reqwest::header::RANGE;

/// PCL2 `NetTaskSpeedLimitLow` 以下视为慢速线路（见 `limit.rs`）。
/// PCL2 `NetSource`: one mirror plus its health counters.
#[derive(Debug, Clone)]
pub struct NetSource {
    pub id: usize,
    pub url: String,
    pub fail_count: u32,
    pub is_failed: bool,
    /// PCL2 `SingleThread`: sources that failed under Range are retried alone.
    pub single_thread: bool,
    pub error: Option<String>,
}

impl NetSource {
    pub fn new(id: usize, url: impl Into<String>) -> Self {
        Self {
            id,
            url: url.into(),
            fail_count: 0,
            is_failed: false,
            single_thread: false,
            error: None,
        }
    }

    pub fn mark_failed(&mut self, error: impl Into<String>) {
        self.fail_count += 1;
        self.error = Some(error.into());
        self.is_failed = true;
    }

    pub fn reset(&mut self) {
        self.fail_count = 0;
        self.is_failed = false;
        self.single_thread = false;
        self.error = None;
    }
}

pub fn sources_for(urls: impl IntoIterator<Item = String>) -> Vec<NetSource> {
    urls.into_iter()
        .enumerate()
        .map(|(id, url)| NetSource::new(id, url))
        .collect()
}

// ---------------------------------------------------------------------------
// 用户下载偏好：镜像家族、自定义 BMCLAPI 兼容源、线程数
// ---------------------------------------------------------------------------

/// Chosen mirror family, optional custom base URL and the thread count used by
/// downloads that do not carry their own (mods, resource packs, pack archives).
/// The frontend pushes them down on startup and whenever the setting changes.
#[derive(Clone)]
struct DownloadPreference {
    source: String,
    custom_url: String,
    threads: usize,
}

static DOWNLOAD_PREFERENCE: OnceLock<std::sync::RwLock<DownloadPreference>> = OnceLock::new();

fn preference_lock() -> &'static std::sync::RwLock<DownloadPreference> {
    DOWNLOAD_PREFERENCE.get_or_init(|| {
        std::sync::RwLock::new(DownloadPreference {
            source: "official_ap".to_string(),
            custom_url: String::new(),
            threads: 16,
        })
    })
}

/// `source` is one of `official_ap` / `bmclapi` / `custom`; `custom_url` is the
/// BMCLAPI-compatible base the user typed in; `threads` is clamped to 1–64.
pub fn set_download_preference(source: &str, custom_url: &str, threads: Option<usize>) {
    let mut guard = preference_lock()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.source = source.trim().to_string();
    guard.custom_url = custom_url.trim().trim_end_matches('/').to_string();
    if let Some(threads) = threads {
        guard.threads = threads.clamp(1, 64);
    }
    let configured = guard.threads;
    drop(guard);
    // PCL2 `NetTaskThreadLimit = ToolDownloadThread + 1`.
    super::limit::set_thread_limit(configured + 1);
}

fn download_preference() -> DownloadPreference {
    preference_lock()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Thread count content downloads should use when the caller has no own value.
pub fn download_threads() -> usize {
    download_preference().threads
}

/// 单个文件可用的分片线程数。
///
/// 小于 1 MB 的文件分不出有意义的分片，直接单连接；未知大小或大文件
/// 使用用户配置的线程数，由下载器先探测 Range 再决定是否真的分段。
/// 这样所有下载入口（客户端、依赖库、资源、安装器、运行时）都遵守同一套
/// 多线程策略，不会再出现某个入口固定单线程的情况。
pub fn per_file_threads(size: Option<u64>) -> usize {
    let configured = download_threads().clamp(1, 64);
    match size {
        Some(total) if total < super::types::MIN_MULTITHREAD_SIZE => 1,
        _ => configured,
    }
}

pub fn is_bmclapi(url: &str) -> bool {
    url.contains("bmclapi2.bangbang93.com") || url.contains("bmclapi.bangbang93.com")
}

/// Rewrite a BMCLAPI URL onto the user's BMCLAPI-compatible mirror base.
fn rewrite_to_custom_mirror(url: &str, base: &str) -> Option<String> {
    if !is_bmclapi(url) {
        return None;
    }
    let parsed = reqwest::Url::parse(url).ok()?;
    let mut rewritten = format!("{base}{}", parsed.path());
    if let Some(query) = parsed.query() {
        rewritten.push('?');
        rewritten.push_str(query);
    }
    Some(rewritten)
}

/// Candidate URLs in the order they should be attempted: the chosen source
/// family first, the rest kept as the automatic 404/offline fallback.
pub fn preferred_urls(url: &str) -> Vec<String> {
    let mut chain = vec![url.to_string()];
    for mirror in get_mirror_urls(url) {
        if !chain.contains(&mirror) {
            chain.push(mirror);
        }
    }

    let preference = download_preference();
    let mode = preference.source;
    let custom_base = preference.custom_url;
    let mut custom = Vec::new();
    if !custom_base.is_empty() {
        for candidate in &chain {
            if let Some(rewritten) = rewrite_to_custom_mirror(candidate, &custom_base) {
                if rewritten != *candidate && !custom.contains(&rewritten) {
                    custom.push(rewritten);
                }
            }
        }
    }

    let (bmclapi, official): (Vec<String>, Vec<String>) = chain
        .into_iter()
        .partition(|candidate| is_bmclapi(candidate));

    let mut ordered = match mode.as_str() {
        "bmclapi" => {
            let mut list = bmclapi;
            list.extend(custom);
            list.extend(official);
            list
        }
        "custom" => {
            let mut list = custom;
            list.extend(bmclapi);
            list.extend(official);
            list
        }
        _ => {
            let mut list = official;
            list.extend(bmclapi);
            list.extend(custom);
            list
        }
    };

    let mut seen: Vec<String> = Vec::new();
    ordered.retain(|candidate| {
        if seen.contains(candidate) {
            false
        } else {
            seen.push(candidate.clone());
            true
        }
    });
    ordered
}

/// Returns alternative mirror URLs for known official Minecraft/BMCLAPI/Fabric/Forge/XboxLive CDNs
/// to transparently prevent 404 or connection failures.
pub fn get_mirror_urls(url: &str) -> Vec<String> {
    let mut mirrors = Vec::new();
    let trimmed = url.trim();

    if trimmed.contains("xboxlive") {
        if let Ok(parsed) = reqwest::Url::parse(trimmed) {
            let path_and_query = match parsed.query() {
                Some(q) => format!("{}?{}", parsed.path(), q),
                None => parsed.path().to_string(),
            };
            let xbox_hosts = [
                "assets1.xboxlive.cn",
                "assets2.xboxlive.cn",
                "d1.xboxlive.cn",
                "d2.xboxlive.cn",
                "assets1.xboxlive.com",
                "assets2.xboxlive.com",
                "xvcf1.xboxlive.com",
                "xvcf2.xboxlive.com",
                "d1.xboxlive.com",
                "d2.xboxlive.com",
            ];
            for host in xbox_hosts {
                let candidate = format!("http://{host}{path_and_query}");
                if candidate != trimmed && !mirrors.contains(&candidate) {
                    mirrors.push(candidate);
                }
            }
        }
    } else if let Some(path) = trimmed.strip_prefix("https://libraries.minecraft.net/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
        mirrors.push(format!("https://maven.fabricmc.net/{path}"));
        mirrors.push(format!("https://maven.minecraftforge.net/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("http://libraries.minecraft.net/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://resources.betacraft.uk/") {
        // Betacraft's legacy-asset mirror is the primary URL from its own index;
        // fall back to Mojang and BMCLAPI when the mirror is unavailable.
        mirrors.push(format!("https://resources.download.minecraft.net/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/assets/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://resources.download.minecraft.net/") {
        // Legacy objects (beta/alpha sound & music, pre-1.6 langs) were pruned
        // from Mojang's CDN and now answer 404 mid-install. Betacraft keeps them
        // under the same hash layout, so it is the first fallback there.
        mirrors.push(format!("https://resources.betacraft.uk/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/assets/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("http://resources.download.minecraft.net/") {
        mirrors.push(format!("https://resources.betacraft.uk/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/assets/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://piston-meta.mojang.com/") {
        // `launchermeta` is Mojang's older hostname on the same CDN and is
        // often noticeably faster than `piston-meta`. Keeping both hostnames
        // in the chain makes the version list reachable when one is throttled
        // or blocked, without relying on the much slower BMCLAPI 302 target.
        mirrors.push(format!("https://launchermeta.mojang.com/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://piston-data.mojang.com/") {
        // `/v1/objects/...` (client.jar) exists only on piston-data; the other
        // Mojang hosts answer 404. Version-JSON `/v1/packages/...` does have
        // official host fallbacks.
        if path.starts_with("v1/packages/") {
            mirrors.push(format!("https://piston-meta.mojang.com/{path}"));
            mirrors.push(format!("https://launchermeta.mojang.com/{path}"));
        }
        // `bmclapi.bangbang93.com` mirrors the official `/v1/objects` layout
        // directly (verified 200); bmclapi2 redirects it to a slow storage node.
        mirrors.push(format!("https://bmclapi.bangbang93.com/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://launcher.mojang.com/") {
        mirrors.push(format!("https://piston-meta.mojang.com/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://launchermeta.mojang.com/") {
        mirrors.push(format!("https://piston-meta.mojang.com/{path}"));
        mirrors.push(format!("https://bmclapi2.bangbang93.com/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://maven.fabricmc.net/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://maven.quiltmc.org/repository/release/") {
        // Quilt 加载器的库此前没有任何镜像回退，官方源一慢就只能干等。
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://maven.minecraftforge.net/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://maven.neoforged.net/releases/") {
        mirrors.push(format!("https://bmclapi2.bangbang93.com/maven/{path}"));
        mirrors.push(format!("https://maven.minecraftforge.net/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://bmclapi2.bangbang93.com/maven/") {
        if path.starts_with("net/minecraftforge/") {
            mirrors.push(format!("https://maven.minecraftforge.net/{path}"));
        } else if path.starts_with("net/neoforged/") {
            mirrors.push(format!("https://maven.neoforged.net/releases/{path}"));
        } else if path.starts_with("net/fabricmc/") {
            mirrors.push(format!("https://maven.fabricmc.net/{path}"));
        } else if path.starts_with("org/quiltmc/") {
            mirrors.push(format!(
                "https://maven.quiltmc.org/repository/release/{path}"
            ));
        } else {
            mirrors.push(format!("https://libraries.minecraft.net/{path}"));
            mirrors.push(format!("https://maven.fabricmc.net/{path}"));
            mirrors.push(format!("https://maven.minecraftforge.net/{path}"));
        }
    } else if let Some(path) = trimmed.strip_prefix("https://bmclapi2.bangbang93.com/assets/") {
        mirrors.push(format!("https://resources.download.minecraft.net/{path}"));
    } else if let Some(path) = trimmed.strip_prefix("https://bmclapi2.bangbang93.com/") {
        // `/version/{id}/client|json` are BMCLAPI-only endpoints; Mojang has
        // no such path, so rewriting them would only produce 404s. The
        // official objects URL is resolved by `official_vanilla_artifacts`.
        if !path.starts_with("version/") {
            mirrors.push(format!("https://piston-data.mojang.com/{path}"));
            mirrors.push(format!("https://piston-meta.mojang.com/{path}"));
        }
    } else if let Some(path) = trimmed.strip_prefix("https://authlib-injector.yushi.moe/") {
        // authlib-injector（外置登录必需）的官方 artifact 服务在国内很慢，
        // BMCLAPI 镜像了同样的路径；校验和仍以官方 JSON 为准。
        mirrors.push(format!(
            "https://bmclapi2.bangbang93.com/mirrors/authlib-injector/{path}"
        ));
    } else if let Some(path) = trimmed.strip_prefix("https://bmclapi2.bangbang93.com/mirrors/authlib-injector/") {
        mirrors.push(format!("https://authlib-injector.yushi.moe/{path}"));
    } else if trimmed.contains("github.com/") && trimmed.contains("/releases/download/") {
        mirrors.push(format!("https://ghproxy.net/{trimmed}"));
        mirrors.push(format!("https://gh-proxy.com/{trimmed}"));
        mirrors.push(trimmed.replace(
            "https://github.com/",
            "https://github1.roundstudio.top/https://github.com/",
        ));
    } else if let Some(rest) = trimmed.strip_prefix("https://raw.githubusercontent.com/") {
        let parts: Vec<&str> = rest.splitn(4, '/').collect();
        if parts.len() == 4 {
            let (owner, repo, branch, path) = (parts[0], parts[1], parts[2], parts[3]);
            mirrors.push(format!("https://cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"));
            mirrors.push(format!("https://fastly.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"));
            mirrors.push(format!("https://gcore.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}"));
        }
        mirrors.push(format!("https://ghproxy.net/{trimmed}"));
        mirrors.push(format!("https://gh-proxy.com/{trimmed}"));
    } else if let Some(rest) = trimmed.strip_prefix("https://cdn.jsdelivr.net/gh/") {
        mirrors.push(format!("https://fastly.jsdelivr.net/gh/{rest}"));
        mirrors.push(format!("https://gcore.jsdelivr.net/gh/{rest}"));
        if let Some((repo_part, path)) = rest.split_once('/') {
            if let Some((owner, repo_and_branch)) = repo_part.split_once('/') {
                let (repo, branch) = match repo_and_branch.split_once('@') {
                    Some((r, b)) => (r, b),
                    None => (repo_and_branch, "master"),
                };
                mirrors.push(format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"));
                mirrors.push(format!("https://ghproxy.net/https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}"));
            }
        }
    }

    mirrors
}

// ---------------------------------------------------------------------------
// 源可达性探测（设置页）
// ---------------------------------------------------------------------------

/// One mirror's reachability and round-trip time, measured against its version
/// manifest. Serialized in camelCase for the settings page.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSourceProbe {
    pub source: String,
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

pub async fn probe_download_sources(custom_url: Option<&str>) -> Vec<DownloadSourceProbe> {
    const MANIFEST_PATH: &str = "/mc/game/version_manifest_v2.json";
    let mut targets = vec![
        (
            "official_ap",
            format!("https://piston-meta.mojang.com{MANIFEST_PATH}"),
        ),
        (
            "bmclapi",
            format!("https://bmclapi2.bangbang93.com{MANIFEST_PATH}"),
        ),
    ];
    let custom_base = custom_url.unwrap_or("").trim().trim_end_matches('/');
    if !custom_base.is_empty() {
        targets.push(("custom", format!("{custom_base}{MANIFEST_PATH}")));
    }

    let probes = targets.into_iter().map(|(source, url)| async move {
        let started = std::time::Instant::now();
        let direct_resp = crate::net::direct_client()
            .get(&url)
            .timeout(std::time::Duration::from_secs(6))
            .header(RANGE, "bytes=0-1023")
            .send()
            .await;
        let response = match direct_resp {
            Ok(resp) => Ok(resp),
            Err(err)
                if err.is_connect() || err.is_timeout() || err.is_request() =>
            {
                crate::net::client()
                    .get(&url)
                    .timeout(std::time::Duration::from_secs(6))
                    .header(RANGE, "bytes=0-1023")
                    .send()
                    .await
            }
            Err(err) => Err(err),
        };
        let latency_ms = started.elapsed().as_millis() as u64;
        match response {
            Ok(resp) if resp.status().is_success() || resp.status().as_u16() == 206 => {
                DownloadSourceProbe {
                    source: source.to_string(),
                    ok: true,
                    latency_ms,
                    error: None,
                }
            }
            Ok(resp) => DownloadSourceProbe {
                source: source.to_string(),
                ok: false,
                latency_ms,
                error: Some(format!("HTTP {}", resp.status())),
            },
            Err(err) => DownloadSourceProbe {
                source: source.to_string(),
                ok: false,
                latency_ms,
                error: Some(super::error::describe_error(&err)),
            },
        }
    });

    futures_util::future::join_all(probes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn betacraft_asset_mirror_falls_back_to_mojang_and_bmclapi() {
        let mirrors = get_mirror_urls(
            "https://resources.betacraft.uk/02/022e48005197b37f0caa53e8051c8a266eeae15e",
        );
        assert!(mirrors.contains(
            &"https://resources.download.minecraft.net/02/022e48005197b37f0caa53e8051c8a266eeae15e"
                .to_string()
        ));
        assert!(mirrors.contains(
            &"https://bmclapi2.bangbang93.com/assets/02/022e48005197b37f0caa53e8051c8a266eeae15e"
                .to_string()
        ));
    }

    #[test]
    fn github_raw_url_falls_back_to_jsdelivr_and_proxies() {
        let mirrors = get_mirror_urls(
            "https://raw.githubusercontent.com/Cerlesse-studio/Open-source-Minecraft-launcher/main/docs/images/logo.png",
        );
        assert!(mirrors.contains(
            &"https://cdn.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/logo.png"
                .to_string()
        ));
        assert!(mirrors.contains(
            &"https://fastly.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/logo.png"
                .to_string()
        ));
        assert!(mirrors.contains(
            &"https://gcore.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/logo.png"
                .to_string()
        ));
    }

    #[test]
    fn pruned_mojang_asset_falls_back_to_betacraft() {
        let mirrors = get_mirror_urls(
            "https://resources.download.minecraft.net/f1/f1b527e059bb4abe3aed3acf6b5eb96f40b07f67",
        );
        assert_eq!(
            mirrors.first().map(String::as_str),
            Some("https://resources.betacraft.uk/f1/f1b527e059bb4abe3aed3acf6b5eb96f40b07f67")
        );
    }

    #[test]
    fn preferred_urls_follow_the_selected_source() {
        let url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

        set_download_preference("official_ap", "", Some(16));
        let official = preferred_urls(url);
        assert_eq!(official.first().map(String::as_str), Some(url));

        set_download_preference("bmclapi", "", None);
        let bmclapi = preferred_urls(url);
        assert!(is_bmclapi(&bmclapi[0]));

        set_download_preference("custom", "https://mirror.example.com/", Some(8));
        let custom = preferred_urls(url);
        assert_eq!(download_threads(), 8);
        assert_eq!(
            custom.first().map(String::as_str),
            Some("https://mirror.example.com/mc/game/version_manifest_v2.json")
        );

        set_download_preference("official_ap", "", None);
        assert_eq!(preferred_urls(url).first().map(String::as_str), Some(url));
    }

    #[test]
    fn official_game_body_has_working_mirror_fallbacks() {
        let url = "https://piston-data.mojang.com/v1/objects/abc123/client.jar";
        let mirrors = get_mirror_urls(url);
        // Other Mojang hosts answer 404 for `/v1/objects`; they must not be added.
        assert!(!mirrors.iter().any(|c| c.contains("piston-meta.mojang.com")));
        assert!(
            !mirrors
                .iter()
                .any(|c| c.contains("launchermeta.mojang.com"))
        );
        assert!(
            mirrors
                .iter()
                .any(|c| c.starts_with("https://bmclapi.bangbang93.com/v1/objects/"))
        );
        assert!(
            mirrors
                .iter()
                .any(|c| c.starts_with("https://bmclapi2.bangbang93.com/v1/objects/"))
        );

        set_download_preference("official_ap", "", None);
        let ordered = preferred_urls(url);
        assert_eq!(ordered.first().map(String::as_str), Some(url));
        let mirror_index = ordered.iter().position(|c| is_bmclapi(c)).unwrap();
        assert!(mirror_index > 0);
    }

    #[test]
    fn official_version_json_has_package_host_fallbacks() {
        let mirrors =
            get_mirror_urls("https://piston-meta.mojang.com/v1/packages/abc123/1.20.1.json");
        assert!(
            mirrors
                .iter()
                .any(|c| c.starts_with("https://launchermeta.mojang.com/v1/packages/"))
        );
        assert!(
            mirrors
                .iter()
                .any(|c| c.starts_with("https://bmclapi2.bangbang93.com/v1/packages/"))
        );
    }

    #[test]
    fn bmclapi_version_endpoint_is_not_rewritten_to_an_invalid_official_path() {
        for suffix in ["client", "json"] {
            let mirrors = get_mirror_urls(&format!(
                "https://bmclapi2.bangbang93.com/version/1.20.1/{suffix}"
            ));
            assert!(!mirrors.iter().any(|c| c.contains("mojang.com/version/")));
        }
    }

    #[test]
    fn version_manifest_has_an_official_hostname_fallback() {
        let urls =
            preferred_urls("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
        assert!(
            urls.iter()
                .any(|u| u == "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json")
        );
        assert!(
            urls.iter()
                .any(|u| u == "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json")
        );
    }

    #[test]
    fn net_file_source_health_follows_pcl2_rotation() {
        let mut sources = sources_for(vec!["https://a".into(), "https://b".into()]);
        assert_eq!(sources.first().map(|s| s.id), Some(0));
        sources[0].mark_failed("HTTP 404");
        assert!(sources[0].is_failed);
        sources[0].reset();
        assert!(!sources[0].is_failed);
        assert_eq!(sources[0].fail_count, 0);
    }
}
