import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Download,
  FileCheck2,
  FolderOpen,
  Gauge,
  HardDriveDownload,
  LoaderCircle,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { cn } from "cn";
import {
  cleanDownloadCache,
  deleteBedrockVersion,
  deleteVersion,
} from "../lib/backend";
import {
  formatBytes,
  formatSpeed,
  progressPercent,
  stageLabel,
} from "../lib/format";
import type {
  ActiveDownloadTask,
  DownloadHistoryRecord,
  InstallProgress,
  InstalledVersion,
  LoaderSelection,
  StageProgress,
  VersionManifest,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  installQueue?: Array<{ versionId: string; selection?: LoaderSelection }>;
  gameRoot: string;
  onSelectVersion: (versionId: string) => void;
  onChangeThreads: (threads: number) => void;
  onInstall: (versionId: string) => void;
  onLaunch?: (versionId: string) => void;
  onClearHistory: () => void;
  onDeleteHistoryItem?: (id: string) => void;
  onOpenVersionSelect: () => void;
  onOpenFolder: (path: string) => void;
  onNotify?: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
  onRefreshInstalled?: () => Promise<void>;
  onPauseInstall?: () => void;
  onCancelInstall?: () => void;
  onResumeInstall?: (record: DownloadHistoryRecord) => void;
  onRemoveQueueItem?: (index: number) => void;
}

const THREAD_PRESETS = [4, 8, 16, 32, 64];

type ListTab = "all" | "active" | "paused" | "queued" | "completed" | "failed";

const DEFAULT_STAGES: StageProgress[] = [
  {
    stage: "prepare",
    label: "解析版本元数据与资源清单",
    status: "pending",
    doneFiles: 0,
    totalFiles: 3,
    doneBytes: 0,
    totalBytes: 0,
  },
  {
    stage: "client",
    label: "核心 Jar / 服务端组件 (多线程 Range 分片)",
    status: "pending",
    doneFiles: 0,
    totalFiles: 1,
    doneBytes: 0,
    totalBytes: 0,
  },
  {
    stage: "libraries",
    label: "运行依赖库与原生拓展",
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

function getTaskEdition(name: string): "bedrock" | "java" {
  const lower = name.toLowerCase();
  if (
    lower.includes("bedrock") ||
    lower.includes("基岩版") ||
    lower.startsWith("bedrock:")
  ) {
    return "bedrock";
  }
  return "java";
}

function getTaskCleanName(name: string): string {
  if (name.startsWith("bedrock:")) {
    return `Minecraft 基岩版 ${name.replace("bedrock:", "")}`;
  }
  return name.startsWith("Minecraft") ? name : `Minecraft ${name}`;
}

function StageIcon({ stage }: { stage: string }) {
  switch (stage) {
    case "prepare":
      return (
        <img
          src="/icons/minecraft/compass.png"
          alt="prepare"
          className="size-3.5 object-contain [image-rendering:pixelated]"
        />
      );
    case "client":
    case "core":
      return (
        <img
          src="/icons/minecraft/crafting_table.png"
          alt="client"
          className="size-3.5 object-contain [image-rendering:pixelated]"
        />
      );
    case "libraries":
    case "extract":
      return (
        <img
          src="/icons/minecraft/redstone_repeater.png"
          alt="libraries"
          className="size-3.5 object-contain [image-rendering:pixelated]"
        />
      );
    case "assets":
      return (
        <img
          src="/icons/minecraft/chest.png"
          alt="assets"
          className="size-3.5 object-contain [image-rendering:pixelated]"
        />
      );
    default:
      return <Download className="size-3.5" />;
  }
}

function StageStatusBadge({ status }: { status: StageProgress["status"] }) {
  if (status === "done") {
    return (
      <Badge
        variant="outline"
        className="h-4 gap-1 border-primary/30 bg-primary/10 px-1 text-[9px] font-normal text-primary"
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
        className="h-4 gap-1 border-gold/35 bg-gold/10 px-1 text-[9px] font-normal text-gold"
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
        className="h-4 gap-1 border-destructive/35 bg-destructive/10 px-1 text-[9px] font-normal text-destructive"
      >
        异常
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-4 border-border/70 bg-muted/30 px-1 text-[9px] font-normal text-muted-foreground"
    >
      待执行
    </Badge>
  );
}

function SpeedSparkline({ samples }: { samples: number[] }) {
  const max = Math.max(...samples, 1_048_576);
  const padded =
    samples.length >= 14
      ? samples.slice(-14)
      : [...Array.from({ length: 14 - samples.length }, () => 0), ...samples];

  return (
    <div
      className="flex h-5 items-end gap-0.5"
      aria-hidden="true"
      title="实时速度波形"
    >
      {padded.map((val, idx) => {
        const ratio = val > 0 ? Math.max(0.18, Math.min(1, val / max)) : 0.1;
        return (
          <span
            key={idx}
            style={{ height: `${Math.round(ratio * 100)}%` }}
            className={cn(
              "w-1 rounded-t-[1px] transition-all duration-150",
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
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/50 p-2.5">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Badge
            variant="outline"
            className="h-4 shrink-0 border-primary/30 bg-primary/10 px-1 font-mono text-[9px] font-normal text-primary"
          >
            线程 #{String(task.workerId).padStart(2, "0")}
          </Badge>
          {task.segments > 1 ? (
            <Badge
              variant="outline"
              className="h-4 shrink-0 border-gold/30 bg-gold/10 px-1 font-mono text-[9px] font-normal text-gold"
              title="HTTP Range 多分片并发加速"
            >
              Range ×{task.segments}
            </Badge>
          ) : (
            <span className="text-[9px] text-muted-foreground">并发流</span>
          )}
        </div>
        <span className="shrink-0 rounded bg-muted/50 px-1 py-0.5 text-[8.5px] text-muted-foreground">
          {stageLabel(task.stage)}
        </span>
      </div>

      <p
        className="truncate font-mono text-[10.5px] font-medium text-foreground/90"
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

      <div className="flex items-center justify-between gap-2 font-mono text-[9px] text-muted-foreground">
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
  manifest: _manifest,
  installed: _installed,
  selectedVersion: _selectedVersion,
  installingVersion,
  installProgress,
  lastProgress,
  downloadThreads,
  peakSpeedBps,
  speedHistory,
  fileEvents,
  history,
  installQueue = [],
  gameRoot,
  onSelectVersion: _onSelectVersion,
  onChangeThreads,
  onInstall,
  onLaunch,
  onClearHistory,
  onDeleteHistoryItem,
  onOpenVersionSelect,
  onOpenFolder,
  onNotify,
  onRefreshInstalled,
  onPauseInstall,
  onCancelInstall,
  onResumeInstall,
  onRemoveQueueItem,
}: DownloadsViewProps) {
  const [activeTab, setActiveTab] = useState<ListTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showActiveDetails, setShowActiveDetails] = useState(true);
  const [activeDetailTab, setActiveDetailTab] = useState<"stages" | "threads" | "logs">("threads");
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false);
  const [deletingRecord, setDeletingRecord] = useState<DownloadHistoryRecord | null>(null);
  const [deleteLocalFiles, setDeleteLocalFiles] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [cleanResidualsOnClear, setCleanResidualsOnClear] = useState(true);

  const activeProgress = installProgress ?? lastProgress;
  const isDownloading = Boolean(installingVersion && installProgress);
  const speedBps = isDownloading ? (installProgress?.speedBps ?? 0) : 0;
  const activeThreads = isDownloading ? (installProgress?.activeThreads ?? 0) : 0;
  const downloadedBytes = activeProgress?.downloadedBytes ?? 0;
  const totalBytes = activeProgress?.totalBytes ?? 0;
  const activeTasks = isDownloading ? (installProgress?.activeTasks ?? []) : [];

  const stages = useMemo<StageProgress[]>(() => {
    if (activeProgress?.stages && activeProgress.stages.length > 0) {
      return activeProgress.stages;
    }
    return DEFAULT_STAGES;
  }, [activeProgress]);

  const overallPercent = useMemo(() => {
    if (!activeProgress) return 0;
    if (activeProgress.stage === "done") return 100;
    if (totalBytes > 0) {
      return Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
    }
    return progressPercent(activeProgress.done, activeProgress.total) ?? 0;
  }, [activeProgress, downloadedBytes, totalBytes]);

  // Tab Counts
  const activeCount = isDownloading ? 1 : 0;
  const queuedCount = installQueue.length;
  const pausedCount = history.filter((h) => h.status === "paused").length;
  const completedCount = history.filter((h) => h.status === "completed").length;
  const failedCount = history.filter((h) => h.status === "failed").length;
  const totalCount = activeCount + queuedCount + history.length;

  // Filter history
  const filteredHistory = useMemo(() => {
    let list = history;
    if (activeTab === "completed") {
      list = list.filter((h) => h.status === "completed");
    } else if (activeTab === "failed") {
      list = list.filter((h) => h.status === "failed");
    } else if (activeTab === "paused") {
      list = list.filter((h) => h.status === "paused");
    } else if (activeTab === "active" || activeTab === "queued") {
      return [];
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter((h) => h.versionId.toLowerCase().includes(q));
    }
    return list;
  }, [history, activeTab, searchQuery]);

  const showActiveRow =
    isDownloading &&
    (activeTab === "all" || activeTab === "active") &&
    (!searchQuery.trim() ||
      (installingVersion && installingVersion.toLowerCase().includes(searchQuery.trim().toLowerCase())));

  const showQueuedRows =
    (activeTab === "all" || activeTab === "queued") &&
    installQueue.filter((q) =>
      !searchQuery.trim() ||
      q.versionId.toLowerCase().includes(searchQuery.trim().toLowerCase())
    );

  const isListEmpty = !showActiveRow && (!showQueuedRows || showQueuedRows.length === 0) && filteredHistory.length === 0;

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <PageHeader
        title="下载管理器"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-border/80 bg-card/70 px-3 text-[11.5px]"
              onClick={onOpenVersionSelect}
            >
              <ArrowLeft className="size-3.5" />
              下载新版本
            </Button>

            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 gap-1.5 border-border/80 px-3 text-[11.5px]",
                showSettingsDrawer ? "bg-accent text-foreground" : "bg-card/70",
              )}
              onClick={() => setShowSettingsDrawer(!showSettingsDrawer)}
            >
              <SlidersHorizontal className="size-3.5 text-gold" />
              <span>并发线程 ({downloadThreads})</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-border/80 bg-card/70 px-3 text-[11.5px]"
              onClick={() => onOpenFolder(gameRoot)}
              title="打开游戏主目录"
            >
              <FolderOpen className="size-3.5 text-muted-foreground" />
              <span>打开目录</span>
            </Button>

            {history.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 px-2.5 text-[11.5px] text-muted-foreground hover:text-destructive"
                onClick={() => setConfirmClearHistory(true)}
                title="清空所有已完成与失败记录，支持深度清理残留缓存"
              >
                <Trash2 className="size-3.5" />
                <span>清空记录</span>
              </Button>
            ) : null}
          </div>
        }
      />

      {/* Global Concurrency & Multi-threaded Settings Panel (Collapsible) */}
      {showSettingsDrawer ? (
        <Card className="border-gold/30 bg-gold/[0.03] p-4 transition-all animate-in fade-in-50">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <Zap className="size-4 text-gold" />
                <h4 className="text-[13px] font-medium text-foreground">
                  全局多线程并发加速配置
                </h4>
                <Badge
                  variant="outline"
                  className="h-5 border-gold/40 bg-gold/10 px-2 font-mono text-[10px] text-gold"
                >
                  全局默认下载工具
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                已将多线程下载器作为 Java 版客户端、依赖库、资源资产以及基岩版 BDS 核心的默认传输引擎。支持自动 HTTP Range 分片并发拉取。
              </p>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground mr-1">预设线程:</span>
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

          <div className="mt-3.5 flex items-center gap-4">
            <Slider
              min={1}
              max={64}
              step={1}
              value={[downloadThreads]}
              onValueChange={([val]) => {
                if (typeof val === "number") onChangeThreads(val);
              }}
              className="flex-1"
              aria-label="全局并发下载线程数"
            />
            <span className="w-16 font-mono text-[12px] font-semibold text-gold text-right">
              {downloadThreads} 线程
            </span>
          </div>
        </Card>
      ) : null}

      {/* Top Real-time Stats & Telemetry Banner */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Speed Card */}
        <Card className="gap-0 border-border/70 bg-card/60 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Gauge className="size-3.5 text-primary" />
              实时下载速率
            </span>
            <StatusDot tone={isDownloading ? "live" : "muted"} animated={isDownloading} />
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <p className="font-mono text-[20px] font-semibold tracking-tight text-foreground">
              {formatSpeed(speedBps)}
            </p>
            <SpeedSparkline samples={speedHistory} />
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>峰值 {formatSpeed(peakSpeedBps)}</span>
            <span className="font-mono text-primary/80">
              {isDownloading ? "高速并发中" : "待命中"}
            </span>
          </div>
        </Card>

        {/* Bytes Card */}
        <Card className="gap-0 border-border/70 bg-card/60 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <HardDriveDownload className="size-3.5 text-primary" />
              当前任务流量
            </span>
            <span className="font-mono text-[10.5px] text-primary">{overallPercent}%</span>
          </div>
          <p className="mt-1.5 font-mono text-[20px] font-semibold tracking-tight text-foreground">
            {formatBytes(downloadedBytes)}
          </p>
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>总计 {totalBytes > 0 ? formatBytes(totalBytes) : "计算中…"}</span>
            <span>{isDownloading ? "传输中" : "就绪"}</span>
          </div>
        </Card>

        {/* Concurrency Threads Card */}
        <Card className="gap-0 border-border/70 bg-card/60 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Cpu className="size-3.5 text-gold" />
              多线程工作池
            </span>
            <Badge
              variant="outline"
              className="h-4 border-gold/30 bg-gold/10 px-1 font-mono text-[9px] text-gold"
            >
              {downloadThreads} 线程
            </Badge>
          </div>
          <p className="mt-1.5 font-mono text-[20px] font-semibold tracking-tight text-foreground">
            {activeThreads}{" "}
            <span className="text-[12px] font-normal text-muted-foreground">
              / {downloadThreads} 活跃
            </span>
          </p>
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>HTTP Range 分片加速</span>
            <span className="text-gold font-mono">全局默认引擎</span>
          </div>
        </Card>

        {/* Task Summary Card */}
        <Card className="gap-0 border-border/70 bg-card/60 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <FileCheck2 className="size-3.5 text-primary" />
              任务执行统计
            </span>
            <ShieldCheck className="size-3.5 text-primary/80" />
          </div>
          <p className="mt-1.5 font-mono text-[20px] font-semibold tracking-tight text-foreground">
            {completedCount}{" "}
            <span className="text-[12px] font-normal text-muted-foreground">
              已完成 / {totalCount} 总任务
            </span>
          </p>
          <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>排队中 {queuedCount}</span>
            <span>异常失败 {failedCount}</span>
          </div>
        </Card>
      </div>

      {/* Task List Controls & Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
        {/* Status Tab Pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab("all")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
              activeTab === "all"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <span>全部任务</span>
            <span className="rounded-full bg-background/20 px-1.5 py-0.2 text-[10px]">
              {totalCount}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("active")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
              activeTab === "active"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <LoaderCircle className={cn("size-3", isDownloading && "animate-spin text-gold")} />
            <span>正在下载</span>
            {activeCount > 0 ? (
              <span className="rounded-full bg-gold/20 px-1.5 py-0.2 text-[10px] font-mono text-gold">
                {activeCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("paused")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
              activeTab === "paused"
                ? "bg-amber-500 text-black shadow-sm font-semibold"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <Pause className="size-3 fill-current" />
            <span>已暂停</span>
            {pausedCount > 0 ? (
              <span className="rounded-full bg-amber-500/20 px-1.5 py-0.2 text-[10px] font-mono text-amber-400">
                {pausedCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("queued")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
              activeTab === "queued"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <Clock className="size-3" />
            <span>等待队列</span>
            {queuedCount > 0 ? (
              <span className="rounded-full bg-background/20 px-1.5 py-0.2 text-[10px]">
                {queuedCount}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("completed")}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
              activeTab === "completed"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
          >
            <CheckCircle2 className="size-3" />
            <span>已完成</span>
            {completedCount > 0 ? (
              <span className="rounded-full bg-background/20 px-1.5 py-0.2 text-[10px]">
                {completedCount}
              </span>
            ) : null}
          </button>

          {failedCount > 0 ? (
            <button
              type="button"
              onClick={() => setActiveTab("failed")}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors",
                activeTab === "failed"
                  ? "bg-destructive text-destructive-foreground shadow-sm"
                  : "bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
            >
              <XCircle className="size-3" />
              <span>失败</span>
              <span className="rounded-full bg-background/20 px-1.5 py-0.2 text-[10px]">
                {failedCount}
              </span>
            </button>
          ) : null}
        </div>

        {/* Search input */}
        <div className="relative min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索任务名称或版本..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-[11.5px]"
          />
        </div>
      </div>

      {/* Task List View */}
      <div className="space-y-3">
        {/* 1. Active Task Row (If downloading) */}
        {showActiveRow && installingVersion ? (
          <Card className="border-primary/40 bg-primary/[0.02] shadow-sm overflow-hidden">
            <div className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* Left: Icon & Title */}
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-xl border p-1",
                      "border-primary/40 bg-primary/10 text-primary",
                    )}
                  >
                    <img
                      src={
                        getTaskEdition(installingVersion) === "bedrock"
                          ? "/icons/minecraft/bedrock.png"
                          : "/icons/minecraft/grass_block.png"
                      }
                      alt="edition icon"
                      className="size-7 object-contain [image-rendering:pixelated]"
                    />
                  </span>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[14px] font-medium text-foreground">
                        {getTaskCleanName(installingVersion)}
                      </h3>
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-5 shrink-0 px-1.5 text-[10px] font-normal",
                          "border-primary/30 bg-primary/10 text-primary",
                        )}
                      >
                        {getTaskEdition(installingVersion) === "bedrock"
                          ? "基岩版 BDS"
                          : "Java 版全组件"}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="h-5 shrink-0 border-gold/40 bg-gold/10 px-1.5 text-[10px] font-normal text-gold animate-pulse"
                      >
                        <LoaderCircle className="size-2.5 mr-1 animate-spin" />
                        多线程并发下载中
                      </Badge>
                    </div>

                    <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {activeProgress
                        ? `${stageLabel(activeProgress.stage)} · ${activeProgress.detail}`
                        : "正在连接下载节点并拉取分片…"}
                    </p>
                  </div>
                </div>

                {/* Right: Metrics & Actions */}
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <p className="font-mono text-[14px] font-semibold text-foreground">
                      {formatSpeed(speedBps)}
                    </p>
                    <p className="font-mono text-[10.5px] text-muted-foreground">
                      {formatBytes(downloadedBytes)} /{" "}
                      {totalBytes > 0 ? formatBytes(totalBytes) : "计算中"}
                    </p>
                  </div>

                  {onPauseInstall ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 border-amber-500/40 text-amber-400 hover:bg-amber-500/10 px-2.5 text-[11px]"
                      onClick={onPauseInstall}
                      title="暂停当前下载任务"
                    >
                      <Pause className="size-3.5 fill-current" />
                      <span>暂停</span>
                    </Button>
                  ) : null}

                  {onCancelInstall ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 px-2.5 text-[11px]"
                      onClick={onCancelInstall}
                      title="取消当前下载任务"
                    >
                      <XCircle className="size-3.5" />
                      <span>取消</span>
                    </Button>
                  ) : null}

                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 border-border/80 px-2.5 text-[11px]"
                    onClick={() => setShowActiveDetails(!showActiveDetails)}
                  >
                    {showActiveDetails ? (
                      <>
                        <span>收起详情</span>
                        <ChevronUp className="size-3.5" />
                      </>
                    ) : (
                      <>
                        <span>分片详情</span>
                        <ChevronDown className="size-3.5" />
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mt-3 space-y-1">
                <Progress
                  value={overallPercent}
                  className="h-2 rounded-sm bg-primary/15 [&_[data-slot=progress-indicator]]:rounded-sm"
                />
                <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
                  <span>
                    并发池: {activeThreads} / {downloadThreads} 线程 · Range 多分片并行拉取
                  </span>
                  <span className="font-semibold text-primary">{overallPercent}%</span>
                </div>
              </div>
            </div>

            {/* Expandable Inspection Drawer */}
            {showActiveDetails ? (
              <div className="border-t border-border/60 bg-muted/20 p-4 space-y-4">
                {/* Detail Tab Switcher */}
                <div className="flex items-center justify-between border-b border-border/50 pb-2.5">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setActiveDetailTab("threads")}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                        activeDetailTab === "threads"
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      实时线程工作池 ({activeTasks.length > 0 ? activeTasks.length : activeThreads})
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveDetailTab("stages")}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                        activeDetailTab === "stages"
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      阶段流水线 ({stages.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveDetailTab("logs")}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                        activeDetailTab === "logs"
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      实时文件流 ({fileEvents.length})
                    </button>
                  </div>

                  <span className="font-mono text-[10px] text-muted-foreground">
                    HTTP Range 分片加速 · SHA-1 实时校验
                  </span>
                </div>

                {/* 1. Worker Threads View */}
                {activeDetailTab === "threads" ? (
                  activeTasks.length > 0 ? (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {activeTasks.map((task) => (
                        <WorkerTaskCard key={task.workerId} task={task} />
                      ))}
                    </div>
                  ) : (
                    <div className="py-6 text-center text-[11.5px] text-muted-foreground">
                      正在调度 {downloadThreads} 线程工作池连接远端 CDN 分片...
                    </div>
                  )
                ) : null}

                {/* 2. Pipeline Stages View */}
                {activeDetailTab === "stages" ? (
                  <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
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
                            "flex flex-col justify-between rounded-lg border p-3",
                            item.status === "active"
                              ? "border-gold/40 bg-gold/[0.04]"
                              : item.status === "done"
                                ? "border-primary/30 bg-primary/[0.03]"
                                : "border-border/60 bg-background/30",
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground">
                              <StageIcon stage={item.stage} />
                              <span>{item.label}</span>
                            </span>
                            <StageStatusBadge status={item.status} />
                          </div>

                          <div className="mt-3 space-y-1">
                            <Progress
                              value={pct ?? (item.status === "active" ? 35 : 0)}
                              className="h-1 rounded-sm bg-primary/15"
                            />
                            <div className="flex justify-between font-mono text-[9px] text-muted-foreground">
                              <span>
                                {item.totalBytes > 0
                                  ? `${formatBytes(item.doneBytes)} / ${formatBytes(item.totalBytes)}`
                                  : `项 ${item.doneFiles} / ${item.totalFiles || "—"}`}
                              </span>
                              <span>{pct !== null ? `${pct}%` : "0%"}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {/* 3. Live File Log View */}
                {activeDetailTab === "logs" ? (
                  fileEvents.length === 0 ? (
                    <div className="py-6 text-center text-[11.5px] text-muted-foreground">
                      暂无文件拉取日志，启动下载后将实时记录。
                    </div>
                  ) : (
                    <div className="max-h-[220px] divide-y divide-border/40 overflow-y-auto rounded-lg border border-border/60 bg-background/40">
                      {fileEvents.slice(0, 15).map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between gap-2.5 px-3 py-1.5 text-[11px]"
                        >
                          <div className="min-w-0 flex-1 flex items-center gap-2">
                            <span className="font-mono text-[9.5px] text-muted-foreground">
                              {ev.time}
                            </span>
                            <Badge
                              variant="outline"
                              className="h-4 border-border/70 px-1 text-[9px] text-muted-foreground"
                            >
                              {stageLabel(ev.stage)}
                            </Badge>
                            <span className="truncate font-mono text-[10.5px] text-foreground/90">
                              {ev.detail}
                            </span>
                          </div>
                          {ev.speedBps > 0 ? (
                            <span className="font-mono text-[9.5px] text-muted-foreground">
                              {formatSpeed(ev.speedBps)}
                            </span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  )
                ) : null}
              </div>
            ) : null}
          </Card>
        ) : null}

        {/* 2. Queued Tasks */}
        {showQueuedRows &&
          showQueuedRows.map((q, idx) => (
            <Card
              key={`${q.versionId}-${idx}`}
              className="border-border/70 bg-card/50 p-4 transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/40 p-1 text-muted-foreground">
                    <img
                      src="/icons/minecraft/compass.png"
                      alt="queue"
                      className="size-5 object-contain [image-rendering:pixelated]"
                    />
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="text-[13px] font-medium text-foreground">
                        {getTaskCleanName(q.versionId)}
                      </h4>
                      <Badge
                        variant="outline"
                        className="h-4.5 border-border/70 bg-muted/30 px-1.5 text-[9.5px] font-normal text-muted-foreground"
                      >
                        队列等待 #{idx + 1}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      等待当前活跃任务完成后自动启动下载
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    等待排队
                  </Badge>
                  {onRemoveQueueItem ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => onRemoveQueueItem(idx)}
                      title="取消排队"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}

        {/* 3. Completed, Paused & Failed Tasks (History List) */}
        {filteredHistory.map((item) => {
          const isBedrock = getTaskEdition(item.versionId) === "bedrock";
          const isSuccess = item.status === "completed";
          const isPaused = item.status === "paused";

          return (
            <Card
              key={item.id}
              className={cn(
                "border-border/60 bg-card/45 p-4 transition-colors hover:border-border hover:bg-card/70",
                isPaused && "border-amber-500/30 bg-amber-500/[0.02]"
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                {/* Left: Icon & Info */}
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg border p-1",
                      isSuccess
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : isPaused
                          ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
                          : "border-destructive/30 bg-destructive/10 text-destructive",
                    )}
                  >
                    {isSuccess ? (
                      <img
                        src={
                          isBedrock
                            ? "/icons/minecraft/bedrock.png"
                            : "/icons/minecraft/grass_block.png"
                        }
                        alt="edition icon"
                        className="size-6 object-contain [image-rendering:pixelated]"
                      />
                    ) : isPaused ? (
                      <Pause className="size-4.5 fill-current" />
                    ) : (
                      <img
                        src="/icons/minecraft/barrier.png"
                        alt="failed icon"
                        className="size-5 object-contain [image-rendering:pixelated]"
                      />
                    )}
                  </span>

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="truncate text-[13.5px] font-medium text-foreground">
                        {getTaskCleanName(item.versionId)}
                      </h4>
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-4.5 shrink-0 px-1.5 text-[9.5px] font-normal",
                          "border-primary/25 bg-primary/10 text-primary",
                        )}
                      >
                        {isBedrock ? "基岩版 BDS" : "Java 版"}
                      </Badge>

                      {isSuccess ? (
                        <Badge
                          variant="outline"
                          className="h-4.5 shrink-0 border-primary/30 bg-primary/10 px-1.5 text-[9.5px] font-normal text-primary"
                        >
                          <Check className="size-2.5 mr-0.5" />
                          已完成
                        </Badge>
                      ) : isPaused ? (
                        <Badge
                          variant="outline"
                          className="h-4.5 shrink-0 border-amber-500/40 bg-amber-500/15 px-1.5 text-[9.5px] font-normal text-amber-400"
                        >
                          <Pause className="size-2 mr-1 fill-current" />
                          {item.pausedReason || "已暂停"}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="h-4.5 shrink-0 border-destructive/30 bg-destructive/10 px-1.5 text-[9.5px] font-normal text-destructive"
                        >
                          下载失败
                        </Badge>
                      )}
                    </div>

                    <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10.5px] text-muted-foreground">
                      {isSuccess ? (
                        <>
                          <span>数据量 {formatBytes(item.totalBytes)}</span>
                          <span>·</span>
                          <span>耗时 {(item.durationMs / 1000).toFixed(1)}s</span>
                          <span>·</span>
                          <span>峰值 {formatSpeed(item.peakSpeedBps)}</span>
                          <span>·</span>
                          <span>{item.threads} 线程并发</span>
                          <span>·</span>
                          <span>{item.finishedAt}</span>
                        </>
                      ) : isPaused ? (
                        <>
                          <span className="text-amber-400 font-medium">
                            已下载 {formatBytes(item.downloadedBytes || 0)} / {item.totalBytes > 0 ? formatBytes(item.totalBytes) : "计算中"}
                            {item.totalBytes > 0 ? ` (${Math.round(((item.downloadedBytes || 0) / item.totalBytes) * 100)}%)` : ""}
                          </span>
                          <span>·</span>
                          <span>{item.threads} 线程</span>
                          <span>·</span>
                          <span>{item.finishedAt}</span>
                        </>
                      ) : (
                        <>
                          <span className="text-destructive/90">{item.error || "下载中断"}</span>
                          <span>·</span>
                          <span>{item.finishedAt}</span>
                        </>
                      )}
                    </div>

                    {isPaused && item.totalBytes > 0 ? (
                      <div className="mt-2 w-full max-w-sm space-y-1">
                        <Progress
                          value={Math.min(100, Math.round(((item.downloadedBytes || 0) / item.totalBytes) * 100))}
                          className="h-1 rounded-sm bg-amber-500/15 [&_[data-slot=progress-indicator]]:bg-amber-400"
                        />
                      </div>
                    ) : null}
                  </div>
                </div>

                {/* Right: Actions */}
                <div className="flex items-center gap-2">
                  {isPaused && onResumeInstall ? (
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7.5 gap-1.5 px-3 text-[11px] bg-amber-500 text-black hover:bg-amber-400 font-semibold"
                      onClick={() => onResumeInstall(item)}
                    >
                      <Play className="size-3 fill-current" />
                      <span>继续下载</span>
                    </Button>
                  ) : null}

                  {isSuccess && onLaunch ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7.5 gap-1.5 border-border/80 px-2.5 text-[11px]"
                      onClick={() => onLaunch(item.versionId.replace("Minecraft ", ""))}
                    >
                      <Play className="size-3 text-primary" />
                      <span>启动</span>
                    </Button>
                  ) : null}

                  {!isPaused ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7.5 gap-1.5 border-border/80 px-2.5 text-[11px]"
                      onClick={() => onInstall(item.versionId.replace("Minecraft ", ""))}
                      title="重新触发多线程下载或校验"
                    >
                      <RotateCcw className="size-3" />
                      <span>{isSuccess ? "校验" : "重试"}</span>
                    </Button>
                  ) : null}

                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7.5 gap-1.5 border-border/80 px-2 text-[11px]"
                    onClick={() => onOpenFolder(gameRoot)}
                    title="打开所在目录"
                  >
                    <FolderOpen className="size-3" />
                  </Button>

                  {onDeleteHistoryItem ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7.5 px-2 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setDeletingRecord(item);
                        setDeleteLocalFiles(true);
                      }}
                      title="删除此任务与关联残留文件"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          );
        })}

        {/* 4. Empty State */}
        {isListEmpty ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-card/25 px-6 py-14 text-center">
            <div className="flex size-12 items-center justify-center rounded-xl border border-border/70 bg-muted/30 p-2 text-muted-foreground">
              <img
                src="/icons/minecraft/grass_block.png"
                alt="grass block"
                className="size-8 object-contain opacity-75 [image-rendering:pixelated]"
              />
            </div>
            <h3 className="mt-3.5 text-[14px] font-medium text-foreground">
              {searchQuery ? "未找到匹配的下载任务" : "当前没有正在执行或记录的下载任务"}
            </h3>
            <p className="mt-1 max-w-md text-[11.5px] leading-5 text-muted-foreground">
              {searchQuery
                ? `未找到与 “${searchQuery}” 相关的版本记录，请尝试其他关键词。`
                : "你可以随时前往版本下载页面，选择 Java 版或基岩版开始极速多线程下载。"}
            </p>
            <div className="mt-5 flex items-center gap-2">
              <Button
                size="sm"
                className="h-8 gap-1.5 px-3.5 text-[11.5px]"
                onClick={onOpenVersionSelect}
              >
                <Sparkles className="size-3.5" />
                挑选并下载版本 (Java / 基岩版)
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* 5. Delete History Item Confirmation Modal */}
      {deletingRecord ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in-0 duration-150">
          <div className="w-full max-w-sm rounded-xl border border-border/80 bg-background/95 p-5 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <Trash2 className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground">删除下载任务与文件</h3>
                <p className="mt-0.5 text-xs text-muted-foreground truncate font-mono">
                  {deletingRecord.versionId}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-border/70 bg-card/40 p-3 space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer text-xs select-none">
                <input
                  type="checkbox"
                  checked={deleteLocalFiles}
                  onChange={(e) => setDeleteLocalFiles(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-border accent-destructive cursor-pointer"
                />
                <div className="space-y-0.5">
                  <span className="font-medium text-foreground">
                    同时彻底删除本地已下载的核心文件与安装包残留
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    清理本地版本目录及 download cache 残留（.zip / .part 临时包），释放硬盘空间。
                  </p>
                </div>
              </label>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isDeleting}
                onClick={() => setDeletingRecord(null)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isDeleting}
                className="gap-1.5"
                onClick={async () => {
                  if (!deletingRecord) return;
                  setIsDeleting(true);
                  try {
                    if (deleteLocalFiles) {
                      const edition = getTaskEdition(deletingRecord.versionId);
                      const cleanVer = deletingRecord.versionId
                        .replace(/^Minecraft 基岩版 /, "")
                        .replace(/^Minecraft /, "")
                        .replace(/^bedrock:/, "")
                        .trim();
                      if (edition === "bedrock") {
                        await deleteBedrockVersion(cleanVer, gameRoot);
                      } else {
                        await deleteVersion(gameRoot, cleanVer);
                      }
                      await onRefreshInstalled?.();
                    }
                    onDeleteHistoryItem?.(deletingRecord.id);
                    onNotify?.(
                      "success",
                      "已成功删除",
                      deleteLocalFiles
                        ? `已彻底删除 ${deletingRecord.versionId} 及其本地残留文件。`
                        : "已从下载历史记录中移除该任务。",
                    );
                    setDeletingRecord(null);
                  } catch (err) {
                    onNotify?.("error", "删除失败", String(err));
                  } finally {
                    setIsDeleting(false);
                  }
                }}
              >
                {isDeleting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                确认删除
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 6. Clear All History Confirmation Modal */}
      {confirmClearHistory ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in-0 duration-150">
          <div className="w-full max-w-sm rounded-xl border border-border/80 bg-background/95 p-5 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <Trash2 className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground">清空所有下载记录</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  共 {history.length} 条已完成或失败记录
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-border/70 bg-card/40 p-3 space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer text-xs select-none">
                <input
                  type="checkbox"
                  checked={cleanResidualsOnClear}
                  onChange={(e) => setCleanResidualsOnClear(e.target.checked)}
                  className="mt-0.5 size-4 rounded border-border accent-destructive cursor-pointer"
                />
                <div className="space-y-0.5">
                  <span className="font-medium text-foreground">
                    同时深度清理所有残留缓存文件
                  </span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    扫描并清理基岩版临时压缩包（.zip）、分片缓存（.part）与安装包残留。
                  </p>
                </div>
              </label>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isDeleting}
                onClick={() => setConfirmClearHistory(false)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={isDeleting}
                className="gap-1.5"
                onClick={async () => {
                  setIsDeleting(true);
                  try {
                    let detailMsg = "已清空所有下载记录。";
                    if (cleanResidualsOnClear) {
                      const freed = await cleanDownloadCache(gameRoot);
                      if (freed > 0) {
                        detailMsg = `已清空记录并深度清理了 ${formatBytes(freed)} 的残留文件。`;
                      } else {
                        detailMsg = "已清空记录，未发现其他残留缓存。";
                      }
                      await onRefreshInstalled?.();
                    }
                    onClearHistory();
                    onNotify?.("success", "清空完成", detailMsg);
                    setConfirmClearHistory(false);
                  } catch (err) {
                    onNotify?.("error", "清理失败", String(err));
                  } finally {
                    setIsDeleting(false);
                  }
                }}
              >
                {isDeleting ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                确认清空
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
