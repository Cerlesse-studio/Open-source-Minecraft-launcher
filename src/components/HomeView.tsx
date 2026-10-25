import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Layers3,
  LoaderCircle,
  LogIn,
  Newspaper,
  Play,
  RefreshCw,
  SlidersHorizontal,
  Square,
  UserRound,
} from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, progressPercent } from "../lib/format";
import {
  channelLabel,
  getPatchNotes,
  isRelease,
  type PatchNote,
} from "../lib/news";
import {
  getBedrockStatus,
  launchBedrock,
} from "../lib/backend";
import type {
  BedrockStatus,
  GameEdition,
  GameStateName,
  InstallProgress,
  InstalledVersion,
} from "../lib/types";
import { Avatar, GrassBlock, StatusDot, TypeBadge } from "./ui";

interface RuntimeView {
  status: GameStateName;
  detail?: string | null;
  pid?: number | null;
  versionId?: string | null;
}

interface HomeViewProps {
  installed: InstalledVersion[];
  selectedVersion: string;
  playerName: string;
  onPlayerNameChange: (name: string) => void;
  runtime: RuntimeView;
  launchProgress: InstallProgress | null;
  onLaunch: () => void;
  onStop: () => void;
  onOpenVersionSelect: () => void;
  onOpenVersionSettings: () => void;
  gameRoot?: string;
  onOpenDownloadBedrock?: () => void;
  onNotify?: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
  edition?: GameEdition;
  onEditionChange?: (edition: GameEdition) => void;
  selectedBedrockVersion?: string;
}

function NewsFallback({ size = 28 }: { size?: number }) {
  return (
    <div className="relative grid h-full w-full place-items-center overflow-hidden bg-[#0b110c]">
      <div className="world-grid absolute inset-0 opacity-40" />
      <GrassBlock size={size} className="relative opacity-75" />
    </div>
  );
}

function NewsCover({
  note,
  eager = false,
}: {
  note: PatchNote;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [note.imageUrl]);

  if (!note.imageUrl || failed) {
    return <NewsFallback size={eager ? 52 : 22} />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0b110c]">
      {!loaded ? (
        <div className="absolute inset-0">
          <NewsFallback size={eager ? 52 : 22} />
        </div>
      ) : null}
      <img
        src={note.imageUrl}
        alt=""
        loading={eager ? "eager" : "lazy"}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          "relative h-full w-full object-cover transition-opacity duration-500",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function NewsSkeleton() {
  return (
    <div className="space-y-4 p-5" aria-hidden="true">
      <Skeleton className="h-[260px] w-full rounded-lg" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
      <div className="space-y-2 pt-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton className="h-10 w-14 shrink-0 rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HomeView({
  installed,
  selectedVersion,
  playerName,
  onPlayerNameChange,
  runtime,
  launchProgress,
  onLaunch,
  onStop,
  onOpenVersionSelect,
  onOpenVersionSettings,
  gameRoot,
  onOpenDownloadBedrock,
  onNotify,
  edition: _controlledEdition,
  onEditionChange: _onEditionChange,
  selectedBedrockVersion = "uwp",
}: HomeViewProps) {
  const [bedrockStatus, setBedrockStatus] = useState<BedrockStatus | null>(null);
  const [bedrockLaunching, setBedrockLaunching] = useState(false);
  const [news, setNews] = useState<PatchNote[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const refreshBedrockStatus = useCallback(async () => {
    try {
      const s = await getBedrockStatus(gameRoot);
      setBedrockStatus(s);
    } catch {
      // ignore
    }
  }, [gameRoot]);

  useEffect(() => {
    void refreshBedrockStatus();
  }, [refreshBedrockStatus]);

  const handleLaunchBedrock = async () => {
    setBedrockLaunching(true);
    try {
      const target =
        selectedBedrockVersion === "uwp" || !selectedBedrockVersion
          ? undefined
          : selectedBedrockVersion;
      const msg = await launchBedrock(target, gameRoot);
      onNotify?.("success", "已唤起 Minecraft 基岩版", msg);
    } catch (e) {
      onNotify?.("error", "启动基岩版失败", String(e));
    } finally {
      setBedrockLaunching(false);
    }
  };

  const loadNews = useCallback(async (force = false) => {
    setNewsLoading(true);
    setNewsError(null);
    try {
      const entries = await getPatchNotes(force);
      setNews(entries);
      setActiveId((current) =>
        current && entries.some((entry) => entry.id === current)
          ? current
          : (entries[0]?.id ?? null),
      );
    } catch (error) {
      setNewsError(String(error));
    } finally {
      setNewsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNews();
  }, [loadNews]);

  const activeNews = useMemo(
    () => news.find((entry) => entry.id === activeId) ?? news[0] ?? null,
    [news, activeId],
  );

  const installedVersion = installed.find((entry) => entry.id === selectedVersion);
  const isInstalled = Boolean(installedVersion);
  const isLaunching = runtime.status === "preparing";
  const isRunning = runtime.status === "running";
  const nameInvalid = !/^[A-Za-z0-9_]{1,16}$/.test(playerName.trim());
  const activeProgress = isLaunching ? launchProgress : null;
  const percent = activeProgress
    ? progressPercent(activeProgress.done, activeProgress.total)
    : null;

  const statusTone = isRunning
    ? "live"
    : isLaunching
      ? "pending"
      : isInstalled
        ? "online"
        : "warn";
  const statusLabel = isRunning
    ? "游戏运行中"
    : isLaunching
      ? activeProgress?.detail || runtime.detail || "正在检查运行环境"
      : isInstalled
        ? "准备就绪，随时出发"
        : selectedVersion
          ? "此版本尚未安装"
          : "还没有可启动的版本";
  const launchLabel = isRunning
    ? "结束游戏"
    : isLaunching
      ? "正在启动…"
      : "启动游戏";

  return (
    <div className="relative z-10 h-full overflow-y-auto p-4 min-[900px]:overflow-hidden">
      <div className="grid min-h-full gap-4 min-[900px]:h-full min-[900px]:min-h-0 min-[900px]:grid-cols-[minmax(0,1fr)_338px]">
        <section
          aria-label="我的世界更新新闻"
          className="flex min-h-[560px] flex-col overflow-hidden rounded-xl border border-border/70 bg-card/45 min-[900px]:min-h-0"
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/60 px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60">
                <Newspaper className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                  我的世界更新新闻
                </h1>
                <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                  Mojang 官方 Java 版更新日志
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="hidden items-center gap-1.5 text-[10px] text-muted-foreground min-[1160px]:flex">
                <StatusDot tone={newsError ? "warn" : "online"} />
                {newsError ? "同步失败" : "官方同步"}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => void loadNews(true)}
                disabled={newsLoading}
                aria-label="刷新更新新闻"
                title="刷新更新新闻"
              >
                <RefreshCw className={cn("size-3.5", newsLoading && "animate-spin")} />
              </Button>
            </div>
          </header>

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            aria-busy={newsLoading && news.length === 0}
          >
            {newsLoading && news.length === 0 ? (
              <NewsSkeleton />
            ) : newsError && news.length === 0 ? (
              <div className="grid min-h-[420px] place-items-center px-8 py-12 text-center">
                <div className="max-w-xs">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-gold/25 bg-gold/10">
                    <AlertTriangle className="size-4 text-gold" />
                  </div>
                  <h2 className="mt-4 text-[15px] font-medium">更新新闻暂时不可用</h2>
                  <p className="mt-1.5 text-[11.5px] leading-5 text-muted-foreground">
                    无法连接 Mojang 更新服务。检查网络后重试，不影响启动游戏。
                  </p>
                  <p
                    className="mt-2 break-words font-mono text-[10px] text-muted-foreground/60"
                    title={newsError}
                  >
                    {newsError}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 gap-2"
                    onClick={() => void loadNews(true)}
                  >
                    <RefreshCw className="size-3.5" />
                    重新加载
                  </Button>
                </div>
              </div>
            ) : activeNews ? (
              <>
                <article className="border-b border-border/60">
                  <div className="relative h-[260px] w-full overflow-hidden bg-muted">
                    <NewsCover note={activeNews} eager />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#070b08] via-[#070b08]/45 to-transparent" />
                    <div className="absolute inset-x-0 bottom-0 p-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <TypeBadge
                          type={activeNews.type}
                          tone={isRelease(activeNews) ? "grass" : "gold"}
                          label={channelLabel(activeNews)}
                        />
                        <span className="font-mono text-[10px] text-white/70">
                          {activeNews.version}
                        </span>
                        <span className="h-3 w-px bg-white/20" />
                        <time
                          dateTime={activeNews.date || undefined}
                          className="text-[10.5px] text-white/60"
                        >
                          {formatDate(activeNews.date)}
                        </time>
                        <span className="ml-auto hidden text-[10px] text-white/45 sm:inline">
                          Java Edition
                        </span>
                      </div>
                      <h2
                        lang="en"
                        className="mt-2.5 line-clamp-2 max-w-[70ch] text-[22px] font-semibold leading-[1.18] tracking-[-0.02em] text-white text-balance"
                      >
                        {activeNews.title}
                      </h2>
                    </div>
                  </div>
                  {activeNews.summary ? (
                    <div className="px-5 py-3.5">
                      <p
                        lang="en"
                        className="line-clamp-2 max-w-[82ch] text-[12px] leading-5 text-muted-foreground"
                      >
                        {activeNews.summary}
                      </p>
                    </div>
                  ) : null}
                </article>

                <div className="p-2">
                  <div className="flex items-center justify-between gap-3 px-3 pb-1.5 pt-2">
                    <h2 className="text-[11px] font-medium text-muted-foreground">
                      最近更新
                    </h2>
                    <span className="font-mono text-[10px] text-muted-foreground/60">
                      {news.length} 条
                    </span>
                  </div>
                  <div className="flex flex-col">
                    {news.slice(0, 8).map((note) => {
                      const active = note.id === activeNews.id;
                      return (
                        <button
                          key={note.id}
                          type="button"
                          onClick={() => setActiveId(note.id)}
                          aria-current={active ? "true" : undefined}
                          className={cn(
                            "group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors",
                            "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/60",
                            active && "bg-accent/60",
                          )}
                        >
                          <div className="h-9 w-14 shrink-0 overflow-hidden rounded-[5px] border border-border/60 bg-background/60">
                            <NewsCover note={note} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p
                              lang="en"
                              className={cn(
                                "truncate text-[11.5px] text-foreground/85",
                                active && "text-foreground",
                              )}
                            >
                              {note.title}
                            </p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              {channelLabel(note)}
                              <span className="mx-1.5 text-border">/</span>
                              {formatDate(note.date)}
                            </p>
                          </div>
                          {active ? (
                            <span
                              aria-hidden="true"
                              className="size-1.5 shrink-0 rounded-[1px] bg-primary"
                            />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <p className="px-3 pb-1 pt-2.5 text-[9.5px] text-muted-foreground/60">
                    来自 Mojang 官方更新日志，保留英文原文。
                  </p>
                </div>
              </>
            ) : (
              <div className="grid min-h-[420px] place-items-center px-8 text-center">
                <div>
                  <p className="text-[13px] text-muted-foreground">暂无更新新闻</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 gap-2"
                    onClick={() => void loadNews(true)}
                  >
                    <RefreshCw className="size-3.5" />
                    重新加载
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className="flex min-h-[560px] flex-col overflow-y-auto rounded-xl border border-border/70 bg-card/45 p-5 min-[900px]:min-h-0">
          {/* Unified Player Profile */}
          <div>
            <div className="relative size-[168px] overflow-hidden rounded-xl border border-border/80 bg-[#0a0f0b] grass-glow">
              <Avatar name={playerName} size={168} className="size-full" />
              <span className="absolute bottom-2 left-2 rounded border border-white/10 bg-black/55 px-1.5 py-0.5 text-[9px] text-white/75 backdrop-blur-sm">
                离线档案
              </span>
            </div>
            <div className="mt-3.5 min-w-0">
              <p className="truncate text-[19px] font-semibold leading-tight tracking-[-0.01em]">
                {playerName.trim() || "未命名玩家"}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <span className="size-1.5 rounded-[1px] bg-primary/80" />
                本地玩家档案 · Java 与基岩版混用共存
              </p>
            </div>
          </div>

          <div className="flex-1" />

          <div className="space-y-3 pt-6">
            <div
              className="flex items-center justify-between gap-3 px-0.5 text-[11px]"
              aria-live="polite"
            >
              <span
                className={cn(
                  "flex min-w-0 items-center gap-2 text-muted-foreground",
                  isRunning && "text-primary",
                )}
              >
                <StatusDot
                  tone={statusTone}
                  animated={isLaunching}
                  className="shrink-0"
                />
                <span className="truncate">{statusLabel}</span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
                {selectedVersion || "—"}
              </span>
            </div>

            {/* Login Mode dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-11 w-full justify-between rounded-lg border-border/80 bg-background/35 px-3.5 font-normal"
                >
                  <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <LogIn className="size-3.5" />
                    登录方式
                  </span>
                  <span className="flex items-center gap-1.5 text-[12px] text-foreground">
                    离线账户
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                side="top"
                className="w-[var(--radix-dropdown-menu-trigger-width)]"
              >
                <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                  选择登录方式
                </DropdownMenuLabel>
                <DropdownMenuItem className="gap-2.5">
                  <Check className="size-3.5 text-primary" />
                  离线账户
                  <Badge
                    variant="outline"
                    className="ml-auto h-4 border-border/80 px-1.5 text-[9px] font-normal text-muted-foreground"
                  >
                    当前
                  </Badge>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled
                  className="gap-2.5"
                  title="微软登录尚未接入"
                >
                  <span className="size-3.5 rounded-full border border-muted-foreground/40" />
                  微软账户
                  <span className="ml-auto text-[9px] text-muted-foreground/70">
                    尚未支持
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Player name input */}
            <div className="space-y-1.5">
              <label className="sr-only" htmlFor="home-player-name">
                名称
              </label>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="home-player-name"
                  value={playerName}
                  onChange={(event) => onPlayerNameChange(event.target.value.slice(0, 16))}
                  placeholder="名称"
                  maxLength={16}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={nameInvalid}
                  aria-describedby={nameInvalid ? "home-name-error" : undefined}
                  className="h-11 rounded-lg border-border/80 bg-background/35 pl-9 pr-3 text-[13px]"
                />
              </div>
              {nameInvalid ? (
                <p id="home-name-error" className="px-0.5 text-[10px] text-destructive">
                  使用 1–16 位字母、数字或下划线
                </p>
              ) : null}
            </div>

            {/* Unified Big Play Button */}
            {(() => {
              const isBedrock =
                selectedVersion === "uwp" ||
                selectedVersion === "bedrock-uwp" ||
                selectedVersion.startsWith("bedrock:") ||
                selectedVersion.startsWith("bedrock-") ||
                (bedrockStatus?.installedVersions.includes(selectedVersion) ?? false);

              const handleUnifiedPlay = () => {
                if (isBedrock) {
                  if (bedrockStatus?.uwpInstalled || bedrockStatus?.standaloneInstalled) {
                    void handleLaunchBedrock();
                  } else {
                    onOpenDownloadBedrock?.();
                  }
                } else {
                  if (isRunning) {
                    onStop();
                  } else {
                    onLaunch();
                  }
                }
              };

              return (
                <div className="relative">
                  <Button
                    type="button"
                    size="lg"
                    variant={isRunning ? "outline" : "default"}
                    onClick={handleUnifiedPlay}
                    disabled={(isLaunching || bedrockLaunching || nameInvalid) && !isRunning}
                    className={cn(
                      "h-16 w-full rounded-xl text-[16px] font-semibold tracking-[-0.01em]",
                      isRunning
                        ? "border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
                        : isBedrock
                          ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_18px_44px_-24px_rgba(16,185,129,0.5)]"
                          : "shadow-[0_18px_44px_-24px_var(--primary)]",
                      (isLaunching || bedrockLaunching) && "disabled:opacity-100",
                    )}
                  >
                    {isLaunching || bedrockLaunching ? (
                      <LoaderCircle className="size-5 animate-spin" />
                    ) : isRunning ? (
                      <Square className="size-4 fill-current" />
                    ) : (
                      <Play className="size-5 fill-current" />
                    )}
                    {isRunning
                      ? "停止运行"
                      : isLaunching || bedrockLaunching
                        ? "正在启动…"
                        : isBedrock
                          ? bedrockStatus?.uwpInstalled || bedrockStatus?.standaloneInstalled
                            ? "启动基岩版"
                            : "获取并下载基岩版"
                          : launchLabel}
                  </Button>
                  {isLaunching ? (
                    <Progress
                      value={percent ?? 30}
                      aria-label="启动进度"
                      className={cn(
                        "pointer-events-none absolute inset-x-4 bottom-2 h-0.5 bg-primary-foreground/20",
                        "[&_[data-slot=progress-indicator]]:bg-primary-foreground",
                        percent === null && "animate-pulse",
                      )}
                    />
                  ) : null}
                </div>
              );
            })()}

            {/* Quick action buttons */}
            <div className="grid grid-cols-2 gap-2.5">
              <Button
                variant="outline"
                className="h-11 justify-start gap-2 rounded-lg border-border/80 bg-background/35 px-3 text-[12px] font-normal"
                onClick={onOpenVersionSelect}
              >
                <Layers3 className="size-3.5 text-muted-foreground" />
                版本选择
              </Button>

              <Button
                variant="outline"
                className="h-11 justify-start gap-2 rounded-lg border-border/80 bg-background/35 px-3 text-[12px] font-normal"
                onClick={onOpenVersionSettings}
              >
                <SlidersHorizontal className="size-3.5 text-muted-foreground" />
                版本设置
              </Button>
            </div>

            {/* Unified Stats Footer */}
            <div className="mt-2 rounded-lg border border-border/60 bg-background/30 p-2.5 text-[11px] text-muted-foreground flex items-center justify-between">
              <span>Java 版本: <strong className="text-foreground">{installed.length}</strong></span>
              <span>基岩版: <strong className="text-foreground">{bedrockStatus?.uwpInstalled ? "UWP 已就绪" : `${bedrockStatus?.installedVersions.length ?? 0} 个核心`}</strong></span>
              <span>附加包: <strong className="text-foreground">{(bedrockStatus?.resourcePacksCount ?? 0) + (bedrockStatus?.behaviorPacksCount ?? 0)}</strong></span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
