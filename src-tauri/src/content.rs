use crate::net;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How many builds the version picker shows.
const VERSION_LIST_LIMIT: usize = 50;
/// A fetched version list is reused for this long before the API is queried again.
const VERSION_LIST_TTL: Duration = Duration::from_secs(10 * 60);
/// Upper bound on cached lists so a long session cannot grow without limit.
const VERSION_CACHE_MAX_ENTRIES: usize = 64;

type VersionListCache = std::collections::HashMap<String, (Instant, Vec<ContentVersionItem>)>;

fn version_list_cache() -> &'static std::sync::Mutex<VersionListCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<VersionListCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentHit {
    pub project_id: String,
    pub slug: String,
    pub author: String,
    pub title: String,
    pub description: String,
    pub categories: Vec<String>,
    pub versions: Vec<String>,
    pub downloads: u64,
    pub follows: u64,
    pub icon_url: Option<String>,
    pub date_created: Option<String>,
    pub date_modified: Option<String>,
    pub latest_version: Option<String>,
    pub project_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContentResult {
    pub hits: Vec<ContentHit>,
    pub offset: u32,
    pub limit: u32,
    pub total_hits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentFile {
    pub url: String,
    pub filename: String,
    pub primary: bool,
    pub size: u64,
    pub sha1: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentVersionItem {
    pub id: String,
    pub name: String,
    pub version_number: String,
    pub game_versions: Vec<String>,
    pub loaders: Vec<String>,
    pub date_published: Option<String>,
    pub downloads: u64,
    pub files: Vec<ContentFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadContentRequest {
    pub root: String,
    pub instance_id: Option<String>,
    pub project_type: String, // "mod" | "modpack" | "shader" | "datapack" | "resourcepack"
    pub url: String,
    pub filename: String,
    pub sha1: Option<String>,
    pub size: Option<u64>,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadContentResult {
    pub success: bool,
    pub file_path: String,
    pub bytes: u64,
}

// ---------------------------------------------------------------------------
// Modrinth API Queries
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ModrinthSearchResponse {
    hits: Vec<ModrinthRawHit>,
    offset: u32,
    limit: u32,
    total_hits: u32,
}

#[derive(Deserialize)]
struct ModrinthRawHit {
    project_id: String,
    slug: String,
    author: String,
    title: String,
    description: String,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    versions: Vec<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    follows: u64,
    icon_url: Option<String>,
    date_created: Option<String>,
    date_modified: Option<String>,
    latest_version: Option<String>,
    project_type: String,
}

async fn get_bedrock_hits(query: &str, project_type: &str) -> Vec<ContentHit> {
    let all = crate::bedrock::get_bedrock_content_async(None).await;
    let q = query.trim().to_lowercase();
    all.into_iter()
        .filter(|item| {
            let type_match = if project_type == "resourcepack" {
                item.content_type == "resourcepack" || item.content_type == "shader"
            } else if project_type == "shader" {
                item.content_type == "shader" || item.content_type == "resourcepack"
            } else {
                item.content_type == project_type
            };
            if !type_match {
                return false;
            }
            if !q.is_empty() {
                if !item.title.to_lowercase().contains(&q)
                    && !item.description.to_lowercase().contains(&q)
                    && !item.author.to_lowercase().contains(&q)
                    && !item.tags.iter().any(|t| t.to_lowercase().contains(&q))
                {
                    return false;
                }
            }
            true
        })
        .map(|item| ContentHit {
            project_id: item.id.clone(),
            slug: item.id,
            author: item.author,
            title: item.title,
            description: item.description,
            categories: {
                let mut cats = vec!["bedrock".to_string(), "基岩版".to_string()];
                cats.extend(item.tags);
                cats
            },
            versions: vec!["1.21+".to_string(), "基岩版".to_string()],
            downloads: item.downloads,
            follows: item.downloads / 10,
            icon_url: item.icon_url,
            date_created: Some("2024-01-01T00:00:00Z".to_string()),
            date_modified: Some("2024-12-01T00:00:00Z".to_string()),
            latest_version: Some(item.version),
            project_type: item.content_type,
        })
        .collect()
}

pub async fn search_content(
    query: String,
    project_type: String,
    game_version: Option<String>,
    loader: Option<String>,
    sort: Option<String>,
    offset: u32,
    limit: u32,
) -> Result<SearchContentResult, String> {
    let limit = limit.clamp(1, 50);

    // If explicitly searching bedrock (by loader or version)
    let is_bedrock = loader.as_deref() == Some("bedrock")
        || game_version.as_deref() == Some("bedrock")
        || game_version.as_deref() == Some("基岩版");

    if is_bedrock {
        let bedrock_local_hits = get_bedrock_hits(&query, &project_type).await;

        // Query Modrinth API in real time for Bedrock-compatible items
        let modrinth_query = if query.trim().is_empty() {
            "bedrock".to_string()
        } else if !query.to_lowercase().contains("bedrock") {
            format!("{} bedrock", query.trim())
        } else {
            query.clone()
        };

        let mut facets: Vec<Vec<String>> = Vec::new();
        facets.push(vec![format!("project_type:{project_type}")]);
        let facets_json = serde_json::to_string(&facets).unwrap_or_else(|_| "[]".to_string());

        let url = format!(
            "https://api.modrinth.com/v2/search?query={}&facets={}&index={}&offset={}&limit={}",
            urlencoding(&modrinth_query),
            urlencoding(&facets_json),
            "downloads",
            0,
            limit
        );

        let mut combined_hits = bedrock_local_hits;
        let client = net::client();
        if let Ok(resp) = client.get(&url).timeout(Duration::from_secs(6)).send().await {
            if resp.status().is_success() {
                if let Ok(raw) = resp.json::<ModrinthSearchResponse>().await {
                    for h in raw.hits {
                        if !combined_hits.iter().any(|c| c.project_id == h.project_id || c.slug == h.slug) {
                            combined_hits.push(ContentHit {
                                project_id: h.project_id,
                                slug: h.slug,
                                author: h.author,
                                title: h.title,
                                description: h.description,
                                categories: h.categories,
                                versions: h.versions,
                                downloads: h.downloads,
                                follows: h.follows,
                                icon_url: h.icon_url,
                                date_created: h.date_created,
                                date_modified: h.date_modified,
                                latest_version: h.latest_version,
                                project_type: h.project_type,
                            });
                        }
                    }
                }
            }
        }

        let total = combined_hits.len() as u32;
        let start = (offset as usize).min(combined_hits.len());
        let end = (start + limit as usize).min(combined_hits.len());
        let paged_hits = combined_hits[start..end].to_vec();

        return Ok(SearchContentResult {
            hits: paged_hits,
            offset,
            limit,
            total_hits: total,
        });
    }

    let index = match sort.as_deref() {
        Some("relevance") => "relevance",
        Some("newest") => "newest",
        Some("updated") => "updated",
        _ => "downloads",
    };

    let mut facets: Vec<Vec<String>> = Vec::new();
    // Project type facet: "project_type:mod" / "project_type:shader" / etc.
    facets.push(vec![format!("project_type:{project_type}")]);

    if let Some(v) = game_version.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "all" && *s != "基岩版" && *s != "bedrock") {
        facets.push(vec![format!("versions:{v}")]);
    }

    if let Some(l) = loader.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "all" && *s != "bedrock") {
        facets.push(vec![format!("categories:{}", l.to_lowercase())]);
    }

    let facets_json = serde_json::to_string(&facets).unwrap_or_else(|_| "[]".to_string());

    let url = format!(
        "https://api.modrinth.com/v2/search?query={}&facets={}&index={}&offset={}&limit={}",
        urlencoding(&query),
        urlencoding(&facets_json),
        index,
        offset,
        limit
    );

    // Modrinth can answer slowly on congested links, so the timeout covers the
    // whole body and stalled transfers are retried instead of failing outright.
    let raw: ModrinthSearchResponse = net::fetch_json(&url, Duration::from_secs(60), 3)
        .await
        .map_err(|e| format!("搜索 Modrinth 失败: {e}"))?;

    let mut hits: Vec<ContentHit> = raw
        .hits
        .into_iter()
        .map(|h| ContentHit {
            project_id: h.project_id,
            slug: h.slug,
            author: h.author,
            title: h.title,
            description: h.description,
            categories: h.categories,
            versions: h.versions,
            downloads: h.downloads,
            follows: h.follows,
            icon_url: h.icon_url,
            date_created: h.date_created,
            date_modified: h.date_modified,
            latest_version: h.latest_version,
            project_type: h.project_type,
        })
        .collect();

    // Include Bedrock hits in first page if no specific loader or all loaders
    if offset == 0 && (loader.is_none() || loader.as_deref() == Some("all")) {
        let bedrock_hits = get_bedrock_hits(&query, &project_type).await;
        if !bedrock_hits.is_empty() {
            let mut combined = bedrock_hits;
            combined.extend(hits);
            hits = combined;
        }
    }

    Ok(SearchContentResult {
        hits,
        offset: raw.offset,
        limit: raw.limit,
        total_hits: raw.total_hits,
    })
}

#[derive(Deserialize)]
struct ModrinthRawVersion {
    id: String,
    name: String,
    version_number: String,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    loaders: Vec<String>,
    date_published: Option<String>,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    files: Vec<ModrinthRawFile>,
}

#[derive(Deserialize)]
struct ModrinthRawFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    size: u64,
    hashes: Option<ModrinthRawHashes>,
}

#[derive(Deserialize)]
struct ModrinthRawHashes {
    sha1: Option<String>,
}

pub async fn get_content_versions(
    project_id_or_slug: String,
    game_version: Option<String>,
    loader: Option<String>,
) -> Result<Vec<ContentVersionItem>, String> {
    // Check if it's a bedrock curated project. Use the cache-only view: this
    // runs before every version list, and waiting on the remote catalog here
    // added seconds to each open when its mirrors were unreachable.
    let bedrock_items = crate::bedrock::get_bedrock_content_cached();
    if let Some(item) = bedrock_items.into_iter().find(|i| i.id == project_id_or_slug) {
        return Ok(vec![ContentVersionItem {
            id: format!("{}-v1", item.id),
            name: format!("{} (基岩版推荐)", item.version),
            version_number: item.version,
            game_versions: vec!["1.21+".to_string(), "基岩版".to_string()],
            loaders: vec!["bedrock".to_string()],
            date_published: Some("2024-12-01T00:00:00Z".to_string()),
            downloads: item.downloads,
            files: vec![ContentFile {
                url: item.download_url,
                filename: item.file_name,
                primary: true,
                size: 2_500_000,
                sha1: None,
            }],
        }]);
    }
    // Reopening the same project/filter combination is served from memory: the
    // version list is immutable enough that a 10 minute window is safe.
    let cache_key = format!(
        "{}|{}|{}",
        project_id_or_slug.trim().to_lowercase(),
        game_version.as_deref().unwrap_or("").trim(),
        loader.as_deref().unwrap_or("").trim()
    );
    if let Ok(cache) = version_list_cache().lock() {
        if let Some((fetched_at, cached)) = cache.get(&cache_key) {
            if fetched_at.elapsed() < VERSION_LIST_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let url = build_version_list_url(&project_id_or_slug, game_version.as_deref(), loader.as_deref());
    // A version list can exceed a megabyte, and the old 12s request-wide cap
    // cut the body mid-transfer on slow links: reqwest then reported the
    // useless "error decoding response body". Use a body-inclusive timeout and
    // retry stalled transfers.
    let raw_versions: Vec<ModrinthRawVersion> = net::fetch_json(&url, Duration::from_secs(60), 3)
        .await
        .map_err(|e| format!("Modrinth 版本列表: {e}"))?;

    let items: Vec<ContentVersionItem> = raw_versions
        .into_iter()
        .take(VERSION_LIST_LIMIT)
        .map(|v| ContentVersionItem {
            id: v.id,
            name: v.name,
            version_number: v.version_number,
            game_versions: v.game_versions,
            loaders: v.loaders,
            date_published: v.date_published,
            downloads: v.downloads,
            files: v
                .files
                .into_iter()
                .map(|f| ContentFile {
                    url: f.url,
                    filename: f.filename,
                    primary: f.primary,
                    size: f.size,
                    sha1: f.hashes.and_then(|h| h.sha1),
                })
                .collect(),
        })
        .collect();

    if let Ok(mut cache) = version_list_cache().lock() {
        if cache.len() >= VERSION_CACHE_MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(cache_key, (Instant::now(), items.clone()));
    }

    Ok(items)
}

/// Compose the Modrinth version list URL for one project and filter set.
///
/// `limit` keeps the response to the page the picker actually renders. Without
/// it a popular project returns its entire history (Fabric API: 1216 versions,
/// 1.2 MB of JSON, ~35s on a slow link) to show 50 rows.
fn build_version_list_url(
    project_id_or_slug: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
) -> String {
    let mut query_params = Vec::new();

    // Do NOT pass "基岩版" or "bedrock" to Modrinth version filter
    if let Some(v) = game_version.map(str::trim).filter(|s| !s.is_empty() && *s != "all" && *s != "基岩版" && *s != "bedrock") {
        let gv_json = serde_json::to_string(&vec![v]).unwrap_or_default();
        query_params.push(format!("game_versions={}", urlencoding(&gv_json)));
    }
    if let Some(l) = loader.map(str::trim).filter(|s| !s.is_empty() && *s != "all" && *s != "bedrock") {
        let l_json = serde_json::to_string(&vec![l.to_lowercase()]).unwrap_or_default();
        query_params.push(format!("loaders={}", urlencoding(&l_json)));
    }

    query_params.push(format!("limit={VERSION_LIST_LIMIT}"));

    format!(
        "https://api.modrinth.com/v2/project/{project_id_or_slug}/version?{}",
        query_params.join("&")
    )
}

fn urlencoding(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    encoded
}

// ---------------------------------------------------------------------------
// File Download & Placement
// ---------------------------------------------------------------------------

pub async fn download_content_file(
    request: DownloadContentRequest,
) -> Result<DownloadContentResult, String> {
    let root = net::absolute_path(&PathBuf::from(&request.root));
    let filename = Path::new(&request.filename)
        .file_name()
        .ok_or_else(|| "文件名无效".to_string())?
        .to_string_lossy()
        .to_string();

    // Check if it's a bedrock pack or targeted for bedrock
    if request.instance_id.as_deref() == Some("bedrock")
        || filename.ends_with(".mcpack")
        || filename.ends_with(".mcaddon")
    {
        let res = crate::bedrock::install_bedrock_pack(&root, &request.url, &filename).await?;
        return Ok(DownloadContentResult {
            success: true,
            file_path: res.target_path,
            bytes: request.size.unwrap_or(0),
        });
    }

    let target_dir: PathBuf = match request.project_type.as_str() {
        "mod" => {
            if let Some(ref inst) = request.instance_id.filter(|s| !s.trim().is_empty()) {
                root.join("versions").join(inst).join("mods")
            } else {
                root.join("mods")
            }
        }
        "shader" => {
            if let Some(ref inst) = request.instance_id.filter(|s| !s.trim().is_empty()) {
                root.join("versions").join(inst).join("shaderpacks")
            } else {
                root.join("shaderpacks")
            }
        }
        "datapack" => {
            if let Some(ref inst) = request.instance_id.filter(|s| !s.trim().is_empty()) {
                root.join("versions").join(inst).join("datapacks")
            } else {
                root.join("datapacks")
            }
        }
        "resourcepack" => {
            if let Some(ref inst) = request.instance_id.filter(|s| !s.trim().is_empty()) {
                root.join("versions").join(inst).join("resourcepacks")
            } else {
                root.join("resourcepacks")
            }
        }
        "modpack" => root.join("modpacks"),
        _ => root.join("downloads"),
    };

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("创建目标目录失败: {e}"))?;

    let dest = target_dir.join(&filename);

    let bytes = net::download_file_multithreaded(
        &request.url,
        &dest,
        request.sha1.as_deref(),
        request.size,
        6,
        None,
        None,
    )
    .await?;

    Ok(DownloadContentResult {
        success: true,
        file_path: dest.to_string_lossy().to_string(),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_url_requests_only_the_visible_page() {
        assert_eq!(
            build_version_list_url("fabric-api", None, None),
            "https://api.modrinth.com/v2/project/fabric-api/version?limit=50"
        );
    }

    #[test]
    fn version_url_encodes_game_version_and_loader_filters() {
        let url = build_version_list_url("fabric-api", Some("1.20.1"), Some("Fabric"));
        assert!(url.contains("game_versions=%5B%221.20.1%22%5D"), "{url}");
        assert!(url.contains("loaders=%5B%22fabric%22%5D"), "{url}");
        assert!(url.ends_with("&limit=50"), "{url}");
    }

    #[test]
    fn version_url_omits_filters_that_mean_everything() {
        for value in ["all", "bedrock", "", "   "] {
            assert_eq!(
                build_version_list_url("pack", Some(value), Some(value)),
                "https://api.modrinth.com/v2/project/pack/version?limit=50",
                "value {value:?} should not become a filter"
            );
        }
    }
}
