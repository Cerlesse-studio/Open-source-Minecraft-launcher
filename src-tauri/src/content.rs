use crate::bridge::AppHandle;
use crate::net;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

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
    /// Catalogue the row came from ("modrinth" / "curseforge"). Java mods are
    /// indexed by both, so the list shows which site a result belongs to.
    #[serde(default)]
    pub source: Option<String>,
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
    /// Other projects this build needs before it runs.
    #[serde(default)]
    pub dependencies: Vec<ContentDependency>,
}

/// One project a build depends on.
///
/// Displayed under the version row so the user knows what else to install;
/// names are resolved from the catalogue, and `project_id` is the launcher's
/// id form (`cfj:<id>` for CurseForge, the raw Modrinth id otherwise) so a
/// future "install dependency" action can reuse it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDependency {
    pub project_id: String,
    /// Resolved title; falls back to the raw project id when the lookup fails.
    pub name: String,
    /// The exact build the author pinned (Modrinth only).
    #[serde(default)]
    pub version_id: Option<String>,
    /// File name the author suggests (Modrinth only).
    #[serde(default)]
    pub file_name: Option<String>,
    /// `true` when the game will not load without it.
    pub required: bool,
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
    // Both the translated keywords and the raw text are searched in parallel and
    // their rows merged: the translation matches how the catalogues are indexed,
    // while the raw query still finds a project that is titled in Chinese.
    // Searching only one of them either missed Chinese titles or returned
    // nothing at all.
    let variants = crate::search_i18n::query_variants(&query);
    let effective = variants.first().map(String::as_str).unwrap_or("");
    let original = variants.get(1).cloned();
    // Only a query the glossary actually rewrote is reported as translated.
    let translated = original.as_ref().and_then(|_| variants.first().cloned());

    if project_type == "world" {
        // Maps live on CurseForge, never Modrinth: Java in gameId 432 and
        // Bedrock in gameId 78022. The UI sends `loader=bedrock` to request the
        // Bedrock catalogue. `game_version` only applies to Java builds.
        let world_version = game_version
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "all");
        let (primary, fallback) = tokio::join!(
            search_worlds_any(
                effective,
                is_bedrock,
                world_version,
                offset,
                limit,
                sort.as_deref(),
            ),
            async {
                match original.as_deref() {
                    Some(text) => search_worlds_any(
                        text,
                        is_bedrock,
                        world_version,
                        offset,
                        limit,
                        sort.as_deref(),
                    )
                    .await
                    .ok(),
                    None => None,
                }
            }
        );
        let mut result = merge_searches(
            primary,
            fallback,
            if is_bedrock {
                "搜索基岩版地图失败"
            } else {
                "搜索 Java 地图失败"
            },
            limit,
        )?;
        result.translated_query = translated;
        return Ok(result);
    }

    if is_bedrock {
        // Bedrock content is browsed through CurseForge, the catalogue
        // BedrockBoot-DM uses: add-ons and texture packs with real download
        // counts, icons and per-file CDN links.
        let (primary, fallback) = tokio::join!(
            crate::bedrock_store::search_bedrock(
                effective,
                &project_type,
                offset,
                limit,
                sort.as_deref(),
            ),
            async {
                match original.as_deref() {
                    Some(text) => crate::bedrock_store::search_bedrock(
                        text,
                        &project_type,
                        offset,
                        limit,
                        sort.as_deref(),
                    )
                    .await
                    .ok(),
                    None => None,
                }
            }
        );
        let mut result = merge_searches(primary, fallback, "搜索基岩版资源失败", limit)?;
        result.translated_query = translated;
        return Ok(result);
    }

    // Java content is searched through the pcl-rust catalogue engine: one
    // session covers Modrinth and, for mods, CurseForge. The rows that are
    // published on both sites are deduplicated and ranked inside the session,
    // so the list no longer has to interleave two separate responses.
    let (primary, fallback) = tokio::join!(
        crate::pcl::search(
            effective,
            &project_type,
            game_version.as_deref(),
            loader.as_deref(),
            sort.as_deref(),
            offset,
            limit,
        ),
        async {
            match original.as_deref() {
                Some(text) => crate::pcl::search(
                    text,
                    &project_type,
                    game_version.as_deref(),
                    loader.as_deref(),
                    sort.as_deref(),
                    offset,
                    limit,
                )
                .await
                .ok(),
                None => None,
            }
        }
    );
    let mut result = merge_searches(primary, fallback, "搜索内容目录失败", limit)?;
    result.translated_query = translated;
    Ok(result)
}

/// Search either CurseForge world catalogue with one query.
async fn search_worlds_any(
    query: &str,
    is_bedrock: bool,
    game_version: Option<&str>,
    offset: u32,
    limit: u32,
    sort: Option<&str>,
) -> Result<SearchContentResult, String> {
    if is_bedrock {
        crate::bedrock_store::search_bedrock_worlds(query, offset, limit, sort).await
    } else {
        crate::bedrock_store::search_worlds(query, game_version, offset, limit, sort).await
    }
}

/// Combine the translated and the raw search for one page.
///
/// The primary list keeps its catalogue order and rows unique to the second
/// search fill the rest of the page. A failed primary request still returns the
/// other list, so one bad query spelling cannot fail the whole search.
fn merge_searches(
    primary: Result<SearchContentResult, String>,
    extra: Option<SearchContentResult>,
    error_label: &str,
    limit: u32,
) -> Result<SearchContentResult, String> {
    match primary {
        Ok(mut result) => {
            if let Some(extra) = extra {
                merge_extra_hits(&mut result, extra, limit);
            }
            Ok(result)
        }
        Err(error) => extra.ok_or_else(|| format!("{error_label}: {error}")),
    }
}

/// Append the rows the second search found that the first one did not have.
fn merge_extra_hits(primary: &mut SearchContentResult, extra: SearchContentResult, limit: u32) {
    let mut seen: std::collections::HashSet<String> =
        primary.hits.iter().map(|hit| hit.project_id.clone()).collect();
    // Either query alone may have more matches than the merged page shows, so
    // the larger total keeps the pager from ending early.
    primary.total_hits = primary.total_hits.max(extra.total_hits);
    for hit in extra.hits {
        if primary.hits.len() >= limit as usize {
            break;
        }
        if seen.insert(hit.project_id.clone()) {
            primary.hits.push(hit);
        }
    }
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

    // Java mods can also come from CurseForge: their id carries the `cfj:`
    // prefix and their file list is the jar builds the author published there.
    if let Some(raw_id) = project_id_or_slug.strip_prefix(crate::bedrock_store::JAVA_MOD_PREFIX) {
        let mod_id: u32 = raw_id
            .trim()
            .parse()
            .map_err(|_| format!("无效的模组项目 ID: {project_id_or_slug}"))?;
        let cache_key = format!("cfj:{mod_id}");
        if let Ok(cache) = version_list_cache().lock() {
            if let Some((fetched_at, cached)) = cache.get(&cache_key) {
                if fetched_at.elapsed() < VERSION_LIST_TTL {
                    return Ok(cached.clone());
                }
            }
        }
        let items = crate::bedrock_store::java_mod_project_files(mod_id)
            .await
            .map_err(|e| format!("获取模组文件失败: {e}"))?;
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

    // Modrinth builds come from the pcl-rust resource model: one bounded
    // request, normalized versions, and dependency titles resolved in a single
    // batch. The result is also cached to disk, so a project opened before still
    // opens offline.
    let items = crate::pcl::modrinth_versions(
        &project_id_or_slug,
        game_version.as_deref(),
        loader.as_deref(),
    )
    .await?;

    if let Ok(mut cache) = version_list_cache().lock() {
        if cache.len() >= VERSION_CACHE_MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(cache_key, (Instant::now(), items.clone()));
    }

    Ok(items)
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
///
/// Shaders follow the *game directory* of the selected version instead of a
/// literal `versions/<id>/shaderpacks`: with version isolation the game reads
/// `versions/<id>/shaderpacks`, but with isolation turned off it reads
/// `<root>/shaderpacks`, and a shader dropped into the other one silently never
/// shows up in the shader menu.
fn content_target_dir(
    root: &Path,
    project_type: &str,
    instance_id: Option<&str>,
    isolation: Option<&str>,
) -> Option<PathBuf> {
    let instance = instance_id.filter(|s| !s.trim().is_empty());
    let per_instance = |folder: &str| match instance {
        Some(id) => Some(root.join("versions").join(id).join(folder)),
        None => Some(root.join(folder)),
    };
    let in_game_dir = |folder: &str| match instance {
        Some(id) => Some(
            crate::minecraft::resolve_java_game_dir(root, id, isolation).join(folder),
        ),
        None => Some(root.join(folder)),
    };
    match project_type {
        "mod" => instance.map(|id| root.join("versions").join(id).join("mods")),
        "shader" => in_game_dir("shaderpacks"),
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

/// 取消内容下载后清掉这次的半成品：`.part`（以及续传旁车文件）。
///
/// 资源会被放进好几个目录（`downloads/`、基岩缓存、各实例的 `mods/`、
/// `shaderpacks/`……），取消时任务可能停在任意一步，所以按文件名把这些候选
/// 目录扫一遍，只删 `<filename>.part`，已经完成的文件一个都不动。
pub async fn discard_content_partial(root: &Path, filename: &str, project_type: &str) {
    let Some(file) = Path::new(filename).file_name().map(|name| name.to_owned()) else {
        return;
    };
    let bedrock_cache = root.join("bedrock").join("cache");
    let mut dirs = vec![
        root.join("downloads"),
        bedrock_cache.clone(),
        root.join("shaderpacks"),
        root.join("resourcepacks"),
        root.join("datapacks"),
        root.join("modpacks"),
    ];
    if project_type == "mod" {
        dirs.push(root.join("mods"));
    }
    // 基岩版的附加包和地图各自落在 `bedrock/cache/packs`、`.../worlds` 这类
    // 子目录里；把子目录一起扫上，否则取消附加包下载会永远留下 `.part`。
    if let Ok(mut entries) = tokio::fs::read_dir(&bedrock_cache).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
                dirs.push(entry.path());
            }
        }
    }
    // 版本隔离把资源放进 `versions/<id>/<folder>`，那里同样要清。
    if let Ok(mut entries) = tokio::fs::read_dir(root.join("versions")).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let version_dir = entry.path();
            for folder in [
                "mods",
                "shaderpacks",
                "resourcepacks",
                "datapacks",
                "modpacks",
            ] {
                dirs.push(version_dir.join(folder));
            }
        }
    }
    for dir in dirs {
        net::discard_partial_files(&dir.join(&file)).await;
    }
    sweep_partial_files(root, &file).await;
}

/// 目录清单之外的最后一道兜底：在游戏目录里有界地走一遍，只删名字匹配
/// `<filename>.part` / `<filename>.part.meta` 的文件。
///
/// 清单每次都会漏点东西（基岩附加包的 `bedrock/cache/packs` 就是这么漏的），
/// 而仓库里目录结构还会变；按文件名扫一遍就不依赖“作者记得加目录”了。
async fn sweep_partial_files(root: &Path, file: &std::ffi::OsStr) {
    const MAX_DEPTH: usize = 4;
    // 这些目录只装游戏资源与日志，不会有内容下载的半成品。
    const SKIP: [&str; 7] = [
        "assets",
        "libraries",
        "runtime",
        "logs",
        "crash-reports",
        "natives",
        ".git",
    ];
    let stem = file.to_string_lossy();
    let part_name = format!("{stem}.part");
    let meta_name = format!("{part_name}.meta");
    // pcl-download 的临时文件用另一套后缀（`.pcl-part` / `.pcl-seg-N` /
    // `.pcl-resume.json`）：取消时若引擎自己的清理没跑完，这里兜底删掉。
    let engine_part = format!("{stem}.pcl-part");
    let engine_resume = format!("{stem}.pcl-resume.json");
    let engine_segment = format!("{stem}.pcl-seg-");

    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_dir() {
                if depth >= MAX_DEPTH {
                    continue;
                }
                let name = entry.file_name();
                if name.to_str().is_some_and(|name| SKIP.contains(&name)) {
                    continue;
                }
                stack.push((entry.path(), depth + 1));
            } else if kind.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name == part_name
                    || name == meta_name
                    || name == engine_part
                    || name == engine_resume
                    || name.starts_with(&engine_segment)
                {
                    let _ = tokio::fs::remove_file(entry.path()).await;
                }
            }
        }
    }
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
        // 分片被回收时上报的 `done` 会回退，拿它做差分会把显示速度打成 0；
        // 这里累计“真正收到的字节”，速度始终单调。
        let mut received = 0u64;
        let mut progress_cb = |done: u64, total: u64, delta: u64| {
            received = received.saturating_add(delta);
            let now = Instant::now();
            let elapsed_ms = now.duration_since(last_emit).as_millis();
            if elapsed_ms >= 120 || (total > 0 && done >= total) {
                if elapsed_ms > 0 {
                    let instant = (received.saturating_sub(last_bytes) * 1000) / (elapsed_ms as u64);
                    current_speed = speed_smoother.update(instant, elapsed_ms as u64);
                }
                last_emit = now;
                last_bytes = received;
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

        // 传输层换成 pcl-rust 的分段引擎；镜像链仍由 `net::preferred_urls`
        // 按用户的镜像偏好排序后交给它依次尝试。
        let bytes = match crate::pcl::download_file(
            &request.url,
            &archive,
            request.sha1.as_deref(),
            request.size,
            threads,
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

        // 同上：用累计收到的字节算速度，不受分片回收导致的进度回退影响。
        let mut received = 0u64;
        let mut progress_cb = |done: u64, total: u64, delta: u64| {
            received = received.saturating_add(delta);
            let now = Instant::now();
            let elapsed_ms = now.duration_since(last_emit).as_millis();
            if elapsed_ms >= 120 || (total > 0 && done >= total) {
                if elapsed_ms > 0 {
                    let diff = received.saturating_sub(last_bytes);
                    let instant = (diff * 1000) / (elapsed_ms as u64);
                    current_speed = speed_smoother.update(instant, elapsed_ms as u64);
                }
                last_emit = now;
                last_bytes = received;
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

    let target_dir = match content_target_dir(
        &root,
        &request.project_type,
        instance_id.as_deref(),
        request.isolation.as_deref(),
    ) {
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

    // 同上：模组/资源包走分片下载，被回收的慢块会让 `done` 回退，
    // 用累计收到的字节算速度才不会出现“下载中却一直 0 B/s”。
    let mut received = 0u64;
    let mut progress_callback = |done: u64, total: u64, delta: u64| {
        received = received.saturating_add(delta);
        let now = Instant::now();
        let elapsed_ms = now.duration_since(last_emit).as_millis();
        if elapsed_ms >= 120 || (total > 0 && done >= total) {
            if elapsed_ms > 0 {
                let bytes_diff = received.saturating_sub(last_bytes);
                let instant = (bytes_diff * 1000) / (elapsed_ms as u64);
                current_speed = speed_smoother.update(instant, elapsed_ms as u64);
            }
            last_emit = now;
            last_bytes = received;
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

    let download_res = crate::pcl::download_file(
        &request.url,
        &dest,
        request.sha1.as_deref(),
        request.size,
        threads,
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

    /// 手动探针：用真实目录数据检查依赖字段（Modrinth 与 CurseForge 各一次）。
    /// `cargo test --lib -- --ignored --nocapture manual_dependency_probe`
    #[tokio::test]
    #[ignore = "manual probe against the live catalogues"]
    async fn manual_dependency_probe() {
        let cache =
            std::env::temp_dir().join(format!("cobble-dep-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        // SAFETY: 探针测试串行运行，没有其它线程在读这个变量。
        unsafe { std::env::set_var("OSML_METADATA_CACHE", &cache) };

        for (label, project) in [("Modrinth iris", "iris"), ("CurseForge JEI", "cfj:238222")] {
            let started = Instant::now();
            match get_content_versions(project.to_string(), None, None).await {
                Ok(items) => {
                    let with_deps: Vec<String> = items
                        .iter()
                        .filter(|v| !v.dependencies.is_empty())
                        .take(3)
                        .map(|v| {
                            let deps: Vec<String> = v
                                .dependencies
                                .iter()
                                .map(|d| {
                                    format!(
                                        "{}{}",
                                        d.name,
                                        if d.required { "" } else { "(可选)" }
                                    )
                                })
                                .collect();
                            format!("{} → [{}]", v.version_number, deps.join(", "))
                        })
                        .collect();
                    println!(
                        "{label}: {} 个构建，{} 个带依赖，耗时 {} ms\n  {}",
                        items.len(),
                        items.iter().filter(|v| !v.dependencies.is_empty()).count(),
                        started.elapsed().as_millis(),
                        with_deps.join("\n  ")
                    );
                }
                Err(error) => println!("{label}: 失败 {error}"),
            }
        }
        let _ = std::fs::remove_dir_all(&cache);
    }

    /// 手动探针：真实搜索一次（走网络）再一次（走磁盘缓存），打印两次耗时。
    /// `cargo test --lib -- --ignored --nocapture manual_search_cache_probe`
    #[tokio::test]
    #[ignore = "manual probe against the live catalogues"]
    async fn manual_search_cache_probe() {
        let cache = std::env::temp_dir().join(format!("cobble-probe-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        // SAFETY: 探针测试串行运行，没有其它线程在读这个变量。
        unsafe { std::env::set_var("OSML_METADATA_CACHE", &cache) };

        for attempt in 1..=2 {
            let started = Instant::now();
            let result = search_content(
                "sodium".to_string(),
                "mod".to_string(),
                None,
                None,
                None,
                0,
                20,
            )
            .await;
            match result {
                Ok(res) => println!(
                    "search #{attempt}: {:?} 内返回 {} 条（总 {}），耗时 {} ms",
                    started.elapsed(),
                    res.hits.len(),
                    res.total_hits,
                    started.elapsed().as_millis()
                ),
                Err(error) => println!("search #{attempt}: 失败 {}（{} ms）", error, started.elapsed().as_millis()),
            }
        }
        let _ = std::fs::remove_dir_all(&cache);
    }

    /// 取消下载后只删半成品：`downloads/`、基岩缓存和版本目录里的 `.part`
    /// 都要清掉，已经下完的正式文件和其他版本的文件必须留着。
    #[tokio::test]
    async fn cancelling_a_download_only_removes_partial_files() {
        let root = std::env::temp_dir().join(format!(
            "cobble-discard-{}",
            std::process::id() as u64 * 1000 + 7
        ));
        let _ = std::fs::remove_dir_all(&root);
        let staging = root.join("downloads");
        let shaders = root.join("versions").join("1.21.1").join("shaderpacks");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::create_dir_all(&shaders).unwrap();
        std::fs::write(staging.join("BSL.zip.part"), b"half").unwrap();
        std::fs::write(staging.join("BSL.zip.part.meta"), b"{}").unwrap();
        std::fs::write(shaders.join("BSL.zip.part"), b"half").unwrap();
        std::fs::write(shaders.join("BSL.zip"), b"done").unwrap();
        std::fs::write(shaders.join("other.zip.part"), b"half").unwrap();

        discard_content_partial(&root, "BSL.zip", "shader").await;

        assert!(!staging.join("BSL.zip.part").exists());
        assert!(!staging.join("BSL.zip.part.meta").exists());
        assert!(!shaders.join("BSL.zip.part").exists());
        // 已完成的包与别的包都不能被误删。
        assert!(shaders.join("BSL.zip").exists());
        assert!(shaders.join("other.zip.part").exists());

        // 基岩版附加包落在 `bedrock/cache/packs`，取消后同样不能留半成品。
        let packs = root.join("bedrock").join("cache").join("packs");
        std::fs::create_dir_all(&packs).unwrap();
        std::fs::write(packs.join("Addon.mcpack.part"), b"half").unwrap();
        std::fs::write(packs.join("Addon.mcpack.part.meta"), b"{}").unwrap();
        std::fs::write(packs.join("Keep.mcpack"), b"done").unwrap();

        discard_content_partial(&root, "Addon.mcpack", "resourcepack").await;

        assert!(!packs.join("Addon.mcpack.part").exists());
        assert!(!packs.join("Addon.mcpack.part.meta").exists());
        assert!(packs.join("Keep.mcpack").exists());

        // 清单之外的新目录也是由兜底扫描清掉的，同时不能动其他文件。
        let custom = root.join("custom-cache").join("deep");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join("Addon.mcpack.part"), b"half").unwrap();
        std::fs::write(custom.join("Addon.mcpack"), b"done").unwrap();

        discard_content_partial(&root, "Addon.mcpack", "resourcepack").await;

        assert!(!custom.join("Addon.mcpack.part").exists());
        assert!(custom.join("Addon.mcpack").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn target_dir_prefers_the_resolved_instance() {
        let root = PathBuf::from("/game");
        assert_eq!(
            content_target_dir(&root, "mod", Some("1.20.1-forge"), None),
            Some(
                PathBuf::from("/game")
                    .join("versions")
                    .join("1.20.1-forge")
                    .join("mods")
            )
        );
        // Mods never fall back to the shared `<root>/mods` folder.
        assert_eq!(content_target_dir(&root, "mod", None, None), None);
        // An empty instance id must not create a version folder named "".
        assert_eq!(content_target_dir(&root, "mod", Some("   "), None), None);
        // Without an instance the other types keep their root folder.
        assert_eq!(
            content_target_dir(&root, "shader", None, None),
            Some(PathBuf::from("/game").join("shaderpacks"))
        );
    }

    /// 光影必须落到游戏真正读取的那个 `shaderpacks`：开了版本隔离是
    /// `versions/<id>/shaderpacks`，关了隔离则是 `<root>/shaderpacks`。
    #[test]
    fn shaders_follow_the_game_directory_of_the_selected_version() {
        let root = PathBuf::from("/game");
        // `resolve_java_game_dir` absolutises the root, so compare the tail
        // instead of the whole path.
        let per_version = PathBuf::from("versions")
            .join("1.21.1-neoforge")
            .join("shaderpacks");
        for isolation in [None, Some("all"), Some("  ")] {
            let target = content_target_dir(&root, "shader", Some("1.21.1-neoforge"), isolation)
                .expect("shader target dir");
            assert!(
                target.ends_with(&per_version),
                "{target:?} should end with {per_version:?}"
            );
        }
        // Isolation off: the game reads the shared folder, so the shader must
        // not be buried in a version folder it never opens.
        let shared = content_target_dir(&root, "shader", Some("1.21.1-neoforge"), Some("none"))
            .expect("shader target dir");
        assert_eq!(shared.file_name().and_then(|n| n.to_str()), Some("shaderpacks"));
        assert!(
            !shared.to_string_lossy().contains("versions"),
            "{shared:?} must be the shared shaderpacks folder"
        );
    }

    fn hit(project_id: &str, downloads: u64) -> ContentHit {
        ContentHit {
            project_id: project_id.to_string(),
            slug: project_id.to_string(),
            author: "author".to_string(),
            title: project_id.to_string(),
            description: String::new(),
            categories: Vec::new(),
            versions: Vec::new(),
            downloads,
            follows: 0,
            icon_url: None,
            date_created: None,
            date_modified: None,
            latest_version: None,
            project_type: "mod".to_string(),
            source: None,
        }
    }

    fn page(ids: &[&str], total_hits: u32) -> SearchContentResult {
        SearchContentResult {
            hits: ids.iter().map(|id| hit(id, 0)).collect(),
            offset: 0,
            limit: 20,
            total_hits,
            translated_query: None,
        }
    }

    #[test]
    fn merged_search_keeps_primary_order_and_drops_duplicates() {
        // The translated search leads; the raw Chinese search only contributes
        // the rows the translation did not already cover.
        let mut result = page(&["sodium", "lithium"], 2);
        merge_extra_hits(&mut result, page(&["lithium", "钠", "钠二"], 7), 4);
        let ids: Vec<&str> = result.hits.iter().map(|h| h.project_id.as_str()).collect();
        assert_eq!(ids, vec!["sodium", "lithium", "钠", "钠二"]);
        // The pager must not end before the larger of the two result sets.
        assert_eq!(result.total_hits, 7);
    }

    #[test]
    fn merged_search_fills_only_to_the_page_limit() {
        let mut result = page(&["a", "b"], 2);
        merge_extra_hits(&mut result, page(&["c", "d", "e"], 5), 3);
        let ids: Vec<&str> = result.hits.iter().map(|h| h.project_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
    }

    #[test]
    fn a_failed_primary_search_falls_back_to_the_other_list() {
        let merged = merge_searches(Err("boom".to_string()), Some(page(&["钠"], 1)), "失败", 20)
            .expect("fallback rows survive");
        assert_eq!(merged.hits.len(), 1);
        assert_eq!(merged.total_hits, 1);

        let error = merge_searches(Err("boom".to_string()), None, "失败", 20).unwrap_err();
        assert!(error.contains("失败"), "{error}");
        assert!(error.contains("boom"), "{error}");
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

}
