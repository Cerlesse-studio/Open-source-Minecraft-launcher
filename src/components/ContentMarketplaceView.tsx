import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import {
  Archive,
  ArrowDownToLine,
  ArrowUpDown,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
  FolderOpen,
  Heart,
  LoaderCircle,
  Package,
  PackageOpen,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { installBedrockPack, isDesktop, searchContent } from "../lib/backend";
import { ContentVersionSelectView } from "./ContentVersionSelectView";
import type {
  ContentHit,
  ContentProjectType,
  InstalledVersion,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  "基岩版",
];

const LOADERS = ["all", "fabric", "forge", "neoforge", "quilt", "bedrock"];

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
  if (instanceId === "bedrock") {
    switch (type) {
      case "shader":
        return "bedrock/games/com.mojang/resource_packs/ (基岩版光影)";
      case "mod":
        return "bedrock/games/com.mojang/behavior_packs/ (基岩版模组)";
      default:
        return "bedrock/games/com.mojang/";
    }
  }
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

function getPaginationRange(current: number, total: number, maxVisible = 7): Array<number | "..."> {
  if (total <= maxVisible) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const side = 2;
  const left = Math.max(2, current - side);
  const right = Math.min(total - 1, current + side);

  const range: Array<number | "..."> = [1];
  if (left > 2) {
    range.push("...");
  }
  for (let i = left; i <= right; i++) {
    range.push(i);
  }
  if (right < total - 1) {
    range.push("...");
  }
  range.push(total);
  return range;
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
    selectedVersion || (installed[0]?.id ?? "bedrock"),
  );
  const [importing, setImporting] = useState(false);

  const [hits, setHits] = useState<ContentHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalHits, setTotalHits] = useState(0);

  // Pagination states
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [jumpInput, setJumpInput] = useState("");
  const prevFilterRef = useRef({ projectType, debouncedQuery, gameVersion, loader, sort });

  const totalPages = Math.max(1, Math.ceil(totalHits / pageSize));
  const currentPage = Math.min(page, totalPages);

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

  const handleImportLocal = async () => {
    try {
      let selectedPath: string | null = null;
      if (isDesktop) {
        const file = await openDialog({
          title: "选择基岩版模组或光影包 (.mcpack / .mcaddon / .zip)",
          multiple: false,
          filters: [
            {
              name: "Minecraft Bedrock Packs",
              extensions: ["mcpack", "mcaddon", "zip"],
            },
          ],
        });
        if (typeof file === "string") {
          selectedPath = file;
        }
      } else {
        selectedPath = "C:\\Users\\demo\\Downloads\\Addon.mcaddon";
      }

      if (!selectedPath) return;

      setImporting(true);
      const res = await installBedrockPack(selectedPath, undefined, gameRoot);
      onNotify("success", `本地导入成功 (${res.packType})`, res.message);
    } catch (e) {
      onNotify("error", "导入本地文件失败", String(e));
    } finally {
      setImporting(false);
    }
  };

  // Load content whenever query, filters, or page change
  const doSearch = async (targetPage = page, targetPageSize = pageSize) => {
    setLoading(true);
    setError(null);
    try {
      const offset = (targetPage - 1) * targetPageSize;
      const res = await searchContent({
        query: debouncedQuery,
        projectType,
        gameVersion: gameVersion !== "all" ? gameVersion : undefined,
        loader: loader !== "all" ? loader : undefined,
        sort,
        offset,
        limit: targetPageSize,
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
    const pf = prevFilterRef.current;
    const filterChanged =
      pf.projectType !== projectType ||
      pf.debouncedQuery !== debouncedQuery ||
      pf.gameVersion !== gameVersion ||
      pf.loader !== loader ||
      pf.sort !== sort;

    if (filterChanged) {
      prevFilterRef.current = { projectType, debouncedQuery, gameVersion, loader, sort };
      if (page !== 1) {
        setPage(1);
        return;
      }
    }

    void doSearch(page, pageSize);
  }, [projectType, debouncedQuery, gameVersion, loader, sort, page, pageSize]);

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
      <Card className="flex flex-col gap-3 border-border/70 bg-card/65 p-3.5 shadow-sm">
        {/* Row 1: Search & Action Controls */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
              className="h-10 rounded-xl border-border/70 bg-background/60 pl-9 pr-9 text-xs shadow-xs focus-visible:ring-1"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              className="h-10 gap-1.5 rounded-xl border-border/70 px-3.5 text-xs text-muted-foreground shadow-xs hover:text-foreground"
              onClick={handleImportLocal}
              disabled={importing}
              title="导入本地 .mcpack / .mcaddon / .zip"
            >
              {importing ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5 text-primary" />
              )}
              <span>导入本地包</span>
            </Button>

            <Button
              variant="outline"
              size="icon"
              className="size-10 shrink-0 rounded-xl border-border/70 text-muted-foreground shadow-xs hover:text-foreground"
              onClick={() => void doSearch()}
              disabled={loading}
              title="刷新列表"
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        {/* Row 2: Filter Pills & Folder Path */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {/* Target Instance Picker */}
            {projectType !== "modpack" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg border-border/70 bg-background/50 px-2.5 text-xs font-normal hover:bg-accent/60"
                  >
                    <span className="text-[11px] text-muted-foreground">安装到:</span>
                    <span
                      className={cn(
                        "font-medium",
                        targetInstance === "bedrock"
                          ? "font-semibold text-emerald-400"
                          : "font-mono text-foreground",
                      )}
                    >
                      {targetInstance === "bedrock"
                        ? "基岩版 (com.mojang)"
                        : `Java: ${targetInstance}`}
                    </span>
                    <ChevronDown className="size-3 text-muted-foreground opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                    选择安装目标
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={() => setTargetInstance("bedrock")}
                    className="flex cursor-pointer items-center justify-between text-xs font-medium text-emerald-400"
                  >
                    <span>基岩版 (com.mojang)</span>
                    {targetInstance === "bedrock" && (
                      <Check className="size-3.5 text-emerald-400" />
                    )}
                  </DropdownMenuItem>
                  {installed.length > 0 && <DropdownMenuSeparator />}
                  {installed.map((inst) => (
                    <DropdownMenuItem
                      key={inst.id}
                      onClick={() => setTargetInstance(inst.id)}
                      className="flex cursor-pointer items-center justify-between font-mono text-xs"
                    >
                      <span>Java: {inst.id}</span>
                      {targetInstance === inst.id && (
                        <Check className="size-3.5 text-primary" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {/* Game Version Filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 rounded-lg border-border/70 bg-background/50 px-2.5 text-xs font-normal hover:bg-accent/60"
                >
                  <span className="text-[11px] text-muted-foreground">版本:</span>
                  <span className="font-mono font-medium text-foreground">
                    {gameVersion === "all" ? "全部版本" : gameVersion}
                  </span>
                  <ChevronDown className="size-3 text-muted-foreground opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 w-40 overflow-y-auto">
                <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                  选择游戏版本
                </DropdownMenuLabel>
                {COMMON_MC_VERSIONS.map((v) => (
                  <DropdownMenuItem
                    key={v}
                    onClick={() => setGameVersion(v)}
                    className="flex cursor-pointer items-center justify-between font-mono text-xs"
                  >
                    <span>{v === "all" ? "全部版本" : v}</span>
                    {gameVersion === v && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Loader Filter */}
            {(projectType === "mod" || projectType === "modpack") && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg border-border/70 bg-background/50 px-2.5 text-xs font-normal hover:bg-accent/60"
                  >
                    <span className="text-[11px] text-muted-foreground">加载器:</span>
                    <span className="font-mono font-medium capitalize text-foreground">
                      {loader === "all"
                        ? "全部加载器"
                        : loader === "bedrock"
                          ? "基岩版 (Bedrock)"
                          : loader}
                    </span>
                    <ChevronDown className="size-3 text-muted-foreground opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44">
                  <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                    选择模组加载器
                  </DropdownMenuLabel>
                  {LOADERS.map((l) => (
                    <DropdownMenuItem
                      key={l}
                      onClick={() => setLoader(l)}
                      className="flex cursor-pointer items-center justify-between font-mono text-xs capitalize"
                    >
                      <span>
                        {l === "all"
                          ? "全部加载器"
                          : l === "bedrock"
                            ? "基岩版 (Bedrock)"
                            : l}
                      </span>
                      {loader === l && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* Sort Filter */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 rounded-lg border-border/70 bg-background/50 px-2.5 text-xs font-normal hover:bg-accent/60"
                >
                  <ArrowUpDown className="size-3 text-muted-foreground" />
                  <span className="text-[11px] text-muted-foreground">排序:</span>
                  <span className="font-medium text-foreground">
                    {SORTS.find((s) => s.id === sort)?.label || "最多下载"}
                  </span>
                  <ChevronDown className="size-3 text-muted-foreground opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-36">
                <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                  排序方式
                </DropdownMenuLabel>
                {SORTS.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => setSort(s.id)}
                    className="flex cursor-pointer items-center justify-between text-xs"
                  >
                    <span>{s.label}</span>
                    {sort === s.id && <Check className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Target Directory Clickable Pill */}
          <button
            type="button"
            onClick={() =>
              onOpenFolder(
                `${gameRoot}/${typeDestinationLabel(projectType, targetInstance)}`,
              )
            }
            title="点击打开对应存储文件夹"
            className="group flex items-center gap-1.5 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
          >
            <FolderOpen className="size-3.5 text-primary/80 transition-transform group-hover:scale-110" />
            <span>目标:</span>
            <code className="font-mono text-[10.5px] text-foreground/85 transition-colors group-hover:text-primary">
              {typeDestinationLabel(projectType, targetInstance)}
            </code>
          </button>
        </div>
      </Card>

      {/* Results Header */}
      <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span>
          找到约 <strong className="font-mono text-foreground">{totalHits}</strong> 个资源
          {totalHits > 0 ? (
            <span className="ml-1 text-muted-foreground/75">
              (第 {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, totalHits)} 项)
            </span>
          ) : null}
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
        {hits.map((hit) => {
          const isBedrock =
            hit.categories.includes("bedrock") ||
            hit.categories.includes("基岩版") ||
            hit.versions.includes("基岩版");
          return (
            <Card
              key={hit.projectId}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (isBedrock) {
                  setTargetInstance("bedrock");
                }
                setSelectedProject(hit);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  if (isBedrock) {
                    setTargetInstance("bedrock");
                  }
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
                    {isBedrock ? (
                      <Badge className="h-4 border-0 bg-emerald-500/15 px-1.5 text-[9px] font-medium text-emerald-400">
                        基岩版
                      </Badge>
                    ) : null}
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <UserRound className="size-3" />
                      {hit.author}
                    </span>
                    {hit.categories
                      .filter((c) => c !== "bedrock" && c !== "基岩版")
                      .slice(0, 3)
                      .map((c) => (
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
                    if (isBedrock) {
                      setTargetInstance("bedrock");
                    }
                    setSelectedProject(hit);
                  }}
                >
                  <Download className="size-3" />
                  选择版本
                  <ChevronRight className="size-3 transition-transform group-hover:translate-x-0.5" />
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Bottom Pagination Controls */}
      {totalPages > 1 && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-border/70 bg-card/65 p-3 shadow-xs">
          {/* Left: Summary & Per-Page Selector */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>
              第 <strong className="font-mono text-foreground">{currentPage}</strong> /{" "}
              <span className="font-mono">{totalPages}</span> 页 · 共{" "}
              <strong className="font-mono text-foreground">{totalHits}</strong> 项
            </span>

            <div className="flex items-center gap-1.5 border-l border-border/60 pl-3">
              <span className="text-[11px]">每页</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 rounded-md border-border/70 bg-background/60 px-2 font-mono text-[11px]"
                  >
                    <span>{pageSize} 条</span>
                    <ChevronDown className="size-3 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-24">
                  {[10, 20, 30, 50].map((sz) => (
                    <DropdownMenuItem
                      key={sz}
                      onClick={() => {
                        setPageSize(sz);
                        setPage(1);
                      }}
                      className="font-mono text-xs cursor-pointer"
                    >
                      {sz} 条/页
                      {pageSize === sz && <Check className="ml-auto size-3 text-primary" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Center: Page Navigation Buttons */}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              className="size-7 rounded-md"
              disabled={currentPage <= 1 || loading}
              onClick={() => {
                setPage(1);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              title="第一页"
            >
              <ChevronsLeft className="size-3.5" />
            </Button>

            <Button
              variant="outline"
              size="icon-xs"
              className="size-7 rounded-md"
              disabled={currentPage <= 1 || loading}
              onClick={() => {
                setPage((p) => Math.max(1, p - 1));
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              title="上一页"
            >
              <ChevronLeft className="size-3.5" />
            </Button>

            <div className="flex items-center gap-1 px-1">
              {getPaginationRange(currentPage, totalPages).map((p, idx) => {
                if (p === "...") {
                  return (
                    <span
                      key={`dots-${idx}`}
                      className="px-1 text-xs text-muted-foreground select-none"
                    >
                      …
                    </span>
                  );
                }
                const isActive = p === currentPage;
                return (
                  <Button
                    key={p}
                    variant={isActive ? "default" : "outline"}
                    size="xs"
                    className={cn(
                      "size-7 min-w-7 rounded-md p-0 font-mono text-xs",
                      isActive
                        ? "shadow-xs font-semibold"
                        : "border-border/70 text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => {
                      setPage(p);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  >
                    {p}
                  </Button>
                );
              })}
            </div>

            <Button
              variant="outline"
              size="icon-xs"
              className="size-7 rounded-md"
              disabled={currentPage >= totalPages || loading}
              onClick={() => {
                setPage((p) => Math.min(totalPages, p + 1));
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              title="下一页"
            >
              <ChevronRight className="size-3.5" />
            </Button>

            <Button
              variant="outline"
              size="icon-xs"
              className="size-7 rounded-md"
              disabled={currentPage >= totalPages || loading}
              onClick={() => {
                setPage(totalPages);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              title="最后一页"
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>

          {/* Right: Quick Jump */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="text-[11px]">前往</span>
            <Input
              value={jumpInput}
              onChange={(e) => setJumpInput(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const target = parseInt(jumpInput, 10);
                  if (target >= 1 && target <= totalPages) {
                    setPage(target);
                    setJumpInput("");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }
                }
              }}
              placeholder={String(currentPage)}
              className="h-7 w-12 rounded-md border-border/70 bg-background/60 px-1 text-center font-mono text-[11px]"
            />
            <span className="text-[11px]">页</span>
            <Button
              variant="ghost"
              size="xs"
              className="h-7 px-2 text-[11px]"
              onClick={() => {
                const target = parseInt(jumpInput, 10);
                if (target >= 1 && target <= totalPages) {
                  setPage(target);
                  setJumpInput("");
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }
              }}
            >
              跳转
            </Button>
          </div>
        </Card>
      )}

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
