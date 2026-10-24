use crate::minecraft::{Arguments, Artifact, Library, LibraryDownloads, VersionDetail};
use crate::net;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderVersionItem {
    pub version: String,
    pub stable: bool,
    pub release_time: Option<String>,
    pub subtitle: Option<String>,
    pub download_url: Option<String>,
    pub file_name: Option<String>,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VersionLoadersCatalog {
    pub mc_version: String,
    pub forge: Vec<LoaderVersionItem>,
    pub neoforge: Vec<LoaderVersionItem>,
    pub fabric: Vec<LoaderVersionItem>,
    pub quilt: Vec<LoaderVersionItem>,
    pub optifine: Vec<LoaderVersionItem>,
    pub fabric_api: Vec<LoaderVersionItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoaderSelection {
    pub instance_name: Option<String>,
    pub loader_type: Option<String>,
    pub loader_version: Option<String>,
    pub optifine_version: Option<String>,
    pub optifine_url: Option<String>,
    pub optifine_filename: Option<String>,
    pub fabric_api_version: Option<String>,
    pub fabric_api_url: Option<String>,
    pub fabric_api_filename: Option<String>,
}

impl LoaderSelection {
    pub fn has_any_addon(&self) -> bool {
        self.loader_type
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
            || self
                .optifine_version
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
            || self
                .fabric_api_version
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
    }
}

pub struct ExtraModFile {
    pub label: String,
    pub url: String,
    pub dest: PathBuf,
    pub sha1: Option<String>,
    pub size: Option<u64>,
}

// ---------------------------------------------------------------------------
// Catalog Queries
// ---------------------------------------------------------------------------

async fn get_json_with_timeout<T: for<'de> Deserialize<'de>>(url: &str) -> Result<T, String> {
    let response = net::client()
        .get(url)
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .map_err(|e| format!("请求失败 ({url}): {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} ({url})", response.status()));
    }
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    serde_json::from_str::<T>(&text).map_err(|e| format!("解析响应失败: {e}"))
}

#[derive(Deserialize)]
struct FabricLoaderEntry {
    loader: FabricLoaderMeta,
}

#[derive(Deserialize)]
struct FabricLoaderMeta {
    version: String,
    #[serde(default)]
    stable: bool,
}

async fn fetch_fabric(mc_version: &str) -> Vec<LoaderVersionItem> {
    let url = format!("https://meta.fabricmc.net/v2/versions/loader/{mc_version}");
    let Ok(entries) = get_json_with_timeout::<Vec<FabricLoaderEntry>>(&url).await else {
        return Vec::new();
    };
    entries
        .into_iter()
        .take(40)
        .enumerate()
        .map(|(idx, entry)| LoaderVersionItem {
            subtitle: Some(if entry.loader.stable {
                if idx == 0 {
                    "推荐稳定版".to_string()
                } else {
                    "稳定版".to_string()
                }
            } else {
                "测试版".to_string()
            }),
            version: entry.loader.version,
            stable: entry.loader.stable,
            release_time: None,
            download_url: None,
            file_name: None,
            sha1: None,
            size: None,
        })
        .collect()
}

#[derive(Deserialize)]
struct QuiltLoaderEntry {
    loader: QuiltLoaderMeta,
}

#[derive(Deserialize)]
struct QuiltLoaderMeta {
    version: String,
}

async fn fetch_quilt(mc_version: &str) -> Vec<LoaderVersionItem> {
    let url = format!("https://meta.quiltmc.org/v3/versions/loader/{mc_version}");
    let Ok(entries) = get_json_with_timeout::<Vec<QuiltLoaderEntry>>(&url).await else {
        return Vec::new();
    };
    entries
        .into_iter()
        .take(35)
        .map(|entry| {
            let v = entry.loader.version;
            let stable = !v.contains("beta") && !v.contains("alpha") && !v.contains("-rc");
            LoaderVersionItem {
                version: v,
                stable,
                release_time: None,
                subtitle: Some(if stable {
                    "稳定版".to_string()
                } else {
                    "测试版".to_string()
                }),
                download_url: None,
                file_name: None,
                sha1: None,
                size: None,
            }
        })
        .collect()
}

#[derive(Deserialize)]
struct BmclForgeEntry {
    version: String,
    modified: Option<String>,
    branch: Option<String>,
}

#[derive(Deserialize)]
struct ForgePromotions {
    #[serde(default)]
    promos: std::collections::HashMap<String, String>,
}

async fn fetch_forge_official(mc_version: &str) -> Option<Vec<LoaderVersionItem>> {
    let promo_url =
        "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
    let promos_res = get_json_with_timeout::<ForgePromotions>(promo_url).await.ok();
    let promos = promos_res.map(|p| p.promos).unwrap_or_default();

    let rec_key = format!("{mc_version}-recommended");
    let latest_key = format!("{mc_version}-latest");
    let rec_ver = promos.get(&rec_key).cloned();
    let latest_ver = promos.get(&latest_key).cloned();

    let maven_meta_url =
        "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
    let mut versions = Vec::new();
    if let Ok(client_resp) = net::client().get(maven_meta_url).send().await {
        if client_resp.status().is_success() {
            if let Ok(xml) = client_resp.text().await {
                let prefix = format!("<version>{mc_version}-");
                let mut remaining = &xml[..];
                while let Some(pos) = remaining.find(&prefix) {
                    let after = &remaining[pos + prefix.len()..];
                    if let Some(end) = after.find("</version>") {
                        let ver = &after[..end];
                        if !ver.is_empty() {
                            versions.push(ver.to_string());
                        }
                        remaining = &after[end + "</version>".len()..];
                    } else {
                        break;
                    }
                }
            }
        }
    }

    if versions.is_empty() {
        if let Some(l) = latest_ver.clone() {
            versions.push(l);
        }
        if let Some(r) = rec_ver.clone() {
            if !versions.contains(&r) {
                versions.push(r);
            }
        }
    }

    if versions.is_empty() {
        return None;
    }

    versions.reverse();
    let items = versions
        .into_iter()
        .take(40)
        .map(|v| {
            let is_rec = rec_ver.as_deref() == Some(&v);
            let is_latest = latest_ver.as_deref() == Some(&v);
            let subtitle = if is_rec {
                "推荐稳定版 (官方CDN)".to_string()
            } else if is_latest {
                "最新版本 (官方CDN)".to_string()
            } else {
                "正式构建 (官方CDN)".to_string()
            };
            LoaderVersionItem {
                version: v,
                stable: is_rec || !subtitle.contains("Beta"),
                release_time: None,
                subtitle: Some(subtitle),
                download_url: None,
                file_name: None,
                sha1: None,
                size: None,
            }
        })
        .collect();

    Some(items)
}

async fn fetch_forge(mc_version: &str) -> Vec<LoaderVersionItem> {
    // 1. Try official Cloudflare Anycast CDN (Asia-Pacific POPs / non-mainland China)
    if let Some(official) = fetch_forge_official(mc_version).await {
        if !official.is_empty() {
            return official;
        }
    }

    // 2. Fallback to BMCLAPI
    let url = format!("https://bmclapi2.bangbang93.com/forge/minecraft/{mc_version}");
    let Ok(mut entries) = get_json_with_timeout::<Vec<BmclForgeEntry>>(&url).await else {
        return Vec::new();
    };
    // Sort newest first by modified timestamp or version string
    entries.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.version.cmp(&a.version)));
    entries
        .into_iter()
        .take(40)
        .enumerate()
        .map(|(idx, item)| {
            let subtitle = match item.branch.as_deref() {
                Some(b) if !b.is_empty() => format!("分支 {b}"),
                _ if idx == 0 => "最新版本".to_string(),
                _ => "正式构建".to_string(),
            };
            LoaderVersionItem {
                version: item.version,
                stable: idx == 0,
                release_time: item.modified,
                subtitle: Some(subtitle),
                download_url: None,
                file_name: None,
                sha1: None,
                size: None,
            }
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BmclNeoForgeEntry {
    version: String,
    raw_version: Option<String>,
}

#[derive(Deserialize)]
struct NeoForgeMavenVersions {
    versions: Vec<String>,
}

fn neoforge_prefix_for_mc(mc_version: &str) -> Option<String> {
    // Minecraft 1.20.2+ uses NeoForge versioning <minor>.<patch>.<build>
    // e.g. 1.21.4 -> "21.4.", 1.21 -> "21.0.", 1.20.4 -> "20.4."
    let rest = mc_version.strip_prefix("1.")?;
    if rest.contains('-') || rest.contains('w') {
        return None;
    }
    let parts: Vec<&str> = rest.split('.').collect();
    match parts.as_slice() {
        [minor] => Some(format!("{minor}.0.")),
        [minor, patch] => Some(format!("{minor}.{patch}.")),
        _ => None,
    }
}

async fn fetch_neoforge(mc_version: &str) -> Vec<LoaderVersionItem> {
    // 1. Try official Cloudflare Anycast Maven API first (Asia-Pacific edge POPs, non-mainland China)
    if let Some(prefix) = neoforge_prefix_for_mc(mc_version) {
        let maven_url =
            "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
        if let Ok(meta) = get_json_with_timeout::<NeoForgeMavenVersions>(maven_url).await {
            let mut matched: Vec<String> = meta
                .versions
                .into_iter()
                .filter(|v| v.starts_with(&prefix))
                .collect();
            if !matched.is_empty() {
                matched.reverse();
                return matched
                    .into_iter()
                    .take(40)
                    .map(|v| {
                        let stable = !v.contains("beta") && !v.contains("alpha");
                        LoaderVersionItem {
                            version: v,
                            stable,
                            release_time: None,
                            subtitle: Some(if stable {
                                "稳定版 (官方CDN)".to_string()
                            } else {
                                "Beta 构建".to_string()
                            }),
                            download_url: None,
                            file_name: None,
                            sha1: None,
                            size: None,
                        }
                    })
                    .collect();
            }
        }
    }

    // 2. Fallback to BMCLAPI
    let bmcl_url = format!("https://bmclapi2.bangbang93.com/neoforge/list/{mc_version}");
    if let Ok(mut list) = get_json_with_timeout::<Vec<BmclNeoForgeEntry>>(&bmcl_url).await {
        if !list.is_empty() {
            list.reverse();
            return list
                .into_iter()
                .take(40)
                .map(|entry| {
                    let v = entry.version;
                    let stable = !v.contains("beta") && !v.contains("alpha");
                    LoaderVersionItem {
                        version: v,
                        stable,
                        release_time: None,
                        subtitle: Some(if stable {
                            "稳定版".to_string()
                        } else {
                            "Beta 构建".to_string()
                        }),
                        download_url: entry.raw_version,
                        file_name: None,
                        sha1: None,
                        size: None,
                    }
                })
                .collect();
        }
    }

    Vec::new()
}

#[derive(Deserialize)]
struct BmclOptiFineEntry {
    #[serde(rename = "type")]
    of_type: String,
    patch: String,
    filename: Option<String>,
}

async fn fetch_optifine(mc_version: &str) -> Vec<LoaderVersionItem> {
    let url = format!("https://bmclapi2.bangbang93.com/optifine/{mc_version}");
    let Ok(mut entries) = get_json_with_timeout::<Vec<BmclOptiFineEntry>>(&url).await else {
        return Vec::new();
    };
    entries.reverse();
    entries
        .into_iter()
        .take(30)
        .map(|entry| {
            let ver = format!("{}_{}", entry.of_type, entry.patch);
            let stable = !entry.patch.starts_with("pre") && !entry.patch.contains("alpha");
            let dl_url = format!(
                "https://bmclapi2.bangbang93.com/optifine/{}/{}/{}",
                mc_version, entry.of_type, entry.patch
            );
            let filename = entry
                .filename
                .unwrap_or_else(|| format!("OptiFine_{mc_version}_{ver}.jar"));
            LoaderVersionItem {
                version: ver,
                stable,
                release_time: None,
                subtitle: Some(if stable {
                    "高清修复正式版".to_string()
                } else {
                    "预览版 (Preview)".to_string()
                }),
                download_url: Some(dl_url),
                file_name: Some(filename),
                sha1: None,
                size: None,
            }
        })
        .collect()
}

#[derive(Deserialize)]
struct ModrinthVersion {
    version_number: String,
    name: String,
    date_published: Option<String>,
    version_type: Option<String>,
    files: Vec<ModrinthFile>,
}

#[derive(Deserialize)]
struct ModrinthFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    size: Option<u64>,
    hashes: Option<ModrinthHashes>,
}

#[derive(Deserialize)]
struct ModrinthHashes {
    sha1: Option<String>,
}

async fn fetch_fabric_api(mc_version: &str) -> Vec<LoaderVersionItem> {
    let url = format!(
        "https://api.modrinth.com/v2/project/P7dR8mSH/version?game_versions=%5B%22{mc_version}%22%5D&loaders=%5B%22fabric%22%5D"
    );
    let Ok(entries) = get_json_with_timeout::<Vec<ModrinthVersion>>(&url).await else {
        return Vec::new();
    };
    entries
        .into_iter()
        .take(25)
        .filter_map(|entry| {
            let file = entry
                .files
                .iter()
                .find(|f| f.primary)
                .or_else(|| entry.files.first())?;
            let stable = entry.version_type.as_deref() == Some("release");
            Some(LoaderVersionItem {
                version: entry.version_number,
                stable,
                release_time: entry.date_published,
                subtitle: Some(entry.name),
                download_url: Some(file.url.clone()),
                file_name: Some(file.filename.clone()),
                sha1: file.hashes.as_ref().and_then(|h| h.sha1.clone()),
                size: file.size,
            })
        })
        .collect()
}

pub async fn fetch_version_loaders(mc_version: &str) -> Result<VersionLoadersCatalog, String> {
    let mc = mc_version.trim();
    if mc.is_empty() {
        return Err("版本号不能为空".to_string());
    }
    let (forge, neoforge, fabric, quilt, optifine, fabric_api) = tokio::join!(
        fetch_forge(mc),
        fetch_neoforge(mc),
        fetch_fabric(mc),
        fetch_quilt(mc),
        fetch_optifine(mc),
        fetch_fabric_api(mc),
    );
    Ok(VersionLoadersCatalog {
        mc_version: mc.to_string(),
        forge,
        neoforge,
        fabric,
        quilt,
        optifine,
        fabric_api,
    })
}

// ---------------------------------------------------------------------------
// Profile Merging & Installation
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LoaderProfileJson {
    #[serde(rename = "mainClass")]
    main_class: Option<String>,
    #[serde(default)]
    libraries: Vec<Library>,
    arguments: Option<Arguments>,
    #[serde(rename = "minecraftArguments")]
    minecraft_arguments: Option<String>,
}

fn merge_profile_into_version(base: &mut VersionDetail, profile: LoaderProfileJson) {
    if let Some(main_class) = profile.main_class {
        if !main_class.trim().is_empty() {
            base.main_class = main_class;
        }
    }
    if let Some(mc_args) = profile.minecraft_arguments {
        base.minecraft_arguments = Some(mc_args);
    }
    if let Some(loader_args) = profile.arguments {
        let target = base.arguments.get_or_insert_with(|| Arguments {
            game: Vec::new(),
            jvm: Vec::new(),
        });
        target.jvm.extend(loader_args.jvm);
        target.game.extend(loader_args.game);
    }
    // Prepend loader libraries so loader's patched ASM/LaunchWrapper/Mixin takes priority
    let mut combined = profile.libraries;
    combined.append(&mut base.libraries);
    base.libraries = combined;
}

async fn apply_fabric_or_quilt(
    base: &mut VersionDetail,
    mc_version: &str,
    loader_type: &str,
    loader_version: &str,
) -> Result<(), String> {
    let profile_url = if loader_type == "quilt" {
        format!(
            "https://meta.quiltmc.org/v3/versions/loader/{mc_version}/{loader_version}/profile/json"
        )
    } else {
        format!(
            "https://meta.fabricmc.net/v2/versions/loader/{mc_version}/{loader_version}/profile/json"
        )
    };
    let profile: LoaderProfileJson = get_json_with_timeout(&profile_url)
        .await
        .map_err(|e| format!("获取 {loader_type} 安装配置失败: {e}"))?;
    merge_profile_into_version(base, profile);
    Ok(())
}

#[derive(Deserialize)]
struct InstallerInstallProfile {
    #[serde(default)]
    libraries: Vec<Library>,
    #[serde(rename = "versionInfo")]
    version_info: Option<LoaderProfileJson>,
}

fn normalize_forge_library(mut lib: Library, default_maven_base: &str) -> Library {
    // Ensure libraries that only provide `name` or empty `artifact.url` have a valid URL
    if let Some(ref mut downloads) = lib.downloads {
        if let Some(ref mut artifact) = downloads.artifact {
            if artifact
                .url
                .as_deref()
                .map(|u| u.trim().is_empty())
                .unwrap_or(true)
            {
                if let Some(ref path) = artifact.path {
                    let base = default_maven_base.trim_end_matches('/');
                    artifact.url = Some(format!("{base}/{path}"));
                }
            }
        }
    } else if lib.url.is_none() {
        lib.url = Some(default_maven_base.to_string());
    }
    lib
}

fn extract_installer_archive(
    installer_path: &Path,
    libraries_dir: &Path,
    default_maven_base: &str,
) -> Result<(LoaderProfileJson, Vec<Library>), String> {
    let file = std::fs::File::open(installer_path)
        .map_err(|e| format!("无法打开加载器安装包: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("安装包格式无效 (非 ZIP/JAR): {e}"))?;

    // Extract any bundled `maven/` jars inside the installer directly into `libraries/`
    for i in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(i) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if let Some(rel) = name.strip_prefix("maven/") {
            if rel.is_empty() || rel.contains("..") {
                continue;
            }
            let dest = libraries_dir.join(rel);
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(mut out) = std::fs::File::create(&dest) {
                let _ = std::io::copy(&mut entry, &mut out);
            }
        }
    }

    let mut version_json_text = String::new();
    if let Ok(mut entry) = archive.by_name("version.json") {
        let _ = entry.read_to_string(&mut version_json_text);
    }

    let mut install_profile_text = String::new();
    if let Ok(mut entry) = archive.by_name("install_profile.json") {
        let _ = entry.read_to_string(&mut install_profile_text);
    }

    let mut extra_libs = Vec::new();
    let mut profile_opt: Option<LoaderProfileJson> = None;

    if !version_json_text.is_empty() {
        let parsed: LoaderProfileJson = serde_json::from_str(&version_json_text)
            .map_err(|e| format!("解析安装包内 version.json 失败: {e}"))?;
        profile_opt = Some(parsed);
    }

    if !install_profile_text.is_empty() {
        if let Ok(install_prof) =
            serde_json::from_str::<InstallerInstallProfile>(&install_profile_text)
        {
            extra_libs.extend(install_prof.libraries);
            if profile_opt.is_none() {
                profile_opt = install_prof.version_info;
            }
        }
    }

    let Some(mut profile) = profile_opt else {
        return Err("安装包内未找到 version.json 或 versionInfo".to_string());
    };

    profile.libraries = profile
        .libraries
        .into_iter()
        .map(|l| normalize_forge_library(l, default_maven_base))
        .collect();

    let extra_libs = extra_libs
        .into_iter()
        .filter(|l| {
            // Skip libraries whose URL is empty and are generated locally by processors unless already extracted
            l.downloads
                .as_ref()
                .and_then(|d| d.artifact.as_ref())
                .and_then(|a| a.url.as_deref())
                .map(|u| !u.trim().is_empty())
                .unwrap_or(true)
        })
        .map(|l| normalize_forge_library(l, default_maven_base))
        .collect();

    Ok((profile, extra_libs))
}

async fn apply_forge_or_neoforge(
    root: &Path,
    base: &mut VersionDetail,
    mc_version: &str,
    loader_type: &str,
    loader_version: &str,
) -> Result<(), String> {
    let installers_dir = root.join("meta").join("installers");
    tokio::fs::create_dir_all(&installers_dir)
        .await
        .map_err(|e| format!("无法创建安装器缓存目录: {e}"))?;

    let (installer_urls, default_maven, file_name) = if loader_type == "neoforge" {
        let fname = format!("neoforge-{loader_version}-installer.jar");
        let urls = vec![
            // Official Cloudflare Anycast CDN (Asia-Pacific edge POPs, non-mainland China)
            format!(
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/{loader_version}/{fname}"
            ),
            // Mainland fallback
            format!(
                "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/{loader_version}/{fname}"
            ),
        ];
        (urls, "https://maven.neoforged.net/releases/", fname)
    } else {
        let fname = format!("forge-{mc_version}-{loader_version}-installer.jar");
        let urls = vec![
            // Official Cloudflare Anycast CDN (Asia-Pacific edge POPs, non-mainland China)
            format!(
                "https://maven.minecraftforge.net/net/minecraftforge/forge/{mc_version}-{loader_version}/{fname}"
            ),
            // Mainland fallback
            format!(
                "https://bmclapi2.bangbang93.com/forge/download?mcversion={mc_version}&version={loader_version}&category=installer&format=jar"
            ),
        ];
        (urls, "https://maven.minecraftforge.net/", fname)
    };

    let installer_path = installers_dir.join(&file_name);
    if !net::looks_complete(&installer_path, None) {
        let mut last_err = String::new();
        let mut ok = false;
        for url in &installer_urls {
            match net::download_file_multithreaded(url, &installer_path, None, None, 4, None, None)
                .await
            {
                Ok(_) => {
                    ok = true;
                    break;
                }
                Err(e) => {
                    last_err = e;
                }
            }
        }
        if !ok {
            return Err(format!("下载 {loader_type} 安装包失败: {last_err}"));
        }
    }

    let libs_dir = root.join("libraries");
    let installer_clone = installer_path.clone();
    let maven_str = default_maven.to_string();
    let (profile, _extra_libs) = tokio::task::spawn_blocking(move || {
        extract_installer_archive(&installer_clone, &libs_dir, &maven_str)
    })
    .await
    .map_err(|e| format!("解析安装包任务失败: {e}"))??;

    merge_profile_into_version(base, profile);
    Ok(())
}

pub async fn prepare_addons(
    root: &Path,
    instance_dir: &Path,
    mc_version: &str,
    version: &mut VersionDetail,
    selection: &LoaderSelection,
) -> Result<Vec<ExtraModFile>, String> {
    if let (Some(loader_type), Some(loader_version)) = (
        selection
            .loader_type
            .as_deref()
            .filter(|s| !s.trim().is_empty()),
        selection
            .loader_version
            .as_deref()
            .filter(|s| !s.trim().is_empty()),
    ) {
        let kind = loader_type.to_lowercase();
        match kind.as_str() {
            "fabric" | "quilt" => {
                apply_fabric_or_quilt(version, mc_version, &kind, loader_version).await?;
            }
            "forge" | "neoforge" => {
                apply_forge_or_neoforge(root, version, mc_version, &kind, loader_version).await?;
            }
            other => {
                return Err(format!("不支持的模组加载器类型: {other}"));
            }
        }
        version.loader = Some(kind);
        version.loader_version = Some(loader_version.to_string());
    }

    let mods_dir = instance_dir.join("mods");
    let mut extra_mods = Vec::new();

    if let Some(fab_ver) = selection
        .fabric_api_version
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        let mut dl_url = selection.fabric_api_url.clone();
        let mut fname = selection.fabric_api_filename.clone();
        let mut sha1 = None;
        let mut size = None;

        if dl_url.is_none() {
            let api_list = fetch_fabric_api(mc_version).await;
            if let Some(found) = api_list
                .into_iter()
                .find(|item| item.version == fab_ver)
            {
                dl_url = found.download_url;
                fname = found.file_name;
                sha1 = found.sha1;
                size = found.size;
            }
        }

        if let Some(url) = dl_url {
            let file_name = fname.unwrap_or_else(|| format!("fabric-api-{fab_ver}.jar"));
            extra_mods.push(ExtraModFile {
                label: format!("Fabric API {fab_ver}"),
                url,
                dest: mods_dir.join(file_name),
                sha1,
                size,
            });
        }
    }

    if let Some(of_ver) = selection
        .optifine_version
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        let url = selection.optifine_url.clone().unwrap_or_else(|| {
            let parts: Vec<&str> = of_ver.rsplitn(2, '_').collect();
            if parts.len() == 2 {
                format!(
                    "https://bmclapi2.bangbang93.com/optifine/{}/{}/{}",
                    mc_version, parts[1], parts[0]
                )
            } else {
                format!("https://bmclapi2.bangbang93.com/optifine/{mc_version}/HD_U/{of_ver}")
            }
        });
        let file_name = selection
            .optifine_filename
            .clone()
            .unwrap_or_else(|| format!("OptiFine_{mc_version}_{of_ver}.jar"));

        // Also inject OptiFine wrapper library if installed without a mod loader
        if selection
            .loader_type
            .as_deref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            let rel_path = format!("optifine/OptiFine/{mc_version}_{of_ver}/{file_name}");
            let lib_dest = root.join("libraries").join(&rel_path);
            extra_mods.push(ExtraModFile {
                label: format!("OptiFine {of_ver}"),
                url: url.clone(),
                dest: lib_dest,
                sha1: None,
                size: None,
            });
            version.libraries.push(Library {
                name: format!("optifine:OptiFine:{mc_version}_{of_ver}"),
                downloads: Some(LibraryDownloads {
                    artifact: Some(Artifact {
                        path: Some(rel_path),
                        sha1: None,
                        size: None,
                        url: Some(url.clone()),
                    }),
                    classifiers: None,
                }),
                natives: None,
                rules: Vec::new(),
                url: None,
                sha1: None,
                size: None,
            });
        }

        extra_mods.push(ExtraModFile {
            label: format!("OptiFine {of_ver}"),
            url,
            dest: mods_dir.join(file_name),
            sha1: None,
            size: None,
        });
    }

    Ok(extra_mods)
}
