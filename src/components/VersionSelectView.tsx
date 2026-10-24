import { useMemo, useState } from "react";
import {
  Archive,
  Check,
  Download,
  FlaskConical,
  FolderCog,
  FolderOpen,
  Layers3,
  Package,
  PackageOpen,
  Play,
  Search,
  SlidersHorizontal,
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
import type { InstalledVersion, VersionManifest } from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader, TypeBadge } from "./ui";

type Filter = "all" | "release" | "snapshot" | "legacy";

const FILTERS: Array<{
  id: Filter;
  label: string;
  icon: typeof Layers3;
}> = [
  { id: "all", label: "全部已下载", icon: Layers3 },
  { id: "release", label: "正式版", icon: Package },
  { id: "snapshot", label: "快照", icon: FlaskConical },
  { id: "legacy", label: "远古版本", icon: Archive },
];

interface VersionSelectViewProps {
  manifest: VersionManifest | null;
  installed: InstalledVersion[];
  selectedVersion: string;
  gameRoot: string;
  onSelect: (versionId: string) => void;
  onPlay: (versionId: string) => void;
  onOpenVersionSettings: (versionId: string) => void;
  onOpenFolder: (path: string) => void;
  onOpenLauncherSettings: () => void;
  onOpenDownloadPage: () => void;
}

function installedDate(version: InstalledVersion): string {
  if (!version.installedAt) return "本地实例";
  return formatDate(new Date(version.installedAt * 1000).toISOString());
}

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

export function VersionSelectView({
  manifest,
  installed,
  selectedVersion,
  gameRoot,
  onSelect,
  onPlay,
  onOpenVersionSettings,
  onOpenFolder,
  onOpenLauncherSettings,
  onOpenDownloadPage,
}: VersionSelectViewProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => {
    const release = installed.filter((v) => v.type === "release").length;
    const snapshot = installed.filter((v) => v.type === "snapshot").length;
    const legacy = installed.filter(
      (v) => v.type !== "release" && v.type !== "snapshot",
    ).length;
    return {
      all: installed.length,
      release,
      snapshot,
      legacy,
    };
  }, [installed]);

  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return installed.filter((version) => {
      if (needle && !version.id.toLowerCase().includes(needle)) {
        return false;
      }
      if (filter === "all") return true;
      if (filter === "release") return version.type === "release";
      if (filter === "snapshot") return version.type === "snapshot";
      return version.type !== "release" && version.type !== "snapshot";
    });
  }, [filter, installed, query]);

  const activeFilterLabel =
    FILTERS.find((entry) => entry.id === filter)?.label ?? "全部已下载";

  return (
    <div className="space-y-5">
      <PageHeader
        title="版本选择"
        actions={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索已下载版本"
                aria-label="搜索已下载版本"
                spellCheck={false}
                className="h-8 w-[190px] border-border/80 bg-card/60 pl-8 pr-8 font-mono text-[11px]"
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
        }
      />

      <div className="grid items-start gap-4 min-[1000px]:grid-cols-[190px_minmax(0,1fr)] min-[1240px]:grid-cols-[206px_minmax(0,1fr)]">
        <aside className="space-y-3 min-[1000px]:sticky min-[1000px]:top-0">
          <Card className="gap-0 border-border/70 bg-card/55 py-0">
            <CardHeader className="border-b border-border/60 px-4 py-3">
              <CardTitle className="flex items-center gap-2 text-[12px] font-medium">
                <FolderCog className="size-3.5 text-primary" />
                游戏文件夹
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3">
              <div className="rounded-lg border border-primary/25 bg-primary/[0.045] p-2.5">
                <div className="flex items-center gap-1.5 text-[10px] font-medium text-primary">
                  <span className="size-1.5 rounded-[1px] bg-primary" />
                  当前文件夹
                </div>
                <p
                  className="mt-1.5 truncate font-mono text-[9.5px] text-muted-foreground"
                  title={gameRoot}
                >
                  {shortPath(gameRoot, 30)}
                </p>
                <div className="mt-2.5 grid grid-cols-2 gap-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 border-border/70 bg-background/40 px-1.5 text-[10px]"
                    onClick={() => onOpenFolder(gameRoot)}
                  >
                    <FolderOpen className="size-3" />
                    打开
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 border-border/70 bg-background/40 px-1.5 text-[10px]"
                    onClick={onOpenLauncherSettings}
                  >
                    <FolderCog className="size-3" />
                    更换
                  </Button>
                </div>
              </div>
              <dl className="mt-3 space-y-2 px-0.5">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-[10px] text-muted-foreground">已下载版本</dt>
                  <dd className="font-mono text-[10px] text-foreground/90">
                    {installed.length} 个版本
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <Card className="gap-0 border-border/70 bg-card/55 py-0">
            <CardHeader className="border-b border-border/60 px-4 py-3">
              <CardTitle className="flex items-center gap-2 text-[12px] font-medium">
                <Layers3 className="size-3.5 text-primary" />
                类型筛选
              </CardTitle>
            </CardHeader>
            <CardContent className="p-1.5">
              <div className="flex flex-col gap-0.5" role="list">
                {FILTERS.map((item) => {
                  const Icon = item.icon;
                  const active = filter === item.id;
                  const count = counts[item.id];
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setFilter(item.id)}
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
        </aside>

        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[13px] font-medium">{activeFilterLabel}</h2>
              <span className="font-mono text-[10px] text-muted-foreground/70">
                {filteredItems.length} 个版本
              </span>
            </div>
            <span className="text-[10px] text-muted-foreground/60">
              当前版本{" "}
              <span className="font-mono text-foreground/80">
                {selectedVersion || "未选择"}
              </span>
            </span>
          </div>

          {filteredItems.length === 0 ? (
            <Card className="grid min-h-[320px] place-items-center border-border/70 bg-card/45 px-6 py-12 text-center">
              <div className="max-w-xs">
                <div className="mx-auto flex size-11 items-center justify-center rounded-lg border border-border/70 bg-muted/30">
                  <PackageOpen className="size-5 text-muted-foreground/60" />
                </div>
                <h3 className="mt-3 text-[13px] font-medium">
                  {query
                    ? `没有找到包含“${query}”的已下载版本`
                    : installed.length === 0
                      ? "还没有下载任何游戏版本"
                      : "该分类下没有已下载的版本"}
                </h3>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {query
                    ? "换一个关键词，或清除搜索查看全部已下载版本。"
                    : "版本选择页仅展示已下载到本地的版本。如需获取新版本，请前往下载页面。"}
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {query ? (
                    <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                      清除搜索
                    </Button>
                  ) : filter !== "all" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFilter("all")}
                    >
                      查看全部已下载
                    </Button>
                  ) : null}
                  <Button size="sm" className="gap-1.5" onClick={onOpenDownloadPage}>
                    <Download className="size-3.5" />
                    前往下载页面
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <Card className="gap-0 overflow-hidden border-border/70 bg-card/55 py-0">
              <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60 text-primary">
                  <Check className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium">已下载游戏版本</span>
                    <Badge
                      variant="outline"
                      className="h-4 min-w-5 justify-center border-border/80 px-1 font-mono text-[9px] font-normal text-muted-foreground"
                    >
                      {filteredItems.length}
                    </Badge>
                  </div>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                    点击版本切换当前实例，或直接启动游戏
                  </span>
                </div>
              </div>

              <div className="divide-y divide-border/40">
                {filteredItems.map((version) => {
                  const isSelected = selectedVersion === version.id;
                  const latest = manifest?.latest.release === version.id;
                  return (
                    <div
                      key={version.id}
                      className={cn(
                        "flex items-center gap-2 px-3.5 py-2.5 transition-colors hover:bg-muted/20",
                        isSelected && "bg-primary/[0.045]",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => onSelect(version.id)}
                        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        aria-pressed={isSelected}
                      >
                        <VersionGlyph type={version.type} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono text-[12px] font-medium text-foreground">
                              {version.id}
                            </span>
                            {isSelected ? (
                              <Badge className="h-4 gap-0.5 rounded-[4px] border-0 bg-primary/15 px-1.5 text-[9px] font-normal text-primary">
                                <Check className="size-2.5" />
                                当前
                              </Badge>
                            ) : null}
                            {latest ? (
                              <Badge className="h-4 rounded-[4px] border-0 bg-gold/15 px-1.5 text-[9px] font-normal text-gold">
                                最新
                              </Badge>
                            ) : null}
                            <Badge
                              variant="outline"
                              className="h-4 rounded-[4px] border-primary/25 bg-primary/5 px-1.5 text-[9px] font-normal text-primary"
                            >
                              已安装
                            </Badge>
                            {version.loader ? (
                              <Badge
                                variant="outline"
                                className="h-4 rounded-[4px] border-border/80 bg-muted/40 px-1.5 font-mono text-[9px] font-normal text-foreground/85 uppercase"
                              >
                                {version.loader}
                                {version.loaderVersion ? ` ${version.loaderVersion}` : ""}
                              </Badge>
                            ) : null}
                            {version.optifineVersion ? (
                              <Badge
                                variant="outline"
                                className="h-4 rounded-[4px] border-gold/30 bg-gold/10 px-1.5 font-mono text-[9px] font-normal text-gold"
                              >
                                OptiFine {version.optifineVersion}
                              </Badge>
                            ) : null}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            <span>安装于 {installedDate(version)}</span>
                            <span className="text-border">/</span>
                            <TypeBadge
                              type={version.type}
                              tone={typeTone(version.type)}
                              label={typeLabel(version.type)}
                            />
                          </span>
                        </span>
                      </button>

                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-7 text-muted-foreground"
                          onClick={() =>
                            onOpenFolder(joinPath(gameRoot, "versions", version.id))
                          }
                          title="打开版本目录"
                          aria-label={`打开 ${version.id} 的版本目录`}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-7 text-muted-foreground"
                          onClick={() => onOpenVersionSettings(version.id)}
                          title="打开版本设置"
                          aria-label={`打开 ${version.id} 的版本设置`}
                        >
                          <SlidersHorizontal className="size-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 gap-1.5 px-2.5 text-[11px]"
                          onClick={() => onPlay(version.id)}
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
    </div>
  );
}
