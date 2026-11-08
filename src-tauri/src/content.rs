use crate::bridge::AppHandle;
use crate::net;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How many builds the version picker shows.
///
/// The picker groups files by loader and Minecraft version and lists every
/// version the project supports as a pill, so the window has to reach back far
/// enough to cover older Minecraft releases: at 50 files a fast-moving mod only
/// exposed its newest two Minecraft versions. 200 files is ~400 KB of JSON for
/// the busiest projects, still well inside the body timeout below.
const VERSION_LIST_LIMIT: usize = 200;
/// A fetched version list is reused for this long before the API is queried again.
const VERSION_LIST_TTL: Duration = Duration::from_secs(10 * 60);
/// Upper bound on cached lists so a long session cannot grow without limit.
const VERSION_CACHE_MAX_ENTRIES: usize = 64;

/// PCL2 `ResourceTypes`: `Mod` / `ModPack` / `DataPack` / `Shader` /
/// `ResourcePack` / `World` / `Any`. The wire value stays a plain string; this
/// enum only replaces the scattered `project_type == "..."` string branches
/// with PCL2's vocabulary. No serialized shape changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceType {
    Mod,
    ModPack,
    DataPack,
    Shader,
    ResourcePack,
    World,
    Any,
}

impl ResourceType {
    pub fn from_wire(value: &str) -> Self {
        match value {
            "mod" => Self::Mod,
            "modpack" => Self::ModPack,
            "datapack" => Self::DataPack,
            "shader" => Self::Shader,
            "resourcepack" => Self::ResourcePack,
            "world" => Self::World,
            _ => Self::Any,
        }
    }

    /// PCL2 `GetModrinthAddress`: `facets=[["project_type:{Type}"]]`.
    pub fn as_modrinth_facet(self) -> &'static str {
        match self {
            Self::ModPack => "modpack",
            Self::DataPack => "datapack",
            Self::Shader => "shader",
            Self::ResourcePack => "resourcepack",
            Self::Mod | Self::World | Self::Any => "mod",
        }
    }

    /// PCL2 `PageResource.TypeName` (English words are left untranslated).
    pub fn as_type_name(self) -> &'static str {
        match self {
            Self::Mod | Self::Any => "Mod",
            Self::ModPack => "整合包",
            Self::DataPack => "数据包",
            Self::Shader => "光影包",
            Self::ResourcePack => "资源包",
            Self::World => "地图",
        }
    }
}

/// PCL2 `ResourcePlatforms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourcePlatform {
    CurseForge,
    Modrinth,
    #[allow(dead_code)]
    Any,
}

/// PCL2 `ResourceSearcher.SearchRequest`. Rust uses snake_case field names,
/// but the concepts (`search_text`, `target_result_count`, `loader_name`,
/// `sources`) mirror PCL2 so both sides of the stdio bridge share one
/// vocabulary. Metadata-only fields are intentionally kept for parity.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub search_text: String,
    pub resource_type: ResourceType,
    pub game_version: Option<String>,
    pub mod_loaders: Option<String>,
    pub tag: String,
    pub sources: ResourcePlatform,
    pub sort: Option<String>,
    pub offset: u32,
    pub limit: u32,
    pub is_bedrock: bool,
    /// PCL2 `(Page + 1) * PAGE_SIZE`, with `Page = offset / limit` (0-based).
    pub target_result_count: u32,
    /// PCL2 `Loader.Name = $"社区资源获取：{TypeName}"`.
    pub loader_name: String,
}

impl SearchRequest {
    pub fn new(
        query: String,
        project_type: &str,
        game_version: Option<String>,
        loader: Option<String>,
        sort: Option<String>,
        offset: u32,
        limit: u32,
    ) -> Self {
        let resource_type = ResourceType::from_wire(project_type);
        let is_bedrock = loader.as_deref() == Some("bedrock")
            || game_version.as_deref() == Some("bedrock")
            || game_version.as_deref() == Some("基岩版");
        let sources = if is_bedrock || resource_type == ResourceType::World {
            ResourcePlatform::CurseForge
        } else {
            ResourcePlatform::Modrinth
        };
        let page = offset / limit.max(1);
        let target_result_count = (page + 1).saturating_mul(limit);
        let loader_name = format!("社区资源获取：{}", resource_type.as_type_name());
        Self {
            search_text: query,
            resource_type,
            game_version,
            mod_loaders: loader,
            tag: String::new(),
            sources,
            sort,
            offset,
            limit,
            is_bedrock,
            target_result_count,
            loader_name,
        }
    }
}

type VersionListCache = std::collections::HashMap<String, (Instant, Vec<ContentVersionItem>)>;

fn version_list_cache() -> &'static std::sync::Mutex<VersionListCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<VersionListCache>> =
        std::sync::OnceLock::new();
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
    /// English keywords substituted for a non-English query, when the search
    /// actually used them. The UI shows this so the substitution is visible.
    #[serde(default)]
    pub translated_query: Option<String>,
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
    /// Minecraft versions this build was published for. Used to pick the local
    /// instance the mod belongs to when the caller names none.
    #[serde(default)]
    pub game_versions: Vec<String>,
    /// Loader family of the file ("fabric", "forge", …) when known.
    #[serde(default)]
    pub loader: Option<String>,
    /// Version isolation used by the selected instance. Worlds must be unpacked
    /// into the same `saves/` folder the game will read, which isolation moves.
    #[serde(default)]
    pub isolation: Option<String>,
    /// Catalog metadata for a downloaded world, persisted next to the save so
    /// update detection can compare the installed file with the newest one.
    #[serde(default)]
    pub source_project_id: Option<String>,
    #[serde(default)]
    pub source_file_id: Option<String>,
    #[serde(default)]
    pub source_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentProgressPayload {
    pub id: String,
    pub title: String,
    pub filename: String,
    pub project_type: String,
    pub stage: String,
    pub detail: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub speed_bps: u64,
    pub threads: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadContentResult {
    pub success: bool,
    pub file_path: String,
    pub bytes: u64,
    /// Instance the file ended up in (explicit or auto-detected).
    #[serde(default)]
    pub instance_id: Option<String>,
    /// True when no instance was requested and a matching local one was found.
    #[serde(default)]
    pub auto_matched: bool,
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
    // PCL2 `ResourceSearcher.SearchRequest`, built the same way as
    // `PageResource.LoaderInput` does from the current page/filters.
    let request = SearchRequest::new(
        query,
        &project_type,
        game_version,
        loader,
        sort,
        offset,
        limit,
    );
    let search_text = request.search_text.as_str();
    let game_version = request.game_version.as_deref();
    let loader = request.mod_loaders.as_deref();
    let sort = request.sort.as_deref();
    let offset = request.offset;
    let limit = request.limit;
    let is_bedrock = request.is_bedrock;
    let resource_type = request.resource_type;
    let facet = resource_type.as_modrinth_facet();

    // The catalogues index English metadata, so `钠` or `機械動力` found nothing.
    // Search the English keywords first; when even those return nothing the
    // raw query is retried, because a project can genuinely be titled in
    // Chinese and the glossary must not hide it.
    let translated = crate::search_i18n::translate_query(search_text);
    let effective = translated.as_deref().unwrap_or(search_text);

    if resource_type == ResourceType::World {
        // Maps live on CurseForge, never Modrinth: Java in gameId 432 and
        // Bedrock in gameId 78022. The UI sends `loader=bedrock` to request the
        // Bedrock catalogue. `game_version` only applies to Java builds.
        let world_version = game_version
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "all");
        let mut result = if is_bedrock {
            crate::bedrock_store::search_bedrock_worlds(effective, offset, limit, sort)
                .await
                .map_err(|e| format!("搜索基岩版地图失败: {e}"))?
        } else {
            crate::bedrock_store::search_worlds(effective, world_version, offset, limit, sort)
                .await
                .map_err(|e| format!("搜索 Java 地图失败: {e}"))?
        };

        if result.total_hits == 0 && translated.is_some() {
            if let Ok(mut fallback) = if is_bedrock {
                crate::bedrock_store::search_bedrock_worlds(search_text, offset, limit, sort).await
            } else {
                crate::bedrock_store::search_worlds(search_text, world_version, offset, limit, sort)
                    .await
            } {
                if fallback.total_hits > 0 {
                    fallback.translated_query = translated.clone();
                    return Ok(fallback);
                }
            }
        }

        result.translated_query = translated;
        return Ok(result);
    }

    if is_bedrock {
        // Bedrock content is browsed through CurseForge, the catalogue
        // BedrockBoot-DM uses: add-ons and texture packs with real download
        // counts, icons and per-file CDN links.
        let mut result =
            crate::bedrock_store::search_bedrock(effective, &project_type, offset, limit, sort)
                .await
                .map_err(|e| format!("搜索基岩版资源失败: {e}"))?;

        if result.total_hits == 0 && translated.is_some() {
            if let Ok(mut fallback) = crate::bedrock_store::search_bedrock(
                search_text,
                &project_type,
                offset,
                limit,
                sort,
            )
            .await
            {
                if fallback.total_hits > 0 {
                    fallback.translated_query = translated.clone();
                    return Ok(fallback);
                }
            }
        }

        result.translated_query = translated;
        return Ok(result);
    }

    let mut result =
        search_modrinth(effective, facet, game_version, loader, sort, offset, limit).await?;

    if result.total_hits == 0 && translated.is_some() {
        if let Ok(mut fallback) = search_modrinth(
            search_text,
            facet,
            game_version,
            loader,
            sort,
            offset,
            limit,
        )
        .await
        {
            if fallback.total_hits > 0 {
                fallback.translated_query = translated.clone();
                return Ok(fallback);
            }
        }
    }

    result.translated_query = translated;
    Ok(result)
}

/// One Modrinth search request for a query that is already in English.
async fn search_modrinth(
    query: &str,
    project_type: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
    sort: Option<&str>,
    offset: u32,
    limit: u32,
) -> Result<SearchContentResult, String> {
    let index = match sort {
        Some("relevance") => "relevance",
        Some("newest") => "newest",
        Some("updated") => "updated",
        _ => "downloads",
    };

    let mut facets: Vec<Vec<String>> = Vec::new();
    // Project type facet: "project_type:mod" / "project_type:shader" / etc.
    facets.push(vec![format!("project_type:{project_type}")]);

    if let Some(v) = game_version
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all" && *s != "基岩版" && *s != "bedrock")
    {
        facets.push(vec![format!("versions:{v}")]);
    }

    if let Some(l) = loader
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all" && *s != "bedrock")
    {
        facets.push(vec![format!("categories:{}", l.to_lowercase())]);
    }

    let facets_json = serde_json::to_string(&facets).unwrap_or_else(|_| "[]".to_string());

    let url = format!(
        "https://api.modrinth.com/v2/search?query={}&facets={}&index={}&offset={}&limit={}",
        urlencoding(query),
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

    let hits: Vec<ContentHit> = raw
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

    Ok(SearchContentResult {
        hits,
        offset: raw.offset,
        limit: raw.limit,
        total_hits: raw.total_hits,
        translated_query: None,
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
    // Java worlds live on CurseForge too: their id carries the `cfw:` prefix
    // and their file list is the set of downloadable save archives.
    if let Some(raw_id) = project_id_or_slug.strip_prefix(crate::bedrock_store::WORLD_PREFIX) {
        let mod_id: u32 = raw_id
            .trim()
            .parse()
            .map_err(|_| format!("无效的地图项目 ID: {project_id_or_slug}"))?;
        let cache_key = format!("cfw:{mod_id}");
        if let Ok(cache) = version_list_cache().lock() {
            if let Some((fetched_at, cached)) = cache.get(&cache_key) {
                if fetched_at.elapsed() < VERSION_LIST_TTL {
                    return Ok(cached.clone());
                }
            }
        }
        let items = crate::bedrock_store::world_project_files(mod_id)
            .await
            .map_err(|e| format!("获取地图文件失败: {e}"))?;
        if let Ok(mut cache) = version_list_cache().lock() {
            if cache.len() >= VERSION_CACHE_MAX_ENTRIES {
                cache.clear();
            }
            cache.insert(cache_key, (Instant::now(), items.clone()));
        }
        return Ok(items);
    }

    // Bedrock worlds live on CurseForge: their id carries the `cbw:` prefix
    // and their files are `.mcworld` save archives.
    if let Some(raw_id) =
        project_id_or_slug.strip_prefix(crate::bedrock_store::BEDROCK_WORLD_PREFIX)
    {
        let mod_id: u32 = raw_id
            .trim()
            .parse()
            .map_err(|_| format!("无效的基岩版地图项目 ID: {project_id_or_slug}"))?;
        let cache_key = format!("cbw:{mod_id}");
        if let Ok(cache) = version_list_cache().lock() {
            if let Some((fetched_at, cached)) = cache.get(&cache_key) {
                if fetched_at.elapsed() < VERSION_LIST_TTL {
                    return Ok(cached.clone());
                }
            }
        }
        let items = crate::bedrock_store::bedrock_world_project_files(mod_id)
            .await
            .map_err(|e| format!("获取基岩版地图文件失败: {e}"))?;
        if let Ok(mut cache) = version_list_cache().lock() {
            if cache.len() >= VERSION_CACHE_MAX_ENTRIES {
                cache.clear();
            }
            cache.insert(cache_key, (Instant::now(), items.clone()));
        }
        return Ok(items);
    }

    // Bedrock projects live on CurseForge: their id carries the `cfb:` prefix
    // and their file list is the set of downloadable pack archives.
    if let Some(raw_id) = project_id_or_slug.strip_prefix(crate::bedrock_store::PROJECT_PREFIX) {
        let mod_id: u32 = raw_id
            .trim()
            .parse()
            .map_err(|_| format!("无效的基岩版项目 ID: {project_id_or_slug}"))?;
        let cache_key = format!("cfb:{mod_id}");
        if let Ok(cache) = version_list_cache().lock() {
            if let Some((fetched_at, cached)) = cache.get(&cache_key) {
                if fetched_at.elapsed() < VERSION_LIST_TTL {
                    return Ok(cached.clone());
                }
            }
        }
        let items = crate::bedrock_store::bedrock_project_files(mod_id)
            .await
            .map_err(|e| format!("获取基岩版项目文件失败: {e}"))?;
        if let Ok(mut cache) = version_list_cache().lock() {
            if cache.len() >= VERSION_CACHE_MAX_ENTRIES {
                cache.clear();
            }
            cache.insert(cache_key, (Instant::now(), items.clone()));
        }
        return Ok(items);
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

    let url = build_version_list_url(
        &project_id_or_slug,
        game_version.as_deref(),
        loader.as_deref(),
    );
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
/// `limit` keeps the response to a bounded recent window. Without it a popular
/// project returns its entire history (Fabric API: 1216 versions, 1.2 MB of
/// JSON, ~35s on a slow link) for a picker that only groups a few hundred rows.
fn build_version_list_url(
    project_id_or_slug: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
) -> String {
    let mut query_params = Vec::new();

    // Do NOT pass "基岩版" or "bedrock" to Modrinth version filter
    if let Some(v) = game_version
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all" && *s != "基岩版" && *s != "bedrock")
    {
        let gv_json = serde_json::to_string(&vec![v]).unwrap_or_default();
        query_params.push(format!("game_versions={}", urlencoding(&gv_json)));
    }
    if let Some(l) = loader
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all" && *s != "bedrock")
    {
        let l_json = serde_json::to_string(&vec![l.to_lowercase()]).unwrap_or_default();
        query_params.push(format!("loaders={}", urlencoding(&l_json)));
    }

    query_params.push(format!("limit={VERSION_LIST_LIMIT}"));

    format!(
        "https://api.modrinth.com/v2/project/{project_id_or_slug}/version?{}",
        query_params.join("&")
    )
}

pub(crate) fn urlencoding(input: &str) -> String {
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

/// Directory a downloaded content file is written to.
///
/// Mods are installed into the instance they were built for: the game reads
/// `versions/<id>/mods` for the version it launches, never a shared
/// `<root>/mods`, so `None` means the caller has to resolve an instance (or
/// explain why it cannot). The other types keep a root folder for the case
/// where no instance matches.
fn content_target_dir(
    root: &Path,
    project_type: &str,
    instance_id: Option<&str>,
) -> Option<PathBuf> {
    let instance = instance_id.filter(|s| !s.trim().is_empty());
    let per_instance = |folder: &str| match instance {
        Some(id) => Some(root.join("versions").join(id).join(folder)),
        None => Some(root.join(folder)),
    };
    match project_type {
        "mod" => instance.map(|id| root.join("versions").join(id).join("mods")),
        "shader" => per_instance("shaderpacks"),
        "datapack" => per_instance("datapacks"),
        "resourcepack" => per_instance("resourcepacks"),
        "modpack" => Some(root.join("modpacks")),
        "world" => Some(root.join("saves")),
        _ => Some(root.join("downloads")),
    }
}

/// Normalize a Minecraft version label for comparisons.
fn normalize_mc_version(value: &str) -> String {
    value.trim().trim_start_matches('v').to_lowercase()
}

/// Pick the installed Java version a downloaded mod belongs in.
///
/// A mod is built for one Minecraft version and one loader family. Dropping a
/// 1.20.1 Forge jar into the shared `<root>/mods` directory silently does
/// nothing for the instance the player actually launches, so when the caller
/// does not name an instance we look for a local version whose Minecraft
/// version matches the file — preferring one with the same loader.
///
/// Returns the newest matching instance, or `None` when the local setup has no
/// version the file was built for.
pub fn pick_mod_instance(
    installed: &[crate::minecraft::InstalledVersion],
    game_versions: &[String],
    loader: Option<&str>,
) -> Option<crate::minecraft::InstalledVersion> {
    let wanted: Vec<String> = game_versions
        .iter()
        .map(|v| normalize_mc_version(v))
        .filter(|v| !v.is_empty())
        .collect();
    if wanted.is_empty() {
        return None;
    }

    let candidates: Vec<&crate::minecraft::InstalledVersion> = installed
        .iter()
        .filter(|inst| match inst.mc_version.as_deref() {
            Some(mc) => {
                let mc = normalize_mc_version(mc);
                wanted.iter().any(|want| *want == mc)
            }
            None => false,
        })
        .collect();

    let wanted_loader = loader
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty() && l != "all");
    // Same loader first; a vanilla instance still beats the shared mods folder
    // when it is the only install for that Minecraft version.
    let narrowed: Vec<&crate::minecraft::InstalledVersion> = match wanted_loader {
        Some(ref want) => {
            let same_loader: Vec<&crate::minecraft::InstalledVersion> = candidates
                .iter()
                .copied()
                .filter(|inst| {
                    inst.loader
                        .as_deref()
                        .map(|have| have.eq_ignore_ascii_case(want))
                        .unwrap_or(false)
                })
                .collect();
            if same_loader.is_empty() {
                candidates
            } else {
                same_loader
            }
        }
        None => candidates,
    };

    narrowed
        .into_iter()
        .max_by_key(|inst| inst.installed_at)
        .cloned()
}

/// Turn a project title into a folder name the OS accepts.
fn world_folder_name(title: &str) -> String {
    let cleaned: String = title
        .trim()
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let mut name: String = trimmed.chars().take(60).collect();
    if name.is_empty() {
        name = "世界".to_string();
    }
    name
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaMapUpdate {
    pub project_id: String,
    pub current_file_id: String,
    pub latest_file_id: String,
    pub latest_name: String,
    pub latest_version: String,
    pub latest_filename: String,
    pub download_url: String,
    pub sha1: Option<String>,
    pub size: u64,
    pub update_available: bool,
}

/// Compare the file a map was installed from with the newest file the project
/// publishes. Only catalogs with a stable file API can support this, which is
/// why the check is limited to CurseForge worlds.
pub async fn check_java_world_update(
    project_id: String,
    current_file_id: String,
) -> Result<JavaMapUpdate, String> {
    let raw_id = project_id
        .trim()
        .strip_prefix(crate::bedrock_store::WORLD_PREFIX)
        .ok_or_else(|| format!("无效的地图项目 ID: {project_id}"))?;
    let mod_id: u32 = raw_id
        .trim()
        .parse()
        .map_err(|_| format!("无效的地图项目 ID: {project_id}"))?;

    let latest = crate::bedrock_store::world_project_files(mod_id)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "该地图没有可下载的文件".to_string())?;
    let file = latest
        .files
        .iter()
        .find(|file| file.primary)
        .or_else(|| latest.files.first())
        .ok_or_else(|| "该地图最新版本没有下载链接".to_string())?;
    let latest_file_id = latest.id.clone();
    let current = current_file_id.trim();

    Ok(JavaMapUpdate {
        project_id,
        current_file_id: current.to_string(),
        update_available: !current.is_empty() && !latest_file_id.eq_ignore_ascii_case(current),
        latest_file_id,
        latest_name: latest.name,
        latest_version: latest.version_number,
        latest_filename: file.filename.clone(),
        download_url: file.url.clone(),
        sha1: file.sha1.clone(),
        size: file.size,
    })
}

/// `saves/` folder a downloaded map must use for the selected instance.
/// Isolated versions read `versions/<id>/saves`; "none" shares the root.
fn world_saves_dir(
    root: &Path,
    instance_id: Option<&str>,
    isolation: Option<&str>,
) -> PathBuf {
    match instance_id.map(str::trim).filter(|value| !value.is_empty()) {
        Some(version_id) => {
            crate::minecraft::resolve_java_game_dir(root, version_id, isolation).join("saves")
        }
        None => root.join("saves"),
    }
}

/// Find the `level.dat` folder inside an extracted archive, at most two
/// levels deep. A save is often shipped inside a wrapper folder, and zipping
/// on macOS adds a `__MACOSX` sibling that must not count as a world.
fn collect_world_roots(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if dir.join("level.dat").is_file() {
        out.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "__MACOSX" || name.starts_with('.') {
            continue;
        }
        collect_world_roots(&path, depth - 1, out);
    }
}

/// Extract a downloaded save archive into `saves/<title>`, refusing archives
/// that do not contain exactly one `level.dat` world.
fn extract_world_archive(archive: &Path, saves: &Path, title: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(saves).map_err(|e| format!("创建 saves 目录失败: {e}"))?;
    let temp = saves.join(format!(
        ".extracting-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    if temp.exists() {
        let _ = std::fs::remove_dir_all(&temp);
    }
    std::fs::create_dir_all(&temp).map_err(|e| format!("创建临时目录失败: {e}"))?;

    let result = (|| {
        let file = std::fs::File::open(archive).map_err(|e| format!("无法打开地图压缩包: {e}"))?;
        let mut zip =
            zip::ZipArchive::new(file).map_err(|e| format!("不是有效的地图压缩文件: {e}"))?;
        for index in 0..zip.len() {
            let mut entry = zip
                .by_index(index)
                .map_err(|e| format!("读取地图压缩包失败: {e}"))?;
            let Some(path) = entry.enclosed_name() else {
                continue;
            };
            let out = temp.join(path);
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败: {e}"))?;
            } else {
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
                }
                let mut writer =
                    std::fs::File::create(&out).map_err(|e| format!("写入地图文件失败: {e}"))?;
                std::io::copy(&mut entry, &mut writer).map_err(|e| format!("解压地图失败: {e}"))?;
            }
        }

        let mut roots = Vec::new();
        collect_world_roots(&temp, 2, &mut roots);
        let source = match roots.len() {
            0 => {
                return Err(
                    "压缩包里没有找到 level.dat，这不是有效的 Minecraft 地图存档".to_string(),
                );
            }
            1 => roots.remove(0),
            _ => return Err("压缩包里包含多个世界，无法确定要安装哪一个".to_string()),
        };

        let base = world_folder_name(title);
        let mut target = saves.join(&base);
        let mut suffix = 2;
        while target.exists() {
            target = saves.join(format!("{base} ({suffix})"));
            suffix += 1;
        }

        std::fs::rename(&source, &target).map_err(|e| format!("移动到 saves 失败: {e}"))?;
        Ok(target)
    })();

    let _ = std::fs::remove_dir_all(&temp);
    result
}

pub async fn download_content_file(
    app: Option<&AppHandle>,
    request: DownloadContentRequest,
) -> Result<DownloadContentResult, String> {
    let root = net::absolute_path(&PathBuf::from(&request.root));
    let filename = Path::new(&request.filename)
        .file_name()
        .ok_or_else(|| "文件名无效".to_string())?
        .to_string_lossy()
        .to_string();

    let task_id = format!("content:{}:{}", request.project_type, filename);
    let title = if request.title.trim().is_empty() {
        filename.clone()
    } else {
        request.title.clone()
    };
    let threads = net::download_threads();
    let total_bytes = request.size.unwrap_or(0);

    let emit =
        |stage: &str, done: u64, total: u64, speed: u64, detail: &str, error: Option<String>| {
            if let Some(app) = app {
                let _ = app.emit(
                    "content:progress",
                    ContentProgressPayload {
                        id: task_id.clone(),
                        title: title.clone(),
                        filename: filename.clone(),
                        project_type: request.project_type.clone(),
                        stage: stage.to_string(),
                        detail: detail.to_string(),
                        done_bytes: done,
                        total_bytes: total,
                        speed_bps: speed,
                        threads,
                        error,
                    },
                );
            }
        };

    emit(
        "downloading",
        0,
        total_bytes,
        0,
        &format!("准备下载 {filename}"),
        None,
    );

    // Worlds are unpacked, never dropped as files: Java maps go to `saves/`,
    // Bedrock maps go to every `com.mojang/minecraftWorlds` the game reads.
    let is_bedrock_world =
        request.project_type == "world" && request.loader.as_deref() == Some("bedrock");
    if request.project_type == "world" {
        let download_dir = if is_bedrock_world {
            root.join("bedrock").join("cache").join("worlds")
        } else {
            root.join("downloads")
        };
        if let Err(e) = tokio::fs::create_dir_all(&download_dir).await {
            let err_msg = format!("创建下载目录失败: {e}");
            emit("error", 0, total_bytes, 0, &err_msg, Some(err_msg.clone()));
            return Err(err_msg);
        }
        let archive = download_dir.join(&filename);

        let mut last_emit = Instant::now();
        let mut last_bytes = 0u64;
        let mut current_speed = 0u64;
        let mut speed_smoother = net::SpeedSmoother::new();
        let mut progress_cb = |done: u64, total: u64, _delta: u64| {
            let now = Instant::now();
            let elapsed_ms = now.duration_since(last_emit).as_millis();
            if elapsed_ms >= 120 || (total > 0 && done >= total) {
                if elapsed_ms > 0 {
                    let instant = (done.saturating_sub(last_bytes) * 1000) / (elapsed_ms as u64);
                    current_speed = speed_smoother.update(instant, elapsed_ms as u64);
                }
                last_emit = now;
                last_bytes = done;
                let display_total = if total > 0 { total } else { total_bytes };
                emit(
                    "downloading",
                    done,
                    display_total,
                    current_speed,
                    &format!("正在下载地图 {filename}"),
                    None,
                );
            }
        };

        let bytes = match net::download_file_with_mirrors(
            &request.url,
            &archive,
            request.sha1.as_deref(),
            request.size,
            threads,
            None,
            Some(&mut progress_cb),
        )
        .await
        {
            Ok(bytes) => bytes,
            Err(e) => {
                emit(
                    "error",
                    last_bytes,
                    total_bytes,
                    0,
                    &format!("下载地图失败: {e}"),
                    Some(e.clone()),
                );
                return Err(e);
            }
        };

        if is_bedrock_world {
            emit(
                "extracting",
                bytes,
                bytes,
                0,
                "正在解压基岩版地图到 minecraftWorlds",
                None,
            );
            let archive_for_task = archive.clone();
            let root_for_task = root.clone();
            let install_result = tokio::task::spawn_blocking(move || {
                crate::bedrock::install_downloaded_bedrock_world(
                    &root_for_task,
                    &archive_for_task.to_string_lossy(),
                )
            })
            .await;
            let installed = match install_result {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => {
                    emit(
                        "error",
                        bytes,
                        total_bytes,
                        0,
                        &format!("安装基岩版地图失败: {error}"),
                        Some(error.clone()),
                    );
                    return Err(error);
                }
                Err(error) => {
                    let message = format!("基岩版地图解压任务失败: {error}");
                    emit(
                        "error",
                        bytes,
                        total_bytes,
                        0,
                        &message,
                        Some(message.clone()),
                    );
                    return Err(message);
                }
            };
            // The archive is reproducible from CurseForge; do not keep a second
            // copy of a potentially large world in the cache.
            let _ = tokio::fs::remove_file(&archive).await;
            emit("done", bytes, bytes, 0, &installed.message, None);
            return Ok(DownloadContentResult {
                success: true,
                file_path: installed.target_path,
                bytes,
                instance_id: None,
                auto_matched: false,
            });
        }

        // A world downloaded for a selected version belongs to that instance's
        // game directory. With isolation "all" that is `versions/<id>/saves`,
        // not the shared root; unpacking into the wrong folder made the map
        // invisible in game.
        let saves = world_saves_dir(
            &root,
            request.instance_id.as_deref(),
            request.isolation.as_deref(),
        );
        emit("extracting", bytes, bytes, 0, "正在解压地图到 saves", None);
        let archive_for_task = archive.clone();
        let title_for_task = title.clone();
        let target = tokio::task::spawn_blocking(move || {
            extract_world_archive(&archive_for_task, &saves, &title_for_task)
        })
        .await
        .map_err(|e| format!("地图解压任务失败: {e}"))?
        .map_err(|e| {
            emit(
                "error",
                bytes,
                total_bytes,
                0,
                &format!("安装地图失败: {e}"),
                Some(e.clone()),
            );
            e
        })?;

        if let (Some(project_id), Some(file_id)) = (
            request.source_project_id.clone(),
            request.source_file_id.clone(),
        ) {
            let source = crate::minecraft::JavaWorldSource {
                provider: "curseforge".to_string(),
                project_id,
                file_id,
                version: request.source_version.clone().unwrap_or_default(),
                title: request.title.clone(),
                url: request.url.clone(),
                installed_at: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0),
            };
            // Losing update metadata must not discard a completed world.
            let _ = crate::minecraft::write_java_world_source(&target, &source);
        }

        emit(
            "done",
            bytes,
            bytes,
            0,
            &format!("已安装到 {}", target.to_string_lossy()),
            None,
        );

        return Ok(DownloadContentResult {
            success: true,
            file_path: target.to_string_lossy().to_string(),
            bytes,
            instance_id: None,
            auto_matched: false,
        });
    }

    // Check if it's a bedrock pack or targeted for bedrock
    let lower_name = filename.to_lowercase();
    if request.instance_id.as_deref() == Some("bedrock")
        || lower_name.ends_with(".mcpack")
        || lower_name.ends_with(".mcaddon")
        || lower_name.ends_with(".mcworld")
    {
        let mut last_emit = Instant::now();
        let mut last_bytes = 0u64;
        let mut current_speed = 0u64;
        let mut speed_smoother = net::SpeedSmoother::new();

        let mut progress_cb = |done: u64, total: u64, _delta: u64| {
            let now = Instant::now();
            let elapsed_ms = now.duration_since(last_emit).as_millis();
            if elapsed_ms >= 120 || (total > 0 && done >= total) {
                if elapsed_ms > 0 {
                    let diff = done.saturating_sub(last_bytes);
                    let instant = (diff * 1000) / (elapsed_ms as u64);
                    current_speed = speed_smoother.update(instant, elapsed_ms as u64);
                }
                last_emit = now;
                last_bytes = done;
                let display_total = if total > 0 { total } else { total_bytes };
                emit(
                    "downloading",
                    done,
                    display_total,
                    current_speed,
                    &format!("正在下载 {filename}"),
                    None,
                );
            }
        };

        let res = match crate::bedrock::install_bedrock_pack(
            &root,
            &request.url,
            &filename,
            Some(&mut progress_cb),
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                emit(
                    "error",
                    last_bytes,
                    total_bytes,
                    0,
                    &format!("安装失败: {e}"),
                    Some(e.clone()),
                );
                return Err(e);
            }
        };

        let final_bytes = request.size.unwrap_or(last_bytes);
        emit("done", final_bytes, final_bytes, 0, "安装完成", None);

        return Ok(DownloadContentResult {
            success: true,
            file_path: res.target_path,
            bytes: final_bytes,
            instance_id: None,
            auto_matched: false,
        });
    }

    // Java mods are version- and loader-bound: resolve the instance before the
    // target directory is chosen so the jar lands where the game reads it.
    let mut instance_id = request
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut auto_matched = false;
    if instance_id.is_none() && request.project_type == "mod" && !request.game_versions.is_empty() {
        let installed = crate::minecraft::list_installed(&root).unwrap_or_default();
        if let Some(found) = pick_mod_instance(
            &installed,
            &request.game_versions,
            request.loader.as_deref(),
        ) {
            instance_id = Some(found.id);
            auto_matched = true;
        }
    }

    let target_dir = match content_target_dir(&root, &request.project_type, instance_id.as_deref())
    {
        Some(dir) => dir,
        None => {
            let versions = request
                .game_versions
                .iter()
                .map(|v| v.trim())
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
                .join(" / ");
            let wanted = if versions.is_empty() {
                "该模组支持的游戏版本".to_string()
            } else {
                versions
            };
            let loader = request
                .loader
                .as_deref()
                .map(str::trim)
                .filter(|l| !l.is_empty() && *l != "all")
                .map(|l| format!(" {l}"))
                .unwrap_or_default();
            let err_msg = format!(
                "本地没有与 {wanted}{loader} 匹配的游戏版本，模组只会安装到对应版本的 mods 目录。请先在版本列表里安装该版本，再回来下载。"
            );
            emit("error", 0, total_bytes, 0, &err_msg, Some(err_msg.clone()));
            return Err(err_msg);
        }
    };

    if let Err(e) = tokio::fs::create_dir_all(&target_dir).await {
        let err_msg = format!("创建目标目录失败: {e}");
        emit("error", 0, total_bytes, 0, &err_msg, Some(err_msg.clone()));
        return Err(err_msg);
    }

    let dest = target_dir.join(&filename);

    let mut last_emit = Instant::now();
    let mut last_bytes = 0u64;
    let mut current_speed = 0u64;
    let mut speed_smoother = net::SpeedSmoother::new();

    let mut progress_callback = |done: u64, total: u64, _delta: u64| {
        let now = Instant::now();
        let elapsed_ms = now.duration_since(last_emit).as_millis();
        if elapsed_ms >= 120 || (total > 0 && done >= total) {
            if elapsed_ms > 0 {
                let bytes_diff = done.saturating_sub(last_bytes);
                let instant = (bytes_diff * 1000) / (elapsed_ms as u64);
                current_speed = speed_smoother.update(instant, elapsed_ms as u64);
            }
            last_emit = now;
            last_bytes = done;
            let display_total = if total > 0 { total } else { total_bytes };
            let detail = format!("正在下载 {}", filename);
            emit(
                "downloading",
                done,
                display_total,
                current_speed,
                &detail,
                None,
            );
        }
    };

    let download_res = net::download_file_with_mirrors(
        &request.url,
        &dest,
        request.sha1.as_deref(),
        request.size,
        threads,
        None,
        Some(&mut progress_callback),
    )
    .await;

    let bytes = match download_res {
        Ok(b) => {
            let final_total = if b > 0 { b } else { total_bytes };
            emit("done", final_total, final_total, 0, "下载已完成", None);
            b
        }
        Err(e) => {
            emit(
                "error",
                last_bytes,
                total_bytes,
                0,
                &format!("下载失败: {e}"),
                Some(e.clone()),
            );
            return Err(e);
        }
    };

    Ok(DownloadContentResult {
        success: true,
        file_path: dest.to_string_lossy().to_string(),
        bytes,
        instance_id,
        auto_matched,
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_type_uses_pcl2_names_and_modrinth_facets() {
        assert_eq!(ResourceType::from_wire("mod"), ResourceType::Mod);
        assert_eq!(ResourceType::from_wire("modpack"), ResourceType::ModPack);
        assert_eq!(ResourceType::from_wire("datapack"), ResourceType::DataPack);
        assert_eq!(ResourceType::from_wire("shader"), ResourceType::Shader);
        assert_eq!(
            ResourceType::from_wire("resourcepack"),
            ResourceType::ResourcePack
        );
        assert_eq!(ResourceType::from_wire("world"), ResourceType::World);
        assert_eq!(ResourceType::from_wire("unknown"), ResourceType::Any);

        assert_eq!(ResourceType::Mod.as_modrinth_facet(), "mod");
        assert_eq!(ResourceType::ModPack.as_modrinth_facet(), "modpack");
        assert_eq!(ResourceType::Shader.as_modrinth_facet(), "shader");
        assert_eq!(ResourceType::Mod.as_type_name(), "Mod");
        assert_eq!(ResourceType::ResourcePack.as_type_name(), "资源包");
    }

    #[test]
    fn search_request_matches_pcl2_loader_input() {
        let first = SearchRequest::new(
            "钠".to_string(),
            "mod",
            None,
            None,
            Some("relevance".to_string()),
            0,
            20,
        );
        assert_eq!(first.offset, 0);
        assert_eq!(first.limit, 20);
        assert_eq!(first.target_result_count, 20);
        assert_eq!(first.loader_name, "社区资源获取：Mod");
        assert_eq!(first.sources, ResourcePlatform::Modrinth);
        assert!(!first.is_bedrock);

        // PCL2 `(Page + 1) * PAGE_SIZE`, Page = offset / limit (0-based).
        let third = SearchRequest::new("".to_string(), "modpack", None, None, None, 40, 20);
        assert_eq!(third.target_result_count, 60);
        assert_eq!(third.offset, 40);

        let bedrock = SearchRequest::new(
            "".to_string(),
            "shader",
            Some("基岩版".to_string()),
            Some("bedrock".to_string()),
            None,
            0,
            20,
        );
        assert!(bedrock.is_bedrock);
        assert_eq!(bedrock.sources, ResourcePlatform::CurseForge);

        let worlds = SearchRequest::new("".to_string(), "world", None, None, None, 0, 20);
        assert_eq!(worlds.sources, ResourcePlatform::CurseForge);
    }

    fn instance(
        id: &str,
        mc_version: Option<&str>,
        loader: Option<&str>,
        installed_at: u64,
    ) -> crate::minecraft::InstalledVersion {
        crate::minecraft::InstalledVersion {
            id: id.to_string(),
            version_type: "release".to_string(),
            installed_at,
            mc_version: mc_version.map(str::to_string),
            loader: loader.map(str::to_string),
            loader_version: None,
            optifine_version: None,
            fabric_api_version: None,
        }
    }

    #[test]
    fn target_dir_prefers_the_resolved_instance() {
        let root = PathBuf::from("/game");
        assert_eq!(
            content_target_dir(&root, "mod", Some("1.20.1-forge")),
            Some(
                PathBuf::from("/game")
                    .join("versions")
                    .join("1.20.1-forge")
                    .join("mods")
            )
        );
        // Mods never fall back to the shared `<root>/mods` folder.
        assert_eq!(content_target_dir(&root, "mod", None), None);
        // An empty instance id must not create a version folder named "".
        assert_eq!(content_target_dir(&root, "mod", Some("   ")), None);
        // Shaders and the other types keep their root folder.
        assert_eq!(
            content_target_dir(&root, "shader", None),
            Some(PathBuf::from("/game").join("shaderpacks"))
        );
    }

    #[test]
    fn mod_instance_matches_minecraft_version() {
        let installed = vec![
            instance("1.21.4-fabric", Some("1.21.4"), Some("fabric"), 10),
            instance("1.20.1-forge", Some("1.20.1"), Some("forge"), 20),
        ];
        let picked = pick_mod_instance(&installed, &["1.20.1".to_string()], Some("forge"))
            .expect("1.20.1 install exists");
        assert_eq!(picked.id, "1.20.1-forge");
    }

    #[test]
    fn mod_instance_prefers_the_requested_loader() {
        let installed = vec![
            instance("1.20.1-vanilla", Some("1.20.1"), None, 30),
            instance("1.20.1-fabric", Some("1.20.1"), Some("fabric"), 10),
        ];
        let picked = pick_mod_instance(&installed, &["1.20.1".to_string()], Some("Fabric"))
            .expect("fabric install exists");
        assert_eq!(picked.id, "1.20.1-fabric");
    }

    #[test]
    fn mod_instance_falls_back_to_any_build_of_that_version() {
        let installed = vec![instance("1.20.1-vanilla", Some("1.20.1"), None, 30)];
        let picked = pick_mod_instance(&installed, &["1.20.1".to_string()], Some("forge"))
            .expect("a 1.20.1 install exists");
        assert_eq!(picked.id, "1.20.1-vanilla");
    }

    #[test]
    fn mod_instance_ignores_other_game_versions() {
        let installed = vec![instance(
            "1.21.4-fabric",
            Some("1.21.4"),
            Some("fabric"),
            10,
        )];
        assert!(pick_mod_instance(&installed, &["1.20.1".to_string()], Some("fabric")).is_none());
        assert!(pick_mod_instance(&installed, &[], Some("fabric")).is_none());
    }

    #[test]
    fn mod_instance_matches_through_qualified_labels() {
        let installed = vec![instance(
            "1.20.1-fabric",
            Some("v1.20.1"),
            Some("fabric"),
            5,
        )];
        let picked = pick_mod_instance(&installed, &[" 1.20.1 ".to_string()], None)
            .expect("labels are normalized before comparing");
        assert_eq!(picked.id, "1.20.1-fabric");
    }

    #[test]
    fn world_folder_names_are_safe() {
        assert_eq!(world_folder_name("  Sky/Block: 2  "), "Sky_Block_ 2");
        assert_eq!(world_folder_name("..."), "世界");
        assert_eq!(world_folder_name("").chars().count(), 2);
    }

    #[test]
    fn world_archive_install_extracts_the_wrapper_and_dedupes_names() {
        use std::io::Write;

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base =
            std::env::temp_dir().join(format!("cobble-world-{}-{stamp}", std::process::id()));
        let saves = base.join("saves");
        std::fs::create_dir_all(&base).unwrap();
        let archive = base.join("world.zip");

        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("My World/level.dat", options).unwrap();
            writer.write_all(b"level").unwrap();
            writer
                .start_file("My World/region/r.0.0.mca", options)
                .unwrap();
            writer.write_all(b"region").unwrap();
            writer.finish().unwrap();
        }

        let first = extract_world_archive(&archive, &saves, "测试地图").unwrap();
        assert_eq!(first, saves.join("测试地图"));
        assert!(first.join("level.dat").is_file());
        assert!(first.join("region/r.0.0.mca").is_file());

        let second = extract_world_archive(&archive, &saves, "测试地图").unwrap();
        assert_eq!(second, saves.join("测试地图 (2)"));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn downloaded_maps_use_the_selected_versions_saves_folder() {
        let root = crate::net::absolute_path(Path::new("launcher-root"));
        let isolated = world_saves_dir(&root, Some("1.20.1"), Some("all"));
        assert!(isolated.ends_with(Path::new("versions").join("1.20.1").join("saves")));

        let shared = world_saves_dir(&root, Some("1.20.1"), Some("none"));
        assert_eq!(shared, root.join("saves"));

        assert_eq!(world_saves_dir(&root, None, None), root.join("saves"));
    }

    #[test]
    fn world_archive_rejects_a_zip_without_level_dat() {
        use std::io::Write;

        let base = std::env::temp_dir().join(format!(
            "cobble-world-invalid-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&base).unwrap();
        let archive = base.join("not-a-world.zip");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file("readme.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"not a world").unwrap();
            writer.finish().unwrap();
        }

        let err = extract_world_archive(&archive, &base.join("saves"), "坏包").unwrap_err();
        assert!(err.contains("level.dat"), "{err}");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn version_url_requests_only_the_visible_page() {
        assert_eq!(
            build_version_list_url("fabric-api", None, None),
            "https://api.modrinth.com/v2/project/fabric-api/version?limit=200"
        );
    }

    #[test]
    fn version_url_encodes_game_version_and_loader_filters() {
        let url = build_version_list_url("fabric-api", Some("1.20.1"), Some("Fabric"));
        assert!(url.contains("game_versions=%5B%221.20.1%22%5D"), "{url}");
        assert!(url.contains("loaders=%5B%22fabric%22%5D"), "{url}");
        assert!(url.ends_with("&limit=200"), "{url}");
    }

    #[test]
    fn version_url_omits_filters_that_mean_everything() {
        for value in ["all", "bedrock", "", "   "] {
            assert_eq!(
                build_version_list_url("pack", Some(value), Some(value)),
                "https://api.modrinth.com/v2/project/pack/version?limit=200",
                "value {value:?} should not become a filter"
            );
        }
    }
}
