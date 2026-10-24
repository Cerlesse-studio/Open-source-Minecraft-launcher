import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  Boxes,
  Check,
  Download,
  FolderOpen,
  Heart,
  LoaderCircle,
  Package,
  RefreshCw,
  Search,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { downloadContentFile, getContentVersions } from "../lib/backend";
import { formatBytes, formatDate } from "../lib/format";
import type {
  ContentHit,
  ContentProjectType,
  ContentVersionItem,
  InstalledVersion,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export interface ContentVersionSelectViewProps {
  project: ContentHit;
  projectType: ContentProjectType;
  installed: InstalledVersion[];
  targetInstance: string;
  onChangeTargetInstance: (instanceId: string) => void;
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
];

const LOADERS = ["all", "fabric", "forge", "neoforge", "quilt"];

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

function typeDestinationPath(type: ContentProjectType, instanceId?: string): string {
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
  installed,
  targetInstance,
  onChangeTargetInstance,
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
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
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
    setDownloadingId(versionItem.id);
    try {
      const res = await downloadContentFile({
        root: gameRoot,
        instanceId: projectType !== "modpack" ? targetInstance : undefined,
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
      setDownloadingId(null);
    }
  };

  const destinationFolder = typeDestinationPath(projectType, targetInstance);

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

            {project.iconUrl ? (
              <img
                src={project.iconUrl}
                alt={project.title}
                className="size-14 shrink-0 rounded-xl border border-border/70 bg-muted/20 object-cover"
              />
            ) : (
              <div className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted/30 text-muted-foreground">
                {projectType === "mod" ? (
                  <Boxes className="size-6" />
                ) : projectType === "shader" ? (
                  <Sparkles className="size-6" />
                ) : projectType === "datapack" ? (
                  <Archive className="size-6" />
                ) : (
                  <Package className="size-6" />
                )}
              </div>
            )}

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
      <Card className="gap-0 border-border/70 bg-card/60 p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2.5">
            {/* Target Instance Picker */}
            {projectType !== "modpack" && installed.length > 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-2.5 py-1">
                <span className="text-[11px] text-muted-foreground">安装到游戏实例:</span>
                <select
                  value={targetInstance}
                  onChange={(e) => onChangeTargetInstance(e.target.value)}
                  className="bg-transparent font-mono text-[11.5px] font-semibold text-foreground outline-none"
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
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-2.5 py-1">
              <span className="text-[11px] text-muted-foreground">游戏版本:</span>
              <select
                value={gameVersion}
                onChange={(e) => setGameVersion(e.target.value)}
                className="bg-transparent font-mono text-[11.5px] text-foreground outline-none"
              >
                {COMMON_MC_VERSIONS.map((v) => (
                  <option key={v} value={v} className="bg-popover text-popover-foreground">
                    {v === "all" ? "全部版本" : v}
                  </option>
                ))}
              </select>
            </div>

            {/* Loader Filter */}
            {(projectType === "mod" || projectType === "modpack") && (
              <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-background/50 px-2.5 py-1">
                <span className="text-[11px] text-muted-foreground">加载器:</span>
                <select
                  value={loader}
                  onChange={(e) => setLoader(e.target.value)}
                  className="bg-transparent font-mono text-[11.5px] text-foreground outline-none capitalize"
                >
                  {LOADERS.map((l) => (
                    <option key={l} value={l} className="bg-popover text-popover-foreground">
                      {l === "all" ? "全部加载器" : l}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <Button
              variant="outline"
              size="icon-sm"
              className="size-8 text-muted-foreground"
              onClick={() => void loadVersions()}
              disabled={loading}
              title="重新刷新版本列表"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>

          {/* Quick search inside versions */}
          <div className="relative w-full lg:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索版本号或文件名…"
              className="h-8 bg-background/50 pl-8 pr-7 font-mono text-[11px]"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Directory Path indicator */}
        <div className="mt-3 flex flex-wrap items-center justify-between border-t border-border/50 pt-2.5 text-[11px] text-muted-foreground">
          <span>
            文件将下载至：
            <code className="rounded bg-muted/40 px-1 py-0.5 font-mono text-[10.5px] text-foreground/90">
              {destinationFolder}
            </code>
          </span>
          <button
            type="button"
            onClick={() => onOpenFolder(`${gameRoot}/${destinationFolder}`)}
            className="flex items-center gap-1 text-primary hover:underline"
          >
            <FolderOpen className="size-3" />
            打开对应文件夹
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
            const isBusy = downloadingId === v.id;
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
