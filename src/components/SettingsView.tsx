import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Check,
  Coffee,
  Cpu,
  FolderOpen,
  Gauge,
  Globe,
  Info,
  RefreshCw,
  UserRound,
} from "lucide-react";
import { cn } from "cn";
import { isDesktop } from "../lib/backend";
import { joinPath, shortPath } from "../lib/format";
import type { JavaInstall, LauncherSettings, SystemInfo } from "../lib/types";
import { Avatar, PageHeader } from "./ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface SettingsViewProps {
  settings: LauncherSettings;
  onChange: (patch: Partial<LauncherSettings>) => void;
  systemInfo: SystemInfo | null;
  javaInstalls: JavaInstall[];
  javaDetecting: boolean;
  onRefreshJava: () => Promise<void>;
  onOpenFolder: (path: string) => void;
  onNotify: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
}

type SettingsTab = "account" | "launch" | "download" | "about";

function SettingsSection({
  title,
  icon,
  children,
  actions,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
      <CardHeader className="border-b border-border/60 px-5 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-primary">
              {icon}
            </span>
            <CardTitle className="text-[13px] font-medium">{title}</CardTitle>
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-5">{children}</CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
  htmlFor,
  error,
}: {
  label: string;
  children: ReactNode;
  htmlFor?: string;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label
        htmlFor={htmlFor}
        className="text-[11px] font-normal text-muted-foreground"
      >
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-[10px] leading-4 text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

export function SettingsView({
  settings,
  onChange,
  systemInfo,
  javaInstalls,
  javaDetecting,
  onRefreshJava,
  onOpenFolder,
  onNotify,
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const [scanning, setScanning] = useState(false);
  const [rootDraft, setRootDraft] = useState(settings.gameRoot);
  const cleanName = /^[A-Za-z0-9_]{1,16}$/.test(settings.playerName);

  useEffect(() => {
    setRootDraft(settings.gameRoot);
  }, [settings.gameRoot]);

  const commitRoot = () => {
    const value = rootDraft.trim();
    if (value && value !== settings.gameRoot) {
      onChange({ gameRoot: value });
    } else {
      setRootDraft(settings.gameRoot);
    }
  };

  const refreshJava = async () => {
    setScanning(true);
    try {
      await onRefreshJava();
    } finally {
      setScanning(false);
    }
  };

  const browseGameRoot = async () => {
    if (!isDesktop) {
      onNotify("info", "浏览器预览模式", "目录选择在桌面应用中可用。");
      return;
    }
    try {
      let picked: string | string[] | null = null;
      try {
        picked = await open({
          directory: true,
          multiple: false,
          defaultPath: settings.gameRoot || undefined,
          title: "选择游戏目录",
        });
      } catch {
        picked = await open({
          directory: true,
          multiple: false,
          title: "选择游戏目录",
        });
      }
      if (typeof picked === "string") {
        onChange({ gameRoot: picked });
      }
    } catch (error) {
      onNotify("error", "无法选择目录", String(error));
    }
  };

  const browseJava = async () => {
    if (!isDesktop) {
      onNotify("info", "浏览器预览模式", "文件选择在桌面应用中可用。");
      return;
    }
    try {
      const picked = await open({
        directory: false,
        multiple: false,
        defaultPath: settings.javaPath || undefined,
        title: "选择 java 可执行文件",
      });
      if (typeof picked === "string") {
        onChange({ javaPath: picked });
      }
    } catch (error) {
      onNotify("error", "无法选择 Java", String(error));
    }
  };

  const manualJava =
    settings.javaPath && !javaInstalls.some((java) => java.path === settings.javaPath);
  const selectedJava = settings.javaPath || "auto";

  return (
    <div className="space-y-5">
      <PageHeader
        title="设置"
        actions={
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Check className="size-3.5 text-primary" />
            已自动保存
          </span>
        }
      />

      <Tabs
        value={activeTab}
        onValueChange={(val) => setActiveTab(val as SettingsTab)}
        className="space-y-4"
      >
        <div className="overflow-x-auto pb-1">
          <TabsList className="h-10 w-full justify-start gap-1 rounded-lg border border-border/70 bg-card/60 p-1">
            <TabsTrigger
              value="account"
              className="gap-2 px-3.5 py-1.5 text-[12px] data-[state=active]:bg-background/80"
            >
              <UserRound className="size-3.5 text-primary" />
              账户设置
            </TabsTrigger>
            <TabsTrigger
              value="launch"
              className="gap-2 px-3.5 py-1.5 text-[12px] data-[state=active]:bg-background/80"
            >
              <Gauge className="size-3.5 text-primary" />
              游戏与启动
            </TabsTrigger>
            <TabsTrigger
              value="download"
              className="gap-2 px-3.5 py-1.5 text-[12px] data-[state=active]:bg-background/80"
            >
              <Cpu className="size-3.5 text-primary" />
              下载与网络
            </TabsTrigger>
            <TabsTrigger
              value="about"
              className="gap-2 px-3.5 py-1.5 text-[12px] data-[state=active]:bg-background/80"
            >
              <Info className="size-3.5 text-primary" />
              关于启动器
            </TabsTrigger>
          </TabsList>
        </div>

        {/* 账户设置 Tab */}
        <TabsContent value="account" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="max-w-xl">
            <SettingsSection
              title="账户信息"
              icon={<UserRound className="size-4" />}
            >
              <Field
                label="游戏昵称"
                htmlFor="player-name"
                error={
                  cleanName
                    ? undefined
                    : "昵称格式错误：请使用 1–16 位英文字母、数字或下划线"
                }
              >
                <div className="relative">
                  <Input
                    id="player-name"
                    value={settings.playerName}
                    maxLength={16}
                    spellCheck={false}
                    aria-invalid={!cleanName}
                    className={cn(
                      "h-9 bg-background/40 pr-9 text-[12px]",
                      !cleanName && "border-destructive/60 focus-visible:ring-destructive/20",
                    )}
                    onChange={(event) => onChange({ playerName: event.target.value })}
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2">
                    {cleanName ? (
                      <Check className="size-3.5 text-primary" />
                    ) : (
                      <AlertCircle className="size-3.5 text-destructive" />
                    )}
                  </span>
                </div>
              </Field>

              <div className="flex items-center gap-3.5 rounded-lg border border-border/60 bg-muted/20 p-3.5">
                <div className="overflow-hidden rounded-md border border-border/60 bg-background">
                  <Avatar name={settings.playerName} size={40} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[13px] font-medium">
                      {settings.playerName || "未命名"}
                    </p>
                    <Badge
                      variant="outline"
                      className="h-4 border-border/80 px-1.5 text-[9px] font-normal text-muted-foreground"
                    >
                      离线账户
                    </Badge>
                  </div>
                </div>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>

        {/* 游戏与启动 Tab */}
        <TabsContent value="launch" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsSection
              title="游戏文件根目录"
              icon={<FolderOpen className="size-4" />}
            >
              <Field label="游戏主目录路径" htmlFor="game-root">
                <div className="flex gap-1.5">
                  <Input
                    id="game-root"
                    value={rootDraft}
                    spellCheck={false}
                    className="h-9 min-w-0 flex-1 bg-background/40 font-mono text-[11px]"
                    onChange={(event) => setRootDraft(event.target.value)}
                    onBlur={commitRoot}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 px-3 text-[11px]"
                    onClick={browseGameRoot}
                  >
                    选择
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="size-9 shrink-0"
                    onClick={() => onOpenFolder(settings.gameRoot)}
                    title="打开目录"
                    aria-label="打开目录"
                  >
                    <FolderOpen className="size-3.5" />
                  </Button>
                </div>
              </Field>

              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-foreground">版本目录 (versions)</p>
                    <p className="truncate font-mono text-[9px] text-muted-foreground">
                      {joinPath(settings.gameRoot, "versions")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 shrink-0 gap-1 text-[10px]"
                    onClick={() => onOpenFolder(joinPath(settings.gameRoot, "versions"))}
                  >
                    <FolderOpen className="size-3 text-primary" />
                    打开
                  </Button>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-foreground">资源对象 (assets)</p>
                    <p className="truncate font-mono text-[9px] text-muted-foreground">
                      {joinPath(settings.gameRoot, "assets")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 shrink-0 gap-1 text-[10px]"
                    onClick={() => onOpenFolder(joinPath(settings.gameRoot, "assets"))}
                  >
                    <FolderOpen className="size-3 text-primary" />
                    打开
                  </Button>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-foreground">依赖库 (libraries)</p>
                    <p className="truncate font-mono text-[9px] text-muted-foreground">
                      {joinPath(settings.gameRoot, "libraries")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-6 shrink-0 gap-1 text-[10px]"
                    onClick={() => onOpenFolder(joinPath(settings.gameRoot, "libraries"))}
                  >
                    <FolderOpen className="size-3 text-primary" />
                    打开
                  </Button>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title="Java 运行时"
              icon={<Coffee className="size-4" />}
              actions={
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-7 gap-1 px-2 text-[10.5px] text-muted-foreground"
                    onClick={refreshJava}
                    disabled={scanning || javaDetecting}
                  >
                    <RefreshCw
                      className={cn("size-3", (scanning || javaDetecting) && "animate-spin")}
                    />
                    {scanning || javaDetecting ? "检测中…" : "刷新检测"}
                  </Button>
                  {settings.javaPath ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-7 px-2 text-[10.5px] text-muted-foreground"
                      onClick={() => onChange({ javaPath: "" })}
                    >
                      恢复自动
                    </Button>
                  ) : null}
                </div>
              }
            >
              <RadioGroup
                value={selectedJava}
                onValueChange={(value) =>
                  onChange({ javaPath: value === "auto" ? "" : value })
                }
                className="gap-2"
              >
                <label
                  htmlFor="java-auto"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/25",
                    !settings.javaPath
                      ? "border-primary/35 bg-primary/[0.035]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="auto" id="java-auto" className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[12px] font-medium">自动选择 (推荐)</span>
                    <span className="mt-0.5 block text-[10px] leading-4 text-muted-foreground">
                      {javaInstalls.length > 0
                        ? `已检测到 ${javaInstalls.length} 个本地运行时，启动时自动匹配`
                        : javaDetecting
                          ? "正在扫描…"
                          : "未检测到本地运行时，启动时自动下载 Temurin JRE"}
                    </span>
                  </span>
                </label>

                {javaInstalls.map((java) => (
                  <label
                    key={java.path}
                    htmlFor={`java-${java.path}`}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors hover:bg-muted/25",
                      settings.javaPath === java.path
                        ? "border-primary/35 bg-primary/[0.035]"
                        : "border-border/60",
                    )}
                  >
                    <RadioGroupItem
                      value={java.path}
                      id={`java-${java.path}`}
                      className="mt-0.5"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11.5px] font-medium">Java {java.major}</span>
                        <span className="font-mono text-[9px] text-muted-foreground">
                          {java.version}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                        {shortPath(java.path, 48)}
                      </span>
                    </span>
                  </label>
                ))}

                {manualJava ? (
                  <label
                    htmlFor="java-manual"
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-primary/35 bg-primary/[0.035] p-2.5"
                  >
                    <RadioGroupItem value={settings.javaPath} id="java-manual" className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-[11.5px] font-medium">手动指定</span>
                      <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                        {shortPath(settings.javaPath, 48)}
                      </span>
                    </span>
                  </label>
                ) : null}
              </RadioGroup>

              <Field label="指定 Java 可执行文件路径">
                <div className="flex gap-1.5">
                  <Input
                    value={settings.javaPath}
                    placeholder="自动检测与匹配"
                    spellCheck={false}
                    className="h-8 min-w-0 flex-1 bg-background/40 font-mono text-[10px]"
                    onChange={(event) => onChange({ javaPath: event.target.value })}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 px-3 text-[11px]"
                    onClick={browseJava}
                  >
                    浏览
                  </Button>
                </div>
              </Field>
            </SettingsSection>

            <SettingsSection
              title="启动内存与分辨率"
              icon={<Gauge className="size-4" />}
            >
              <div className="space-y-3">
                <div className="flex items-end justify-between gap-3">
                  <Label className="text-[11px] font-normal text-muted-foreground">
                    最大内存
                  </Label>
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-base font-semibold text-primary">
                      {settings.memoryMb}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">MB</span>
                  </div>
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

                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {[2048, 4096, 6144, 8192, 12288].map((mb) => (
                    <Button
                      key={mb}
                      variant="outline"
                      size="xs"
                      className={cn(
                        "h-6 px-2 font-mono text-[10px]",
                        settings.memoryMb === mb && "border-primary/50 bg-primary/10 text-primary",
                      )}
                      onClick={() => onChange({ memoryMb: mb })}
                    >
                      {mb / 1024} GB
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/15 p-2.5">
                  <Label
                    htmlFor="resolution-enabled"
                    className="text-[11.5px] font-medium"
                  >
                    自定义窗口尺寸
                  </Label>
                  <Switch
                    id="resolution-enabled"
                    checked={settings.resolutionEnabled}
                    onCheckedChange={(checked) => onChange({ resolutionEnabled: checked })}
                  />
                </div>

                {settings.resolutionEnabled ? (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                      <Field label="宽度 (px)" htmlFor="resolution-width">
                        <Input
                          id="resolution-width"
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
                      </Field>
                      <span className="pb-2 text-[11px] text-muted-foreground">×</span>
                      <Field label="高度 (px)" htmlFor="resolution-height">
                        <Input
                          id="resolution-height"
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
                      </Field>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      {[
                        { label: "720P", w: 1280, h: 720 },
                        { label: "1080P", w: 1920, h: 1080 },
                        { label: "2K", w: 2560, h: 1440 },
                        { label: "经典", w: 854, h: 480 },
                      ].map((preset) => (
                        <Button
                          key={preset.label}
                          variant="outline"
                          size="xs"
                          className={cn(
                            "h-6 px-2 text-[10px]",
                            settings.width === preset.w &&
                              settings.height === preset.h &&
                              "border-primary/50 bg-primary/10 text-primary",
                          )}
                          onClick={() => onChange({ width: preset.w, height: preset.h })}
                        >
                          {preset.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </SettingsSection>
          </div>
        </TabsContent>

        {/* 下载与网络 Tab */}
        <TabsContent value="download" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsSection
              title="下载镜像源"
              icon={<Globe className="size-4" />}
            >
              <RadioGroup
                value={settings.downloadSource || "official_ap"}
                onValueChange={(val) => onChange({ downloadSource: val as any })}
                className="gap-2"
              >
                <label
                  htmlFor="src-official-ap"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/25",
                    (!settings.downloadSource || settings.downloadSource === "official_ap")
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="official_ap" id="src-official-ap" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-medium text-foreground">
                        官方 / 亚太 Anycast CDN (推荐)
                      </span>
                      <Badge
                        variant="outline"
                        className="h-4 border-primary/35 bg-primary/10 px-1 font-mono text-[9px] text-primary"
                      >
                        非中国大陆
                      </Badge>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 font-mono text-[9px] text-muted-foreground/80">
                      <span className="rounded bg-muted/50 px-1 py-0.5">香港</span>
                      <span className="rounded bg-muted/50 px-1 py-0.5">台北</span>
                      <span className="rounded bg-muted/50 px-1 py-0.5">东京</span>
                      <span className="rounded bg-muted/50 px-1 py-0.5">新加坡</span>
                    </div>
                  </div>
                </label>

                <label
                  htmlFor="src-bmclapi"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/25",
                    settings.downloadSource === "bmclapi"
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="bmclapi" id="src-bmclapi" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-medium text-foreground">
                        BMCLAPI
                      </span>
                      <Badge
                        variant="outline"
                        className="h-4 border-border/80 px-1 font-mono text-[9px] text-muted-foreground"
                      >
                        中国大陆
                      </Badge>
                    </div>
                  </div>
                </label>

                <label
                  htmlFor="src-custom"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/25",
                    settings.downloadSource === "custom"
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="custom" id="src-custom" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <span className="text-[12px] font-medium text-foreground">
                      自定义镜像源
                    </span>
                  </div>
                </label>
              </RadioGroup>

              {settings.downloadSource === "custom" ? (
                <Field label="自定义镜像 URL">
                  <Input
                    value={settings.customSourceUrl || ""}
                    placeholder="https://..."
                    spellCheck={false}
                    className="h-8 bg-background/40 font-mono text-[11px]"
                    onChange={(e) => onChange({ customSourceUrl: e.target.value })}
                  />
                </Field>
              ) : null}
            </SettingsSection>

            <SettingsSection
              title="多线程下载并发"
              icon={<Cpu className="size-4" />}
            >
              <div className="space-y-3">
                <div className="flex items-end justify-between gap-3">
                  <Label className="text-[11px] font-normal text-muted-foreground">
                    并发线程数
                  </Label>
                  <span className="font-mono text-base font-semibold text-primary">
                    {settings.downloadThreads} <span className="text-[11px] font-normal text-muted-foreground">线程</span>
                  </span>
                </div>

                <Slider
                  min={1}
                  max={64}
                  step={1}
                  value={[settings.downloadThreads]}
                  onValueChange={([value]) => {
                    if (typeof value === "number") onChange({ downloadThreads: value });
                  }}
                  aria-label="多线程下载并发数"
                />

                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {[4, 8, 16, 24, 32].map((threads) => (
                    <Button
                      key={threads}
                      variant="outline"
                      size="xs"
                      className={cn(
                        "h-6 px-2 font-mono text-[10px]",
                        settings.downloadThreads === threads &&
                          "border-primary/50 bg-primary/10 text-primary",
                      )}
                      onClick={() => onChange({ downloadThreads: threads })}
                    >
                      {threads} 线程
                    </Button>
                  ))}
                </div>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>

        {/* 关于启动器 Tab */}
        <TabsContent value="about" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="max-w-xl">
            <SettingsSection
              title="系统架构与运行环境"
              icon={<Info className="size-4" />}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <span className="text-[11.5px] text-muted-foreground">名称与版本</span>
                  <span className="font-mono text-[12px] font-medium text-foreground">
                    Open-source-Minecraft-launcher v{systemInfo?.launcherVersion ?? "0.1.0"}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <span className="text-[11.5px] text-muted-foreground">开源协议</span>
                  <Badge variant="outline" className="border-primary/35 bg-primary/10 text-primary font-mono text-[10.5px]">
                    MIT License
                  </Badge>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <span className="text-[11.5px] text-muted-foreground">系统架构</span>
                  <span className="font-mono text-[11.5px] text-foreground">
                    {systemInfo ? `${systemInfo.os} (${systemInfo.arch})` : "正在读取…"}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <span className="text-[11.5px] text-muted-foreground">运行模式</span>
                  <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                    {isDesktop ? "Tauri 2.0 原生" : "Web 预览"}
                  </Badge>
                </div>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>
      </Tabs>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-4 text-[10px] text-muted-foreground/60">
        <span className="font-mono">
          Open-source-Minecraft-launcher {systemInfo?.launcherVersion ?? "0.1.0"}
        </span>
        <span>MIT License</span>
      </footer>
    </div>
  );
}
