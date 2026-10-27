import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Check,
  Coffee,
  Cpu,
  Download,
  FolderCog,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Package,
  PackageOpen,
  Play,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { cn } from "cn";
import {
  formatDate,
  joinPath,
  shortPath,
  typeLabel,
  typeTone,
} from "../lib/format";
import {
  deleteBedrockVersion,
  deleteVersion,
  getBedrockStatus,
  getBedrockVersions,
} from "../lib/backend";
import type {
  BedrockStatus,
  BedrockVersionItem,
  GameEdition,
  InstalledVersion,
  VersionManifest,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TypeBadge } from "./ui";

export type UnifiedFilter = "all" | "java" | "bedrock" | "modded" | "release" | "april_fools";

const UNIFIED_FILTERS: Array<{
  id: UnifiedFilter;
  label: string;
  icon: typeof Layers3;
  imageSrc?: string;
}> = [
  { id: "all", label: "全部版本 (混排)", icon: Layers3, imageSrc: "/icons/minecraft/compass.png" },
  { id: "java", label: "仅 Java 版", icon: Coffee, imageSrc: "/icons/minecraft/grass_block.png" },
  { id: "bedrock", label: "仅基岩版", icon: Boxes, imageSrc: "/icons/minecraft/bedrock.png" },
  { id: "april_fools", label: "愚人节限定", icon: Sparkles, imageSrc: "/icons/minecraft/poisonous_potato.png" },
  { id: "modded", label: "模组版本 (Fabric/Forge)", icon: Cpu, imageSrc: "/icons/minecraft/anvil.png" },
  { id: "release", label: "官方正式版", icon: Package, imageSrc: "/icons/minecraft/crafting_table.png" },
];

export interface VersionSelectViewProps {
  manifest: VersionManifest | null;
  installed: InstalledVersion[];
  selectedVersion: string;
  gameRoot: string;
  edition?: GameEdition;
  onEditionChange?: (edition: GameEdition) => void;
  selectedBedrockVersion?: string;
  onSelectBedrockVersion?: (versionId: string) => void;
  onSelect: (versionId: string) => void;
  onPlay: (versionId: string) => void;
  onPlayBedrock?: (versionId?: string) => void;
  onOpenVersionSettings: (versionId: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenLauncherSettings: () => void;
  onOpenDownloadPage: () => void;
  onDeleteVersion?: (versionId: string, edition: "java" | "bedrock") => Promise<void> | void;
  onNotify?: (
    tone: "success" | "error" | "info",
    title: string,
    detail?: string,
  ) => void;
}

function installedDate(version: InstalledVersion): string {
  if (!version.installedAt) return "本地实例";
  return formatDate(new Date(version.installedAt * 1000).toISOString());
}

export interface MixedVersionItem {
  id: string;
  name: string;
  edition: "java" | "bedrock";
  type: string;
  loader?: string;
  loaderVersion?: string;
  optifineVersion?: string;
  dateStr: string;
  pathDisplay: string;
  isUwp?: boolean;
  isServerCore?: boolean;
  isGdkCore?: boolean;
  javaVersion?: InstalledVersion;
}

export function VersionSelectView({
  manifest,
  installed,
  selectedVersion,
  gameRoot,
  edition: _edition,
  onEditionChange,
  selectedBedrockVersion = "uwp",
  onSelectBedrockVersion,
  onSelect,
  onPlay,
  onPlayBedrock,
  onOpenVersionSettings,
  onOpenFolder,
  onOpenLauncherSettings,
  onOpenDownloadPage,
  onDeleteVersion,
  onNotify,
}: VersionSelectViewProps) {
  const [filter, setFilter] = useState<UnifiedFilter>("all");
  const [query, setQuery] = useState("");
  const [bedrockStatus, setBedrockStatus] = useState<BedrockStatus | null>(null);
  const [cloudBedrockVersions, setCloudBedrockVersions] = useState<BedrockVersionItem[]>([]);
  const [deletingItem, setDeletingItem] = useState<MixedVersionItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cleaningLeftovers, setCleaningLeftovers] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getBedrockStatus(gameRoot);
      setBedrockStatus(s);
    } catch {
      // ignore
    }
  }, [gameRoot]);

  const leftovers = bedrockStatus?.leftoverVersions ?? [];

  // Folders left behind by aborted downloads never show up as installed cores,
  // so they had no delete entry at all. Clearing them goes through the same
  // backend delete path as a real version.
  const handleCleanLeftovers = useCallback(async () => {
    if (cleaningLeftovers || leftovers.length === 0) return;
    setCleaningLeftovers(true);
    const failed: string[] = [];
    try {
      for (const id of leftovers) {
        try {
          await deleteBedrockVersion(id, gameRoot);
        } catch (error) {
          failed.push(`${id}: ${String(error)}`);
        }
      }
      await refreshStatus();
      if (failed.length === 0) {
        onNotify?.("success", "已清理残留目录", `移除 ${leftovers.length} 个未完成安装的目录。`);
      } else {
        onNotify?.("error", "部分残留目录无法清理", failed.join("\n"));
      }
    } finally {
      setCleaningLeftovers(false);
    }
  }, [cleaningLeftovers, leftovers, gameRoot, refreshStatus, onNotify]);

  useEffect(() => {
    void refreshStatus();
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshStatus, selectedBedrockVersion, _edition]);

  // Load cloud recommendations lazily in the background without blocking installed versions
  useEffect(() => {
    let active = true;
    void getBedrockVersions().then((bVers) => {
      if (active && Array.isArray(bVers)) {
        setCloudBedrockVersions(bVers.slice(0, 4));
      }
    }).catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Combine Java versions and Bedrock versions into a mixed list
  const mixedItems = useMemo<MixedVersionItem[]>(() => {
    const list: MixedVersionItem[] = [];

    // 1. Java Versions
    for (const v of installed) {
      list.push({
        id: v.id,
        name: v.id,
        edition: "java",
        type: v.type,
        loader: v.loader,
        loaderVersion: v.loaderVersion,
        optifineVersion: v.optifineVersion,
        dateStr: installedDate(v),
        pathDisplay: `versions/${v.id}/${v.id}.jar`,
        javaVersion: v,
      });
    }

    // 2. Bedrock Versions
    if (bedrockStatus?.uwpInstalled) {
      list.push({
        id: "uwp",
        name: "Minecraft for Windows (正版 UWP)",
        edition: "bedrock",
        type: "uwp",
        dateStr: "系统已就绪",
        pathDisplay: bedrockStatus.comMojangPath || "%LOCALAPPDATA%/.../com.mojang",
        isUwp: true,
      });
    }

    for (const bdsVer of bedrockStatus?.installedVersions ?? []) {
      const detail = bedrockStatus?.versionDetails?.find(
        (item) => item.id === bdsVer || item.id.startsWith(`${bdsVer}.`) || bdsVer.startsWith(item.id),
      );
      const isServerCore = detail?.isServer ?? false;
      const isGdkCore = detail?.isGdk ?? detail?.packageType === "msixvc";
      list.push({
        id: `bedrock:${bdsVer}`,
        name: `Minecraft 基岩版: ${bdsVer}`,
        edition: "bedrock",
        type: "bds",
        dateStr: isServerCore
          ? "独立核心已就绪"
          : isGdkCore
            ? "GDK 加密核心已下载"
            : "UWP / AppX 核心已就绪",
        pathDisplay: `bedrock/versions/${bdsVer}/`,
        isServerCore,
        isGdkCore,
      });
    }

    return list;
  }, [installed, bedrockStatus]);

  const isAprilFoolsVersion = (id: string) => {
    const lower = id.toLowerCase();
    return (
      lower.includes("potato") ||
      lower.includes("shareware") ||
      lower.includes("oneblock") ||
      lower.includes("infinite") ||
      lower.includes("23w13") ||
      lower.includes("1.rv") ||
      lower.includes("15w14")
    );
  };

  // Counts for filters
  const filterCounts = useMemo(() => {
    const javaCount = installed.length;
    const bedrockCount = (bedrockStatus?.uwpInstalled ? 1 : 0) + (bedrockStatus?.installedVersions.length ?? 0);
    const moddedCount = installed.filter((v) => v.loader || v.optifineVersion).length;
    const foolsCount = installed.filter((v) => isAprilFoolsVersion(v.id)).length;
    const releaseCount = installed.filter((v) => v.type === "release" && !v.loader && !v.optifineVersion).length + (bedrockStatus?.uwpInstalled ? 1 : 0);
    return {
      all: javaCount + bedrockCount,
      java: javaCount,
      bedrock: bedrockCount,
      april_fools: foolsCount,
      modded: moddedCount,
      release: releaseCount,
    };
  }, [installed, bedrockStatus]);

  // Filtered Items
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return mixedItems.filter((item) => {
      if (needle && !item.name.toLowerCase().includes(needle) && !item.id.toLowerCase().includes(needle)) {
        return false;
      }
      if (filter === "all") return true;
      if (filter === "java") return item.edition === "java";
      if (filter === "bedrock") return item.edition === "bedrock";
      if (filter === "april_fools") return item.edition === "java" && isAprilFoolsVersion(item.id);
      if (filter === "modded") return item.edition === "java" && Boolean(item.loader || item.optifineVersion);
      if (filter === "release") {
        if (item.edition === "java") return item.type === "release" && !item.loader && !item.optifineVersion;
        if (item.edition === "bedrock") return true;
      }
      return true;
    });
  }, [mixedItems, filter, query]);

  const activeFilterLabel =
    UNIFIED_FILTERS.find((entry) => entry.id === filter)?.label ?? "全部版本";

  const handleSelectItem = (item: MixedVersionItem) => {
    onSelect(item.id);
    if (item.edition === "bedrock") {
      onSelectBedrockVersion?.(item.id.replace(/^bedrock:/, ""));
      onEditionChange?.("bedrock");
    } else {
      onEditionChange?.("java");
    }
  };

  const handlePlayItem = (item: MixedVersionItem) => {
    if (item.edition === "bedrock") {
      const bdsId = item.id === "uwp" ? "uwp" : item.id.replace(/^bedrock:/, "");
      onPlayBedrock?.(bdsId);
    } else {
      onPlay(item.id);
    }
  };

  const handleOpenFolder = (item: MixedVersionItem) => {
    if (item.edition === "bedrock") {
      if (item.isUwp) {
        onOpenFolder(bedrockStatus?.comMojangPath || `${gameRoot}/bedrock/games/com.mojang`);
      } else {
        const bdsId = item.id.replace(/^bedrock:/, "");
        onOpenFolder(joinPath(gameRoot, "bedrock", "versions", bdsId));
      }
    } else {
      onOpenFolder(joinPath(gameRoot, "versions", item.id));
    }
  };

  return (
    <div className="space-y-5">
      {/* Page Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight">版本选择</h1>
          <Badge
            variant="outline"
            className="h-6 border-primary/30 bg-primary/10 px-2 text-xs font-normal text-primary"
          >
            Java 版与基岩版全混用
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">
            共 {mixedItems.length} 个本地版本
          </span>
        </div>

        {/* Search & Actions */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 Java 或基岩版版本…"
              spellCheck={false}
              className="h-8 w-[220px] border-border/80 bg-card/60 pl-8 pr-8 font-mono text-[11px]"
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
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 border-border/80 bg-card/60 text-[11.5px]"
            onClick={onOpenDownloadPage}
          >
            <Download className="size-3.5 text-primary" />
            前往下载页面
          </Button>
        </div>
      </div>

      {/* Main Grid: Sidebar + List */}
      <div className="grid items-start gap-4 min-[1000px]:grid-cols-[220px_minmax(0,1fr)] min-[1240px]:grid-cols-[240px_minmax(0,1fr)]">
        {/* Left Sidebar */}
        <aside className="space-y-3 min-[1000px]:sticky min-[1000px]:top-0">
          {/* Unified Game Directories Card */}
          <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-xs">
            <CardHeader className="border-b border-border/60 px-4 py-3">
              <CardTitle className="flex items-center gap-2 text-[12px] font-medium">
                <FolderCog className="size-3.5 text-primary" />
                游戏存储目录
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 p-3">
              {/* Java Folder */}
              <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-2.5">
                <div className="flex items-center justify-between text-[10px] font-medium text-primary">
                  <span className="flex items-center gap-1.5">
                    <Coffee className="size-3" />
                    Java 版本目录
                  </span>
                </div>
                <p
                  className="mt-1 truncate font-mono text-[9px] text-muted-foreground"
                  title={joinPath(gameRoot, "versions")}
                >
                  {shortPath(joinPath(gameRoot, "versions"), 24)}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 gap-1 border-border/70 bg-background/40 px-1.5 text-[9.5px]"
                    onClick={() => onOpenFolder(joinPath(gameRoot, "versions"))}
                  >
                    <FolderOpen className="size-2.5" />
                    打开
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 gap-1 border-border/70 bg-background/40 px-1.5 text-[9.5px]"
                    onClick={onOpenLauncherSettings}
                  >
                    <FolderCog className="size-2.5" />
                    设置
                  </Button>
                </div>
              </div>

              {/* Bedrock Folder */}
              <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-2.5">
                <div className="flex items-center justify-between text-[10px] font-medium text-primary">
                  <span className="flex items-center gap-1.5">
                    <Boxes className="size-3" />
                    基岩版数据目录
                  </span>
                  <span className="text-[9px] text-muted-foreground">
                    {bedrockStatus?.uwpInstalled ? "正版 UWP" : "独立核心"}
                  </span>
                </div>
                <p
                  className="mt-1 truncate font-mono text-[9px] text-muted-foreground"
                  title={bedrockStatus?.comMojangPath || joinPath(gameRoot, "bedrock")}
                >
                  {shortPath(bedrockStatus?.comMojangPath || joinPath(gameRoot, "bedrock"), 24)}
                </p>
                <div className="mt-2">
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 w-full gap-1 border-border/70 bg-background/40 px-1.5 text-[9.5px]"
                    onClick={() => {
                      if (bedrockStatus?.comMojangPath) {
                        onOpenFolder(bedrockStatus.comMojangPath);
                      } else {
                        onOpenFolder(joinPath(gameRoot, "bedrock", "games", "com.mojang"));
                      }
                    }}
                  >
                    <FolderOpen className="size-2.5" />
                    打开基岩版目录
                  </Button>
                </div>
                {leftovers.length > 0 ? (
                  <div className="mt-1.5 flex items-center justify-between gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-1.5 py-1">
                    <span className="flex min-w-0 items-center gap-1 text-[9.5px] text-amber-400/90">
                      <TriangleAlert className="size-2.5 shrink-0" />
                      <span className="truncate" title={leftovers.join("\n")}>
                        {leftovers.length} 个残留目录
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-5 shrink-0 gap-1 px-1.5 text-[9.5px] text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                      disabled={cleaningLeftovers}
                      onClick={() => void handleCleanLeftovers()}
                      title={`清理: ${leftovers.join(", ")}`}
                    >
                      {cleaningLeftovers ? (
                        <LoaderCircle className="size-2.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-2.5" />
                      )}
                      清理
                    </Button>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* Unified Filter Card */}
          <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-xs">
            <CardHeader className="border-b border-border/60 px-4 py-3">
              <CardTitle className="flex items-center gap-2 text-[12px] font-medium">
                <Layers3 className="size-3.5 text-primary" />
                分类筛选
              </CardTitle>
            </CardHeader>
            <CardContent className="p-2">
              <nav className="flex flex-col gap-1">
                {UNIFIED_FILTERS.map((item) => {
                  const active = filter === item.id;
                  const Icon = item.icon;
                  const count = filterCounts[item.id] ?? 0;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFilter(item.id)}
                      className={cn(
                        "flex items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors",
                        active
                          ? "bg-primary/10 font-medium text-primary shadow-2xs"
                          : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {item.imageSrc ? (
                          <img
                            src={item.imageSrc}
                            alt=""
                            className="size-4 shrink-0 object-contain [image-rendering:pixelated]"
                          />
                        ) : (
                          <Icon className="size-3.5 shrink-0" />
                        )}
                        {item.label}
                      </span>
                      <span
                        className={cn(
                          "font-mono text-[10px]",
                          active ? "text-primary" : "text-muted-foreground/70",
                        )}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </nav>
            </CardContent>
          </Card>
        </aside>

        {/* Right Content Area: Unified Mixed Version List */}
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[13px] font-medium">{activeFilterLabel}</h2>
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {filteredItems.length} 个版本
              </span>
            </div>
            <span className="text-[10px] text-muted-foreground/60">
              当前选定版本{" "}
              <strong className="font-mono font-medium text-foreground">
                {selectedVersion || "未选择"}
              </strong>
            </span>
          </div>

          {filteredItems.length === 0 ? (
            <Card className="grid min-h-[320px] place-items-center border-border/70 bg-card/45 px-6 py-12 text-center">
              <div className="max-w-sm">
                <div className="mx-auto flex size-11 items-center justify-center rounded-lg border border-border/70 bg-muted/30">
                  <PackageOpen className="size-5 text-muted-foreground/60" />
                </div>
                <h3 className="mt-3 text-[13px] font-medium">
                  {query
                    ? `没有找到包含“${query}”的版本`
                    : filter === "bedrock"
                      ? "本地暂未检测到已安装的基岩版"
                      : filter === "april_fools"
                        ? "本地暂未安装愚人节特别版"
                        : mixedItems.length === 0
                          ? "还没有下载任何 Java 或基岩版游戏"
                          : "该分类下暂无已下载的版本"}
                </h3>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {query
                    ? "换一个关键词，或清除搜索查看全部版本。"
                    : filter === "bedrock"
                      ? "启动器支持通过第三方全版本 API 一键下载 Windows 基岩版 BDS 独立核心，开箱即玩无需 Microsoft Store。前往下载中心可快速安装各版本基岩版！"
                      : filter === "april_fools"
                        ? "支持一键多线程极速下载 2024 毒马铃薯、2020 21.4亿随机维度、2022 一次一个方块、3D软盘版等历年脑洞神作！前往下载中心即可高速获取并游玩。"
                        : "版本选择页聚合展示本地已安装的所有 Java 与基岩版版本。如需新版本，请前往下载中心。"}
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {query ? (
                    <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                      清除搜索
                    </Button>
                  ) : filter !== "all" ? (
                    <Button variant="outline" size="sm" onClick={() => setFilter("all")}>
                      查看全部已安装
                    </Button>
                  ) : null}
                  <Button size="sm" className="gap-1.5" onClick={onOpenDownloadPage}>
                    <Download className="size-3.5" />
                    前往下载页面
                  </Button>
                </div>

                {filter === "bedrock" && cloudBedrockVersions.length > 0 ? (
                  <div className="mt-5 border-t border-border/60 pt-4 text-left">
                    <span className="block text-[11px] font-medium text-foreground">
                      推荐快速安装基岩版：
                    </span>
                    <div className="mt-2 space-y-1.5">
                      {cloudBedrockVersions.map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center justify-between rounded-md border border-border/60 bg-muted/25 px-2.5 py-1.5 text-xs"
                        >
                          <span className="font-mono text-[11px] text-foreground">{b.name}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 px-2 text-[10px] text-primary hover:bg-primary/10"
                            onClick={onOpenDownloadPage}
                          >
                            <Download className="size-2.5" />
                            去下载
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          ) : (
            <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
              <div className="divide-y divide-border/60">
                {filteredItems.map((item) => {
                  const isSelected =
                    selectedVersion === item.id ||
                    (item.edition === "bedrock" && item.id === "uwp" && (selectedVersion === "uwp" || selectedBedrockVersion === "uwp"));
                  const isJava = item.edition === "java";
                  const isLatest =
                    manifest?.latest &&
                    (manifest.latest.release === item.id ||
                      manifest.latest.snapshot === item.id);

                  return (
                    <div
                      key={`${item.edition}-${item.id}`}
                      className={cn(
                        "flex items-center gap-2 px-3.5 py-3 transition-colors hover:bg-muted/20",
                        isSelected && "bg-primary/[0.045]",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => handleSelectItem(item)}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        aria-pressed={isSelected}
                      >
                        {/* Glyph icon */}
                        {(() => {
                          const isFools = isAprilFoolsVersion(item.id);
                          const itemIconSrc = isJava
                            ? isFools
                              ? "/icons/minecraft/poisonous_potato.png"
                              : item.loader || item.optifineVersion
                                ? "/icons/minecraft/anvil.png"
                                : item.type === "snapshot"
                                  ? "/icons/minecraft/command_block.png"
                                  : item.type === "release"
                                    ? "/icons/minecraft/grass_block.png"
                                    : "/icons/minecraft/cobblestone.png"
                            : "/icons/minecraft/bedrock.png";

                          return (
                            <span
                              className={cn(
                                "flex size-9 shrink-0 items-center justify-center rounded-md border p-1 shadow-2xs",
                                isJava
                                  ? isFools
                                    ? "border-purple-500/35 bg-purple-500/15"
                                    : item.type === "release"
                                      ? "border-primary/25 bg-primary/10"
                                      : item.type === "snapshot"
                                        ? "border-gold/25 bg-gold/10"
                                        : "border-border/70 bg-muted/50"
                                  : "border-primary/30 bg-primary/10",
                              )}
                            >
                              <img
                                src={itemIconSrc}
                                alt=""
                                className="size-6 object-contain drop-shadow-xs [image-rendering:pixelated]"
                              />
                            </span>
                          );
                        })()}

                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[12px] font-medium text-foreground">
                              {item.name}
                            </span>

                            {/* Edition Badge */}
                            {isJava ? (
                              <Badge className="h-4 rounded-[4px] border-0 bg-primary/15 px-1.5 text-[9px] font-normal text-primary">
                                ☕ Java 版
                              </Badge>
                            ) : (
                              <Badge className="h-4 rounded-[4px] border-0 bg-primary/15 px-1.5 text-[9px] font-normal text-primary">
                                ☸ 基岩版
                              </Badge>
                            )}

                            {isSelected ? (
                              <Badge
                                className={cn(
                                  "h-4 gap-0.5 rounded-[4px] border-0 px-1.5 text-[9px] font-normal",
                                  "bg-primary/20 text-primary",
                                )}
                              >
                                <Check className="size-2.5" />
                                当前激活
                              </Badge>
                            ) : null}

                            {isLatest ? (
                              <Badge className="h-4 rounded-[4px] border-0 bg-gold/15 px-1.5 text-[9px] font-normal text-gold">
                                最新
                              </Badge>
                            ) : null}

                            {/* Type Badges */}
                            {isJava ? (
                              <>
                                <TypeBadge
                                  type={item.type}
                                  tone={typeTone(item.type)}
                                  label={typeLabel(item.type)}
                                />
                                {item.loader ? (
                                  <Badge
                                    variant="outline"
                                    className="h-4 rounded-[4px] border-border/80 bg-muted/40 px-1.5 font-mono text-[9px] font-normal text-foreground/85 uppercase"
                                  >
                                    {item.loader}
                                    {item.loaderVersion ? ` ${item.loaderVersion}` : ""}
                                  </Badge>
                                ) : null}
                                {item.optifineVersion ? (
                                  <Badge
                                    variant="outline"
                                    className="h-4 rounded-[4px] border-gold/30 bg-gold/10 px-1.5 font-mono text-[9px] font-normal text-gold"
                                  >
                                    OptiFine {item.optifineVersion}
                                  </Badge>
                                ) : null}
                              </>
                            ) : (
                              <Badge
                                variant="outline"
                                className="h-4 rounded-[4px] border-primary/30 bg-primary/5 px-1.5 text-[9px] font-normal text-primary"
                              >
                                {item.isUwp
                                  ? "Windows Store 正版"
                                  : item.isServerCore
                                    ? "BDS 独立核心"
                                    : item.isGdkCore
                                      ? "Xbox GDK 加密核心"
                                      : "UWP / AppX 核心"}
                              </Badge>
                            )}
                          </span>

                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            <span>{item.dateStr}</span>
                            <span className="text-border">/</span>
                            <span className="font-mono text-[9.5px] truncate max-w-[320px]">
                              {item.pathDisplay}
                            </span>
                          </span>
                        </span>
                      </button>

                      {/* Action buttons */}
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-7 text-muted-foreground"
                          onClick={() => handleOpenFolder(item)}
                          title="打开文件目录"
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>

                        {isJava ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 text-muted-foreground"
                            onClick={() => onOpenVersionSettings(item.id)}
                            title="打开版本设置"
                          >
                            <SlidersHorizontal className="size-3.5" />
                          </Button>
                        ) : null}

                        {!item.isUwp ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="size-7 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeletingItem(item);
                            }}
                            title="删除此版本核心与文件"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        ) : null}

                        <Button
                          size="sm"
                          className="h-7 gap-1.5 px-2.5 text-[11px]"
                          onClick={() => handlePlayItem(item)}
                        >
                          <Play className="size-3 fill-current" />
                          启动
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      </div>

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
              此操作将从磁盘中永久清理该版本的核心文件与配置文件目录（
              <span className="font-mono text-foreground">{deletingItem.pathDisplay}</span>
              ），删除后无法撤销恢复。
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
                    const bdsVer = deletingItem.id.startsWith("bedrock:")
                      ? deletingItem.id.replace(/^bedrock:/, "")
                      : deletingItem.id;
                    if (onDeleteVersion) {
                      await onDeleteVersion(
                        deletingItem.edition === "java" ? deletingItem.id : bdsVer,
                        deletingItem.edition,
                      );
                    } else {
                      if (deletingItem.edition === "java") {
                        await deleteVersion(gameRoot, deletingItem.id);
                      } else {
                        await deleteBedrockVersion(bdsVer, gameRoot);
                      }
                      onNotify?.("success", "删除成功", `已成功删除版本 ${deletingItem.name}`);
                    }
                    const s = await getBedrockStatus(gameRoot);
                    setBedrockStatus(s);
                    setDeletingItem(null);
                  } catch (e) {
                    onNotify?.("error", "删除失败", String(e));
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
    </div>
  );
}
