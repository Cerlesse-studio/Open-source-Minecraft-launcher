//! Bedrock Edition add-on store backed by the CurseForge API.
//!
//! BedrockBoot-DM (the reference launcher this project follows) browses Bedrock
//! content through CurseForge, whose Bedrock game id is 78022, and lets the user
//! pick a different API host — the official one or the MCIM mirror. That is the
//! approach implemented here:
//!
//! * `https://api.curseforge.com/` — the official host. It needs an `x-api-key`
//!   header, read from `CURSEFORGE_API_KEY` / `COBBLE_CURSEFORGE_API_KEY`.
//! * `https://mod.mcimirror.top/curseforge/` — a keyless read-only mirror with
//!   the same REST shapes. It is tried first so the store works out of the box.
//!
//! Everything the launcher displays is real: names, icons, download counts and
//! file lists come from the API, and a download resolves to the CDN URL the API
//! reports for that exact file (never a hand-written URL).

use crate::content::{ContentFile, ContentHit, ContentVersionItem, SearchContentResult};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::time::Duration;

/// CurseForge game id for Minecraft Bedrock Edition.
pub const BEDROCK_GAME_ID: u32 = 78022;
/// CurseForge game id for Minecraft: Java Edition.
///
/// These are the same identifiers HMCL uses in its
/// `CurseForgeRemoteAddonRepository`: `gameId=432` and `SECTION_WORLD=17`.
pub const JAVA_GAME_ID: u32 = 432;

/// CurseForge class ids of the Bedrock sections the launcher browses.
const CLASS_ADDONS: u32 = 4984;
const CLASS_TEXTURE_PACKS: u32 = 6929;
/// CurseForge class id of the Bedrock Edition "Maps" section.
const CLASS_BEDROCK_WORLDS: u32 = 6913;
/// CurseForge class id of the Java Edition "Worlds" section.
const CLASS_WORLDS: u32 = 17;

/// Prefix that marks a launcher project id as a CurseForge Bedrock project.
pub const PROJECT_PREFIX: &str = "cfb:";
/// Prefix that marks a launcher project id as a CurseForge Java world.
pub const WORLD_PREFIX: &str = "cfw:";
/// Prefix that marks a launcher project id as a CurseForge Bedrock world.
pub const BEDROCK_WORLD_PREFIX: &str = "cbw:";

/// Which CurseForge catalogue a project came from. The two share the same REST
/// shapes but need different labels, id prefixes and version fallbacks.
#[derive(Clone, Copy, PartialEq)]
enum Catalog {
    Bedrock,
    World,
    BedrockWorld,
}

const MCIM_BASE: &str = "https://mod.mcimirror.top/curseforge/";
const OFFICIAL_BASE: &str = "https://api.curseforge.com/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const FILE_LIST_PAGE_SIZE: u32 = 50;

struct CfSource {
    base: &'static str,
    label: &'static str,
    api_key: Option<String>,
}

fn api_key_from_env() -> Option<String> {
    for key in ["CURSEFORGE_API_KEY", "COBBLE_CURSEFORGE_API_KEY"] {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    None
}

/// Hosts to try, in order. The official host only joins the list when a key is
/// available, because without one it answers 403 for every request.
fn sources() -> Vec<CfSource> {
    let key = api_key_from_env();
    let mut sources = vec![CfSource {
        base: MCIM_BASE,
        label: "CurseForge (MCIM 镜像)",
        api_key: None,
    }];
    if let Some(api_key) = key {
        sources.insert(
            0,
            CfSource {
                base: OFFICIAL_BASE,
                label: "CurseForge 官方",
                api_key: Some(api_key),
            },
        );
    }
    sources
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// GET one API path from the first host that answers successfully.
async fn get_json<T: DeserializeOwned>(path: &str) -> Result<(T, String), String> {
    let mut failures: Vec<String> = Vec::new();
    for source in sources() {
        let url = format!("{}{}", source.base, path);
        let mut request = crate::net::client()
            .get(&url)
            .timeout(REQUEST_TIMEOUT)
            .header("Accept", "application/json");
        if let Some(ref key) = source.api_key {
            request = request.header("x-api-key", key);
        }
        match request.send().await {
            Ok(response) if response.status().is_success() => {
                let body = response
                    .text()
                    .await
                    .map_err(|e| format!("{} 响应读取失败: {e}", source.label))?;
                match serde_json::from_str::<T>(&body) {
                    Ok(value) => return Ok((value, source.label.to_string())),
                    Err(e) => failures.push(format!("{} 返回了无法解析的数据: {e}", source.label)),
                }
            }
            Ok(response) => {
                let status = response.status();
                failures.push(format!(
                    "{} 请求失败: HTTP {}（{}）",
                    source.label,
                    status.as_u16(),
                    path
                ));
            }
            Err(err) => failures.push(format!("{} 无法连接: {err}", source.label)),
        }
    }

    let hint = if api_key_from_env().is_none() {
        "。可设置环境变量 CURSEFORGE_API_KEY 使用 CurseForge 官方源"
    } else {
        ""
    };
    Err(format!("{}{hint}", failures.join("；")))
}

// ---------------------------------------------------------------------------
// Wire types (CurseForge REST schema, trimmed to what the launcher shows)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CfPagination {
    #[serde(default)]
    total_count: u32,
}

#[derive(Debug, Deserialize)]
struct CfList<T> {
    data: Vec<T>,
    #[serde(default)]
    pagination: Option<CfPagination>,
}

#[derive(Debug, Deserialize)]
struct CfValue<T> {
    data: T,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CfAuthor {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CfLogo {
    #[serde(default)]
    thumbnail_url: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CfCategory {
    #[serde(default)]
    name: String,
    #[serde(default)]
    is_class: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CfHash {
    #[serde(default)]
    value: String,
    #[serde(default)]
    algo: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CfFile {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    file_length: u64,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    game_versions: Vec<String>,
    #[serde(default)]
    file_date: Option<String>,
    #[serde(default)]
    download_count: u64,
    #[serde(default)]
    hashes: Vec<CfHash>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CfFileIndex {
    #[serde(default)]
    game_version: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CfProject {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    name: String,
    #[serde(default)]
    slug: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    download_count: u64,
    #[serde(default)]
    favorite_count: u64,
    #[serde(default)]
    authors: Vec<CfAuthor>,
    #[serde(default)]
    logo: Option<CfLogo>,
    #[serde(default)]
    categories: Vec<CfCategory>,
    #[serde(default)]
    latest_files: Vec<CfFile>,
    #[serde(default)]
    latest_files_indexes: Vec<CfFileIndex>,
    #[serde(default)]
    date_created: Option<String>,
    #[serde(default)]
    date_modified: Option<String>,
}

fn class_for_project_type(project_type: &str) -> u32 {
    match project_type {
        "shader" | "resourcepack" => CLASS_TEXTURE_PACKS,
        _ => CLASS_ADDONS,
    }
}

fn class_label(class_id: u32) -> &'static str {
    match class_id {
        CLASS_TEXTURE_PACKS => "材质包",
        CLASS_ADDONS => "附加包",
        CLASS_WORLDS | CLASS_BEDROCK_WORLDS => "地图",
        _ => "基岩版",
    }
}

fn sort_field(sort: Option<&str>) -> u32 {
    // CurseForge sort fields: 2 popularity, 3 last updated, 6 total downloads,
    // 11 released date.
    match sort.unwrap_or("downloads") {
        "updated" => 3,
        "newest" => 11,
        "relevance" => 2,
        _ => 6,
    }
}

fn hit_from_project(
    project: CfProject,
    project_type: &str,
    class_id: u32,
    catalog: Catalog,
) -> ContentHit {
    let author = if project.authors.is_empty() {
        "CurseForge".to_string()
    } else {
        project
            .authors
            .iter()
            .map(|a| a.name.trim())
            .filter(|n| !n.is_empty())
            .collect::<Vec<_>>()
            .join("、")
    };

    let mut categories = match catalog {
        Catalog::Bedrock => vec![
            "bedrock".to_string(),
            "基岩版".to_string(),
            class_label(class_id).to_string(),
        ],
        Catalog::World => vec!["world".to_string(), "地图".to_string()],
        Catalog::BedrockWorld => vec![
            "world".to_string(),
            "地图".to_string(),
            "bedrock".to_string(),
            "基岩版".to_string(),
        ],
    };
    if let Some(sub) = project
        .categories
        .iter()
        .find(|c| !c.is_class && !c.name.trim().is_empty())
    {
        if !categories.iter().any(|c| c == sub.name.trim()) {
            categories.push(sub.name.trim().to_string());
        }
    }

    let mut versions: Vec<String> = Vec::new();
    for index in &project.latest_files_indexes {
        let version = index.game_version.trim();
        if !version.is_empty() && !versions.iter().any(|v| v == version) {
            versions.push(version.to_string());
        }
        if versions.len() >= 4 {
            break;
        }
    }
    if versions.is_empty() {
        for file in &project.latest_files {
            for version in &file.game_versions {
                let version = version.trim();
                if !version.is_empty() && !versions.iter().any(|v| v == version) {
                    versions.push(version.to_string());
                }
            }
        }
    }
    if matches!(catalog, Catalog::Bedrock | Catalog::BedrockWorld) {
        versions.push("基岩版".to_string());
    }

    let latest = project.latest_files.first();
    let latest_version = latest.map(|file| {
        file.display_name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| file.file_name.clone())
    });

    let prefix = match catalog {
        Catalog::Bedrock => PROJECT_PREFIX,
        Catalog::World => WORLD_PREFIX,
        Catalog::BedrockWorld => BEDROCK_WORLD_PREFIX,
    };

    ContentHit {
        project_id: format!("{prefix}{}", project.id),
        slug: project
            .slug
            .filter(|slug| !slug.trim().is_empty())
            .unwrap_or_else(|| project.id.to_string()),
        author,
        title: project.name,
        description: project.summary.unwrap_or_default(),
        categories,
        versions,
        downloads: project.download_count,
        follows: project.favorite_count,
        icon_url: project
            .logo
            .and_then(|logo| logo.thumbnail_url.or(logo.url))
            .filter(|url| !url.trim().is_empty()),
        date_created: project.date_created,
        date_modified: project.date_modified,
        latest_version,
        project_type: project_type.to_string(),
    }
}

/// Search Bedrock projects on CurseForge.
pub async fn search_bedrock(
    query: &str,
    project_type: &str,
    offset: u32,
    limit: u32,
    sort: Option<&str>,
) -> Result<SearchContentResult, String> {
    let class_id = class_for_project_type(project_type);
    search_catalog(
        query,
        project_type,
        BEDROCK_GAME_ID,
        class_id,
        Catalog::Bedrock,
        None,
        offset,
        limit,
        sort,
    )
    .await
}

/// Search Bedrock Edition maps (the CurseForge "Maps" section).
///
/// Bedrock worlds are `.mcworld` archives. They are installed into every
/// `com.mojang/minecraftWorlds` folder rather than a Java `saves/` directory.
pub async fn search_bedrock_worlds(
    query: &str,
    offset: u32,
    limit: u32,
    sort: Option<&str>,
) -> Result<SearchContentResult, String> {
    search_catalog(
        query,
        "world",
        BEDROCK_GAME_ID,
        CLASS_BEDROCK_WORLDS,
        Catalog::BedrockWorld,
        None,
        offset,
        limit,
        sort,
    )
    .await
}

/// Search Java Edition worlds (the CurseForge "Worlds" section).
///
/// Worlds are plain save archives: the installer unpacks them into `saves/`
/// instead of dropping a jar into a version folder.
pub async fn search_worlds(
    query: &str,
    game_version: Option<&str>,
    offset: u32,
    limit: u32,
    sort: Option<&str>,
) -> Result<SearchContentResult, String> {
    search_catalog(
        query,
        "world",
        JAVA_GAME_ID,
        CLASS_WORLDS,
        Catalog::World,
        game_version,
        offset,
        limit,
        sort,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn search_catalog(
    query: &str,
    project_type: &str,
    game_id: u32,
    class_id: u32,
    catalog: Catalog,
    game_version: Option<&str>,
    offset: u32,
    limit: u32,
    sort: Option<&str>,
) -> Result<SearchContentResult, String> {
    let limit = limit.clamp(1, 50);
    let mut path = format!(
        "v1/mods/search?gameId={game_id}&classId={class_id}&index={offset}&pageSize={limit}&sortField={}&sortOrder=desc",
        sort_field(sort)
    );
    let query = query.trim();
    if !query.is_empty() {
        path.push_str(&format!("&searchFilter={}", percent_encode(query)));
    }
    if let Some(version) = game_version
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all" && *value != "基岩版")
    {
        path.push_str(&format!("&gameVersion={}", percent_encode(version)));
    }

    let (response, _source): (CfList<CfProject>, String) = get_json(&path).await?;
    let total_hits = response
        .pagination
        .as_ref()
        .map(|p| p.total_count)
        .unwrap_or_else(|| response.data.len() as u32);

    Ok(SearchContentResult {
        hits: response
            .data
            .into_iter()
            .map(|project| hit_from_project(project, project_type, class_id, catalog))
            .collect(),
        offset,
        limit,
        total_hits,
        // The launcher fills this in after substituting English keywords.
        translated_query: None,
    })
}

#[cfg(test)]
fn file_to_version(mod_id: u32, file: CfFile) -> ContentVersionItem {
    file_to_version_with(mod_id, file, "bedrock", "基岩版")
}

/// Map a CurseForge file to the launcher's download row. Worlds use the same
/// schema but carry the `world` loader and fall back to a version label of
/// "Java 版" when the author did not tag a Minecraft version.
fn file_to_version_with(
    mod_id: u32,
    file: CfFile,
    loader: &str,
    fallback_version: &str,
) -> ContentVersionItem {
    let download_url = file.download_url.clone().unwrap_or_default();
    let sha1 = file
        .hashes
        .iter()
        .find(|hash| hash.algo == 1)
        .map(|hash| hash.value.clone())
        .filter(|value| !value.trim().is_empty());
    let version_number = file
        .game_versions
        .first()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_version.to_string());
    let display_name = file
        .display_name
        .clone()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| file.file_name.clone());

    ContentVersionItem {
        id: format!("{mod_id}:{}", file.id),
        name: display_name,
        version_number,
        game_versions: file.game_versions,
        loaders: vec![loader.to_string()],
        date_published: file.file_date,
        downloads: file.download_count,
        files: vec![ContentFile {
            url: download_url,
            filename: file.file_name,
            primary: true,
            size: file.file_length,
            sha1,
        }],
    }
}

/// Ask the API for the CDN URL of one file. CurseForge omits `downloadUrl` for
/// projects whose author opted out of third-party distribution; the dedicated
/// endpoint still resolves a usable link for them.
async fn resolve_download_url(mod_id: u32, file_id: u32) -> Option<String> {
    let path = format!("v1/mods/{mod_id}/files/{file_id}/download-url");
    let (value, _source): (CfValue<Option<String>>, String) = get_json(&path).await.ok()?;
    value.data.filter(|url| !url.trim().is_empty())
}

/// Every downloadable file of one Bedrock project, newest first.
pub async fn bedrock_project_files(mod_id: u32) -> Result<Vec<ContentVersionItem>, String> {
    project_files(mod_id, "bedrock", "基岩版").await
}

/// Every downloadable file of one Java world, newest first.
pub async fn world_project_files(mod_id: u32) -> Result<Vec<ContentVersionItem>, String> {
    project_files(mod_id, "world", "Java 版").await
}

/// Every downloadable file of one Bedrock world, newest first.
pub async fn bedrock_world_project_files(mod_id: u32) -> Result<Vec<ContentVersionItem>, String> {
    project_files(mod_id, "bedrock", "基岩版").await
}

async fn project_files(
    mod_id: u32,
    loader: &str,
    fallback_version: &str,
) -> Result<Vec<ContentVersionItem>, String> {
    let path = format!("v1/mods/{mod_id}/files?index=0&pageSize={FILE_LIST_PAGE_SIZE}");
    let (response, _source): (CfList<CfFile>, String) = get_json(&path).await?;

    let mut items = Vec::new();
    for file in response.data {
        let mut version = file_to_version_with(mod_id, file.clone(), loader, fallback_version);
        if let Some(entry) = version.files.first_mut() {
            if entry.url.trim().is_empty() {
                if let Some(url) = resolve_download_url(mod_id, file.id).await {
                    entry.url = url;
                }
            }
        }
        if version
            .files
            .first()
            .map(|f| f.url.trim().is_empty())
            .unwrap_or(true)
        {
            // No usable link: the file is no longer downloadable, so showing it
            // would only give the user a button that always fails.
            continue;
        }
        items.push(version);
    }

    items.sort_by(|a, b| b.date_published.cmp(&a.date_published));
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROJECT_FIXTURE: &str = r#"{
        "id": 1575941,
        "name": "Verity - Bedrock Edition",
        "slug": "verity-bedrock-edition",
        "summary": "A realistic mob add-on.",
        "downloadCount": 15857831,
        "favoriteCount": 4210,
        "dateCreated": "2025-06-01T10:00:00Z",
        "dateModified": "2026-09-17T09:05:26.977Z",
        "authors": [{"name": "PnTMC"}],
        "logo": {"thumbnailUrl": "https://media.forgecdn.net/a.png"},
        "categories": [{"name": "Addons", "isClass": true}, {"name": "Mobs", "isClass": false}],
        "latestFiles": [{"id": 8902437, "fileName": "Verity.mcaddon", "displayName": "Verity 4.0.0", "fileLength": 37688517, "downloadUrl": "https://edge.forgecdn.net/files/8902/437/Verity.mcaddon", "gameVersions": ["26.50"], "fileDate": "2026-09-17T09:05:26.977Z", "downloadCount": 15345}],
        "latestFilesIndexes": [{"gameVersion": "26.50", "fileId": 8902437}]
    }"#;

    #[test]
    fn maps_a_curseforge_project_to_a_launcher_hit() {
        let project: CfProject = serde_json::from_str(PROJECT_FIXTURE).unwrap();
        let hit = hit_from_project(project, "mod", CLASS_ADDONS, Catalog::Bedrock);

        assert_eq!(hit.project_id, "cfb:1575941");
        assert_eq!(hit.title, "Verity - Bedrock Edition");
        assert_eq!(hit.author, "PnTMC");
        assert_eq!(hit.downloads, 15_857_831);
        assert_eq!(
            hit.icon_url.as_deref(),
            Some("https://media.forgecdn.net/a.png")
        );
        assert!(hit.categories.contains(&"bedrock".to_string()));
        assert!(hit.categories.contains(&"基岩版".to_string()));
        assert!(hit.versions.contains(&"26.50".to_string()));
        assert_eq!(hit.latest_version.as_deref(), Some("Verity 4.0.0"));
        assert_eq!(hit.project_type, "mod");
    }

    #[test]
    fn maps_a_file_to_a_downloadable_version() {
        let file: CfFile = serde_json::from_str(
            r#"{"id": 8902437, "fileName": "Verity.mcaddon", "displayName": "Verity 4.0.0",
                "fileLength": 37688517, "downloadUrl": "https://edge.forgecdn.net/f/x.mcaddon",
                "gameVersions": ["26.50"], "fileDate": "2026-09-17T09:05:26.977Z",
                "downloadCount": 15345,
                "hashes": [{"value": "26f55d06", "algo": 1}, {"value": "92cfae02", "algo": 2}]}"#,
        )
        .unwrap();

        let version = file_to_version(1575941, file);
        assert_eq!(version.id, "1575941:8902437");
        assert_eq!(version.version_number, "26.50");
        assert_eq!(version.loaders, vec!["bedrock".to_string()]);
        assert_eq!(version.files.len(), 1);
        assert_eq!(version.files[0].filename, "Verity.mcaddon");
        assert_eq!(version.files[0].size, 37_688_517);
        // Only the sha1 hash (algo 1) is used for verification.
        assert_eq!(version.files[0].sha1.as_deref(), Some("26f55d06"));
    }

    #[test]
    fn maps_a_curseforge_bedrock_world_to_a_map_hit() {
        let project: CfProject = serde_json::from_str(PROJECT_FIXTURE).unwrap();
        let hit = hit_from_project(
            project,
            "world",
            CLASS_BEDROCK_WORLDS,
            Catalog::BedrockWorld,
        );

        assert_eq!(hit.project_id, "cbw:1575941");
        assert_eq!(hit.project_type, "world");
        assert!(hit.categories.contains(&"world".to_string()));
        assert!(hit.categories.contains(&"bedrock".to_string()));
        assert!(hit.versions.iter().any(|v| v == "基岩版"));
    }

    #[test]
    fn maps_a_curseforge_world_to_a_map_hit() {
        let project: CfProject = serde_json::from_str(PROJECT_FIXTURE).unwrap();
        let hit = hit_from_project(project, "world", CLASS_WORLDS, Catalog::World);

        assert_eq!(hit.project_id, "cfw:1575941");
        assert_eq!(hit.project_type, "world");
        assert!(hit.categories.contains(&"world".to_string()));
        assert!(hit.categories.contains(&"地图".to_string()));
        assert!(!hit.categories.contains(&"bedrock".to_string()));
        // Worlds are a Java Edition feature: no Bedrock version pill is added.
        assert!(!hit.versions.iter().any(|v| v == "基岩版"));
    }

    #[test]
    fn maps_a_world_file_to_a_world_version() {
        let file: CfFile = serde_json::from_str(
            r#"{"id": 4455, "fileName": "Skyblock.zip", "displayName": "Skyblock 2.1",
                "fileLength": 1200, "downloadUrl": "https://edge.forgecdn.net/f/Skyblock.zip",
                "gameVersions": ["1.21.4"], "fileDate": "2026-09-17T09:05:26.977Z"}"#,
        )
        .unwrap();

        let version = file_to_version_with(1, file, "world", "Java 版");
        assert_eq!(version.loaders, vec!["world".to_string()]);
        assert_eq!(version.version_number, "1.21.4");
    }

    #[test]
    fn reads_the_pagination_total() {
        let fixture = format!(
            r#"{{"data":[{PROJECT_FIXTURE}],"pagination":{{"index":0,"pageSize":5,"resultCount":1,"totalCount":10000}}}}"#
        );
        let parsed: CfList<CfProject> = serde_json::from_str(&fixture).unwrap();
        assert_eq!(parsed.pagination.unwrap().total_count, 10_000);
    }

    #[test]
    fn texture_packs_and_addons_use_different_sections() {
        assert_eq!(class_for_project_type("mod"), CLASS_ADDONS);
        assert_eq!(class_for_project_type("datapack"), CLASS_ADDONS);
        assert_eq!(class_for_project_type("shader"), CLASS_TEXTURE_PACKS);
        assert_eq!(class_for_project_type("resourcepack"), CLASS_TEXTURE_PACKS);
    }
}
