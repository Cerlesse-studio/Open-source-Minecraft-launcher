import { useEffect, useState, type ReactNode } from "react";
import { open } from "@/lib/desktop";
import {
  AlertCircle,
  Boxes,
  Check,
  ChevronDown,
  ChevronUp,
  CloudDownload,
  Coffee,
  Cpu,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Gauge,
  Globe,
  Image as ImageIcon,
  Info,
  Monitor,
  Moon,
  Newspaper,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  Sun,
  Type,
  Upload,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import { isDesktop, openExternalUrl, probeDownloadSources } from "../lib/backend";
import { joinPath, shortPath } from "../lib/format";
import { DEFAULT_ACCENT } from "../lib/theme";
import type {
  MsAccount,
  DownloadSourceId,
  DownloadSourceProbe,
  HomePageMode,
  JavaInstall,
  LauncherSettings,
  LauncherVisibility,
  OfflineSkinModel,
  OfflineSkinType,
  ProcessPriority,
  SystemInfo,
  VersionIsolation,
  WindowSizeMode,
} from "../lib/types";
import { Avatar, PageHeader } from "./ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface CreditEntry {
  name: string;
  role: string;
  license?: string;
  url: string;
  /**
   * Brand mark shipped in `public/` so the list works offline. Entries without
   * one (or with a mark that fails to load) fall back to a letter badge.
   */
  icon?: string;
  /** Minecraft textures are nearest-neighbour art and need `image-rendering`. */
  pixel?: boolean;
}

/**
 * Only the projects the launcher genuinely leans on. The full dependency list
 * stays in package.json / Cargo.toml; this page is an acknowledgement, not a
 * bill of materials.
 */
const CORE_PROJECTS: CreditEntry[] = [
  { name: "Electron", role: "桌面运行时", license: "MIT", url: "https://github.com/electron/electron" },
  { name: "Rust", role: "后端语言", license: "MIT / Apache-2.0", url: "https://www.rust-lang.org", icon: "/icons/credits/rust.svg" },
  { name: "React", role: "界面框架", license: "MIT", url: "https://github.com/facebook/react", icon: "/icons/credits/react.svg" },
  { name: "Vite", role: "构建工具", license: "MIT", url: "https://github.com/vitejs/vite", icon: "/icons/credits/vite.svg" },
  { name: "Tailwind CSS", role: "样式引擎", license: "MIT", url: "https://github.com/tailwindlabs/tailwindcss", icon: "/icons/credits/tailwindcss.svg" },
  { name: "Radix UI", role: "界面组件原语", license: "MIT", url: "https://github.com/radix-ui/primitives" },
  { name: "Lucide", role: "图标库", license: "ISC", url: "https://github.com/lucide-icons/lucide" },
  { name: "Sonner", role: "通知提示", license: "MIT", url: "https://github.com/emilkowalski/sonner" },
  { name: "Geist / Silkscreen", role: "界面字体", license: "SIL OFL 1.1", url: "https://github.com/vercel/geist-font" },
  { name: "EasyTier", role: "联机内核（easytier-core）", license: "LGPL-3.0", url: "https://github.com/EasyTier/EasyTier" },
  { name: "BedrockBoot-DM", role: "基岩版核心与加载规范", url: "https://github.com/0x44614D696E67/BedrockBoot-DM", icon: "/icons/minecraft/bedrock.png", pixel: true },
];

const SOURCE_PROJECTS: CreditEntry[] = [
  { name: "Mojang", role: "版本元数据与资源", url: "https://www.minecraft.net", icon: "/icons/minecraft/grass_block.png", pixel: true },
  { name: "Microsoft / Xbox Live", role: "正版账户登录与游戏服务", url: "https://www.xbox.com" },
  { name: "BMCLAPI", role: "国内下载镜像", url: "https://github.com/bangbang93/BMCLAPI", icon: "/icons/credits/bmclapi.png" },
  { name: "Betacraft", role: "旧版本资源与版本索引", url: "https://betacraft.uk" },
  { name: "Modrinth", role: "模组索引与 CDN", url: "https://modrinth.com", icon: "/icons/credits/modrinth.svg" },
  { name: "CurseForge", role: "模组索引", url: "https://www.curseforge.com", icon: "/icons/credits/curseforge.svg" },
  { name: "MC百科", role: "模组中文资料", url: "https://www.mcmod.cn", icon: "/icons/credits/mcmod.png" },
];

function CreditRow({ entry }: { entry: CreditEntry }) {
  const [iconFailed, setIconFailed] = useState(false);
  const icon = entry.icon && !iconFailed ? entry.icon : null;
  return (
    <button
      type="button"
      onClick={() => void openExternalUrl(entry.url)}
      title={entry.url}
      className="group flex items-center gap-2.5 rounded-lg border border-border/50 bg-muted/15 px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:outline-none"
    >
      <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background/60 p-1">
        {icon ? (
          <img
            src={icon}
            alt=""
            aria-hidden="true"
            loading="lazy"
            onError={() => setIconFailed(true)}
            className={cn("size-full object-contain", entry.pixel && "pixelated")}
          />
        ) : (
          <span
            aria-hidden="true"
            className="select-none text-[11px] font-semibold text-muted-foreground/70 group-hover:text-primary"
          >
            {entry.name.trim().charAt(0).toUpperCase()}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-medium text-foreground">{entry.name}</span>
        <span className="block truncate text-[10px] text-muted-foreground/60">{entry.role}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground/50">
        {entry.license ? <span className="font-mono text-[9.5px]">{entry.license}</span> : null}
        <ExternalLink className="size-3 transition-colors group-hover:text-primary" />
      </span>
    </button>
  );
}

const HOME_PAGE_OPTIONS: Array<{ id: HomePageMode; label: string; icon: LucideIcon }> = [
  { id: "blank", label: "空白", icon: SquareDashed },
  { id: "preset", label: "预设", icon: Newspaper },
  { id: "local", label: "读取本地文件", icon: FileCode2 },
  { id: "online", label: "联网更新", icon: CloudDownload },
];

const DOWNLOAD_SOURCE_LABELS: Record<string, string> = {
  official_ap: "官方 / 亚太 CDN",
  bmclapi: "BMCLAPI",
  custom: "自定义镜像",
};

/** Latency chip shown next to a mirror after probing. */
function ProbeBadge({ probe, fastest }: { probe?: DownloadSourceProbe; fastest: boolean }) {
  if (!probe) return null;
  if (!probe.ok) {
    return (
      <span
        title={probe.error || undefined}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-destructive/35 bg-destructive/10 px-1.5 py-0.5 font-mono text-[9px] text-destructive"
      >
        <span className="size-1.5 rounded-full bg-destructive" />
        不可用
      </span>
    );
  }
  return (
    <span
      className={cn(
        "ml-auto inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px]",
        fastest
          ? "border-success/40 bg-success/10 text-success"
          : "border-border/70 bg-muted/30 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          fastest ? "bg-success" : "bg-muted-foreground/60",
        )}
      />
      {fastest ? "最快 " : ""}
      {probe.latencyMs} ms
    </span>
  );
}

interface SettingsViewProps {
  settings: LauncherSettings;
  onChange: (patch: Partial<LauncherSettings>) => void;
  systemInfo: SystemInfo | null;
  javaInstalls: JavaInstall[];
  javaDetecting: boolean;
  onRefreshJava: () => Promise<void>;
  onOpenFolder: (path: string) => void;
  onNotify: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
  account?: MsAccount | null;
}

type SettingsTab = "account" | "launch" | "download" | "personalization" | "about";

function SettingsSection({
  title,
  icon,
  children,
  actions,
  className,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 border-border/70 bg-card/55 py-0 shadow-sm", className)}>
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

function SettingsSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: string; description?: string }>;
  onChange: (val: T) => void;
  disabled?: boolean;
}) {
  const current = options.find((opt) => opt.value === value) ?? options[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
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

export function SettingsView({
  settings,
  onChange,
  systemInfo,
  javaInstalls,
  javaDetecting,
  onRefreshJava,
  onOpenFolder,
  onNotify,
  account,
}: SettingsViewProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const [scanning, setScanning] = useState(false);
  const [rootDraft, setRootDraft] = useState(settings.gameRoot);
  const [skinCollapsed, setSkinCollapsed] = useState(false);
  const [sourceProbes, setSourceProbes] = useState<DownloadSourceProbe[] | null>(null);
  const [probingSources, setProbingSources] = useState(false);
  const cleanName = /^[A-Za-z0-9_]{1,16}$/.test(settings.playerName);

  // Custom mirror latency changes when the URL changes, so drop stale results.
  useEffect(() => {
    setSourceProbes(null);
  }, [settings.customSourceUrl]);

  const probeSources = async () => {
    setProbingSources(true);
    try {
      setSourceProbes(await probeDownloadSources(settings.customSourceUrl || ""));
    } catch (error) {
      onNotify("error", "测速失败", String(error));
    } finally {
      setProbingSources(false);
    }
  };

  const probeFor = (source: DownloadSourceId) =>
    sourceProbes?.find((probe) => probe.source === source);
  const fastestProbe =
    sourceProbes
      ?.filter((probe) => probe.ok)
      .reduce<DownloadSourceProbe | null>(
        (best, probe) => (!best || probe.latencyMs < best.latencyMs ? probe : best),
        null,
      ) ?? null;

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

  const browseCustomSkin = async () => {
    if (!isDesktop) {
      onNotify("info", "浏览器预览模式", "文件选择在桌面应用中可用。");
      return;
    }
    try {
      const picked = await open({
        directory: false,
        multiple: false,
        filters: [{ name: "Minecraft 皮肤 (*.png)", extensions: ["png"] }],
        title: "选择离线皮肤文件",
      });
      if (typeof picked === "string" && picked.trim()) {
        onChange({ customSkinPath: picked.trim() });
        onNotify("success", "已设置自定义皮肤", picked.trim());
      }
    } catch (error) {
      onNotify("error", "无法选择皮肤文件", String(error));
    }
  };

  const handlePickWallpaper = async () => {
    if (!isDesktop) {
      onNotify("info", "Web 预览模式", "Web 预览环境请直接在输入框中填入图片 URL。");
      return;
    }
    try {
      const picked = await open({
        directory: false,
        multiple: false,
        filters: [
          {
            name: "图片文件 (*.png, *.jpg, *.jpeg, *.webp)",
            extensions: ["png", "jpg", "jpeg", "webp"],
          },
        ],
        title: "选择启动器背景壁纸图片",
      });
      if (typeof picked === "string" && picked.trim()) {
        onChange({
          backgroundType: "custom",
          customBackgroundPath: picked.trim(),
        });
        onNotify("success", "已设置背景壁纸", picked.trim());
      }
    } catch (error) {
      onNotify("error", "无法选择壁纸文件", String(error));
    }
  };

  const handlePickHomePage = async () => {
    if (!isDesktop) {
      onNotify("info", "浏览器预览模式", "读取本地主页文件需要桌面应用。");
      return;
    }
    try {
      const picked = await open({
        directory: false,
        multiple: false,
        filters: [
          {
            name: "网页与 PCL 主页 (*.html, *.htm, *.xaml, *.xml)",
            extensions: ["html", "htm", "xaml", "xml"],
          },
        ],
        title: "选择自定义主页文件（HTML 或 PCL2 的 XAML）",
      });
      if (typeof picked === "string" && picked.trim()) {
        onChange({ homePageMode: "local", homePageLocalPath: picked.trim() });
        onNotify("success", "已设置本地主页", picked.trim());
      }
    } catch (error) {
      onNotify("error", "无法选择主页文件", String(error));
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
              value="personalization"
              className="gap-2 px-3.5 py-1.5 text-[12px] data-[state=active]:bg-background/80"
            >
              <Sparkles className="size-3.5 text-primary" />
              个性化
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
          <div className="max-w-2xl space-y-4">
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
                <div className="size-10 overflow-hidden rounded-md border border-border/60 bg-background flex items-center justify-center shrink-0">
                  <Avatar
                    name={account?.signedIn ? account.name : settings.playerName || "Steve"}
                    skinType={
                      settings.offlineSkinType === "custom" && settings.customSkinPath
                        ? "custom"
                        : account?.signedIn
                          ? settings.offlineSkinType === "steve" || settings.offlineSkinType === "alex"
                            ? settings.offlineSkinType
                            : "mojang"
                          : settings.offlineSkinType
                    }
                    customSkinPath={settings.customSkinPath}
                    mojangSkinName={
                      account?.signedIn
                        ? settings.offlineSkinType === "mojang" && settings.mojangSkinName?.trim()
                          ? settings.mojangSkinName.trim()
                          : account.name
                        : settings.mojangSkinName
                    }
                    skinUrl={account?.skinUrl}
                    size={40}
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {account?.signedIn ? account.name : settings.playerName || "未命名"}
                    </p>
                    <Badge
                      variant="outline"
                      className={cn(
                        "h-4 border-border/80 px-1.5 text-[9px] font-normal",
                        account?.signedIn
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      {account?.signedIn ? "正版账户" : "离线账户"}
                    </Badge>
                  </div>
                  <p className="text-[10.5px] text-muted-foreground truncate pt-0.5">
                    {account?.signedIn ? (
                      <>
                        当前正版模式 · 皮肤：
                        <span className="text-foreground/90 font-medium">
                          {settings.offlineSkinType === "custom" && settings.customSkinPath
                            ? "自定义本地皮肤"
                            : settings.offlineSkinType === "steve"
                              ? "强制 Steve 粗手臂"
                              : settings.offlineSkinType === "alex"
                                ? "强制 Alex 细手臂"
                                : settings.offlineSkinType === "mojang" && settings.mojangSkinName?.trim()
                                  ? `指定正版皮肤 (${settings.mojangSkinName.trim()})`
                                  : `官方正版皮肤 (${account.name})`}
                        </span>
                      </>
                    ) : (
                      <>
                        离线皮肤状态：
                        <span className="text-foreground/90 font-medium">
                          {settings.offlineSkinType === "random"
                            ? "随机 (默认)"
                            : settings.offlineSkinType === "steve"
                              ? "Steve 粗手臂"
                              : settings.offlineSkinType === "alex"
                                ? "Alex 细手臂"
                                : settings.offlineSkinType === "mojang"
                                  ? `正版皮肤 (${settings.mojangSkinName?.trim() || settings.playerName})`
                                  : "自定义本地皮肤"}
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </div>
            </SettingsSection>

            {/* 离线皮肤 Card */}
            <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
              <CardHeader className="border-b border-border/60 px-5 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-primary">
                      <Sparkles className="size-4" />
                    </span>
                    <CardTitle className="text-[13px] font-medium">离线皮肤</CardTitle>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    onClick={() => setSkinCollapsed((prev) => !prev)}
                    title={skinCollapsed ? "展开" : "收起"}
                    aria-label={skinCollapsed ? "展开" : "收起"}
                  >
                    {skinCollapsed ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronUp className="size-4" />
                    )}
                  </Button>
                </div>
              </CardHeader>

              {!skinCollapsed && (
                <CardContent className="space-y-4 p-5">
                  {/* Warning banner matching user screenshot */}
                  <div className="rounded-md border-l-4 border-amber-500 bg-amber-500/10 px-4 py-2.5 text-[12px] font-medium text-amber-600 dark:text-amber-400">
                    由于技术问题，此功能只保证对 1.19.2 以前的版本有效！
                  </div>

                  {/* Radio Group matching user screenshot */}
                  <RadioGroup
                    value={settings.offlineSkinType}
                    onValueChange={(val) =>
                      onChange({ offlineSkinType: val as OfflineSkinType })
                    }
                    className="flex flex-wrap items-center gap-6 pt-1"
                  >
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="random" id="skin-random" />
                      <Label htmlFor="skin-random" className="cursor-pointer text-xs font-normal">
                        随机
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="steve" id="skin-steve" />
                      <Label htmlFor="skin-steve" className="cursor-pointer text-xs font-normal">
                        Steve
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="alex" id="skin-alex" />
                      <Label htmlFor="skin-alex" className="cursor-pointer text-xs font-normal">
                        Alex
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="mojang" id="skin-mojang" />
                      <Label htmlFor="skin-mojang" className="cursor-pointer text-xs font-normal">
                        正版皮肤
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="custom" id="skin-custom" />
                      <Label htmlFor="skin-custom" className="cursor-pointer text-xs font-normal">
                        自定义
                      </Label>
                    </div>
                  </RadioGroup>

                  {/* Contextual Options */}
                  {settings.offlineSkinType === "random" && (
                    <div className="rounded-lg border border-border/50 bg-muted/15 p-3 text-[11.5px] leading-relaxed text-muted-foreground">
                      💡 由 Minecraft 客户端根据玩家离线 UUID 自动随机决定默认皮肤（Steve 或 Alex）。
                    </div>
                  )}

                  {settings.offlineSkinType === "steve" && (
                    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/15 p-3">
                      <div className="size-9 shrink-0 overflow-hidden rounded border border-border/60 bg-muted/30">
                        <img
                          src="https://minotar.net/helm/Steve/36.png"
                          alt="Steve"
                          className="size-full object-contain pixelated"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      </div>
                      <div className="text-[11.5px] text-muted-foreground leading-relaxed">
                        💡 强制将离线 UUID 校验为偶数哈希，固定使用经典的史蒂夫（Steve）4px 粗手臂模型与外观。
                      </div>
                    </div>
                  )}

                  {settings.offlineSkinType === "alex" && (
                    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-muted/15 p-3">
                      <div className="size-9 shrink-0 overflow-hidden rounded border border-border/60 bg-muted/30">
                        <img
                          src="https://minotar.net/helm/Alex/36.png"
                          alt="Alex"
                          className="size-full object-contain pixelated"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      </div>
                      <div className="text-[11.5px] text-muted-foreground leading-relaxed">
                        💡 强制将离线 UUID 校验为奇数哈希，固定使用爱丽克丝（Alex）3px 细手臂纤细外观。
                      </div>
                    </div>
                  )}

                  {settings.offlineSkinType === "mojang" && (
                    <div className="space-y-3 rounded-lg border border-border/50 bg-muted/15 p-3.5">
                      <div className="space-y-1.5">
                        <Label htmlFor="mojang-skin-name" className="text-[11px] text-muted-foreground">
                          正版玩家游戏 ID（留空则默认使用当前游戏昵称）
                        </Label>
                        <div className="flex gap-2">
                          <Input
                            id="mojang-skin-name"
                            value={settings.mojangSkinName || ""}
                            placeholder={settings.playerName || "例如 Notch"}
                            spellCheck={false}
                            className="h-8 text-xs font-mono bg-background/50"
                            onChange={(e) => onChange({ mojangSkinName: e.target.value })}
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-3 pt-1">
                        <div className="size-10 shrink-0 overflow-hidden rounded border border-border/60 bg-background flex items-center justify-center">
                          <img
                            src={`https://minotar.net/helm/${settings.mojangSkinName?.trim() || settings.playerName || "Steve"}/40.png`}
                            alt="Mojang Skin"
                            className="size-full object-contain pixelated"
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        </div>
                        <div className="text-[11px] text-muted-foreground leading-relaxed">
                          启动时启动器将通过 Mojang 官方 API 读取正版皮肤与带签名的 textures 数据。在 1.19.2 及以前版本离线进入游戏时即可完美显示。
                        </div>
                      </div>
                    </div>
                  )}

                  {settings.offlineSkinType === "custom" && (
                    <div className="space-y-3 rounded-lg border border-border/50 bg-muted/15 p-3.5">
                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-muted-foreground">选择本地皮肤文件 (.png)</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            value={settings.customSkinPath || ""}
                            placeholder="请选择 .png 格式的 Minecraft 皮肤文件…"
                            readOnly
                            className="h-8 text-xs font-mono bg-background/50 flex-1 truncate"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 gap-1.5 px-3 text-xs shrink-0"
                            onClick={browseCustomSkin}
                          >
                            <Upload className="size-3.5 text-primary" />
                            <span>浏览选择</span>
                          </Button>
                          {settings.customSkinPath && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => onChange({ customSkinPath: "" })}
                            >
                              清除
                            </Button>
                          )}
                        </div>
                      </div>

                      {/* Arm Model Selection */}
                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-muted-foreground">皮肤模型手臂类型</Label>
                        <RadioGroup
                          value={settings.offlineSkinModel}
                          onValueChange={(val) =>
                            onChange({ offlineSkinModel: val as OfflineSkinModel })
                          }
                          className="flex items-center gap-6"
                        >
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="default" id="model-default" />
                            <Label htmlFor="model-default" className="cursor-pointer text-xs font-normal">
                              经典 (4px 粗手臂 / Steve)
                            </Label>
                          </div>
                          <div className="flex items-center space-x-2">
                            <RadioGroupItem value="slim" id="model-slim" />
                            <Label htmlFor="model-slim" className="cursor-pointer text-xs font-normal">
                              纤细 (3px 细手臂 / Alex)
                            </Label>
                          </div>
                        </RadioGroup>
                      </div>

                      <div className="text-[11px] text-muted-foreground leading-relaxed pt-0.5">
                        💡 启动器会在游戏启动时自动将皮肤封装为专用离线材质包（OfflineSkinPack）并自动注入激活，支持各版本单人与离线服务器环境。
                      </div>
                    </div>
                  )}
                </CardContent>
              )}
            </Card>
          </div>
        </TabsContent>

        {/* 游戏与启动 Tab */}
        <TabsContent value="launch" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2">
              <SettingsSection
                title="启动选项"
                icon={<SlidersHorizontal className="size-4" />}
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
                  <Field label="默认版本隔离">
                    <SettingsSelect<VersionIsolation>
                      value={settings.versionIsolation}
                      options={[
                        { value: "all", label: "隔离所有版本", description: "每个版本使用独立的 saves、mods 和配置文件夹" },
                        { value: "modded", label: "仅隔离模组包", description: "仅为包含模组加载器的版本提供独立文件夹" },
                        { value: "none", label: "不隔离", description: "所有版本共用根目录下的 saves、mods 和配置" },
                      ]}
                      onChange={(val) => onChange({ versionIsolation: val })}
                    />
                  </Field>

                  <Field label="游戏窗口标题">
                    <Input
                      placeholder="默认"
                      value={settings.windowTitle}
                      spellCheck={false}
                      className="h-9 bg-background/40 text-[12px]"
                      onChange={(e) => onChange({ windowTitle: e.target.value })}
                    />
                  </Field>

                  <Field label="自定义信息">
                    <Input
                      placeholder="PCL"
                      value={settings.customInfo}
                      spellCheck={false}
                      className="h-9 bg-background/40 text-[12px]"
                      onChange={(e) => onChange({ customInfo: e.target.value })}
                    />
                  </Field>

                  <Field label="启动器可见性">
                    <SettingsSelect<LauncherVisibility>
                      value={settings.launcherVisibility}
                      options={[
                        { value: "keep", label: "游戏启动后仍保持不变", description: "游戏运行期间启动器正常显示" },
                        { value: "hide", label: "游戏启动后隐藏启动器", description: "游戏启动后最小化隐藏，游戏退出后自动恢复" },
                        { value: "close", label: "游戏启动后关闭启动器", description: "游戏启动后直接退出启动器进程" },
                      ]}
                      onChange={(val) => onChange({ launcherVisibility: val })}
                    />
                  </Field>

                  <Field label="进程优先级">
                    <SettingsSelect<ProcessPriority>
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
                  </Field>

                  <Field label="窗口大小">
                    <SettingsSelect<WindowSizeMode>
                      value={settings.windowSize}
                      options={[
                        { value: "default", label: "默认", description: "使用游戏配置或标准分辨率" },
                        { value: "fullscreen", label: "全屏", description: "以全屏模式启动 Minecraft" },
                        { value: "custom", label: "自定义", description: "自定义指定的窗口长宽像素" },
                      ]}
                      onChange={(val) => {
                        onChange({
                          windowSize: val,
                          resolutionEnabled: val === "custom",
                        });
                      }}
                    />
                  </Field>
                </div>

                {settings.windowSize === "custom" && (
                  <div className="pt-3 border-t border-border/40 space-y-2">
                    <Label className="text-[11px] text-muted-foreground font-normal">
                      自定义窗口分辨率 (px)
                    </Label>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 max-w-sm">
                      <Input
                        type="number"
                        min={320}
                        max={7680}
                        value={settings.width}
                        className="h-8 bg-background/40 font-mono text-[11px]"
                        onChange={(e) => onChange({ width: Number(e.target.value) || 1280 })}
                      />
                      <span className="text-[11px] text-muted-foreground">×</span>
                      <Input
                        type="number"
                        min={240}
                        max={4320}
                        value={settings.height}
                        className="h-8 bg-background/40 font-mono text-[11px]"
                        onChange={(e) => onChange({ height: Number(e.target.value) || 720 })}
                      />
                    </div>
                  </div>
                )}
              </SettingsSection>
            </div>

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
              actions={
                <Button
                  variant="outline"
                  size="xs"
                  className="h-7 gap-1.5 px-2 text-[11px]"
                  onClick={() => void probeSources()}
                  disabled={probingSources}
                >
                  <RefreshCw className={cn("size-3", probingSources && "animate-spin")} />
                  {probingSources ? "测速中" : "测速"}
                </Button>
              }
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
                      <ProbeBadge
                        probe={probeFor("official_ap")}
                        fastest={fastestProbe?.source === "official_ap"}
                      />
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
                      <ProbeBadge
                        probe={probeFor("bmclapi")}
                        fastest={fastestProbe?.source === "bmclapi"}
                      />
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
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="text-[12px] font-medium text-foreground">
                      自定义镜像源
                    </span>
                    <ProbeBadge
                      probe={probeFor("custom")}
                      fastest={fastestProbe?.source === "custom"}
                    />
                  </div>
                </label>
              </RadioGroup>

              {sourceProbes ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-[11px]">
                  <span className="text-muted-foreground">
                    {fastestProbe ? (
                      <>
                        最快：
                        <span className="font-medium text-foreground">
                          {DOWNLOAD_SOURCE_LABELS[fastestProbe.source] ?? fastestProbe.source}
                        </span>
                        <span className="ml-1 font-mono text-primary">
                          {fastestProbe.latencyMs} ms
                        </span>
                      </>
                    ) : (
                      "所有下载源均不可用，请检查网络或代理"
                    )}
                  </span>
                  {fastestProbe &&
                  fastestProbe.source !== (settings.downloadSource || "official_ap") ? (
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6 px-2 text-[10.5px]"
                      onClick={() => onChange({ downloadSource: fastestProbe.source })}
                    >
                      使用最快源
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-[10.5px] leading-5 text-muted-foreground/60">
                  选择只改变优先顺序，失败时会自动回退到其它源；测速会请求各源的版本清单，仅比较首字节延迟。
                </p>
              )}

              {settings.downloadSource === "custom" ? (
                <Field label="自定义镜像 URL">
                  <Input
                    value={settings.customSourceUrl || ""}
                    placeholder="https://mirror.example.com（BMCLAPI 兼容地址）"
                    spellCheck={false}
                    className="h-8 bg-background/40 font-mono text-[11px]"
                    onChange={(e) => onChange({ customSourceUrl: e.target.value })}
                  />
                  {settings.customSourceUrl?.trim() &&
                  !/^https?:\/\//i.test(settings.customSourceUrl.trim()) ? (
                    <p className="text-[10px] text-destructive">需以 http:// 或 https:// 开头</p>
                  ) : null}
                </Field>
              ) : null}
            </SettingsSection>

            <SettingsSection
              title="基岩版第三方 API 下载源"
              icon={<Boxes className="size-4 text-primary" />}
            >
              <RadioGroup
                value={settings.bedrockApiSource || "endstone"}
                onValueChange={(val) => onChange({ bedrockApiSource: val as any })}
                className="gap-2"
              >
                <label
                  htmlFor="bedrock-src-endstone"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/25",
                    (!settings.bedrockApiSource || settings.bedrockApiSource === "endstone")
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="endstone" id="bedrock-src-endstone" className="mt-0.5" />
                  <div className="flex-1 text-xs">
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      <span>EndstoneMC 全版本 API (推荐)</span>
                      <Badge className="h-4 rounded-[4px] border-0 bg-primary/15 px-1.5 text-[9px] font-normal text-primary">
                        智能多 CDN 镜像
                      </Badge>
                    </div>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      由 Endstone 社区维护的基岩版完整版本数据库，支持所有正式版与测试版预览核心，并经由全球 CDN 加速。
                    </span>
                  </div>
                </label>

                <label
                  htmlFor="bedrock-src-mcserverjars"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/25",
                    settings.bedrockApiSource === "mcserverjars"
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="mcserverjars" id="bedrock-src-mcserverjars" className="mt-0.5" />
                  <div className="flex-1 text-xs">
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      <span>MCServerJars API</span>
                      <Badge className="h-4 rounded-[4px] border-0 bg-primary/15 px-1.5 text-[9px] font-normal text-primary">
                        第三方直连 API
                      </Badge>
                    </div>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      提供标准化 RESTful 下载端点，直接解析并分发最新与指定基岩版独立运行组件。
                    </span>
                  </div>
                </label>

                <label
                  htmlFor="bedrock-src-azure"
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/25",
                    settings.bedrockApiSource === "azure_mirror"
                      ? "border-primary/40 bg-primary/[0.04]"
                      : "border-border/60",
                  )}
                >
                  <RadioGroupItem value="azure_mirror" id="bedrock-src-azure" className="mt-0.5" />
                  <div className="flex-1 text-xs">
                    <div className="flex items-center gap-1.5 font-medium text-foreground">
                      <span>Azure CDN 官方边缘镜像</span>
                    </div>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      由微软 Azure 全球 CDN 分发加速节点提供的基岩版核心分发地址。
                    </span>
                  </div>
                </label>
              </RadioGroup>
            </SettingsSection>

            <SettingsSection
              title="多线程下载并发"
              icon={<Cpu className="size-4" />}
              className="lg:col-span-2"
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

                <p className="text-[10.5px] leading-5 text-muted-foreground/60">
                  线程越多分片越细，建议 8–16；网络不稳定或共享带宽时降到 4 更稳。单文件小于 1 MB 时仍走单线程。
                </p>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>

        {/* 个性化设置 Tab */}
        <TabsContent value="personalization" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="max-w-2xl space-y-4">
            {/* 主题配色与外观 */}
            <SettingsSection
              title="主题"
              icon={<Palette className="size-4" />}
            >
              {/* 明暗外观模式 */}
              <Field label="外观模式">
                <RadioGroup
                  value={settings.themeMode}
                  onValueChange={(val) => onChange({ themeMode: val as any })}
                  className="grid grid-cols-3 gap-2"
                >
                  <Label
                    htmlFor="theme-dark"
                    className={cn(
                      "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all",
                      settings.themeMode === "dark"
                        ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/40"
                        : "border-border/70 bg-background/40 hover:bg-muted/30 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <RadioGroupItem value="dark" id="theme-dark" className="sr-only" />
                    <Moon className="size-4" />
                    <span className="text-[11.5px] font-medium">深色模式</span>
                  </Label>
                  <Label
                    htmlFor="theme-light"
                    className={cn(
                      "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all",
                      settings.themeMode === "light"
                        ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/40"
                        : "border-border/70 bg-background/40 hover:bg-muted/30 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <RadioGroupItem value="light" id="theme-light" className="sr-only" />
                    <Sun className="size-4" />
                    <span className="text-[11.5px] font-medium">浅色模式</span>
                  </Label>
                  <Label
                    htmlFor="theme-system"
                    className={cn(
                      "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all",
                      settings.themeMode === "system"
                        ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/40"
                        : "border-border/70 bg-background/40 hover:bg-muted/30 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <RadioGroupItem value="system" id="theme-system" className="sr-only" />
                    <Monitor className="size-4" />
                    <span className="text-[11.5px] font-medium">跟随系统</span>
                  </Label>
                </RadioGroup>
              </Field>

              {/* 主题强调色：只保留一个自定义颜色，没有预设色卡 */}
              <Field label="强调色">
                <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/30 p-3">
                  <input
                    type="color"
                    value={settings.customThemeColor || DEFAULT_ACCENT}
                    onChange={(e) => onChange({ customThemeColor: e.target.value })}
                    className="size-8 cursor-pointer rounded border border-border/80 bg-transparent p-0.5"
                    aria-label="强调色"
                  />
                  <Input
                    value={settings.customThemeColor || DEFAULT_ACCENT}
                    onChange={(e) => onChange({ customThemeColor: e.target.value })}
                    placeholder={DEFAULT_ACCENT}
                    className="h-8 max-w-[160px] font-mono text-[11px]"
                  />
                </div>
              </Field>
            </SettingsSection>

            {/* 背景设置：只有无背景与一张自定义图片，不再提供预设壁纸 */}
            <SettingsSection
              title="背景与透明度"
              icon={<ImageIcon className="size-4" />}
            >
              <div className="grid grid-cols-2 gap-2">
                {([
                  { id: "default", label: "无背景", icon: Sparkles },
                  { id: "custom", label: "自定义图片", icon: ImageIcon },
                ] as const).map((option) => {
                  const selected = settings.backgroundType === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => onChange({ backgroundType: option.id })}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-[12px] transition-colors",
                        selected
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/70 bg-background/40 text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                      )}
                    >
                      <option.icon className="size-4" />
                      {option.label}
                      {selected ? <Check className="ml-auto size-3.5" /> : null}
                    </button>
                  );
                })}
              </div>

              {/* 自定义壁纸路径选择 */}
              {settings.backgroundType === "custom" && (
                <div className="space-y-2 rounded-lg border border-border/70 bg-background/30 p-3">
                  <Label className="text-[11px] text-muted-foreground">图片路径或链接</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={settings.customBackgroundPath || ""}
                      onChange={(e) => onChange({ customBackgroundPath: e.target.value })}
                      placeholder="本地图片路径 (如 D:\wallpaper.jpg) 或网络 URL"
                      className="h-8 flex-1 font-mono text-[11px]"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-[11px]"
                      onClick={() => void handlePickWallpaper()}
                    >
                      <FolderOpen className="size-3.5" />
                      浏览
                    </Button>
                    {settings.customBackgroundPath && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={() => onChange({ customBackgroundPath: "" })}
                      >
                        清空
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* 模糊度与遮罩透明度 */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-1">
                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/15 p-3">
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="text-muted-foreground">背景模糊度</span>
                    <span className="font-mono text-primary font-medium">{settings.backgroundBlur} px</span>
                  </div>
                  <Slider
                    min={0}
                    max={24}
                    step={1}
                    value={[settings.backgroundBlur]}
                    onValueChange={([val]) => onChange({ backgroundBlur: val })}
                  />
                </div>

                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/15 p-3">
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="text-muted-foreground">背景不透明度</span>
                    <span className="font-mono text-primary font-medium">{settings.backgroundOpacity}%</span>
                  </div>
                  <Slider
                    min={10}
                    max={100}
                    step={5}
                    value={[settings.backgroundOpacity]}
                    onValueChange={([val]) => onChange({ backgroundOpacity: val })}
                  />
                </div>

                {/* 全局面板透明度：与背景滑杆同一块面板，不再单独占一节 */}
                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/15 p-3 sm:col-span-2">
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="text-muted-foreground">界面不透明度</span>
                    <span className="font-mono text-primary font-medium">{settings.uiOpacity}%</span>
                  </div>
                  <Slider
                    min={30}
                    max={100}
                    step={5}
                    value={[settings.uiOpacity]}
                    onValueChange={([val]) => onChange({ uiOpacity: val })}
                  />
                  <p className="text-[10.5px] text-muted-foreground/70">
                    作用于卡片、侧边栏、标题栏、弹窗与输入框
                  </p>
                </div>
              </div>

              {/* 网格线与毛玻璃开关 */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/15 p-3">
                  <Label className="text-[12px] font-medium text-foreground">方块网格</Label>
                  <Switch
                    checked={settings.showWorldGrid}
                    onCheckedChange={(val) => onChange({ showWorldGrid: val })}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/15 p-3">
                  <Label className="text-[12px] font-medium text-foreground">磨砂玻璃</Label>
                  <Switch
                    checked={settings.enableMica}
                    onCheckedChange={(val) => onChange({ enableMica: val })}
                  />
                </div>
              </div>
            </SettingsSection>

            {/* 主页：PCL2 风格的可自定义主页区域 */}
            <SettingsSection title="主页" icon={<Newspaper className="size-4" />}>
              <Field label="主页内容">
                <RadioGroup
                  value={settings.homePageMode}
                  onValueChange={(val) => onChange({ homePageMode: val as HomePageMode })}
                  className="grid grid-cols-2 gap-2 sm:grid-cols-4"
                >
                  {HOME_PAGE_OPTIONS.map((option) => (
                    <Label
                      key={option.id}
                      htmlFor={`home-page-${option.id}`}
                      className={cn(
                        "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all",
                        settings.homePageMode === option.id
                          ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/40"
                          : "border-border/70 bg-background/40 text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                      )}
                    >
                      <RadioGroupItem
                        value={option.id}
                        id={`home-page-${option.id}`}
                        className="sr-only"
                      />
                      <option.icon className="size-4" />
                      <span className="text-[11.5px] font-medium">{option.label}</span>
                    </Label>
                  ))}
                </RadioGroup>
              </Field>

              <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                {settings.homePageMode === "preset"
                  ? "使用内置的“我的世界更新新闻”作为主页内容。"
                  : settings.homePageMode === "blank"
                    ? "主页区域保持空白，只保留右侧启动面板。"
                    : settings.homePageMode === "local"
                      ? "读取本地 HTML 文件，或直接使用 PCL2 的 .xaml 自定义主页；XAML 里的相对图片会按文件所在目录读取。"
                      : "从网络地址加载 HTML 或 PCL2 的 .xaml 主页，可设置自动刷新间隔保持内容最新。"}
              </p>

              <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                兼容 PCL2 自定义主页：支持 Grid / StackPanel / Border / TextBlock / Image
                等布局与内容组件，以及 MyCard、MyButton、MyHint、MyTextBox 等 PCL
                控件、{'{DynamicResource}'} 主题色与 EventType 动作（打开网页 / 复制文本 /
                刷新主页 / 启动游戏）。无法还原的元素会在主页标题旁标记。
              </p>

              {settings.homePageMode === "local" ? (
                <div className="space-y-2 rounded-lg border border-border/70 bg-background/30 p-3">                    <Label className="text-[11px] text-muted-foreground">
                      本地主页文件（HTML 或 PCL2 的 .xaml）
                    </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={settings.homePageLocalPath || ""}
                      onChange={(e) => onChange({ homePageLocalPath: e.target.value })}
                      placeholder="例如 D:\\PCL2\\Homepage.html"
                      className="h-8 flex-1 font-mono text-[11px]"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-[11px]"
                      onClick={() => void handlePickHomePage()}
                    >
                      <FolderOpen className="size-3.5" />
                      浏览
                    </Button>
                    {settings.homePageLocalPath ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={() => onChange({ homePageLocalPath: "" })}
                      >
                        清空
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {settings.homePageMode === "online" ? (
                <div className="space-y-3">
                  <div className="space-y-2 rounded-lg border border-border/70 bg-background/30 p-3">
                    <Label className="text-[11px] text-muted-foreground">主页地址</Label>
                    <Input
                      value={settings.homePageUrl || ""}
                      onChange={(e) => onChange({ homePageUrl: e.target.value })}
                      placeholder="https://example.com/homepage.html"
                      className="h-8 font-mono text-[11px]"
                    />
                  </div>
                  <Field label="自动刷新间隔">
                    <SettingsSelect
                      value={String(settings.homePageRefreshMinutes)}
                      onChange={(val) => onChange({ homePageRefreshMinutes: Number(val) })}
                      options={[
                        {
                          value: "0",
                          label: "仅手动刷新",
                          description: "打开主页或点击刷新时更新",
                        },
                        { value: "5", label: "每 5 分钟", description: "适合频繁更新的主页" },
                        { value: "15", label: "每 15 分钟", description: "较为均衡" },
                        { value: "30", label: "每 30 分钟", description: "节省流量" },
                        { value: "60", label: "每 60 分钟", description: "适合更新较慢的页面" },
                      ]}
                    />
                  </Field>
                </div>
              ) : null}
            </SettingsSection>

            {/* 界面排版与视觉定制 */}
            <SettingsSection
              title="排版与文案"
              icon={<Type className="size-4" />}
            >
              <Field label="界面字体风格">
                <SettingsSelect
                  value={settings.fontFamily}
                  onChange={(val) => onChange({ fontFamily: val as any })}
                  options={[
                    {
                      value: "default",
                      label: "现代极简 (Geist Sans)",
                      description: "专为代码与设计优化的现代极简无衬线字体（推荐）",
                    },
                    {
                      value: "pixel",
                      label: "复古像素 (Silkscreen)",
                      description: "经典的 8-bit Minecraft 像素风格字体",
                    },
                    {
                      value: "system",
                      label: "系统原生字体 (System UI)",
                      description: "跟随当前操作系统原生 UI 字体配置",
                    },
                    {
                      value: "serif",
                      label: "古典衬线 (Serif)",
                      description: "Georgia 与宋体回退，适合喜欢阅读感的排版",
                    },
                  ]}
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="界面字重">
                  <SettingsSelect
                    value={settings.fontWeight}
                    onChange={(val) => onChange({ fontWeight: val as any })}
                    options={[
                      {
                        value: "regular",
                        label: "常规字重 (400)",
                        description: "默认，轻盈通透",
                      },
                      {
                        value: "medium",
                        label: "中等字重 (500)",
                        description: "文字更厚重，小字号也更清晰",
                      },
                    ]}
                  />
                </Field>

                <Field label="字间距">
                  <SettingsSelect
                    value={settings.letterSpacing}
                    onChange={(val) => onChange({ letterSpacing: val as any })}
                    options={[
                      {
                        value: "tight",
                        label: "紧凑 (-0.01em)",
                        description: "信息密度更高，适合小屏",
                      },
                      {
                        value: "normal",
                        label: "标准",
                        description: "默认排版间距",
                      },
                      {
                        value: "wide",
                        label: "宽松 (+0.03em)",
                        description: "更舒缓，搭配像素字体尤其清晰",
                      },
                    ]}
                  />
                </Field>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/15 p-3">
                <Label className="text-[12px] font-medium text-foreground">平滑过渡动效</Label>
                <Switch
                  checked={settings.enableAnimation}
                  onCheckedChange={(val) => onChange({ enableAnimation: val })}
                />
              </div>

              <Field label="自定义启动器窗口标题 (留空使用默认名称)">
                <Input
                  value={settings.windowTitle || ""}
                  onChange={(e) => onChange({ windowTitle: e.target.value })}
                  placeholder="OPEN-SOURCE MINECRAFT LAUNCHER"
                  className="h-8 font-mono text-[11px]"
                />
              </Field>

              <Field label="启动器个性标语 / 座右铭签名">
                <Input
                  value={settings.customSlogan || ""}
                  onChange={(e) => onChange({ customSlogan: e.target.value })}
                  placeholder="自由探索，无限创造。"
                  className="h-8 text-[11px]"
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="首页状态文案 (留空使用默认)">
                  <Input
                    value={settings.statusText || ""}
                    onChange={(e) => onChange({ statusText: e.target.value })}
                    placeholder="准备就绪，随时出发"
                    maxLength={40}
                    className="h-8 text-[11px]"
                  />
                </Field>

                <Field label="启动按钮文案 (留空使用默认)">
                  <Input
                    value={settings.launchButtonText || ""}
                    onChange={(e) => onChange({ launchButtonText: e.target.value })}
                    placeholder="启动游戏 / 启动基岩版"
                    maxLength={20}
                    className="h-8 text-[11px]"
                  />
                </Field>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>

        {/* 关于启动器 Tab */}
        <TabsContent value="about" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="max-w-2xl space-y-4">
            <SettingsSection
              title="系统架构与运行环境"
              icon={<Info className="size-4" />}
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <span className="text-[11.5px] text-muted-foreground">名称与版本</span>
                  <span className="font-mono text-[12px] font-medium text-foreground">
                    Open-source-Minecraft-launcher v{systemInfo?.launcherVersion ?? "0.0.7"}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <span className="text-[11.5px] text-muted-foreground">开源协议</span>
                  <Badge variant="outline" className="border-primary/35 bg-primary/10 text-primary font-mono text-[10.5px]">
                    MIT License
                  </Badge>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <span className="text-[11.5px] text-muted-foreground">系统与架构</span>
                  <span className="font-mono text-[11.5px] text-foreground">
                    {systemInfo ? `${systemInfo.os} · ${systemInfo.arch}` : "正在读取…"}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/50 bg-muted/15 p-2.5">
                  <span className="text-[11.5px] text-muted-foreground">运行模式</span>
                  <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                    {isDesktop ? "Electron 桌面版" : "Web 预览"}
                  </Badge>
                </div>
              </div>
            </SettingsSection>

            {/* 开源项目：每个条目都可在系统浏览器打开主页 */}
            <SettingsSection title="开源项目" icon={<Boxes className="size-4" />}>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {CORE_PROJECTS.map((entry) => (
                  <CreditRow key={entry.name} entry={entry} />
                ))}
              </div>
            </SettingsSection>

            <SettingsSection title="数据与镜像来源" icon={<Globe className="size-4" />}>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {SOURCE_PROJECTS.map((entry) => (
                  <CreditRow key={entry.name} entry={entry} />
                ))}
              </div>
            </SettingsSection>
          </div>
        </TabsContent>
      </Tabs>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-4 text-[10px] text-muted-foreground/60">
        <span className="font-mono">
          Open-source-Minecraft-launcher {systemInfo?.launcherVersion ?? "0.0.7"}
        </span>
        <span>MIT License</span>
      </footer>
    </div>
  );
}
