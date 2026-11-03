import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Languages,
  MessageSquareWarning,
  Monitor,
  Moon,
  Network,
  Newspaper,
  Palette,
  Plus,
  Puzzle,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Sparkles,
  SquareDashed,
  Sun,
  Terminal,
  Trash2,
  Type,
  Upload,
  UserRound,
  Zap,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "cn";
import {
  checkAppUpdate,
  configureDeveloperOptions,
  downloadAppUpdate,
  getDeveloperOptions,
  getElectronChromiumProfile,
  installAppUpdate,
  isDesktop,
  openExternalUrl,
  probeDownloadSources,
  probeMultiplayerLatency,
  subscribe,
} from "../lib/backend";
import { formatBytes, formatDate, joinPath, shortPath } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { DEFAULT_ACCENT } from "../lib/theme";
import {
  DEFAULT_PUBLIC_SERVER,
  OFFICIAL_PUBLIC_SERVERS,
  loadCustomServers,
  saveCustomServers,
  loadCachedCommunityServers,
  syncCommunityRelayNodes,
  parseServerUri,
  pickFastestRelayServer,
  loadCachedServerLatencies,
  saveCachedServerLatencies,
  batchProbeMultiplayerLatencies,
} from "../lib/multiplayer";
import type {
  AppUpdateDownloadResult,
  AppUpdateInfo,
  AppUpdateProgress,
  EasyTierPublicServer,
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
  DeveloperOptionsState,
  ElectronChromiumProfile,
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
import { Progress } from "@/components/ui/progress";
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

const FEEDBACK_URL =
  "https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/issues";

const LANGUAGE_OPTIONS: Array<{ value: LauncherSettings["language"]; label: string }> = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en-US", label: "English" },
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
  initialTab?: SettingsTab;
}

type SettingsTab =
  | "account"
  | "launch"
  | "download"
  | "personalization"
  | "about";

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
  initialTab,
}: SettingsViewProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab || "account");
  const lastInitialTabRef = useRef<SettingsTab | undefined>(initialTab);

  useEffect(() => {
    // 仅在外部真正切换传入新的 initialTab 时更新，避免内部设置修改导致反复重置与刷新
    if (initialTab && initialTab !== lastInitialTabRef.current) {
      lastInitialTabRef.current = initialTab;
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  const [scanning, setScanning] = useState(false);
  const [rootDraft, setRootDraft] = useState(settings.gameRoot);
  const [skinCollapsed, setSkinCollapsed] = useState(false);
  const [sourceProbes, setSourceProbes] = useState<DownloadSourceProbe[] | null>(null);
  const [probingSources, setProbingSources] = useState(false);
  const [chromiumProfile, setChromiumProfile] = useState<ElectronChromiumProfile | null>(null);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateProgress | null>(null);
  const [updateDownload, setUpdateDownload] =
    useState<AppUpdateDownloadResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [developerConsole, setDeveloperConsole] = useState<DeveloperOptionsState | null>(null);
  const updateAutoChecked = useRef(false);

  // EasyTier 协助节点打洞与多线路中继
  const [customServers, setCustomServers] = useState<string[]>(loadCustomServers);
  const [syncedServers, setSyncedServers] = useState<EasyTierPublicServer[]>(loadCachedCommunityServers);
  const [syncingCommunity, setSyncingCommunity] = useState(false);
  const [serverGroupTab, setServerGroupTab] = useState<string>("all");
  // 优先从本地持久化缓存读取测速结果，杜绝刷新后测速数据归空的问题
  const [serverLatencies, setServerLatencies] = useState<Record<string, number | null>>(
    () => loadCachedServerLatencies().latencies,
  );
  const [testingLatency, setTestingLatency] = useState(false);
  const [newCustomInput, setNewCustomInput] = useState("");
  const [testingCustom, setTestingCustom] = useState(false);
  const [customTestResult, setCustomTestResult] = useState<number | null | undefined>(undefined);
  const autoProbedRef = useRef(false);

  const allRelayServers = useMemo<EasyTierPublicServer[]>(() => {
    const list: EasyTierPublicServer[] = [...OFFICIAL_PUBLIC_SERVERS];
    const seenUris = new Set(list.map((s) => s.uri));

    syncedServers.forEach((synced) => {
      if (!seenUris.has(synced.uri)) {
        seenUris.add(synced.uri);
        list.push(synced);
      }
    });

    customServers.forEach((uri, idx) => {
      if (!seenUris.has(uri)) {
        seenUris.add(uri);
        list.push({
          id: `custom-${idx}-${uri}`,
          name: `自定义节点 ${idx + 1}`,
          uri,
          region: "用户自建",
          description: "第三方或自建 EasyTier 协助节点（支持 P2P 打洞与中继）",
          group: "自建节点",
          isCustom: true,
        });
      }
    });
    return list;
  }, [syncedServers, customServers]);

  const autoFastestServer = useMemo(() => {
    return pickFastestRelayServer(allRelayServers, serverLatencies, DEFAULT_PUBLIC_SERVER);
  }, [allRelayServers, serverLatencies]);

  const filteredRelayServers = useMemo(() => {
    if (serverGroupTab === "all") return allRelayServers;
    if (serverGroupTab === "official") return allRelayServers.filter((s) => s.group === "官方推荐");
    if (serverGroupTab === "community") return allRelayServers.filter((s) => s.group === "国内社区");
    if (serverGroupTab === "crossborder") return allRelayServers.filter((s) => s.group === "海外跨境");
    if (serverGroupTab === "custom") return allRelayServers.filter((s) => s.isCustom);
    return allRelayServers;
  }, [allRelayServers, serverGroupTab]);

  // 首次进入设置时，若本地测速缓存为空或已过期，在后台静默发起一次分批测速更新优选节点
  useEffect(() => {
    if (autoProbedRef.current || allRelayServers.length === 0) return;
    const cached = loadCachedServerLatencies();
    if (!cached.isFresh || Object.keys(cached.latencies).length === 0) {
      autoProbedRef.current = true;
      void batchProbeMultiplayerLatencies(allRelayServers, 4, probeMultiplayerLatency)
        .then((fresh) => {
          setServerLatencies(fresh);
        })
        .catch(() => {});
    }
  }, [allRelayServers]);

  const handleTestAllServers = async () => {
    setTestingLatency(true);
    try {
      const results = await batchProbeMultiplayerLatencies(
        allRelayServers,
        4,
        probeMultiplayerLatency,
      );
      setServerLatencies(results);
      const fastest = pickFastestRelayServer(allRelayServers, results, DEFAULT_PUBLIC_SERVER);
      const lat = results[fastest];
      onNotify(
        "info",
        "测速完成",
        `已对 ${allRelayServers.length} 个中继节点完成分批延迟检测${lat != null ? `，当前最优节点：${fastest} (${lat} ms)` : ""}`,
      );
    } catch {
      onNotify("error", "测速异常", "网络探测遇到问题，请检查网络连接");
    } finally {
      setTestingLatency(false);
    }
  };

  const handleSyncCommunityNodes = async () => {
    setSyncingCommunity(true);
    try {
      const res = await syncCommunityRelayNodes();
      setSyncedServers(res.servers);
      onNotify("success", "已从 info.qtet.cn 同步最新 Relay 节点", `已载入 ${res.count} 个社区节点`);
    } catch {
      onNotify("error", "同步社区节点失败", "请检查网络连接");
    } finally {
      setSyncingCommunity(false);
    }
  };

  const handleTestCustomNodeInput = async () => {
    const parsed = parseServerUri(newCustomInput);
    if (!parsed) {
      onNotify("error", "节点地址格式无效", "支持 tcp://主机:端口 或 udp://主机:端口（例如 tcp://vps.com:11010）");
      return;
    }
    const uri = parsed.full;
    setTestingCustom(true);
    setCustomTestResult(undefined);
    try {
      const probe = await probeMultiplayerLatency(uri);
      const isUdp = uri.startsWith("udp://");
      const reachable = probe.reachable;
      const lat = reachable ? probe.latencyMs : null;
      setCustomTestResult(lat);
      if (reachable === true) {
        onNotify("success", `TCP 节点已连通: ${lat != null ? `${lat} ms` : "就绪"}`);
      } else if (reachable === null || isUdp) {
        onNotify("success", "UDP 节点格式正确", "UDP 协议无需 TCP 预检，启动后将自动建立 UDP 通道。");
      } else {
        onNotify("error", "连接超时", "请确认服务器地址、端口及防火墙是否放行。");
      }
    } catch (err) {
      setCustomTestResult(null);
      onNotify("error", "测试失败", String(err));
    } finally {
      setTestingCustom(false);
    }
  };

  const handleAddCustomNode = () => {
    const parsed = parseServerUri(newCustomInput);
    if (!parsed) {
      onNotify("error", "节点地址格式无效", "支持 tcp://主机:端口 或 udp://主机:端口（例如 tcp://vps.com:11010）");
      return;
    }
    const uri = parsed.full;
    let nextList = customServers;
    if (!customServers.includes(uri)) {
      nextList = [...customServers, uri];
      setCustomServers(nextList);
      saveCustomServers(nextList);
    }
    setNewCustomInput("");
    setCustomTestResult(undefined);
    if (settings.easyTierRelayMode === "manual") {
      onChange({ easyTierSelectedNode: uri });
    }
    onNotify("success", "已成功添加自定义协助节点", uri);

    void probeMultiplayerLatency(uri).then((probe) => {
      const lat = probe.reachable ? probe.latencyMs : null;
      setServerLatencies((prev) => {
        const next = { ...prev, [uri]: lat };
        saveCachedServerLatencies(next);
        return next;
      });
    });
  };

  const handleDeleteCustomNode = (uri: string) => {
    const nextList = customServers.filter((item) => item !== uri);
    setCustomServers(nextList);
    saveCustomServers(nextList);
    if (settings.easyTierSelectedNode === uri) {
      onChange({ easyTierSelectedNode: DEFAULT_PUBLIC_SERVER });
    }
    onNotify("info", "已移除该自定义节点");
  };

  useEffect(() => {
    if (isDesktop) {
      void getElectronChromiumProfile().then(setChromiumProfile);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "about" || !isDesktop) return;
    void getDeveloperOptions().then(setDeveloperConsole).catch(() => undefined);
  }, [activeTab, settings.enableDevTools, settings.showBackendConsole]);

  const openBackendConsole = async () => {
    if (!settings.showBackendConsole) {
      onNotify("info", "后台日志未启用", "请先打开「后台进程日志」开关。");
      return;
    }
    try {
      const state = await configureDeveloperOptions({
        devToolsEnabled: settings.enableDevTools,
        backendConsoleEnabled: true,
        openConsole: true,
      });
      setDeveloperConsole(state);
      if (state?.consoleOpen) {
        onNotify("success", "已打开后台日志窗口", state.logPath ?? undefined);
      }
    } catch (error) {
      onNotify("error", "无法打开后台日志窗口", String(error));
    }
  };
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

  const handleCheckUpdate = async () => {
    if (updateChecking || updateDownloading) return;
    setUpdateChecking(true);
    setUpdateError(null);
    try {
      const info = await checkAppUpdate();
      setUpdateInfo(info);
      setUpdateDownload(
        info.cachedPath
          ? {
              path: info.cachedPath,
              bytes: info.asset?.size ?? 0,
              fileName: info.asset?.name ?? "",
            }
          : null,
      );
    } catch (error) {
      setUpdateError(String(error));
    } finally {
      setUpdateChecking(false);
    }
  };

  const handleDownloadUpdate = async (force = false) => {
    const asset = updateInfo?.asset;
    if (!asset || updateDownloading) return;
    setUpdateDownloading(true);
    setUpdateError(null);
    setUpdateProgress({
      received: 0,
      total: asset.size,
      percent: 0,
      fileName: asset.name,
    });
    try {
      setUpdateDownload(await downloadAppUpdate(asset, force));
    } catch (error) {
      setUpdateError(String(error));
    } finally {
      setUpdateDownloading(false);
      setUpdateProgress(null);
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateDownload || updateInstalling) return;
    setUpdateInstalling(true);
    setUpdateError(null);
    try {
      const result = await installAppUpdate(updateDownload.path);
      onNotify("success", "更新已准备就绪", result.message);
    } catch (error) {
      setUpdateError(String(error));
      onNotify("error", "无法安装更新", String(error));
    } finally {
      setUpdateInstalling(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    void subscribe("update:progress", (progress) => {
      if (!disposed) setUpdateProgress(progress);
    })
      .then((off) => {
        if (disposed) off();
        else unsubscribe = off;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "about" || updateAutoChecked.current) return;
    updateAutoChecked.current = true;
    void handleCheckUpdate();
  }, [activeTab]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("设置")}
        actions={
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Check className="size-3.5 text-primary" />
            {t("已自动保存")}
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
              className="gap-2 px-3.5 py-1.5 text-[12px] text-muted-foreground transition-all hover:text-foreground data-[state=active]:border data-[state=active]:border-primary/50 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:font-semibold data-[state=active]:shadow-xs"
            >
              <UserRound className="size-3.5 transition-colors" />
              {t("账户设置")}
            </TabsTrigger>
            <TabsTrigger
              value="launch"
              className="gap-2 px-3.5 py-1.5 text-[12px] text-muted-foreground transition-all hover:text-foreground data-[state=active]:border data-[state=active]:border-primary/50 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:font-semibold data-[state=active]:shadow-xs"
            >
              <Gauge className="size-3.5 transition-colors" />
              {t("游戏与启动")}
            </TabsTrigger>
            <TabsTrigger
              value="download"
              className="gap-2 px-3.5 py-1.5 text-[12px] text-muted-foreground transition-all hover:text-foreground data-[state=active]:border data-[state=active]:border-primary/50 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:font-semibold data-[state=active]:shadow-xs"
            >
              <Cpu className="size-3.5 transition-colors" />
              {t("下载与网络")}
            </TabsTrigger>
            <TabsTrigger
              value="personalization"
              className="gap-2 px-3.5 py-1.5 text-[12px] text-muted-foreground transition-all hover:text-foreground data-[state=active]:border data-[state=active]:border-primary/50 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:font-semibold data-[state=active]:shadow-xs"
            >
              <Sparkles className="size-3.5 transition-colors" />
              {t("个性化")}
            </TabsTrigger>
            <TabsTrigger
              value="about"
              className="gap-2 px-3.5 py-1.5 text-[12px] text-muted-foreground transition-all hover:text-foreground data-[state=active]:border data-[state=active]:border-primary/50 data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:font-semibold data-[state=active]:shadow-xs"
            >
              <Info className="size-3.5 transition-colors" />
              {t("关于启动器")}
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
                        {java.is64Bit !== undefined && (
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[8.5px] px-1 py-0 h-3.5",
                              java.is64Bit
                                ? "border-emerald-500/30 text-emerald-500"
                                : "border-amber-500/40 text-amber-500",
                            )}
                          >
                            {java.is64Bit ? "64 位" : "32 位 (限1G)"}
                          </Badge>
                        )}
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

            {/* 网络设置：EasyTier 协助节点打洞与多线路中继 */}
            <SettingsSection
              title="EasyTier 协助节点打洞与多线路中继（网络设置）"
              icon={<Network className="size-4 text-primary" />}
              className="lg:col-span-2"
              actions={
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 px-2 text-[11px]"
                    disabled={syncingCommunity}
                    onClick={handleSyncCommunityNodes}
                    title="从 info.qtet.cn 社区监控在线同步最新上线的中继节点"
                  >
                    <RefreshCw className={cn("size-3", syncingCommunity && "animate-spin")} />
                    {syncingCommunity ? "同步中" : "同步社区最新"}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-7 gap-1 px-2 text-[11px]"
                    disabled={testingLatency}
                    onClick={handleTestAllServers}
                  >
                    {testingLatency ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : (
                      <Zap className="size-3 text-amber-400" />
                    )}
                    {testingLatency ? "测速中" : "全量测速"}
                  </Button>
                </div>
              }
            >
              <div className="space-y-4">
                {/* 模式选择：自动选择中继节点（默认） vs 手动选择 */}
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <Label className="text-[11px] font-medium text-foreground">
                      中继节点选择模式
                    </Label>
                    <span className="text-[10px] text-muted-foreground">
                      联机房间打洞与多线路中继使用的节点策略
                    </span>
                  </div>

                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {/* 自动选择模式卡片 */}
                    <div
                      onClick={() => {
                        onChange({ easyTierRelayMode: "auto" });
                        onNotify("info", "已设为自动选择中继节点", "将根据网络延迟动态优选最佳协助节点。");
                      }}
                      className={cn(
                        "relative flex cursor-pointer flex-col justify-between rounded-xl border p-3.5 transition-all select-none",
                        (settings.easyTierRelayMode || "auto") === "auto"
                          ? "border-primary bg-primary/[0.06] ring-1 ring-primary/40 shadow-xs"
                          : "border-border/60 bg-muted/20 hover:border-border hover:bg-muted/30",
                      )}
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Sparkles className="size-4 text-primary" />
                            <span className="text-[12.5px] font-semibold text-foreground">
                              自动选择中继节点
                            </span>
                            <Badge className="h-4 border-0 bg-primary/20 px-1.5 text-[9px] font-medium text-primary">
                              默认 · 推荐
                            </Badge>
                          </div>
                          <span
                            className={cn(
                              "flex size-4 items-center justify-center rounded-full border transition-colors",
                              (settings.easyTierRelayMode || "auto") === "auto"
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/30 bg-transparent",
                            )}
                          >
                            {(settings.easyTierRelayMode || "auto") === "auto" ? (
                              <Check className="size-2.5 stroke-[3]" />
                            ) : null}
                          </span>
                        </div>
                        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                          根据全网各节点测速结果，自动优选延迟最低、连接质量最稳定的协助打洞与多线路中继节点。
                        </p>
                      </div>

                      <div className="mt-2.5 flex items-center justify-between rounded-lg border border-border/50 bg-background/50 px-2.5 py-1.5 text-[10.5px]">
                        <span className="text-muted-foreground">当前优选节点：</span>
                        <code className="min-w-0 max-w-[200px] truncate font-mono font-medium text-foreground">
                          {autoFastestServer}
                        </code>
                        {serverLatencies[autoFastestServer] != null ? (
                          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-emerald-400">
                            {serverLatencies[autoFastestServer]} ms
                          </span>
                        ) : (
                          <span className="font-mono text-[9.5px] text-muted-foreground">就绪</span>
                        )}
                      </div>
                    </div>

                    {/* 手动选择模式卡片 */}
                    <div
                      onClick={() => {
                        onChange({ easyTierRelayMode: "manual" });
                        onNotify("info", "已设为手动选择中继节点", "请在下方列表中指定固定的中继节点。");
                      }}
                      className={cn(
                        "relative flex cursor-pointer flex-col justify-between rounded-xl border p-3.5 transition-all select-none",
                        settings.easyTierRelayMode === "manual"
                          ? "border-primary bg-primary/[0.06] ring-1 ring-primary/40 shadow-xs"
                          : "border-border/60 bg-muted/20 hover:border-border hover:bg-muted/30",
                      )}
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Server className="size-4 text-primary" />
                            <span className="text-[12.5px] font-semibold text-foreground">
                              手动指定中继节点
                            </span>
                          </div>
                          <span
                            className={cn(
                              "flex size-4 items-center justify-center rounded-full border transition-colors",
                              settings.easyTierRelayMode === "manual"
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/30 bg-transparent",
                            )}
                          >
                            {settings.easyTierRelayMode === "manual" ? (
                              <Check className="size-2.5 stroke-[3]" />
                            ) : null}
                          </span>
                        </div>
                        <p className="text-[10.5px] leading-relaxed text-muted-foreground">
                          锁定指定的官方节点、国内社区节点，或直接连接你自定义部署的自建 EasyTier 私有节点。
                        </p>
                      </div>

                      <div className="mt-2.5 flex items-center justify-between rounded-lg border border-border/50 bg-background/50 px-2.5 py-1.5 text-[10.5px]">
                        <span className="text-muted-foreground">当前指定节点：</span>
                        <code className="min-w-0 max-w-[200px] truncate font-mono font-medium text-foreground">
                          {settings.easyTierSelectedNode || DEFAULT_PUBLIC_SERVER}
                        </code>
                        {serverLatencies[settings.easyTierSelectedNode || DEFAULT_PUBLIC_SERVER] != null ? (
                          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-emerald-400">
                            {serverLatencies[settings.easyTierSelectedNode || DEFAULT_PUBLIC_SERVER]} ms
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 分类筛选标签 */}
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 pb-2">
                  {[
                    { id: "all", label: "全部节点", count: allRelayServers.length },
                    {
                      id: "official",
                      label: "官方推荐",
                      count: allRelayServers.filter((s) => s.group === "官方推荐").length,
                    },
                    {
                      id: "community",
                      label: "国内社区",
                      count: allRelayServers.filter((s) => s.group === "国内社区").length,
                    },
                    {
                      id: "crossborder",
                      label: "海外跨境",
                      count: allRelayServers.filter((s) => s.group === "海外跨境").length,
                    },
                    ...(allRelayServers.some((s) => s.isCustom)
                      ? [
                          {
                            id: "custom",
                            label: "我的自建",
                            count: allRelayServers.filter((s) => s.isCustom).length,
                          },
                        ]
                      : []),
                  ].map((tab) => {
                    const active = serverGroupTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setServerGroupTab(tab.id)}
                        className={cn(
                          "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors select-none",
                          active
                            ? "bg-primary/15 text-primary shadow-xs"
                            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                        )}
                      >
                        <span>{tab.label}</span>
                        <span
                          className={cn(
                            "rounded-full px-1 text-[9.5px]",
                            active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground",
                          )}
                        >
                          {tab.count}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* 节点列表卡片网格 */}
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {filteredRelayServers.map((srv) => {
                    const isManualSelected =
                      settings.easyTierRelayMode === "manual" &&
                      (settings.easyTierSelectedNode || DEFAULT_PUBLIC_SERVER) === srv.uri;
                    const isAutoSelected =
                      (settings.easyTierRelayMode || "auto") === "auto" &&
                      autoFastestServer === srv.uri;
                    const isChosen = isManualSelected || isAutoSelected;
                    const lat = serverLatencies[srv.uri];
                    const schemeMatch = srv.uri.match(/^([a-zA-Z0-9]+):\/\//);
                    const scheme = schemeMatch ? schemeMatch[1].toUpperCase() : "TCP";
                    const schemeBadgeClass =
                      scheme === "UDP"
                        ? "border-violet-500/30 bg-violet-500/10 text-violet-400"
                        : scheme === "WSS"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                          : scheme === "TXT"
                            ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                            : "border-sky-500/30 bg-sky-500/10 text-sky-400";

                    return (
                      <div
                        key={srv.id}
                        onClick={() => {
                          onChange({
                            easyTierRelayMode: "manual",
                            easyTierSelectedNode: srv.uri,
                          });
                          onNotify("success", "已手动选定中继协助节点", srv.uri);
                        }}
                        className={cn(
                          "relative flex flex-col justify-between rounded-xl border p-3.5 text-left transition-all cursor-pointer select-none",
                          isChosen
                            ? "border-primary bg-card ring-1 ring-primary/50 shadow-sm"
                            : "border-border/70 bg-card/40 hover:border-border hover:bg-card/70",
                        )}
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                className={cn(
                                  "shrink-0 rounded px-1 py-0.2 font-mono text-[9px] font-semibold border",
                                  schemeBadgeClass,
                                )}
                              >
                                {scheme}
                              </span>
                              <span className="font-semibold text-[12px] text-foreground truncate">
                                {srv.name}
                              </span>
                              {srv.isCustom ? (
                                <span className="shrink-0 rounded border border-primary/30 bg-primary/10 px-1 py-0.2 text-[9px] font-medium text-primary">
                                  自建
                                </span>
                              ) : null}
                              {isAutoSelected && (
                                <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.2 text-[9px] font-medium text-amber-400">
                                  自动优选
                                </span>
                              )}
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {testingLatency ? (
                                <span className="inline-flex items-center gap-1 font-mono text-[9.5px] text-muted-foreground">
                                  <LoaderCircle className="size-2.5 animate-spin" />
                                  测速
                                </span>
                              ) : lat !== undefined ? (
                                <span
                                  className={cn(
                                    "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-medium",
                                    lat != null
                                      ? lat < 80
                                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                                        : lat < 180
                                          ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                                          : "border-rose-500/30 bg-rose-500/10 text-rose-400"
                                      : srv.uri.startsWith("udp://")
                                        ? "border-violet-500/30 bg-violet-500/10 text-violet-400"
                                        : srv.uri.startsWith("txt://")
                                          ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                                          : "border-destructive/30 bg-destructive/10 text-destructive",
                                  )}
                                >
                                  {lat != null
                                    ? `${lat} ms`
                                    : srv.uri.startsWith("udp://")
                                      ? "UDP 就绪"
                                      : srv.uri.startsWith("txt://")
                                        ? "DNS 动态"
                                        : "超时"}
                                </span>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="h-4 px-1.5 font-normal text-[9px] text-muted-foreground"
                                >
                                  {srv.region}
                                </Badge>
                              )}

                              <span
                                className={cn(
                                  "flex size-4 items-center justify-center rounded-full border transition-colors",
                                  isChosen
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-muted-foreground/30 bg-transparent",
                                )}
                              >
                                {isChosen ? <Check className="size-2.5 stroke-[3]" /> : null}
                              </span>
                            </div>
                          </div>

                          {/* URI 地址栏 */}
                          <div className="mt-2.5 flex items-center justify-between gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 font-mono text-[10.5px]">
                            <code className="min-w-0 flex-1 truncate font-medium text-foreground">
                              {srv.uri}
                            </code>
                            {srv.isCustom ? (
                              <button
                                type="button"
                                className="p-0.5 text-muted-foreground/60 transition-colors hover:text-destructive"
                                title="删除此自定义节点"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteCustomNode(srv.uri);
                                }}
                              >
                                <Trash2 className="size-3" />
                              </button>
                            ) : null}
                          </div>

                          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                            {srv.description}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between px-1 text-[9.5px] text-muted-foreground/80">
                  <span>共载入 {allRelayServers.length} 个 EasyTier 协助中继节点</span>
                  <span>数据源：info.qtet.cn 社区监控 & EasyTier 官方</span>
                </div>

                {/* 自定义节点输入专区 */}
                <div className="rounded-xl border border-border/60 bg-background/40 p-3.5">
                  <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-foreground">
                    <Plus className="size-3.5 text-primary" />
                    <span>添加自定义 / 自建 EasyTier 协助打洞节点</span>
                  </div>
                  <p className="mt-1 text-[10.5px] text-muted-foreground">
                    支持输入你自己或社区搭建的 EasyTier 协助节点，支持 TCP / UDP 协议通道。
                  </p>
                  <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <Input
                        value={newCustomInput}
                        onChange={(e) => {
                          setNewCustomInput(e.target.value);
                          setCustomTestResult(undefined);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAddCustomNode();
                        }}
                        placeholder="tcp://your-vps.com:11010 或 udp://..."
                        className="h-8 font-mono text-[11px]"
                      />
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 px-2.5 text-[11px]"
                        disabled={!newCustomInput.trim() || testingCustom}
                        onClick={handleTestCustomNodeInput}
                      >
                        {testingCustom ? (
                          <LoaderCircle className="size-3 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        {customTestResult !== undefined ? (
                          customTestResult != null ? (
                            <span className="font-mono text-emerald-400">
                              {customTestResult} ms
                            </span>
                          ) : (
                            <span className="text-destructive">超时</span>
                          )
                        ) : (
                          "测速"
                        )}
                      </Button>
                      <Button
                        size="sm"
                        className="h-8 gap-1 px-3 text-[11px] font-medium"
                        disabled={!newCustomInput.trim()}
                        onClick={handleAddCustomNode}
                      >
                        <Plus className="size-3.5" />
                        添加节点
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </SettingsSection>
          </div>
        </TabsContent>

        {/* 个性化设置 Tab */}
        <TabsContent value="personalization" className="mt-0 space-y-4 focus-visible:outline-none">
          <div className="max-w-2xl space-y-4">
            {/* 语言与地区：放在个性化首项，切换后整个启动器立即跟随 */}
            <SettingsSection
              title={t("语言与地区")}
              icon={<Languages className="size-4" />}
            >
              <Field label={t("界面语言")}>
                <RadioGroup
                  value={settings.language}
                  onValueChange={(val) => onChange({ language: val as LauncherSettings["language"] })}
                  className="grid grid-cols-2 gap-2"
                >
                  {LANGUAGE_OPTIONS.map((option) => {
                    const selected = settings.language === option.value;
                    return (
                      <Label
                        key={option.value}
                        htmlFor={`language-${option.value}`}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2.5 text-[12px] transition-all",
                          selected
                            ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/40"
                            : "border-border/70 bg-background/40 text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                        )}
                      >
                        <RadioGroupItem
                          value={option.value}
                          id={`language-${option.value}`}
                          className="sr-only"
                        />
                        <span className="font-medium">{option.label}</span>
                        {selected ? <Check className="ml-auto size-3.5" /> : null}
                      </Label>
                    );
                  })}
                </RadioGroup>
              </Field>
              <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                {t("切换启动器界面语言，保存后立即生效。")}
              </p>
              <p className="text-[10.5px] leading-5 text-muted-foreground/60">
                {t(
                  "English 界面包目前覆盖启动器框架、主页与个性化设置，其余页面会继续回退到中文。",
                )}
              </p>
            </SettingsSection>

            {/* 主题配色与外观 */}
            <SettingsSection
              title={t("主题")}
              icon={<Palette className="size-4" />}
            >
              {/* 明暗外观模式 */}
              <Field label={t("外观模式")}>
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
                    <span className="text-[11.5px] font-medium">{t("深色模式")}</span>
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
                    <span className="text-[11.5px] font-medium">{t("浅色模式")}</span>
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
                    <span className="text-[11.5px] font-medium">{t("跟随系统")}</span>
                  </Label>
                </RadioGroup>
              </Field>

              {/* 主题强调色：只保留一个自定义颜色，没有预设色卡 */}
              <Field label={t("强调色")}>
                <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-background/30 p-3">
                  <input
                    type="color"
                    value={settings.customThemeColor || DEFAULT_ACCENT}
                    onChange={(e) => onChange({ customThemeColor: e.target.value })}
                    className="size-8 cursor-pointer rounded border border-border/80 bg-transparent p-0.5"
                    aria-label={t("强调色")}
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
              title={t("背景与透明度")}
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
                      {t(option.label)}
                      {selected ? <Check className="ml-auto size-3.5" /> : null}
                    </button>
                  );
                })}
              </div>

              {/* 自定义壁纸路径选择 */}
              {settings.backgroundType === "custom" && (
                <div className="space-y-2 rounded-lg border border-border/70 bg-background/30 p-3">
                  <Label className="text-[11px] text-muted-foreground">{t("图片路径或链接")}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={settings.customBackgroundPath || ""}
                      onChange={(e) => onChange({ customBackgroundPath: e.target.value })}
                      placeholder={t("本地图片路径 (如 D:\\wallpaper.jpg) 或网络 URL")}
                      className="h-8 flex-1 font-mono text-[11px]"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-[11px]"
                      onClick={() => void handlePickWallpaper()}
                    >
                      <FolderOpen className="size-3.5" />
                      {t("浏览")}
                    </Button>
                    {settings.customBackgroundPath && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={() => onChange({ customBackgroundPath: "" })}
                      >
                        {t("清空")}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* 模糊度与遮罩透明度 */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 pt-1">
                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/15 p-3">
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="text-muted-foreground">{t("背景模糊度")}</span>
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
                    <span className="text-muted-foreground">{t("背景不透明度")}</span>
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
                    <span className="text-muted-foreground">{t("界面不透明度")}</span>
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
                    {t("作用于卡片、侧边栏、标题栏、弹窗与输入框")}
                  </p>
                </div>
              </div>

              {/* 网格线与毛玻璃开关 */}
              <div className="space-y-2 pt-1">
                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/15 p-3">
                  <Label className="text-[12px] font-medium text-foreground">{t("方块网格")}</Label>
                  <Switch
                    checked={settings.showWorldGrid}
                    onCheckedChange={(val) => onChange({ showWorldGrid: val })}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/15 p-3">
                  <Label className="text-[12px] font-medium text-foreground">{t("磨砂玻璃")}</Label>
                  <Switch
                    checked={settings.enableMica}
                    onCheckedChange={(val) => onChange({ enableMica: val })}
                  />
                </div>
              </div>
            </SettingsSection>

            {/* 主页：PCL2 风格的可自定义主页区域 */}
            <SettingsSection title={t("主页")} icon={<Newspaper className="size-4" />}>
              <Field label={t("主页内容")}>
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
                      <span className="text-[11.5px] font-medium">{t(option.label)}</span>
                    </Label>
                  ))}
                </RadioGroup>
              </Field>

              <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                {settings.homePageMode === "preset"
                  ? t("使用内置的“我的世界更新新闻”作为主页内容。")
                  : settings.homePageMode === "blank"
                    ? t("主页区域保持空白，只保留右侧启动面板。")
                    : settings.homePageMode === "local"
                      ? t(
                          "读取本地 HTML 文件，或直接使用 PCL2 的 .xaml 自定义主页；XAML 里的相对图片会按文件所在目录读取。",
                        )
                      : t(
                          "从网络地址加载 HTML 或 PCL2 的 .xaml 主页，可设置自动刷新间隔保持内容最新。",
                        )}
              </p>

              <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                {t(
                  "兼容 PCL2 自定义主页：支持 Grid / StackPanel / Border / TextBlock / Image 等布局与内容组件，以及 MyCard、MyButton、MyHint、MyTextBox 等 PCL 控件、{DynamicResource} 主题色与 EventType 动作（打开网页 / 复制文本 / 刷新主页 / 启动游戏）。无法还原的元素会在主页标题旁标记。",
                )}
              </p>

              {settings.homePageMode === "local" ? (
                <div className="space-y-2 rounded-lg border border-border/70 bg-background/30 p-3">                    <Label className="text-[11px] text-muted-foreground">
                      {t("本地主页文件（HTML 或 PCL2 的 .xaml）")}
                    </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      value={settings.homePageLocalPath || ""}
                      onChange={(e) => onChange({ homePageLocalPath: e.target.value })}
                      placeholder={t("例如 D:\\PCL2\\Homepage.html")}
                      className="h-8 flex-1 font-mono text-[11px]"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-[11px]"
                      onClick={() => void handlePickHomePage()}
                    >
                      <FolderOpen className="size-3.5" />
                      {t("浏览")}
                    </Button>
                    {settings.homePageLocalPath ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={() => onChange({ homePageLocalPath: "" })}
                      >
                        {t("清空")}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {settings.homePageMode === "online" ? (
                <div className="space-y-3">
                  <div className="space-y-2 rounded-lg border border-border/70 bg-background/30 p-3">
                    <Label className="text-[11px] text-muted-foreground">{t("主页地址")}</Label>
                    <Input
                      value={settings.homePageUrl || ""}
                      onChange={(e) => onChange({ homePageUrl: e.target.value })}
                      placeholder="https://example.com/homepage.html"
                      className="h-8 font-mono text-[11px]"
                    />
                  </div>
                  <Field label={t("自动刷新间隔")}>
                    <SettingsSelect
                      value={String(settings.homePageRefreshMinutes)}
                      onChange={(val) => onChange({ homePageRefreshMinutes: Number(val) })}
                      options={[
                        {
                          value: "0",
                          label: t("仅手动刷新"),
                          description: t("打开主页或点击刷新时更新"),
                        },
                        {
                          value: "5",
                          label: t("每 5 分钟"),
                          description: t("适合频繁更新的主页"),
                        },
                        { value: "15", label: t("每 15 分钟"), description: t("较为均衡") },
                        { value: "30", label: t("每 30 分钟"), description: t("节省流量") },
                        {
                          value: "60",
                          label: t("每 60 分钟"),
                          description: t("适合更新较慢的页面"),
                        },
                      ]}
                    />
                  </Field>
                </div>
              ) : null}
            </SettingsSection>

            {/* 界面排版与视觉定制 */}
            <SettingsSection
              title={t("排版与文案")}
              icon={<Type className="size-4" />}
            >
              <Field label={t("界面字体风格")}>
                <SettingsSelect
                  value={settings.fontFamily}
                  onChange={(val) => onChange({ fontFamily: val as any })}
                  options={[
                    {
                      value: "default",
                      label: t("现代极简 (Geist Sans)"),
                      description: t("专为代码与设计优化的现代极简无衬线字体（推荐）"),
                    },
                    {
                      value: "pixel",
                      label: t("复古像素 (Silkscreen)"),
                      description: t("经典的 8-bit Minecraft 像素风格字体"),
                    },
                    {
                      value: "system",
                      label: t("系统原生字体 (System UI)"),
                      description: t("跟随当前操作系统原生 UI 字体配置"),
                    },
                    {
                      value: "serif",
                      label: t("古典衬线 (Serif)"),
                      description: t("Georgia 与宋体回退，适合喜欢阅读感的排版"),
                    },
                  ]}
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("界面字重")}>
                  <SettingsSelect
                    value={settings.fontWeight}
                    onChange={(val) => onChange({ fontWeight: val as any })}
                    options={[
                      {
                        value: "regular",
                        label: t("常规字重 (400)"),
                        description: t("默认，轻盈通透"),
                      },
                      {
                        value: "medium",
                        label: t("中等字重 (500)"),
                        description: t("文字更厚重，小字号也更清晰"),
                      },
                    ]}
                  />
                </Field>

                <Field label={t("字间距")}>
                  <SettingsSelect
                    value={settings.letterSpacing}
                    onChange={(val) => onChange({ letterSpacing: val as any })}
                    options={[
                      {
                        value: "tight",
                        label: t("紧凑 (-0.01em)"),
                        description: t("信息密度更高，适合小屏"),
                      },
                      {
                        value: "normal",
                        label: t("标准"),
                        description: t("默认排版间距"),
                      },
                      {
                        value: "wide",
                        label: t("宽松 (+0.03em)"),
                        description: t("更舒缓，搭配像素字体尤其清晰"),
                      },
                    ]}
                  />
                </Field>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/15 p-3">
                <Label className="text-[12px] font-medium text-foreground">{t("平滑过渡动效")}</Label>
                <Switch
                  checked={settings.enableAnimation}
                  onCheckedChange={(val) => onChange({ enableAnimation: val })}
                />
              </div>

              <Field label={t("自定义启动器窗口标题 (留空使用默认名称)")}>
                <Input
                  value={settings.windowTitle || ""}
                  onChange={(e) => onChange({ windowTitle: e.target.value })}
                  placeholder="OPEN-SOURCE MINECRAFT LAUNCHER"
                  className="h-8 font-mono text-[11px]"
                />
              </Field>

              <Field label={t("启动器个性标语 / 座右铭签名")}>
                <Input
                  value={settings.customSlogan || ""}
                  onChange={(e) => onChange({ customSlogan: e.target.value })}
                  placeholder={t("自由探索，无限创造。")}
                  className="h-8 text-[11px]"
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("首页状态文案 (留空使用默认)")}>
                  <Input
                    value={settings.statusText || ""}
                    onChange={(e) => onChange({ statusText: e.target.value })}
                    placeholder={t("准备就绪，随时出发")}
                    maxLength={40}
                    className="h-8 text-[11px]"
                  />
                </Field>

                <Field label={t("启动按钮文案 (留空使用默认)")}>
                  <Input
                    value={settings.launchButtonText || ""}
                    onChange={(e) => onChange({ launchButtonText: e.target.value })}
                    placeholder={t("启动游戏 / 启动基岩版")}
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
              title="软件更新"
              icon={<CloudDownload className="size-4" />}
              actions={
                <Badge
                  variant="outline"
                  className="border-primary/30 bg-primary/10 font-mono text-[9.5px] text-primary"
                >
                  GitHub Releases
                </Badge>
              }
            >
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 bg-muted/15 p-3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium text-foreground">
                      当前版本{" "}
                      <span className="font-mono">
                        v{updateInfo?.currentVersion ?? systemInfo?.launcherVersion ?? "0.0.7"}
                      </span>
                      {updateInfo?.available && updateInfo.latestVersion ? (
                        <span className="ml-2 font-mono text-[11px] text-primary">
                          → v{updateInfo.latestVersion}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-0.5 text-[10.5px] leading-4 text-muted-foreground">
                      更新包默认由 GitHub Releases 分发，下载后暂存于本机更新目录。
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5"
                    onClick={() => void handleCheckUpdate()}
                    disabled={updateChecking || updateDownloading}
                  >
                    <RefreshCw className={cn("size-3.5", updateChecking && "animate-spin")} />
                    {updateChecking ? "检查中…" : "检查更新"}
                  </Button>
                </div>

                {updateError ? (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-[11px] leading-5 text-destructive">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 break-all">{updateError}</span>
                  </div>
                ) : null}

                {updateInfo && !updateInfo.available && !updateChecking ? (
                  <div className="flex items-start gap-2 rounded-lg border border-border/50 bg-muted/15 p-2.5 text-[11px] leading-5 text-muted-foreground">
                    <Info className="mt-0.5 size-3.5 shrink-0 text-primary" />
                    <span>
                      {updateInfo.message || "当前已是最新版本。"}
                      {!isDesktop ? " 桌面版可直接在启动器内下载并安装。" : ""}
                    </span>
                  </div>
                ) : null}

                {updateInfo?.available ? (
                  <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/5 p-3.5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[12.5px] font-semibold text-foreground">
                          发现新版本 v{updateInfo.latestVersion}
                        </p>
                        <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                          {updateInfo.releaseName ? `${updateInfo.releaseName} · ` : ""}
                          {updateInfo.publishedAt
                            ? `${formatDate(updateInfo.publishedAt)} · `
                            : ""}
                          来自 GitHub Releases
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className="border-primary/35 bg-primary/10 font-mono text-[9.5px] text-primary"
                      >
                        OTA
                      </Badge>
                    </div>

                    {updateInfo.notes ? (
                      <div className="max-h-28 overflow-y-auto whitespace-pre-line rounded-md border border-border/40 bg-background/50 p-2.5 text-[11px] leading-5 text-muted-foreground">
                        {updateInfo.notes}
                      </div>
                    ) : null}

                    {updateInfo.asset ? (
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                          <span
                            className="min-w-0 truncate font-mono text-foreground/90"
                            title={updateInfo.asset.name}
                          >
                            {updateInfo.asset.name}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                            {formatBytes(updateInfo.asset.size)}
                          </span>
                        </div>

                        {updateDownload ? (
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                className="h-8 gap-1.5"
                                onClick={() => void handleInstallUpdate()}
                                disabled={updateInstalling}
                              >
                                <Check className="size-3.5" />
                                {updateInstalling ? "正在启动…" : "安装更新"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8"
                                onClick={() => void handleDownloadUpdate(true)}
                                disabled={updateDownloading || updateInstalling}
                              >
                                重新下载
                              </Button>
                            </div>
                            <p
                              className="truncate font-mono text-[9.5px] text-muted-foreground/70"
                              title={updateDownload.path}
                            >
                              已下载：{shortPath(updateDownload.path, 48)}
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Button
                              size="sm"
                              className="h-8 gap-1.5"
                              onClick={() => void handleDownloadUpdate()}
                              disabled={updateDownloading}
                            >
                              <CloudDownload
                                className={cn("size-3.5", updateDownloading && "animate-pulse")}
                              />
                              {updateDownloading
                                ? `下载中 ${updateProgress?.percent ?? 0}%`
                                : "下载更新"}
                            </Button>
                            {updateDownloading ? (
                              <div className="space-y-1.5">
                                <Progress
                                  value={updateProgress?.percent ?? 0}
                                  className="h-1.5"
                                />
                                <div className="flex justify-between gap-2 font-mono text-[9.5px] text-muted-foreground">
                                  <span>
                                    {formatBytes(updateProgress?.received ?? 0)} /{" "}
                                    {formatBytes(
                                      updateProgress?.total || updateInfo.asset.size,
                                    )}
                                  </span>
                                  <span>{updateProgress?.percent ?? 0}%</span>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        className="h-8 gap-1.5"
                        onClick={() => void openExternalUrl(updateInfo.releaseUrl)}
                      >
                        <ExternalLink className="size-3.5" />
                        前往 GitHub Releases 下载
                      </Button>
                    )}

                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[10.5px] text-muted-foreground transition-colors hover:text-primary"
                      onClick={() => void openExternalUrl(updateInfo.releaseUrl)}
                    >
                      查看发布说明
                      <ExternalLink className="size-3" />
                    </button>
                  </div>
                ) : null}
              </div>
            </SettingsSection>

            <SettingsSection
              title="问题反馈"
              icon={<MessageSquareWarning className="size-4" />}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-[11.5px] leading-5 text-muted-foreground">
                    遇到 bug、兼容性问题，或有功能建议？请到 GitHub Issues 提交，附上启动器版本与复现步骤会更快定位。
                  </p>
                  <p className="truncate font-mono text-[9.5px] text-muted-foreground/60">
                    github.com/Cerlesse-studio/Open-source-Minecraft-launcher/issues
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 gap-1.5 border-primary/35 bg-primary/10 text-primary hover:bg-primary/15"
                  onClick={() => void openExternalUrl(FEEDBACK_URL)}
                >
                  <MessageSquareWarning className="size-3.5" />
                  提交反馈
                  <ExternalLink className="size-3" />
                </Button>
              </div>
            </SettingsSection>

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
                    {isDesktop ? "原生轻量级 WebView 桌面版 (Win / macOS / Linux)" : "Web 预览"}
                  </Badge>
                </div>
              </div>
            </SettingsSection>

            <SettingsSection
              title="开发者选项"
              icon={<Terminal className="size-4" />}
              actions={
                <Badge
                  variant="outline"
                  className="border-primary/30 bg-primary/10 font-mono text-[9.5px] text-primary"
                >
                  {isDesktop ? "Electron" : "浏览器预览"}
                </Badge>
              }
            >
              <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                这些开关只影响本机启动器，设置会自动保存。关闭扩展或调试能力不会删除任何已安装内容。
              </p>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/15 p-3">
                <div className="min-w-0 space-y-1">
                  <Label
                    htmlFor="developer-extensions"
                    className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"
                  >
                    <Puzzle className="size-3.5 text-primary" />
                    启用扩展功能
                  </Label>
                  <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                    关闭后隐藏侧边栏的「扩展」入口，并停止扩展后台脚本与游戏启动/退出事件分发。扩展目录和启用状态会原样保留。
                  </p>
                </div>
                <Switch
                  id="developer-extensions"
                  checked={settings.enableExtensions}
                  onCheckedChange={(val) => onChange({ enableExtensions: val })}
                />
              </div>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/15 p-3">
                <div className="min-w-0 space-y-1">
                  <Label
                    htmlFor="developer-devtools"
                    className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"
                  >
                    <Monitor className="size-3.5 text-primary" />
                    启用 Chromium F12 开发者工具
                  </Label>
                  <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                    开启后可随时按 <kbd className="rounded border border-border/70 bg-background/60 px-1 font-mono text-[9.5px]">F12</kbd> 或{" "}
                    <kbd className="rounded border border-border/70 bg-background/60 px-1 font-mono text-[9.5px]">Ctrl+Shift+I</kbd>{" "}
                    打开独立 DevTools 窗口；关闭时会自动收起，并拦截系统默认快捷键。
                  </p>
                </div>
                <Switch
                  id="developer-devtools"
                  checked={settings.enableDevTools}
                  onCheckedChange={(val) => onChange({ enableDevTools: val })}
                />
              </div>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/15 p-3">
                <div className="min-w-0 space-y-1">
                  <Label
                    htmlFor="developer-console"
                    className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"
                  >
                    <Terminal className="size-3.5 text-primary" />
                    后台进程日志（CMD 控制台）
                  </Label>
                  <p className="text-[10.5px] leading-5 text-muted-foreground/70">
                    开启后自动打开独立的等宽日志窗口，实时捕获 Rust 核心的 stdout、stderr、进程退出与 IPC 状态，并同步写入日志文件。
                  </p>
                </div>
                <Switch
                  id="developer-console"
                  checked={settings.showBackendConsole}
                  onCheckedChange={(val) => onChange({ showBackendConsole: val })}
                />
              </div>

              {settings.showBackendConsole ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-background/30 p-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-[10.5px] text-muted-foreground/60">日志文件</p>
                    <p
                      className="truncate font-mono text-[10px] text-foreground/80"
                      title={developerConsole?.logPath ?? undefined}
                    >
                      {developerConsole?.logPath ?? "启用后生成到用户数据目录 /logs/core-console.log"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 text-[11px]"
                    onClick={() => void openBackendConsole()}
                  >
                    <Terminal className="size-3.5" />
                    打开日志窗口
                  </Button>
                  {developerConsole?.logPath ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => onOpenFolder(developerConsole.logPath ?? "")}
                    >
                      所在文件夹
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {!isDesktop ? (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-2.5 text-[10.5px] leading-5 text-amber-300">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>浏览器预览模式没有 Electron 主进程，F12 与后台日志窗口只在桌面版生效。</span>
                </div>
              ) : null}
            </SettingsSection>

            <SettingsSection
              title="跨平台轻量级原生 WebView 内核与安全基线"
              icon={<Cpu className="size-4" />}
            >
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-2.5">
                    <div className="text-[10.5px] text-muted-foreground">WebView 渲染核心</div>
                    <div className="mt-0.5 font-mono text-[12px] font-semibold text-foreground">
                      {chromiumProfile?.versions.chrome ?? "Custom"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-2.5">
                    <div className="text-[10.5px] text-muted-foreground">冷启动至可交互</div>
                    <div className="mt-0.5 font-mono text-[12px] font-semibold text-primary">
                      {chromiumProfile?.coldStartupMs != null ? `${chromiumProfile.coldStartupMs} ms` : "已就绪"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-2.5">
                    <div className="text-[10.5px] text-muted-foreground">工作集内存 / 进程</div>
                    <div className="mt-0.5 font-mono text-[12px] font-semibold text-foreground">
                      {chromiumProfile ? `${chromiumProfile.memoryWorkingSetMb} MB · ${chromiumProfile.processCount} 进程` : "—"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/15 p-2.5">
                    <div className="text-[10.5px] text-muted-foreground">发行包体积</div>
                    <div className="mt-0.5 font-mono text-[12px] font-semibold text-foreground">
                      {chromiumProfile?.baseline ? `${chromiumProfile.baseline.totalDistSizeMb} MB` : "—"}
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5 rounded-lg border border-border/50 bg-muted/15 p-3 text-[11.5px]">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">L1 打包层裁剪</span>
                    <Badge variant="outline" className="border-emerald-500/35 bg-emerald-500/10 text-emerald-400 text-[10px]">
                      零捆绑浏览器运行时 · 节省 ~240 MB 落盘体积
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">L2 运行时与 Fuse 加固</span>
                    <Badge variant="outline" className="border-emerald-500/35 bg-emerald-500/10 text-emerald-400 text-[10px]">
                      Rust 进程内直连 IPC · 禁用 14 项冗余特性
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">L3 源码级 GN 裁剪配置</span>
                    <Badge variant="outline" className="border-primary/35 bg-primary/10 text-primary font-mono text-[10px]">
                      Win WebView2 · macOS WKWebView · Linux WebKitGTK
                    </Badge>
                  </div>
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
