import { useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  LayoutDashboard,
  Layers3,
  LoaderCircle,
  MemoryStick,
  FolderOpen,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Wrench,
} from "lucide-react";
import { cn } from "cn";
import { formatDate, joinPath, typeLabel, typeTone } from "../lib/format";
import type {
  GameStateName,
  InstallProgress,
  InstalledVersion,
  JavaInstall,
  LauncherVisibility,
  ProcessPriority,
  VersionIsolation,
  VersionManifest,
  WindowSizeMode,
} from "../lib/types";
import type { VersionLaunchSettings } from "../lib/versionSettings";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import type { LogEntry } from "./Console";
import { PlayView } from "./PlayView";
import { GrassBlock, PageHeader, TypeBadge } from "./ui";

interface RuntimeView {
  status: GameStateName;
  detail?: string | null;
  pid?: number | null;
  versionId?: string | null;
}

interface VersionSettingsViewProps {
  manifest: VersionManifest | null;
  installed: InstalledVersion[];
  selectedVersion: string;
  onSelectVersion: (versionId: string) => void;
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
  launchSettings: VersionLaunchSettings;
  hasOverride: boolean;
  onChangeLaunchSettings: (patch: Partial<VersionLaunchSettings>) => void;
  onResetLaunchSettings: () => void;
  onLaunch: () => void;
  onStop: () => void;
  onInstall: (versionId: string) => void;
  onOpenVersionSelect: () => void;
  onOpenFolder: (path: string) => void;
  onRefreshJava: () => void;
  onClearLogs: () => void;
  onDeleteVersion?: (versionId: string) => Promise<void> | void;
}

type Section = "overview" | "launch";

function VersionSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; description?: string }>;
  onChange: (val: T) => void;
}) {
  const current = options.find((opt) => opt.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="h-9 w-full justify-between border-border/70 bg-background/40 px-3 text-left font-normal text-[12px] hover:bg-muted/30 hover:text-foreground"
        >
          <span className="truncate">{current?.label ?? value}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[240px] p-1">
        {options.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            className={cn(
              "flex cursor-pointer items-center justify-between rounded-sm px-2.5 py-1.5 text-[12px]",
              value === opt.value && "bg-primary/10 font-medium text-primary",
            )}
            onClick={() => onChange(opt.value)}
          >
            <div className="flex flex-col">
              <span>{opt.label}</span>
              {opt.description ? (
                <span className="text-[10px] text-muted-foreground">{opt.description}</span>
              ) : null}
            </div>
            {value === opt.value ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LaunchSettingsPanel({
  versionId,
  settings,
  hasOverride,
  isInstalled,
  onChange,
  onReset,
  onOpenFolder,
  onDelete,
  gameRoot,
}: {
  versionId: string;
  settings: VersionLaunchSettings;
  hasOverride: boolean;
  isInstalled: boolean;
  onChange: (patch: Partial<VersionLaunchSettings>) => void;
  onReset: () => void;
  onOpenFolder: (path: string) => void;
  onDelete?: () => void;
  gameRoot: string;
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  return (
    <div className="space-y-4">
      <Card className="gap-0 border-border/70 bg-card/55 py-0">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
              <MemoryStick className="size-4" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-[13px] font-medium">内存分配</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-end justify-between gap-3">
            <Label className="text-[11px] font-normal text-muted-foreground">
              最大内存
            </Label>
            <span className="font-mono text-[12px] text-foreground">
              {settings.memoryMb} MB
            </span>
          </div>
          <Slider
            min={1024}
            max={16384}
            step={512}
            value={[settings.memoryMb]}
            onValueChange={([value]) => {
              if (typeof value === "number") onChange({ memoryMb: value });
            }}
            aria-label="最大内存"
          />
          <div className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
            <span>1 GB</span>
            <span>8 GB</span>
            <span>16 GB</span>
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 border-border/70 bg-card/55 py-0">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
              <SlidersHorizontal className="size-4" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-[13px] font-medium">启动选项</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] font-normal text-muted-foreground">
                版本隔离
              </Label>
              <VersionSelect<VersionIsolation>
                value={settings.versionIsolation}
                options={[
                  { value: "all", label: "隔离所有版本", description: "使用独立的 saves、mods 和配置文件夹" },
                  { value: "modded", label: "仅隔离模组包", description: "仅模组版本使用独立文件夹" },
                  { value: "none", label: "不隔离", description: "共用根目录下的数据" },
                ]}
                onChange={(val) => onChange({ versionIsolation: val })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="version-window-title" className="text-[11px] font-normal text-muted-foreground">
                游戏窗口标题
              </Label>
              <Input
                id="version-window-title"
                placeholder="默认"
                value={settings.windowTitle}
                spellCheck={false}
                className="h-9 bg-background/40 text-[12px]"
                onChange={(e) => onChange({ windowTitle: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="version-custom-info" className="text-[11px] font-normal text-muted-foreground">
                自定义信息
              </Label>
              <Input
                id="version-custom-info"
                placeholder="PCL"
                value={settings.customInfo}
                spellCheck={false}
                className="h-9 bg-background/40 text-[12px]"
                onChange={(e) => onChange({ customInfo: e.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] font-normal text-muted-foreground">
                启动器可见性
              </Label>
              <VersionSelect<LauncherVisibility>
                value={settings.launcherVisibility}
                options={[
                  { value: "keep", label: "游戏启动后仍保持不变" },
                  { value: "hide", label: "游戏启动后隐藏启动器" },
                  { value: "close", label: "游戏启动后关闭启动器" },
                ]}
                onChange={(val) => onChange({ launcherVisibility: val })}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] font-normal text-muted-foreground">
                进程优先级
              </Label>
              <VersionSelect<ProcessPriority>
                value={settings.processPriority}
                options={[
                  { value: "normal", label: "中（平衡）" },
                  { value: "realtime", label: "实时" },
                  { value: "high", label: "高" },
                  { value: "above_normal", label: "高于正常" },
                  { value: "below_normal", label: "低于正常" },
                  { value: "low", label: "低" },
                ]}
                onChange={(val) => onChange({ processPriority: val })}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] font-normal text-muted-foreground">
                窗口大小
              </Label>
              <VersionSelect<WindowSizeMode>
                value={settings.windowSize}
                options={[
                  { value: "default", label: "默认" },
                  { value: "fullscreen", label: "全屏" },
                  { value: "custom", label: "自定义" },
                ]}
                onChange={(val) => {
                  onChange({
                    windowSize: val,
                    resolutionEnabled: val === "custom",
                  });
                }}
              />
            </div>
          </div>

          {(settings.windowSize === "custom" || settings.resolutionEnabled) && (
            <div className="pt-3 border-t border-border/40 space-y-2">
              <Label className="text-[11px] text-muted-foreground font-normal">
                自定义窗口分辨率 (px)
              </Label>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 max-w-sm">
                <Input
                  type="number"
                  min={320}
                  max={7680}
                  step={10}
                  value={settings.width}
                  className="h-8 bg-background/40 font-mono text-[11px]"
                  onChange={(event) =>
                    onChange({ width: Number(event.target.value) || 1280 })
                  }
                />
                <span className="text-[11px] text-muted-foreground">×</span>
                <Input
                  type="number"
                  min={240}
                  max={4320}
                  step={10}
                  value={settings.height}
                  className="h-8 bg-background/40 font-mono text-[11px]"
                  onChange={(event) =>
                    onChange({ height: Number(event.target.value) || 720 })
                  }
                />
              </div>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-5 py-3">
          <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {hasOverride ? (
              <>
                <Check className="size-3 text-primary" />
                已覆盖启动器默认设置
              </>
            ) : (
              <>当前使用启动器默认设置</>
            )}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="h-6 gap-1.5 px-1.5 text-[10px] text-muted-foreground"
            onClick={onReset}
            disabled={!hasOverride}
          >
            <RotateCcw className="size-3" />
            恢复默认
          </Button>
        </CardFooter>
      </Card>

      <Card className="gap-0 border-border/70 bg-card/55 py-0">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
              <FolderOpen className="size-4" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-[13px] font-medium">版本目录</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-muted/15 p-3">
            <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
              {joinPath(gameRoot, "versions", versionId)}
            </code>
            <Button
              variant="outline"
              size="xs"
              className="h-7 shrink-0 gap-1.5 px-2 text-[10px]"
              onClick={() => onOpenFolder(joinPath(gameRoot, "versions", versionId))}
              disabled={!isInstalled}
              title={isInstalled ? undefined : "安装后可打开版本目录"}
            >
              <FolderOpen className="size-3" />
              打开
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      {isInstalled && onDelete ? (
        <Card className="gap-0 border-destructive/35 bg-destructive/5 py-0">
          <CardHeader className="border-b border-destructive/20 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" />
              <CardTitle className="text-xs font-medium text-destructive">危险操作区域</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <span className="block text-xs font-medium text-foreground">删除此版本核心与文件</span>
              <span className="block text-[11px] text-muted-foreground">
                永久删除版本 {versionId} 的客户端文件与配置目录。此操作无法撤销。
              </span>
            </div>
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => setShowDeleteConfirm(true)}
            >
              <Trash2 className="size-3.5" />
              删除版本
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in-0 duration-150">
          <div className="w-full max-w-sm rounded-xl border border-border/80 bg-background/95 p-5 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <Trash2 className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground">确认删除此版本？</h3>
                <p className="mt-0.5 text-xs text-muted-foreground truncate font-mono">
                  {versionId}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              此操作将永久清理版本【<span className="font-mono text-foreground">{versionId}</span>】的文件目录，所有核心组件将被清除。
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isDeleting}
                onClick={() => setShowDeleteConfirm(false)}
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
                    await onDelete?.();
                    setShowDeleteConfirm(false);
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
    </div>
  );
}

export function VersionSettingsView({
  manifest,
  installed,
  selectedVersion,
  onSelectVersion,
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
  launchSettings,
  hasOverride,
  onChangeLaunchSettings,
  onResetLaunchSettings,
  onLaunch,
  onStop,
  onInstall,
  onOpenVersionSelect,
  onOpenFolder,
  onRefreshJava,
  onClearLogs,
  onDeleteVersion,
}: VersionSettingsViewProps) {
  const [section, setSection] = useState<Section>("overview");
  const installedVersion = installed.find((version) => version.id === selectedVersion);
  const summary = manifest?.versions.find((version) => version.id === selectedVersion);
  const isInstalled = Boolean(installedVersion);
  const isLatest = Boolean(manifest && manifest.latest.release === selectedVersion);
  const versionType = installedVersion?.type ?? summary?.type ?? "release";

  return (
    <div className="space-y-5">
      <PageHeader
        title="版本设置"
        actions={
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-[10.5px] text-muted-foreground sm:flex">
              <Check className="size-3.5 text-primary" />
              自动保存
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              onClick={onOpenVersionSelect}
            >
              <Layers3 className="size-3.5" />
              版本选择
            </Button>
          </div>
        }
      />

      {!selectedVersion ? (
        <Card className="gap-0 overflow-hidden border-border/70 bg-card/55 py-0">
          <CardContent className="flex flex-col items-center gap-4 px-6 py-16 text-center">
            <div className="rounded-2xl border border-border/80 bg-background/60 p-4">
              <GrassBlock size={76} />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold">还没有选择版本</h2>
              <p className="mt-1 max-w-sm text-[11.5px] leading-5 text-muted-foreground">
                版本设置需要一个当前版本。先去版本选择页挑一个，或下载新的游戏文件。
              </p>
            </div>
            <Button onClick={onOpenVersionSelect} className="gap-2">
              <Layers3 className="size-4" />
              打开版本选择
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
          <aside className="rounded-xl border border-border/70 bg-card/55 min-[1024px]:sticky min-[1024px]:top-0">
            <div className="border-b border-border/60 px-3.5 py-4">
              <p className="text-[10px] text-muted-foreground">当前版本</p>
              <p
                className="mt-1 truncate font-pixel text-[15px] text-foreground"
                title={selectedVersion}
              >
                {selectedVersion}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <TypeBadge
                  type={versionType}
                  tone={typeTone(versionType)}
                  label={typeLabel(versionType)}
                />
                {isInstalled ? (
                  <Badge
                    variant="outline"
                    className="h-4 gap-0.5 rounded-[4px] border-primary/25 bg-primary/5 px-1.5 text-[9px] font-normal text-primary"
                  >
                    <Check className="size-2.5" />
                    已安装
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="h-4 rounded-[4px] border-gold/25 bg-gold/5 px-1.5 text-[9px] font-normal text-gold"
                  >
                    未安装
                  </Badge>
                )}
                {isLatest ? (
                  <Badge className="h-4 rounded-[4px] border-0 bg-gold/15 px-1.5 text-[9px] font-normal text-gold">
                    最新
                  </Badge>
                ) : null}
              </div>
              {summary?.releaseTime ? (
                <p className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <CalendarDays className="size-3" />
                  {formatDate(summary.releaseTime)}
                </p>
              ) : null}
            </div>

            <nav className="flex flex-col gap-1 p-1.5" aria-label="版本设置导航">
              <button
                type="button"
                onClick={() => setSection("overview")}
                aria-current={section === "overview" ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground",
                  section === "overview" && "bg-accent/70 text-foreground",
                )}
              >
                {section === "overview" ? (
                  <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                ) : null}
                <LayoutDashboard
                  className={cn(
                    "size-3.5",
                    section === "overview" ? "text-primary" : "text-muted-foreground/75",
                  )}
                />
                概览
              </button>
              <button
                type="button"
                onClick={() => setSection("launch")}
                aria-current={section === "launch" ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground",
                  section === "launch" && "bg-accent/70 text-foreground",
                )}
              >
                {section === "launch" ? (
                  <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                ) : null}
                <Wrench
                  className={cn(
                    "size-3.5",
                    section === "launch" ? "text-primary" : "text-muted-foreground/75",
                  )}
                />
                启动设置
              </button>
            </nav>

            <Separator />
            <div className="flex flex-col gap-0.5 p-1.5">
              <button
                type="button"
                className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                onClick={onOpenVersionSelect}
              >
                <Layers3 className="size-3.5" />
                更换版本
              </button>
              <button
                type="button"
                disabled={!isInstalled}
                title={isInstalled ? undefined : "安装后可打开版本目录"}
                className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                onClick={() =>
                  onOpenFolder(joinPath(gameRoot, "versions", selectedVersion))
                }
              >
                <FolderOpen className="size-3.5" />
                打开目录
              </button>
            </div>
          </aside>

          <div className="min-w-0">
            {section === "overview" ? (
              <PlayView
                embedded
                manifest={manifest}
                installed={installed}
                selectedVersion={selectedVersion}
                onSelectVersion={onSelectVersion}
                settingsMemory={launchSettings.memoryMb}
                playerName={playerName}
                gameRoot={gameRoot}
                javaInstalls={javaInstalls}
                javaDetecting={javaDetecting}
                javaPath={javaPath}
                runtime={runtime}
                installProgress={installProgress}
                installingVersion={installingVersion}
                launchProgress={launchProgress}
                logs={logs}
                onLaunch={onLaunch}
                onStop={onStop}
                onInstall={onInstall}
                onOpenVersions={onOpenVersionSelect}
                onOpenSettings={() => setSection("launch")}
                onOpenFolder={onOpenFolder}
                onRefreshJava={onRefreshJava}
                onClearLogs={onClearLogs}
              />
            ) : (
              <LaunchSettingsPanel
                versionId={selectedVersion}
                settings={launchSettings}
                hasOverride={hasOverride}
                isInstalled={isInstalled}
                onChange={onChangeLaunchSettings}
                onReset={onResetLaunchSettings}
                onOpenFolder={onOpenFolder}
                onDelete={
                  onDeleteVersion
                    ? async () => {
                        await onDeleteVersion(selectedVersion);
                        onOpenVersionSelect();
                      }
                    : undefined
                }
                gameRoot={gameRoot}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
