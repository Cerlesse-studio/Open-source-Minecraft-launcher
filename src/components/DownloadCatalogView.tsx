import { useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  FlaskConical,
  HardDriveDownload,
  Layers3,
  LoaderCircle,
  Package,
  PackageOpen,
  RefreshCw,
  Search,
  ShieldCheck,
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
import { ContentMarketplaceView } from "./ContentMarketplaceView";
import type {
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

type Filter = "all" | "release" | "snapshot" | "legacy";
type GroupId = "release" | "snapshot" | "legacy";

const FILTERS: Array<{
  id: Filter;
  label: string;
  icon: typeof Layers3;
}> = [
  { id: "all", label: "全部可下载", icon: Layers3 },
  { id: "release", label: "正式版", icon: Package },
  { id: "snapshot", label: "快照", icon: FlaskConical },
  { id: "legacy", label: "远古版本", icon: Archive },
];

const GROUP_META: Record<
  GroupId,
  { title: string; description: string; icon: typeof Layers3 }
> = {
  release: {
    title: "正式版",
    description: "稳定版本，适合日常游玩",
    icon: Package,
  },
  snapshot: {
    title: "快照",
    description: "抢先体验开发中的新内容",
    icon: FlaskConical,
  },
  legacy: {
    title: "远古版本",
    description: "Beta 与 Alpha 历史版本",
    icon: Archive,
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
  onNotify: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
}

type CatalogCategory =
  | "versions"
  | "mod"
  | "modpack"
  | "shader"
  | "datapack"
  | "resourcepack";

const CATALOG_CATEGORIES: Array<{
  id: CatalogCategory;
  label: string;
  icon: typeof Package;
  desc: string;
}> = [
  { id: "versions", label: "游戏版本", icon: Package, desc: "原版核心与快照" },
  { id: "mod", label: "模组 (Mods)", icon: Layers3, desc: "功能与玩法扩展" },
  { id: "modpack", label: "整合包", icon: Archive, desc: "精选整合包" },
  { id: "shader", label: "光影包", icon: FlaskConical, desc: "画面与光影渲染" },
  { id: "datapack", label: "数据包", icon: Cpu, desc: "原版世界与规则" },
];

function VersionGlyph({ type }: { type: string }) {
  const Icon =
    type === "snapshot" ? FlaskConical : type === "release" ? Package : Archive;
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md border",
        type === "release"
          ? "border-primary/25 bg-primary/10 text-primary"
          : type === "snapshot"
            ? "border-gold/25 bg-gold/10 text-gold"
            : "border-border/70 bg-muted/50 text-muted-foreground",
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

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
  onNotify,
}: DownloadCatalogViewProps) {
  const [activeCategory, setActiveCategory] = useState<CatalogCategory>("versions");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<GroupId, boolean>>({
    release: true,
    snapshot: false,
    legacy: false,
  });
  const [limits, setLimits] = useState<Record<GroupId, number>>({
    release: 10,
    snapshot: 6,
    legacy: 4,
  });

  const installedMap = useMemo(
    () => new Map(installed.map((version) => [version.id, version])),
    [installed],
  );

  const groups = useMemo<Array<{ id: GroupId; items: VersionSummary[] }>>(() => {
    const needle = query.trim().toLowerCase();
    const matches = (version: VersionSummary) =>
      !needle || version.id.toLowerCase().includes(needle);

    const all = (manifest?.versions ?? []).filter(matches);

    return [
      { id: "release", items: all.filter((version) => version.type === "release") },
      {
        id: "snapshot",
        items: all.filter((version) => version.type === "snapshot"),
      },
      {
        id: "legacy",
        items: all.filter(
          (version) => version.type !== "release" && version.type !== "snapshot",
        ),
      },
    ];
  }, [manifest, query]);

  const counts = useMemo(() => {
    const byGroup = Object.fromEntries(
      groups.map((group) => [group.id, group.items.length]),
    ) as Record<GroupId, number>;
    return {
      ...byGroup,
      all: groups.reduce((total, group) => total + group.items.length, 0),
    };
  }, [groups]);

  const visibleGroups = groups.filter((group) => {
    if (filter === "all") return group.items.length > 0;
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
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-[10.5px] text-primary hover:bg-primary/10 hover:text-primary"
            onClick={(e) => {
              e.stopPropagation();
              onOpenVersionSelect();
            }}
            title="查看本地已安装版本"
          >
            <Check className="size-3" />
            已装原版
          </Button>
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
  const hasAnyResults = visibleGroups.some((group) => group.items.length > 0);

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
                  setLimits({ release: 10, snapshot: 6, legacy: 4 });
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
                      <Icon
                        className={cn(
                          "size-3.5",
                          active ? "text-primary" : "text-muted-foreground/70",
                        )}
                      />
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
              const open = openGroups[group.id] || Boolean(query.trim());
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
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60 text-primary">
                      <Icon className="size-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[12.5px] font-medium">{meta.title}</span>
                        <Badge
                          variant="outline"
                          className="h-4 min-w-5 justify-center border-border/80 px-1 font-mono text-[9px] font-normal text-muted-foreground"
                        >
                          {group.items.length}
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
                      {visible.map((version) => {
                        const local = installedMap.get(version.id);
                        const latest = manifest?.latest.release === version.id;
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
                            className="group flex cursor-pointer items-center gap-2 px-3.5 py-2.5 transition-colors hover:bg-muted/25"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <VersionGlyph type={version.type} />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="font-mono text-[12px] font-medium text-foreground">
                                    {version.id}
                                  </span>
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
                                <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                                  <span>发布于 {formatDate(version.releaseTime)}</span>
                                  <span className="text-border">/</span>
                                  <TypeBadge
                                    type={version.type}
                                    tone={typeTone(version.type)}
                                    label={typeLabel(version.type)}
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
                      {group.items.length > visible.length ? (
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
</div>
);
}
