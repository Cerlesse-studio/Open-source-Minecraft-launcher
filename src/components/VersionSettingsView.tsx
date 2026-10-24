import { useState } from "react";
import {
  CalendarDays,
  Check,
  LayoutDashboard,
  Layers3,
  MemoryStick,
  FolderOpen,
  RotateCcw,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { cn } from "cn";
import { formatDate, joinPath, typeLabel, typeTone } from "../lib/format";
import type {
  GameStateName,
  InstallProgress,
  InstalledVersion,
  JavaInstall,
  VersionManifest,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
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
}

type Section = "overview" | "launch";

function LaunchSettingsPanel({
  versionId,
  settings,
  hasOverride,
  isInstalled,
  onChange,
  onReset,
  onOpenFolder,
  gameRoot,
}: {
  versionId: string;
  settings: VersionLaunchSettings;
  hasOverride: boolean;
  isInstalled: boolean;
  onChange: (patch: Partial<VersionLaunchSettings>) => void;
  onReset: () => void;
  onOpenFolder: (path: string) => void;
  gameRoot: string;
}) {
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
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                只影响 {versionId}。未单独设置时使用启动器默认值。
              </p>
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
          <p className="text-[10px] leading-4 text-muted-foreground/70">
            约 {(settings.memoryMb / 1024).toFixed(1)} GB。建议至少 2048 MB，安装大量模组时提高到 4096 MB 以上。
          </p>
        </CardContent>
      </Card>

      <Card className="gap-0 border-border/70 bg-card/55 py-0">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
              <SlidersHorizontal className="size-4" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-[13px] font-medium">游戏窗口</CardTitle>
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                固定启动时的窗口尺寸，未启用时由游戏决定。
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/15 p-3">
            <div className="min-w-0">
              <Label htmlFor="version-resolution" className="text-[12px] font-medium">
                自定义窗口大小
              </Label>
              <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                使用 -width 与 -height 覆盖游戏默认窗口。
              </p>
            </div>
            <Switch
              id="version-resolution"
              checked={settings.resolutionEnabled}
              onCheckedChange={(checked) => onChange({ resolutionEnabled: checked })}
            />
          </div>

          {settings.resolutionEnabled ? (
            <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="version-width" className="text-[11px] font-normal text-muted-foreground">
                  宽度
                </Label>
                <Input
                  id="version-width"
                  type="number"
                  min={320}
                  max={7680}
                  step={10}
                  value={settings.width}
                  className="h-9 bg-background/40 font-mono text-[11px]"
                  onChange={(event) =>
                    onChange({ width: Number(event.target.value) || 1280 })
                  }
                />
              </div>
              <span className="pb-2.5 text-[11px] text-muted-foreground">×</span>
              <div className="space-y-1.5">
                <Label htmlFor="version-height" className="text-[11px] font-normal text-muted-foreground">
                  高度
                </Label>
                <Input
                  id="version-height"
                  type="number"
                  min={240}
                  max={4320}
                  step={10}
                  value={settings.height}
                  className="h-9 bg-background/40 font-mono text-[11px]"
                  onChange={(event) =>
                    onChange({ height: Number(event.target.value) || 720 })
                  }
                />
              </div>
            </div>
          ) : null}
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
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                这个版本的客户端与配置都保存在这里。
              </p>
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
        description="查看当前版本的运行状态，并单独调整它的启动参数。"
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
                gameRoot={gameRoot}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
