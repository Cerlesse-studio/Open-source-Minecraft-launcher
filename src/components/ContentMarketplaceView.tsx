import { useEffect, useState } from "react";
import { cn } from "cn";
import {
  Archive,
  ArrowDownToLine,
  Boxes,
  ChevronRight,
  Download,
  FolderOpen,
  Heart,
  LoaderCircle,
  Package,
  PackageOpen,
  RefreshCw,
  Search,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { searchContent } from "../lib/backend";
import { ContentVersionSelectView } from "./ContentVersionSelectView";
import type {
  ContentHit,
  ContentProjectType,
  InstalledVersion,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface ContentMarketplaceViewProps {
  projectType: ContentProjectType;
  installed: InstalledVersion[];
  selectedVersion: string;
  gameRoot: string;
  onOpenFolder: (path: string) => void;
  onNotify: (
    tone: "success" | "error" | "info",
    title: string,
    detail?: string,
  ) => void;
}

const COMMON_MC_VERSIONS = [
  "all",
  "1.21.4",
  "1.21.1",
  "1.20.1",
  "1.19.4",
  "1.18.2",
  "1.16.5",
  "1.12.2",
];

const LOADERS = ["all", "fabric", "forge", "neoforge", "quilt"];

const SORTS: Array<{ id: string; label: string }> = [
  { id: "downloads", label: "最多下载" },
  { id: "updated", label: "最近更新" },
  { id: "newest", label: "最新发布" },
  { id: "relevance", label: "相关度" },
];

function formatCount(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return String(num);
}

function typeDestinationLabel(type: ContentProjectType, instanceId?: string): string {
  const target = instanceId ? `versions/${instanceId}/` : "";
  switch (type) {
    case "mod":
      return `${target}mods/`;
    case "shader":
      return `${target}shaderpacks/`;
    case "datapack":
      return `${target}datapacks/`;
    case "resourcepack":
      return `${target}resourcepacks/`;
    case "modpack":
      return "modpacks/";
    default:
      return "downloads/";
  }
}

export function ContentMarketplaceView({
  projectType,
  installed,
  selectedVersion,
  gameRoot,
  onOpenFolder,
  onNotify,
}: ContentMarketplaceViewProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [gameVersion, setGameVersion] = useState("all");
  const [loader, setLoader] = useState("all");
  const [sort, setSort] = useState("downloads");
  const [targetInstance, setTargetInstance] = useState(
    selectedVersion || (installed[0]?.id ?? ""),
  );

  const [hits, setHits] = useState<ContentHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalHits, setTotalHits] = useState(0);

  // Selected project to view on dedicated standalone page (no floating modal!)
  const [selectedProject, setSelectedProject] = useState<ContentHit | null>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 280);
    return () => clearTimeout(timer);
  }, [query]);

  // Keep target instance aligned if selectedVersion changes
  useEffect(() => {
    if (selectedVersion && installed.some((v) => v.id === selectedVersion)) {
      setTargetInstance(selectedVersion);
    } else if (installed.length > 0 && !targetInstance) {
      setTargetInstance(installed[0].id);
    }
  }, [selectedVersion, installed, targetInstance]);

  // Reset selected project when switching project type tab
  useEffect(() => {
    setSelectedProject(null);
  }, [projectType]);

  // Load content whenever query or filters change
  const doSearch = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await searchContent({
        query: debouncedQuery,
        projectType,
        gameVersion: gameVersion !== "all" ? gameVersion : undefined,
        loader: loader !== "all" ? loader : undefined,
        sort,
        limit: 28,
      });
      setHits(res.hits);
      setTotalHits(res.totalHits);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void doSearch();
  }, [projectType, debouncedQuery, gameVersion, loader, sort]);

  // If a project is selected, render the dedicated Standalone Page (No Floating Popup!)
  if (selectedProject) {
    return (
      <ContentVersionSelectView
        project={selectedProject}
        projectType={projectType}
        installed={installed}
        targetInstance={targetInstance}
        onChangeTargetInstance={setTargetInstance}
        gameRoot={gameRoot}
        initialGameVersion={gameVersion}
        initialLoader={loader}
        onBack={() => setSelectedProject(null)}
        onOpenFolder={onOpenFolder}
        onNotify={onNotify}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Search & Filter Toolbar */}
      <Card className="gap-0 border-border/70 bg-card/65 p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* Search Input */}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`在 Modrinth 搜索${
                projectType === "mod"
                  ? "模组 (如 JEI, Sodium, Create)…"
                  : projectType === "shader"
                    ? "光影包 (如 Complementary, BSL)…"
                    : projectType === "datapack"
                      ? "数据包 (如 Terralith, Incendium)…"
                      : projectType === "modpack"
                        ? "整合包 (如 Fabulously Optimized)…"
                        : "资源包…"
              }`}
              className="h-9 bg-background/55 pl-9 pr-8 text-[12px]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          {/* Filter Group */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Target Instance Picker (if mods/shaders/datapacks) */}
            {projectType !== "modpack" && installed.length > 0 ? (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/40 px-2 py-1">
                <span className="text-[10px] text-muted-foreground">安装到:</span>
                <select
                  value={targetInstance}
                  onChange={(e) => setTargetInstance(e.target.value)}
                  className="bg-transparent font-mono text-[11px] font-medium text-foreground outline-none"
                >
                  {installed.map((inst) => (
                    <option key={inst.id} value={inst.id} className="bg-popover text-popover-foreground">
                      {inst.id}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {/* Game Version Filter */}
            <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/40 px-2 py-1">
              <span className="text-[10px] text-muted-foreground">版本:</span>
              <select
                value={gameVersion}
                onChange={(e) => setGameVersion(e.target.value)}
                className="bg-transparent font-mono text-[11px] text-foreground outline-none"
              >
                {COMMON_MC_VERSIONS.map((v) => (
                  <option key={v} value={v} className="bg-popover text-popover-foreground">
                    {v === "all" ? "全部版本" : v}
                  </option>
                ))}
              </select>
            </div>

            {/* Loader Filter (for mods/modpacks) */}
            {(projectType === "mod" || projectType === "modpack") && (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/40 px-2 py-1">
                <span className="text-[10px] text-muted-foreground">加载器:</span>
                <select
                  value={loader}
                  onChange={(e) => setLoader(e.target.value)}
                  className="bg-transparent font-mono text-[11px] text-foreground outline-none capitalize"
                >
                  {LOADERS.map((l) => (
                    <option key={l} value={l} className="bg-popover text-popover-foreground">
                      {l === "all" ? "全部加载器" : l}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Sort Filter */}
            <div className="flex items-center gap-1.5 rounded-lg border border-border/70 bg-background/40 px-2 py-1">
              <span className="text-[10px] text-muted-foreground">排序:</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="bg-transparent text-[11px] text-foreground outline-none"
              >
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id} className="bg-popover text-popover-foreground">
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <Button
              variant="outline"
              size="icon-sm"
              className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => void doSearch()}
              disabled={loading}
              title="刷新列表"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {/* Destination folder path prompt */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between border-t border-border/40 pt-2 text-[10.5px] text-muted-foreground">
          <span>
            目标存储路径：
            <code className="rounded bg-muted/40 px-1 py-0.5 font-mono text-[10px] text-foreground/80">
              {typeDestinationLabel(projectType, targetInstance)}
            </code>
          </span>
          <button
            type="button"
            onClick={() =>
              onOpenFolder(
                `${gameRoot}/${typeDestinationLabel(projectType, targetInstance)}`,
              )
            }
            className="flex items-center gap-1 text-primary hover:underline"
          >
            <FolderOpen className="size-3" />
            打开对应文件夹
          </button>
        </div>
      </Card>

      {/* Results Header */}
      <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span>
          找到约 <strong className="font-mono text-foreground">{totalHits}</strong> 个资源
        </span>
        {loading ? (
          <span className="flex items-center gap-1.5 text-primary">
            <LoaderCircle className="size-3 animate-spin" />
            正在检索…
          </span>
        ) : null}
      </div>

      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-4 text-[12px] text-destructive">
          加载资源失败：{error}
        </Card>
      ) : null}

      {/* List of Content Items */}
      <div className="space-y-2">
        {hits.map((hit) => (
          <Card
            key={hit.projectId}
            role="button"
            tabIndex={0}
            onClick={() => setSelectedProject(hit)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setSelectedProject(hit);
              }
            }}
            className="group flex cursor-pointer flex-col gap-3 border-border/70 bg-card/55 p-3.5 transition-all hover:border-primary/45 hover:bg-card/85 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3.5">
              {hit.iconUrl ? (
                <img
                  src={hit.iconUrl}
                  alt={hit.title}
                  loading="lazy"
                  className="size-12 shrink-0 rounded-lg border border-border/60 bg-muted/20 object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                <div className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/30 text-muted-foreground">
                  {projectType === "mod" ? (
                    <Boxes className="size-5" />
                  ) : projectType === "shader" ? (
                    <Sparkles className="size-5" />
                  ) : projectType === "datapack" ? (
                    <Archive className="size-5" />
                  ) : (
                    <Package className="size-5" />
                  )}
                </div>
              )}

              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[13.5px] font-semibold text-foreground transition-colors group-hover:text-primary">
                    {hit.title}
                  </h3>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <UserRound className="size-3" />
                    {hit.author}
                  </span>
                  {hit.categories.slice(0, 3).map((c) => (
                    <Badge
                      key={c}
                      variant="outline"
                      className="h-4 border-border/60 bg-muted/20 px-1.5 text-[9px] font-normal text-muted-foreground/80"
                    >
                      {c}
                    </Badge>
                  ))}
                </div>

                <p className="line-clamp-1 text-[11.5px] leading-5 text-muted-foreground">
                  {hit.description || "暂无简介"}
                </p>

                <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground/80">
                  <span className="flex items-center gap-1 font-mono">
                    <ArrowDownToLine className="size-3 text-primary/80" />
                    {formatCount(hit.downloads)} 下载
                  </span>
                  {hit.follows ? (
                    <>
                      <span>·</span>
                      <span className="flex items-center gap-1 font-mono">
                        <Heart className="size-3 text-rose-500/80" />
                        {formatCount(hit.follows)} 关注
                      </span>
                    </>
                  ) : null}
                  {hit.versions.length > 0 ? (
                    <>
                      <span>·</span>
                      <span className="text-muted-foreground/60">
                        支持版本: {hit.versions.slice(0, 5).join(", ")}
                        {hit.versions.length > 5 ? ` 等 ${hit.versions.length} 个` : ""}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-border/80 px-3.5 text-[11px] text-muted-foreground transition-colors group-hover:border-primary/45 group-hover:bg-primary/10 group-hover:text-primary"
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedProject(hit);
                }}
              >
                <Download className="size-3" />
                选择版本
                <ChevronRight className="size-3 transition-transform group-hover:translate-x-0.5" />
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {!loading && hits.length === 0 && (
        <Card className="flex min-h-[220px] flex-col items-center justify-center p-8 text-center text-muted-foreground">
          <PackageOpen className="size-8 text-muted-foreground/50" />
          <p className="mt-2 text-[12.5px] font-medium text-foreground">没有找到匹配的资源</p>
          <p className="mt-1 text-[11px]">请尝试更换关键词或清除版本/加载器筛选限制。</p>
        </Card>
      )}
    </div>
  );
}
