//! MC 百科（mcmod.cn）条目解析。
//!
//! PCL2 在它的资源页面上给出「MC 百科」按钮，链接的是具体条目
//! `https://www.mcmod.cn/class/<id>.html`，找不到条目时干脆不显示；它靠的是一份
//! 随启动器更新的 slug → 条目 ID 映射表。这里不复制那份表（体积近 1 MB，且它的
//! 使用条款对二次分发有额外要求），改用 MC 百科自己的搜索页做同样的定位：
//!
//! * 只查询一次（按类型限定 `filter=1` 模组 / `filter=2` 整合包），最多两个关键词；
//! * 只接受「英文名 / 方括号缩写 / 整个标题」与项目 slug 完全一致的结果，
//!   因此 `Sodium` 不会误跳到 `Sodium Extra`，`Create` 也不会跳到 `Create: Neoforge`；
//! * 匹配不到就返回 `None`，界面退回到搜索页，而不是硬塞一个可能错误的条目。

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const SEARCH_HOST: &str = "https://search.mcmod.cn/s";
const SITE_HOST: &str = "https://www.mcmod.cn";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// MC 百科条目和搜索结果都很少变化，缓存一天。
const MCMOD_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// Type-restricted tab and the combined one, tried in this order: the narrow tab
/// gives short, focused results, while "全部" rescues popular entries (Create,
/// JEI) that the narrow tab's snapshot ordering pushes off the first page.
const MOD_FILTERS: [u8; 2] = [1, 0];
const MODPACK_FILTERS: [u8; 2] = [2, 0];

fn filters_for(kind: &str) -> &'static [u8; 2] {
    if kind.eq_ignore_ascii_case("modpack") {
        &MODPACK_FILTERS
    } else {
        &MOD_FILTERS
    }
}

/// 一个已定位的 MC 百科条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiEntry {
    /// MC 百科的页面 ID（`/class/<id>.html`）。
    pub id: u32,
    /// 搜索结果里的完整标题，例如「钠 (Sodium)」。
    pub title: String,
    /// 中文名，界面与英文名并排显示（百科标题本身是中文，取括号外的部分）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_zh: Option<String>,
    /// 英文名，取自百科标题括号内的部分；没有时回退到项目自己的英文名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_en: Option<String>,
    /// 页面地址，始终指向具体条目。
    pub url: String,
}

/// 搜索页里的一条结果：条目 ID、标题文本（标签已剥离）与页面地址。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    id: u32,
    title: String,
    /// `/class/` for mods and data packs, `/modpack/` for modpacks.
    url: String,
}

fn cache() -> &'static Mutex<HashMap<String, Option<WikiEntry>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<WikiEntry>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(title: &str, slug: &str, kind: &str) -> String {
    format!(
        "{}|{}|{}",
        kind.trim().to_lowercase(),
        slug.trim().to_lowercase(),
        title.trim().to_lowercase()
    )
}

/// Strip inline tags (`<em>`), decode the handful of entities the search page uses
/// and collapse whitespace, so titles compare cleanly.
fn clean_title(raw: &str) -> String {
    let mut text = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => text.push(ch),
            _ => {}
        }
    }

    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");

    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pull every `<div class="result-item">` entry out of a search page.
///
/// Mods and data packs live under `/class/<id>.html`, modpacks under
/// `/modpack/<id>.html`; both are kept so a modpack query can resolve too.
fn parse_results(html: &str) -> Vec<Candidate> {
    const ITEM: &str = "class=\"result-item\"";
    const HREF: &str = "href=\"https://www.mcmod.cn/";

    let mut out = Vec::new();
    let mut rest = html;

    while let Some(item_at) = rest.find(ITEM) {
        rest = &rest[item_at + ITEM.len()..];

        let Some(href_at) = rest.find(HREF) else {
            continue;
        };
        let after_href = &rest[href_at + HREF.len()..];
        let Some(quote) = after_href.find('"') else {
            continue;
        };

        // e.g. `class/2785.html` or `modpack/248.html`
        let path = &after_href[..quote];
        let Some((section, file)) = path.split_once('/') else {
            continue;
        };
        if section != "class" && section != "modpack" {
            continue;
        }
        let Ok(id) = file.trim_end_matches(".html").parse::<u32>() else {
            continue;
        };

        let after_quote = &after_href[quote..];
        let Some(gt) = after_quote.find('>') else {
            continue;
        };
        let text_zone = &after_quote[gt + 1..];
        let Some(close) = text_zone.find("</a>") else {
            continue;
        };

        out.push(Candidate {
            id,
            title: clean_title(&text_zone[..close]),
            url: format!("{SITE_HOST}/{path}"),
        });
    }

    out
}

/// Lowercase letters and digits only, so `Sodium Extra`, `sodium-extra` and
/// `SodiumExtra` all collapse to the same key. CJK characters are kept so a
/// project titled with its Chinese name can still match a wiki entry.
fn compact(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Contents of the leading `[ABC]` tag, if any (e.g. `[JEI] JEI物品管理器`).
fn bracket_tag(title: &str) -> Option<String> {
    let trimmed = title.trim_start();
    let rest = trimmed.strip_prefix('[')?;
    let end = rest.find(']')?;
    Some(compact(&rest[..end]))
}

/// Every `(...)` group inside a title, e.g. `钠 (Sodium)` → `["sodium"]`.
fn paren_parts(title: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = title;
    while let Some(start) = rest.find('(') {
        let after = &rest[start + 1..];
        let Some(end) = after.find(')') else {
            break;
        };
        parts.push(compact(&after[..end]));
        rest = &after[end + 1..];
    }
    parts
}

/// Title without its bracketed tag and parenthesised names, e.g.
/// `[JEI]JEI物品管理器 (Just Enough Items)` → `jei物品管理器`.
fn base_title(title: &str) -> String {
    let mut text = title.trim().to_string();
    if let Some(rest) = text.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            text = rest[end + 1..].to_string();
        }
    }
    if let Some(start) = text.find('(') {
        text.truncate(start);
    }
    compact(&text)
}

/// Pick the entry whose English name matches the project, never a neighbour.
///
/// Matching is intentionally exact: a fuzzy rule would send `Sodium` to
/// `Sodium Extra` the way older PCL builds did.
fn pick_match<'a>(candidates: &'a [Candidate], slug: &str, title: &str) -> Option<&'a Candidate> {
    let mut keys = vec![compact(slug), compact(title)];
    keys.retain(|key| key.len() >= 3);
    keys.dedup();
    if keys.is_empty() {
        return None;
    }

    for candidate in candidates {
        let full = compact(&candidate.title);
        let base = base_title(&candidate.title);
        let parens = paren_parts(&candidate.title);
        let bracket = bracket_tag(&candidate.title);

        for key in &keys {
            if full == *key
                || base == *key
                || bracket.as_deref() == Some(key)
                || parens.iter().any(|part| part == key)
            {
                return Some(candidate);
            }
        }
    }

    None
}

fn has_cjk(value: &str) -> bool {
    value.chars().any(|c| {
        matches!(c,
            '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}' | '\u{f900}'..='\u{faff}')
    })
}

fn has_latin(value: &str) -> bool {
    value.chars().any(|c| c.is_ascii_alphabetic())
}

/// 去掉开头的 `[ABC]` 缩写标签（`[JEI]JEI物品管理器 (…)`）。
fn strip_bracket_tag(title: &str) -> &str {
    let trimmed = title.trim();
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[end + 1..].trim();
        }
    }
    trimmed
}

/// 把 MC 百科的标题拆成（中文名，英文名）。
///
/// 百科的标题格式是 `中文名 (English Name)`，例如「钠 (Sodium)」「机械动力
/// (Create)」；括号里有时是多个英文别名（`镁 (Magnesium / Sodium Reforged)`），
/// 原样保留。只有一侧命中语言特征才当作该语言的名字，避免把 ``FabricAPI``
/// 当成中文名。
fn bilingual_names(title: &str) -> (Option<String>, Option<String>) {
    let body = strip_bracket_tag(title);
    let (outside, inside) = match body.find('(') {
        Some(start) => {
            let after = &body[start + 1..];
            let end = after.find(')').unwrap_or(after.len());
            (body[..start].trim(), after[..end].trim())
        }
        None => (body, ""),
    };

    let chinese = (!outside.is_empty() && has_cjk(outside)).then(|| outside.to_string());
    let english = (!inside.is_empty() && has_latin(inside) && !has_cjk(inside))
        .then(|| inside.to_string());
    (chinese, english)
}

/// 项目自己的英文名：优先目录里的标题（去掉括号别名），否则用 slug。
fn project_english_name(title: &str, slug: &str) -> Option<String> {
    let bare = strip_parens(title);
    if has_latin(&bare) && !has_cjk(&bare) {
        return Some(bare);
    }
    let slug = slug.trim();
    if has_latin(slug) {
        return Some(slug.replace(['-', '_'], " "));
    }
    None
}

/// 项目自己的中文名（目录标题就是中文时才会命中）。
fn project_chinese_name(title: &str) -> Option<String> {
    let bare = strip_parens(title);
    (has_cjk(&bare)).then_some(bare)
}

/// Title without its parenthesised aliases, e.g. `Just Enough Items (JEI)`
/// → `Just Enough Items`.
fn strip_parens(title: &str) -> String {
    match title.find('(') {
        Some(start) => title[..start].trim().to_string(),
        None => title.trim().to_string(),
    }
}

/// Keywords to try, most specific first. Two at most, so a page view costs no
/// more than two lightweight requests.
fn query_variants(title: &str, slug: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for candidate in [slug.trim(), strip_parens(title).as_str(), title.trim()] {
        let value = candidate.trim();
        if value.is_empty() {
            continue;
        }
        if !out
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(value))
        {
            out.push(value.to_string());
        }
        if out.len() == 2 {
            break;
        }
    }
    out
}

fn search_url(key: &str, filter: u8) -> String {
    format!(
        "{}?key={}&filter={}&mold=0",
        SEARCH_HOST,
        crate::content::urlencoding(key),
        filter
    )
}

async fn fetch_text(url: &str) -> Result<String, String> {
    // 百科页面几乎不变，缓存一天：同一个项目反复打开时不再重复抓取，
    // 断网时也能显示上次找到的条目。
    crate::metadata_cache::fetch_text("mcmod", url, url, MCMOD_CACHE_TTL, REQUEST_TIMEOUT)
        .await
        .map_err(|e| format!("请求 MC 百科搜索失败: {e}"))
}

/// Resolve the wiki entry of a project by its slug / English title. `kind` is
/// `mod`, `modpack` or `datapack`; it only selects which MC 百科 tab is searched
/// first.
///
/// Returns `None` when no entry matches exactly. Shaders and resource packs have
/// no MC 百科 section at all, and the caller hides the button for them.
pub async fn find_entry(title: &str, slug: &str, kind: &str) -> Option<WikiEntry> {
    let key = cache_key(title, slug, kind);
    if let Ok(cache) = cache().lock() {
        if let Some(hit) = cache.get(&key) {
            return hit.clone();
        }
    }

    let mut found = None;

    'queries: for query in query_variants(title, slug) {
        for filter in filters_for(kind).iter().copied() {
            let url = search_url(&query, filter);
            let Ok(html) = fetch_text(&url).await else {
                continue;
            };

            if let Some(hit) = pick_match(&parse_results(&html), slug, title) {
                // 双语对照：中文名来自百科标题，英文名也优先用百科标题括号里的
                // 那个（目录里的英文名可能带别名或全大写），缺失时才互相回退。
                let (name_zh, name_en) = bilingual_names(&hit.title);
                found = Some(WikiEntry {
                    id: hit.id,
                    title: hit.title.clone(),
                    name_zh: name_zh.or_else(|| project_chinese_name(title)),
                    name_en: name_en.or_else(|| project_english_name(title, slug)),
                    url: hit.url.clone(),
                });
                break 'queries;
            }
        }
    }

    if let Ok(mut cache) = cache().lock() {
        cache.insert(key, found.clone());
    }

    found
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = r#"<div class="search-result-list">
        <div class="result-item"><div class="head"><div class="class-category"><ul><li><a class="c_24" href="//www.mcmod.cn/class/category/24-1.html"></a></li></ul></div><a  target="_blank" href="https://www.mcmod.cn/class/16585.html"><em>Sodium</em> Extra Information</a></div><div class="body">x</div><div class="foot"><span class="info"><span class="value"><a target="_blank" href="https://www.mcmod.cn/class/16585.html">www.mcmod.cn/class/16585.html</a></span></span></div></div>
        <div class="result-item"><div class="head"><a  target="_blank" href="https://www.mcmod.cn/class/2785.html">钠 (<em>Sodium</em>)</a></div><div class="body">钠是渲染优化模组。</div><div class="foot"><a target="_blank" href="https://www.mcmod.cn/class/2785.html">www.mcmod.cn/class/2785.html</a></div></div>
        <div class="result-item"><div class="head"><a  target="_blank" href="https://www.mcmod.cn/class/459.html">[JEI]JEI物品管理器 (Just Enough Items)</a></div><div class="body">物品管理器。</div></div>
        <div class="result-item"><div class="head"><a  target="_blank" href="https://www.mcmod.cn/class/2021.html">机械动力 (Create)</a></div><div class="body">动力学模组。</div></div>
        <div class="result-item"><div class="head"><a  target="_blank" href="https://www.mcmod.cn/class/3124.html">FabricAPI</a></div><div class="body">API。</div></div>
        <div class="result-item"><div class="head"><a  target="_blank" href="https://www.mcmod.cn/modpack/248.html">[FO] 难以置信的优化 (Fabulously Optimized)</a></div><div class="body">整合包。</div></div>
    </div>"#;

    #[test]
    fn parses_candidate_ids_and_titles() {
        let items = parse_results(PAGE);
        assert_eq!(items.len(), 6);
        assert_eq!(items[1].id, 2785);
        assert_eq!(items[1].title, "钠 (Sodium)");
        assert_eq!(items[1].url, "https://www.mcmod.cn/class/2785.html");
        assert_eq!(items[2].title, "[JEI]JEI物品管理器 (Just Enough Items)");
        assert_eq!(items[5].url, "https://www.mcmod.cn/modpack/248.html");
    }

    #[test]
    fn resolves_modpacks_through_the_modpack_url() {
        let items = parse_results(PAGE);
        let hit = pick_match(&items, "fabulously-optimized", "Fabulously Optimized")
            .expect("fabulously optimized entry");
        assert_eq!(hit.id, 248);
        assert_eq!(hit.url, "https://www.mcmod.cn/modpack/248.html");
    }

    #[test]
    fn matches_the_exact_project_not_its_addons() {
        let items = parse_results(PAGE);
        // `Sodium Extra Information` comes first; the base mod must still win.
        let hit = pick_match(&items, "sodium", "Sodium").expect("sodium entry");
        assert_eq!(hit.id, 2785);

        let hit = pick_match(&items, "jei", "Just Enough Items (JEI)").expect("jei entry");
        assert_eq!(hit.id, 459);

        let hit = pick_match(&items, "create", "Create").expect("create entry");
        assert_eq!(hit.id, 2021);

        let hit = pick_match(&items, "fabric-api", "Fabric API").expect("fabric api entry");
        assert_eq!(hit.id, 3124);
    }

    #[test]
    fn refuses_when_only_neighbours_exist() {
        let items = parse_results(PAGE);
        assert!(pick_match(&items, "sodium-extra", "Sodium Extra").is_none());
        assert!(pick_match(&items, "iris-shaders", "Iris Shaders").is_none());
        assert!(pick_match(&items, "", "").is_none());
    }

    #[test]
    fn splits_wiki_titles_into_chinese_and_english_names() {
        assert_eq!(
            bilingual_names("钠 (Sodium)"),
            (Some("钠".to_string()), Some("Sodium".to_string()))
        );
        assert_eq!(
            bilingual_names("[JEI]JEI物品管理器 (Just Enough Items)"),
            (
                Some("JEI物品管理器".to_string()),
                Some("Just Enough Items".to_string())
            )
        );
        // 多个英文别名原样保留。
        assert_eq!(
            bilingual_names("镁 (Magnesium / Sodium Reforged)"),
            (
                Some("镁".to_string()),
                Some("Magnesium / Sodium Reforged".to_string())
            )
        );
        // 纯英文标题没有中文名，不能硬塞一个。
        assert_eq!(bilingual_names("FabricAPI"), (None, None));
        assert_eq!(
            bilingual_names("机械动力 (Create)"),
            (Some("机械动力".to_string()), Some("Create".to_string()))
        );
    }

    #[test]
    fn falls_back_to_the_project_name_for_the_missing_language() {
        // 百科标题没有括号（纯中文）：英文名用目录里的项目标题。
        assert_eq!(
            project_english_name("Create", "create"),
            Some("Create".to_string())
        );
        // 括号别名不进入英文名。
        assert_eq!(
            project_english_name("Just Enough Items (JEI)", "jei"),
            Some("Just Enough Items".to_string())
        );
        // 标题本身就是英文时没有中文名；中文标题则相反。
        assert_eq!(project_chinese_name("Sodium"), None);
        assert_eq!(
            project_chinese_name("机械动力 (Create)"),
            Some("机械动力".to_string())
        );
    }

    #[test]
    fn normalizes_repeated_parens_and_tags() {
        assert_eq!(compact("Sodium-Extra"), "sodiumextra");
        assert_eq!(
            paren_parts("镁 (Magnesium / Sodium Reforged)"),
            vec!["magnesiumsodiumreforged"]
        );
        assert_eq!(bracket_tag("[W2W] 传送石碑路径点"), Some("w2w".to_string()));
        assert_eq!(
            base_title("[JEI]JEI物品管理器 (Just Enough Items)"),
            "jei物品管理器"
        );
        assert_eq!(clean_title("钠&nbsp;(<em>Sodium</em>)"), "钠 (Sodium)");
    }

    #[test]
    fn requires_a_meaningful_key() {
        let items = parse_results(PAGE);
        assert!(pick_match(&items, "je", "JE").is_none());
    }

    #[test]
    fn builds_the_site_search_url() {
        assert_eq!(
            search_url("sodium", 1),
            "https://search.mcmod.cn/s?key=sodium&filter=1&mold=0"
        );
        assert_eq!(
            search_url("sodium", 0),
            "https://search.mcmod.cn/s?key=sodium&filter=0&mold=0"
        );
    }

    #[test]
    fn modpacks_search_the_pack_tab_first() {
        assert_eq!(filters_for("modpack"), &[2, 0]);
        assert_eq!(filters_for("mod"), &[1, 0]);
        assert_eq!(filters_for("datapack"), &[1, 0]);
    }

    #[test]
    fn queries_use_slug_then_bare_title() {
        assert_eq!(
            query_variants("Just Enough Items (JEI)", "jei"),
            vec!["jei".to_string(), "Just Enough Items".to_string()]
        );
        assert_eq!(
            query_variants("钠", "sodium"),
            vec!["sodium".to_string(), "钠".to_string()]
        );
    }
}
