import { useState, useCallback, useMemo, useEffect } from "react";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Coffee,
  FolderOpen,
  HardDrive,
  LayoutDashboard,
  Layers3,
  LoaderCircle,
  Map as MapIcon,
  MemoryStick,
  Package,
  Paintbrush,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Tag,
  Trash2,
  Wrench,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "cn";
import { formatBytes, formatDate, joinPath, shortPath, typeLabel, typeTone } from "../lib/format";
import type {
  InstalledVersion,
  JavaInstall,
  JavaModItem,
  GameEdition,
  LauncherVisibility,
  ProcessPriority,
  VersionIsolation,
  VersionManifest,
  WindowSizeMode,
  VersionSummary,
} from "../lib/types";
import {
  deleteJavaMod,
  getJavaMods,
  installJavaModFile,
  toggleJavaMod,
} from "../lib/backend";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { GrassBlock, PageHeader, TypeBadge } from "./ui";
import { BedrockPackManager } from "./BedrockPackManager";
import { JavaPackManager } from "./JavaPackManager";
import { JavaShortcuts } from "./JavaShortcuts";
import { WorldManager } from "./WorldManager";

interface VersionSettingsViewProps {
  manifest: VersionManifest | null;
  installed: InstalledVersion[];
  selectedVersion: string;
  /** The edition switch lives in App, so Bedrock detection needs it here. */
  edition?: GameEdition;
  gameRoot: string;
  javaInstalls: JavaInstall[];
  javaPath: string;
  launchSettings: VersionLaunchSettings;
  hasOverride: boolean;
  onChangeLaunchSettings: (patch: Partial<VersionLaunchSettings>) => void;
  onResetLaunchSettings: () => void;
  onLaunch: () => void;
  onOpenVersionSelect: () => void;
  onOpenFolder: (path: string) => void;
  onDeleteVersion?: (versionId: string) => Promise<void> | void;
  onNotify?: (level: "info" | "success" | "error", title: string, detail?: string) => void;
  [key: string]: any;
}

type Section = "overview" | "launch" | "mods" | "packs" | "worlds";

/**
 * Locales the launcher can force at start-up. The codes are the ones Minecraft
 * itself writes into `options.txt` (`lang:`), so nothing is translated on the
 * way to disk.
 */
const GAME_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "", label: "不修改（跟随游戏内设置）" },
  { value: "zh_cn", label: "简体中文 · zh_cn" },
  { value: "zh_tw", label: "繁體中文 · zh_tw" },
  { value: "en_us", label: "English (US) · en_us" },
  { value: "en_gb", label: "English (UK) · en_gb" },
  { value: "ja_jp", label: "日本語 · ja_jp" },
  { value: "ko_kr", label: "한국어 · ko_kr" },
  { value: "fr_fr", label: "Français · fr_fr" },
  { value: "de_de", label: "Deutsch · de_de" },
  { value: "es_es", label: "Español · es_es" },
  { value: "pt_br", label: "Português (Brasil) · pt_br" },
  { value: "it_it", label: "Italiano · it_it" },
  { value: "ru_ru", label: "Русский · ru_ru" },
  { value: "uk_ua", label: "Українська · uk_ua" },
  { value: "pl_pl", label: "Polski · pl_pl" },
  { value: "tr_tr", label: "Türkçe · tr_tr" },
  { value: "nl_nl", label: "Nederlands · nl_nl" },
  { value: "th_th", label: "ไทย · th_th" },
  { value: "vi_vn", label: "Tiếng Việt · vi_vn" },
];

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
  javaInstalls,
  defaultJavaPath,
  isBedrock = false,
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
  javaInstalls?: JavaInstall[];
  defaultJavaPath?: string;
  isBedrock?: boolean;
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  return (
    <div className="space-y-4">
      {/* Scope Alert Badge */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <SlidersHorizontal className="size-4" />
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground">
              当前配置版本：<span className="font-mono text-primary font-bold">{versionId}</span> 专属设置
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              此面板内调整的内存、专属 Java、隔离模式及启动参数均仅对本版本生效，独立隔离保存，不会影响其他版本与全局设置。
            </p>
          </div>
        </div>
        {hasOverride ? (
          <Badge className="h-5 text-[9.5px] bg-primary/20 text-primary border-primary/30">
            已启用版本专属配置
          </Badge>
        ) : (
          <Badge variant="outline" className="h-5 text-[9.5px] text-muted-foreground border-border/60">
            继承启动器默认值
          </Badge>
        )}
      </div>

      <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
                <MemoryStick className="size-4" />
              </span>
              <div className="min-w-0">
                <CardTitle className="text-[13px] font-medium">版本专属最大内存</CardTitle>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  为当前版本分配独立的运行内存上限
                </p>
              </div>
            </div>
            <span className="font-mono text-[13px] font-semibold text-primary">
              {settings.memoryMb} MB
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 p-5">
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
            <span>4 GB</span>
            <span>8 GB</span>
            <span>12 GB</span>
            <span>16 GB</span>
          </div>
        </CardContent>
      </Card>

      {/* Per-Version Java Runtime Selection */}
      <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
                <Coffee className="size-4" />
              </span>
              <div className="min-w-0">
                <CardTitle className="text-[13px] font-medium">版本专属 Java 运行环境</CardTitle>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  可针对当前 Minecraft 版本指定专用 Java（如 1.12 需 Java 8，1.20 需 Java 17，1.21+ 需 Java 21）
                </p>
              </div>
            </div>
            {settings.javaPath ? (
              <Badge className="h-4 text-[9px] bg-primary/15 text-primary border-primary/30 font-mono">
                专属指定
              </Badge>
            ) : (
              <Badge variant="outline" className="h-4 text-[9px] text-muted-foreground">
                跟随全局默认
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-5">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-normal text-muted-foreground">
              选择本版本使用的 Java
            </Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-between border-border/70 bg-background/40 px-3 text-left font-normal text-[12px] hover:bg-muted/30 hover:text-foreground"
                >
                  <span className="truncate">
                    {settings.javaPath
                      ? `专属: ${settings.javaPath}`
                      : defaultJavaPath
                        ? `跟随启动器全局默认 (${defaultJavaPath})`
                        : "跟随启动器全局默认 (自动匹配)"}
                  </span>
                  <ChevronDown className="size-3.5 shrink-0 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-[380px] p-1">
                <DropdownMenuItem
                  className={cn(
                    "flex cursor-pointer items-center justify-between rounded-sm px-2.5 py-2 text-[12px]",
                    !settings.javaPath && "bg-primary/10 font-medium text-primary",
                  )}
                  onClick={() => onChange({ javaPath: "" })}
                >
                  <div className="flex flex-col">
                    <span className="font-medium">跟随启动器全局默认</span>
                    <span className="text-[10px] text-muted-foreground truncate">
                      {defaultJavaPath || "未设置全局路径，启动时自动检测系统匹配的 Java"}
                    </span>
                  </div>
                  {!settings.javaPath ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                </DropdownMenuItem>

                {javaInstalls && javaInstalls.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-[10px] text-muted-foreground px-2.5 py-1">
                      已检测到的系统 Java
                    </DropdownMenuLabel>
                    {javaInstalls.map((j) => (
                      <DropdownMenuItem
                        key={j.path}
                        className={cn(
                          "flex cursor-pointer items-center justify-between rounded-sm px-2.5 py-1.5 text-[12px]",
                          settings.javaPath === j.path && "bg-primary/10 font-medium text-primary",
                        )}
                        onClick={() => onChange({ javaPath: j.path })}
                      >
                        <div className="flex flex-col min-w-0 pr-2">
                          <span className="truncate font-medium">
                            Java {j.major} ({j.version || "未知版本"})
                          </span>
                          <span className="text-[10px] text-muted-foreground truncate font-mono">
                            {j.path}
                          </span>
                        </div>
                        {settings.javaPath === j.path ? (
                          <Check className="size-3.5 shrink-0 text-primary" />
                        ) : null}
                      </DropdownMenuItem>
                    ))}
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="version-custom-java-input" className="text-[11px] font-normal text-muted-foreground">
              手动填写 Java 绝对路径 (可选)
            </Label>
            <Input
              id="version-custom-java-input"
              placeholder="留空则跟随上述下拉选项或全局默认"
              value={settings.javaPath || ""}
              spellCheck={false}
              className="h-8 bg-background/40 font-mono text-[11px]"
              onChange={(e) => onChange({ javaPath: e.target.value.trim() })}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
              <SlidersHorizontal className="size-4" />
            </span>
            <div className="min-w-0">
              <CardTitle className="text-[13px] font-medium">启动选项与独立隔离</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                设置本版本专属的游戏隔离目录、窗口尺寸及 JVM 附加参数
              </p>
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
                自定义信息 (F3 界面)
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

            {/* Language applied to options.txt right before the game starts. */}
            {isBedrock ? null : (
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-[11px] font-normal text-muted-foreground">
                  游戏语言（启动后生效）
                </Label>
                <VersionSelect<string>
                  value={settings.language || ""}
                  options={GAME_LANGUAGES}
                  onChange={(val) => onChange({ language: val })}
                />
                <p className="text-[10px] leading-4 text-muted-foreground/80">
                  启动前写入本版本 <span className="font-mono">options.txt</span> 的{" "}
                  <span className="font-mono">lang</span> 项，游戏全程以该语言运行；
                  游戏内再次切换语言会覆盖此设置，下次启动仍按这里生效。
                </p>
              </div>
            )}

            {/* Custom JVM Arguments */}
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="version-jvm-args" className="text-[11px] font-normal text-muted-foreground">
                当前版本专属 JVM 附加参数
              </Label>
              <Input
                id="version-jvm-args"
                placeholder="例如: -XX:+UseG1GC -Dfile.encoding=UTF-8 (留空则不附加)"
                value={settings.jvmArgs || ""}
                spellCheck={false}
                className="h-8 bg-background/40 font-mono text-[11px]"
                onChange={(e) => onChange({ jvmArgs: e.target.value })}
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

const LOADER_TONES: Record<string, string> = {
  Fabric: "border-amber-500/35 bg-amber-500/10 text-amber-300",
  Forge: "border-purple-500/35 bg-purple-500/10 text-purple-300",
  NeoForge: "border-orange-500/35 bg-orange-500/10 text-orange-300",
  Quilt: "border-pink-500/35 bg-pink-500/10 text-pink-300",
};

function loaderTone(loader: string): string {
  return LOADER_TONES[loader] ?? "border-border/60 bg-muted/25 text-muted-foreground";
}

/**
 * Mod icon tile.
 *
 * The backend inlines the icon it found inside the jar; when a mod ships none
 * (or ships one we cannot decode) the tile keeps its size and falls back to the
 * mod's initial, so rows never shift or leave a hole.
 */
function ModIconTile({
  iconUrl,
  name,
  enabled,
  className,
}: {
  iconUrl?: string | null;
  name: string;
  enabled: boolean;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = iconUrl?.trim() ?? "";
  const showImage = url.length > 0 && failedUrl !== url;
  const initial = (name.trim()[0] ?? "M").toUpperCase();

  return (
    <div
      className={cn(
        "relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted/20 transition-colors",
        enabled ? "border-border/70" : "border-border/40 bg-muted/10",
        className,
      )}
    >
      {showImage ? (
        <img
          src={url}
          alt={name}
          loading="lazy"
          decoding="async"
          className={cn(
            "size-full object-cover [image-rendering:pixelated]",
            !enabled && "opacity-60 saturate-50",
          )}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span className="select-none text-[17px] font-semibold text-muted-foreground/60">
          {initial}
        </span>
      )}
    </div>
  );
}

function JavaModManagerPanel({
  versionId,
  gameRoot,
  installedVersion,
  onOpenFolder,
  onNotify,
}: {
  versionId: string;
  gameRoot: string;
  installedVersion?: InstalledVersion;
  onOpenFolder: (path: string) => void;
  onNotify?: (level: "info" | "success" | "error", title: string, detail?: string) => void;
}) {
  const [mods, setMods] = useState<JavaModItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [togglingFile, setTogglingFile] = useState<string | null>(null);
  const [deletingMod, setDeletingMod] = useState<JavaModItem | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [importing, setImporting] = useState(false);

  const loadMods = useCallback(async () => {
    setLoading(true);
    try {
      const list = await getJavaMods(versionId, gameRoot);
      setMods(list);
    } catch (e) {
      console.error("加载模组失败", e);
    } finally {
      setLoading(false);
    }
  }, [versionId, gameRoot]);

  useEffect(() => {
    void loadMods();
  }, [loadMods]);

  const handleToggle = async (mod: JavaModItem) => {
    setTogglingFile(mod.fileName);
    try {
      await toggleJavaMod(versionId, mod.fileName, !mod.enabled, gameRoot);
      await loadMods();
      onNotify?.(
        "info",
        mod.enabled ? "模组已停用" : "模组已启用",
        `${mod.name} (${mod.fileName})`,
      );
    } catch (e) {
      onNotify?.("error", "切换模组状态失败", String(e));
    } finally {
      setTogglingFile(null);
    }
  };

  const handleDelete = async () => {
    if (!deletingMod) return;
    setIsDeleting(true);
    try {
      await deleteJavaMod(versionId, deletingMod.fileName, gameRoot);
      onNotify?.("success", "模组已成功删除", deletingMod.fileName);
      setDeletingMod(null);
      await loadMods();
    } catch (e) {
      onNotify?.("error", "删除模组失败", String(e));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleImportDialog = async () => {
    setImporting(true);
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Java 模组 (.jar)", extensions: ["jar", "zip"] }],
      });
      if (selected && typeof selected === "string") {
        const msg = await installJavaModFile(versionId, selected, gameRoot);
        onNotify?.("success", "模组导入成功", msg);
        await loadMods();
      }
    } catch (e) {
      onNotify?.("error", "导入模组失败", String(e));
    } finally {
      setImporting(false);
    }
  };

  const handleBatchToggleAll = async (enable: boolean) => {
    const targets = mods.filter((m) => m.enabled !== enable);
    if (targets.length === 0) return;
    setLoading(true);
    try {
      for (const m of targets) {
        await toggleJavaMod(versionId, m.fileName, enable, gameRoot);
      }
      onNotify?.(
        "success",
        enable ? "已全部启用模组" : "已全部停用模组",
        `共处理 ${targets.length} 个模组`,
      );
      await loadMods();
    } catch (e) {
      onNotify?.("error", "批量操作失败", String(e));
    } finally {
      setLoading(false);
    }
  };

  const enabledCount = useMemo(() => mods.filter((m) => m.enabled).length, [mods]);
  const disabledCount = mods.length - enabledCount;
  const totalSize = useMemo(() => mods.reduce((sum, m) => sum + m.size, 0), [mods]);

  const filteredMods = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return mods.filter((m) => {
      if (statusFilter === "enabled" && !m.enabled) return false;
      if (statusFilter === "disabled" && m.enabled) return false;
      if (needle) {
        return (
          m.name.toLowerCase().includes(needle) ||
          m.fileName.toLowerCase().includes(needle) ||
          (m.id && m.id.toLowerCase().includes(needle)) ||
          (m.description && m.description.toLowerCase().includes(needle))
        );
      }
      return true;
    });
  }, [mods, query, statusFilter]);

  const loaderDisplay =
    installedVersion?.loader ||
    (versionId.toLowerCase().includes("fabric")
      ? "Fabric"
      : versionId.toLowerCase().includes("neoforge")
        ? "NeoForge"
        : versionId.toLowerCase().includes("forge")
          ? "Forge"
          : versionId.toLowerCase().includes("quilt")
            ? "Quilt"
            : versionId.toLowerCase().includes("optifine")
              ? "OptiFine"
              : "Modded");

  return (
    <div className="space-y-4">
      {/* Top Banner & Action Bar */}
      <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
        <CardHeader className="border-b border-border/60 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
                <Layers3 className="size-4.5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <CardTitle className="text-[14px]">模组管理 (Mod 管理器)</CardTitle>
                  <Badge
                    variant="outline"
                    className="h-4 border-primary/30 bg-primary/10 px-1.5 text-[9px] font-mono text-primary"
                  >
                    {loaderDisplay}
                    {installedVersion?.loaderVersion ? ` v${installedVersion.loaderVersion}` : ""}
                  </Badge>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
                  {mods.length > 0 ? (
                    <>
                      <span>共 {mods.length} 个模组</span>
                      <span className="text-border">/</span>
                      <span className="text-success/90">启用 {enabledCount}</span>
                      {disabledCount > 0 ? (
                        <>
                          <span className="text-border">/</span>
                          <span className="text-amber-400/90">停用 {disabledCount}</span>
                        </>
                      ) : null}
                      <span className="text-border">/</span>
                      <span className="font-mono">{formatBytes(totalSize)}</span>
                    </>
                  ) : (
                    <span>已加载当前 Java 版本的 mods 目录，支持动态启用、停用、删除与快速导入。</span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="default"
                size="sm"
                className="h-8 gap-1.5 text-xs shadow-2xs"
                onClick={() => void handleImportDialog()}
                disabled={importing}
              >
                {importing ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
                导入模组 (.jar)
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs border-border/70 hover:bg-muted/30"
                onClick={() =>
                  onOpenFolder(joinPath(gameRoot, "versions", versionId, "mods"))
                }
              >
                <FolderOpen className="size-3.5" />
                打开模组目录
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-8"
                onClick={() => void loadMods()}
                disabled={loading}
                title="刷新模组列表"
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              </Button>
            </div>
          </div>
        </CardHeader>

        {/* Filter and Search Bar */}
        <CardContent className="px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative min-w-[200px] max-w-sm flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                placeholder="搜索模组名称、文件名或描述…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 w-full rounded-md border border-border/60 bg-background/50 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary/50 focus:outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setStatusFilter("all")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                  statusFilter === "all"
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                )}
              >
                全部 ({mods.length})
              </button>
              <button
                type="button"
                onClick={() => setStatusFilter("enabled")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                  statusFilter === "enabled"
                    ? "bg-success/15 font-medium text-success"
                    : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                )}
              >
                已启用 ({enabledCount})
              </button>
              <button
                type="button"
                onClick={() => setStatusFilter("disabled")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                  statusFilter === "disabled"
                    ? "bg-amber-500/15 font-medium text-amber-400"
                    : "text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                )}
              >
                已停用 ({disabledCount})
              </button>

              <Separator orientation="vertical" className="mx-1 h-4" />

              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[10.5px] text-muted-foreground hover:text-foreground"
                onClick={() => void handleBatchToggleAll(true)}
                disabled={loading || enabledCount === mods.length}
              >
                全部启用
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-[10.5px] text-muted-foreground hover:text-foreground"
                onClick={() => void handleBatchToggleAll(false)}
                disabled={loading || disabledCount === mods.length}
              >
                全部停用
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Mods List Area */}
      {loading && mods.length === 0 ? (
        <Card className="flex h-48 items-center justify-center border-border/70 bg-card/45">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin text-primary" />
            <span className="text-xs">正在扫描模组目录…</span>
          </div>
        </Card>
      ) : filteredMods.length === 0 ? (
        <Card className="grid min-h-[240px] place-items-center border-border/70 bg-card/45 p-8 text-center">
          <div className="max-w-md">
            <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-border/70 bg-muted/20">
              <Package className="size-5 text-muted-foreground/60" />
            </div>
            <h3 className="mt-3 text-[13px] font-medium text-foreground">
              {query
                ? `没有找到包含“${query}”的模组`
                : statusFilter !== "all"
                  ? "没有符合筛选状态的模组"
                  : "当前版本尚未安装任何模组"}
            </h3>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              {query
                ? "请尝试更换关键词搜索，或清除筛选条件。"
                : "将下载好的 .jar 模组放入 versions 隔离目录或根 mods 目录，即可在此动态管理开关。"}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {query ? (
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  清除搜索
                </Button>
              ) : (
                <>
                  <Button
                    variant="default"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={() => void handleImportDialog()}
                  >
                    <Plus className="size-3.5" />
                    导入模组文件
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={() =>
                      onOpenFolder(joinPath(gameRoot, "versions", versionId, "mods"))
                    }
                  >
                    <FolderOpen className="size-3.5" />
                    打开模组文件夹
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <div className="space-y-2.5">
          {filteredMods.map((mod) => {
            const isToggling = togglingFile === mod.fileName;
            return (
              <Card
                key={mod.fileName}
                className={cn(
                  "group flex flex-row items-center gap-3.5 rounded-xl border-border/70 bg-card/55 p-3.5 transition-all hover:border-primary/45 hover:bg-card/85",
                  !mod.enabled && "border-border/45 bg-muted/[0.06] hover:border-border/60",
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-3.5">
                  <ModIconTile
                    iconUrl={mod.iconDataUrl}
                    name={mod.name}
                    enabled={mod.enabled}
                    className="size-14 rounded-xl"
                  />

                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        className={cn(
                          "max-w-full truncate text-[14.5px] font-semibold tracking-tight",
                          mod.enabled ? "text-foreground" : "text-muted-foreground",
                        )}
                        title={mod.name}
                      >
                        {mod.name}
                      </h3>
                      {mod.version ? (
                        <span className="shrink-0 rounded border border-border/50 bg-muted/25 px-1 font-mono text-[9.5px] leading-4 text-muted-foreground">
                          v{mod.version}
                        </span>
                      ) : null}
                      {mod.modLoader ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-4 shrink-0 border px-1.5 font-mono text-[9px] font-normal",
                            loaderTone(mod.modLoader),
                          )}
                        >
                          {mod.modLoader}
                        </Badge>
                      ) : null}
                      {mod.enabled ? (
                        <Badge className="h-4 border-0 bg-success/15 px-1.5 text-[9px] font-normal text-success">
                          已启用
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="h-4 border-border/60 bg-muted/20 px-1.5 text-[9px] font-normal text-muted-foreground"
                        >
                          已停用
                        </Badge>
                      )}
                      {mod.id ? (
                        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                          <Tag className="size-3 shrink-0" />
                          <span className="truncate font-mono text-[10px]" title={mod.id}>
                            {mod.id}
                          </span>
                        </span>
                      ) : null}
                    </div>

                    <p className="truncate text-[12px] leading-5 text-muted-foreground">
                      {mod.description || "此模组未提供简介"}
                    </p>

                    <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-muted-foreground/80">
                      <span className="flex items-center gap-1 font-mono">
                        <HardDrive className="size-3 text-primary/80" />
                        {formatBytes(mod.size)}
                      </span>
                      <span className="text-muted-foreground/40">·</span>
                      <span className="flex items-center gap-1">
                        <CalendarDays className="size-3 text-primary/70" />
                        {mod.modifiedTime}
                      </span>
                      <span className="text-muted-foreground/40">·</span>
                      <span
                        className="max-w-[280px] truncate font-mono text-muted-foreground/60"
                        title={mod.fileName}
                      >
                        {mod.fileName}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-1.5 whitespace-nowrap rounded-lg border-border/80 px-3.5 text-[11.5px] text-muted-foreground transition-colors group-hover:border-primary/45 group-hover:bg-primary/10 group-hover:text-primary"
                    disabled={isToggling}
                    onClick={() => void handleToggle(mod)}
                  >
                    {isToggling ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <Power className="size-3" />
                    )}
                    {mod.enabled ? "停用" : "启用"}
                    <ChevronRight className="size-3 transition-transform group-hover:translate-x-0.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 text-muted-foreground/60 hover:bg-destructive/15 hover:text-destructive"
                    onClick={() => setDeletingMod(mod)}
                    title="删除模组"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Delete Mod Confirmation Modal */}
      {deletingMod ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in-0 duration-150">
          <div className="w-full max-w-sm rounded-xl border border-border/80 bg-background/95 p-5 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/15 text-destructive">
                <Trash2 className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-foreground">确认删除模组？</h3>
                <p className="mt-0.5 text-xs text-muted-foreground truncate font-mono">
                  {deletingMod.fileName}
                </p>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              此操作将永久移除模组文件【
              <span className="font-mono text-foreground">{deletingMod.name}</span>
              】，不会影响其他版本。
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeletingMod(null)}
                disabled={isDeleting}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => void handleDelete()}
                disabled={isDeleting}
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

function VersionOverviewPanel({
  versionId,
  installedVersion,
  summary,
  gameRoot,
  launchSettings,
  hasOverride,
  isModded,
  isBedrock,
  onGoToLaunch,
  onGoToMods,
  onOpenFolder,
  onLaunch,
}: {
  versionId: string;
  installedVersion?: InstalledVersion;
  summary?: VersionSummary;
  gameRoot: string;
  launchSettings: VersionLaunchSettings;
  hasOverride: boolean;
  isModded: boolean;
  isBedrock: boolean;
  onGoToLaunch: () => void;
  onGoToMods: () => void;
  onOpenFolder: (path: string) => void;
  onLaunch: () => void;
}) {
  const versionType = installedVersion?.type ?? summary?.type ?? "release";
  const mcVer = installedVersion?.mcVersion || versionId.split("-")[0];

  return (
    <div className="space-y-4">
      {/* Scope Alert Badge */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <LayoutDashboard className="size-4" />
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground">
              当前配置版本：<span className="font-mono text-primary font-bold">{versionId}</span> 专属档案
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {isBedrock
                ? "此版本使用基岩版附加包（资源包 / 行为包），不加载 Java 模组。"
                : "此版本已建立独立启动与模组配置，此处所有修改仅对本版本生效。"}
            </p>
          </div>
        </div>
        {hasOverride ? (
          <Badge className="h-5 text-[9.5px] bg-primary/20 text-primary border-primary/30">
            已启用专属独立配置
          </Badge>
        ) : (
          <Badge variant="outline" className="h-5 text-[9.5px] text-muted-foreground border-border/60">
            继承全局统一默认
          </Badge>
        )}
      </div>

      {/* Version Header Card */}
      <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl border border-border/80 bg-background/60 p-3 shadow-2xs shrink-0">
                <GrassBlock size={52} />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-pixel text-[17px] text-foreground font-semibold">
                    {versionId}
                  </h2>
                  <TypeBadge
                    type={versionType}
                    tone={typeTone(versionType)}
                    label={typeLabel(versionType)}
                  />
                  {isModded ? (
                    <Badge className="h-4 border-0 bg-primary/20 text-primary text-[9px]">
                      {installedVersion?.loader || "Modded"}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[11px] text-muted-foreground font-mono">
                  <span>Minecraft 核心: {mcVer}</span>
                  <span>•</span>
                  <span>
                    状态: {installedVersion ? "已安装至本地" : "云端可用"}
                  </span>
                  <span>•</span>
                  <span className="truncate max-w-[280px]">
                    目录: versions/{versionId}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="h-8 gap-1.5 text-xs shadow-2xs" onClick={onLaunch}>
                <Play className="size-3.5 fill-current" />
                以专属配置启动
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs border-border/70 hover:bg-muted/30"
                onClick={() => onOpenFolder(joinPath(gameRoot, "versions", versionId))}
              >
                <FolderOpen className="size-3.5" />
                打开目录
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Grid of Active Per-Version Configurations */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-2xs">
          <CardHeader className="px-4 py-3 border-b border-border/50">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground flex items-center gap-2">
                <MemoryStick className="size-3.5 text-primary" />
                最大内存分配
              </span>
              <Badge variant="outline" className="text-[9px] border-primary/30 text-primary">
                {hasOverride ? "独立指定" : "继承全局"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="font-mono text-base font-semibold text-foreground">
              {launchSettings.memoryMb} MB
            </div>
            <p className="mt-1 text-[10.5px] text-muted-foreground">
              专为当前版本配置的最大 JVM 堆内存空间。
            </p>
          </CardContent>
        </Card>

        <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-2xs">
          <CardHeader className="px-4 py-3 border-b border-border/50">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground flex items-center gap-2">
                <Coffee className="size-3.5 text-primary" />
                Java 运行环境
              </span>
              <Badge variant="outline" className="text-[9px] border-primary/30 text-primary">
                {launchSettings.javaPath ? "专属环境" : "全局默认"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="font-mono text-xs font-semibold text-foreground truncate" title={launchSettings.javaPath || "跟随启动器全局匹配"}>
              {launchSettings.javaPath ? shortPath(launchSettings.javaPath) : "跟随全局默认自动匹配"}
            </div>
            <p className="mt-1 text-[10.5px] text-muted-foreground">
              {launchSettings.javaPath ? "已锁定该版本专用的 Java 环境" : "未指定时由启动器自动匹配合适版本"}
            </p>
          </CardContent>
        </Card>

        <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-2xs">
          <CardHeader className="px-4 py-3 border-b border-border/50">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground flex items-center gap-2">
                <SlidersHorizontal className="size-3.5 text-primary" />
                版本数据隔离
              </span>
            </div>
          </CardHeader>
          <CardContent className="p-4">
            <div className="text-xs font-semibold text-foreground">
              {launchSettings.versionIsolation === "all"
                ? "完全独立目录隔离"
                : launchSettings.versionIsolation === "modded"
                  ? "仅模组包独立隔离"
                  : "共用游戏根目录"}
            </div>
            <p className="mt-1 text-[10.5px] text-muted-foreground">
              {launchSettings.versionIsolation === "all"
                ? "saves、mods、config 均独立于当前版本目录下"
                : "与主游戏目录共享部分存档或配置"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Action Navigation Card */}
      <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-2xs">
        <CardContent className="p-5 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h4 className="text-xs font-semibold text-foreground">需要调整本版本的专属参数？</h4>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              可随时进入专属启动设置或模组管理面板对本版本进行单独定制。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={onGoToLaunch}>
              <Wrench className="size-3.5" />
              调整专属启动设置
            </Button>
            {isModded || isBedrock ? (
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs text-primary border-primary/30" onClick={onGoToMods}>
                <Package className="size-3.5" />
                {isBedrock ? "管理本版本附加包" : "管理本版本模组"}
              </Button>
            ) : null}
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
  edition,
  gameRoot,
  javaInstalls,
  javaPath,
  launchSettings,
  hasOverride,
  onChangeLaunchSettings,
  onResetLaunchSettings,
  onLaunch,
  onOpenVersionSelect,
  onOpenFolder,
  onDeleteVersion,
  onNotify,
}: VersionSettingsViewProps) {
  const [section, setSection] = useState<Section>("overview");
  const installedVersion = installed.find((version) => version.id === selectedVersion);
  const summary = manifest?.versions.find((version) => version.id === selectedVersion);
  const isInstalled = Boolean(installedVersion);
  const isLatest = Boolean(manifest && manifest.latest.release === selectedVersion);
  const versionType = installedVersion?.type ?? summary?.type ?? "release";

  // Bedrock packs live in `com.mojang`, so the Java `versions/<id>/mods` panel
  // would show an empty folder for these ids and manage the wrong thing.
  const isBedrockVersion =
    edition === "bedrock" ||
    selectedVersion === "uwp" ||
    selectedVersion === "bedrock-uwp" ||
    selectedVersion.startsWith("bedrock:") ||
    selectedVersion.startsWith("bedrock-") ||
    selectedVersion.includes("基岩版");

  const isModded = Boolean(
    installedVersion?.loader ||
    installedVersion?.optifineVersion ||
    installedVersion?.fabricApiVersion ||
    selectedVersion.toLowerCase().includes("fabric") ||
    selectedVersion.toLowerCase().includes("forge") ||
    selectedVersion.toLowerCase().includes("quilt") ||
    selectedVersion.toLowerCase().includes("neoforge") ||
    selectedVersion.toLowerCase().includes("optifine")
  );

  // Resource packs, saves and screenshots all live in the game directory the
  // version is launched with, which the isolation mode decides.
  const javaGameDir = useMemo(() => {
    const isolation = launchSettings.versionIsolation ?? "all";
    if (isolation === "none") return gameRoot;
    if (isolation === "modded" && !isModded) return gameRoot;
    return joinPath(gameRoot, "versions", selectedVersion);
  }, [gameRoot, launchSettings.versionIsolation, selectedVersion, isModded]);

  const [lastAutoLoadedVersion, setLastAutoLoadedVersion] = useState<string | null>(null);

  // Open the manager that matches the platform: mods for a modded Java
  // version, packs for a Bedrock version.
  useEffect(() => {
    if ((isModded || isBedrockVersion) && lastAutoLoadedVersion !== selectedVersion) {
      setSection("mods");
      setLastAutoLoadedVersion(selectedVersion);
    }
  }, [selectedVersion, isModded, isBedrockVersion, lastAutoLoadedVersion]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="版本专属设置"
        description={`当前正在单独配置已选定版本：${selectedVersion}（设置将独立保存于本版本，不影响全局与其他版本）`}
        actions={
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1.5 text-[10.5px] text-muted-foreground sm:flex">
              <Check className="size-3.5 text-primary" />
              独立隔离保存
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2"
              onClick={onOpenVersionSelect}
            >
              <Layers3 className="size-3.5" />
              更换版本
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
              <button
                type="button"
                onClick={() => setSection("mods")}
                aria-current={section === "mods" ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center justify-between rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground",
                  section === "mods" && "bg-accent/70 text-foreground",
                )}
              >
                {section === "mods" ? (
                  <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                ) : null}
                <div className="flex items-center gap-2.5">
                  <Package
                    className={cn(
                      "size-3.5",
                      section === "mods" ? "text-primary" : "text-muted-foreground/75",
                    )}
                  />
                  <span>{isBedrockVersion ? "附加包管理" : "模组管理"}</span>
                </div>
                {isBedrockVersion ? (
                  <Badge className="h-3.5 rounded px-1 text-[8.5px] font-mono border-0 bg-primary/20 text-primary">
                    Pack
                  </Badge>
                ) : isModded ? (
                  <Badge className="h-3.5 rounded px-1 text-[8.5px] font-mono border-0 bg-primary/20 text-primary">
                    Mod
                  </Badge>
                ) : null}
              </button>
              <button
                type="button"
                onClick={() => setSection("packs")}
                aria-current={section === "packs" ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground",
                  section === "packs" && "bg-accent/70 text-foreground",
                )}
              >
                {section === "packs" ? (
                  <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                ) : null}
                <Paintbrush
                  className={cn(
                    "size-3.5",
                    section === "packs" ? "text-primary" : "text-muted-foreground/75",
                  )}
                />
                资源包管理
              </button>
              <button
                type="button"
                onClick={() => setSection("worlds")}
                aria-current={section === "worlds" ? "page" : undefined}
                className={cn(
                  "relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground",
                  section === "worlds" && "bg-accent/70 text-foreground",
                )}
              >
                {section === "worlds" ? (
                  <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
                ) : null}
                <MapIcon
                  className={cn(
                    "size-3.5",
                    section === "worlds" ? "text-primary" : "text-muted-foreground/75",
                  )}
                />
                地图管理
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
              <div className="space-y-4">
                <VersionOverviewPanel
                  versionId={selectedVersion}
                  installedVersion={installedVersion}
                  summary={summary}
                  gameRoot={gameRoot}
                  launchSettings={launchSettings}
                  hasOverride={hasOverride}
                  isModded={isModded}
                  isBedrock={isBedrockVersion}
                  onGoToLaunch={() => setSection("launch")}
                  onGoToMods={() => setSection("mods")}
                  onOpenFolder={onOpenFolder}
                  onLaunch={onLaunch}
                />
                {isBedrockVersion ? null : (
                  <JavaShortcuts
                    versionId={selectedVersion}
                    gameRoot={gameRoot}
                    gameDir={javaGameDir}
                    onOpenFolder={onOpenFolder}
                  />
                )}
              </div>
            ) : section === "launch" ? (
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
                javaInstalls={javaInstalls}
                defaultJavaPath={javaPath}
                isBedrock={isBedrockVersion}
              />
            ) : section === "packs" ? (
              isBedrockVersion ? (
                <BedrockPackManager
                  gameRoot={gameRoot}
                  fixedType="resource"
                  onOpenFolder={onOpenFolder}
                  onNotify={onNotify}
                />
              ) : (
                <JavaPackManager
                  versionId={selectedVersion}
                  gameRoot={gameRoot}
                  gameDir={javaGameDir}
                  isolation={launchSettings.versionIsolation}
                  onOpenFolder={onOpenFolder}
                  onNotify={onNotify}
                />
              )
            ) : section === "worlds" ? (
              <WorldManager
                edition={isBedrockVersion ? "bedrock" : "java"}
                versionId={selectedVersion}
                gameRoot={gameRoot}
                gameDir={javaGameDir}
                isolation={launchSettings.versionIsolation}
                onOpenFolder={onOpenFolder}
                onNotify={onNotify}
              />
            ) : isBedrockVersion ? (
              <BedrockPackManager
                gameRoot={gameRoot}
                onOpenFolder={onOpenFolder}
                onNotify={onNotify}
              />
            ) : (
              <JavaModManagerPanel
                versionId={selectedVersion}
                gameRoot={gameRoot}
                installedVersion={installedVersion}
                onOpenFolder={onOpenFolder}
                onNotify={onNotify}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
