import { useEffect, useRef, useState } from "react";
import { cn } from "cn";
import {
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
  Languages,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  Search,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { open as openDialog } from "@/lib/desktop";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ContentIcon } from "@/components/ui";

export interface ContentMarketplaceViewProps {
  projectType: ContentProjectType;
  installed?: InstalledVersion[];
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
  "基岩版",
  "1.21.4",
  "1.21.1",
  "1.20.1",
  "1.19.4",
  "1.18.2",
  "1.16.5",
  "1.12.2",
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

function typeDestinationLabel(type: ContentProjectType, bedrock: boolean): string {
  if (bedrock) {
    // Bedrock packs are deployed into the game data folder, not a Java
    // instance: the installer sorts them into resource_packs/behavior_packs.
    return type === "shader" || type === "resourcepack"
      ? "com.mojang/resource_packs"
      : "com.mojang/behavior_packs";
  }
  switch (type) {
    case "mod":
      // Mods live with their instance; there is no shared `mods/` folder.
      return "versions/<对应版本>/mods";
    case "shader":
      return "shaderpacks/";
    case "datapack":
      return "datapacks/";
    case "resourcepack":
      return "resourcepacks/";
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
  const [importing, setImporting] = useState(false);
  // Bedrock add-ons come from CurseForge instead of Modrinth.
  const [bedrockOnly, setBedrockOnly] = useState(false);
  const isBedrockSource = bedrockOnly || loader === "bedrock";

  // Java mods are installed into the instance they were built for, so the
  // destination pill follows the selected version instead of a shared folder.
  const modDestinationPath = selectedVersion
    ? `versions/${selectedVersion}/mods`
    : "versions/<对应版本>/mods";
  const modDestinationOpen = selectedVersion
    ? `${gameRoot}/${modDestinationPath}`
    : `${gameRoot}/versions`;

  const [hits, setHits] = useState<ContentHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalHits, setTotalHits] = useState(0);
  // English keywords the backend substituted for a non-English query.
  const [translatedQuery, setTranslatedQuery] = useState<string | null>(null);

  // Pagination states
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [jumpInput, setJumpInput] = useState("");
  const prevFilterRef = useRef({
    projectType,
    debouncedQuery,
    gameVersion,
    loader,
    sort,
    bedrockOnly,
  });

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
        gameVersion: !isBedrockSource && gameVersion !== "all" ? gameVersion : undefined,
        loader: isBedrockSource ? "bedrock" : loader !== "all" ? loader : undefined,
        sort,
        offset,
        limit: targetPageSize,
      });
      setHits(res.hits);
      setTotalHits(res.totalHits);
      setTranslatedQuery(res.translatedQuery ?? null);
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
      pf.sort !== sort ||
      pf.bedrockOnly !== bedrockOnly;

    if (filterChanged) {
      prevFilterRef.current = {
        projectType,
        debouncedQuery,
        gameVersion,
        loader,
        sort,
        bedrockOnly,
      };
      if (page !== 1) {
        setPage(1);
        return;
      }
    }

    void doSearch(page, pageSize);
  }, [projectType, debouncedQuery, gameVersion, loader, sort, bedrockOnly, page, pageSize]);

  // If a project is selected, render the dedicated Standalone Page (No Floating Popup!)
  if (selectedProject) {
    return (
      <ContentVersionSelectView
        project={selectedProject}
        projectType={projectType}
        gameRoot={gameRoot}
        initialGameVersion={gameVersion}
        initialLoader={isBedrockSource ? "bedrock" : loader}
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
              placeholder={
                isBedrockSource
                  ? "在 CurseForge 搜索基岩版附加包 (支持中文，如 家具/枪械/空岛)…"
                  : `在 Modrinth 搜索${
                      projectType === "mod"
                        ? "模组 (JEI、Sodium，支持中文，如 钠/机械动力)…"
                        : projectType === "shader"
                          ? "光影包 (Complementary、BSL，支持中文，如 光影)…"
                          : projectType === "datapack"
                            ? "数据包 (Terralith、Incendium，支持中文)…"
                            : projectType === "modpack"
                              ? "整合包 (支持中文，如 空岛/科技)…"
                              : "资源包 (支持中文，如 材质/卡通)…"
                    }`
              }
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
            {/* Bedrock catalogue toggle: CurseForge instead of Modrinth */}
            <Button
              variant={isBedrockSource ? "default" : "outline"}
              size="sm"
              className={cn(
                "h-8 gap-1.5 rounded-lg px-2.5 text-xs",
                !isBedrockSource &&
                  "border-border/70 bg-background/50 font-normal text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              onClick={() => {
                setBedrockOnly((current) => !current);
                setLoader("all");
                setGameVersion("all");
                setPage(1);
              }}
              title="切换基岩版资源库 (CurseForge)"
            >
              <Boxes className="size-3.5" />
              基岩版
            </Button>

            {/* Game Version Filter */}
            {!isBedrockSource ? (
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
            ) : (
              <Badge
                variant="outline"
                className="h-8 gap-1.5 rounded-lg border-primary/35 bg-primary/10 px-2.5 text-[11px] font-normal text-primary"
              >
                CurseForge · 基岩版全版本
              </Badge>
            )}

            {/* Loader Filter */}
            {!isBedrockSource && (projectType === "mod" || projectType === "modpack") && (
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

          {/* Target Directory Clickable Pill. Java mods are installed per
              instance, so they point at the selected version's own folder. */}
          <button
            type="button"
            onClick={() =>
              onOpenFolder(
                isBedrockSource
                  ? `${gameRoot}/bedrock/games/com.mojang`
                  : projectType === "mod"
                    ? modDestinationOpen
                    : `${gameRoot}/${typeDestinationLabel(projectType, false)}`,
              )
            }
            title="点击打开对应存储文件夹"
            className="group flex items-center gap-1.5 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
          >
            <FolderOpen className="size-3.5 text-primary/80 transition-transform group-hover:scale-110" />
            <span>目标:</span>
            <code className="font-mono text-[10.5px] text-foreground/85 transition-colors group-hover:text-primary">
              {isBedrockSource
                ? typeDestinationLabel(projectType, true)
                : projectType === "mod"
                  ? modDestinationPath
                  : typeDestinationLabel(projectType, false)}
            </code>
          </button>
        </div>

        {/* Multilingual search: the backend maps Chinese/Japanese/Korean/Russian
            keywords to English before querying, and reports what it used. */}
        {translatedQuery ? (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-border/40 pt-2 text-[10.5px] text-muted-foreground">
            <Languages className="size-3.5 shrink-0 text-primary/80" />
            <span>已识别为多语言关键词，按英文</span>
            <code className="rounded border border-border/60 bg-background/60 px-1.5 py-px font-mono text-[10px] text-foreground/85">
              {translatedQuery}
            </code>
            <span>搜索；若没有结果会自动改用原文。</span>
          </div>
        ) : null}
      </Card>

      {/* Results Header */}
      <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span>
          找到约 <strong className="font-mono text-foreground">{totalHits}</strong> 个资源
          {isBedrockSource ? (
            <span className="ml-1.5 text-primary/85">
              · 数据来源 CurseForge（基岩版 gameId 78022）
            </span>
          ) : null}
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
                setSelectedProject(hit);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedProject(hit);
                }
              }}
              className="group flex cursor-pointer flex-col gap-3 border-border/70 bg-card/55 p-3.5 transition-all hover:border-primary/45 hover:bg-card/85 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3.5">
                <ContentIcon
                  src={hit.iconUrl}
                  alt={hit.title}
                  projectType={projectType}
                  className="size-12"
                />

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[13.5px] font-semibold text-foreground transition-colors group-hover:text-primary">
                      {hit.title}
                    </h3>
                    {isBedrock ? (
                      <Badge className="h-4 border-0 bg-primary/15 px-1.5 text-[9px] font-medium text-primary">
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
