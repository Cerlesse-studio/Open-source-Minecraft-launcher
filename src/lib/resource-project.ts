/**
 * PCL2 `ResourceProject` view model and `GetControlTitle` port.
 *
 * PCL2 keeps the untranslated English name in `RawName`, the MC 百科 name in
 * `TranslatedName` (e.g. `钠 (Sodium)`, falling back to `RawName`), and builds
 * the two-line list item from `GetControlTitle(HasModLoaderDescription)`:
 * `Title` -> `MyResourceItem.Title` (`LabTitle`),
 * `SubTitle` -> `MyResourceItem.SubTitle` (`LabTitleRaw`, collapsed when empty),
 * `Tags` -> `PanTags`, `Description` -> `LabInfo`.
 *
 * This is a pure view model: `ContentHit` and every IPC shape stay untouched.
 */
import type { ContentHit } from "./types";

export interface ResourceProject {
  /** PCL2 `RawName`: original English name. */
  rawName: string;
  /** PCL2 `TranslatedName`: Chinese title, or `rawName` when unavailable. */
  translatedName: string;
  /** PCL2 `WikiId`: 0 when no MC 百科 entry is attached. */
  wikiId: number;
  slug: string;
  id: string;
  /** PCL2 `ResourcePlatforms` value (display metadata only). */
  platform: "CurseForge" | "Modrinth";
  description: string;
  /** PCL2 `Tags`: display tags, already localized. */
  tags: string[];
  logoUrl?: string | null;
  downloadCount: number;
  modLoaders: string[];
  drops: string[];
}

/** PCL2 `MyResourceItem` title tuple (PascalCase names kept from VB). */
export interface ControlTitle {
  Title: string;
  /** PCL2 joins parts with a leading `" | "`. */
  SubTitle: string;
}

export function toResourceProject(
  hit: ContentHit,
  translatedName?: string | null,
): ResourceProject {
  const rawName = hit.title ?? "";
  return {
    rawName,
    translatedName: translatedName?.trim() || rawName,
    wikiId: 0,
    slug: hit.slug ?? "",
    id: hit.projectId ?? "",
    platform:
      hit.categories?.some((c) => c === "bedrock" || c === "基岩版") ||
      hit.versions?.includes("基岩版")
        ? "CurseForge"
        : "Modrinth",
    description: hit.description ?? "",
    tags: hit.categories ?? [],
    logoUrl: hit.iconUrl,
    downloadCount: hit.downloads ?? 0,
    modLoaders: [],
    drops: hit.versions ?? [],
  };
}

const NAME_SEPARATORS = / \| | - |\(|\)|\[|\]|\{|\}/;

const LOADER_WORDS = ["neoforge", "forge", "fabric", "quilt"] as const;

function hasLoaderWord(value: string): boolean {
  const lower = value.toLowerCase();
  return LOADER_WORDS.some((word) => lower.includes(word));
}

function withoutLoaderWords(value: string): string {
  let result = value.toLowerCase();
  for (const word of LOADER_WORDS) result = result.split(word).join("");
  return result;
}

function splitName(value: string, trimChars: " /\\" | " /"): string[] {
  return value
    .split(NAME_SEPARATORS)
    .map((part) => {
      let text = part;
      if (trimChars === " /\\") {
        text = text.replace(/^[ /\\]+|[ /\\]+$/g, "");
      } else {
        text = text.replace(/^[ /]+|[ /]+$/g, "");
      }
      return text;
    })
    .filter((part) => part.length > 0);
}

function beforeFirst(value: string, marker: string): string {
  const index = value.indexOf(marker);
  return index < 0 ? value : value.slice(0, index);
}

function beforeLast(value: string, marker: string): string {
  const index = value.lastIndexOf(marker);
  return index < 0 ? value : value.slice(0, index);
}

function afterLast(value: string, marker: string): string {
  const index = value.lastIndexOf(marker);
  return index < 0 ? "" : value.slice(index + marker.length);
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/** PCL2 `ResourceProject.GetControlTitle`. */
export function getControlTitle(
  project: ResourceProject,
  hasModLoaderDescription = true,
): ControlTitle {
  let title = project.rawName;
  let subtitleList: string[] = [];

  if (project.translatedName === project.rawName) {
    // No Chinese translation: split the name, pull abbreviations and
    // Forge/Fabric edition markers into the subtitle.
    const nameLists = splitName(project.translatedName, " /\\");
    if (nameLists.length <= 1) return { Title: title, SubTitle: "" };

    const normalNameList: string[] = [];
    for (const name of nameLists) {
      const lower = name.toLowerCase();
      const isAbbreviation =
        name === name.toUpperCase() && name !== "FPS" && name !== "HUD";
      const isEditionMarker =
        hasLoaderWord(lower) && !/[a-z]+/.test(withoutLoaderWords(lower));
      if (isAbbreviation || isEditionMarker) subtitleList.push(name);
      else normalNameList.push(name);
    }

    if (normalNameList.length === 0 || subtitleList.length === 0) {
      return { Title: title, SubTitle: "" };
    }
    title = normalNameList.join(" - ");
  } else {
    // "中文名 (EnglishName) - Suffix": Chinese name becomes the title, the
    // parenthesised original name becomes the subtitle.
    title = project.translatedName.includes(" (")
      ? beforeFirst(project.translatedName, " (")
      : beforeLast(project.translatedName, " - ");

    const tail = afterLast(project.translatedName, ")");
    const suffix = tail.includes(" - ") ? afterLast(tail, " - ") : "";

    let englishName = project.translatedName;
    if (suffix !== "") englishName = englishName.replace(` - ${suffix}`, "");
    englishName = englishName
      .split(title)
      .join("")
      .replace(/^[() ]+|[() ]+$/g, "");

    subtitleList = splitName(englishName, " /");
    const noLoaderHints = !subtitleList.some((part) =>
      hasLoaderWord(part.toLowerCase()),
    );
    const isAbbreviationPair =
      subtitleList.length === 2 &&
      subtitleList[subtitleList.length - 1] ===
        subtitleList[subtitleList.length - 1].toUpperCase();
    if (subtitleList.length > 1 && noLoaderHints && !isAbbreviationPair) {
      subtitleList = [englishName];
    }
    if (suffix !== "") subtitleList.push(suffix);
    subtitleList = Array.from(new Set(subtitleList));
  }

  let subTitle = "";
  for (let entry of subtitleList) {
    const isModLoaderDescription = hasLoaderWord(entry.toLowerCase());
    if (!hasModLoaderDescription && isModLoaderDescription) continue;
    if (
      entry.length < 16 &&
      entry.toLowerCase().includes("fabric") &&
      entry.toLowerCase().includes("forge")
    ) {
      continue;
    }
    if (
      isModLoaderDescription &&
      !entry.includes("版") &&
      withoutLoaderWords(entry).length <= 3
    ) {
      entry =
        capitalize(entry.replace(/Edition/g, "").replace(/edition/g, "").trim()) +
        " 版";
    }
    entry = entry
      .replace(/neoforge/gi, "NeoForge")
      .replace(/forge/gi, "Forge")
      .replace(/neo/gi, "Neo")
      .replace(/fabric/gi, "Fabric")
      .replace(/quilt/gi, "Quilt");
    subTitle += ` | ${entry.trim()}`;
  }

  return { Title: title, SubTitle: subTitle };
}

/** Strip the PCL2 leading pipe so the subtitle reads naturally in HTML. */
export function subTitleText(subTitle: string): string {
  return subTitle.replace(/^\s*\|\s*/, "").trim();
}

/**
 * PCL2 `ResourceProject.Tags`: CurseForge numeric category ids and Modrinth
 * category slugs are both converted to their Chinese display labels.
 */
export const RESOURCE_TAG_LABELS: Record<string, string> = {
  // CurseForge: Mod
  "406": "世界元素", "407": "生物群系", "410": "维度", "408": "矿物/资源",
  "409": "天然结构", "412": "科技", "415": "管道/物流", "4843": "自动化",
  "417": "能源", "4558": "红石", "436": "食物/烹饪", "416": "农业",
  "414": "运输", "420": "仓储", "419": "魔法", "422": "冒险",
  "424": "装饰", "411": "生物", "434": "装备", "6814": "性能优化",
  "9026": "创造模式", "423": "信息显示", "435": "服务器", "5191": "改良",
  "421": "支持库",
  // CurseForge: ModPack
  "4484": "多人", "4479": "硬核", "4483": "战斗", "4478": "任务",
  "4472": "科技", "4473": "魔法", "4475": "冒险", "4476": "探索",
  "4477": "小游戏", "4474": "科幻", "4736": "空岛", "5128": "原版改良",
  "4487": "FTB", "4480": "基于地图", "4481": "轻量", "4482": "大型",
  // CurseForge: ResourcePack / Shader / DataPack
  "403": "原版风", "400": "写实风", "401": "现代风", "402": "中世纪",
  "399": "蒸汽朋克", "5244": "含字体", "404": "动态效果", "4465": "兼容 Mod",
  "393": "16x", "394": "32x", "395": "64x", "396": "128x", "397": "256x",
  "398": "超高清", "5193": "数据包", "6553": "写实风", "6554": "幻想风",
  "6555": "原版风", "6948": "冒险", "6949": "幻想", "6950": "支持库",
  "6952": "魔法", "6946": "Mod 相关", "6951": "科技", "6953": "实用",
  // Modrinth category slugs
  technology: "科技", magic: "魔法", adventure: "冒险", utility: "实用",
  optimization: "性能优化", "vanilla-like": "原版风", realistic: "写实风",
  worldgen: "世界元素", food: "食物/烹饪", "game-mechanics": "游戏机制",
  transportation: "运输", storage: "仓储", decoration: "装饰", mobs: "生物",
  equipment: "装备", social: "服务器", library: "支持库", multiplayer: "多人",
  challenging: "硬核", combat: "战斗", quests: "任务",
  "kitchen-sink": "水槽包", lightweight: "轻量", simplistic: "简洁",
  tweaks: "改良", "8x-": "极简", "16x": "16x", "32x": "32x", "48x": "48x",
  "64x": "64x", "128x": "128x", "256x": "256x", "512x+": "超高清",
  audio: "含声音", fonts: "含字体", models: "含模型", gui: "含 UI",
  locale: "含语言", "core-shaders": "核心着色器", modded: "兼容 Mod",
  fantasy: "幻想风", "semi-realistic": "半写实风", cartoon: "卡通风",
  "colored-lighting": "彩色光照", "path-tracing": "路径追踪",
  pbr: "PBR", reflections: "反射", iris: "Iris", optifine: "OptiFine",
  vanilla: "原版可用", datapack: "数据包",
};

export function translateResourceTag(tag: string): string {
  return RESOURCE_TAG_LABELS[tag] ?? tag;
}

/** PCL2 `MyResourceItem.Tags` display order: filter, localize, dedupe, cap. */
export function toDisplayTags(
  hit: ContentHit,
  projectType: string,
  max = 3,
  translateTags = true,
): string[] {
  const tags: string[] = [];
  for (const category of hit.categories ?? []) {
    if (category === "bedrock" || category === "基岩版") continue;
    if (projectType === "world" && (category === "world" || category === "地图")) {
      continue;
    }
    const label = translateTags ? translateResourceTag(category) : category;
    if (label && !tags.includes(label)) tags.push(label);
    if (tags.length >= max) break;
  }
  return tags;
}

/** PCL2 `ResourceProject.IsLike`, reduced to fields present in `ContentHit`. */
export function isLike(a: ContentHit, b: ContentHit): boolean {
  if (a.projectId === b.projectId) return true;
  const alnum = (value: string) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    a.title === b.title ||
    alnum(a.slug) === alnum(b.slug) ||
    (a.description.length > 0 && a.description === b.description)
  );
}

/** PCL2 `ResourceSearcher` cross-source deduplication. */
export function dedupeResults(hits: ContentHit[]): ContentHit[] {
  const results: ContentHit[] = [];
  for (const hit of hits) {
    if (!results.some((existing) => isLike(existing, hit))) results.push(hit);
  }
  return results;
}
