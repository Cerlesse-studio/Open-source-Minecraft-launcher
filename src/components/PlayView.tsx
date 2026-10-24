import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  Coffee,
  Download,
  FolderOpen,
  Layers3,
  MemoryStick,
  Play,
  RefreshCw,
  Square,
  UserRound,
} from "lucide-react";
import { cn } from "cn";
import {
  formatDate,
  joinPath,
  shortPath,
  typeLabel,
  typeTone,
} from "../lib/format";
import type {
  GameStateName,
  InstallProgress,
  InstalledVersion,
  JavaInstall,
  VersionManifest,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConsolePanel, type LogEntry } from "./Console";
import {
  GrassBlock,
  PageHeader,
  ProgressBar,
  StatusDot,
  TypeBadge,
} from "./ui";

interface RuntimeView {
  status: GameStateName;
  detail?: string | null;
  pid?: number | null;
  versionId?: string | null;
}

interface PlayViewProps {
  manifest: VersionManifest | null;
  installed: InstalledVersion[];
  selectedVersion: string;
  onSelectVersion: (versionId: string) => void;
  settingsMemory: number;
  playerName: string;
  gameRoot: string;
  javaInstalls: JavaInstall[];
  javaDetecting: boolean;
  javaPath: string;
  runtime: RuntimeView;
  installProgress: InstallProgress | null;
  installingVersion: string | null;
  launchProgress: InstallProgress | null;
  logs: LogEntry[];
  onLaunch: () => void;
  onStop: () => void;
  onInstall: (versionId: string) => void;
  onOpenVersions: () => void;
  onOpenSettings: () => void;
  onOpenFolder: (path: string) => void;
  onRefreshJava: () => void;
  onClearLogs: () => void;
  embedded?: boolean;
}

function VersionPicker({
  installed,
  selected,
  onSelect,
  onManage,
}: {
  installed: InstalledVersion[];
  selected: string;
  onSelect: (versionId: string) => void;
  onManage: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 border-border/80 bg-card/80 px-2.5 font-mono text-[11px] font-normal text-muted-foreground hover:text-foreground"
        >
          <Layers3 className="size-3.5" />
          <span className="max-w-32 truncate text-foreground">{selected || "选择版本"}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center justify-between text-[11px] font-normal text-muted-foreground">
          已安装版本
          <span className="font-mono">{installed.length}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {installed.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs">
            还没有安装任何版本
          </DropdownMenuItem>
        ) : (
          installed.map((version) => (
            <DropdownMenuItem
              key={version.id}
              onSelect={() => onSelect(version.id)}
              className={cn(
                "gap-2.5 font-mono text-xs",
                version.id === selected && "bg-accent/70",
              )}
            >
              <span
                className={cn(
                  "size-2 rounded-[2px]",
                  version.type === "release"
                    ? "bg-primary"
                    : version.type === "snapshot"
                      ? "bg-gold"
                      : "bg-muted-foreground/60",
                )}
              />
              <span className="flex-1">{version.id}</span>
              <span className="text-[10px] font-sans text-muted-foreground">
                {typeLabel(version.type)}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onManage}
          className="gap-2.5 text-xs text-muted-foreground"
        >
          <Download className="size-3.5" />
          下载更多版本
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-[11px] text-foreground/90">{value}</dd>
    </div>
  );
}

function findBestJava(javaInstalls: JavaInstall[], javaPath: string): JavaInstall | null {
  if (javaPath) {
    return (
      javaInstalls.find((java) => java.path === javaPath) ?? {
        path: javaPath,
        major: 0,
        version: "手动指定",
        source: "手动",
      }
    );
  }
  return javaInstalls[0] ?? null;
}

export function PlayView({
  manifest,
  installed,
  selectedVersion,
  onSelectVersion,
  settingsMemory,
  playerName,
  gameRoot,
  javaInstalls,
  javaDetecting,
  javaPath,
  runtime,
  installProgress,
  installingVersion,
  launchProgress,
  logs,
  onLaunch,
  onStop,
  onInstall,
  onOpenVersions,
  onOpenSettings,
  onOpenFolder,
  onRefreshJava,
  onClearLogs,
  embedded = false,
}: PlayViewProps) {
  const selectedInstalled = installed.find((version) => version.id === selectedVersion);
  const summary = manifest?.versions.find((version) => version.id === selectedVersion);
  const versionType = selectedInstalled?.type ?? summary?.type ?? "release";
  const isInstalled = Boolean(selectedInstalled);
  const isLatest = Boolean(manifest && manifest.latest.release === selectedVersion);
  const isInstalling = installingVersion === selectedVersion;
  const activeVersion = runtime.versionId ?? selectedVersion;
  const isLaunching =
    runtime.status === "preparing" &&
    (!runtime.versionId || activeVersion === selectedVersion);
  const isRunning =
    runtime.status === "running" &&
    (!runtime.versionId || activeVersion === selectedVersion);
  const bestJava = findBestJava(javaInstalls, javaPath);
  const gameFolder = joinPath(gameRoot, "versions", selectedVersion);

  const activeProgress = isInstalling
    ? installProgress
    : isLaunching
      ? launchProgress
      : null;

  const headerLabel = isRunning
    ? "游戏运行中"
    : isLaunching
      ? "启动准备中"
      : isInstalling
        ? "正在下载"
        : isInstalled
          ? "准备就绪"
          : "等待安装";
  const headerTone = isRunning
    ? "live"
    : isInstalled && !isLaunching
      ? "online"
      : isLaunching || isInstalling
        ? "pending"
        : "muted";

  let statusCopy = "游戏文件已就绪";
  if (isRunning) statusCopy = `游戏正在运行${runtime.pid ? ` · PID ${runtime.pid}` : ""}`;
  else if (isLaunching) statusCopy = activeProgress?.detail || runtime.detail || "正在启动游戏";
  else if (isInstalling) statusCopy = activeProgress?.detail || "正在下载游戏文件";
  else if (!isInstalled) statusCopy = "需要下载客户端、依赖库与资源文件";

  const primaryLabel = isRunning
    ? "结束游戏"
    : isLaunching
      ? "正在启动…"
      : isInstalled
        ? "开始游戏"
        : isInstalling
          ? "正在安装…"
          : "下载并安装";

  return (
    <div className="space-y-5">
      {!embedded ? (
        <PageHeader
          title="版本设置"
          description="查看当前版本状态，准备进入世界。"
          actions={
            <div className="flex h-7 items-center gap-2 rounded-full border border-border/70 bg-card/60 px-3 text-[11px] text-muted-foreground">
              <StatusDot tone={headerTone} animated={isRunning} />
              {headerLabel}
            </div>
          }
        />
      ) : null}

      {!selectedVersion ? (
        <Card className="gap-0 overflow-hidden border-border/70 bg-card/70 py-0">
          <CardContent className="flex flex-col items-center gap-4 px-6 py-14 text-center">
            <div className="rounded-2xl border border-border/80 bg-background/60 p-4">
              <GrassBlock size={92} />
            </div>
            <div>
              <h2 className="text-lg font-semibold">还没有可启动的版本</h2>
              <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
                先从版本选择页下载一份游戏文件。客户端、依赖和资源都会自动处理。
              </p>
            </div>
            <Button onClick={onOpenVersions}>
              <Download />
              打开版本选择
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="gap-0 overflow-hidden border-border/70 bg-card/70 py-0">
          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-5">
            <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
              <span className="size-1.5 rounded-[2px] bg-primary" />
              当前实例
            </div>
            <VersionPicker
              installed={installed}
              selected={selectedVersion}
              onSelect={onSelectVersion}
              onManage={onOpenVersions}
            />
          </div>

          <div className="relative">
            <div className="world-grid pointer-events-none absolute inset-0 opacity-60" />
            <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:gap-6 lg:p-6">
              <div className="grass-glow flex size-[104px] shrink-0 items-center justify-center rounded-2xl border border-border/80 bg-[#0a0f0b] p-2 lg:size-[124px] lg:p-2.5">
                <GrassBlock size={88} className="lg:hidden" />
                <GrassBlock size={96} className="hidden lg:block" />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <TypeBadge
                    type={versionType}
                    tone={typeTone(versionType)}
                    label={typeLabel(versionType)}
                  />
                  {isLatest ? (
                    <Badge
                      variant="outline"
                      className="h-5 rounded-[5px] border-gold/30 bg-gold/10 px-1.5 text-[10px] text-gold"
                    >
                      最新正式版
                    </Badge>
                  ) : null}
                  <span className="ml-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                    <CalendarDays className="size-3" />
                    {summary?.releaseTime ? formatDate(summary.releaseTime) : "本地实例"}
                  </span>
                </div>
                <h2 className="font-pixel mt-2 text-[38px] leading-none tracking-tight text-foreground lg:text-[44px]">
                  {selectedVersion}
                </h2>
                <p
                  className={cn(
                    "mt-3 flex items-center gap-2 text-[12px] text-muted-foreground",
                    isRunning && "text-primary",
                  )}
                >
                  <StatusDot
                    tone={isRunning ? "live" : isLaunching || isInstalling ? "pending" : "online"}
                    animated={isRunning || isLaunching}
                  />
                  <span className="truncate">{statusCopy}</span>
                </p>

                <div className="mt-5 flex flex-wrap items-center gap-2">
                  {isInstalled ? (
                    <Button
                      size="lg"
                      className="h-10 gap-2 rounded-lg px-5 text-[13px] font-semibold shadow-[0_0_24px_-10px_rgba(155,221,107,0.65)]"
                      onClick={isRunning ? onStop : onLaunch}
                      disabled={isLaunching}
                    >
                      {isRunning ? <Square className="size-3.5 fill-current" /> : <Play className="size-4 fill-current" />}
                      {primaryLabel}
                    </Button>
                  ) : (
                    <Button
                      size="lg"
                      className="h-10 gap-2 rounded-lg px-5 text-[13px] font-semibold"
                      onClick={() => onInstall(selectedVersion)}
                      disabled={isInstalling}
                    >
                      <Download className="size-4" />
                      {primaryLabel}
                    </Button>
                  )}
                  {isInstalled && !isRunning ? (
                    <Button
                      variant="outline"
                      size="lg"
                      className="h-10 gap-2 rounded-lg border-border/80 bg-card/60 px-4 text-[12px]"
                      onClick={() => onOpenFolder(gameFolder)}
                    >
                      <FolderOpen className="size-3.5" />
                      打开目录
                    </Button>
                  ) : null}
                </div>
              </div>

              <dl className="hidden w-[176px] shrink-0 flex-col gap-3 border-l border-border/60 pl-6 lg:flex">
                <MetaRow label="版本类型" value={typeLabel(versionType)} />
                <MetaRow
                  label="发布时间"
                  value={summary?.releaseTime ? formatDate(summary.releaseTime) : "本地实例"}
                />
                <MetaRow label="最大内存" value={`${settingsMemory} MB`} />
              </dl>
            </div>

            {activeProgress ? (
              <div className="relative border-t border-border/60 bg-background/25 px-5 py-4 sm:px-6">
                <div className="mb-2.5 flex items-center justify-between gap-3 text-[11px]">
                  <span className="font-medium text-foreground">
                    {isLaunching ? "启动准备" : "安装进度"}
                  </span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {activeProgress.detail}
                  </span>
                </div>
                <ProgressBar progress={activeProgress} />
              </div>
            ) : null}
          </div>

          <div className="border-t border-border/60 bg-muted/10 px-5 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">
                已安装 {installed.length} 个版本
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={onOpenVersions}
              >
                管理版本
              </Button>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {installed.slice(0, 4).map((version) => (
                <button
                  key={version.id}
                  className={cn(
                    "inline-flex h-7 items-center gap-2 rounded-md border border-border/70 bg-card/60 px-2.5 font-mono text-[10px] text-muted-foreground transition-colors hover:border-border hover:text-foreground",
                    version.id === selectedVersion &&
                      "border-primary/35 bg-primary/10 text-primary",
                  )}
                  onClick={() => onSelectVersion(version.id)}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-[1px]",
                      version.type === "release" ? "bg-primary" : "bg-gold",
                    )}
                  />
                  {version.id}
                </button>
              ))}
              <Button
                variant="outline"
                size="xs"
                className="h-7 gap-1.5 border-dashed border-border/70 bg-transparent px-2 font-normal text-muted-foreground"
                onClick={onOpenVersions}
              >
                <Download className="size-3" />
                获取版本
              </Button>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Card className="gap-0 border-border/70 bg-card/60 py-0">
          <CardHeader className="border-b border-border/60 px-5 py-4">
            <CardTitle className="flex items-center justify-between text-[13px] font-medium">
              <span className="flex items-center gap-2">
                <span className="flex size-6 items-center justify-center rounded-md border border-border/70 bg-background/60">
                  <Layers3 className="size-3.5 text-primary" />
                </span>
                运行环境
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={onRefreshJava}
                title="重新检测 Java"
                aria-label="重新检测 Java"
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <dl className="divide-y divide-border/50">
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
                  <UserRound className="size-3.5" />
                  账户
                </dt>
                <dd className="flex min-w-0 items-center gap-2 text-[12px]">
                  <span className="truncate">{playerName}</span>
                  <Badge
                    variant="outline"
                    className="h-4 border-border/80 px-1.5 text-[9px] font-normal text-muted-foreground"
                  >
                    离线
                  </Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
                  <Coffee className="size-3.5" />
                  Java
                </dt>
                <dd className="flex min-w-0 flex-col items-end gap-0.5 text-[12px]" title={bestJava?.path}>
                  {bestJava ? (
                    <>
                      <span>
                        {bestJava.major ? `Java ${bestJava.major}` : "手动指定"}
                      </span>
                      <span className="max-w-[180px] truncate font-mono text-[9px] text-muted-foreground">
                        {shortPath(bestJava.path, 30)}
                      </span>
                    </>
                  ) : javaDetecting ? (
                    <>
                      <span>正在检测…</span>
                      <span className="text-[9px] text-muted-foreground">本机与运行时</span>
                    </>
                  ) : (
                    <>
                      <span>启动时自动安装</span>
                      <span className="text-[9px] text-muted-foreground">Temurin JRE</span>
                    </>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
                  <MemoryStick className="size-3.5" />
                  内存
                </dt>
                <dd className="text-right text-[12px]">
                  {settingsMemory} MB
                  <span className="ml-1.5 text-[9px] text-muted-foreground">最大堆</span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <dt className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
                  <FolderOpen className="size-3.5" />
                  游戏目录
                </dt>
                <dd className="min-w-0">
                  <button
                    className="block max-w-[190px] truncate font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => onOpenFolder(gameRoot)}
                    title={gameRoot}
                  >
                    {shortPath(gameRoot, 32)}
                  </button>
                </dd>
              </div>
            </dl>
          </CardContent>
          <CardFooter className="flex flex-col items-stretch gap-2 border-t border-border/60 px-5 py-3.5">
            <p className="text-[10px] leading-4 text-muted-foreground">
              {bestJava
                ? "启动时会校验 Java 主版本；不匹配时将自动下载正确的运行时。"
                : javaDetecting
                  ? "正在扫描本机与启动器运行时。"
                  : "没有检测到 Java。首次启动会自动下载 Temurin JRE。"}
            </p>
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="xs"
                className="h-6 px-0 text-[10px] text-muted-foreground hover:bg-transparent hover:text-foreground"
                onClick={onOpenSettings}
              >
                调整设置
              </Button>
              {runtime.status === "running" ? (
                <span className="flex items-center gap-1.5 text-[10px] text-gold">
                  <AlertTriangle className="size-3" />
                  进程运行中
                </span>
              ) : null}
            </div>
          </CardFooter>
        </Card>

        <ConsolePanel
          logs={logs}
          runtime={runtime}
          onClear={onClearLogs}
          onOpenFolder={() => onOpenFolder(gameRoot)}
        />
      </div>
    </div>
  );
}
