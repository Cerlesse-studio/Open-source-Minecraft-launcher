import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  CloudDownload,
  Copy,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Layers3,
  LayoutTemplate,
  LoaderCircle,
  LogIn,
  Newspaper,
  Play,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  SquareDashed,
  UserRound,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, progressPercent } from "../lib/format";
import {
  channelLabel,
  getPatchNotes,
  isRelease,
  type PatchNote,
} from "../lib/news";
import {
  fetchHomePage,
  getBedrockStatus,
  isDesktop,
  launchBedrock,
  openExternalUrl,
  openFolderPath,
  readHomePageFile,
  readSkinAsDataUrl,
} from "../lib/backend";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { joinPath } from "../lib/format";
import { looksLikePclHomepage, renderPclHomepage } from "../lib/pcl-homepage";
import { getEffectivePrimaryColor } from "../lib/theme";
import type {
  BedrockStatus,
  GameEdition,
  GameStateName,
  HomePageMode,
  InstallProgress,
  InstalledVersion,
  LauncherSettings,
  MsAccount,
} from "../lib/types";
import { Avatar, GrassBlock, StatusDot, TypeBadge } from "./ui";

interface RuntimeView {
  status: GameStateName;
  detail?: string | null;
  pid?: number | null;
  versionId?: string | null;
}

interface HomeViewProps {
  installed: InstalledVersion[];
  selectedVersion: string;
  playerName: string;
  onPlayerNameChange: (name: string) => void;
  runtime: RuntimeView;
  launchProgress: InstallProgress | null;
  onLaunch: () => void;
  onStop: () => void;
  onOpenVersionSelect: () => void;
  onOpenVersionSettings: () => void;
  /** Jumps to the launcher settings; used by the custom home page hints. */
  onOpenSettings?: () => void;
  gameRoot?: string;
  onOpenDownloadBedrock?: () => void;
  onNotify?: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
  edition?: GameEdition;
  onEditionChange?: (edition: GameEdition) => void;
  selectedBedrockVersion?: string;
  settings?: LauncherSettings;
  onUpdateSettings?: (patch: Partial<LauncherSettings>) => void;
  accountType?: "offline" | "microsoft";
  /** The signed-in Microsoft account, shared by both editions. */
  account?: MsAccount | null;
  onOpenAccount?: () => void;
}

/** Directory part of a home page path, used to resolve its relative resources. */
function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return index > 0 ? path.slice(0, index) : "";
}

/**
 * XAML home pages address images by path, and the frame cannot read local files,
 * so relative (or absolute) paths are read here and inlined as data URLs.
 */
async function resolveHomeResource(pagePath: string, relative: string): Promise<string | null> {
  const trimmed = relative.trim();
  if (!trimmed) return null;
  try {
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
      return await readSkinAsDataUrl(trimmed);
    }
    const directory = dirName(pagePath);
    if (!directory) return null;
    const separator = directory.includes("\\") ? "\\" : "/";
    const normalised = trimmed.replace(/[\\/]+/g, separator);
    return await readSkinAsDataUrl(joinPath(directory, normalised));
  } catch {
    return null;
  }
}

type Notify = (tone: "success" | "error" | "info", title: string, detail?: string) => void;

/** Clipboard first; when the webview refuses it, show the text so it can be copied. */
function copyText(value: string, label: string, onNotify?: Notify): void {
  if (!value) return;
  void navigator.clipboard?.writeText(value).then(
    () => onNotify?.("success", "已复制", label),
    () => onNotify?.("info", "请手动复制", value),
  );
}

const HOME_PAGE_CHOICES: Array<{ id: HomePageMode; label: string; hint: string }> = [
  { id: "preset", label: "预设更新新闻", hint: "内置的 Mojang 更新日志" },
  { id: "blank", label: "空白", hint: "主页区域留空" },
  { id: "local", label: "读取本地文件", hint: "HTML 或 PCL2 的 .xaml 主页" },
  { id: "online", label: "联网更新", hint: "从网址加载主页" },
];

interface HomePageMenuProps {
  mode: HomePageMode;
  source?: string;
  loading: boolean;
  activeTitle?: string | null;
  onRefresh: () => void;
  onChangeMode: (mode: HomePageMode) => void;
  onOpenSettings?: () => void;
  onNotify?: Notify;
}

/** Right-click menu of the left home page column (news feed or custom page). */
function HomePageContextMenu({
  mode,
  source,
  loading,
  activeTitle,
  onRefresh,
  onChangeMode,
  onOpenSettings,
  onNotify,
}: HomePageMenuProps) {
  const isCustom = mode === "local" || mode === "online";
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuLabel className="text-[10.5px] font-normal text-muted-foreground">
        {mode === "preset" ? "更新新闻" : "自定义主页"}
      </ContextMenuLabel>
      <ContextMenuItem disabled={loading} className="gap-2.5 text-[12.5px]" onSelect={onRefresh}>
        <RefreshCw className="size-3.5" />
        {mode === "preset" ? "刷新更新新闻" : "刷新主页"}
      </ContextMenuItem>
      {mode === "preset" ? (
        <ContextMenuItem
          disabled={!activeTitle}
          className="gap-2.5 text-[12.5px]"
          onSelect={() => copyText(activeTitle ?? "", activeTitle ?? "", onNotify)}
        >
          <Copy className="size-3.5" />
          复制当前更新标题
        </ContextMenuItem>
      ) : null}

      {isCustom && source ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            className="gap-2.5 text-[12.5px]"
            onSelect={() => copyText(source, source, onNotify)}
          >
            <Copy className="size-3.5" />
            {mode === "local" ? "复制主页文件路径" : "复制主页地址"}
          </ContextMenuItem>
          {mode === "local" ? (
            <ContextMenuItem
              className="gap-2.5 text-[12.5px]"
              onSelect={() => {
                const directory = dirName(source);
                if (!directory) {
                  onNotify?.("error", "无法打开文件夹", "这个路径里没有上级目录。");
                  return;
                }
                void openFolderPath(directory).catch((error) =>
                  onNotify?.("error", "无法打开文件夹", String(error)),
                );
              }}
            >
              <FolderOpen className="size-3.5" />
              打开文件所在文件夹
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              className="gap-2.5 text-[12.5px]"
              onSelect={() => void openExternalUrl(source)}
            >
              <ExternalLink className="size-3.5" />
              在浏览器中打开
            </ContextMenuItem>
          )}
        </>
      ) : null}

      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger className="gap-2.5 text-[12.5px]">
          <LayoutTemplate className="size-3.5" />
          主页内容
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56">
          {HOME_PAGE_CHOICES.map((choice) => (
            <ContextMenuCheckboxItem
              key={choice.id}
              checked={mode === choice.id}
              className="gap-2.5 text-[12.5px]"
              onSelect={() => onChangeMode(choice.id)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{choice.label}</span>
                <span className="text-[10px] text-muted-foreground">{choice.hint}</span>
              </span>
            </ContextMenuCheckboxItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem className="gap-2.5 text-[12.5px]" onSelect={() => onOpenSettings?.()}>
        <SlidersHorizontal className="size-3.5" />
        主页设置…
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

interface LaunchMenuProps {
  primaryLabel: string;
  running: boolean;
  busy: boolean;
  installed: boolean;
  isOffline: boolean;
  playerLabel: string;
  signedIn: boolean;
  onPrimaryAction: () => void;
  onOpenVersionSelect: () => void;
  onOpenVersionSettings: () => void;
  onOpenAccount?: () => void;
  onUploadSkin: () => void;
  onOpenSettings?: () => void;
  onNotify?: Notify;
}

/** Right-click menu of the launch column: launch, versions, profile. */
function LaunchContextMenu({
  primaryLabel,
  running,
  busy,
  installed,
  isOffline,
  playerLabel,
  signedIn,
  onPrimaryAction,
  onOpenVersionSelect,
  onOpenVersionSettings,
  onOpenAccount,
  onUploadSkin,
  onOpenSettings,
  onNotify,
}: LaunchMenuProps) {
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuLabel className="text-[10.5px] font-normal text-muted-foreground">
        启动
      </ContextMenuLabel>
      <ContextMenuItem
        disabled={busy}
        className="gap-2.5 text-[12.5px]"
        onSelect={onPrimaryAction}
      >
        {running ? <Square className="size-3.5 fill-current" /> : <Play className="size-3.5" />}
        {primaryLabel}
      </ContextMenuItem>
      <ContextMenuItem className="gap-2.5 text-[12.5px]" onSelect={onOpenVersionSelect}>
        <Layers3 className="size-3.5" />
        版本选择
      </ContextMenuItem>
      {installed ? (
        <ContextMenuItem
          className="gap-2.5 text-[12.5px]"
          onSelect={onOpenVersionSettings}
        >
          <SlidersHorizontal className="size-3.5" />
          版本设置
        </ContextMenuItem>
      ) : null}

      <ContextMenuSeparator />
      <ContextMenuLabel className="text-[10.5px] font-normal text-muted-foreground">
        玩家档案
      </ContextMenuLabel>
      <ContextMenuItem
        className="gap-2.5 text-[12.5px]"
        onSelect={() => onOpenAccount?.()}
      >
        <UserRound className="size-3.5" />
        {signedIn ? "账户信息…" : "登录微软账户…"}
      </ContextMenuItem>
      {isOffline ? (
        <ContextMenuItem className="gap-2.5 text-[12.5px]" onSelect={onUploadSkin}>
          <Camera className="size-3.5" />
          上传离线皮肤…
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        className="gap-2.5 text-[12.5px]"
        onSelect={() => copyText(playerLabel, playerLabel, onNotify)}
      >
        <Copy className="size-3.5" />
        复制玩家名
      </ContextMenuItem>

      <ContextMenuSeparator />
      <ContextMenuItem className="gap-2.5 text-[12.5px]" onSelect={() => onOpenSettings?.()}>
        <SlidersHorizontal className="size-3.5" />
        启动器设置…
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function NewsFallback({ size = 28 }: { size?: number }) {
  return (
    <div className="media-surface relative grid h-full w-full place-items-center overflow-hidden">
      <div className="world-grid absolute inset-0 opacity-40" />
      <GrassBlock size={size} className="relative opacity-75" />
    </div>
  );
}

function NewsCover({
  note,
  eager = false,
}: {
  note: PatchNote;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
  }, [note.imageUrl]);

  if (!note.imageUrl || failed) {
    return <NewsFallback size={eager ? 52 : 22} />;
  }

  return (
    <div className="media-surface relative h-full w-full overflow-hidden">
      {!loaded ? (
        <div className="absolute inset-0">
          <NewsFallback size={eager ? 52 : 22} />
        </div>
      ) : null}
      <img
        src={note.imageUrl}
        alt=""
        loading={eager ? "eager" : "lazy"}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          "relative h-full w-full object-cover transition-opacity duration-500",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function NewsSkeleton() {
  return (
    <div className="space-y-4 p-5" aria-hidden="true">
      <Skeleton className="h-[260px] w-full rounded-lg" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-4/5" />
      </div>
      <div className="space-y-2 pt-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton className="h-10 w-14 shrink-0 rounded-md" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HomeView({
  installed,
  selectedVersion,
  playerName,
  onPlayerNameChange,
  runtime,
  launchProgress,
  onLaunch,
  onStop,
  onOpenVersionSelect,
  onOpenVersionSettings,
  onOpenSettings,
  gameRoot,
  onOpenDownloadBedrock,
  onNotify,
  edition = "java",
  selectedBedrockVersion = "uwp",
  settings,
  onUpdateSettings,
  accountType = "offline",
  account = null,
  onOpenAccount,
}: HomeViewProps) {
  const [bedrockStatus, setBedrockStatus] = useState<BedrockStatus | null>(null);
  const [bedrockLaunching, setBedrockLaunching] = useState(false);
  const [news, setNews] = useState<PatchNote[]>([]);
  const [newsLoading, setNewsLoading] = useState(true);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [homeHtml, setHomeHtml] = useState<string | null>(null);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState<string | null>(null);
  const [homeUpdatedAt, setHomeUpdatedAt] = useState<number | null>(null);
  // PCL2 主页（XAML）会被翻译成 HTML；兼容模式及其被降级的元素都会提示给玩家。
  const [homeCompat, setHomeCompat] = useState(false);
  const [homeWarnings, setHomeWarnings] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const homeFrameRef = useRef<HTMLIFrameElement | null>(null);
  /** Invisible anchors that let a right-click open the launcher menu at the pointer. */
  const menuAnchorHomeRef = useRef<HTMLDivElement | null>(null);
  const menuAnchorLaunchRef = useRef<HTMLDivElement | null>(null);
  const isOffline = accountType === "offline";

  // Custom home page: the left panel shows the player's own HTML instead of the
  // news feed. `preset` is the built-in news panel and needs no loading.
  const homeMode = settings?.homePageMode ?? "preset";
  const homeSource = (
    homeMode === "local" ? settings?.homePageLocalPath : settings?.homePageUrl
  )?.trim();
  const homeUpdatedLabel = homeUpdatedAt
    ? new Date(homeUpdatedAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  /**
   * Opens one of the launcher context menus at viewport coordinates. Radix opens
   * a menu from a real `contextmenu` event, so the invisible anchor is moved to
   * the pointer and the event is dispatched on it — that keeps one menu
   * definition working for the page itself and for the PCL2 home page frame.
   */
  const openMenuAt = useCallback((anchor: HTMLDivElement | null, x: number, y: number) => {
    if (!anchor) return;
    const point = { x: Math.round(x), y: Math.round(y) };
    anchor.style.left = `${point.x}px`;
    anchor.style.top = `${point.y}px`;
    anchor.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
      }),
    );
  }, []);

  const isBedrock =
    edition === "bedrock" ||
    selectedVersion === "uwp" ||
    selectedVersion === "bedrock-uwp" ||
    selectedVersion.startsWith("bedrock:") ||
    selectedVersion.startsWith("bedrock-") ||
    (bedrockStatus?.installedVersions.includes(selectedVersion) ?? false);

  const activeBedrockVersion = useMemo(() => {
    if (selectedVersion.startsWith("bedrock:")) {
      return selectedVersion.replace(/^bedrock:/, "");
    }
    if (selectedBedrockVersion && selectedBedrockVersion !== "uwp") {
      return selectedBedrockVersion;
    }
    // Offline accounts boot the BDS core by default: the Store client needs a
    // Microsoft sign-in, which an offline account cannot provide.
    if (isOffline) {
      const bds = bedrockStatus?.versionDetails?.find((detail) => detail.isServer);
      if (bds) return bds.id;
    }
    if (bedrockStatus?.installedVersions && bedrockStatus.installedVersions.length > 0) {
      return bedrockStatus.installedVersions[0];
    }
    if (bedrockStatus?.uwpInstalled) {
      return "uwp";
    }
    return selectedBedrockVersion || "uwp";
  }, [selectedVersion, selectedBedrockVersion, bedrockStatus, isOffline]);

  const isBedrockInstalled = useMemo(() => {
    if (activeBedrockVersion === "uwp") {
      return Boolean(bedrockStatus?.uwpInstalled);
    }
    return Boolean(
      bedrockStatus?.installedVersions.includes(activeBedrockVersion) ||
      bedrockStatus?.standaloneInstalled
    );
  }, [activeBedrockVersion, bedrockStatus]);

  const displayVersion = isBedrock
    ? activeBedrockVersion === "uwp"
      ? "Minecraft for Windows (UWP)"
      : `基岩版: ${activeBedrockVersion}`
    : selectedVersion || "—";

  const handleUploadSkin = useCallback(async () => {
    if (!isOffline) {
      onNotify?.("info", "仅限离线账户", "当前只有离线账户支持本地上传皮肤。");
      return;
    }

    if (isDesktop) {
      try {
        const picked = await openDialog({
          directory: false,
          multiple: false,
          filters: [{ name: "Minecraft 皮肤 (*.png)", extensions: ["png"] }],
          title: "选择离线皮肤文件 (PNG)",
        });
        if (typeof picked === "string" && picked.trim()) {
          onUpdateSettings?.({
            offlineSkinType: "custom",
            customSkinPath: picked.trim(),
          });
          onNotify?.("success", "皮肤已更新", "已成功更换离线自定义皮肤");
        }
      } catch (error) {
        onNotify?.("error", "选择皮肤失败", String(error));
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [isOffline, onNotify, onUpdateSettings]);

  const handleBrowserFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!file.name.toLowerCase().endsWith(".png")) {
        onNotify?.("error", "文件格式错误", "请上传 .png 格式的皮肤文件。");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        onUpdateSettings?.({
          offlineSkinType: "custom",
          customSkinPath: result,
        });
        onNotify?.("success", "皮肤已更新", `已加载皮肤: ${file.name}`);
      };
      reader.readAsDataURL(file);
      e.target.value = "";
    },
    [onNotify, onUpdateSettings],
  );

  const refreshBedrockStatus = useCallback(async () => {
    try {
      const s = await getBedrockStatus(gameRoot);
      setBedrockStatus(s);
    } catch {
      // ignore
    }
  }, [gameRoot]);

  useEffect(() => {
    void refreshBedrockStatus();
    const onFocus = () => void refreshBedrockStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshBedrockStatus, selectedBedrockVersion, edition]);

  const handleLaunchBedrock = async () => {
    setBedrockLaunching(true);
    try {
      const target =
        activeBedrockVersion === "uwp" || !activeBedrockVersion
          ? undefined
          : activeBedrockVersion;
      const msg = await launchBedrock(target, gameRoot);
      onNotify?.("success", "基岩版启动 / 自动程序处理中", msg);
      await refreshBedrockStatus();
    } catch (e) {
      onNotify?.("error", "启动基岩版失败", String(e));
    } finally {
      setBedrockLaunching(false);
    }
  };

  const loadNews = useCallback(async (force = false) => {
    setNewsLoading(true);
    setNewsError(null);
    try {
      const entries = await getPatchNotes(force);
      setNews(entries);
      setActiveId((current) =>
        current && entries.some((entry) => entry.id === current)
          ? current
          : (entries[0]?.id ?? null),
      );
    } catch (error) {
      setNewsError(String(error));
    } finally {
      setNewsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (homeMode === "preset") void loadNews();
  }, [loadNews, homeMode]);

  // 玩家名 / 版本号等只在渲染那一刻读取，放进 ref 里，避免每敲一个字就重载主页。
  const homeRuntimeRef = useRef({ player: "", version: "", launcher: "" });
  homeRuntimeRef.current = {
    player: account?.signedIn ? account.name : playerName,
    version: selectedVersion,
    launcher: settings?.customInfo?.trim() || "Open-source-Minecraft-launcher",
  };

  const loadCustomHome = useCallback(async () => {
    const mode = settings?.homePageMode ?? "preset";
    if (mode !== "local" && mode !== "online") return;
    const source = (
      mode === "local" ? settings?.homePageLocalPath : settings?.homePageUrl
    )?.trim();
    if (!source) {
      setHomeHtml(null);
      setHomeError(null);
      setHomeUpdatedAt(null);
      return;
    }
    setHomeLoading(true);
    try {
      const raw = mode === "local" ? await readHomePageFile(source) : await fetchHomePage(source);
      if (looksLikePclHomepage(raw, source)) {
        const { color: accent } = getEffectivePrimaryColor({
          customThemeColor: settings?.customThemeColor ?? "",
        });
        const themeMode = settings?.themeMode ?? "dark";
        const dark =
          themeMode === "dark" ||
          (themeMode === "system" &&
            typeof window !== "undefined" &&
            window.matchMedia("(prefers-color-scheme: dark)").matches);
        const rendered = await renderPclHomepage(raw, {
          accent,
          dark,
          runtime: {
            PlayerName: homeRuntimeRef.current.player,
            VersionName: homeRuntimeRef.current.version,
            LauncherName: homeRuntimeRef.current.launcher,
          },
          baseHref: mode === "online" ? source : undefined,
          resolveLocalResource:
            mode === "local" ? (relative) => resolveHomeResource(source, relative) : undefined,
        });
        setHomeHtml(rendered.html);
        setHomeWarnings(rendered.warnings);
        setHomeCompat(true);
      } else {
        setHomeHtml(raw);
        setHomeWarnings([]);
        setHomeCompat(false);
      }
      setHomeError(null);
      setHomeUpdatedAt(Date.now());
    } catch (error) {
      setHomeError(String(error));
    } finally {
      setHomeLoading(false);
    }
  }, [
    settings?.customThemeColor,
    settings?.homePageLocalPath,
    settings?.homePageMode,
    settings?.homePageUrl,
    settings?.themeMode,
  ]);

  useEffect(() => {
    void loadCustomHome();
  }, [loadCustomHome]);

  // PCL2 主页里的按钮会把动作发给启动器（打开网页 / 复制文本 / 刷新主页 /
  // 启动游戏），否则它们在这套外壳里什么也不会发生。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = homeFrameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const payload = event.data as
        | {
            source?: string;
            type?: string;
            eventType?: string;
            eventData?: string;
            x?: number;
            y?: number;
          }
        | null;
      if (!payload || payload.source !== "pcl-homepage") return;
      // PCL2 主页里的右键转成启动器自己的菜单，坐标要换算到启动器窗口。
      if (payload.type === "contextmenu") {
        const rect = frame.getBoundingClientRect();
        openMenuAt(
          menuAnchorHomeRef.current,
          rect.left + Number(payload.x ?? 0),
          rect.top + Number(payload.y ?? 0),
        );
        return;
      }
      if (payload.type !== "event") return;
      const eventType = String(payload.eventType ?? "").trim();
      const eventData = String(payload.eventData ?? "");
      switch (eventType) {
        case "打开网页":
          if (/^https?:\/\//i.test(eventData.trim())) {
            void openExternalUrl(eventData.trim());
          } else if (eventData.trim()) {
            onNotify?.("error", "链接无法打开", `地址需要以 http:// 或 https:// 开头：${eventData}`);
          }
          break;
        case "复制文本": {
          void navigator.clipboard?.writeText(eventData).then(
            () => onNotify?.("success", "已复制到剪贴板", eventData.slice(0, 60)),
            () => onNotify?.("info", "请手动复制", eventData),
          );
          break;
        }
        case "刷新主页":
          void loadCustomHome();
          break;
        case "启动游戏":
          onLaunch();
          break;
        default:
          if (eventType) {
            onNotify?.(
              "info",
              `主页动作「${eventType}」暂不支持`,
              "该动作依赖 PCL 内置逻辑，其余主页内容仍会正常显示。",
            );
          }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [loadCustomHome, onLaunch, onNotify, openMenuAt]);

  // Online pages can refresh on their own so a "latest news"-style home page
  // stays current without the player touching anything.
  useEffect(() => {
    const minutes = settings?.homePageRefreshMinutes ?? 0;
    if (homeMode !== "online" || minutes <= 0) return;
    const timer = window.setInterval(() => void loadCustomHome(), minutes * 60_000);
    return () => window.clearInterval(timer);
  }, [homeMode, settings?.homePageRefreshMinutes, loadCustomHome]);

  const activeNews = useMemo(
    () => news.find((entry) => entry.id === activeId) ?? news[0] ?? null,
    [news, activeId],
  );

  const installedVersion = installed.find((entry) => entry.id === selectedVersion);
  const isInstalled = Boolean(installedVersion);
  const isLaunching = runtime.status === "preparing";
  const isRunning = runtime.status === "running";
  const nameInvalid = !/^[A-Za-z0-9_]{1,16}$/.test(playerName.trim());
  const activeProgress = isLaunching ? launchProgress : null;
  const percent = activeProgress
    ? progressPercent(activeProgress.done, activeProgress.total)
    : null;

  const effectiveInstalled = isBedrock ? isBedrockInstalled : isInstalled;

  const statusTone = isRunning
    ? "live"
    : isLaunching || bedrockLaunching
      ? "pending"
      : effectiveInstalled
        ? "online"
        : "warn";
  const statusLabel = isRunning
    ? "游戏运行中"
    : isLaunching || bedrockLaunching
      ? activeProgress?.detail || runtime.detail || "正在检查运行环境…"
      : isBedrock
        ? isBedrockInstalled
          ? settings?.statusText?.trim() || "基岩版已就绪，随时出发"
          : "尚未下载安装此基岩版本"
        : isInstalled
          ? settings?.statusText?.trim() || "准备就绪，随时出发"
          : selectedVersion
            ? "此版本尚未安装"
            : "还没有可启动的版本";
  const launchLabel = isRunning
    ? "结束游戏"
    : isLaunching || bedrockLaunching
      ? "正在启动…"
      : isBedrock
        ? isBedrockInstalled
          ? settings?.launchButtonText?.trim() || "启动基岩版"
          : "下载基岩版"
        : isInstalled
          ? settings?.launchButtonText?.trim() || "启动游戏"
          : "下载游戏";

  /** Label of the big button; the right-click menu reuses it. */
  const primaryLabel = isRunning
    ? "停止运行"
    : isLaunching || bedrockLaunching
      ? "正在启动…"
      : isBedrock
        ? isBedrockInstalled
          ? settings?.launchButtonText?.trim() || "启动基岩版"
          : "获取并下载基岩版"
        : launchLabel;

  /** The big button and the launch menu run the same action. */
  const handlePrimaryAction = () => {
    if (isBedrock) {
      if (isBedrockInstalled) {
        void handleLaunchBedrock();
      } else {
        onOpenDownloadBedrock?.();
      }
    } else if (isRunning) {
      onStop();
    } else {
      onLaunch();
    }
  };

  return (
    <div className="relative z-10 h-full overflow-y-auto p-4 min-[900px]:overflow-hidden">
      <div className="grid min-h-full gap-4 min-[900px]:h-full min-[900px]:min-h-0 min-[900px]:grid-cols-[minmax(0,1fr)_338px]">
        {/* 自定义主页：空白 / 本地 HTML / 联网 HTML，占据新闻面板的位置 */}
        {homeMode !== "preset" ? (
          <section
            aria-label="自定义主页"
            className="flex min-h-[560px] flex-col overflow-hidden rounded-xl border border-border/70 bg-card/45 min-[900px]:min-h-0"
            onContextMenu={(event) => {
              event.preventDefault();
              openMenuAt(menuAnchorHomeRef.current, event.clientX, event.clientY);
            }}
          >
            {homeMode === "blank" ? (
              <div className="grid flex-1 place-items-center px-8 py-12 text-center">
                <div className="max-w-sm">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-border/70 bg-muted/20">
                    <SquareDashed className="size-4 text-muted-foreground" />
                  </div>
                  <h2 className="mt-4 text-[15px] font-medium">空白主页</h2>
                  <p className="mt-1.5 text-[11.5px] leading-5 text-muted-foreground">
                    主页内容已清空，右侧启动面板不受影响。
                  </p>
                  {onOpenSettings ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4 gap-2"
                      onClick={onOpenSettings}
                    >
                      <SlidersHorizontal className="size-3.5" />
                      自定义主页
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/60 px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60">
                      {homeMode === "local" ? (
                        <FileCode2 className="size-4 text-primary" />
                      ) : (
                        <CloudDownload className="size-4 text-primary" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                          {homeMode === "local" ? "本地自定义主页" : "在线自定义主页"}
                        </h1>
                        {homeCompat ? (
                          <span
                            className="shrink-0 rounded border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-[9.5px] font-medium text-primary"
                            title="已按 PCL2 主页（XAML）兼容模式渲染"
                          >
                            PCL 兼容
                          </span>
                        ) : null}
                        {homeCompat && homeWarnings.length > 0 ? (
                          <span
                            className="shrink-0 cursor-help rounded border border-gold/30 bg-gold/10 px-1.5 py-0.5 text-[9.5px] text-gold"
                            title={homeWarnings.join("\n")}
                          >
                            {homeWarnings.length} 项未兼容
                          </span>
                        ) : null}
                      </div>
                      <p
                        className="mt-0.5 truncate text-[10.5px] text-muted-foreground"
                        title={homeSource || undefined}
                      >
                        {homeSource || "尚未设置主页来源"}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <span className="hidden items-center gap-1.5 text-[10px] text-muted-foreground min-[1160px]:flex">
                      <StatusDot
                        tone={homeError ? "warn" : homeLoading ? "pending" : "online"}
                        animated={homeLoading}
                      />
                      {homeError
                        ? "同步失败"
                        : homeLoading
                          ? "正在加载"
                          : homeUpdatedLabel
                            ? `已更新 ${homeUpdatedLabel}`
                            : "等待加载"}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      onClick={() => void loadCustomHome()}
                      disabled={homeLoading}
                      aria-label="刷新自定义主页"
                      title="刷新自定义主页"
                    >
                      <RefreshCw className={cn("size-3.5", homeLoading && "animate-spin")} />
                    </Button>
                  </div>
                </header>

                <div className="relative min-h-0 flex-1 bg-background/40">
                  {homeLoading && !homeHtml ? (
                    <div className="grid h-full place-items-center">
                      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        正在加载自定义主页…
                      </div>
                    </div>
                  ) : homeError && !homeHtml ? (
                    <div className="grid h-full place-items-center px-8 py-12 text-center">
                      <div className="max-w-xs">
                        <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-gold/25 bg-gold/10">
                          <AlertTriangle className="size-4 text-gold" />
                        </div>
                        <h2 className="mt-4 text-[15px] font-medium">主页加载失败</h2>
                        <p className="mt-1.5 text-[11.5px] leading-5 text-muted-foreground">
                          {homeMode === "local"
                            ? "无法读取该 HTML 文件，请检查路径是否存在。"
                            : "无法获取该地址，请检查网络与链接是否可访问。"}
                        </p>
                        <p
                          className="mt-2 break-words font-mono text-[10px] text-muted-foreground/60"
                          title={homeError}
                        >
                          {homeError}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-4 gap-2"
                          onClick={() => void loadCustomHome()}
                        >
                          <RefreshCw className="size-3.5" />
                          重新加载
                        </Button>
                      </div>
                    </div>
                  ) : homeHtml ? (
                    <>
                      {homeError ? (
                        <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-gold/25 bg-gold/10 px-4 py-1.5 text-[10.5px] text-gold">
                          <AlertTriangle className="size-3.5 shrink-0" />
                          <span className="truncate">
                            刷新失败，正在显示上一次成功加载的内容：{homeError}
                          </span>
                        </div>
                      ) : null}
                      <iframe
                        ref={homeFrameRef}
                        title="自定义主页"
                        srcDoc={homeHtml}
                        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
                        referrerPolicy="no-referrer"
                        className="h-full w-full border-0 bg-transparent"
                      />
                    </>
                  ) : (
                    <div className="grid h-full place-items-center px-8 text-center">
                      <div className="max-w-sm">
                        <p className="text-[12.5px] text-muted-foreground">
                          {homeMode === "local"
                            ? "尚未选择本地 HTML 文件"
                            : "尚未填写在线主页地址"}
                        </p>
                        {onOpenSettings ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-3 gap-2"
                            onClick={onOpenSettings}
                          >
                            <SlidersHorizontal className="size-3.5" />
                            打开主页设置
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        ) : null}

        <section
          aria-label="我的世界更新新闻"
          className={cn(
            "flex min-h-[560px] flex-col overflow-hidden rounded-xl border border-border/70 bg-card/45 min-[900px]:min-h-0",
            homeMode !== "preset" && "hidden",
          )}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenuAt(menuAnchorHomeRef.current, event.clientX, event.clientY);
          }}
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/60 px-5 py-3.5">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60">
                <Newspaper className="size-4 text-primary" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
                  我的世界更新新闻
                </h1>
                <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                  Mojang 官方 Java 版更新日志
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="hidden items-center gap-1.5 text-[10px] text-muted-foreground min-[1160px]:flex">
                <StatusDot tone={newsError ? "warn" : "online"} />
                {newsError ? "同步失败" : "官方同步"}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={() => void loadNews(true)}
                disabled={newsLoading}
                aria-label="刷新更新新闻"
                title="刷新更新新闻"
              >
                <RefreshCw className={cn("size-3.5", newsLoading && "animate-spin")} />
              </Button>
            </div>
          </header>

          <div
            className="min-h-0 flex-1 overflow-y-auto"
            aria-busy={newsLoading && news.length === 0}
          >
            {newsLoading && news.length === 0 ? (
              <NewsSkeleton />
            ) : newsError && news.length === 0 ? (
              <div className="grid min-h-[420px] place-items-center px-8 py-12 text-center">
                <div className="max-w-xs">
                  <div className="mx-auto flex size-10 items-center justify-center rounded-lg border border-gold/25 bg-gold/10">
                    <AlertTriangle className="size-4 text-gold" />
                  </div>
                  <h2 className="mt-4 text-[15px] font-medium">更新新闻暂时不可用</h2>
                  <p className="mt-1.5 text-[11.5px] leading-5 text-muted-foreground">
                    无法连接 Mojang 更新服务。检查网络后重试，不影响启动游戏。
                  </p>
                  <p
                    className="mt-2 break-words font-mono text-[10px] text-muted-foreground/60"
                    title={newsError}
                  >
                    {newsError}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4 gap-2"
                    onClick={() => void loadNews(true)}
                  >
                    <RefreshCw className="size-3.5" />
                    重新加载
                  </Button>
                </div>
              </div>
            ) : activeNews ? (
              <>
                <article className="border-b border-border/60">
                  <div className="relative h-[260px] w-full overflow-hidden bg-muted">
                    <NewsCover note={activeNews} eager />
                    <div className="media-surface-fade pointer-events-none absolute inset-0" />
                    <div className="absolute inset-x-0 bottom-0 p-5">
                      <div className="flex flex-wrap items-center gap-2">
                        <TypeBadge
                          type={activeNews.type}
                          tone={isRelease(activeNews) ? "grass" : "gold"}
                          label={channelLabel(activeNews)}
                        />
                        <span className="font-mono text-[10px] text-white/70">
                          {activeNews.version}
                        </span>
                        <span className="h-3 w-px bg-white/20" />
                        <time
                          dateTime={activeNews.date || undefined}
                          className="text-[10.5px] text-white/60"
                        >
                          {formatDate(activeNews.date)}
                        </time>
                        <span className="ml-auto hidden text-[10px] text-white/45 sm:inline">
                          Java Edition
                        </span>
                      </div>
                      <h2
                        lang="en"
                        className="mt-2.5 line-clamp-2 max-w-[70ch] text-[22px] font-semibold leading-[1.18] tracking-[-0.02em] text-white text-balance"
                      >
                        {activeNews.title}
                      </h2>
                    </div>
                  </div>
                  {activeNews.summary ? (
                    <div className="px-5 py-3.5">
                      <p
                        lang="en"
                        className="line-clamp-2 max-w-[82ch] text-[12px] leading-5 text-muted-foreground"
                      >
                        {activeNews.summary}
                      </p>
                    </div>
                  ) : null}
                </article>

                <div className="p-2">
                  <div className="flex items-center justify-between gap-3 px-3 pb-1.5 pt-2">
                    <h2 className="text-[11px] font-medium text-muted-foreground">
                      最近更新
                    </h2>
                    <span className="font-mono text-[10px] text-muted-foreground/60">
                      {news.length} 条
                    </span>
                  </div>
                  <div className="flex flex-col">
                    {news.slice(0, 8).map((note) => {
                      const active = note.id === activeNews.id;
                      return (
                        <button
                          key={note.id}
                          type="button"
                          onClick={() => setActiveId(note.id)}
                          aria-current={active ? "true" : undefined}
                          className={cn(
                            "group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors",
                            "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/60",
                            active && "bg-accent/60",
                          )}
                        >
                          <div className="h-9 w-14 shrink-0 overflow-hidden rounded-[5px] border border-border/60 bg-background/60">
                            <NewsCover note={note} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p
                              lang="en"
                              className={cn(
                                "truncate text-[11.5px] text-foreground/85",
                                active && "text-foreground",
                              )}
                            >
                              {note.title}
                            </p>
                            <p className="mt-0.5 text-[10px] text-muted-foreground">
                              {channelLabel(note)}
                              <span className="mx-1.5 text-border">/</span>
                              {formatDate(note.date)}
                            </p>
                          </div>
                          {active ? (
                            <span
                              aria-hidden="true"
                              className="size-1.5 shrink-0 rounded-[1px] bg-primary"
                            />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                  <p className="px-3 pb-1 pt-2.5 text-[9.5px] text-muted-foreground/60">
                    来自 Mojang 官方更新日志，保留英文原文。
                  </p>
                </div>
              </>
            ) : (
              <div className="grid min-h-[420px] place-items-center px-8 text-center">
                <div>
                  <p className="text-[13px] text-muted-foreground">暂无更新新闻</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 gap-2"
                    onClick={() => void loadNews(true)}
                  >
                    <RefreshCw className="size-3.5" />
                    重新加载
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        <aside
          className="flex min-h-[560px] flex-col overflow-y-auto rounded-xl border border-border/70 bg-card/45 p-5 min-[900px]:min-h-0"
          onContextMenu={(event) => {
            event.preventDefault();
            openMenuAt(menuAnchorLaunchRef.current, event.clientX, event.clientY);
          }}
        >
          {/* Unified Player Profile */}
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png"
              className="hidden"
              onChange={handleBrowserFileChange}
            />
            <div
              role={isOffline ? "button" : undefined}
              tabIndex={isOffline ? 0 : undefined}
              onClick={isOffline ? () => void handleUploadSkin() : undefined}
              onKeyDown={
                isOffline
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        void handleUploadSkin();
                      }
                    }
                  : undefined
              }
              className={cn(
                "group relative size-[168px] overflow-hidden rounded-xl border border-border/80 media-surface grass-glow select-none transition-all",
                isOffline &&
                  "cursor-pointer hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
              )}
              title={
                isOffline
                  ? "点击上传自定义皮肤 (PNG)"
                  : "在线账户暂不支持本地皮肤上传"
              }
            >
              <Avatar
                name={account?.signedIn ? account.name : playerName}
                size={168}
                className="size-full transition-transform duration-300 group-hover:scale-105"
                skinType={account?.signedIn ? "mojang" : settings?.offlineSkinType}
                customSkinPath={settings?.customSkinPath}
                mojangSkinName={
                  account?.signedIn ? account.name : settings?.mojangSkinName
                }
              />
              <span className="pointer-events-none absolute bottom-2 left-2 rounded border border-white/10 bg-black/60 px-1.5 py-0.5 text-[9px] font-medium text-white/80 backdrop-blur-sm">
                {isOffline ? "离线档案" : "在线档案"}
              </span>

              {isOffline ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/60 backdrop-blur-[2px] opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                  <div className="rounded-full bg-primary/25 p-2 text-primary ring-1 ring-primary/50">
                    <Camera className="size-5" />
                  </div>
                  <span className="text-[12px] font-medium text-white shadow-sm">
                    点击上传皮肤
                  </span>
                  <span className="text-[9.5px] text-white/70">
                    支持 64×64 PNG
                  </span>
                </div>
              ) : null}
            </div>

            {isOffline && settings?.offlineSkinType === "custom" ? (
              <button
                type="button"
                onClick={() => {
                  onUpdateSettings?.({
                    offlineSkinType: "random",
                    customSkinPath: undefined,
                  });
                  onNotify?.("info", "已恢复默认皮肤", "离线皮肤已重置为默认随机。");
                }}
                className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                title="恢复为默认随机皮肤"
              >
                <RotateCcw className="size-3" />
                <span>恢复默认皮肤</span>
              </button>
            ) : null}

            <div className="mt-3.5 min-w-0">
              <p className="truncate text-[19px] font-semibold leading-tight tracking-[-0.01em]">
                {account?.signedIn ? account.name : playerName.trim() || "未命名玩家"}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <span className="size-1.5 rounded-[1px] bg-primary/80" />
                {account?.signedIn
                  ? `正版账户 · Java 与基岩版共用 · XUID ${account.xuid || "—"}`
                  : settings?.customSlogan?.trim() || "本地玩家档案 · Java 与基岩版混用共存"}
              </p>
            </div>
          </div>

          <div className="flex-1" />

          <div className="space-y-3 pt-6">
            <div
              className="flex items-center justify-between gap-3 px-0.5 text-[11px]"
              aria-live="polite"
            >
              <span
                className={cn(
                  "flex min-w-0 items-center gap-2 text-muted-foreground",
                  isRunning && "text-primary",
                )}
              >
                <StatusDot
                  tone={statusTone}
                  animated={isLaunching || bedrockLaunching}
                  className="shrink-0"
                />
                <span className="truncate">{statusLabel}</span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/80">
                {displayVersion}
              </span>
            </div>

            {/* Login Mode dropdown */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-11 w-full justify-between rounded-lg border-border/80 bg-background/35 px-3.5 font-normal"
                >
                  <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <LogIn className="size-3.5" />
                    登录方式
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-foreground">
                    <span className="truncate">
                      {account?.signedIn ? account.name : "离线账户"}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                side="top"
                className="w-[var(--radix-dropdown-menu-trigger-width)]"
              >
                <DropdownMenuLabel className="text-[10px] font-normal text-muted-foreground">
                  选择登录方式
                </DropdownMenuLabel>
                <DropdownMenuItem className="gap-2.5" disabled={Boolean(account?.signedIn)}>
                  {account?.signedIn ? (
                    <span className="size-3.5 rounded-full border border-muted-foreground/40" />
                  ) : (
                    <Check className="size-3.5 text-primary" />
                  )}
                  离线账户
                  <span className="ml-auto text-[9px] text-muted-foreground/70">
                    {account?.signedIn ? "退出登录后生效" : "当前"}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="gap-2.5"
                  onSelect={() => onOpenAccount?.()}
                >
                  {account?.signedIn ? (
                    <Check className="size-3.5 text-primary" />
                  ) : (
                    <span className="size-3.5 rounded-full border border-muted-foreground/40" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {account?.signedIn ? account.name : "微软账户"}
                  </span>
                  {account?.signedIn ? (
                    <span className="ml-auto flex shrink-0 items-center gap-1">
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-4 px-1.5 text-[9px] font-normal",
                          account.entitlements.java
                            ? "border-primary/40 text-primary"
                            : "border-border/80 text-muted-foreground/70",
                        )}
                      >
                        Java
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          "h-4 px-1.5 text-[9px] font-normal",
                          account.entitlements.bedrock
                            ? "border-primary/40 text-primary"
                            : "border-border/80 text-muted-foreground/70",
                        )}
                      >
                        基岩版
                      </Badge>
                    </span>
                  ) : (
                    <span className="ml-auto text-[9px] text-muted-foreground/70">
                      点击登录
                    </span>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Player name input */}
            <div className="space-y-1.5">
              <label className="sr-only" htmlFor="home-player-name">
                名称
              </label>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="home-player-name"
                  value={account?.signedIn ? account.name : playerName}
                  onChange={(event) =>
                    account?.signedIn ? undefined : onPlayerNameChange(event.target.value.slice(0, 16))
                  }
                  placeholder={account?.signedIn ? "正版账户名称" : "名称"}
                  maxLength={16}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={Boolean(account?.signedIn)}
                  readOnly={Boolean(account?.signedIn)}
                  title={account?.signedIn ? "使用正版账户时不可自定义角色名称" : undefined}
                  aria-invalid={!account?.signedIn && nameInvalid}
                  aria-describedby={!account?.signedIn && nameInvalid ? "home-name-error" : undefined}
                  className="h-11 rounded-lg border-border/80 bg-background/35 pl-9 pr-3 text-[13px] disabled:cursor-not-allowed disabled:opacity-70"
                />
              </div>
              {!account?.signedIn && nameInvalid ? (
                <p id="home-name-error" className="px-0.5 text-[10px] text-destructive">
                  使用 1–16 位字母、数字或下划线
                </p>
              ) : null}
            </div>


            {/* Unified Big Play Button */}
            <div className="relative">
              <Button
                type="button"
                size="lg"
                variant={isRunning ? "outline" : "default"}
                onClick={handlePrimaryAction}
                disabled={
                  (isLaunching ||
                    bedrockLaunching ||
                    (!isBedrock && !account?.signedIn && nameInvalid)) &&
                  !isRunning
                }
                className={cn(
                  "h-16 w-full rounded-xl text-[16px] font-semibold tracking-[-0.01em]",
                  isRunning
                    ? "border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
                    : "shadow-[0_18px_44px_-24px_var(--primary)]",
                  (isLaunching || bedrockLaunching) && "disabled:opacity-100",
                )}
              >
                {isLaunching || bedrockLaunching ? (
                  <LoaderCircle className="size-5 animate-spin" />
                ) : isRunning ? (
                  <Square className="size-4 fill-current" />
                ) : (
                  <Play className="size-5 fill-current" />
                )}
                {primaryLabel}
              </Button>
              {isLaunching ? (
                <Progress
                  value={percent ?? 30}
                  aria-label="启动进度"
                  className={cn(
                    "pointer-events-none absolute inset-x-4 bottom-2 h-0.5 bg-primary-foreground/20",
                    "[&_[data-slot=progress-indicator]]:bg-primary-foreground",
                    percent === null && "animate-pulse",
                  )}
                />
              ) : null}
            </div>

            {/* Quick action buttons. Version settings only make sense for a
                version that exists on disk: the launcher preselects the newest
                release from the version manifest, which may never have been
                downloaded, and with nothing installed there is nothing to
                configure. */}
            <div
              className={cn(
                "grid gap-2.5",
                effectiveInstalled ? "grid-cols-2" : "grid-cols-1",
              )}
            >
              <Button
                variant="outline"
                className="h-11 justify-start gap-2 rounded-lg border-border/80 bg-background/35 px-3 text-[12px] font-normal"
                onClick={onOpenVersionSelect}
              >
                <Layers3 className="size-3.5 text-muted-foreground" />
                版本选择
              </Button>

              {effectiveInstalled ? (
                <Button
                  variant="outline"
                  className="h-11 justify-start gap-2 rounded-lg border-border/80 bg-background/35 px-3 text-[12px] font-normal"
                  onClick={onOpenVersionSettings}
                >
                  <SlidersHorizontal className="size-3.5 text-muted-foreground" />
                  版本设置
                </Button>
              ) : null}
            </div>

            {/* Unified Stats Footer */}
            <div className="mt-2 rounded-lg border border-border/60 bg-background/30 p-2.5 text-[11px] text-muted-foreground flex items-center justify-between">
              <span>Java 版本: <strong className="text-foreground">{installed.length}</strong></span>
              <span>基岩版: <strong className="text-foreground">{bedrockStatus?.uwpInstalled ? "UWP 已就绪" : `${bedrockStatus?.installedVersions.length ?? 0} 个核心`}</strong></span>
              <span>附加包: <strong className="text-foreground">{(bedrockStatus?.resourcePacksCount ?? 0) + (bedrockStatus?.behaviorPacksCount ?? 0)}</strong></span>
            </div>
          </div>
        </aside>
      </div>

      {/* 右键菜单：锚点是不可见的零尺寸元素，菜单在指针位置弹出 */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={menuAnchorHomeRef}
            aria-hidden="true"
            className="pointer-events-none fixed top-0 left-0 z-50 size-0"
          />
        </ContextMenuTrigger>
        <HomePageContextMenu
          mode={homeMode}
          source={homeSource}
          loading={homeMode === "preset" ? newsLoading : homeLoading}
          activeTitle={activeNews?.title ?? null}
          onRefresh={() => {
            if (homeMode === "preset") void loadNews(true);
            else void loadCustomHome();
          }}
          onChangeMode={(mode) => onUpdateSettings?.({ homePageMode: mode })}
          onOpenSettings={onOpenSettings}
          onNotify={onNotify}
        />
      </ContextMenu>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={menuAnchorLaunchRef}
            aria-hidden="true"
            className="pointer-events-none fixed top-0 left-0 z-50 size-0"
          />
        </ContextMenuTrigger>
        <LaunchContextMenu
          primaryLabel={primaryLabel}
          running={isRunning}
          busy={isLaunching || bedrockLaunching}
          installed={effectiveInstalled}
          isOffline={isOffline}
          signedIn={Boolean(account?.signedIn)}
          playerLabel={account?.signedIn ? account.name : playerName.trim() || "未命名玩家"}
          onPrimaryAction={handlePrimaryAction}
          onOpenVersionSelect={onOpenVersionSelect}
          onOpenVersionSettings={onOpenVersionSettings}
          onOpenAccount={onOpenAccount}
          onUploadSkin={() => void handleUploadSkin()}
          onOpenSettings={onOpenSettings}
          onNotify={onNotify}
        />
      </ContextMenu>
    </div>
  );
}
