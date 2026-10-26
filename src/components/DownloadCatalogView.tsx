import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowRight,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  ExternalLink,
  FlaskConical,
  Globe,
  HardDriveDownload,
  Layers3,
  LoaderCircle,
  Package,
  PackageOpen,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "cn";
import {
  formatBytes,
  formatDate,
  formatSpeed,
  progressPercent,
  stageLabel,
  typeLabel,
  typeTone,
} from "../lib/format";
import {
  autoFixBedrockBootDependencies,
  deleteBedrockVersion,
  deleteVersion,
  getBedrockStatus,
  getBedrockVersions,
  getBetacraftManifest,
  installBedrockVersion,
  launchBedrock,
} from "../lib/backend";
import { ContentMarketplaceView } from "./ContentMarketplaceView";
import { BedrockModLoaderModal } from "./BedrockModLoaderModal";
import type {
  BedrockStatus,
  BedrockVersionItem,
  ContentProjectType,
  InstallProgress,
  InstalledVersion,
  VersionManifest,
  VersionSummary,
} from "../lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader, ProgressBar, StatusDot, TypeBadge } from "./ui";

type Filter = "all" | "release" | "snapshot" | "april_fools" | "legacy" | "bedrock";
type GroupId = "release" | "snapshot" | "april_fools" | "legacy" | "bedrock";

const FILTERS: Array<{
  id: Filter;
  label: string;
  icon: typeof Layers3;
  imageSrc?: string;
}> = [
  { id: "all", label: "全部可下载", icon: Layers3, imageSrc: "/icons/minecraft/compass.png" },
  { id: "release", label: "Java 正式版", icon: Package, imageSrc: "/icons/minecraft/grass_block.png" },
  { id: "snapshot", label: "Java 快照", icon: FlaskConical, imageSrc: "/icons/minecraft/command_block.png" },
  { id: "april_fools", label: "愚人节限定", icon: Sparkles, imageSrc: "/icons/minecraft/poisonous_potato.png" },
  { id: "legacy", label: "远古版本档案", icon: Archive, imageSrc: "/icons/minecraft/cobblestone.png" },
  { id: "bedrock", label: "基岩版核心", icon: Boxes, imageSrc: "/icons/minecraft/bedrock.png" },
];

export interface AprilFoolsMeta {
  year: number;
  titleZh: string;
  subtitle: string;
  highlights: string[];
  tag: string;
}

export const APRIL_FOOLS_REGISTRY: Record<string, AprilFoolsMeta> = {
  "24w14potato": {
    year: 2024,
    titleZh: "毒马铃薯更新 (The Poisonous Potato Update)",
    subtitle: "毒马铃薯专属维度、马铃薯权杖、飞天爪钩、炼药战车与五大马铃薯 Boss",
    highlights: ["马铃薯传送门", "毒马铃薯维度", "爪钩物理", "五大专属 Boss"],
    tag: "最新脑洞神作",
  },
  "23w13a_or_b": {
    year: 2023,
    titleZh: "投票更新 (The Vote Update)",
    subtitle: "全员提案公投改变游戏底层规则、重力反转、月球维度、变身为任意生物",
    highlights: ["全民提案公投", "月球低重力", "变形方块与实体", "颠倒世界"],
    tag: "规则修改器",
  },
  "22w13oneblockatatime": {
    year: 2022,
    titleZh: "一次一个方块 (One Block at a Time)",
    subtitle: "彻底移除物品栏与背包，玩家双手捧起方块放置，能徒手举起末影龙丢出去",
    highlights: ["无背包机制", "双手捧方块", "手抛末影龙", "推箱子物理"],
    tag: "硬核脑洞",
  },
  "20w14infinite": {
    year: 2020,
    titleZh: "无尽世界 / 终极内容更新 (Ultimate Content Update)",
    subtitle: "写下文字的书扔入下界传送门，即可生成 21.4 亿个独一无二的随机神秘维度",
    highlights: ["21.4 亿随机维度", "传送门写书", "色彩海洋", "无尽世界群系"],
    tag: "传世神作",
  },
  "3D Shareware v1.34": {
    year: 2019,
    titleZh: "3D 软盘共享版 (3D Shareware v1.34)",
    subtitle: "致敬 90 年代 MS-DOS 经典！全屏复古扫描线、像素血条与毁灭战士音效",
    highlights: ["MS-DOS 画风", "复古 CRT 扫描线", "按级解密", "经典音效"],
    tag: "复古 90 年代",
  },
  "1.RV-Pre1": {
    year: 2016,
    titleZh: "潮流科技更新 (Trendy Update)",
    subtitle: "加入 USB 充电电缆、VR 虚拟现实护目镜、智能手表与踝部显示器",
    highlights: ["USB 数据线", "智能眼镜", "VR 护目镜", "智能脚环"],
    tag: "数码潮流",
  },
  "15w14a": {
    year: 2015,
    titleZh: "爱与拥抱更新 (The Love and Hugs Update)",
    subtitle: "移除所有伤害机制，伤害变成治愈爱心，爱心进度槽与黑曜石爱心小艇",
    highlights: ["充满爱心雨", "无伤治愈世界", "黑曜石小艇", "爱心指示器"],
    tag: "充满爱心",
  },
};

export const APRIL_FOOLS_FALLBACK_VERSIONS: VersionSummary[] = [
  {
    id: "24w14potato",
    type: "snapshot",
    url: "https://piston-meta.mojang.com/v1/packages/e17ba5ae44e2665a2f2c1d40f520b34ce11a1057/24w14potato.json",
    time: "2024-04-01T11:07:19+00:00",
    releaseTime: "2024-04-01T11:07:19+00:00",
    sha1: "e17ba5ae44e2665a2f2c1d40f520b34ce11a1057",
  },
  {
    id: "23w13a_or_b",
    type: "snapshot",
    url: "https://piston-meta.mojang.com/v1/packages/6d9b7b1f3fa890704ec5d3d4bfb0145f44437b22/23w13a_or_b.json",
    time: "2023-04-01T12:52:18+00:00",
    releaseTime: "2023-04-01T12:52:18+00:00",
    sha1: "6d9b7b1f3fa890704ec5d3d4bfb0145f44437b22",
  },
  {
    id: "22w13oneblockatatime",
    type: "snapshot",
    url: "https://piston-meta.mojang.com/v1/packages/d70cef49b7606e8c37e49abad4ff542e2ce21d09/22w13oneblockatatime.json",
    time: "2022-04-01T11:56:58+00:00",
    releaseTime: "2022-04-01T11:56:58+00:00",
    sha1: "d70cef49b7606e8c37e49abad4ff542e2ce21d09",
  },
  {
    id: "20w14infinite",
    type: "snapshot",
    url: "https://piston-meta.mojang.com/v1/packages/73eb2a736f0a7349fb5f73e685f847826e5321fd/20w14infinite.json",
    time: "2020-04-01T12:47:08+00:00",
    releaseTime: "2020-04-01T12:47:08+00:00",
    sha1: "73eb2a736f0a7349fb5f73e685f847826e5321fd",
  },
  {
    id: "3D Shareware v1.34",
    type: "snapshot",
    url: "https://piston-meta.mojang.com/v1/packages/5b59564acaa4cc153b6f934e566226642ed978ab/3D%20Shareware%20v1.34.json",
    time: "2019-04-01T11:18:08+00:00",
    releaseTime: "2019-04-01T11:18:08+00:00",
    sha1: "5b59564acaa4cc153b6f934e566226642ed978ab",
  },
  {
    id: "1.RV-Pre1",
    type: "snapshot",
    url: "https://piston-meta.mojang.com/v1/packages/23761c1cc8b5c7c72f6604e1e7322a056a6af2f8/1.RV-Pre1.json",
    time: "2016-03-31T16:18:53+00:00",
    releaseTime: "2016-03-31T16:18:53+00:00",
    sha1: "23761c1cc8b5c7c72f6604e1e7322a056a6af2f8",
  },
  {
    id: "15w14a",
    type: "snapshot",
    url: "https://piston-meta.mojang.com/v1/packages/e9349d236c0f4b8760f75621b3eaad538055c759/15w14a.json",
    time: "2015-04-01T07:08:00+00:00",
    releaseTime: "2015-04-01T07:08:00+00:00",
    sha1: "e9349d236c0f4b8760f75621b3eaad538055c759",
  },
];

const GROUP_META: Record<
  GroupId,
  { title: string; description: string; icon: typeof Layers3; imageSrc: string }
> = {
  release: {
    title: "Java 正式版",
    description: "稳定版本，适合日常游玩",
    icon: Package,
    imageSrc: "/icons/minecraft/grass_block.png",
  },
  snapshot: {
    title: "Java 快照",
    description: "抢先体验开发中的新内容",
    icon: FlaskConical,
    imageSrc: "/icons/minecraft/command_block.png",
  },
  april_fools: {
    title: "愚人节特别版 (April Fools' Updates)",
    description: "Mojang 历年愚人节脑洞神作：毒马铃薯维度、21.4亿随机维度、一次一个方块、3D软盘共享版等",
    icon: Sparkles,
    imageSrc: "/icons/minecraft/poisonous_potato.png",
  },
  legacy: {
    title: "BetaCraft 远古版本档案库",
    description: "files.betacraft.uk · 汇集 290+ 远古历史版本（Classic, Indev, Infdev, Alpha, Beta），修复现代系统声音缺失与皮肤黑屏",
    icon: Archive,
    imageSrc: "/icons/minecraft/cobblestone.png",
  },
  bedrock: {
    title: "基岩版 (Bedrock Edition)",
    description: "官方独立服务端核心、正式版与 Windows Store 渠道",
    icon: Boxes,
    imageSrc: "/icons/minecraft/bedrock.png",
  },
};

interface DownloadCatalogViewProps {
  manifest: VersionManifest | null;
  installed: InstalledVersion[];
  selectedVersion: string;
  gameRoot: string;
  installingVersion: string | null;
  installProgress: InstallProgress | null;
  lastProgress: InstallProgress | null;
  downloadThreads: number;
  loading: boolean;
  error: string | null;
  onSelectVersion: (version: VersionSummary) => void;
  onOpenProgress: () => void;
  onOpenVersionSelect: () => void;
  onOpenFolder: (path: string) => void;
  onRefresh: () => void;
  onDeleteVersion?: (versionId: string, edition: "java" | "bedrock") => Promise<void> | void;
  onInstallBedrock?: (ver: BedrockVersionItem, apiSource?: string) => Promise<void>;
  onNotify: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
}

type CatalogCategory =
  | "versions"
  | "resourcepack"
  | "shader"
  | "mod"
  | "datapack"
  | "modpack";

const CATALOG_CATEGORIES: Array<{
  id: CatalogCategory;
  label: string;
  icon: typeof Package;
  desc: string;
}> = [
  { id: "versions", label: "游戏版本", icon: Package, desc: "Java 与基岩版核心" },
  { id: "resourcepack", label: "材质与资源包", icon: Sparkles, desc: "基岩版与 Java 材质包" },
  { id: "shader", label: "光影包", icon: FlaskConical, desc: "Java 光影与基岩版 RTX/PBR" },
  { id: "mod", label: "模组 (Mods)", icon: Layers3, desc: "Java 模组与基岩版行为包" },
  { id: "datapack", label: "数据包", icon: Cpu, desc: "原版世界与规则" },
  { id: "modpack", label: "整合包", icon: Archive, desc: "精选整合包" },
];

function VersionGlyph({ type, source }: { type: string; source?: string }) {
  let iconSrc = "/icons/minecraft/grass_block.png";
  let borderClass = "border-primary/25 bg-primary/10";
  let altText = "Java 正式版";

  if (type === "bedrock") {
    iconSrc = "/icons/minecraft/bedrock.png";
    borderClass = "border-emerald-500/30 bg-emerald-500/10";
    altText = "基岩版";
  } else if (type === "april_fools") {
    iconSrc = "/icons/minecraft/poisonous_potato.png";
    borderClass = "border-purple-500/35 bg-purple-500/15";
    altText = "愚人节限定";
  } else if (type === "snapshot") {
    iconSrc = "/icons/minecraft/command_block.png";
    borderClass = "border-gold/30 bg-gold/10";
    altText = "开发快照";
  } else if (type === "old_beta" || type === "old_alpha" || type === "legacy" || type === "betacraft" || source === "betacraft") {
    iconSrc = "/icons/minecraft/cobblestone.png";
    borderClass = "border-amber-500/30 bg-amber-500/10";
    altText = "远古版本";
  }

  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border p-1 shadow-2xs transition-transform group-hover:scale-105",
        borderClass,
      )}
    >
      <img
        src={iconSrc}
        alt={altText}
        className="size-6 object-contain drop-shadow-xs [image-rendering:pixelated]"
        loading="lazy"
      />
    </span>
  );
}

let globalBedrockVersionsCache: BedrockVersionItem[] | null = null;
let globalBedrockStatusCache: BedrockStatus | null = null;

export function DownloadCatalogView({
  manifest,
  installed,
  selectedVersion,
  gameRoot,
  installingVersion,
  installProgress,
  lastProgress,
  downloadThreads,
  loading,
  error,
  onSelectVersion,
  onOpenProgress,
  onOpenVersionSelect,
  onOpenFolder,
  onRefresh,
  onDeleteVersion,
  onInstallBedrock,
  onNotify,
}: DownloadCatalogViewProps) {
  const [activeCategory, setActiveCategory] = useState<CatalogCategory>("versions");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [deletingItem, setDeletingItem] = useState<{ id: string; name: string; edition: "java" | "bedrock" } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<GroupId, boolean>>({
    release: true,
    snapshot: false,
    april_fools: true,
    legacy: false,
    bedrock: true,
  });
  const [limits, setLimits] = useState<Record<GroupId, number>>({
    release: 10,
    snapshot: 6,
    april_fools: 15,
    legacy: 15,
    bedrock: 25,
  });

  const [betacraftManifest, setBetacraftManifest] = useState<VersionManifest | null>(null);
  const [betacraftLoading, setBetacraftLoading] = useState(false);
  const [betacraftPhaseFilter, setBetacraftPhaseFilter] = useState<string>("all");
  const [legacySource, setLegacySource] = useState<"all" | "betacraft" | "mojang">("all");

  const loadBetacraft = async (force = false) => {
    setBetacraftLoading(true);
    try {
      const bm = await getBetacraftManifest(gameRoot, force);
      setBetacraftManifest(bm);
    } catch {
      // ignore
    } finally {
      setBetacraftLoading(false);
    }
  };

  useEffect(() => {
    void loadBetacraft();
  }, [gameRoot]);

  const [bedrockVersions, setBedrockVersions] = useState<BedrockVersionItem[]>(
    () => globalBedrockVersionsCache ?? [],
  );
  const [bedrockTypeFilter, setBedrockTypeFilter] = useState<"all" | "release" | "preview">("all");
  const [bedrockStatus, setBedrockStatus] = useState<BedrockStatus | null>(
    () => globalBedrockStatusCache,
  );
  const [installingBedrockId, setInstallingBedrockId] = useState<string | null>(null);
  const [bedrockApiSource, setBedrockApiSource] = useState<
    "mcappx" | "bedrockboot_gitee" | "bmcbl" | "endstone" | "azure_mirror"
  >("mcappx");
  const [bedrockLoading, setBedrockLoading] = useState(
    () => !globalBedrockVersionsCache || globalBedrockVersionsCache.length === 0,
  );
  const [bedrockLoaderModalVer, setBedrockLoaderModalVer] = useState<BedrockVersionItem | null>(null);

  const loadBedrock = async (source = bedrockApiSource, showSpinner = false) => {
    if (showSpinner || !globalBedrockVersionsCache || globalBedrockVersionsCache.length === 0) {
      setBedrockLoading(true);
    }
    try {
      const [v, s] = await Promise.all([
        getBedrockVersions(source),
        getBedrockStatus(gameRoot),
      ]);
      if (Array.isArray(v) && v.length > 0) {
        globalBedrockVersionsCache = v;
        setBedrockVersions(v);
      }
      if (s) {
        globalBedrockStatusCache = s;
        setBedrockStatus(s);
      }
    } catch {
      // ignore
    } finally {
      setBedrockLoading(false);
    }
  };

  useEffect(() => {
    void loadBedrock();
    const onFocus = () => void loadBedrock();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [gameRoot, bedrockApiSource]);

  const handleInstallBedrock = async (ver: BedrockVersionItem) => {
    if (onInstallBedrock) {
      onOpenProgress();
      await onInstallBedrock(ver, bedrockApiSource);
      await loadBedrock();
      return;
    }
    setInstallingBedrockId(ver.id);
    try {
      const res = await installBedrockVersion(ver.id, ver.downloadUrl, gameRoot, bedrockApiSource, downloadThreads);
      onNotify("success", `基岩版 ${ver.version} 安装成功`, res);
      await loadBedrock();
    } catch (e) {
      onNotify("error", `安装基岩版 ${ver.version} 失败`, String(e));
    } finally {
      setInstallingBedrockId(null);
    }
  };

  const handleLaunchBedrockInstance = async (versionId?: string) => {
    try {
      const res = await launchBedrock(versionId, gameRoot);
      onNotify("success", "已唤起 Minecraft 基岩版", res);
    } catch (e) {
      onNotify("error", "启动基岩版失败", String(e));
    }
  };

  const installedMap = useMemo(
    () => new Map(installed.map((version) => [version.id, version])),
    [installed],
  );

  const groups = useMemo<
    Array<{
      id: GroupId;
      items: VersionSummary[];
      bedrockItems?: BedrockVersionItem[];
    }>
  >(() => {
    const needle = query.trim().toLowerCase();
    const matches = (version: VersionSummary) =>
      !needle || version.id.toLowerCase().includes(needle);

    const all = (manifest?.versions ?? []).filter(matches);
    const filteredBedrock = bedrockVersions.filter(
      (v) =>
        !needle ||
        v.name.toLowerCase().includes(needle) ||
        v.version.toLowerCase().includes(needle),
    );

    const isAprilFools = (version: VersionSummary) => {
      const vid = version.id.toLowerCase();
      return (
        APRIL_FOOLS_REGISTRY[version.id] !== undefined ||
        vid.includes("potato") ||
        vid.includes("shareware") ||
        vid.includes("oneblock") ||
        vid.includes("infinite") ||
        vid === "23w13a_or_b" ||
        vid === "1.rv-pre1" ||
        vid === "15w14a"
      );
    };

    const aprilFoolsFromManifest = all.filter(isAprilFools);
    const manifestFoolsIds = new Set(aprilFoolsFromManifest.map((v) => v.id));
    const aprilFoolsItems = [
      ...aprilFoolsFromManifest,
      ...APRIL_FOOLS_FALLBACK_VERSIONS.filter(
        (fb) => !manifestFoolsIds.has(fb.id) && matches(fb),
      ),
    ];

    const allBetaCraft = (betacraftManifest?.versions ?? []).filter(matches);
    const mojangLegacy = all.filter(
      (version) =>
        version.type !== "release" &&
        version.type !== "snapshot" &&
        !isAprilFools(version),
    );

    let legacyItems: VersionSummary[] = [];
    if (legacySource === "mojang") {
      legacyItems = mojangLegacy;
    } else if (legacySource === "betacraft") {
      legacyItems = allBetaCraft;
    } else {
      const seen = new Set<string>();
      legacyItems = [];
      for (const v of allBetaCraft) {
        seen.add(v.id);
        legacyItems.push(v);
      }
      for (const v of mojangLegacy) {
        if (!seen.has(v.id)) {
          seen.add(v.id);
          legacyItems.push(v);
        }
      }
    }

    if (betacraftPhaseFilter !== "all") {
      legacyItems = legacyItems.filter((v) => {
        const ph = (v.phase || "").toLowerCase();
        if (ph) return ph === betacraftPhaseFilter.toLowerCase();
        const idLower = v.id.toLowerCase();
        if (betacraftPhaseFilter === "beta") return idLower.startsWith("b") || v.type === "old_beta";
        if (betacraftPhaseFilter === "alpha") return idLower.startsWith("a") || v.type === "old_alpha";
        if (betacraftPhaseFilter === "classic") return idLower.startsWith("c");
        if (betacraftPhaseFilter === "indev") return idLower.startsWith("in");
        if (betacraftPhaseFilter === "infdev") return idLower.startsWith("inf");
        if (betacraftPhaseFilter === "oddballs") return idLower.includes("rd") || idLower.includes("test");
        return true;
      });
    }

    return [
      { id: "release", items: all.filter((version) => version.type === "release") },
      {
        id: "snapshot",
        items: all.filter(
          (version) => version.type === "snapshot" && !isAprilFools(version),
        ),
      },
      {
        id: "april_fools",
        items: aprilFoolsItems,
      },
      {
        id: "legacy",
        items: legacyItems,
      },
      {
        id: "bedrock",
        items: [],
        bedrockItems: filteredBedrock,
      },
    ];
  }, [manifest, betacraftManifest, bedrockVersions, query, betacraftPhaseFilter, legacySource]);

  const counts = useMemo(() => {
    const byGroup = Object.fromEntries(
      groups.map((group) => [
        group.id,
        group.id === "bedrock"
          ? (group.bedrockItems?.length ?? 0)
          : group.items.length,
      ]),
    ) as Record<GroupId, number>;
    return {
      ...byGroup,
      all: groups.reduce(
        (total, group) =>
          total +
          (group.id === "bedrock"
            ? (group.bedrockItems?.length ?? 0)
            : group.items.length),
        0,
      ),
    };
  }, [groups]);

  const visibleGroups = groups.filter((group) => {
    if (filter === "all") {
      return (
        group.items.length > 0 || (group.bedrockItems && group.bedrockItems.length > 0)
      );
    }
    return group.id === filter;
  });

  const setFilterAndExpand = (next: Filter) => {
    setFilter(next);
    if (next !== "all") {
      setOpenGroups((current) => ({ ...current, [next]: true }));
    }
  };

  const isInstalling = (versionId: string) =>
    installingVersion === versionId && Boolean(installProgress);

  const activeBannerProgress = installProgress ?? lastProgress;
  const isCurrentlyDownloading = Boolean(installingVersion && installProgress);
  const bannerPercent = useMemo(() => {
    if (!activeBannerProgress) return 0;
    if (activeBannerProgress.stage === "done") return 100;
    const dl = activeBannerProgress.downloadedBytes ?? 0;
    const tot = activeBannerProgress.totalBytes ?? 0;
    if (tot > 0) {
      return Math.max(0, Math.min(100, Math.round((dl / tot) * 100)));
    }
    return progressPercent(activeBannerProgress.done, activeBannerProgress.total) ?? 0;
  }, [activeBannerProgress]);

  const renderActions = (version: VersionSummary) => {
    const local = installedMap.get(version.id);
    if (isInstalling(version.id) && installProgress) {
      return (
        <div
          className="flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onOpenProgress}
            title="点击查看下载进度页面"
            className="w-[150px] max-w-[36vw] rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/30"
          >
            <ProgressBar progress={installProgress} compact />
          </button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 border-gold/35 bg-gold/10 px-2 text-[10.5px] text-gold hover:bg-gold/15"
            onClick={onOpenProgress}
          >
            <Activity className="size-3" />
            进度
          </Button>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-2">
        {local ? (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[10.5px] text-primary hover:bg-primary/10 hover:text-primary"
              onClick={onOpenVersionSelect}
              title="查看本地已安装版本"
            >
              <Check className="size-3" />
              已安装
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
              onClick={() =>
                setDeletingItem({
                  id: version.id,
                  name: version.id,
                  edition: "java",
                })
              }
              title="删除此版本"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ) : null}
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground group-hover:text-foreground">
          <span>配置并安装</span>
          <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    );
  };

  const activeFilterLabel =
    FILTERS.find((entry) => entry.id === filter)?.label ?? "全部可下载";
  const activeCount = filter === "all" ? counts.all : counts[filter];
  const hasAnyResults = visibleGroups.some((group) =>
    group.id === "bedrock"
      ? (group.bedrockItems?.length ?? 0) > 0
      : group.items.length > 0,
  );

  return (
    <div className="space-y-5">
      {/* Category Tabs: 游戏版本 | 模组 | 整合包 | 光影包 | 数据包 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 pb-3">
        {CATALOG_CATEGORIES.map((cat) => {
          const Icon = cat.icon;
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              onClick={() => setActiveCategory(cat.id)}
              className={cn(
                "flex h-9 items-center gap-2 rounded-lg px-3.5 text-[12.5px] font-medium transition-colors",
                isActive
                  ? "border border-primary/35 bg-primary/10 text-primary shadow-sm"
                  : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
              )}
            >
              <Icon className={cn("size-3.5", isActive ? "text-primary" : "text-muted-foreground")} />
              <span>{cat.label}</span>
            </button>
          );
        })}
      </div>

      {activeCategory !== "versions" ? (
        <ContentMarketplaceView
          projectType={activeCategory as ContentProjectType}
          installed={installed}
          selectedVersion={selectedVersion}
          gameRoot={gameRoot}
          onOpenFolder={onOpenFolder}
          onNotify={onNotify}
        />
      ) : (
        <>
          <PageHeader
            title="版本下载"
            actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimits({ release: 10, snapshot: 6, april_fools: 15, legacy: 15, bedrock: 25 });
                }}
                placeholder="搜索版本号"
                aria-label="搜索版本号"
                spellCheck={false}
                className="h-8 w-[180px] border-border/80 bg-card/60 pl-8 pr-8 font-mono text-[11px]"
              />
              {query ? (
                <button
                  className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => setQuery("")}
                  aria-label="清除搜索"
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </div>

            <Button
              variant={isCurrentlyDownloading ? "default" : "outline"}
              size="sm"
              className={cn(
                "h-8 gap-1.5 px-3 text-[11.5px]",
                !isCurrentlyDownloading &&
                  "border-primary/35 bg-primary/10 text-primary hover:bg-primary/15",
              )}
              onClick={onOpenProgress}
            >
              {isCurrentlyDownloading ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <HardDriveDownload className="size-3.5" />
              )}
              下载进度
              {isCurrentlyDownloading ? (
                <span className="font-mono text-[10px]">({bannerPercent}%)</span>
              ) : null}
            </Button>

            <Button
              variant="outline"
              size="icon-sm"
              className="size-8 border-border/80 bg-card/60 text-muted-foreground"
              onClick={onRefresh}
              title="刷新版本清单"
              aria-label="刷新版本清单"
              disabled={loading}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        }
      />

      {/* Active / Recent Download Progress Entry Banner */}
      {isCurrentlyDownloading && installProgress ? (
        <Card className="gap-0 overflow-hidden border-gold/40 bg-gold/[0.05] py-0">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot tone="pending" animated />
                <span className="text-[12.5px] font-medium text-foreground">
                  正在多线程下载 Minecraft {installProgress.versionId}
                </span>
                <Badge
                  variant="outline"
                  className="h-4 border-gold/35 bg-gold/10 px-1.5 font-mono text-[9.5px] font-normal text-gold"
                >
                  {installProgress.activeThreads ?? downloadThreads} / {downloadThreads} 线程活跃
                </Badge>
                {installProgress.speedBps ? (
                  <span className="font-mono text-[11px] text-primary">
                    {formatSpeed(installProgress.speedBps)}
                  </span>
                ) : null}
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {stageLabel(installProgress.stage)} · {bannerPercent}%
                </span>
              </div>
              <Progress
                value={bannerPercent}
                className="h-1.5 rounded-sm bg-primary/15 [&_[data-slot=progress-indicator]]:rounded-sm"
              />
              <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                <span className="truncate">{installProgress.detail}</span>
                <span>
                  {formatBytes(installProgress.downloadedBytes ?? 0)} /{" "}
                  {formatBytes(installProgress.totalBytes ?? 0)}
                </span>
              </div>
            </div>
            <Button
              size="sm"
              className="h-9 shrink-0 gap-1.5 px-3.5 text-[11.5px]"
              onClick={onOpenProgress}
            >
              查看下载进度详情
              <ArrowRight className="size-3.5" />
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {error ? (
        <Alert variant="destructive" className="border-destructive/30 bg-destructive/5 py-3">
          <AlertTriangle />
          <AlertTitle>无法刷新版本清单</AlertTitle>
          <AlertDescription className="line-clamp-2">{error}</AlertDescription>
          <Button variant="outline" size="xs" className="mt-1 w-fit" onClick={onRefresh}>
            重试
          </Button>
        </Alert>
      ) : null}

      <div className="grid items-start gap-4 min-[1000px]:grid-cols-[196px_minmax(0,1fr)] min-[1240px]:grid-cols-[212px_minmax(0,1fr)]">
        <aside className="space-y-3 min-[1000px]:sticky min-[1000px]:top-0">
          <Card className="gap-0 border-border/70 bg-card/55 py-0">
            <CardHeader className="border-b border-border/60 px-4 py-3">
              <CardTitle className="flex items-center gap-2 text-[12px] font-medium">
                <Layers3 className="size-3.5 text-primary" />
                版本通道
              </CardTitle>
            </CardHeader>
            <CardContent className="p-1.5">
              <div className="flex flex-col gap-0.5" role="list">
                {FILTERS.map((item) => {
                  const Icon = item.icon;
                  const active = filter === item.id;
                  const count =
                    item.id === "all"
                      ? counts.all
                      : counts[item.id as GroupId] ?? 0;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFilterAndExpand(item.id)}
                      aria-pressed={active}
                      className={cn(
                        "flex h-8 items-center gap-2 rounded-md px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground",
                        active && "bg-accent/70 text-foreground",
                      )}
                    >
                      {item.imageSrc ? (
                        <img
                          src={item.imageSrc}
                          alt=""
                          className="size-3.5 shrink-0 object-contain [image-rendering:pixelated]"
                        />
                      ) : (
                        <Icon
                          className={cn(
                            "size-3.5",
                            active ? "text-primary" : "text-muted-foreground/70",
                          )}
                        />
                      )}
                      <span className="flex-1 text-left">{item.label}</span>
                      <span className="font-mono text-[9px] text-muted-foreground/70">
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <p className="flex items-start gap-1.5 px-1 text-[9.5px] leading-4 text-muted-foreground/65">
            <ShieldCheck className="mt-0.5 size-3 shrink-0" />
            来自 Mojang 官方服务器，客户端、依赖库与资源文件都会自动校验。
          </p>
        </aside>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[13px] font-medium">{activeFilterLabel}</h2>
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {activeCount} 个结果
              </span>
            </div>
            <span className="text-[10px] text-muted-foreground/60">
              最新正式版{" "}
              <span className="font-mono text-foreground/80">
                {manifest?.latest.release || "—"}
              </span>
            </span>
          </div>

          {loading && !manifest ? (
            <Card className="gap-0 border-border/70 bg-card/55 py-0">
              <div className="divide-y divide-border/40">
                {Array.from({ length: 7 }).map((_, index) => (
                  <div className="flex items-center gap-3 px-4 py-3.5" key={index}>
                    <Skeleton className="size-9 rounded-md" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-28" />
                      <Skeleton className="h-2.5 w-20" />
                    </div>
                    <Skeleton className="h-7 w-14" />
                  </div>
                ))}
              </div>
            </Card>
          ) : !loading && !hasAnyResults ? (
            <Card className="grid min-h-[320px] place-items-center border-border/70 bg-card/45 px-6 py-12 text-center">
              <div className="max-w-xs">
                <div className="mx-auto flex size-11 items-center justify-center rounded-lg border border-border/70 bg-muted/30">
                  <PackageOpen className="size-5 text-muted-foreground/60" />
                </div>
                <h3 className="mt-3 text-[13px] font-medium">
                  {query ? `没有找到包含“${query}”的版本` : "这个分类里还没有版本"}
                </h3>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {query
                    ? "换一个关键词，或清除搜索查看全部版本。"
                    : "刷新版本清单，或切换到其他分类。"}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => {
                    if (query) {
                      setQuery("");
                    } else {
                      setFilterAndExpand("release");
                    }
                  }}
                >
                  {query ? "清除搜索" : "浏览正式版"}
                </Button>
              </div>
            </Card>
          ) : (
            visibleGroups.map((group) => {
              const meta = GROUP_META[group.id];
              const Icon = meta.icon;
              const open =
                openGroups[group.id] ||
                Boolean(query.trim()) ||
                (filter !== "all" && filter === group.id);
              const visible = group.items.slice(0, limits[group.id]);
              return (
                <Card
                  key={group.id}
                  className="gap-0 overflow-hidden border-border/70 bg-card/55 py-0"
                >
                  <button
                    type="button"
                    className="flex w-full items-center gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-muted/20"
                    onClick={() =>
                      setOpenGroups((current) => ({
                        ...current,
                        [group.id]: !current[group.id],
                      }))
                    }
                    aria-expanded={open}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60 p-1">
                      {meta.imageSrc ? (
                        <img
                          src={meta.imageSrc}
                          alt=""
                          className="size-4.5 object-contain [image-rendering:pixelated]"
                        />
                      ) : (
                        <Icon className="size-3.5 text-primary" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[12.5px] font-medium">{meta.title}</span>
                        <Badge
                          variant="outline"
                          className="h-4 min-w-5 justify-center border-border/80 px-1 font-mono text-[9px] font-normal text-muted-foreground"
                        >
                          {group.id === "bedrock"
                            ? (group.bedrockItems?.length ?? 0)
                            : group.items.length}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {meta.description}
                      </span>
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-4 shrink-0 text-muted-foreground transition-transform",
                        open && "rotate-180",
                      )}
                    />
                  </button>

                  {open ? (
                    <div className="divide-y divide-border/40">
                      {group.id === "bedrock" ? (
                        <>
                          <div className="flex flex-wrap items-center justify-between gap-2.5 bg-muted/20 px-3.5 py-2.5 text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="flex items-center gap-1.5 font-medium text-foreground">
                                <Globe className="size-3.5 text-emerald-400" />
                                <span>基岩版下载数据源 (BedrockBoot)：</span>
                              </div>
                              <div className="inline-flex flex-wrap items-center rounded-lg border border-border/70 bg-background/60 p-0.5">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBedrockApiSource("mcappx");
                                    void loadBedrock("mcappx");
                                  }}
                                  className={cn(
                                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                    bedrockApiSource === "mcappx"
                                      ? "bg-emerald-500/20 text-emerald-400 shadow-xs"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  McAppx 官方源 (推荐)
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBedrockApiSource("bedrockboot_gitee");
                                    void loadBedrock("bedrockboot_gitee");
                                  }}
                                  className={cn(
                                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                    bedrockApiSource === "bedrockboot_gitee"
                                      ? "bg-emerald-500/20 text-emerald-400 shadow-xs"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  BedrockBoot Gitee 源
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBedrockApiSource("bmcbl");
                                    void loadBedrock("bmcbl");
                                  }}
                                  className={cn(
                                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                    bedrockApiSource === "bmcbl"
                                      ? "bg-emerald-500/20 text-emerald-400 shadow-xs"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  BMCBL 源
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBedrockApiSource("endstone");
                                    void loadBedrock("endstone");
                                  }}
                                  className={cn(
                                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                    bedrockApiSource === "endstone"
                                      ? "bg-emerald-500/20 text-emerald-400 shadow-xs"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  EndstoneMC 社区源
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setBedrockApiSource("azure_mirror");
                                    void loadBedrock("azure_mirror");
                                  }}
                                  className={cn(
                                    "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                    bedrockApiSource === "azure_mirror"
                                      ? "bg-emerald-500/20 text-emerald-400 shadow-xs"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  AzureCDN 镜像
                                </button>
                              </div>

                              <div className="inline-flex items-center rounded-lg border border-border/70 bg-background/60 p-0.5">
                                <button
                                  type="button"
                                  onClick={() => setBedrockTypeFilter("all")}
                                  className={cn(
                                    "rounded-md px-2 py-0.5 text-[10.5px] transition-colors",
                                    bedrockTypeFilter === "all"
                                      ? "bg-muted text-foreground font-medium"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  全部 ({group.bedrockItems?.length ?? 0})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setBedrockTypeFilter("release")}
                                  className={cn(
                                    "rounded-md px-2 py-0.5 text-[10.5px] transition-colors",
                                    bedrockTypeFilter === "release"
                                      ? "bg-emerald-500/20 text-emerald-400 font-medium"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  正式版 ({group.bedrockItems?.filter((b) => b.releaseType === "release").length ?? 0})
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setBedrockTypeFilter("preview")}
                                  className={cn(
                                    "rounded-md px-2 py-0.5 text-[10.5px] transition-colors",
                                    bedrockTypeFilter === "preview"
                                      ? "bg-amber-500/20 text-amber-400 font-medium"
                                      : "text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  预览测试版 ({group.bedrockItems?.filter((b) => b.releaseType === "preview").length ?? 0})
                                </button>
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {bedrockLoading ? (
                                <span className="flex items-center gap-1 text-[11px] text-emerald-400">
                                  <LoaderCircle className="size-3 animate-spin" />
                                  正在通过第三方 API 同步…
                                </span>
                              ) : (
                                <span className="text-[10px] text-muted-foreground">
                                  已加载 {group.bedrockItems?.length ?? 0} 个版本
                                </span>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 gap-1 px-2 text-[10.5px] text-muted-foreground hover:text-foreground"
                                disabled={bedrockLoading}
                                onClick={() => void loadBedrock(bedrockApiSource)}
                              >
                                <RefreshCw className={cn("size-2.5", bedrockLoading && "animate-spin")} />
                                刷新
                              </Button>
                            </div>
                          </div>

                          {(() => {
                            const filteredBedrock = (group.bedrockItems ?? []).filter((v) => {
                              if (bedrockTypeFilter === "release") return v.releaseType === "release";
                              if (bedrockTypeFilter === "preview") return v.releaseType === "preview";
                              return true;
                            });
                            const visibleBedrock = filteredBedrock.slice(0, limits.bedrock);

                            return (
                              <>
                                {visibleBedrock.map((ver) => {
                                  const isInstalled = Boolean(
                                    bedrockStatus?.installedVersions.some(
                                      (installedId) =>
                                        installedId === ver.id ||
                                        installedId === ver.version ||
                                        installedId.startsWith(ver.id) ||
                                        ver.id.startsWith(installedId) ||
                                        installedId.startsWith(ver.version) ||
                                        ver.version.startsWith(installedId),
                                    ),
                                  );
                                  const isBusy = installingBedrockId === ver.id;
                                  return (
                                    <div
                                      key={ver.id}
                                      className="group flex items-center justify-between gap-3 px-3.5 py-2.5 transition-colors hover:bg-muted/25"
                                    >
                                      <div className="flex min-w-0 flex-1 items-center gap-3">
                                        <VersionGlyph type="bedrock" />
                                        <span className="min-w-0 flex-1">
                                          <span className="flex flex-wrap items-center gap-1.5">
                                            <span className="font-mono text-[12px] font-medium text-foreground">
                                              {ver.name}
                                            </span>
                                            <Badge className="h-4 rounded-[4px] border-0 bg-emerald-500/15 px-1.5 text-[9px] font-normal text-emerald-400">
                                              基岩版
                                            </Badge>
                                            {ver.buildType ? (
                                              <Badge
                                                variant="outline"
                                                className="h-4 rounded-[4px] border-emerald-500/40 bg-emerald-500/10 px-1.5 font-mono text-[9px] font-semibold text-emerald-300"
                                              >
                                                {ver.buildType}
                                              </Badge>
                                            ) : null}
                                            {ver.md5 ? (
                                              <Badge
                                                variant="outline"
                                                title={`MD5 校验值: ${ver.md5}`}
                                                className="h-4 rounded-[4px] border-border/60 bg-muted/30 px-1.5 font-mono text-[9px] font-normal text-muted-foreground"
                                              >
                                                MD5: {ver.md5.slice(0, 8)}…
                                              </Badge>
                                            ) : null}
                                            {ver.apiSource ? (
                                              <Badge
                                                variant="outline"
                                                className="h-4 rounded-[4px] border-emerald-500/30 bg-emerald-500/5 px-1.5 text-[9px] font-normal text-emerald-400"
                                              >
                                                {ver.apiSource}
                                              </Badge>
                                            ) : null}
                                            {isInstalled ? (
                                              <Badge
                                                variant="outline"
                                                className="h-4 rounded-[4px] border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[9px] font-normal text-emerald-400"
                                              >
                                                已就绪
                                              </Badge>
                                            ) : null}
                                          </span>
                                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                            <span>发布于 {ver.date}</span>
                                            <span className="text-border">/</span>
                                            <span>{formatBytes(ver.size)}</span>
                                            <span className="text-border">/</span>
                                            <span>
                                              {ver.releaseType === "release"
                                                ? "官方正式版"
                                                : "预览测试版"}
                                            </span>
                                          </span>
                                        </span>
                                      </div>

                                      <div className="flex shrink-0 items-center gap-2">
                                        {ver.storeUrl ? (
                                          <a
                                            href={ver.storeUrl}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                                          >
                                            <Store className="size-3" />
                                            应用商店
                                            <ExternalLink className="size-2.5 opacity-60" />
                                          </a>
                                        ) : null}

                                        {isInstalled ? (
                                          <>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              className="h-7 gap-1 border-emerald-500/30 text-xs text-emerald-400 hover:bg-emerald-500/10"
                                              onClick={() => void handleLaunchBedrockInstance(ver.id)}
                                            >
                                              <Play className="size-3 fill-current" />
                                              启动
                                            </Button>
                                            {ver.buildType === "GDK" || ver.downloadUrl?.includes(".msixvc") ? (
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                className="h-7 gap-1 border-emerald-500/40 text-xs text-emerald-300 hover:bg-emerald-500/10"
                                                onClick={async () => {
                                                  try {
                                                    const s = await autoFixBedrockBootDependencies();
                                                    onNotify(
                                                      "success",
                                                      "BedrockBoot 运行环境自检与修复已完成",
                                                      s.allSatisfied
                                                        ? "Xbox GDK 运行依赖已全部就绪"
                                                        : "已自动开始配置组件并打开微软商店页面",
                                                    );
                                                  } catch (err) {
                                                    onNotify("error", "自动配置失败", String(err));
                                                  }
                                                }}
                                                title="自动配置 Xbox 应用与游戏服务运行环境"
                                              >
                                                <Wrench className="size-3 text-emerald-400" />
                                                环境自检与修复
                                              </Button>
                                            ) : null}
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              className="h-7 gap-1 border-primary/40 text-xs text-primary hover:bg-primary/10"
                                              onClick={() => setBedrockLoaderModalVer(ver)}
                                              title="配置 LeviLamina 模组加载器与原生 DLL 模组"
                                            >
                                              <Boxes className="size-3" />
                                              模组与加载器
                                            </Button>
                                            <Button
                                              variant="ghost"
                                              size="icon-sm"
                                              className="size-7 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setDeletingItem({
                                                  id: ver.id,
                                                  name: ver.name,
                                                  edition: "bedrock",
                                                });
                                              }}
                                              title="删除此基岩版核心"
                                            >
                                              <Trash2 className="size-3.5" />
                                            </Button>
                                          </>
                                        ) : (
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 gap-1 text-xs text-muted-foreground hover:text-foreground"
                                            onClick={() => setBedrockLoaderModalVer(ver)}
                                            title="预览并准备适配该版本的模组加载器"
                                          >
                                            <Boxes className="size-3" />
                                            加载器
                                          </Button>
                                        )}

                                        <Button
                                          variant={isInstalled ? "ghost" : "default"}
                                          size="sm"
                                          className="h-7 gap-1 text-xs"
                                          disabled={isBusy}
                                          onClick={() => void handleInstallBedrock(ver)}
                                        >
                                          {isBusy ? (
                                            <LoaderCircle className="size-3 animate-spin" />
                                          ) : isInstalled ? (
                                            <Check className="size-3" />
                                          ) : (
                                            <Download className="size-3" />
                                          )}
                                          {isInstalled ? "重新下载" : "第三方 API 下载"}
                                        </Button>
                                      </div>
                                    </div>
                                  );
                                })}

                                {filteredBedrock.length > visibleBedrock.length ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-8 w-full rounded-none text-[10px] font-normal text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                                    onClick={() =>
                                      setLimits((current) => ({
                                        ...current,
                                        bedrock: current.bedrock + 25,
                                      }))
                                    }
                                  >
                                    显示更多基岩版版本（剩余 {filteredBedrock.length - visibleBedrock.length}）
                                  </Button>
                                ) : null}
                              </>
                            );
                          })()}
                        </>
                      ) : (
                        <>
                          {group.id === "legacy" ? (
                            <div className="space-y-2 border-b border-border/60 bg-muted/20 px-3.5 py-2.5 text-xs">
                              <div className="flex flex-wrap items-center justify-between gap-2.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                                    <Archive className="size-3.5 text-amber-400" />
                                    <span>远古版本数据源：</span>
                                  </div>
                                  <div className="inline-flex items-center rounded-lg border border-border/70 bg-background/60 p-0.5">
                                    <button
                                      type="button"
                                      onClick={() => setLegacySource("all")}
                                      className={cn(
                                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                        legacySource === "all"
                                          ? "bg-amber-500/20 text-amber-400 shadow-xs font-semibold"
                                          : "text-muted-foreground hover:text-foreground",
                                      )}
                                    >
                                      全部聚合源 (推荐)
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setLegacySource("betacraft")}
                                      className={cn(
                                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                        legacySource === "betacraft"
                                          ? "bg-amber-500/20 text-amber-400 shadow-xs font-semibold"
                                          : "text-muted-foreground hover:text-foreground",
                                      )}
                                    >
                                      BetaCraft 档案库 (files.betacraft.uk)
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setLegacySource("mojang")}
                                      className={cn(
                                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                                        legacySource === "mojang"
                                          ? "bg-amber-500/20 text-amber-400 shadow-xs font-semibold"
                                          : "text-muted-foreground hover:text-foreground",
                                      )}
                                    >
                                      Mojang 官方源
                                    </button>
                                  </div>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className="h-6 gap-1 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                                  onClick={() => void loadBetacraft(true)}
                                  disabled={betacraftLoading}
                                >
                                  <RefreshCw className={cn("size-2.5", betacraftLoading && "animate-spin")} />
                                  刷新 BetaCraft 清单
                                </Button>
                              </div>

                              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-[11px] font-medium text-muted-foreground mr-1">阶段筛选：</span>
                                  {[
                                    { id: "all", label: "全部" },
                                    { id: "beta", label: "Beta" },
                                    { id: "alpha", label: "Alpha" },
                                    { id: "infdev", label: "Infdev" },
                                    { id: "indev", label: "Indev" },
                                    { id: "classic", label: "Classic" },
                                    { id: "pre-classic", label: "Pre-Classic" },
                                    { id: "oddballs", label: "早期特殊/奇趣" },
                                    { id: "post-1.0", label: "Post-1.0" },
                                  ].map((phase) => (
                                    <button
                                      key={phase.id}
                                      type="button"
                                      onClick={() => setBetacraftPhaseFilter(phase.id)}
                                      className={cn(
                                        "rounded-md px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                                        betacraftPhaseFilter === phase.id
                                          ? "bg-amber-500/20 text-amber-400 shadow-xs font-semibold"
                                          : "bg-background/40 text-muted-foreground hover:text-foreground",
                                      )}
                                    >
                                      {phase.label}
                                    </button>
                                  ))}
                                </div>
                                <span className="text-[10px] text-muted-foreground">
                                  BetaCraft 独家收录早期 Classic/Indev/Infdev 并修复现代系统声音缺失与皮肤黑屏
                                </span>
                              </div>
                            </div>
                          ) : null}

                          {visible.map((version) => {
                            const local = installedMap.get(version.id);
                            const latest = manifest?.latest.release === version.id;
                            const foolsMeta = APRIL_FOOLS_REGISTRY[version.id];
                            const isAprilFools = group.id === "april_fools" || Boolean(foolsMeta);
                            const glyphType = isAprilFools ? "april_fools" : version.type;

                            return (
                              <div
                                key={version.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => onSelectVersion(version)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onSelectVersion(version);
                                  }
                                }}
                                className={cn(
                                  "group flex cursor-pointer items-center gap-2 px-3.5 py-2.5 transition-colors hover:bg-muted/25",
                                  isAprilFools && "hover:bg-purple-500/[0.04]",
                                )}
                              >
                                <div className="flex min-w-0 flex-1 items-center gap-3">
                                  <VersionGlyph type={glyphType} source={version.source} />
                                  <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-1.5">
                                      <span className="font-mono text-[12px] font-medium text-foreground">
                                        {version.id}
                                      </span>
                                      {version.source === "betacraft" ? (
                                        <Badge
                                          variant="outline"
                                          className="h-4 rounded-[4px] border-amber-500/40 bg-amber-500/10 px-1.5 font-mono text-[9px] font-normal text-amber-400"
                                        >
                                          BetaCraft
                                        </Badge>
                                      ) : null}
                                      {version.phase ? (
                                        <Badge
                                          variant="outline"
                                          className="h-4 rounded-[4px] border-border/80 bg-muted/40 px-1.5 font-mono text-[9px] font-normal text-muted-foreground uppercase"
                                        >
                                          {version.phase}
                                        </Badge>
                                      ) : null}
                                      {foolsMeta ? (
                                        <span className="text-[12px] font-semibold text-purple-400">
                                          · {foolsMeta.titleZh}
                                        </span>
                                      ) : null}
                                      {foolsMeta ? (
                                        <Badge className="h-4 rounded-[4px] border-0 bg-purple-500/20 px-1.5 text-[9px] font-medium text-purple-300">
                                          {foolsMeta.tag}
                                        </Badge>
                                      ) : null}
                                      {foolsMeta ? (
                                        <Badge
                                          variant="outline"
                                          className="h-4 rounded-[4px] border-purple-500/35 px-1 text-[9px] text-purple-300/80"
                                        >
                                          {foolsMeta.year} 愚人节
                                        </Badge>
                                      ) : null}
                                      {latest ? (
                                        <Badge className="h-4 rounded-[4px] border-0 bg-gold/15 px-1.5 text-[9px] font-normal text-gold">
                                          最新
                                        </Badge>
                                      ) : null}
                                      {local ? (
                                        <Badge
                                          variant="outline"
                                          className="h-4 rounded-[4px] border-primary/25 bg-primary/5 px-1.5 text-[9px] font-normal text-primary"
                                        >
                                          已下载
                                        </Badge>
                                      ) : null}
                                    </span>

                                    {foolsMeta?.subtitle ? (
                                      <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground/90">
                                        {foolsMeta.subtitle}
                                      </p>
                                    ) : null}

                                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                      {foolsMeta?.highlights && foolsMeta.highlights.length > 0 ? (
                                        <span className="flex flex-wrap items-center gap-1 mr-1">
                                          {foolsMeta.highlights.map((h) => (
                                            <span
                                              key={h}
                                              className="rounded bg-muted/60 px-1.5 py-0.2 text-[9px] text-muted-foreground/90"
                                            >
                                              {h}
                                            </span>
                                          ))}
                                        </span>
                                      ) : null}
                                      <span>发布于 {formatDate(version.releaseTime)}</span>
                                      <span className="text-border">/</span>
                                      <TypeBadge
                                        type={glyphType}
                                        tone={isAprilFools ? "gold" : typeTone(version.type)}
                                        label={isAprilFools ? "愚人节限定" : typeLabel(version.type)}
                                      />
                                    </span>
                                  </span>
                                </div>
                                <div className="flex shrink-0 items-center">
                                  {renderActions(version)}
                                </div>
                              </div>
                            );
                          })}
                        </>
                      )}
                      {group.id !== "bedrock" && group.items.length > visible.length ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-full rounded-none text-[10px] font-normal text-muted-foreground hover:bg-muted/30 hover:text-foreground"
                          onClick={() =>
                            setLimits((current) => ({
                              ...current,
                              [group.id]: current[group.id] + 20,
                            }))
                          }
                        >
                          显示更多（剩余 {group.items.length - visible.length}）
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              );
            })
          )}
        </div>
      </div>
    </>
  )}

  {/* Delete Confirmation Modal */}
  {deletingItem ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in-0 duration-150">
      <div className="w-full max-w-sm rounded-xl border border-border/80 bg-background/95 p-5 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
            <Trash2 className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">确认删除此版本？</h3>
            <p className="mt-0.5 text-xs text-muted-foreground truncate font-mono">
              {deletingItem.name}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          此操作将从磁盘中永久清理该版本的所有已下载核心文件与依赖，删除后无法撤销。
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isDeleting}
            onClick={() => setDeletingItem(null)}
          >
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={isDeleting}
            className="gap-1.5"
            onClick={async () => {
              if (!deletingItem) return;
              setIsDeleting(true);
              try {
                if (onDeleteVersion) {
                  await onDeleteVersion(deletingItem.id, deletingItem.edition);
                } else {
                  if (deletingItem.edition === "java") {
                    await deleteVersion(gameRoot, deletingItem.id);
                  } else {
                    await deleteBedrockVersion(deletingItem.id, gameRoot);
                  }
                  onNotify("success", "删除成功", `已成功删除版本 ${deletingItem.name}`);
                }
                if (deletingItem.edition === "bedrock") {
                  await loadBedrock();
                } else {
                  onRefresh();
                }
                setDeletingItem(null);
              } catch (e) {
                onNotify("error", "删除失败", String(e));
              } finally {
                setIsDeleting(false);
              }
            }}
          >
            {isDeleting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            确认删除
          </Button>
        </div>
      </div>
    </div>
  ) : null}

  {bedrockLoaderModalVer && (
    <BedrockModLoaderModal
      version={bedrockLoaderModalVer}
      gameRoot={gameRoot}
      onClose={() => {
        setBedrockLoaderModalVer(null);
        void loadBedrock();
      }}
    />
  )}
</div>
);
}
