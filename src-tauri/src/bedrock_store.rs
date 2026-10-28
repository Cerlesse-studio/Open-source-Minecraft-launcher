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
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::time::Duration;

/// CurseForge game id for Minecraft Bedrock Edition.
pub const BEDROCK_GAME_ID: u32 = 78022;

/// CurseForge class ids of the Bedrock sections the launcher browses.
const CLASS_ADDONS: u32 = 4984;
const CLASS_TEXTURE_PACKS: u32 = 6929;

/// Prefix that marks a launcher project id as a CurseForge Bedrock project.
pub const PROJECT_PREFIX: &str = "cfb:";

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

fn hit_from_project(project: CfProject, project_type: &str, class_id: u32) -> ContentHit {
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

    let mut categories = vec![
        "bedrock".to_string(),
        "基岩版".to_string(),
        class_label(class_id).to_string(),
    ];
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
    versions.push("基岩版".to_string());

    let latest = project.latest_files.first();
    let latest_version = latest.map(|file| {
        file.display_name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| file.file_name.clone())
    });

    ContentHit {
        project_id: format!("{PROJECT_PREFIX}{}", project.id),
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
    let limit = limit.clamp(1, 50);
    let class_id = class_for_project_type(project_type);
    let mut path = format!(
        "v1/mods/search?gameId={BEDROCK_GAME_ID}&classId={class_id}&index={offset}&pageSize={limit}&sortField={}&sortOrder=desc",
        sort_field(sort)
    );
    let query = query.trim();
    if !query.is_empty() {
        path.push_str(&format!("&searchFilter={}", percent_encode(query)));
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
            .map(|project| hit_from_project(project, project_type, class_id))
            .collect(),
        offset,
        limit,
        total_hits,
        // The launcher fills this in after substituting English keywords.
        translated_query: None,
    })
}

fn file_to_version(mod_id: u32, file: CfFile) -> ContentVersionItem {
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
        .unwrap_or_else(|| "基岩版".to_string());
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
        loaders: vec!["bedrock".to_string()],
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
    let path = format!("v1/mods/{mod_id}/files?index=0&pageSize={FILE_LIST_PAGE_SIZE}");
    let (response, _source): (CfList<CfFile>, String) = get_json(&path).await?;

    let mut items = Vec::new();
    for file in response.data {
        let mut version = file_to_version(mod_id, file.clone());
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
        let hit = hit_from_project(project, "mod", CLASS_ADDONS);

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
