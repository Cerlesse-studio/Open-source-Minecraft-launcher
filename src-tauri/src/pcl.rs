//! `pcl-rust` 接入层（`pcl-rust/crates/pcl-resource`、`pcl-rust/crates/pcl-download`）。
//!
//! 这一层只做翻译，不改前端契约：
//!
//! * 搜索：`pcl-resource` 的双平台会话（Modrinth + CurseForge，跨站去重、排序、
//!   分页）→ [`SearchContentResult`]；
//! * 版本列表：`pcl-resource` 的归一化版本模型与依赖批量解析 →
//!   [`ContentVersionItem`]；
//! * 下载：`pcl-download` 的分段传输引擎 → 与 `net::download_file_with_mirrors`
//!   相同的 `(done, total, delta)` 进度回调。
//!
//! 两个有意保留的例外：
//!
//! * 版本列表请求仍走 `metadata_cache`：它会按 URL 落盘并在断网时回放旧响应，
//!   而且请求带 `limit`（Fabric API 的完整历史是 1216 个构建、1.2 MB）。
//! * CurseForge 文件列表（`cfj:` 项目）仍走 `bedrock_store`：它的 `/download-url`
//!   补全能拿到作者关闭第三方分发、API 里 `downloadUrl` 为空的文件，而
//!   `pcl-resource` 的 CurseForge provider 会按自身约定丢弃这类版本。

use crate::content::{
    ContentDependency, ContentFile, ContentHit, ContentVersionItem, SearchContentResult,
};
use pcl_core::{DownloadConfig, DownloadOutcome, FileSpec, Priority};
use pcl_download::{DownloadManager, TaskHandle};
use pcl_resource::{
    CurseForgeConfig, CurseForgeProvider, DependencyType, ModrinthConfig, ModrinthProvider,
    ProjectKey, ResourcePlatform, ResourceProject, ResourceProvider, ResourceSearchRequest,
    ResourceService, ResourceVersion, ResourceType,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// 搜索结果的磁盘缓存：断网时列表页仍然可用。
const SEARCH_CACHE: &str = "pcl-search";
/// 版本列表的磁盘缓存（键含项目与筛选条件）。
const VERSION_CACHE: &str = "pcl-versions";
/// 搜索结果的进程内缓存：翻页、来回切换标签页不必再等目录接口。
const SEARCH_MEM_TTL: Duration = Duration::from_secs(5 * 60);
/// 内存缓存条目上限，长会话不会无限增长。
const SEARCH_MEM_MAX: usize = 64;
/// 版本列表请求本身的磁盘缓存，按 URL 存，供 `metadata_cache` 回放。
const VERSION_HTTP_CACHE: &str = "modrinth-versions";

/// 版本选择器最多展示多少个构建（与旧实现一致）。
const VERSION_LIST_LIMIT: usize = 200;
/// 一次依赖标题查询最多带多少个项目 id。
const DEPENDENCY_LOOKUP_LIMIT: usize = 40;
/// 版本列表的磁盘缓存存活时间：新构建按天出现，离线时还能打开上次的项目。
const VERSION_DISK_TTL: Duration = Duration::from_secs(30 * 60);
/// 目录接口在拥塞线路上可以很慢，超时按整个响应体计算。
const API_TIMEOUT: Duration = Duration::from_secs(60);
/// 搜索会话每页取多少条，以及最多翻几页。
///
/// 一次会话必须够到 `offset + limit`，否则界面翻到后面会看到空页；50 × 16 页
/// 足够覆盖选择器里的几百条结果，同时避免为一次搜索无限翻页。
const SEARCH_PAGE_SIZE: u32 = 50;
const SEARCH_MAX_ROUNDS: usize = 16;

type SearchMemCache = HashMap<String, (Instant, SearchContentResult)>;

fn search_mem() -> &'static std::sync::Mutex<SearchMemCache> {
    static CACHE: OnceLock<std::sync::Mutex<SearchMemCache>> = OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn service() -> Result<&'static Arc<ResourceService>, String> {
    static SERVICE: OnceLock<Result<Arc<ResourceService>, String>> = OnceLock::new();
    SERVICE
        .get_or_init(build_service)
        .as_ref()
        .map_err(|error| error.clone())
}

fn build_service() -> Result<Arc<ResourceService>, String> {
    let user_agent = crate::net::USER_AGENT.to_string();
    let modrinth = ModrinthProvider::new(ModrinthConfig {
        base_url: "https://api.modrinth.com".to_string(),
        timeout: API_TIMEOUT,
        user_agent: user_agent.clone(),
    })
    .map_err(|error| format!("初始化 Modrinth 客户端失败: {error}"))?;

    // 与 `bedrock_store` 同一套主机策略：有 API key 走官方，没有就走 MCIM
    // 镜像（该镜像不需要 key）。
    let (base_url, api_key) = crate::bedrock_store::curseforge_provider_endpoint();
    let curseforge = CurseForgeProvider::new(CurseForgeConfig {
        base_url,
        api_key,
        timeout: API_TIMEOUT,
        user_agent,
    })
    .map_err(|error| format!("初始化 CurseForge 客户端失败: {error}"))?;

    Ok(Arc::new(
        ResourceService::new(
            Some(Arc::new(curseforge) as Arc<dyn ResourceProvider>),
            Some(Arc::new(modrinth) as Arc<dyn ResourceProvider>),
        )
        .with_search_bounds(SEARCH_PAGE_SIZE, SEARCH_MAX_ROUNDS),
    ))
}

fn resource_type(project_type: &str) -> Option<ResourceType> {
    match project_type.trim().to_ascii_lowercase().as_str() {
        "mod" | "mods" => Some(ResourceType::Mod),
        "modpack" | "modpacks" => Some(ResourceType::ModPack),
        "shader" | "shaders" => Some(ResourceType::Shader),
        "resourcepack" | "resourcepacks" => Some(ResourceType::ResourcePack),
        "datapack" | "datapacks" => Some(ResourceType::DataPack),
        _ => None,
    }
}

/// 只把真正的 Java 版本号交给目录接口：`all`、`bedrock`、`基岩版` 都表示“不筛”。
fn java_version(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && *value != "all" && *value != "bedrock" && *value != "基岩版"
        })
        .map(str::to_string)
}

fn java_loader(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "all" && *value != "bedrock")
        .map(|value| value.to_ascii_lowercase())
}

/// 搜索一页内容。
///
/// Java 模组同时查 Modrinth 与 CurseForge（同一次会话里跨站去重），其余类型
/// 只查 Modrinth——与旧实现的平台分工一致。
pub async fn search(
    query: &str,
    project_type: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
    sort: Option<&str>,
    offset: u32,
    limit: u32,
) -> Result<SearchContentResult, String> {
    let cache_key = format!(
        "{}|{}|{}|{}|{}|{}|{}",
        query.trim().to_lowercase(),
        project_type.trim().to_lowercase(),
        java_version(game_version).unwrap_or_default(),
        java_loader(loader).unwrap_or_default(),
        sort.map(str::trim).unwrap_or("").to_lowercase(),
        offset,
        limit
    );

    if let Ok(cache) = search_mem().lock() {
        if let Some((stored_at, cached)) = cache.get(&cache_key) {
            if stored_at.elapsed() < SEARCH_MEM_TTL {
                return Ok(cached.clone());
            }
        }
    }

    match search_live(query, project_type, game_version, loader, sort, offset, limit).await {
        Ok(result) => {
            if let Ok(mut cache) = search_mem().lock() {
                if cache.len() >= SEARCH_MEM_MAX {
                    cache.clear();
                }
                cache.insert(cache_key.clone(), (Instant::now(), result.clone()));
            }
            if let Ok(body) = serde_json::to_vec(&result) {
                crate::metadata_cache::store(SEARCH_CACHE, &cache_key, &body).await;
            }
            Ok(result)
        }
        // 目录不可达时回放上一次同一条件的列表，而不是让整页搜索失败。
        Err(error) => match crate::metadata_cache::cached_json_any::<SearchContentResult>(
            SEARCH_CACHE,
            &cache_key,
        ) {
            Some(cached) => Ok(cached),
            None => Err(error),
        },
    }
}

async fn search_live(
    query: &str,
    project_type: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
    sort: Option<&str>,
    offset: u32,
    limit: u32,
) -> Result<SearchContentResult, String> {
    let resource_type =
        resource_type(project_type).ok_or_else(|| format!("不支持的资源类型: {project_type}"))?;
    let service = service()?;

    let mut request = ResourceSearchRequest::new(resource_type);
    request.platforms = if resource_type == ResourceType::Mod {
        vec![ResourcePlatform::Modrinth, ResourcePlatform::CurseForge]
    } else {
        vec![ResourcePlatform::Modrinth]
    };
    request.target_count = (offset as usize).saturating_add(limit as usize);
    request = request.with_keyword(query);
    if let Some(version) = java_version(game_version) {
        request = request.with_game_version(version);
    }
    if let Some(loader) = java_loader(loader) {
        request = request.with_loaders(vec![loader]);
    }
    if let Some(sort) = sort.map(str::trim).filter(|sort| !sort.is_empty()) {
        request = request.with_sort(sort);
    }

    let session = service
        .search_resources(request)
        .await
        .map_err(|error| error.to_string())?;

    // 会话是按 `target_count` 取回来的整段，页面偏移在这里切片。
    let hits: Vec<ContentHit> = session
        .results
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(hit_from_project)
        .collect();
    let total_hits = session_total(&session, offset as u64 + hits.len() as u64);

    Ok(SearchContentResult {
        hits,
        offset,
        limit,
        total_hits,
        translated_query: None,
    })
}

/// 两个平台报告的总数相加；只有一边启用（或只有一边报了总数）时用那一边。
fn session_total(session: &pcl_resource::SearchSession, fallback: u64) -> u32 {
    let total = match (session.modrinth.total, session.curseforge.total) {
        (Some(modrinth), Some(curseforge))
            if session.modrinth.enabled && session.curseforge.enabled =>
        {
            Some(modrinth.saturating_add(curseforge))
        }
        (_, Some(curseforge)) if session.curseforge.enabled => Some(curseforge),
        (Some(modrinth), _) if session.modrinth.enabled => Some(modrinth),
        _ => None,
    };
    total.unwrap_or(fallback).min(u32::MAX as u64) as u32
}

/// 归一化项目 → 前端列表行。
fn hit_from_project(project: &ResourceProject) -> ContentHit {
    let (project_id, source) = match project.key.platform {
        // CurseForge 的行沿用启动器自己的 `cfj:` 前缀，点开时才会走
        // CurseForge 的文件列表。
        ResourcePlatform::CurseForge => {
            let id = format!(
                "{}{}",
                crate::bedrock_store::JAVA_MOD_PREFIX,
                project.key.project_id
            );
            (id, "curseforge")
        }
        ResourcePlatform::Modrinth => (project.key.project_id.clone(), "modrinth"),
    };

    ContentHit {
        project_id,
        slug: project.slug.clone(),
        author: project.author.clone(),
        title: project.raw_name.clone(),
        description: project.description.clone().unwrap_or_default(),
        categories: project.categories.clone(),
        versions: project.game_versions.clone(),
        downloads: project.downloads.unwrap_or(0),
        follows: project.follows.unwrap_or(0),
        icon_url: project.icon_url.clone(),
        date_created: project.created_at.clone(),
        date_modified: project.updated_at.map(|at| at.to_rfc3339()),
        latest_version: project.latest_version.clone(),
        // 平台类型用归一化后的资源类型：CurseForge 的 `classId` 是数字，
        // 前端只认 `mod` / `shader` 这类标签。
        project_type: project
            .resource_types
            .first()
            .map(|kind| kind.modrinth_project_type().to_string())
            .unwrap_or_default(),
        source: Some(source.to_string()),
    }
}

/// 取一个 Modrinth 项目的版本列表（带筛选、依赖标题与离线兜底）。
pub async fn modrinth_versions(
    project_ref: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
) -> Result<Vec<ContentVersionItem>, String> {
    let project_id = project_ref.trim().to_string();
    let cache_key = format!(
        "{}|{}|{}",
        project_id.to_lowercase(),
        java_version(game_version).unwrap_or_default(),
        java_loader(loader).unwrap_or_default()
    );

    match modrinth_versions_live(&project_id, game_version, loader).await {
        Ok(items) => {
            if let Ok(body) = serde_json::to_vec(&items) {
                crate::metadata_cache::store(VERSION_CACHE, &cache_key, &body).await;
            }
            Ok(items)
        }
        Err(error) => match crate::metadata_cache::cached_json_any::<Vec<ContentVersionItem>>(
            VERSION_CACHE,
            &cache_key,
        ) {
            Some(cached) => Ok(cached),
            None => Err(error),
        },
    }
}

async fn modrinth_versions_live(
    project_id: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
) -> Result<Vec<ContentVersionItem>, String> {
    let url = version_list_url(project_id, game_version, loader);
    // 列表可能过兆，旧实现的 12 秒整请求超时会在慢线路上把响应体切断；
    // 这里按响应体计时并重试卡住的传输。
    let root: serde_json::Value = crate::metadata_cache::fetch_json(
        VERSION_HTTP_CACHE,
        &url,
        &url,
        VERSION_DISK_TTL,
        API_TIMEOUT,
        3,
    )
    .await
    .map_err(|error| format!("Modrinth 版本列表: {error}"))?;

    let versions = ModrinthProvider::parse_versions_response(project_id, &root)
        .map_err(|error| format!("Modrinth 版本列表: {error}"))?;

    // 接口已经按 `game_versions` / `loaders` 筛过一轮，这里再兜一次：字段缺失
    // 的版本不能因为“筛不出来”被误删。
    let wanted_version = java_version(game_version);
    let wanted_loader = java_loader(loader);
    let listed: Vec<ResourceVersion> = versions
        .into_iter()
        .filter(|version| match wanted_version.as_deref() {
            Some(wanted) => {
                version.game_versions.is_empty()
                    || version
                        .game_versions
                        .iter()
                        .any(|listed| listed.eq_ignore_ascii_case(wanted))
            }
            None => true,
        })
        .filter(|version| match wanted_loader.as_deref() {
            Some(wanted) => {
                version.loaders.is_empty()
                    || version
                        .loaders
                        .iter()
                        .any(|listed| listed.eq_ignore_ascii_case(wanted))
            }
            None => true,
        })
        .take(VERSION_LIST_LIMIT)
        .collect();

    let names = dependency_names(&listed).await;
    Ok(listed
        .iter()
        .map(|version| version_item(version, &names))
        .collect())
}

/// Modrinth 版本列表 URL。
///
/// `limit` 只取最近的一段：不带它时热门项目会返回完整历史（Fabric API 1216 个
/// 构建、约 1.2 MB JSON，慢线路上要 30 秒以上），而这个选择器只会展示几百行。
fn version_list_url(
    project_id: &str,
    game_version: Option<&str>,
    loader: Option<&str>,
) -> String {
    let mut query: Vec<String> = Vec::new();
    if let Some(version) = java_version(game_version) {
        let json = serde_json::to_string(&vec![version]).unwrap_or_default();
        query.push(format!(
            "game_versions={}",
            crate::content::urlencoding(&json)
        ));
    }
    if let Some(loader) = java_loader(loader) {
        let json = serde_json::to_string(&vec![loader]).unwrap_or_default();
        query.push(format!(
            "loaders={}",
            crate::content::urlencoding(&json)
        ));
    }
    query.push(format!("limit={VERSION_LIST_LIMIT}"));
    format!(
        "https://api.modrinth.com/v2/project/{project_id}/version?{}",
        query.join("&")
    )
}

fn version_item(version: &ResourceVersion, names: &HashMap<String, String>) -> ContentVersionItem {
    ContentVersionItem {
        id: version.version_id.clone(),
        name: version.display_name.clone(),
        version_number: version
            .version_number
            .clone()
            .filter(|number| !number.trim().is_empty())
            .unwrap_or_else(|| version.display_name.clone()),
        game_versions: version.game_versions.clone(),
        loaders: version.loaders.clone(),
        date_published: version.published_at.map(|at| at.to_rfc3339()),
        downloads: version.downloads.unwrap_or(0),
        files: version
            .files
            .iter()
            .map(|file| ContentFile {
                url: file.download_url.clone(),
                filename: file.file_name.clone(),
                primary: file.primary,
                size: file.size.unwrap_or(0),
                sha1: file.sha1.clone(),
            })
            .collect(),
        dependencies: content_dependencies(version, names),
    }
}

/// 只保留“要装的东西”：`embedded` 库和 `incompatible` 项目不是前置依赖。
fn is_installable(dependency_type: &DependencyType) -> bool {
    matches!(
        dependency_type,
        DependencyType::Required | DependencyType::Optional
    )
}

/// 按作者顺序保留依赖，去重；标题查不到时回落到项目 id，而不是留空。
fn content_dependencies(
    version: &ResourceVersion,
    names: &HashMap<String, String>,
) -> Vec<ContentDependency> {
    let mut out: Vec<ContentDependency> = Vec::new();
    for dependency in &version.dependencies {
        if !is_installable(&dependency.dependency_type) {
            continue;
        }
        let key = dependency.project_key();
        let id = match key.platform {
            ResourcePlatform::CurseForge => {
                format!("{}{}", crate::bedrock_store::JAVA_MOD_PREFIX, key.project_id)
            }
            ResourcePlatform::Modrinth => key.project_id.clone(),
        };
        if out.iter().any(|seen| seen.project_id == id) {
            continue;
        }
        let name = names
            .get(&key.to_string())
            .cloned()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| key.project_id.clone());
        out.push(ContentDependency {
            project_id: id,
            name,
            version_id: dependency
                .version_id
                .clone()
                .filter(|version| !version.trim().is_empty()),
            file_name: None,
            required: dependency.dependency_type == DependencyType::Required,
        });
    }
    out
}

/// 一次性解析整份列表里出现的依赖项目标题。
///
/// 一次批量请求覆盖所有构建，失败也不影响列表本身（依赖只是附加信息）。
async fn dependency_names(versions: &[ResourceVersion]) -> HashMap<String, String> {
    let mut keys: Vec<ProjectKey> = Vec::new();
    for version in versions {
        for dependency in &version.dependencies {
            if !is_installable(&dependency.dependency_type) {
                continue;
            }
            let key = dependency.project_key();
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys.truncate(DEPENDENCY_LOOKUP_LIMIT);
    if keys.is_empty() {
        return HashMap::new();
    }
    let Ok(service) = service() else {
        return HashMap::new();
    };
    match service.get_projects_batch(&keys).await {
        Ok(projects) => projects
            .into_iter()
            .filter(|project| !project.raw_name.trim().is_empty())
            .map(|project| (project.key.to_string(), project.raw_name))
            .collect(),
        Err(_) => HashMap::new(),
    }
}

/// 把一次异步任务转成可 `Drop` 的取消信号。
///
/// 前端取消下载时 `lib.rs` 会 `abort()` 掉整个 future，这里在 drop 时把 pcl 的
/// 任务一起取消，`.pcl-part` / `.pcl-seg-*` / `.pcl-resume.json` 才会被清掉。
struct CancelGuard {
    handle: Option<TaskHandle>,
}

impl CancelGuard {
    fn disarm(&mut self) {
        self.handle = None;
    }
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            if tokio::runtime::Handle::try_current().is_ok() {
                let _ = handle.cancel();
            }
        }
    }
}

/// 用 `pcl-download` 的分段引擎下载一个内容文件。
///
/// 参数与 `net::download_file_with_mirrors` 对齐：镜像链由 `net::preferred_urls`
/// 按用户的镜像偏好排好序（pcl 会依次尝试并在失败时切源），进度回调是
/// `(已下载, 总量, 本次增量)`。
pub async fn download_file(
    url: &str,
    dest: &Path,
    sha1: Option<&str>,
    size: Option<u64>,
    threads: usize,
    mut on_progress: Option<&mut (dyn FnMut(u64, u64, u64) + Send)>,
) -> Result<u64, String> {
    let mut config = DownloadConfig::default();
    config.max_segments_per_file = threads.clamp(1, 32);
    config.max_concurrent_tasks = 8;
    // 内容下载只跑一两个任务，请求预算给足，避免分片互相排队。
    config.max_global_requests = 64;
    config.max_requests_per_host = 64;
    config.connect_timeout_ms = 15_000;
    config.read_timeout_ms = 30_000;
    config.user_agent = crate::net::USER_AGENT.to_string();

    let manager =
        DownloadManager::new(config).map_err(|error| format!("初始化下载引擎失败: {error}"))?;

    let mut spec = FileSpec::new(crate::net::preferred_urls(url), dest);
    spec.expected_size = size.filter(|size| *size > 0);
    spec.sha1 = sha1
        .map(str::trim)
        .filter(|sha1| !sha1.is_empty())
        .map(str::to_string);
    // 内容文件都是二进制，不是 JSON 接口响应。
    spec.verify_json = false;

    let handle = manager.submit(spec, Priority::Normal);
    let mut guard = CancelGuard {
        handle: Some(handle.clone()),
    };

    let expected = size.filter(|size| *size > 0).unwrap_or(0);
    let mut reported = 0u64;
    loop {
        if let Some(progress) = handle.progress() {
            let done = progress.downloaded_bytes;
            let total = progress.total_bytes.unwrap_or(expected);
            let delta = done.saturating_sub(reported);
            reported = done;
            if let Some(callback) = on_progress.as_deref_mut() {
                callback(done, total, delta);
            }
        }
        if handle.state().is_some_and(|state| state.is_terminal()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }

    let outcome = handle.wait().await;
    match outcome {
        DownloadOutcome::Completed => {
            guard.disarm();
            let bytes = tokio::fs::metadata(dest)
                .await
                .map(|meta| meta.len())
                .unwrap_or(reported);
            if let Some(callback) = on_progress.as_deref_mut() {
                callback(bytes, bytes.max(expected), 0);
            }
            Ok(bytes)
        }
        DownloadOutcome::Cancelled => Err(crate::CONTENT_DOWNLOAD_CANCELLED.to_string()),
        DownloadOutcome::Paused => Err("下载已暂停".to_string()),
        DownloadOutcome::Failed(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pcl_resource::{ReleaseType, ResourceDependency};

    fn dependency(project_id: &str, kind: DependencyType) -> ResourceDependency {
        ResourceDependency {
            platform: ResourcePlatform::Modrinth,
            project_id: project_id.to_string(),
            version_id: None,
            dependency_type: kind,
        }
    }

    fn version(dependencies: Vec<ResourceDependency>) -> ResourceVersion {
        ResourceVersion {
            platform: ResourcePlatform::Modrinth,
            project_id: "sodium".to_string(),
            version_id: "build-1".to_string(),
            display_name: "Sodium 1.0".to_string(),
            version_number: Some("1.0".to_string()),
            release_type: ReleaseType::Release,
            game_versions: vec!["1.21.1".to_string()],
            loaders: vec!["fabric".to_string()],
            files: Vec::new(),
            dependencies,
            published_at: None,
            downloads: None,
        }
    }

    /// 只有 required/optional 是“要装的东西”：内嵌库和冲突项目不能当成前置。
    #[test]
    fn dependencies_keep_only_installable_kinds_without_duplicates() {
        let version = version(vec![
            dependency("P7dR8mSH", DependencyType::Required),
            dependency("mOgUt4GM", DependencyType::Optional),
            dependency("embedded", DependencyType::Embedded),
            dependency("conflict", DependencyType::Incompatible),
            dependency("P7dR8mSH", DependencyType::Required),
        ]);
        let mut names = HashMap::new();
        names.insert("modrinth:P7dR8mSH".to_string(), "Fabric API".to_string());

        let deps = content_dependencies(&version, &names);
        assert_eq!(deps.len(), 2, "重复项与不可安装项都要丢掉");
        assert_eq!(deps[0].project_id, "P7dR8mSH");
        assert_eq!(deps[0].name, "Fabric API");
        assert!(deps[0].required);
        assert!(!deps[1].required);
        // 标题还没查到时回落到项目 id，而不是留一个空白 chip。
        assert_eq!(deps[1].name, "mOgUt4GM");
    }

    #[test]
    fn version_url_requests_only_the_visible_page() {
        assert_eq!(
            version_list_url("fabric-api", None, None),
            "https://api.modrinth.com/v2/project/fabric-api/version?limit=200"
        );
    }

    #[test]
    fn version_url_encodes_game_version_and_loader_filters() {
        let url = version_list_url("fabric-api", Some("1.20.1"), Some("Fabric"));
        assert!(url.contains("game_versions=%5B%221.20.1%22%5D"), "{url}");
        assert!(url.contains("loaders=%5B%22fabric%22%5D"), "{url}");
        assert!(url.ends_with("&limit=200"), "{url}");
    }

    #[test]
    fn version_url_omits_filters_that_mean_everything() {
        for value in ["all", "bedrock", "", "   "] {
            assert_eq!(
                version_list_url("pack", Some(value), Some(value)),
                "https://api.modrinth.com/v2/project/pack/version?limit=200",
                "value {value:?} should not become a filter"
            );
        }
    }
}
