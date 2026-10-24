import { useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Cpu,
  Download,
  FileCheck2,
  FileCode2,
  FolderOpen,
  Gauge,
  HardDriveDownload,
  Layers3,
  LoaderCircle,
  Package,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { cn } from "cn";
import {
  formatBytes,
  formatSpeed,
  joinPath,
  progressPercent,
  stageLabel,
  typeLabel,
} from "../lib/format";
import type {
  ActiveDownloadTask,
  DownloadHistoryRecord,
  InstallProgress,
  InstalledVersion,
  StageProgress,
  VersionManifest,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { PageHeader, StatusDot } from "./ui";

export interface DownloadFileEvent {
  id: number;
  time: string;
  versionId: string;
  stage: string;
  detail: string;
  speedBps: number;
}

interface DownloadsViewProps {
  manifest: VersionManifest | null;
  installed: InstalledVersion[];
  selectedVersion: string;
  installingVersion: string | null;
  installProgress: InstallProgress | null;
  lastProgress: InstallProgress | null;
  downloadThreads: number;
  peakSpeedBps: number;
  speedHistory: number[];
  fileEvents: DownloadFileEvent[];
  history: DownloadHistoryRecord[];
  gameRoot: string;
  onSelectVersion: (versionId: string) => void;
  onChangeThreads: (threads: number) => void;
  onInstall: (versionId: string) => void;
  onClearHistory: () => void;
  onOpenVersionSelect: () => void;
  onOpenFolder: (path: string) => void;
}

const THREAD_PRESETS = [4, 8, 16, 32, 64];

const DEFAULT_STAGES: StageProgress[] = [
  {
    stage: "prepare",
    label: "解析版本与资源清单",
    status: "pending",
    doneFiles: 0,
    totalFiles: 3,
    doneBytes: 0,
    totalBytes: 0,
  },
  {
    stage: "client",
    label: "客户端核心 Jar",
    status: "pending",
    doneFiles: 0,
    totalFiles: 1,
    doneBytes: 0,
    totalBytes: 0,
  },
  {
    stage: "libraries",
    label: "运行依赖库与原生库",
    status: "pending",
    doneFiles: 0,
    totalFiles: 0,
    doneBytes: 0,
    totalBytes: 0,
  },
  {
    stage: "assets",
    label: "游戏资源与音频文件",
    status: "pending",
    doneFiles: 0,
    totalFiles: 0,
    doneBytes: 0,
    totalBytes: 0,
  },
];

function StageIcon({ stage }: { stage: string }) {
  switch (stage) {
    case "prepare":
      return <FileCode2 className="size-4" />;
    case "client":
      return <Package className="size-4" />;
    case "libraries":
      return <Layers3 className="size-4" />;
    case "assets":
      return <Boxes className="size-4" />;
    default:
      return <Download className="size-4" />;
  }
}

function StageStatusBadge({ status }: { status: StageProgress["status"] }) {
  if (status === "done") {
    return (
      <Badge
        variant="outline"
        className="h-5 gap-1 border-primary/30 bg-primary/10 px-1.5 text-[10px] font-normal text-primary"
      >
        <Check className="size-2.5" />
        已完成
      </Badge>
    );
  }
  if (status === "active") {
    return (
      <Badge
        variant="outline"
        className="h-5 gap-1 border-gold/35 bg-gold/10 px-1.5 text-[10px] font-normal text-gold"
      >
        <LoaderCircle className="size-2.5 animate-spin" />
        下载中
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge
        variant="outline"
        className="h-5 gap-1 border-destructive/35 bg-destructive/10 px-1.5 text-[10px] font-normal text-destructive"
      >
        异常
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-5 border-border/70 bg-muted/30 px-1.5 text-[10px] font-normal text-muted-foreground"
    >
      等待中
    </Badge>
  );
}

function SpeedSparkline({ samples }: { samples: number[] }) {
  const max = Math.max(...samples, 1_048_576);
  const padded =
    samples.length >= 18
      ? samples.slice(-18)
      : [...Array.from({ length: 18 - samples.length }, () => 0), ...samples];

  return (
    <div
      className="flex h-7 items-end gap-1 pt-1"
      aria-hidden="true"
      title="实时速度波形"
    >
      {padded.map((val, idx) => {
        const ratio = val > 0 ? Math.max(0.14, Math.min(1, val / max)) : 0.08;
        return (
          <span
            key={idx}
            style={{ height: `${Math.round(ratio * 100)}%` }}
            className={cn(
              "flex-1 rounded-[1px] transition-all duration-150",
              val > 0 ? "bg-primary/80" : "bg-border/60",
            )}
          />
        );
      })}
    </div>
  );
}

function WorkerTaskCard({ task }: { task: ActiveDownloadTask }) {
  const pct = progressPercent(task.doneBytes, task.totalBytes);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-background/45 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge
            variant="outline"
            className="h-4 shrink-0 border-primary/30 bg-primary/10 px-1.5 font-mono text-[9px] font-normal text-primary"
          >
            线程 #{String(task.workerId).padStart(2, "0")}
          </Badge>
          {task.segments > 1 ? (
            <Badge
              variant="outline"
              className="h-4 shrink-0 border-gold/30 bg-gold/10 px-1.5 font-mono text-[9px] font-normal text-gold"
              title="HTTP Range 多分片并发加速"
            >
              Range ×{task.segments}
            </Badge>
          ) : (
            <span className="text-[9.5px] text-muted-foreground">并发流</span>
          )}
        </div>
        <span className="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 text-[9px] text-muted-foreground">
          {stageLabel(task.stage)}
        </span>
      </div>

      <p
        className="truncate font-mono text-[11px] font-medium text-foreground/90"
        title={task.name}
      >
        {task.name}
      </p>

      <Progress
        value={pct ?? 45}
        className={cn(
          "h-1 rounded-sm bg-primary/15 [&_[data-slot=progress-indicator]]:rounded-sm",
          pct === null && "animate-pulse",
        )}
      />

      <div className="flex items-center justify-between gap-2 font-mono text-[9.5px] text-muted-foreground">
        <span>
          {task.totalBytes > 0
            ? `${formatBytes(task.doneBytes)} / ${formatBytes(task.totalBytes)}`
            : formatBytes(task.doneBytes)}
        </span>
        <span>{pct !== null ? `${pct}%` : "传输中"}</span>
      </div>
    </div>
  );
}

export function DownloadsView({
  manifest,
  installed,
  selectedVersion,
  installingVersion,
  installProgress,
  lastProgress,
  downloadThreads,
  peakSpeedBps,
  speedHistory,
  fileEvents,
  history,
  gameRoot,
  onSelectVersion,
  onChangeThreads,
  onInstall,
  onClearHistory,
  onOpenVersionSelect,
  onOpenFolder,
}: DownloadsViewProps) {
  const [rightTab, setRightTab] = useState<"files" | "history">("files");

  const activeProgress = installProgress ?? lastProgress;
  const isDownloading = Boolean(installingVersion && installProgress);
  const targetVersion =
    installingVersion ||
    selectedVersion ||
    manifest?.latest.release ||
    installed[0]?.id ||
    "";
  const isTargetInstalled = installed.some((v) => v.id === targetVersion);

  const stages = useMemo<StageProgress[]>(() => {
    if (activeProgress?.stages && activeProgress.stages.length > 0) {
      return activeProgress.stages;
    }
    return DEFAULT_STAGES;
  }, [activeProgress]);

  const fileTotals = useMemo(() => {
    const doneFiles = stages.reduce((acc, s) => acc + s.doneFiles, 0);
    const totalFiles = stages.reduce((acc, s) => acc + s.totalFiles, 0);
    return { doneFiles, totalFiles };
  }, [stages]);

  const downloadedBytes = activeProgress?.downloadedBytes ?? 0;
  const totalBytes = activeProgress?.totalBytes ?? 0;
  const speedBps = isDownloading ? (installProgress?.speedBps ?? 0) : 0;
  const activeThreads = isDownloading ? (installProgress?.activeThreads ?? 0) : 0;
  const skippedFiles = activeProgress?.skippedFiles ?? 0;
  const retriedFiles = activeProgress?.retriedFiles ?? 0;
  const activeTasks = isDownloading ? (installProgress?.activeTasks ?? []) : [];

  const overallPercent = useMemo(() => {
    if (!activeProgress) return 0;
    if (activeProgress.stage === "done") return 100;
    if (totalBytes > 0) {
      return Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
    }
    return progressPercent(activeProgress.done, activeProgress.total) ?? 0;
  }, [activeProgress, downloadedBytes, totalBytes]);

  const quickVersions = useMemo(() => {
    const list = manifest?.versions.slice(0, 14) ?? [];
    if (list.length > 0) return list;
    return installed.map((v) => ({
      id: v.id,
      type: v.type,
      url: "",
    }));
  }, [installed, manifest]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="下载进度"
        description="实时监控游戏核心、运行依赖库与资源文件的下载进度，支持多线程并发工作池与大文件 HTTP Range 分片加速。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-border/80 bg-card/70 px-3 text-[11.5px]"
              onClick={onOpenVersionSelect}
            >
              <ArrowLeft className="size-3.5" />
              返回下载页面
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-2 border-border/80 bg-card/70 px-3 font-mono text-[11px] font-normal"
                  disabled={isDownloading}
                >
                  <Layers3 className="size-3.5 text-primary" />
                  <span>{targetVersion || "选择版本"}</span>
                  <ChevronDown className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                  选择要下载或校验的版本
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {quickVersions.map((ver) => {
                  const local = installed.some((i) => i.id === ver.id);
                  return (
                    <DropdownMenuItem
                      key={ver.id}
                      onSelect={() => onSelectVersion(ver.id)}
                      className="gap-2 font-mono text-xs"
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-[1px]",
                          ver.type === "release" ? "bg-primary" : "bg-gold",
                        )}
                      />
                      <span className="flex-1 truncate">{ver.id}</span>
                      <span className="font-sans text-[10px] text-muted-foreground">
                        {local ? "已下载" : typeLabel(ver.type)}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onOpenVersionSelect}
                  className="gap-2 text-xs text-muted-foreground"
                >
                  <Boxes className="size-3.5" />
                  返回下载页面查看全部…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              size="sm"
              className="h-8 gap-1.5 px-3.5 text-[11.5px]"
              disabled={isDownloading || !targetVersion}
              onClick={() => targetVersion && onInstall(targetVersion)}
            >
              {isDownloading ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" />
                  正在下载 {installingVersion}…
                </>
              ) : (
                <>
                  <Download className="size-3.5" />
                  {isTargetInstalled
                    ? `校验 / 重装 ${targetVersion}`
                    : `多线程下载 ${targetVersion}`}
                </>
              )}
            </Button>
          </div>
        }
      />

      {/* Top 4 Real-Time Telemetry Cards */}
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="gap-0 border-border/70 bg-card/55 py-0">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Gauge className="size-3.5 text-primary" />
                实时下载速度
              </span>
              <StatusDot
                tone={isDownloading ? "live" : "muted"}
                animated={isDownloading}
              />
            </div>
            <p className="mt-2 font-mono text-[22px] font-semibold tracking-tight text-foreground">
              {formatSpeed(speedBps)}
            </p>
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>峰值 {formatSpeed(peakSpeedBps)}</span>
              <span className="font-mono text-primary/80">
                {isDownloading ? "高速传输中" : "空闲待命"}
              </span>
            </div>
            <SpeedSparkline samples={speedHistory} />
          </CardContent>
        </Card>

        <Card className="gap-0 border-border/70 bg-card/55 py-0">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <HardDriveDownload className="size-3.5 text-primary" />
                游戏文件数据量
              </span>
              <span className="font-mono text-[11px] text-primary">
                {overallPercent}%
              </span>
            </div>
            <p className="mt-2 font-mono text-[22px] font-semibold tracking-tight text-foreground">
              {formatBytes(downloadedBytes)}
            </p>
            <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
              总计 {totalBytes > 0 ? formatBytes(totalBytes) : "计算中…"}
            </p>
            <Progress
              value={overallPercent}
              className="mt-3 h-1.5 rounded-sm bg-primary/15 [&_[data-slot=progress-indicator]]:rounded-sm"
            />
          </CardContent>
        </Card>

        <Card className="gap-0 border-border/70 bg-card/55 py-0">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Cpu className="size-3.5 text-gold" />
                多线程下载器
              </span>
              <Badge
                variant="outline"
                className="h-4 border-gold/30 bg-gold/10 px-1.5 font-mono text-[9px] font-normal text-gold"
              >
                {downloadThreads} 线程
              </Badge>
            </div>
            <p className="mt-2 font-mono text-[22px] font-semibold tracking-tight text-foreground">
              {activeThreads}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">
                / {downloadThreads} 活跃
              </span>
            </p>
            <p className="mt-1 text-[10px] text-muted-foreground">
              HTTP Range 分片 + 异步并发工作池
            </p>
            <div className="mt-3 flex gap-1" aria-hidden="true">
              {Array.from({ length: 16 }, (_, idx) => {
                const slotActive =
                  isDownloading &&
                  idx < Math.ceil((activeThreads / Math.max(1, downloadThreads)) * 16);
                return (
                  <span
                    key={idx}
                    className={cn(
                      "h-1.5 flex-1 rounded-[1px] transition-colors",
                      slotActive ? "bg-gold" : "bg-border/60",
                    )}
                  />
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card className="gap-0 border-border/70 bg-card/55 py-0">
          <CardContent className="p-4">
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <FileCheck2 className="size-3.5 text-primary" />
                文件校验统计
              </span>
              <ShieldCheck className="size-3.5 text-primary/80" />
            </div>
            <p className="mt-2 font-mono text-[22px] font-semibold tracking-tight text-foreground">
              {fileTotals.doneFiles.toLocaleString()}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">
                / {fileTotals.totalFiles.toLocaleString()}
              </span>
            </p>
            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
              <span>缓存跳过 {skippedFiles} 个</span>
              <span>自动重试 {retriedFiles} 次</span>
            </div>
            <div className="mt-3 flex items-center gap-1.5 text-[10px] text-primary/90">
              <CheckCircle2 className="size-3" />
              <span>SHA-1 完整性校验与 .part 原子写入</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Stage-by-Stage Game File Breakdown */}
      <Card className="gap-0 overflow-hidden border-border/70 bg-card/55 py-0">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60 text-primary">
                <Activity className="size-4" />
              </span>
              <div>
                <CardTitle className="flex items-center gap-2 text-[13.5px] font-medium">
                  <span>游戏文件分阶段进度</span>
                  {activeProgress ? (
                    <Badge
                      variant="outline"
                      className="h-5 border-primary/30 bg-primary/10 px-2 font-mono text-[10px] font-normal text-primary"
                    >
                      Minecraft {activeProgress.versionId}
                    </Badge>
                  ) : null}
                </CardTitle>
                <CardDescription className="mt-0.5 text-[11px]">
                  {activeProgress
                    ? `当前状态：${stageLabel(activeProgress.stage)} — ${activeProgress.detail}`
                    : "选择任意版本开始安装，这里会实时展示客户端、依赖库与资源文件的下载详情。"}
                </CardDescription>
              </div>
            </div>

            {activeProgress ? (
              <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                <span>总进度 {overallPercent}%</span>
                <span className="text-border">|</span>
                <span>
                  {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
                </span>
              </div>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="p-5">
          <div className="grid gap-3.5 md:grid-cols-2 xl:grid-cols-4">
            {stages.map((item) => {
              const pct =
                item.status === "done"
                  ? 100
                  : item.totalBytes > 0
                    ? progressPercent(item.doneBytes, item.totalBytes)
                    : progressPercent(item.doneFiles, item.totalFiles);

              return (
                <div
                  key={item.stage}
                  className={cn(
                    "flex flex-col justify-between rounded-xl border p-3.5 transition-colors",
                    item.status === "active"
                      ? "border-gold/40 bg-gold/[0.04]"
                      : item.status === "done"
                        ? "border-primary/30 bg-primary/[0.03]"
                        : "border-border/65 bg-background/35",
                  )}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={cn(
                          "flex size-7 items-center justify-center rounded-md border",
                          item.status === "active"
                            ? "border-gold/35 bg-gold/10 text-gold"
                            : item.status === "done"
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "border-border/70 bg-muted/30 text-muted-foreground",
                        )}
                      >
                        <StageIcon stage={item.stage} />
                      </span>
                      <StageStatusBadge status={item.status} />
                    </div>

                    <h3 className="mt-3 text-[12.5px] font-medium text-foreground">
                      {item.label}
                    </h3>
                    <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      文件 {item.doneFiles.toLocaleString()} /{" "}
                      {item.totalFiles > 0 ? item.totalFiles.toLocaleString() : "—"}
                    </p>
                  </div>

                  <div className="mt-4 space-y-1.5">
                    <Progress
                      value={pct ?? (item.status === "active" ? 30 : 0)}
                      className={cn(
                        "h-1.5 rounded-sm bg-primary/15 [&_[data-slot=progress-indicator]]:rounded-sm",
                        item.status === "active" && pct === null && "animate-pulse",
                      )}
                    />
                    <div className="flex items-center justify-between font-mono text-[9.5px] text-muted-foreground">
                      <span>
                        {item.totalBytes > 0
                          ? `${formatBytes(item.doneBytes)} / ${formatBytes(item.totalBytes)}`
                          : item.stage === "prepare"
                            ? "元数据清单"
                            : "等待解析"}
                      </span>
                      <span>{pct !== null ? `${pct}%` : "0%"}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Bottom Grid: Multi-threaded Worker Pool + File Log / History */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        {/* Multi-threaded Worker Pool Panel */}
        <Card className="gap-0 border-border/70 bg-card/55 py-0">
          <CardHeader className="border-b border-border/60 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/60 text-gold">
                  <Zap className="size-4" />
                </span>
                <div>
                  <CardTitle className="text-[13px] font-medium">
                    多线程下载器与并发通道
                  </CardTitle>
                  <CardDescription className="mt-0.5 text-[11px]">
                    小文件使用多线程异步工作队列，大文件自动启用 HTTP Range 多分片并行拉取。
                  </CardDescription>
                </div>
              </div>
              <Badge
                variant="outline"
                className="h-5 border-primary/30 bg-primary/10 px-2 font-mono text-[10px] font-normal text-primary"
              >
                {downloadThreads} 并发线程
              </Badge>
            </div>
          </CardHeader>

          <CardContent className="space-y-4 p-5">
            {/* Thread Count Controls */}
            <div className="rounded-xl border border-border/65 bg-background/35 p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[11.5px] font-medium text-foreground">
                    并发下载线程数
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    可根据网络带宽调节（1–64 线程），设置会自动保存。
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {THREAD_PRESETS.map((preset) => (
                    <Button
                      key={preset}
                      variant={downloadThreads === preset ? "default" : "outline"}
                      size="xs"
                      className="h-6 px-2 font-mono text-[10px]"
                      onClick={() => onChangeThreads(preset)}
                    >
                      {preset}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="mt-3">
                <Slider
                  min={1}
                  max={64}
                  step={1}
                  value={[downloadThreads]}
                  onValueChange={([val]) => {
                    if (typeof val === "number") onChangeThreads(val);
                  }}
                  aria-label="并发下载线程数"
                />
                <div className="mt-1.5 flex justify-between font-mono text-[9px] text-muted-foreground/70">
                  <span>1 线程（单流稳健）</span>
                  <span>16 线程（推荐默认）</span>
                  <span>32 线程（千兆宽带）</span>
                  <span>64 线程（极速并发）</span>
                </div>
              </div>
            </div>

            {/* Active Thread Slots */}
            <div>
              <div className="mb-2.5 flex items-center justify-between text-[11px]">
                <span className="font-medium text-foreground">
                  实时工作线程监控
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {activeTasks.length > 0
                    ? `正在传输 ${activeTasks.length} 个文件任务`
                    : isDownloading
                      ? "正在切换阶段任务…"
                      : "当前无活跃下载线程"}
                </span>
              </div>

              {activeTasks.length > 0 ? (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {activeTasks.map((task) => (
                    <WorkerTaskCard key={task.workerId} task={task} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-background/25 px-6 py-10 text-center">
                  <div className="flex size-10 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
                    <Cpu className="size-4 text-primary" />
                  </div>
                  <p className="mt-3 text-[12.5px] font-medium text-foreground">
                    {activeProgress?.stage === "done"
                      ? `Minecraft ${activeProgress.versionId} 所有游戏文件已下载并校验完成`
                      : `多线程下载池已就绪（${downloadThreads} 线程）`}
                  </p>
                  <p className="mt-1 max-w-md text-[11px] leading-5 text-muted-foreground">
                    {activeProgress?.stage === "done"
                      ? "所有工作线程已完成任务并释放连接，SHA-1 校验全部通过。"
                      : "开始安装或校验版本时，这里会实时显示每个工作线程正在拉取的文件、分片数量与字节进度。"}
                  </p>
                  {!isDownloading && targetVersion ? (
                    <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                      <Button
                        size="sm"
                        className="h-8 gap-1.5 text-[11px]"
                        onClick={() => onInstall(targetVersion)}
                      >
                        <Sparkles className="size-3.5" />
                        {isTargetInstalled
                          ? `重新校验 ${targetVersion} 文件`
                          : `立即下载 ${targetVersion}`}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-[11px]"
                        onClick={onOpenVersionSelect}
                      >
                        <Layers3 className="size-3.5" />
                        挑选其他版本
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Right Panel: File Activity Log & Session History */}
        <Card className="gap-0 border-border/70 bg-card/55 py-0">
          <CardHeader className="border-b border-border/60 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-background/50 p-0.5">
                <button
                  type="button"
                  onClick={() => setRightTab("files")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                    rightTab === "files"
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  实时文件流 ({fileEvents.length})
                </button>
                <button
                  type="button"
                  onClick={() => setRightTab("history")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                    rightTab === "history"
                      ? "bg-accent text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  下载记录 ({history.length})
                </button>
              </div>

              {rightTab === "history" && history.length > 0 ? (
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 gap-1 px-2 text-[10px] text-muted-foreground"
                  onClick={onClearHistory}
                >
                  <Trash2 className="size-3" />
                  清空
                </Button>
              ) : null}
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {rightTab === "files" ? (
              fileEvents.length === 0 ? (
                <div className="px-5 py-12 text-center text-[11px] text-muted-foreground">
                  暂无文件下载日志。启动下载后将实时记录每个文件的拉取状态。
                </div>
              ) : (
                <div className="max-h-[420px] divide-y divide-border/40 overflow-y-auto">
                  {fileEvents.map((ev) => (
                    <div
                      key={ev.id}
                      className="flex items-center justify-between gap-2.5 px-4 py-2.5 text-[11px]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[9.5px] text-muted-foreground/70">
                            {ev.time}
                          </span>
                          <Badge
                            variant="outline"
                            className="h-4 border-border/70 px-1 text-[9px] font-normal text-muted-foreground"
                          >
                            {stageLabel(ev.stage)}
                          </Badge>
                          <span className="font-mono text-[9.5px] text-primary/80">
                            {ev.versionId}
                          </span>
                        </div>
                        <p
                          className="mt-0.5 truncate font-mono text-[10.5px] text-foreground/90"
                          title={ev.detail}
                        >
                          {ev.detail}
                        </p>
                      </div>
                      {ev.speedBps > 0 ? (
                        <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">
                          {formatSpeed(ev.speedBps)}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              )
            ) : history.length === 0 ? (
              <div className="px-5 py-12 text-center text-[11px] text-muted-foreground">
                还没有已完成的下载任务记录。
              </div>
            ) : (
              <div className="max-h-[420px] divide-y divide-border/40 overflow-y-auto">
                {history.map((rec) => (
                  <div
                    key={rec.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {rec.status === "completed" ? (
                          <CheckCircle2 className="size-3.5 shrink-0 text-primary" />
                        ) : (
                          <XCircle className="size-3.5 shrink-0 text-destructive" />
                        )}
                        <span className="font-mono text-[12px] font-medium text-foreground">
                          {rec.versionId}
                        </span>
                        <Badge
                          variant="outline"
                          className="h-4 border-border/70 px-1.5 font-mono text-[9px] font-normal text-muted-foreground"
                        >
                          {rec.threads} 线程
                        </Badge>
                        <span className="ml-auto flex items-center gap-1 font-mono text-[9.5px] text-muted-foreground">
                          <Clock className="size-2.5" />
                          {rec.finishedAt}
                        </span>
                      </div>

                      {rec.status === "completed" ? (
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                          {rec.totalFiles} 个文件 · {formatBytes(rec.totalBytes)} · 峰值{" "}
                          {formatSpeed(rec.peakSpeedBps)} · 耗时{" "}
                          {(rec.durationMs / 1000).toFixed(1)}s
                        </p>
                      ) : (
                        <p className="mt-1 truncate text-[10px] text-destructive">
                          {rec.error || "下载失败"}
                        </p>
                      )}
                    </div>

                    {rec.status === "completed" ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7 shrink-0 text-muted-foreground"
                        onClick={() =>
                          onOpenFolder(joinPath(gameRoot, "versions", rec.versionId))
                        }
                        title="打开版本目录"
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="xs"
                        className="h-6 shrink-0 gap-1 px-2 text-[10px]"
                        onClick={() => onInstall(rec.versionId)}
                        disabled={isDownloading}
                      >
                        <RefreshCw className="size-2.5" />
                        重试
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
