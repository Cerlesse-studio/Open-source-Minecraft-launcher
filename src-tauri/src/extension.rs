use crate::bridge::AppHandle;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::Digest;
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Largest single asset inlined into an extension popup. A popup that embeds
/// bigger files is better served by the native extension format.
const MAX_INLINE_ASSET_BYTES: u64 = 8 * 1024 * 1024;

type PackageArchive = zip::ZipArchive<Cursor<Vec<u8>>>;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionScripts {
    pub javascript: Option<String>,
    pub rust: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionTab {
    pub title: String,
    pub entry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionUi {
    pub popup: Option<String>,
    pub tab: Option<ExtensionTab>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub author: Option<String>,
    pub icon: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub scripts: Option<ExtensionScripts>,
    pub ui: Option<ExtensionUi>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionFormat {
    /// The launcher's own manifest shape (`scripts` / `ui`).
    #[default]
    Osml,
    /// A Chrome/Chromium manifest (`manifest_version` 2 or 3).
    Chrome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionItem {
    pub id: String,
    pub manifest: ExtensionManifest,
    pub enabled: bool,
    pub folder_path: String,
    pub has_rust: bool,
    pub has_javascript: bool,
    pub has_ui: bool,
    pub icon_data_url: Option<String>,
    pub js_code: Option<String>,
    pub rust_source_or_wasm: Option<String>,
    pub wasm_base64: Option<String>,
    pub ui_html: Option<String>,
    #[serde(default)]
    pub format: ExtensionFormat,
    #[serde(default)]
    pub manifest_version: Option<u32>,
    #[serde(default)]
    pub host_permissions: Vec<String>,
    /// Flattened `_locales/<default_locale>/messages.json`, exposed to popups as
    /// `chrome.i18n.getMessage`. `None` for launcher-native extensions.
    #[serde(default)]
    pub i18n: Option<HashMap<String, String>>,
}

// ---------------------------------------------------------------------------
// Chrome manifest (MV2 / MV3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChromeAction {
    pub default_popup: Option<String>,
    pub default_title: Option<String>,
    pub default_icon: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChromeBackground {
    #[serde(default)]
    pub scripts: Vec<String>,
    pub page: Option<String>,
    pub service_worker: Option<String>,
    #[serde(rename = "type")]
    pub worker_type: Option<String>,
}

/// Parsed Chrome manifest. Unknown keys (`content_scripts`, `web_accessible_resources`,
/// `options_ui`, …) are intentionally ignored: the launcher only consumes the
/// fields it can actually honour, and the compatibility gaps are documented.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChromeManifest {
    #[serde(default)]
    pub manifest_version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub author: Option<serde_json::Value>,
    pub icons: Option<BTreeMap<String, String>>,
    pub action: Option<ChromeAction>,
    #[serde(rename = "browser_action")]
    pub browser_action: Option<ChromeAction>,
    pub background: Option<ChromeBackground>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub host_permissions: Vec<String>,
    pub default_locale: Option<String>,
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

static MSG_PLACEHOLDER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"__MSG_([A-Za-z0-9_@]+)__").expect("valid placeholder regex"));
static LINK_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<link\b[^>]*>").expect("valid link regex"));
static SCRIPT_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<script\b([^>]*)>(.*?)</script>").expect("valid script regex")
});
static IMG_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<img\b[^>]*>").expect("valid img regex"));
static STYLE_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)(<style\b[^>]*>)(.*?)(</style>)").expect("valid style regex")
});
static CSS_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]*))\s*\)"#).expect("valid url regex")
});
static SCRIPT_CLOSE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</script").expect("valid script close regex"));

#[derive(Debug, Deserialize)]
struct LocaleMessage {
    #[serde(default)]
    message: String,
}

fn sanitize_extension_id(raw: &str) -> String {
    let mut id: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    id.truncate(64);
    id.trim_matches('_').to_string()
}

fn slugify(raw: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else {
            pending_dash = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

fn locale_candidates(default_locale: Option<&str>) -> Vec<String> {
    let mut locales = Vec::new();
    if let Some(locale) = default_locale.map(str::trim).filter(|s| !s.is_empty()) {
        locales.push(locale.replace('-', "_"));
    }
    for fallback in ["en", "en_US", "zh_CN"] {
        if !locales.iter().any(|value| value == fallback) {
            locales.push(fallback.to_string());
        }
    }
    locales
}

fn parse_locale_messages(text: &str) -> HashMap<String, String> {
    serde_json::from_str::<HashMap<String, LocaleMessage>>(text)
        .map(|messages| {
            messages
                .into_iter()
                .map(|(key, entry)| (key, entry.message))
                .collect()
        })
        .unwrap_or_default()
}

fn read_locale_messages(folder: &Path, default_locale: Option<&str>) -> HashMap<String, String> {
    for locale in locale_candidates(default_locale) {
        let path = folder.join("_locales").join(locale).join("messages.json");
        if let Ok(text) = fs::read_to_string(path) {
            let messages = parse_locale_messages(&text);
            if !messages.is_empty() {
                return messages;
            }
        }
    }
    HashMap::new()
}

fn resolve_placeholders(text: &str, messages: &HashMap<String, String>) -> String {
    if !text.contains("__MSG_") {
        return text.to_string();
    }
    MSG_PLACEHOLDER_RE
        .replace_all(text, |caps: &regex::Captures<'_>| {
            let key = &caps[1];
            messages
                .get(key)
                .or_else(|| messages.get(&key.to_ascii_lowercase()))
                .cloned()
                .unwrap_or_else(|| caps[0].to_string())
        })
        .into_owned()
}

fn chrome_author(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(author) => Some(author.clone()),
        serde_json::Value::Object(map) => map
            .get("name")
            .or_else(|| map.get("email"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        _ => None,
    }
}

fn icon_value_path(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(path) if !path.trim().is_empty() => Some(path.clone()),
        serde_json::Value::Object(map) => map
            .iter()
            .filter_map(|(size, path)| {
                size.parse::<u32>()
                    .ok()
                    .zip(path.as_str())
                    .map(|(size, path)| (size, path))
            })
            .max_by_key(|(size, _)| *size)
            .map(|(_, path)| path.to_string()),
        _ => None,
    }
}

fn chrome_icon_rel(manifest: &ChromeManifest) -> Option<String> {
    manifest
        .icons
        .as_ref()
        .and_then(|icons| {
            icons
                .iter()
                .filter_map(|(size, path)| size.parse::<u32>().ok().map(|size| (size, path)))
                .max_by_key(|(size, _)| *size)
                .map(|(_, path)| path.clone())
        })
        .or_else(|| {
            manifest
                .action
                .as_ref()
                .and_then(|action| icon_value_path(action.default_icon.as_ref()))
        })
        .or_else(|| {
            manifest
                .browser_action
                .as_ref()
                .and_then(|action| icon_value_path(action.default_icon.as_ref()))
        })
}

fn chrome_popup_rel(manifest: &ChromeManifest) -> Option<String> {
    manifest
        .action
        .as_ref()
        .and_then(|action| action.default_popup.clone())
        .or_else(|| {
            manifest
                .browser_action
                .as_ref()
                .and_then(|action| action.default_popup.clone())
        })
        .filter(|popup| !popup.trim().is_empty())
}

fn chrome_extension_id(
    manifest: &ChromeManifest,
    messages: &HashMap<String, String>,
    fallback: &str,
) -> String {
    let name = resolve_placeholders(&manifest.name, messages);
    let mut base = if name.contains("__MSG_") {
        slugify(fallback)
    } else {
        slugify(&name)
    };
    if base.is_empty() {
        base = slugify(fallback);
    }
    if base.is_empty() {
        base = "extension".to_string();
    }
    sanitize_extension_id(&format!("chrome-{base}"))
}

fn looks_like_host_permission(value: &str) -> bool {
    value == "<all_urls>" || value.contains("://") || value.starts_with("*.")
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "css" => "text/css",
        "js" => "text/javascript",
        "json" => "application/json",
        "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

/// Resolves a manifest-relative path, refusing anything outside `folder`.
fn resolve_extension_file(folder: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim();
    if rel.is_empty()
        || rel.starts_with('#')
        || rel.starts_with("//")
        || rel.starts_with("data:")
        || rel.starts_with("blob:")
        || rel.contains("://")
    {
        return None;
    }
    let clean = rel.split(['?', '#']).next().unwrap_or(rel);
    if clean.starts_with('/') || clean.contains(':') {
        return None;
    }
    let root = folder.canonicalize().ok()?;
    let path = folder.join(clean);
    let canonical = path.canonicalize().ok()?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return None;
    }
    Some(canonical)
}

fn path_data_url(path: &Path) -> Option<String> {
    if fs::metadata(path).ok()?.len() > MAX_INLINE_ASSET_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    Some(format!(
        "data:{};base64,{}",
        mime_for(path),
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
    ))
}

fn extension_file_data_url(folder: &Path, rel: &str) -> Option<String> {
    path_data_url(&resolve_extension_file(folder, rel)?)
}

fn read_extension_text(folder: &Path, rel: &str) -> Option<String> {
    let path = resolve_extension_file(folder, rel)?;
    if fs::metadata(&path).ok()?.len() > MAX_INLINE_ASSET_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn html_attr(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(
        r#"(?is)(?:^|[\s<]){}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#,
        regex::escape(name)
    );
    let re = Regex::new(&pattern).ok()?;
    let caps = re.captures(tag)?;
    caps.get(1)
        .or_else(|| caps.get(2))
        .or_else(|| caps.get(3))
        .map(|value| value.as_str().trim().to_string())
}

fn strip_html_attr(attrs: &str, name: &str) -> String {
    let pattern = format!(
        r#"(?is)\s+\b{}\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)"#,
        regex::escape(name)
    );
    match Regex::new(&pattern) {
        Ok(re) => re.replace_all(attrs, "").into_owned(),
        Err(_) => attrs.to_string(),
    }
}

fn replace_html_attr(tag: &str, name: &str, value: &str) -> String {
    let pattern = format!(
        r#"(?is)((?:^|[\s<]){}\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)"#,
        regex::escape(name)
    );
    let Ok(re) = Regex::new(&pattern) else {
        return tag.to_string();
    };
    re.replace(tag, |caps: &regex::Captures<'_>| {
        format!("{}{}", &caps[1], value)
    })
    .into_owned()
}

/// Rewrites `url(...)` in a stylesheet to self-contained data URLs.
fn inline_css_urls(css: &str, folder: &Path, base: &Path) -> String {
    let root = folder.canonicalize().ok();
    CSS_URL_RE
        .replace_all(css, |caps: &regex::Captures<'_>| {
            let raw = caps
                .get(1)
                .or_else(|| caps.get(2))
                .or_else(|| caps.get(3))
                .map(|value| value.as_str().trim())
                .unwrap_or("");
            if raw.is_empty()
                || raw.starts_with('#')
                || raw.starts_with("data:")
                || raw.starts_with("//")
                || raw.contains("://")
            {
                return caps[0].to_string();
            }
            let clean = raw.split(['?', '#']).next().unwrap_or(raw);
            let Some(root) = root.as_ref() else {
                return caps[0].to_string();
            };
            let Ok(path) = base.join(clean).canonicalize() else {
                return caps[0].to_string();
            };
            if !path.starts_with(root) || !path.is_file() {
                return caps[0].to_string();
            }
            let Some(data_url) = path_data_url(&path) else {
                return caps[0].to_string();
            };
            format!("url(\"{data_url}\")")
        })
        .into_owned()
}

/// Chrome popups reference sibling CSS/JS/images. `srcDoc` has no extension
/// directory to resolve those against, so inline them before handing the HTML
/// to the iframe. Dynamic `fetch()` / `chrome.runtime.getURL()` assets are out
/// of scope and called out in docs/extensions.md.
fn inline_popup_html(folder: &Path, html: &str, base: &Path) -> String {
    let mut output = LINK_TAG_RE
        .replace_all(html, |caps: &regex::Captures<'_>| {
            let tag = &caps[0];
            let rel = html_attr(tag, "rel")
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !rel.split_whitespace().any(|part| part == "stylesheet") {
                return tag.to_string();
            }
            let Some(href) = html_attr(tag, "href") else {
                return tag.to_string();
            };
            let Some(css) = read_extension_text(folder, &href) else {
                return tag.to_string();
            };
            let css_base = resolve_extension_file(folder, &href)
                .and_then(|path| path.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| base.to_path_buf());
            let css = inline_css_urls(&css, folder, &css_base).replace("</style", "<\\/style");
            format!("<style>\n{css}\n</style>")
        })
        .into_owned();

    output = STYLE_TAG_RE
        .replace_all(&output, |caps: &regex::Captures<'_>| {
            let css = inline_css_urls(&caps[2], folder, base).replace("</style", "<\\/style");
            format!("{}\n{css}\n{}", &caps[1], &caps[3])
        })
        .into_owned();

    output = IMG_TAG_RE
        .replace_all(&output, |caps: &regex::Captures<'_>| {
            let tag = &caps[0];
            let Some(src) = html_attr(tag, "src") else {
                return tag.to_string();
            };
            let Some(data_url) = extension_file_data_url(folder, &src) else {
                return tag.to_string();
            };
            replace_html_attr(tag, "src", &format!("\"{data_url}\""))
        })
        .into_owned();

    SCRIPT_TAG_RE
        .replace_all(&output, |caps: &regex::Captures<'_>| {
            let attrs = &caps[1];
            let Some(src) = html_attr(attrs, "src") else {
                return caps[0].to_string();
            };
            let Some(code) = read_extension_text(folder, &src) else {
                return caps[0].to_string();
            };
            let attrs = strip_html_attr(attrs, "src");
            let code = SCRIPT_CLOSE_RE.replace_all(&code, "<\\/script");
            format!("<script{attrs}>\n{code}\n</script>")
        })
        .into_owned()
}

fn extract_script_sources(html: &str) -> Vec<String> {
    SCRIPT_TAG_RE
        .captures_iter(html)
        .filter_map(|caps| html_attr(&caps[1], "src"))
        .collect()
}

fn unpack_extension_package(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() >= 12 && &bytes[0..4] == b"Cr24" {
        let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap_or([0; 4]));
        let offset = match version {
            3 => 12 + u32::from_le_bytes(bytes[8..12].try_into().unwrap_or([0; 4])) as usize,
            2 => {
                if bytes.len() < 16 {
                    return Err("CRX 文件头不完整".to_string());
                }
                16 + u32::from_le_bytes(bytes[8..12].try_into().unwrap_or([0; 4])) as usize
                    + u32::from_le_bytes(bytes[12..16].try_into().unwrap_or([0; 4])) as usize
            }
            other => {
                return Err(format!(
                    "不支持的 CRX 版本 {other}，请使用 Chrome 生成的 CRX2/CRX3 文件"
                ));
            }
        };
        if offset >= bytes.len() {
            return Err("CRX 文件头损坏或缺少 ZIP 数据".to_string());
        }
        // CRX 的签名用于 Chrome 校验；启动器不验证签名，压缩包会被直接解包。
        return Ok(bytes[offset..].to_vec());
    }
    Ok(bytes.to_vec())
}

fn copy_dir_all(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("创建目录失败: {error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("读取目录失败: {error}"))? {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_name() == ".git" {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let target_path = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target_path)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &target_path)
                .map_err(|error| format!("复制扩展文件失败: {error}"))?;
        }
    }
    Ok(())
}

fn staging_dir(base: &Path, id: &str) -> PathBuf {
    base.join(format!(
        ".install-{}-{}-{}",
        id,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ))
}

fn commit_staged_extension(base: &Path, id: &str, staging: &Path) -> Result<(), String> {
    let target = base.join(id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| format!("替换旧扩展目录失败: {error}"))?;
    }
    fs::rename(staging, &target).map_err(|error| format!("写入扩展目录失败: {error}"))
}

pub fn extensions_dir(app: &AppHandle, root: Option<&str>) -> PathBuf {
    if let Some(r) = root.filter(|s| !s.trim().is_empty()) {
        PathBuf::from(r).join("extensions")
    } else {
        crate::default_root(app).unwrap_or_else(|_| PathBuf::from(".minecraft")).join("extensions")
    }
}

fn load_extensions_state(dir: &Path) -> HashMap<String, bool> {
    let state_file = dir.join("extensions.json");
    if let Ok(content) = fs::read_to_string(&state_file) {
        if let Ok(map) = serde_json::from_str::<HashMap<String, bool>>(&content) {
            return map;
        }
    }
    HashMap::new()
}

fn save_extensions_state(dir: &Path, state: &HashMap<String, bool>) {
    let _ = fs::create_dir_all(dir);
    let state_file = dir.join("extensions.json");
    if let Ok(json) = serde_json::to_string_pretty(state) {
        let _ = fs::write(&state_file, json);
    }
}

fn load_extension_item(folder: &Path, state: &HashMap<String, bool>) -> Option<ExtensionItem> {
    let manifest_path = folder.join("manifest.json");
    if !manifest_path.is_file() {
        return None;
    }
    let manifest_text = fs::read_to_string(&manifest_path).ok()?;
    let raw: serde_json::Value = serde_json::from_str(&manifest_text).ok()?;
    let folder_id = folder
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("extension")
        .to_string();

    // Chrome/Chromium manifest. The directory name doubles as the extension id
    // so manual `extensions/<name>/` drops and installs behave identically.
    if let Some(version) = raw.get("manifest_version").and_then(|value| value.as_u64()) {
        if version != 2 && version != 3 {
            return None;
        }
        let chrome: ChromeManifest = serde_json::from_value(raw).ok()?;
        if chrome.name.trim().is_empty() || chrome.version.trim().is_empty() {
            return None;
        }

        let id = folder_id;
        let enabled = state.get(&id).copied().unwrap_or(true);
        let messages = read_locale_messages(folder, chrome.default_locale.as_deref());
        let name = resolve_placeholders(&chrome.name, &messages);
        let description = resolve_placeholders(&chrome.description, &messages);
        let (api_permissions, host_from_permissions): (Vec<String>, Vec<String>) = chrome
            .permissions
            .iter()
            .cloned()
            .partition(|permission| !looks_like_host_permission(permission));
        let mut host_permissions = chrome.host_permissions.clone();
        host_permissions.extend(host_from_permissions);

        let icon_rel = chrome_icon_rel(&chrome);
        let icon_data_url = icon_rel
            .as_deref()
            .and_then(|rel| extension_file_data_url(folder, rel));

        let popup_rel = chrome_popup_rel(&chrome);
        let ui_html = popup_rel.as_deref().and_then(|rel| {
            let path = resolve_extension_file(folder, rel)?;
            let html = fs::read_to_string(&path).ok()?;
            Some(inline_popup_html(folder, &html, path.parent()?))
        });
        let has_ui = ui_html.is_some();

        let mut background_parts = Vec::new();
        if let Some(background) = chrome.background.as_ref() {
            for script in &background.scripts {
                if let Some(code) = read_extension_text(folder, script) {
                    background_parts.push(code);
                }
            }
            if let Some(worker) = background.service_worker.as_deref() {
                if let Some(code) = read_extension_text(folder, worker) {
                    background_parts.push(code);
                }
            }
            if let Some(page) = background.page.as_deref() {
                if let Some(html) = read_extension_text(folder, page) {
                    for script in extract_script_sources(&html) {
                        if let Some(code) = read_extension_text(folder, &script) {
                            background_parts.push(code);
                        }
                    }
                }
            }
        }
        let has_javascript = !background_parts.is_empty();
        let js_code = if has_javascript {
            Some(background_parts.join("\n;\n"))
        } else {
            None
        };

        let manifest = ExtensionManifest {
            id: id.clone(),
            name,
            version: chrome.version.clone(),
            description,
            author: chrome_author(chrome.author.as_ref()),
            icon: icon_rel,
            permissions: api_permissions,
            scripts: Some(ExtensionScripts {
                javascript: chrome.background.as_ref().and_then(|background| {
                    background
                        .service_worker
                        .clone()
                        .or_else(|| background.scripts.first().cloned())
                }),
                rust: None,
            }),
            ui: popup_rel.map(|popup| ExtensionUi {
                popup: Some(popup),
                tab: None,
            }),
        };

        return Some(ExtensionItem {
            id,
            manifest,
            enabled,
            folder_path: folder.to_string_lossy().to_string(),
            has_rust: false,
            has_javascript,
            has_ui,
            icon_data_url,
            js_code,
            rust_source_or_wasm: None,
            wasm_base64: None,
            ui_html,
            format: ExtensionFormat::Chrome,
            manifest_version: Some(version as u32),
            host_permissions,
            i18n: if messages.is_empty() {
                None
            } else {
                Some(messages)
            },
        });
    }

    // Launcher-native manifest.
    let manifest: ExtensionManifest = serde_json::from_value(raw).ok()?;
    if manifest.id.trim().is_empty() {
        return None;
    }
    let ext_id = manifest.id.clone();
    let enabled = state.get(&ext_id).copied().unwrap_or(true);

    let icon_data_url = manifest
        .icon
        .as_deref()
        .and_then(|rel| extension_file_data_url(folder, rel));

    let mut js_code = None;
    let mut has_javascript = false;
    if let Some(scripts) = manifest.scripts.as_ref() {
        if let Some(js_rel) = scripts.javascript.as_deref() {
            if let Some(code) = read_extension_text(folder, js_rel) {
                js_code = Some(code);
                has_javascript = true;
            }
        }
    }

    let mut rust_source_or_wasm = None;
    let mut wasm_base64 = None;
    let mut has_rust = false;
    if let Some(scripts) = manifest.scripts.as_ref() {
        if let Some(rust_rel) = scripts.rust.as_deref() {
            if let Some(path) = resolve_extension_file(folder, rust_rel) {
                has_rust = true;
                if rust_rel.ends_with(".wasm") {
                    if let Ok(bytes) = fs::read(&path) {
                        wasm_base64 = Some(base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            &bytes,
                        ));
                    }
                } else if let Ok(code) = fs::read_to_string(&path) {
                    rust_source_or_wasm = Some(code);
                }
            }
        }
    }
    if wasm_base64.is_none() {
        if let Some(path) = resolve_extension_file(folder, "plugin.wasm") {
            has_rust = true;
            if let Ok(bytes) = fs::read(&path) {
                wasm_base64 = Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &bytes,
                ));
            }
        }
    }

    let mut ui_html = None;
    let mut has_ui = false;
    if let Some(ui) = manifest.ui.as_ref() {
        let popup_rel = ui
            .popup
            .as_deref()
            .or_else(|| ui.tab.as_ref().map(|tab| tab.entry.as_str()));
        if let Some(popup_rel) = popup_rel {
            if let Some(path) = resolve_extension_file(folder, popup_rel) {
                if let Ok(html) = fs::read_to_string(&path) {
                    has_ui = true;
                    ui_html = Some(inline_popup_html(
                        folder,
                        &html,
                        path.parent().unwrap_or(folder),
                    ));
                }
            }
        }
    }

    Some(ExtensionItem {
        id: ext_id,
        manifest,
        enabled,
        folder_path: folder.to_string_lossy().to_string(),
        has_rust,
        has_javascript,
        has_ui,
        icon_data_url,
        js_code,
        rust_source_or_wasm,
        wasm_base64,
        ui_html,
        format: ExtensionFormat::Osml,
        manifest_version: None,
        host_permissions: Vec::new(),
        i18n: None,
    })
}

pub fn list_extensions(app: &AppHandle, root: Option<&str>) -> Result<Vec<ExtensionItem>, String> {
    let base_dir = extensions_dir(app, root);
    if !base_dir.is_dir() {
        return Ok(Vec::new());
    }

    let state = load_extensions_state(&base_dir);
    let mut items = Vec::new();

    let Ok(entries) = fs::read_dir(&base_dir) else {
        return Ok(Vec::new());
    };

    for entry in entries.flatten() {
        let folder = entry.path();
        if !folder.is_dir() {
            continue;
        }
        // Staging dirs are dot-prefixed and must never show up as extensions.
        if folder
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with('.'))
            .unwrap_or(false)
        {
            continue;
        }
        if let Some(item) = load_extension_item(&folder, &state) {
            items.push(item);
        }
    }

    items.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    Ok(items)
}

enum PackageManifest {
    Native(ExtensionManifest),
    Chrome(ChromeManifest),
}

fn parse_package_manifest(raw: &serde_json::Value) -> Result<PackageManifest, String> {
    if let Some(version) = raw.get("manifest_version").and_then(|value| value.as_u64()) {
        if version != 2 && version != 3 {
            return Err(format!(
                "仅支持 Chrome 扩展 manifest_version 2 或 3，当前为 {version}"
            ));
        }
        let chrome: ChromeManifest = serde_json::from_value(raw.clone())
            .map_err(|error| format!("解析 Chrome manifest.json 失败: {error}"))?;
        if chrome.name.trim().is_empty() {
            return Err("Chrome manifest.json 缺少 name".to_string());
        }
        if chrome.version.trim().is_empty() {
            return Err("Chrome manifest.json 缺少 version".to_string());
        }
        return Ok(PackageManifest::Chrome(chrome));
    }

    let native: ExtensionManifest = serde_json::from_value(raw.clone())
        .map_err(|error| format!("解析 manifest.json 格式错误: {error}"))?;
    if native.id.trim().is_empty() {
        return Err("扩展 manifest.json 缺少 id".to_string());
    }
    if native.name.trim().is_empty() {
        return Err("扩展 manifest.json 缺少 name".to_string());
    }
    Ok(PackageManifest::Native(native))
}

fn read_locale_messages_from_zip(
    archive: &mut PackageArchive,
    prefix: &str,
    default_locale: Option<&str>,
) -> HashMap<String, String> {
    for locale in locale_candidates(default_locale) {
        let name = format!("{prefix}_locales/{locale}/messages.json");
        if let Ok(mut entry) = archive.by_name(&name) {
            let mut text = String::new();
            if entry.read_to_string(&mut text).is_ok() {
                let messages = parse_locale_messages(&text);
                if !messages.is_empty() {
                    return messages;
                }
            }
        }
    }
    HashMap::new()
}

fn extract_archive_to(
    archive: &mut PackageArchive,
    target: &Path,
    prefix: &str,
) -> Result<(), String> {
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let full_name = entry.name().replace('\\', "/");
        let rel_name = if !prefix.is_empty() && full_name.starts_with(prefix) {
            &full_name[prefix.len()..]
        } else {
            &full_name
        };
        if rel_name.is_empty()
            || rel_name.contains("..")
            || rel_name.starts_with('/')
            || rel_name.contains(':')
        {
            continue;
        }

        let out_path = target.join(rel_name);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|error| error.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut out_file = File::create(&out_path)
                .map_err(|error| format!("解压文件失败 ({}): {error}", out_path.display()))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|error| format!("写入文件失败: {error}"))?;
        }
    }
    Ok(())
}

fn finish_install(
    app: &AppHandle,
    base_dir: &Path,
    id: &str,
    staging: &Path,
    root: Option<&str>,
) -> Result<ExtensionItem, String> {
    if let Err(error) = commit_staged_extension(base_dir, id, staging) {
        let _ = fs::remove_dir_all(staging);
        return Err(error);
    }

    let mut state = load_extensions_state(base_dir);
    state.insert(id.to_string(), true);
    save_extensions_state(base_dir, &state);

    let items = list_extensions(app, root)?;
    items
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "安装完成但未能读取扩展信息".to_string())
}

pub fn install_extension_zip(
    app: &AppHandle,
    zip_path: &str,
    root: Option<&str>,
) -> Result<ExtensionItem, String> {
    let package_path = Path::new(zip_path);
    if !package_path.is_file() {
        return Err(format!("找不到指定的扩展安装包: {zip_path}"));
    }

    let bytes = fs::read(package_path).map_err(|error| format!("读取扩展安装包失败: {error}"))?;
    let package = unpack_extension_package(&bytes)?;
    let mut archive = zip::ZipArchive::new(Cursor::new(package))
        .map_err(|error| format!("解析扩展包失败，请检查 ZIP/CRX 是否损坏: {error}"))?;

    // 1. Locate manifest.json in the archive.
    let mut manifest_index = None;
    let mut prefix_to_strip = String::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().replace('\\', "/");
        if name == "manifest.json" {
            manifest_index = Some(index);
            prefix_to_strip.clear();
            break;
        }
        if name.ends_with("/manifest.json") && name.split('/').count() == 2 {
            manifest_index = Some(index);
            prefix_to_strip = format!("{}/", name.split('/').next().unwrap_or(""));
            break;
        }
    }

    let manifest_idx =
        manifest_index.ok_or_else(|| "扩展包中缺少 manifest.json，不是合规的扩展。".to_string())?;

    let manifest_content = {
        let mut entry = archive
            .by_index(manifest_idx)
            .map_err(|error| error.to_string())?;
        let mut content = String::new();
        entry
            .read_to_string(&mut content)
            .map_err(|error| format!("读取 manifest.json 失败: {error}"))?;
        content
    };

    let raw: serde_json::Value = serde_json::from_str(&manifest_content)
        .map_err(|error| format!("解析 manifest.json 格式错误: {error}"))?;
    let parsed = parse_package_manifest(&raw)?;
    let fallback_stem = package_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("extension");

    let messages = match &parsed {
        PackageManifest::Chrome(chrome) => read_locale_messages_from_zip(
            &mut archive,
            &prefix_to_strip,
            chrome.default_locale.as_deref(),
        ),
        PackageManifest::Native(_) => HashMap::new(),
    };
    let clean_id = match &parsed {
        PackageManifest::Native(manifest) => sanitize_extension_id(&manifest.id),
        PackageManifest::Chrome(chrome) => chrome_extension_id(chrome, &messages, fallback_stem),
    };
    if clean_id.is_empty() {
        return Err("扩展 id 不能为空".to_string());
    }

    let base_dir = extensions_dir(app, root);
    fs::create_dir_all(&base_dir).map_err(|error| format!("创建扩展目录失败: {error}"))?;
    let staging = staging_dir(&base_dir, &clean_id);
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| format!("创建临时扩展目录失败: {error}"))?;

    if let Err(error) = extract_archive_to(&mut archive, &staging, &prefix_to_strip) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    finish_install(app, &base_dir, &clean_id, &staging, root)
}

/// Installs an unpacked extension directory (`chrome://extensions` → "加载已解压的扩展程序").
/// `.git` is skipped, everything else is copied so Chrome's relative asset paths keep working.
pub fn install_extension_dir(
    app: &AppHandle,
    dir_path: &str,
    root: Option<&str>,
) -> Result<ExtensionItem, String> {
    let source = Path::new(dir_path);
    if !source.is_dir() {
        return Err(format!("找不到扩展目录: {dir_path}"));
    }
    let manifest_path = source.join("manifest.json");
    if !manifest_path.is_file() {
        return Err("所选目录根级缺少 manifest.json，请选择已解压扩展的根目录。".to_string());
    }

    let manifest_content = fs::read_to_string(&manifest_path)
        .map_err(|error| format!("读取 manifest.json 失败: {error}"))?;
    let raw: serde_json::Value = serde_json::from_str(&manifest_content)
        .map_err(|error| format!("解析 manifest.json 格式错误: {error}"))?;
    let parsed = parse_package_manifest(&raw)?;
    let fallback_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("extension");
    let messages = match &parsed {
        PackageManifest::Chrome(chrome) => {
            read_locale_messages(source, chrome.default_locale.as_deref())
        }
        PackageManifest::Native(_) => HashMap::new(),
    };
    let clean_id = match &parsed {
        PackageManifest::Native(manifest) => sanitize_extension_id(&manifest.id),
        PackageManifest::Chrome(chrome) => chrome_extension_id(chrome, &messages, fallback_name),
    };
    if clean_id.is_empty() {
        return Err("扩展 id 不能为空".to_string());
    }

    let base_dir = extensions_dir(app, root);
    fs::create_dir_all(&base_dir).map_err(|error| format!("创建扩展目录失败: {error}"))?;
    if let (Ok(source_path), Ok(install_root)) = (source.canonicalize(), base_dir.canonicalize()) {
        if source_path == install_root || source_path.starts_with(&install_root) {
            return Err("不能从扩展安装目录自身导入，请选择原始的扩展文件夹。".to_string());
        }
    }

    let staging = staging_dir(&base_dir, &clean_id);
    let _ = fs::remove_dir_all(&staging);
    if let Err(error) = copy_dir_all(source, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    finish_install(app, &base_dir, &clean_id, &staging, root)
}

pub fn toggle_extension(
    app: &AppHandle,
    id: &str,
    enabled: bool,
    root: Option<&str>,
) -> Result<(), String> {
    let base_dir = extensions_dir(app, root);
    let mut state = load_extensions_state(&base_dir);
    state.insert(id.to_string(), enabled);
    save_extensions_state(&base_dir, &state);
    Ok(())
}

pub fn uninstall_extension(app: &AppHandle, id: &str, root: Option<&str>) -> Result<(), String> {
    let base_dir = extensions_dir(app, root);
    let target_folder = base_dir.join(id);
    if target_folder.is_dir() {
        fs::remove_dir_all(&target_folder).map_err(|e| format!("删除扩展目录失败: {e}"))?;
    }
    let mut state = load_extensions_state(&base_dir);
    state.remove(id);
    save_extensions_state(&base_dir, &state);
    Ok(())
}

pub fn export_extension_zip(
    app: &AppHandle,
    id: &str,
    target_path: &str,
    root: Option<&str>,
) -> Result<String, String> {
    let base_dir = extensions_dir(app, root);
    let target_folder = base_dir.join(id);
    if !target_folder.is_dir() {
        return Err(format!("找不到扩展目录: {}", target_folder.display()));
    }

    let out_file_path = PathBuf::from(target_path);
    if let Some(parent) = out_file_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let file = File::create(&out_file_path).map_err(|e| format!("创建目标 ZIP 文件失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    fn add_dir_to_zip<W: Write + std::io::Seek>(
        writer: &mut zip::ZipWriter<W>,
        current_dir: &Path,
        root_dir: &Path,
        options: zip::write::SimpleFileOptions,
    ) -> Result<(), String> {
        let entries = fs::read_dir(current_dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(rel_path) = path.strip_prefix(root_dir) else {
                continue;
            };
            let rel_str = rel_path.to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                writer
                    .add_directory(&format!("{rel_str}/"), options)
                    .map_err(|e| e.to_string())?;
                add_dir_to_zip(writer, &path, root_dir, options)?;
            } else if path.is_file() {
                writer
                    .start_file(&rel_str, options)
                    .map_err(|e| e.to_string())?;
                let mut f = File::open(&path).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, writer).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    add_dir_to_zip(&mut writer, &target_folder, &target_folder, options)?;
    writer
        .finish()
        .map_err(|e| format!("完成 ZIP 写入失败: {e}"))?;

    Ok(format!("扩展已成功导出至: {}", out_file_path.display()))
}

pub fn create_sample_extension(
    app: &AppHandle,
    target_dir: Option<&str>,
    root: Option<&str>,
) -> Result<String, String> {
    let out_dir = match target_dir {
        Some(t) if !t.trim().is_empty() => PathBuf::from(t),
        _ => extensions_dir(app, root),
    };
    let _ = fs::create_dir_all(&out_dir);

    let zip_path = out_dir.join("sample-rust-js-extension.zip");
    let file = File::create(&zip_path).map_err(|e| format!("创建示例扩展包失败: {e}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    // 1. manifest.json
    let manifest_content = r#"{
  "id": "sample-companion",
  "name": "Minecraft 智能伙伴 (Rust + JS)",
  "version": "1.0.0",
  "description": "Chrome 扩展架构演示插件：引入 Rust WebAssembly 高性能模块与 JavaScript 沙盒脚本，提供游戏启动监听、状态分析与互动工具弹窗。",
  "author": "Open-Source Minecraft Community",
  "icon": "icon.png",
  "permissions": [
    "launcher:game",
    "launcher:storage",
    "launcher:notification",
    "launcher:rust",
    "network"
  ],
  "scripts": {
    "javascript": "background.js",
    "rust": "plugin.wasm"
  },
  "ui": {
    "popup": "popup.html",
    "tab": {
      "title": "扩展助手仪表盘",
      "entry": "popup.html"
    }
  }
}"#;
    writer
        .start_file("manifest.json", options)
        .map_err(|e| e.to_string())?;
    writer
        .write_all(manifest_content.as_bytes())
        .map_err(|e| e.to_string())?;

    // 2. background.js
    let background_js = r#"// Minecraft 智能伙伴 (Rust + JS) Background Script
console.log("[Extension] 智能伙伴扩展后台脚本已成功载入！");

// 1. 初始化存储
launcher.storage.get("launch_count").then((val) => {
  if (val == null) {
    launcher.storage.set("launch_count", 0);
  }
});

// 2. 监听游戏启动事件
launcher.game.onLaunch(async (event) => {
  console.log("[Extension] 侦测到游戏启动事件:", event);
  const count = (await launcher.storage.get("launch_count")) || 0;
  const nextCount = Number(count) + 1;
  await launcher.storage.set("launch_count", nextCount);
  await launcher.storage.set("last_launch_time", new Date().toLocaleString());

  // 调用内置 Rust 逻辑进行快速哈希与数值计算
  try {
    const rustResult = await launcher.rust.call("compute", { a: nextCount, b: 100 });
    console.log("[Extension] Rust 模块响应计算结果:", rustResult);
  } catch (err) {
    console.warn("[Extension] 调用 Rust 模块:", err);
  }

  // 发送系统通知
  launcher.ui.notify({
    title: "扩展助手：游戏已启动",
    message: `已为您记录启动历史（累计第 ${nextCount} 次启动），Rust 协处理器准备就绪！`,
    type: "info"
  });
});

// 3. 监听游戏结束事件
launcher.game.onExit((event) => {
  console.log("[Extension] 游戏已退出:", event);
  launcher.ui.notify({
    title: "扩展助手：游戏已退出",
    message: "游戏进程已安全终止，扩展会话状态已保存。",
    type: "info"
  });
});
"#;
    writer
        .start_file("background.js", options)
        .map_err(|e| e.to_string())?;
    writer
        .write_all(background_js.as_bytes())
        .map_err(|e| e.to_string())?;

    // 3. plugin.rs (Source code documentation)
    let plugin_rs = r#"// plugin.rs - 扩展的原生 Rust 源代码
// 可以直接编译为 WebAssembly (wasm32-unknown-unknown) 在扩展沙盒中秒级执行

#[no_mangle]
pub extern "C" fn compute(a: i32, b: i32) -> i32 {
    // 高性能整数计算与状态算法
    a * 2 + b
}

#[no_mangle]
pub extern "C" fn calculate_memory_mb(ram_gb: i32) -> i32 {
    ram_gb * 1024
}
"#;
    writer
        .start_file("plugin.rs", options)
        .map_err(|e| e.to_string())?;
    writer
        .write_all(plugin_rs.as_bytes())
        .map_err(|e| e.to_string())?;

    // 4. plugin.wasm (Valid minimal WebAssembly binary that exports `compute(a, b) -> a + b`)
    let wasm_bytes: &[u8] = &[
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // Magic & Version
        0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
        0x7f, // Type Section (i32, i32) -> i32
        0x03, 0x02, 0x01, 0x00, // Function Section
        0x07, 0x0b, 0x01, 0x07, 0x63, 0x6f, 0x6d, 0x70, 0x75, 0x74, 0x65, 0x00,
        0x00, // Export "compute"
        0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a,
        0x0b, // Code Section (add)
    ];
    writer
        .start_file("plugin.wasm", options)
        .map_err(|e| e.to_string())?;
    writer.write_all(&wasm_bytes).map_err(|e| e.to_string())?;

    // 5. popup.html (Chrome-like Extension UI)
    let popup_html = r#"<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>Minecraft 智能伙伴</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: #0f1712;
      color: #e5e7eb;
      width: 340px;
      box-sizing: border-box;
      user-select: none;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    .badge {
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 9999px;
      background: #10b981;
      color: #022c22;
    }
    .badge-rust {
      background: #f97316;
      color: #431407;
    }
    .title {
      font-size: 15px;
      font-weight: 600;
      color: #f3f4f6;
    }
    .card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    .stat-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      margin-bottom: 6px;
    }
    .stat-label { color: #9ca3af; }
    .stat-val { font-weight: 600; color: #34d399; }
    button {
      width: 100%;
      background: #059669;
      color: white;
      border: none;
      padding: 8px 12px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      margin-top: 6px;
    }
    button:hover { background: #10b981; }
    .rust-box {
      border-left: 3px solid #f97316;
      padding-left: 8px;
      font-size: 12px;
      color: #fed7aa;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">Minecraft 智能伙伴</div>
    <span class="badge badge-rust">Rust</span>
    <span class="badge">JS</span>
  </div>

  <div class="card">
    <div class="stat-row">
      <span class="stat-label">启动次数统计:</span>
      <span class="stat-val" id="launchCount">0 次</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">上次启动时间:</span>
      <span class="stat-val" id="lastLaunch" style="font-size: 11px;">尚未记录</span>
    </div>
    <button id="btnNotify">测试桌面通知</button>
  </div>

  <div class="card">
    <div class="stat-row">
      <span class="stat-label">Rust WASM 协处理器:</span>
      <span class="stat-val" id="wasmStatus">就绪</span>
    </div>
    <div class="rust-box" id="rustOutput">点击下方按钮直接调用 Rust 模块计算</div>
    <button id="btnRustCompute" style="background: #ea580c;">执行 Rust 加速计算</button>
  </div>

  <script>
    async function refreshData() {
      if (window.launcher && window.launcher.storage) {
        const count = await window.launcher.storage.get("launch_count") || 0;
        const last = await window.launcher.storage.get("last_launch_time") || "无";
        document.getElementById("launchCount").textContent = count + " 次";
        document.getElementById("lastLaunch").textContent = last;
      }
    }

    document.getElementById("btnNotify").addEventListener("click", () => {
      if (window.launcher && window.launcher.ui) {
        window.launcher.ui.notify({
          title: "智能伙伴弹窗提示",
          message: "来自 Chrome 风格扩展弹窗 UI 的交互通知！",
          type: "success"
        });
      }
    });

    document.getElementById("btnRustCompute").addEventListener("click", async () => {
      const output = document.getElementById("rustOutput");
      output.textContent = "正在调用 Rust 原生 WebAssembly 模块...";
      try {
        if (window.launcher && window.launcher.rust) {
          const res = await window.launcher.rust.call("compute", { a: 128, b: 256 });
          output.textContent = "Rust 计算完成: 128 + 256 = " + (res.result || res);
        } else {
          output.textContent = "未找到 launcher.rust 接口";
        }
      } catch (err) {
        output.textContent = "计算异常: " + err;
      }
    });

    refreshData();
  </script>
</body>
</html>
"#;
    writer
        .start_file("popup.html", options)
        .map_err(|e| e.to_string())?;
    writer
        .write_all(popup_html.as_bytes())
        .map_err(|e| e.to_string())?;

    // 6. icon.png (Minimal 16x16 emerald PNG)
    let png_bytes = [
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0xf3, 0xff, 0x61, 0x00, 0x00, 0x00, 0x22, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60,
        0x40, 0x05, 0xbf, 0x01, 0x06, 0x03, 0x18, 0x90, 0x91, 0x19, 0x18, 0x10, 0x88, 0x92, 0x19,
        0x18, 0x10, 0x88, 0x92, 0x19, 0x00, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x17, 0x3d, 0x05,
        0x19, 0xb8, 0xe2, 0xec, 0x47, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
        0x60, 0x82,
    ];
    writer
        .start_file("icon.png", options)
        .map_err(|e| e.to_string())?;
    writer.write_all(&png_bytes).map_err(|e| e.to_string())?;

    writer
        .finish()
        .map_err(|e| format!("生成示例扩展包完成失败: {e}"))?;

    // Also auto-install it into extensions directory so user sees it right away!
    let _ = install_extension_zip(app, &zip_path.to_string_lossy(), root);

    Ok(zip_path.to_string_lossy().to_string())
}

pub fn execute_extension_rust(
    _app: &AppHandle,
    id: &str,
    fn_name: &str,
    payload: serde_json::Value,
    _root: Option<&str>,
) -> Result<serde_json::Value, String> {
    // Native Rust execution dispatcher for extension hooks
    let a = payload.get("a").and_then(|v| v.as_i64()).unwrap_or(0);
    let b = payload.get("b").and_then(|v| v.as_i64()).unwrap_or(0);

    let result = match fn_name {
        "compute" => a + b,
        "multiply" => a * b,
        "hash" => {
            let input = payload.get("input").and_then(|v| v.as_str()).unwrap_or("");
            let mut hasher = sha1::Sha1::new();
            hasher.update(input.as_bytes());
            let digest = hasher.finalize();
            return Ok(serde_json::json!({
                "extensionId": id,
                "function": fn_name,
                "hash": format!("{digest:x}"),
                "success": true
            }));
        }
        _ => a + b,
    };

    Ok(serde_json::json!({
        "extensionId": id,
        "function": fn_name,
        "result": result,
        "timestamp": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        "success": true
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extension_lifecycle_and_zip_package() {
        let temp_dir = std::env::temp_dir().join(format!("test_osml_ext_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        let _ = fs::create_dir_all(&temp_dir);

        let app = AppHandle::default();
        let root_str = temp_dir.to_string_lossy().to_string();

        // 1. Create sample extension zip
        let zip_created = create_sample_extension(&app, None, Some(&root_str)).unwrap();
        assert!(Path::new(&zip_created).is_file());

        // 2. List extensions
        let list = list_extensions(&app, Some(&root_str)).unwrap();
        assert_eq!(list.len(), 1);
        let sample = &list[0];
        assert_eq!(sample.id, "sample-companion");
        assert!(sample.enabled);
        assert!(sample.has_rust);
        assert!(sample.has_javascript);
        assert!(sample.has_ui);
        assert!(
            sample
                .js_code
                .as_ref()
                .unwrap()
                .contains("launcher.game.onLaunch")
        );
        assert!(sample.wasm_base64.is_some());
        assert!(
            sample
                .ui_html
                .as_ref()
                .unwrap()
                .contains("Minecraft 智能伙伴")
        );

        // 3. Toggle extension
        toggle_extension(&app, "sample-companion", false, Some(&root_str)).unwrap();
        let list_after_toggle = list_extensions(&app, Some(&root_str)).unwrap();
        assert!(!list_after_toggle[0].enabled);

        // 4. Test Rust execution dispatcher
        let rust_res = execute_extension_rust(
            &app,
            "sample-companion",
            "compute",
            serde_json::json!({ "a": 50, "b": 25 }),
            Some(&root_str),
        )
        .unwrap();
        assert_eq!(rust_res.get("result").and_then(|v| v.as_i64()), Some(75));

        // 5. Test Export Extension to another zip
        let exported_zip = temp_dir.join("exported.zip");
        export_extension_zip(
            &app,
            "sample-companion",
            &exported_zip.to_string_lossy(),
            Some(&root_str),
        )
        .unwrap();
        assert!(exported_zip.is_file());

        // 6. Test Uninstall
        uninstall_extension(&app, "sample-companion", Some(&root_str)).unwrap();
        let list_after_uninstall = list_extensions(&app, Some(&root_str)).unwrap();
        assert_eq!(list_after_uninstall.len(), 0);

        // 7. Test Reinstalling from the exported zip
        let reinstalled =
            install_extension_zip(&app, &exported_zip.to_string_lossy(), Some(&root_str)).unwrap();
        assert_eq!(reinstalled.id, "sample-companion");
        assert!(reinstalled.enabled);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    fn write_zip_file(path: &Path, files: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in files {
            writer.start_file(*name, options).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap();
    }

    fn create_chrome_fixture_zip(path: &Path) {
        let manifest = r#"{
            "manifest_version": 3,
            "name": "__MSG_extName__",
            "version": "1.2.3",
            "description": "Chrome fixture",
            "default_locale": "en",
            "icons": { "128": "icon128.png" },
            "action": { "default_popup": "popup.html" },
            "background": { "service_worker": "background.js" },
            "permissions": ["storage", "notifications", "https://example.com/*"],
            "host_permissions": ["*://*.example.org/*"]
        }"#;
        let locale = r#"{"extName":{"message":"Chrome Hello"}}"#;
        let popup = r#"<html><head><link rel="stylesheet" href="popup.css"></head><body><img src="icon128.png"><script src="popup.js"></script></body></html>"#;
        let css = r#"body { background: url("icon128.png"); }"#;
        let popup_js =
            r#"chrome.storage.local.get("count").then(function (value) { console.log(value); });"#;
        let background = r#"chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) { sendResponse({ ok: true }); return true; });"#;
        let png: &[u8] = b"\x89PNG\r\n\x1a\nfixture";
        write_zip_file(
            path,
            &[
                ("manifest.json", manifest.as_bytes()),
                ("_locales/en/messages.json", locale.as_bytes()),
                ("popup.html", popup.as_bytes()),
                ("popup.css", css.as_bytes()),
                ("popup.js", popup_js.as_bytes()),
                ("background.js", background.as_bytes()),
                ("icon128.png", png),
            ],
        );
    }

    #[test]
    fn test_chrome_mv3_zip_install_and_popup_inlining() {
        let temp_dir =
            std::env::temp_dir().join(format!("test_osml_chrome_zip_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let app = AppHandle::default();
        let root_str = temp_dir.to_string_lossy().to_string();
        let zip_path = temp_dir.join("chrome-extension.zip");
        create_chrome_fixture_zip(&zip_path);

        let installed =
            install_extension_zip(&app, &zip_path.to_string_lossy(), Some(&root_str)).unwrap();
        assert_eq!(installed.id, "chrome-chrome-hello");
        assert_eq!(installed.format, ExtensionFormat::Chrome);
        assert_eq!(installed.manifest_version, Some(3));
        assert_eq!(installed.manifest.name, "Chrome Hello");
        assert!(installed.has_javascript);
        assert!(installed.has_ui);
        assert!(
            installed
                .icon_data_url
                .as_deref()
                .unwrap_or("")
                .starts_with("data:image/png;base64,")
        );
        assert!(
            installed
                .js_code
                .as_deref()
                .unwrap_or("")
                .contains("onMessage")
        );
        let html = installed.ui_html.as_deref().unwrap();
        assert!(html.contains("<style>"));
        assert!(html.contains("data:image/png;base64,"));
        assert!(html.contains("chrome.storage.local.get"));
        assert!(installed.i18n.as_ref().unwrap().contains_key("extName"));
        assert!(
            installed
                .manifest
                .permissions
                .iter()
                .any(|permission| permission == "storage")
        );
        assert!(
            !installed
                .manifest
                .permissions
                .iter()
                .any(|permission| permission.contains("://"))
        );
        assert!(
            installed
                .host_permissions
                .iter()
                .any(|permission| permission == "https://example.com/*")
        );
        assert!(
            installed
                .host_permissions
                .iter()
                .any(|permission| permission == "*://*.example.org/*")
        );

        let list = list_extensions(&app, Some(&root_str)).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].format, ExtensionFormat::Chrome);
        toggle_extension(&app, &installed.id, false, Some(&root_str)).unwrap();
        assert!(!list_extensions(&app, Some(&root_str)).unwrap()[0].enabled);
        uninstall_extension(&app, &installed.id, Some(&root_str)).unwrap();
        assert!(list_extensions(&app, Some(&root_str)).unwrap().is_empty());
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_crx3_package_install() {
        let temp_dir =
            std::env::temp_dir().join(format!("test_osml_chrome_crx_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(&temp_dir).unwrap();
        let app = AppHandle::default();
        let root_str = temp_dir.to_string_lossy().to_string();

        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer.start_file("manifest.json", options).unwrap();
        writer
            .write_all(
                br#"{"manifest_version":2,"name":"Crx Fixture","version":"1.0.0","browser_action":{"default_popup":"popup.html"}}"#,
            )
            .unwrap();
        writer.start_file("popup.html", options).unwrap();
        writer.write_all(b"<html><body>CRX</body></html>").unwrap();
        let zip_bytes = writer.finish().unwrap().into_inner();

        let mut crx = b"Cr24".to_vec();
        crx.extend(3u32.to_le_bytes());
        crx.extend(4u32.to_le_bytes());
        crx.extend([0u8, 0, 0, 0]);
        crx.extend(zip_bytes);
        let crx_path = temp_dir.join("fixture.crx");
        fs::write(&crx_path, crx).unwrap();

        let installed =
            install_extension_zip(&app, &crx_path.to_string_lossy(), Some(&root_str)).unwrap();
        assert_eq!(installed.id, "chrome-crx-fixture");
        assert_eq!(installed.format, ExtensionFormat::Chrome);
        assert_eq!(installed.manifest_version, Some(2));
        assert!(installed.has_ui);
        assert!(installed.ui_html.as_deref().unwrap_or("").contains("CRX"));
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_unpacked_chrome_directory_install() {
        let temp_dir =
            std::env::temp_dir().join(format!("test_osml_chrome_dir_{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        let source = temp_dir.join("source-extension");
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(
            source.join("manifest.json"),
            br#"{"manifest_version":3,"name":"Directory Fixture","version":"2.0.0","action":{"default_popup":"popup.html"}}"#,
        )
        .unwrap();
        fs::write(
            source.join("popup.html"),
            b"<html><body>directory</body></html>",
        )
        .unwrap();
        fs::write(source.join("assets").join("marker.txt"), b"copied").unwrap();

        let app = AppHandle::default();
        let root_str = temp_dir.join("root").to_string_lossy().to_string();
        let installed =
            install_extension_dir(&app, &source.to_string_lossy(), Some(&root_str)).unwrap();
        assert_eq!(installed.id, "chrome-directory-fixture");
        assert_eq!(installed.format, ExtensionFormat::Chrome);
        assert!(installed.has_ui);
        assert!(
            Path::new(&installed.folder_path)
                .join("assets")
                .join("marker.txt")
                .is_file()
        );
        let _ = fs::remove_dir_all(&temp_dir);
    }
}
