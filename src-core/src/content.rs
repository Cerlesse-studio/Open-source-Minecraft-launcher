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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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

    // If explicitly searching bedrock (by loader or version)
    let is_bedrock = loader.as_deref() == Some("bedrock")
        || game_version.as_deref() == Some("bedrock")
        || game_version.as_deref() == Some("基岩版");

    // The catalogues index English metadata, so `钠` or `機械動力` found nothing.
    // Search the English keywords first; when even those return nothing the
    // raw query is retried, because a project can genuinely be titled in
    // Chinese and the glossary must not hide it.
    let translated = crate::search_i18n::translate_query(&query);
    let effective = translated.as_deref().unwrap_or(&query);

    if is_bedrock {
        // Bedrock content is browsed through CurseForge, the catalogue
        // BedrockBoot-DM uses: add-ons and texture packs with real download
        // counts, icons and per-file CDN links.
        let mut result = crate::bedrock_store::search_bedrock(
            effective,
            &project_type,
            offset,
            limit,
            sort.as_deref(),
        )
        .await
        .map_err(|e| format!("搜索基岩版资源失败: {e}"))?;

        if result.total_hits == 0 && translated.is_some() {
            if let Ok(fallback) = crate::bedrock_store::search_bedrock(
                &query,
                &project_type,
                offset,
                limit,
                sort.as_deref(),
            )
            .await
            {
                if fallback.total_hits > 0 {
                    return Ok(fallback);
                }
            }
        }

        result.translated_query = translated;
        return Ok(result);
    }

    let mut result = search_modrinth(
        effective,
        &project_type,
        game_version.as_deref(),
        loader.as_deref(),
        sort.as_deref(),
        offset,
        limit,
    )
    .await?;

    if result.total_hits == 0 && translated.is_some() {
        if let Ok(fallback) = search_modrinth(
            &query,
            &project_type,
            game_version.as_deref(),
            loader.as_deref(),
            sort.as_deref(),
            offset,
            limit,
        )
        .await
        {
            if fallback.total_hits > 0 {
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
    let lower_name = filename.to_lowercase();
    if request.instance_id.as_deref() == Some("bedrock")
        || lower_name.ends_with(".mcpack")
        || lower_name.ends_with(".mcaddon")
        || lower_name.ends_with(".mcworld")
    {
        let res = crate::bedrock::install_bedrock_pack(&root, &request.url, &filename).await?;
        return Ok(DownloadContentResult {
            success: true,
            file_path: res.target_path,
            bytes: request.size.unwrap_or(0),
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
            // No local instance was built for this file: refuse instead of
            // dropping it into a shared folder the game never reads.
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
            return Err(format!(
                "本地没有与 {wanted}{loader} 匹配的游戏版本，模组只会安装到对应版本的 mods 目录。请先在版本列表里安装该版本，再回来下载。"
            ));
        }
    };

    tokio::fs::create_dir_all(&target_dir)
        .await
        .map_err(|e| format!("创建目标目录失败: {e}"))?;

    let dest = target_dir.join(&filename);

    // Mods, resource packs, shaders and data packs share the same download
    // engine as game files: mirror fallback, the selected source, retries, the
    // atomic `.part` file and the configured thread count.
    let bytes = net::download_file_with_mirrors(
        &request.url,
        &dest,
        request.sha1.as_deref(),
        request.size,
        net::download_threads(),
        None,
        None,
    )
    .await?;

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
