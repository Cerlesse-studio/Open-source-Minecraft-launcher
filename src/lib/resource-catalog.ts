/**
 * PCL2 `ResourceTypes` / `PageResource` catalog layer.
 *
 * PCL2 defines its six community-resource types in `PageDownloadLeft.xaml`
 * (原版游戏 / Mod / 整合包 / 数据包 / 资源包 / 光影包) and keeps the readable
 * type name on `PageResource.TypeName` / `PageResource.TypeNameSpaced`:
 *
 *   Loader.Name      = $"社区资源获取：{TypeName}"
 *   PanAlways.Title  = $"搜索{TypeNameSpaced}"
 *   Load.Text        = $"正在获取{TypeNameSpaced}列表"
 *
 * English names get a space on both sides in `TypeNameSpaced` (" Mod "),
 * Chinese names do not ("整合包"). This module is the single source of truth
 * for those names, the category metadata and the icons. The visible tab
 * labels (`label`) are deliberately kept byte-for-byte identical to the
 * pre-refactor UI so user-visible behaviour does not change.
 */
import {
  Archive,
  Cpu,
  FlaskConical,
  Layers3,
  Map as MapIcon,
  Package,
  Sparkles,
} from "lucide-react";
import type { ContentProjectType } from "./types";

/** `versions` is the launcher's built-in core page, not a PCL2 resource type. */
export type CatalogCategory = "versions" | ContentProjectType;

export type CategoryIcon = typeof Package;

/** PCL2 `ResourcePlatforms` flag names. Kept as metadata; requests are unchanged. */
export const RESOURCE_PLATFORMS = {
  CurseForge: "CurseForge",
  Modrinth: "Modrinth",
  Any: "Any",
} as const;

export interface ResourceCategory {
  /** Existing wire/persisted id — never renamed. */
  id: CatalogCategory;
  /** PCL2 `ResourceTypes` member name (`Any` for the core page). */
  pclType: "Any" | "Mod" | "ModPack" | "DataPack" | "ResourcePack" | "Shader" | "World";
  /** PCL2 `PageDownloadLeft` label; reference only, not rendered. */
  pclLabel: string;
  projectType: ContentProjectType | null;
  label: string;
  desc: string;
  icon: CategoryIcon;
  /** PCL2 `PageResource.TypeName`: no padding around English words. */
  typeName: string;
  /** PCL2 `PageResource.TypeNameSpaced`: one space around English words. */
  typeNameSpaced: string;
  /** Modrinth `project_type` facet value. */
  modrinthProjectType: string | null;
  /**
   * PCL2 `ResourceSearcher.GetCurseForgeAddress` classId for Java catalogues.
   * Metadata only: this launcher's Bedrock CurseForge calls still use the
   * 6929/4984 classIds in `bedrock_store.rs`.
   */
  pclCurseForgeClassId: number | null;
  /** Install directory, kept in sync with `content.rs::install_dir`. */
  targetDir: string | null;
  /** Search box hint, verbatim from the pre-refactor UI. */
  searchHint: string;
}

/** Order is the tab order and must not change. */
export const RESOURCE_CATEGORIES: readonly ResourceCategory[] = [
  {
    id: "versions",
    pclType: "Any",
    pclLabel: "原版游戏",
    projectType: null,
    label: "游戏版本",
    desc: "Java 与基岩版核心",
    icon: Package,
    typeName: "游戏版本",
    typeNameSpaced: "游戏版本",
    modrinthProjectType: null,
    pclCurseForgeClassId: null,
    targetDir: null,
    searchHint: "搜索游戏版本…",
  },
  {
    id: "world",
    pclType: "World",
    pclLabel: "地图",
    projectType: "world",
    label: "地图",
    desc: "Java 存档与冒险地图",
    icon: MapIcon,
    typeName: "地图",
    typeNameSpaced: "地图",
    modrinthProjectType: null,
    pclCurseForgeClassId: 17,
    targetDir: "saves/<地图名>",
    searchHint: "",
  },
  {
    id: "resourcepack",
    pclType: "ResourcePack",
    pclLabel: "资源包",
    projectType: "resourcepack",
    label: "材质与资源包",
    desc: "基岩版与 Java 材质包",
    icon: Sparkles,
    typeName: "资源包",
    typeNameSpaced: "资源包",
    modrinthProjectType: "resourcepack",
    pclCurseForgeClassId: 12,
    targetDir: "resourcepacks/",
    searchHint: "在 Modrinth 搜索资源包 (支持中文，如 材质/卡通)…",
  },
  {
    id: "shader",
    pclType: "Shader",
    pclLabel: "光影包",
    projectType: "shader",
    label: "光影包",
    desc: "Java 光影与基岩版 RTX/PBR",
    icon: FlaskConical,
    typeName: "光影包",
    typeNameSpaced: "光影包",
    modrinthProjectType: "shader",
    pclCurseForgeClassId: 6552,
    targetDir: "shaderpacks/",
    searchHint: "在 Modrinth 搜索光影包 (Complementary、BSL，支持中文，如 光影)…",
  },
  {
    id: "mod",
    pclType: "Mod",
    pclLabel: "Mod",
    projectType: "mod",
    label: "模组 (Mods)",
    desc: "Java 模组与基岩版行为包",
    icon: Layers3,
    // PCL2: `TypeName="Mod"` / `TypeNameSpaced=" Mod "`.
    typeName: "Mod",
    typeNameSpaced: " Mod ",
    modrinthProjectType: "mod",
    pclCurseForgeClassId: 6,
    targetDir: "versions/<对应版本>/mods",
    searchHint: "在 Modrinth 搜索模组 (JEI、Sodium，支持中文，如 钠/机械动力)…",
  },
  {
    id: "datapack",
    pclType: "DataPack",
    pclLabel: "数据包",
    projectType: "datapack",
    label: "数据包",
    desc: "原版世界与规则",
    icon: Cpu,
    typeName: "数据包",
    typeNameSpaced: "数据包",
    modrinthProjectType: "datapack",
    pclCurseForgeClassId: 6945,
    targetDir: "datapacks/",
    searchHint: "在 Modrinth 搜索数据包 (Terralith、Incendium，支持中文)…",
  },
  {
    id: "modpack",
    pclType: "ModPack",
    pclLabel: "整合包",
    projectType: "modpack",
    label: "整合包",
    desc: "精选整合包",
    icon: Archive,
    typeName: "整合包",
    typeNameSpaced: "整合包",
    modrinthProjectType: "modpack",
    pclCurseForgeClassId: 4471,
    targetDir: "modpacks/",
    searchHint: "在 Modrinth 搜索整合包 (支持中文，如 空岛/科技)…",
  },
];

/** PCL2 `PageResource.PAGE_SIZE` — kept at 20 so paging behaviour is unchanged. */
export const PAGE_SIZE = 20;

const BY_ID = new Map<CatalogCategory, ResourceCategory>(
  RESOURCE_CATEGORIES.map((category) => [category.id, category]),
);

const FALLBACK = RESOURCE_CATEGORIES[0];

export function getResourceCategory(id: CatalogCategory): ResourceCategory {
  return BY_ID.get(id) ?? FALLBACK;
}

/** PCL2 `PageResource.TypeName`. */
export function getTypeName(id: CatalogCategory): string {
  return getResourceCategory(id).typeName;
}

/** PCL2 `PageResource.TypeNameSpaced`. */
export function getTypeNameSpaced(id: CatalogCategory): string {
  return getResourceCategory(id).typeNameSpaced;
}

/** PCL2 `Loader.Name = $"社区资源获取：{TypeName}"`. */
export function getLoaderName(id: CatalogCategory): string {
  return `社区资源获取：${getTypeName(id)}`;
}

/** PCL2 `PanAlways.Title = $"搜索{TypeNameSpaced}"`. */
export function getSearchTitle(id: CatalogCategory): string {
  return `搜索${getTypeNameSpaced(id)}`;
}

/** PCL2 `Load.Text = $"正在获取{TypeNameSpaced}列表"`. */
export function getLoadingText(id: CatalogCategory): string {
  return `正在获取${getTypeNameSpaced(id)}列表`;
}

/**
 * PCL2's readable type name for badges and progress captions. The tab strip
 * keeps its product copy (`label`) so its visible text does not change; every
 * other place that used to hard-code its own wording now shares this one.
 */
export function getCategoryLabel(id: CatalogCategory): string {
  return getResourceCategory(id).pclLabel;
}

/** For wire payloads typed as plain `string` (e.g. progress events). */
export function getCategoryLabelForWireValue(
  value: string,
  fallback = "组件",
): string {
  return BY_ID.get(value as CatalogCategory)?.pclLabel ?? fallback;
}

/** Visible tab copy, kept byte-for-byte identical to the pre-refactor UI. */
export function getTabLabel(id: CatalogCategory): string {
  return getResourceCategory(id).label;
}

export function getCategoryDesc(id: CatalogCategory): string {
  return getResourceCategory(id).desc;
}

export function getTargetDir(id: CatalogCategory): string | null {
  return getResourceCategory(id).targetDir;
}

export function getCategoryIcon(id: CatalogCategory): CategoryIcon {
  return getResourceCategory(id).icon;
}

/** Single icon table shared by the tabs and `ContentIcon`. */
export const CONTENT_TYPE_ICONS: Record<ContentProjectType, CategoryIcon> =
  Object.fromEntries(
    RESOURCE_CATEGORIES.filter(
      (category): category is ResourceCategory & { projectType: ContentProjectType } =>
        category.projectType !== null,
    ).map((category) => [category.projectType, category.icon]),
  ) as Record<ContentProjectType, CategoryIcon>;

export interface SearchPlaceholderContext {
  isWorldSource: boolean;
  isBedrockWorld: boolean;
  isBedrockSource: boolean;
}

/**
 * Verbatim placeholder strings from `ContentMarketplaceView`, now driven by
 * the catalog instead of a nested ternary over `projectType`.
 */
export function getSearchPlaceholder(
  id: CatalogCategory,
  context: SearchPlaceholderContext,
): string {
  if (context.isWorldSource) {
    return context.isBedrockWorld
      ? "在 CurseForge 搜索基岩版地图 (支持中文，如 空岛/跑酷/生存)…"
      : "在 CurseForge 搜索 Java 地图 (支持中文，如 空岛/跑酷/生存)…";
  }
  if (context.isBedrockSource) {
    return "在 CurseForge 搜索基岩版附加包 (支持中文，如 家具/枪械/空岛)…";
  }
  return getResourceCategory(id).searchHint;
}
