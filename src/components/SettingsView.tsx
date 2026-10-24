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
  HardDrive,
  Info,
  Layers,
  Monitor,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Zap,
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
  CardDescription,
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

type SettingsTab =
  | "account"
  | "launch"
  | "download"
  | "about";

function SettingsSection({
  title,
  description,
  icon,
  children,
  actions,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
      <CardHeader className="border-b border-border/60 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
              {icon}
            </span>
            <div className="min-w-0">
              <CardTitle className="text-[13px] font-medium">{title}</CardTitle>
              <CardDescription className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                {description}
              </CardDescription>
            </div>
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5 p-5">{children}</CardContent>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
  htmlFor,
  error = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
  error?: boolean;
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
      {hint ? (
        <p className={cn("text-[10px] leading-4 text-muted-foreground/70", error && "text-destructive")}>
          {hint}
        </p>
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
        description="启动器全局配置：按功能分类管理账户、存储路径、Java 环境、启动性能与多线程下载。"
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
          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsSection
              title="账户信息"
              description="管理你的离线游戏昵称，用于单人游戏和局域网/离线服务器。"
              icon={<UserRound className="size-4" />}
            >
              <Field
                label="游戏昵称"
                htmlFor="player-name"
                error={!cleanName}
                hint={
                  cleanName
                    ? "最多 16 位，仅限字母、数字与下划线。"
                    : "昵称不符合要求：请使用 1–16 位字母、数字或下划线。"
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
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    离线 UUID 根据昵称哈希生成，保证单机存档所有权一致
                  </p>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title="账户服务与规划"
              description="了解离线账户的工作机制及未来特性规划。"
              icon={<ShieldCheck className="size-4" />}
            >
              <div className="space-y-3 text-[11px] leading-5 text-muted-foreground">
                <div className="rounded-lg border border-border/50 bg-muted/15 p-3.5">
                  <p className="font-medium text-foreground">离线账户机制</p>
                  <p className="mt-1 text-[10.5px]">
                    启动器采用符合 Minecraft 离线认证标准的生成算法，将昵称转化为固定的 UUID v3。这确保了在不连接 Mojang 服务器的情况下，单人世界和离线服务器能够稳定保存你的背包、成就和权限。
                  </p>
                </div>
                <div className="rounded-lg border border-border/50 bg-muted/15 p-3.5">
                  <p className="font-medium text-foreground">正版登录支持 (路线图)</p>
                  <p className="mt-1 text-[10.5px]">
                    微软 OAuth2 正版登录与自定义皮肤加载机制正在开发中，后续版本将支持多账号自由切换与正版联机验证。
                  </p>
                </div>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>

        {/* 游戏与启动 Tab (合并存储、Java 与性能) */}
        <TabsContent value="launch" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsSection
              title="游戏文件根目录"
              description="客户端、资源文件、依赖库和每个版本的独立目录都会保存在这里。"
              icon={<FolderOpen className="size-4" />}
            >
              <Field
                label="游戏主目录路径"
                htmlFor="game-root"
                hint="可直接输入绝对路径或点击“选择”通过文件管理器选取。按回车或失焦即可保存。"
              >
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
                    title="在资源管理器中打开"
                    aria-label="在资源管理器中打开"
                  >
                    <FolderOpen className="size-3.5" />
                  </Button>
                </div>
              </Field>

              <div className="rounded-lg border border-border/60 bg-muted/15 p-3.5">
                <p className="text-[11px] font-medium text-foreground">独立版本隔离</p>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  每个已安装版本拥有各自独立的子目录，其模组（mods/）、光影（shaderpacks/）、存档（saves/）及配置文件完全隔离，避免多版本之间资源相互冲突。
                </p>
              </div>
            </SettingsSection>

            <SettingsSection
              title="目录结构导航"
              description="游戏目录下的关键子文件夹结构说明及快速访问入口。"
              icon={<HardDrive className="size-4" />}
            >
              <div className="space-y-2.5">
                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-3">
                  <div className="min-w-0">
                    <p className="text-[11.5px] font-medium text-foreground">版本目录 (versions)</p>
                    <p className="truncate font-mono text-[9.5px] text-muted-foreground">
                      {joinPath(settings.gameRoot, "versions")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-7 shrink-0 gap-1 text-[10.5px]"
                    onClick={() => onOpenFolder(joinPath(settings.gameRoot, "versions"))}
                  >
                    <FolderOpen className="size-3 text-primary" />
                    打开
                  </Button>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-3">
                  <div className="min-w-0">
                    <p className="text-[11.5px] font-medium text-foreground">资源索引与对象 (assets)</p>
                    <p className="truncate font-mono text-[9.5px] text-muted-foreground">
                      {joinPath(settings.gameRoot, "assets")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-7 shrink-0 gap-1 text-[10.5px]"
                    onClick={() => onOpenFolder(joinPath(settings.gameRoot, "assets"))}
                  >
                    <FolderOpen className="size-3 text-primary" />
                    打开
                  </Button>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-3">
                  <div className="min-w-0">
                    <p className="text-[11.5px] font-medium text-foreground">公共依赖库 (libraries)</p>
                    <p className="truncate font-mono text-[9.5px] text-muted-foreground">
                      {joinPath(settings.gameRoot, "libraries")}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-7 shrink-0 gap-1 text-[10.5px]"
                    onClick={() => onOpenFolder(joinPath(settings.gameRoot, "libraries"))}
                  >
                    <FolderOpen className="size-3 text-primary" />
                    打开
                  </Button>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title="Java 运行时选择"
              description="启动器支持自动检测匹配游戏要求的 Java 主版本，也可手动指定。"
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
                        ? `已在系统与通用路径中检测到 ${javaInstalls.length} 个 Java 运行时；启动时根据游戏所需版本自动匹配。`
                        : javaDetecting
                          ? "正在扫描本机与运行时环境…"
                          : "未检测到本地 Java，启动时将自动下载并配置匹配的 Eclipse Temurin JRE。"}
                    </span>
                  </span>
                </label>

                {javaInstalls.map((java) => (
                  <label
                    key={java.path}
                    htmlFor={`java-${java.path}`}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/25",
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
                        <span className="text-[12px] font-medium">Java {java.major}</span>
                        <span className="font-mono text-[9px] text-muted-foreground">
                          {java.version}
                        </span>
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                        {shortPath(java.path, 52)}
                      </span>
                    </span>
                  </label>
                ))}

                {manualJava ? (
                  <label
                    htmlFor="java-manual"
                    className="flex cursor-pointer items-start gap-3 rounded-lg border border-primary/35 bg-primary/[0.035] p-3"
                  >
                    <RadioGroupItem value={settings.javaPath} id="java-manual" className="mt-0.5" />
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium">手动指定运行路径</span>
                      <span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">
                        {shortPath(settings.javaPath, 52)}
                      </span>
                    </span>
                  </label>
                ) : null}
              </RadioGroup>

              <Field
                label="手动输入或浏览 java.exe 路径"
                hint="留空则使用全局自动匹配机制。若手动指定，请确保 Java 大版本满足目标游戏版本要求。"
              >
                <div className="flex gap-1.5">
                  <Input
                    value={settings.javaPath}
                    placeholder="自动检测与匹配"
                    spellCheck={false}
                    className="h-9 min-w-0 flex-1 bg-background/40 font-mono text-[10px]"
                    onChange={(event) => onChange({ javaPath: event.target.value })}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 px-3 text-[11px]"
                    onClick={browseJava}
                  >
                    浏览
                  </Button>
                </div>
              </Field>
            </SettingsSection>

            <SettingsSection
              title="Java 版本匹配指南"
              description="不同 Minecraft 版本的官方 Java 运行环境对应要求参考。"
              icon={<Layers className="size-4" />}
            >
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-[10.5px]">
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-2.5">
                    <p className="font-medium text-foreground">Minecraft 1.20.5+</p>
                    <p className="mt-0.5 text-muted-foreground">推荐 Java 21 (64-bit)</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-2.5">
                    <p className="font-medium text-foreground">Minecraft 1.18 – 1.20.4</p>
                    <p className="mt-0.5 text-muted-foreground">推荐 Java 17 (64-bit)</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-2.5">
                    <p className="font-medium text-foreground">Minecraft 1.17</p>
                    <p className="mt-0.5 text-muted-foreground">推荐 Java 16 (64-bit)</p>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-2.5">
                    <p className="font-medium text-foreground">Minecraft 1.16.5 及以下</p>
                    <p className="mt-0.5 text-muted-foreground">推荐 Java 8 (64-bit)</p>
                  </div>
                </div>

                <div className="rounded-lg border border-primary/20 bg-primary/[0.035] p-3 text-[10px] leading-4 text-muted-foreground">
                  <p className="font-medium text-primary">智能自适应</p>
                  <p className="mt-0.5">
                    设置为“自动选择”时，启动器会解析版本元数据中的 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[9px]">javaVersion</code> 声明，并在检测到的 Java 列表中挑选最合适的环境启动。
                  </p>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title="Java 虚拟机内存分配"
              description="控制游戏运行时的最大堆内存大小 (-Xmx)。"
              icon={<Gauge className="size-4" />}
            >
              <div className="space-y-3">
                <div className="flex items-end justify-between gap-3">
                  <Label className="text-[11px] font-normal text-muted-foreground">
                    最大运行内存
                  </Label>
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-base font-semibold text-primary">
                      {settings.memoryMb}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">MB</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      (约 {(settings.memoryMb / 1024).toFixed(1)} GB)
                    </span>
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

                <div className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
                  <span>1 GB</span>
                  <span>4 GB</span>
                  <span>8 GB</span>
                  <span>12 GB</span>
                  <span>16 GB</span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <span className="text-[10px] text-muted-foreground">快捷预设：</span>
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

                <p className="text-[10px] leading-4 text-muted-foreground/70">
                  原版纯净游戏建议分配 2–4 GB；安装 Fabric/Forge 模组与光影包时，推荐分配 6–8 GB 或以上。
                </p>
              </div>
            </SettingsSection>

            <SettingsSection
              title="游戏窗口大小与分辨率"
              description="自定义游戏启动时的窗口初始宽高尺寸。"
              icon={<Monitor className="size-4" />}
            >
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/15 p-3">
                  <div className="min-w-0">
                    <Label
                      htmlFor="resolution-enabled"
                      className="text-[12px] font-medium"
                    >
                      自定义初始窗口尺寸
                    </Label>
                    <p className="mt-0.5 text-[10px] leading-4 text-muted-foreground">
                      关闭时遵循游戏默认窗口大小（通常为 854 × 480）。
                    </p>
                  </div>
                  <Switch
                    id="resolution-enabled"
                    checked={settings.resolutionEnabled}
                    onCheckedChange={(checked) => onChange({ resolutionEnabled: checked })}
                  />
                </div>

                {settings.resolutionEnabled ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                      <Field label="宽度 (px)" htmlFor="resolution-width">
                        <Input
                          id="resolution-width"
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
                      </Field>
                      <span className="pb-2.5 text-[11px] text-muted-foreground">×</span>
                      <Field label="高度 (px)" htmlFor="resolution-height">
                        <Input
                          id="resolution-height"
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
                      </Field>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">常用比例：</span>
                      {[
                        { label: "720P", w: 1280, h: 720 },
                        { label: "1080P", w: 1920, h: 1080 },
                        { label: "2K", w: 2560, h: 1440 },
                        { label: "经典窗口", w: 854, h: 480 },
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
                          {preset.label} ({preset.w}×{preset.h})
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="rounded-lg border border-border/50 bg-muted/15 p-3 text-[10px] leading-4 text-muted-foreground">
                  启动参数中的 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[9px]">-Xmx</code>{" "}
                  会自动注入设置的内存上限。若在“版本独立设置”中开启了个性化覆盖，将优先使用该版本的独立设置。
                </div>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>

        {/* 下载与网络 Tab */}
        <TabsContent value="download" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsSection
              title="下载镜像源选择"
              description="配置游戏版本清单、依赖库及模组加载器的镜像节点与全球 CDN。"
              icon={<Globe className="size-4" />}
            >
              <RadioGroup
                value={settings.downloadSource || "official_ap"}
                onValueChange={(val) => onChange({ downloadSource: val as any })}
                className="gap-2.5"
              >
                <label
                  htmlFor="src-official-ap"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors hover:bg-muted/25",
                    (!settings.downloadSource || settings.downloadSource === "official_ap")
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="official_ap" id="src-official-ap" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-medium text-foreground">
                        官方 / 亚太 Anycast CDN (推荐 · 非中国大陆)
                      </span>
                      <Badge
                        variant="outline"
                        className="h-4 border-primary/35 bg-primary/10 px-1 font-mono text-[9px] text-primary"
                      >
                        低延迟
                      </Badge>
                      <Badge
                        variant="outline"
                        className="h-4 border-border/80 px-1 font-mono text-[9px] text-muted-foreground"
                      >
                        非中国大陆
                      </Badge>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                      直连 Cloudflare Anycast 与 AWS CloudFront 亚太分布式边缘节点（覆盖香港、台北、东京、新加坡等），就近智能路由分发，免受中国大陆境内网络审查、证书或备案拦截。
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[9px] text-muted-foreground/80">
                      <span className="rounded bg-muted/50 px-1 py-0.5">香港 (HKG)</span>
                      <span className="rounded bg-muted/50 px-1 py-0.5">台北 (TPE)</span>
                      <span className="rounded bg-muted/50 px-1 py-0.5">东京 (NRT)</span>
                      <span className="rounded bg-muted/50 px-1 py-0.5">新加坡 (SIN)</span>
                    </div>
                  </div>
                </label>

                <label
                  htmlFor="src-bmclapi"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors hover:bg-muted/25",
                    settings.downloadSource === "bmclapi"
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="bmclapi" id="src-bmclapi" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-medium text-foreground">
                        BMCLAPI (中国大陆镜像)
                      </span>
                      <Badge
                        variant="outline"
                        className="h-4 border-border/80 px-1 font-mono text-[9px] text-muted-foreground"
                      >
                        中国大陆境内
                      </Badge>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                      国内开源社区维护的 Minecraft 资源镜像服务，服务器与节点均位于中国大陆境内，适合大陆直连用户。
                    </p>
                  </div>
                </label>

                <label
                  htmlFor="src-custom"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors hover:bg-muted/25",
                    settings.downloadSource === "custom"
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="custom" id="src-custom" className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[12px] font-medium text-foreground">
                        自定义镜像源 (Custom Gateway)
                      </span>
                      <Badge
                        variant="outline"
                        className="h-4 border-border/80 px-1 font-mono text-[9px] text-muted-foreground"
                      >
                        自定义
                      </Badge>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                      使用自建的反向代理、Cloudflare Workers 或指定海外私有加速镜像。
                    </p>
                  </div>
                </label>
              </RadioGroup>

              {settings.downloadSource === "custom" ? (
                <Field
                  label="自定义镜像域名或网关 URL"
                  hint="例：https://my-mc-mirror.workers.dev"
                >
                  <Input
                    value={settings.customSourceUrl || ""}
                    placeholder="https://..."
                    spellCheck={false}
                    className="h-9 bg-background/40 font-mono text-[11px]"
                    onChange={(e) => onChange({ customSourceUrl: e.target.value })}
                  />
                </Field>
              ) : null}
            </SettingsSection>

            <div className="space-y-4">
              <SettingsSection
                title="多线程下载并发工作池"
                description="配置启动器下载依赖库、资源文件以及大文件的并发线程数。"
                icon={<Cpu className="size-4" />}
              >
                <div className="space-y-3">
                  <div className="flex items-end justify-between gap-3">
                    <Label className="text-[11px] font-normal text-muted-foreground">
                      并发工作线程数
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

                  <div className="flex justify-between font-mono text-[9px] text-muted-foreground/60">
                    <span>1 线程</span>
                    <span>16 线程 (推荐)</span>
                    <span>32 线程</span>
                    <span>64 线程</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[10px] text-muted-foreground">快捷设置：</span>
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

                  <p className="text-[10px] leading-4 text-muted-foreground/70">
                    多线程并发配合边缘 CDN，在拉取大量小文件（如 Minecraft Assets 散列资源与 Java 依赖库）时大幅缩短总耗时。
                  </p>
                </div>
              </SettingsSection>

              <SettingsSection
                title="加速机制与数据校验"
                description="多线程下载器内置的协议特性与完整性安全策略。"
                icon={<Zap className="size-4" />}
              >
                <div className="space-y-2.5">
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
                    <p className="text-[11.5px] font-medium text-foreground">HTTP Range 分片加速</p>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                      当单文件体积较大（如客户端 client.jar 或整合包压缩文件）且服务器支持 HTTP Range 时，下载器会自动将其划分为等长分片并行拉取，显著突破单连接限速。
                    </p>
                  </div>

                  <div className="rounded-lg border border-border/50 bg-muted/15 p-3">
                    <p className="text-[11.5px] font-medium text-foreground">SHA-1 完整性校验</p>
                    <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                      所有官方依赖库与资源对象在落盘前均经过 SHA-1 校验比对，防止因网络丢包或写入异常导致的游戏崩溃。
                    </p>
                  </div>
                </div>
              </SettingsSection>
            </div>
          </div>
        </TabsContent>

        {/* 关于启动器 Tab */}
        <TabsContent value="about" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="grid gap-4 lg:grid-cols-2">
            <SettingsSection
              title="启动器版本与系统架构"
              description="当前运行的启动器版本及宿主操作系统环境。"
              icon={<Info className="size-4" />}
            >
              <div className="space-y-2.5">
                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-3">
                  <span className="text-[11.5px] text-muted-foreground">启动器名称与版本</span>
                  <span className="font-mono text-[12px] font-medium text-foreground">
                    Cobble v{systemInfo?.launcherVersion ?? "0.1.0"}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-3">
                  <span className="text-[11.5px] text-muted-foreground">操作系统与架构</span>
                  <span className="font-mono text-[11.5px] text-foreground">
                    {systemInfo ? `${systemInfo.os} (${systemInfo.arch})` : "正在读取…"}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-3">
                  <span className="text-[11.5px] text-muted-foreground">运行时环境</span>
                  <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                    {isDesktop ? "Tauri 2.0 原生桌面" : "浏览器预览模式"}
                  </Badge>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title="开源与数据存储"
              description="设置存储策略与项目说明。"
              icon={<ShieldCheck className="size-4" />}
            >
              <div className="space-y-3 text-[11px] leading-5 text-muted-foreground">
                <p>
                  Cobble 是一款遵循现代化轻量理念设计的开源 Minecraft 启动器，基于 Rust + Tauri 2.0 与 React 19 构建。
                </p>
                <div className="rounded-lg border border-border/50 bg-muted/15 p-3 font-mono text-[10px]">
                  <p className="text-foreground">持久化存储机制：</p>
                  <p className="mt-0.5 text-muted-foreground">
                    所有全局设置和版本独立设置均保存在本地应用目录的 JSON 文件中，任何设置项变更都会立即生效并自动保存，无需手动确认。
                  </p>
                </div>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>
      </Tabs>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-4 text-[10px] text-muted-foreground/60">
        <span className="font-mono">
          Cobble {systemInfo?.launcherVersion ?? "0.1.0"} /{" "}
          {systemInfo ? `${systemInfo.os} ${systemInfo.arch}` : "正在读取系统信息"}
        </span>
        <span>设置会自动保存在本机</span>
      </footer>
    </div>
  );
}
