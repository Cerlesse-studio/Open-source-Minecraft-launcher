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

/// `(term, english keywords)`. Terms are matched case-insensitively and the
/// longest match wins, so multi-character names must simply be present here —
/// order does not matter.
///
/// Keep this list ordered from specific names to generic categories for
/// readability; matching does not depend on the order.
const GLOSSARY: &[(&str, &str)] = &[
    // ---------------------------------------------------------------------
    // 中文 — 常用模组与资源包名称
    // ---------------------------------------------------------------------
    ("机械动力", "create"),
    ("機械動力", "create"),
    ("农夫乐事", "farmers delight"),
    ("農夫樂事", "farmers delight"),
    ("苹果皮", "apple skin"),
    ("蘋果皮", "apple skin"),
    ("高清修复", "optifine"),
    ("高清修復", "optifine"),
    ("钠", "sodium"),
    ("鈉", "sodium"),
    ("锂", "lithium"),
    ("鋰", "lithium"),
    ("铟", "indium"),
    ("銦", "indium"),
    ("氪", "krypton"),
    ("磷", "phosphor"),
    ("铷", "rubidium"),
    ("銣", "rubidium"),
    ("龙之研究", "draconic evolution"),
    ("龍之研究", "draconic evolution"),
    ("附属", "addon"),
    ("附屬", "addon"),
    ("附加", "addon"),
    ("扩展", "addon"),
    ("擴展", "addon"),
    ("模组加载器", "mod loader"),
    ("模組載入器", "mod loader"),
    ("更好的战斗", "better combat"),
    ("更好的戰鬥", "better combat"),
    ("起源", "origins"),
    ("匠魂", "tinkers construct"),
    ("沉浸工程", "immersive engineering"),
    ("工业时代", "industrial craft"),
    ("應用能源", "applied energistics"),
    ("应用能源", "applied energistics"),
    ("植物魔法", "botania"),
    ("神秘时代", "thaumcraft"),
    ("血魔法", "blood magic"),
    ("等价交换", "projecte"),
    ("暮色森林", "twilight forest"),
    ("群峦传说", "terrafirmacraft"),
    ("史诗战斗", "epic fight"),
    ("史詩戰鬥", "epic fight"),
    ("语音聊天", "voice chat"),
    ("語音聊天", "voice chat"),
    ("区块预生成", "chunky"),
    ("區塊預生成", "chunky"),
    ("宝可梦", "cobblemon"),
    ("寶可夢", "cobblemon"),
    ("旅行地图", "journeymap"),
    ("旅行地圖", "journeymap"),
    ("物品管理器", "jei"),
    ("合成表", "recipe"),
    ("墓碑", "graves"),
    ("小地图", "minimap"),
    ("小地圖", "minimap"),
    ("世界地图", "world map"),
    ("世界地圖", "world map"),
    ("地图", "map"),
    ("地圖", "map"),
    // ---------------------------------------------------------------------
    // 中文 — 内容类型与玩法
    // ---------------------------------------------------------------------
    ("资源包", "resource pack"),
    ("資源包", "resource pack"),
    ("材质包", "resource pack"),
    ("材質包", "resource pack"),
    ("光影包", "shader"),
    ("光影", "shader"),
    ("着色器", "shader"),
    ("数据包", "datapack"),
    ("資料包", "datapack"),
    ("整合包", "modpack"),
    ("模组包", "modpack"),
    ("模組包", "modpack"),
    ("模组", "mod"),
    ("模組", "mod"),
    ("汉化", "chinese"),
    ("漢化", "chinese"),
    ("中文", "chinese"),
    ("翻译", "translation"),
    ("翻譯", "translation"),
    ("优化", "optimization"),
    ("優化", "optimization"),
    ("性能", "performance"),
    ("效能", "performance"),
    ("帧数", "fps"),
    ("幀數", "fps"),
    ("卡顿", "lag"),
    ("渲染", "rendering"),
    ("光影效果", "shader"),
    ("音效", "sound"),
    ("音乐", "music"),
    ("音樂", "music"),
    ("界面", "ui"),
    ("图形", "graphics"),
    ("動畫", "animation"),
    ("动画", "animation"),
    ("写实", "realistic"),
    ("寫實", "realistic"),
    ("卡通", "cartoon"),
    ("像素", "pixel"),
    ("中世纪", "medieval"),
    ("中世紀", "medieval"),
    ("现代", "modern"),
    ("現代", "modern"),
    ("恐怖", "horror"),
    ("可爱", "cute"),
    ("可愛", "cute"),
    ("季节", "seasons"),
    ("季節", "seasons"),
    ("天气", "weather"),
    ("天氣", "weather"),
    // 玩法 / 维度 / 世界
    ("空岛", "skyblock"),
    ("空島", "skyblock"),
    ("生存", "survival"),
    ("冒险", "adventure"),
    ("冒險", "adventure"),
    ("任务", "quest"),
    ("任務", "quest"),
    ("魔法", "magic"),
    ("法术", "spell"),
    ("法術", "spell"),
    ("科技", "tech"),
    ("工业", "industrial"),
    ("工業", "industrial"),
    ("自动化", "automation"),
    ("自動化", "automation"),
    ("机械", "machines"),
    ("機械", "machines"),
    ("农业", "farming"),
    ("農業", "farming"),
    ("作物", "crops"),
    ("食物", "food"),
    ("烹饪", "cooking"),
    ("烹飪", "cooking"),
    ("钓鱼", "fishing"),
    ("釣魚", "fishing"),
    ("建筑", "building"),
    ("建築", "building"),
    ("装饰", "decoration"),
    ("裝飾", "decoration"),
    ("家具", "furniture"),
    ("照明", "lighting"),
    ("地形", "terrain"),
    ("生物群系", "biome"),
    ("洞穴", "cave"),
    ("维度", "dimension"),
    ("維度", "dimension"),
    ("下界", "nether"),
    ("地獄", "nether"),
    ("末地", "end"),
    ("終界", "end"),
    ("天空", "sky"),
    ("地牢", "dungeon"),
    ("村庄", "village"),
    ("村莊", "village"),
    ("城市", "city"),
    ("跑酷", "parkour"),
    ("小游戏", "minigames"),
    ("小遊戲", "minigames"),
    ("联机", "multiplayer"),
    ("聯機", "multiplayer"),
    ("多人", "multiplayer"),
    ("服务器", "server"),
    ("伺服器", "server"),
    ("生存模式", "survival"),
    ("创造模式", "creative"),
    ("創造模式", "creative"),
    // 战斗 / 装备 / 生物
    ("战斗", "combat"),
    ("戰鬥", "combat"),
    ("武器", "weapon"),
    ("工具", "tools"),
    ("盔甲", "armor"),
    ("装备", "equipment"),
    ("裝備", "equipment"),
    ("附魔", "enchantment"),
    ("药水", "potion"),
    ("藥水", "potion"),
    ("生命", "health"),
    ("饥饿", "hunger"),
    ("死亡", "death"),
    ("图腾", "totem"),
    ("图騰", "totem"),
    ("怪物", "mobs"),
    ("生物", "mobs"),
    ("动物", "animals"),
    ("動物", "animals"),
    ("宠物", "pets"),
    ("寵物", "pets"),
    ("首领", "boss"),
    ("首領", "boss"),
    ("僵尸", "zombie"),
    ("殭屍", "zombie"),
    ("骷髅", "skeleton"),
    ("苦力怕", "creeper"),
    ("末影人", "enderman"),
    ("村民", "villager"),
    ("凋灵", "wither"),
    ("凋靈", "wither"),
    ("龙", "dragon"),
    ("龍", "dragon"),
    // 物品 / 系统 / 载具
    ("箱子", "chest"),
    ("背包", "backpack"),
    ("存储", "storage"),
    ("存儲", "storage"),
    ("管道", "pipe"),
    ("能源", "energy"),
    ("电力", "electricity"),
    ("電力", "electricity"),
    ("核能", "nuclear"),
    ("太阳能", "solar"),
    ("太陽能", "solar"),
    ("反应堆", "reactor"),
    ("反應爐", "reactor"),
    ("火车", "train"),
    ("火車", "train"),
    ("汽车", "car"),
    ("汽車", "car"),
    ("飞机", "aircraft"),
    ("飛機", "aircraft"),
    ("船只", "boats"),
    ("枪械", "guns"),
    ("槍械", "guns"),
    ("传送", "teleport"),
    ("傳送", "teleport"),
    ("飞行", "flight"),
    ("飛行", "flight"),
    // ---------------------------------------------------------------------
    // 日本語
    // ---------------------------------------------------------------------
    ("シェーダー", "shader"),
    ("影mod", "shader"),
    ("最適化", "optimization"),
    ("軽量化", "optimization"),
    ("テクスチャ", "resource pack"),
    ("リソースパック", "resource pack"),
    ("ワールド", "world"),
    ("地図", "map"),
    ("サバイバル", "survival"),
    ("冒険", "adventure"),
    ("魔法", "magic"),
    ("工業", "industrial"),
    ("農業", "farming"),
    ("家具", "furniture"),
    ("建築", "building"),
    ("兵器", "weapon"),
    ("銃", "gun"),
    // ---------------------------------------------------------------------
    // 한국어
    // ---------------------------------------------------------------------
    ("셰이더", "shader"),
    ("최적화", "optimization"),
    ("모드", "mod"),
    ("지형", "terrain"),
    ("리소스팩", "resource pack"),
    ("월드", "world"),
    ("지도", "map"),
    ("생존", "survival"),
    ("모험", "adventure"),
    ("마법", "magic"),
    ("산업", "industrial"),
    ("농업", "farming"),
    ("가구", "furniture"),
    ("건축", "building"),
    ("무기", "weapon"),
    // ---------------------------------------------------------------------
    // Русский
    // ---------------------------------------------------------------------
    ("шейдер", "shader"),
    ("оптимизация", "optimization"),
    ("моды", "mod"),
    ("мод", "mod"),
    ("ресурспак", "resource pack"),
    ("карта", "map"),
    ("выживание", "survival"),
    ("приключение", "adventure"),
    ("магия", "magic"),
    ("оружие", "weapon"),
    ("ферма", "farm"),
    ("мебель", "furniture"),
    ("строительство", "building"),
];

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
        let best = GLOSSARY
            .iter()
            .filter(|(term, _)| lowered[index..].starts_with(*term))
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
