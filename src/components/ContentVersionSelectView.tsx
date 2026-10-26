import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import {
  ArrowDownToLine,
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  Heart,
  LoaderCircle,
  Package,
  RefreshCw,
  Search,
  UserRound,
  X,
} from "lucide-react";
import { downloadContentFile, getContentVersions } from "../lib/backend";
import { formatBytes, formatDate } from "../lib/format";
import type {
  ContentHit,
  ContentProjectType,
  ContentVersionItem,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ContentIcon } from "@/components/ui";

export interface ContentVersionSelectViewProps {
  project: ContentHit;
  projectType: ContentProjectType;
  gameRoot: string;
  initialGameVersion?: string;
  initialLoader?: string;
  onBack: () => void;
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

function projectTypeLabel(type: ContentProjectType): string {
  switch (type) {
    case "mod":
      return "模组";
    case "shader":
      return "光影包";
    case "datapack":
      return "数据包";
    case "resourcepack":
      return "资源包";
    case "modpack":
      return "整合包";
    default:
      return "资源";
  }
}

function typeDestinationPath(type: ContentProjectType): string {
  switch (type) {
    case "mod":
      return "mods/";
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

function formatCount(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return String(num);
}

export function ContentVersionSelectView({
  project,
  projectType,
  gameRoot,
  initialGameVersion = "all",
  initialLoader = "all",
  onBack,
  onOpenFolder,
  onNotify,
}: ContentVersionSelectViewProps) {
  const [gameVersion, setGameVersion] = useState(initialGameVersion);
  const [loader, setLoader] = useState(initialLoader);
  const [query, setQuery] = useState("");
  const [versions, setVersions] = useState<ContentVersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [downloadedSet, setDownloadedSet] = useState<Set<string>>(new Set());

  const loadVersions = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getContentVersions(
        project.projectId,
        gameVersion !== "all" ? gameVersion : undefined,
        loader !== "all" ? loader : undefined,
      );
      setVersions(list);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadVersions();
  }, [project.projectId, gameVersion, loader]);

  const filteredVersions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return versions;
    return versions.filter(
      (v) =>
        v.versionNumber.toLowerCase().includes(q) ||
        v.name.toLowerCase().includes(q) ||
        v.files.some((f) => f.filename.toLowerCase().includes(q)),
    );
  }, [versions, query]);

  const handleDownload = async (versionItem: ContentVersionItem) => {
    const file = versionItem.files.find((f) => f.primary) ?? versionItem.files[0];
    if (!file) {
      onNotify("error", "下载失败", "未找到可下载的文件链接");
      return;
    }
    setDownloadingIds((prev) => new Set(prev).add(versionItem.id));
    try {
      const res = await downloadContentFile({
        root: gameRoot,
        instanceId: undefined,
        projectType,
        url: file.url,
        filename: file.filename,
        sha1: file.sha1,
        size: file.size,
        title: project.title,
      });
      setDownloadedSet((prev) => new Set(prev).add(versionItem.id));
      onNotify(
        "success",
        `已成功下载 ${project.title} (${versionItem.versionNumber})`,
        `已保存至 ${res.filePath} (${formatBytes(res.bytes)})`,
      );
    } catch (err) {
      onNotify("error", `下载 ${project.title} 失败`, String(err));
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(versionItem.id);
        return next;
      });
    }
  };

  const destinationFolder = typeDestinationPath(projectType);

  return (
    <div className="space-y-4">
      {/* Top Project Banner & Navigation */}
      <Card className="gap-0 border-border/70 bg-card/75 p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <Button
              variant="outline"
              size="icon-sm"
              className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onBack}
              title={`返回${projectTypeLabel(projectType)}列表`}
            >
              <ArrowLeft className="size-4" />
            </Button>

            <ContentIcon
              src={project.iconUrl}
              alt={project.title}
              projectType={projectType}
              className="size-14 rounded-xl"
              iconClassName="size-6"
            />

            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[17px] font-bold text-foreground">
                  {project.title}
                </h1>
                <Badge
                  variant="outline"
                  className="h-4 border-primary/30 bg-primary/10 px-1.5 text-[9.5px] font-medium text-primary"
                >
                  {projectTypeLabel(projectType)}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <UserRound className="size-3" />
                  {project.author}
                </span>
                <span>·</span>
                <span className="flex items-center gap-1 font-mono">
                  <ArrowDownToLine className="size-3" />
                  {formatCount(project.downloads)} 下载
                </span>
                {project.follows ? (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1 font-mono">
                      <Heart className="size-3 text-rose-500/80" />
                      {formatCount(project.follows)} 关注
                    </span>
                  </>
                ) : null}
              </div>

              <p className="mt-1 max-w-2xl text-[11.5px] leading-5 text-muted-foreground">
                {project.description || "暂无简介"}
              </p>

              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {project.categories.map((c) => (
                  <Badge
                    key={c}
                    variant="outline"
                    className="h-4 border-border/60 bg-muted/20 px-1.5 text-[9.5px] text-muted-foreground/80"
                  >
                    {c}
                  </Badge>
                ))}
              </div>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 self-start text-[11.5px] text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeft className="size-3.5" />
            返回列表
          </Button>
        </div>
      </Card>

      {/* Target Instance & Filters Card */}
      <Card className="flex flex-col gap-3 border-border/70 bg-card/60 p-3.5 shadow-sm">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
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

            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0 rounded-lg border-border/70 text-muted-foreground shadow-xs hover:text-foreground"
              onClick={() => void loadVersions()}
              disabled={loading}
              title="重新刷新版本列表"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>

          {/* Quick search inside versions */}
          <div className="relative w-full shrink-0 sm:w-60">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索版本号或文件名…"
              className="h-8 rounded-lg border-border/70 bg-background/50 pl-8 pr-7 font-mono text-xs shadow-xs"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Directory Path indicator */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
          <span>文件将直接保存并激活于目标目录：</span>
          <button
            type="button"
            onClick={() => {
                onOpenFolder(`${gameRoot}/${destinationFolder}`);
              }}
            title="点击打开对应存储文件夹"
            className="group flex items-center gap-1.5 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
          >
            <FolderOpen className="size-3.5 text-primary/80 transition-transform group-hover:scale-110" />
            <span>目标:</span>
            <code className="font-mono text-[10.5px] text-foreground/85 transition-colors group-hover:text-primary">
              {destinationFolder}
            </code>
          </button>
        </div>
      </Card>

      {/* Version Items Count & Status */}
      <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span>
          共找到 <strong className="font-mono text-foreground">{filteredVersions.length}</strong> 个可下载构建
        </span>
        {loading ? (
          <span className="flex items-center gap-1.5 text-primary">
            <LoaderCircle className="size-3 animate-spin" />
            正在同步版本清单…
          </span>
        ) : null}
      </div>

      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-4 text-[12px] text-destructive">
          获取版本列表失败：{error}
        </Card>
      ) : null}

      {/* Version List */}
      <div className="space-y-2.5">
        {loading && versions.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Card key={i} className="h-20 animate-pulse border-border/60 bg-card/40" />
            ))}
          </div>
        ) : filteredVersions.length === 0 ? (
          <Card className="flex min-h-[220px] flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <Package className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-[12.5px] font-medium text-foreground">
              未找到匹配的可用构建
            </p>
            <p className="mt-1 text-[11px]">
              尝试将“游戏版本”或“加载器”重置为“全部”，或清除搜索筛选。
            </p>
          </Card>
        ) : (
          filteredVersions.map((v) => {
            const primaryFile = v.files.find((f) => f.primary) ?? v.files[0];
            const isBusy = downloadingIds.has(v.id);
            const isDownloaded = downloadedSet.has(v.id);

            return (
              <Card
                key={v.id}
                className="gap-0 border-border/70 bg-card/55 transition-colors hover:border-primary/35 hover:bg-card/75"
              >
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  {/* Left: Version Meta */}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[13px] font-semibold text-foreground">
                        {v.versionNumber}
                      </span>
                      {v.name && v.name !== v.versionNumber ? (
                        <span className="text-[12px] text-muted-foreground">
                          · {v.name}
                        </span>
                      ) : null}
                      {v.loaders.map((l) => (
                        <Badge
                          key={l}
                          variant="outline"
                          className="h-4 border-border/80 px-1.5 font-mono text-[9px] uppercase text-muted-foreground"
                        >
                          {l}
                        </Badge>
                      ))}
                    </div>

                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {primaryFile?.filename || "未命名文件"}
                    </p>

                    <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground/80">
                      {primaryFile?.size ? (
                        <span className="font-mono">{formatBytes(primaryFile.size)}</span>
                      ) : null}
                      {v.datePublished ? (
                        <>
                          <span>·</span>
                          <span>发布于 {formatDate(v.datePublished)}</span>
                        </>
                      ) : null}
                      {v.downloads ? (
                        <>
                          <span>·</span>
                          <span className="font-mono">{formatCount(v.downloads)} 次下载</span>
                        </>
                      ) : null}
                      {v.gameVersions.length > 0 ? (
                        <>
                          <span>·</span>
                          <span className="text-muted-foreground/60">
                            支持版本: {v.gameVersions.slice(0, 4).join(", ")}
                            {v.gameVersions.length > 4 ? ` 等 ${v.gameVersions.length} 个` : ""}
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {/* Right: Actions */}
                  <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
                    <Button
                      size="sm"
                      disabled={isBusy}
                      onClick={() => void handleDownload(v)}
                      className="h-8 gap-1.5 px-4 text-[11.5px]"
                    >
                      {isBusy ? (
                        <LoaderCircle className="size-3.5 animate-spin" />
                      ) : isDownloaded ? (
                        <Check className="size-3.5 text-primary" />
                      ) : (
                        <Download className="size-3.5" />
                      )}
                      {isBusy ? "下载中…" : isDownloaded ? "再次下载" : "下载到此实例"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
