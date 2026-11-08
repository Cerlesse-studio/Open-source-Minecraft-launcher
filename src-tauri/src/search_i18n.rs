//! Multilingual search terms for the content market.
//!
//! Modrinth and CurseForge index English project names and descriptions, so a
//! Chinese (or Japanese/Korean/Russian) query such as `钠` or `機械動力`
//! returned zero results even though the project exists. This module maps the
//! vocabulary players actually type onto the English keywords the catalogues
//! understand.
//!
//! The table is deliberately a *glossary*, not a translator: it covers
//! Minecraft content terms plus the most-used project aliases, works offline,
//! and never changes a query it does not understand. Callers keep the original
//! query as a fallback, so a project whose real title is Chinese still matches.
//!
//! The pairs live in `src/lib/search-glossary.json` so the browser preview's
//! demo backend can use the same vocabulary; `include_str!` keeps the core
//! self-contained at runtime.

use std::sync::OnceLock;

/// `[term, english keywords]` pairs. Terms are matched case-insensitively and
/// the longest match wins, so multi-character names must simply be present in
/// the table — order does not matter.
fn glossary() -> &'static [(String, String)] {
    static TABLE: OnceLock<Vec<(String, String)>> = OnceLock::new();
    TABLE
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../src/lib/search-glossary.json"))
                .expect("search-glossary.json must be a list of [term, english] pairs")
        })
        .as_slice()
}

fn push_terms(terms: &mut Vec<String>, text: &str) {
    for word in text.split_whitespace() {
        let word = word.trim();
        if !word.is_empty() && !terms.iter().any(|existing| existing == word) {
            terms.push(word.to_string());
        }
    }
}

/// Translate a search query into English keywords.
///
/// Returns `None` for queries this table cannot help with (already English, or
/// nothing recognised), so the caller simply searches the original text.
/// Mixed queries keep both parts: `sodium 優化` → `sodium optimization`.
pub fn translate_query(query: &str) -> Option<String> {
    let trimmed = query.trim();
    if trimmed.is_empty() || trimmed.is_ascii() {
        return None;
    }

    let lowered = trimmed.to_lowercase();
    let mut terms: Vec<String> = Vec::new();
    let mut latin = String::new();
    let mut matched = false;
    let mut index = 0usize;

    while index < lowered.len() {
        let best = glossary()
            .iter()
            .filter(|(term, _)| lowered[index..].starts_with(term.as_str()))
            .max_by_key(|(term, _)| term.len());

        if let Some((term, english)) = best {
            if !latin.is_empty() {
                push_terms(&mut terms, &latin);
                latin.clear();
            }
            push_terms(&mut terms, english);
            matched = true;
            index += term.len();
            continue;
        }

        let Some(ch) = lowered[index..].chars().next() else {
            break;
        };
        if ch.is_ascii() {
            // Keep ASCII tokens (version numbers, slugs) intact; only
            // whitespace separates them.
            if ch.is_ascii_whitespace() {
                if !latin.is_empty() {
                    push_terms(&mut terms, &latin);
                    latin.clear();
                }
            } else {
                latin.push(ch);
            }
        } else if !latin.is_empty() {
            push_terms(&mut terms, &latin);
            latin.clear();
        }
        index += ch.len_utf8();
    }

    if !latin.is_empty() {
        push_terms(&mut terms, &latin);
    }
    if !matched || terms.is_empty() {
        return None;
    }
    Some(terms.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_project_names() {
        assert_eq!(translate_query("钠").as_deref(), Some("sodium"));
        assert_eq!(translate_query("机械动力").as_deref(), Some("create"));
        assert_eq!(translate_query("機械動力").as_deref(), Some("create"));
        assert_eq!(translate_query("小地图").as_deref(), Some("minimap"));
        assert_eq!(
            translate_query("农夫乐事").as_deref(),
            Some("farmers delight")
        );
    }

    #[test]
    fn translates_categories_and_splits_multi_term_queries() {
        assert_eq!(
            translate_query("机械动力 附属").as_deref(),
            Some("create addon")
        );
        // The resource-pack placeholder advertises 「材质」, which is only a
        // prefix of 「材质包」 in the glossary, so it needs its own row.
        assert_eq!(translate_query("材质").as_deref(), Some("resource pack"));
        assert_eq!(translate_query("材質").as_deref(), Some("resource pack"));
    }

    #[test]
    fn keeps_ascii_tokens_and_merges_them_with_translations() {
        // `addon` has no Chinese entry; the ASCII word must survive.
        assert_eq!(
            translate_query("sodium 优化").as_deref(),
            Some("sodium optimization")
        );
        assert_eq!(
            translate_query("钠 1.20.1").as_deref(),
            Some("sodium 1.20.1")
        );
    }

    #[test]
    fn leaves_english_and_unknown_text_alone() {
        assert_eq!(translate_query("Sodium"), None);
        assert_eq!(translate_query(""), None);
        assert_eq!(translate_query("   "), None);
        assert_eq!(translate_query("紫色小马"), None);
        // Only punctuation: nothing to translate.
        assert_eq!(translate_query("，。"), None);
    }

    #[test]
    fn handles_japanese_korean_and_russian_terms() {
        assert_eq!(translate_query("シェーダー").as_deref(), Some("shader"));
        assert_eq!(translate_query("최적화").as_deref(), Some("optimization"));
        assert_eq!(translate_query("шейдер").as_deref(), Some("shader"));
    }
}
