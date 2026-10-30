import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { getCurrentWindow } from "@/lib/desktop";
import { Sidebar, TitleBar } from "./components/Chrome";
import { DownloadCatalogView } from "./components/DownloadCatalogView";
import { DownloadsView, type DownloadFileEvent } from "./components/DownloadsView";
import { HomeView } from "./components/HomeView";
import { MultiplayerView } from "./components/MultiplayerView";
import { SettingsView } from "./components/SettingsView";
import { VersionInstallView } from "./components/VersionInstallView";
import { VersionSelectView } from "./components/VersionSelectView";
import { VersionSettingsView } from "./components/VersionSettingsView";
import type { LogEntry } from "./components/Console";
import { Toaster } from "./components/ui/sonner";
import { toast } from "sonner";
import {
  cancelInstall,
  deleteBedrockVersion,
  deleteVersion,
  detectJava,
  getInstalledVersions,
  getMsAccount,
  getMultiplayerInstallState,
  getSystemInfo,
  getVersionManifest,
  installBedrockVersion,
  installEasytier,
  installVersion,
  isDesktop,
  launchBedrock,
  launchGame,
  openFolderPath,
  readSkinAsDataUrl,
  setBedrockAccountMode,
  setDownloadPreference,
  stopGame,
  subscribe,
} from "./lib/backend";
import { AccountDialog } from "./components/AccountDialog";
import { applyThemeToDom } from "./lib/theme";
import { timeNow } from "./lib/format";
import { loadSettings, saveSettings } from "./lib/settings";
import {
  loadVersionSettings,
  resolveVersionLaunchSettings,
  saveVersionSettings,
  type VersionLaunchSettings,
} from "./lib/versionSettings";
import type {
  BackgroundDownloadTask,
  BedrockVersionItem,
  DownloadHistoryRecord,
  GameEdition,
  GameStateName,
  InstallProgress,
  InstalledVersion,
  JavaInstall,
  LauncherSettings,
  LauncherVisibility,
  LoaderSelection,
  MsAccount,
  MultiplayerInstallState,
  SystemInfo,
  VersionManifest,
  VersionSummary,
  ViewId,
} from "./lib/types";

interface RuntimeView {
  status: GameStateName;
  detail?: string | null;
  pid?: number | null;
  versionId?: string | null;
}

const MAX_LOGS = 1500;
const MAX_FILE_EVENTS = 180;
const HISTORY_STORAGE_KEY = "cobble.download-history.v1";

/** EasyTier 安装任务转换成下载管理器里的一条后台任务。 */
function toBackgroundDownloadTask(
  state: MultiplayerInstallState,
): BackgroundDownloadTask | null {
  if (!state.stage) return null;
  const finished = state.stage === "done" || state.stage === "error" || state.stage === "paused";
  if (!state.active && !finished) return null;
  const status: BackgroundDownloadTask["status"] = state.active
    ? "running"
    : state.stage === "error"
      ? "error"
      : state.stage === "paused"
        ? "paused"
        : "done";
  return {
    ...state,
    id: "easytier",
    title: "EasyTier 内核",
    status,
  };
}

function loadDownloadHistory(): DownloadHistoryRecord[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DownloadHistoryRecord[]).slice(0, 40) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [settings, setSettings] = useState<LauncherSettings>(loadSettings);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [manifest, setManifest] = useState<VersionManifest | null>(null);
  const [installed, setInstalled] = useState<InstalledVersion[]>([]);
  const [javaInstalls, setJavaInstalls] = useState<JavaInstall[]>([]);
  const [javaDetecting, setJavaDetecting] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [account, setAccount] = useState<MsAccount | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [installTarget, setInstallTarget] = useState<VersionSummary | null>(null);
  const [view, setView] = useState<ViewId>("home");
  const [manifestLoading, setManifestLoading] = useState(true);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [installingVersion, setInstallingVersion] = useState<string | null>(null);
  const [installQueue, setInstallQueue] = useState<
    Array<{ versionId: string; selection?: LoaderSelection }>
  >(() => {
    try {
      const saved = localStorage.getItem("cobble.saved-queue");
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {}
    return [];
  });
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  const [lastInstallProgress, setLastInstallProgress] = useState<InstallProgress | null>(
    null,
  );
  const [peakSpeedBps, setPeakSpeedBps] = useState(0);
  const [speedHistory, setSpeedHistory] = useState<number[]>([]);
  const [fileEvents, setFileEvents] = useState<DownloadFileEvent[]>([]);
  const [downloadHistory, setDownloadHistory] =
    useState<DownloadHistoryRecord[]>(loadDownloadHistory);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundDownloadTask[]>([]);
  const [launchProgress, setLaunchProgress] = useState<InstallProgress | null>(null);
  const [runtime, setRuntime] = useState<RuntimeView>({ status: "idle" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [versionSettings, setVersionSettings] = useState(loadVersionSettings);
  const activeVisibilityRef = useRef<LauncherVisibility>("keep");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("cobble.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });

  const [edition, setEdition] = useState<GameEdition>(() => {
    try {
      const saved = localStorage.getItem("cobble.selected-edition");
      if (saved === "bedrock" || saved === "java") return saved;
    } catch {}
    return "java";
  });

  const [selectedBedrockVersion, setSelectedBedrockVersion] = useState<string>(() => {
    try {
      return localStorage.getItem("cobble.selected-bedrock") || "uwp";
    } catch {}
    return "uwp";
  });

  const handleEditionChange = (ed: GameEdition) => {
    setEdition(ed);
    try {
      localStorage.setItem("cobble.selected-edition", ed);
    } catch {}
  };

  const handleSelectBedrockVersion = (verId: string) => {
    setSelectedBedrockVersion(verId);
    try {
      localStorage.setItem("cobble.selected-bedrock", verId);
    } catch {}
  };

  const handleSelectVersion = useCallback(
    (versionId: string) => {
      setSelectedVersion(versionId);
      try {
        localStorage.setItem("cobble.selected-version", versionId);
      } catch {}
      const isBedrock =
        versionId === "uwp" ||
        versionId === "bedrock-uwp" ||
        versionId.startsWith("bedrock:") ||
        versionId.startsWith("bedrock-") ||
        versionId.includes("基岩版");
      if (isBedrock) {
        handleEditionChange("bedrock");
        if (versionId.startsWith("bedrock:")) {
          handleSelectBedrockVersion(versionId.replace(/^bedrock:/, ""));
        } else if (versionId === "uwp") {
          handleSelectBedrockVersion("uwp");
        }
      } else {
        handleEditionChange("java");
      }
    },
    [],
  );

  const settingsRef = useRef(settings);
  const versionSettingsRef = useRef(versionSettings);
  const logId = useRef(0);
  const fileEventId = useRef(0);
  const lastDetailRef = useRef("");
  const peakSpeedRef = useRef(0);
  const latestProgressRef = useRef<InstallProgress | null>(null);
  const lastRoot = useRef(settings.gameRoot);
  const contentRef = useRef<HTMLElement>(null);
  const [bgDataUrl, setBgDataUrl] = useState<string | null>(null);

  // 主页有启动器自己的右键菜单，其他区域也不再需要 WebView 的刷新/另存为菜单；
  // 输入框保留系统菜单，否则复制、粘贴都会失效。
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    applyThemeToDom(settings);
  }, [
    settings.customThemeColor,
    settings.themeMode,
    settings.fontFamily,
    settings.fontWeight,
    settings.letterSpacing,
    settings.enableAnimation,
    settings.uiOpacity,
  ]);

  // Declared before the account effects below: a failed token renewal has to
  // surface as a toast, and toasts are shared by the whole app.
  const pushToast = useCallback(
    (tone: "success" | "error" | "info", title: string, detail?: string) => {
      const options = {
        description: detail,
        duration: tone === "error" ? 8000 : 5000,
      };
      if (tone === "success") toast.success(title, options);
      else if (tone === "error") toast.error(title, options);
      else toast.info(title, options);
    },
    [],
  );

  // The account decides which Bedrock core a launch may use, so the preference
  // is pushed once here instead of at every launch button.
  useEffect(() => {
    setBedrockAccountMode(Boolean(account?.signedIn));
  }, [account]);

  // Pick up an already signed-in account on startup; the backend renews the
  // session when it aged out (and reports why when it could not).
  useEffect(() => {
    let alive = true;
    getMsAccount(settings.msClientId || undefined)
      .then((value) => {
        if (!alive) return;
        setAccount(value);
        if (value?.sessionError) {
          pushToast("info", `${value.name} 的登录状态需要刷新`, value.sessionError);
        }
      })
      .catch((error) => console.warn("无法读取 Microsoft 账户", error));
    return () => {
      alive = false;
    };
  }, [settings.msClientId, pushToast]);

  // The mirror preference is process state on the Rust side: push it whenever
  // it changes so downloads really start from the selected source.
  useEffect(() => {
    setDownloadPreference(
      settings.downloadSource,
      settings.customSourceUrl || "",
      settings.downloadThreads,
    ).catch((error) => {
      console.warn("无法同步下载设置", error);
    });
  }, [settings.downloadSource, settings.customSourceUrl, settings.downloadThreads]);

  useEffect(() => {
    let alive = true;
    if (settings.backgroundType === "custom" && settings.customBackgroundPath) {
      if (
        settings.customBackgroundPath.startsWith("data:") ||
        settings.customBackgroundPath.startsWith("http")
      ) {
        setBgDataUrl(settings.customBackgroundPath);
      } else {
        readSkinAsDataUrl(settings.customBackgroundPath)
          .then((url) => {
            if (alive) setBgDataUrl(url);
          })
          .catch(() => {
            if (alive) setBgDataUrl(null);
          });
      }
    } else {
      setBgDataUrl(null);
    }
    return () => {
      alive = false;
    };
  }, [settings.backgroundType, settings.customBackgroundPath]);

  const activeInstallParamsRef = useRef<{
    versionId: string;
    selection?: LoaderSelection;
    edition: "java" | "bedrock";
    bedrockVersionItem?: BedrockVersionItem;
    apiSource?: string;
  } | null>(null);
  const isPausedByUserRef = useRef(false);
  const isCancelledByUserRef = useRef(false);
  const installQueueRef = useRef(installQueue);

  useEffect(() => {
    installQueueRef.current = installQueue;
    try {
      if (installQueue.length > 0) {
        localStorage.setItem("cobble.saved-queue", JSON.stringify(installQueue));
      } else {
        localStorage.removeItem("cobble.saved-queue");
      }
    } catch {}
  }, [installQueue]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      const currentTask = activeInstallParamsRef.current;
      if (currentTask) {
        const snap = latestProgressRef.current;
        const targetName =
          currentTask.edition === "bedrock"
            ? currentTask.versionId
            : currentTask.selection?.instanceName?.trim() || currentTask.versionId;
        const pausedRecord: DownloadHistoryRecord = {
          id: `paused-${targetName}-${Date.now()}`,
          versionId: targetName,
          status: "paused",
          threads: settingsRef.current.downloadThreads,
          totalFiles: snap?.total || 1,
          totalBytes: snap?.totalBytes || snap?.downloadedBytes || 0,
          downloadedBytes: snap?.downloadedBytes || 0,
          peakSpeedBps: peakSpeedRef.current,
          durationMs: 0,
          finishedAt: timeNow(),
          selection: currentTask.selection,
          edition: currentTask.edition,
          bedrockVersionItem: currentTask.bedrockVersionItem,
          apiSource: currentTask.apiSource,
          pausedReason: "软件关闭自动暂停",
        };
        try {
          const stored: DownloadHistoryRecord[] = JSON.parse(
            localStorage.getItem(HISTORY_STORAGE_KEY) || "[]",
          );
          const filtered = stored.filter((r) => r.versionId !== targetName);
          localStorage.setItem(
            HISTORY_STORAGE_KEY,
            JSON.stringify([pausedRecord, ...filtered].slice(0, 40)),
          );
        } catch {}
        void cancelInstall();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    versionSettingsRef.current = versionSettings;
    saveVersionSettings(versionSettings);
  }, [versionSettings]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(downloadHistory));
    } catch {
      // Ignore storage errors for download history.
    }
  }, [downloadHistory]);

  useEffect(() => {
    try {
      localStorage.setItem("cobble.sidebar.collapsed", sidebarCollapsed ? "1" : "0");
    } catch {
      // Collapsing the sidebar is cosmetic; ignore storage failures.
    }
  }, [sidebarCollapsed]);

  /** 内核/组件类下载统一记录在这里，下载页只读这一份状态。 */
  const applyBackgroundTask = useCallback((state: MultiplayerInstallState) => {
    const task = toBackgroundDownloadTask(state);
    if (!task) return;
    setBackgroundTasks((current) => {
      const others = current.filter((item) => item.id !== task.id);
      return [...others, task].sort((a, b) => a.startedAt - b.startedAt);
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    getMultiplayerInstallState(settingsRef.current.gameRoot)
      .then((state) => {
        if (!disposed) applyBackgroundTask(state);
      })
      .catch((error) => console.warn("无法读取 EasyTier 安装状态", error));
    return () => {
      disposed = true;
    };
  }, [applyBackgroundTask]);

  const handleRetryBackgroundTask = useCallback(
    async (id: string) => {
      if (id !== "easytier") return;
      try {
        const next = await installEasytier(settingsRef.current.gameRoot);
        pushToast("success", "EasyTier 内核已就绪", next.version ?? undefined);
      } catch (error) {
        pushToast("error", "下载 EasyTier 失败", String(error));
      }
    },
    [pushToast],
  );

  const pushLog = useCallback((stream: string, line: string) => {
    const entry: LogEntry = { id: ++logId.current, stream, line, at: timeNow() };
    setLogs((current) => [...current, entry].slice(-MAX_LOGS));
  }, []);

  const refreshManifest = useCallback(
    async (root?: string, force = false) => {
      const target = root ?? settingsRef.current.gameRoot;
      if (!target) return;
      setManifestLoading(true);
      setManifestError(null);
      try {
        const next = await getVersionManifest(target, force);
        setManifest(next);
      } catch (error) {
        setManifestError(String(error));
      } finally {
        setManifestLoading(false);
      }
    },
    [],
  );

  const refreshInstalled = useCallback(
    async (root?: string) => {
      const target = root ?? settingsRef.current.gameRoot;
      if (!target) return [] as InstalledVersion[];
      try {
        const next = await getInstalledVersions(target);
        setInstalled(next);
        return next;
      } catch (error) {
        pushToast("error", "读取已安装版本失败", String(error));
        return [] as InstalledVersion[];
      }
    },
    [pushToast],
  );

  const detectJavaForRoot = useCallback(async (root: string) => {
    if (!root) {
      setJavaDetecting(false);
      return [] as JavaInstall[];
    }
    setJavaDetecting(true);
    try {
      const installs = await detectJava(root);
      setJavaInstalls(installs);
      return installs;
    } catch {
      return [] as JavaInstall[];
    } finally {
      setJavaDetecting(false);
    }
  }, []);

  const refreshJava = useCallback(async () => {
    const root = settingsRef.current.gameRoot;
    setJavaDetecting(true);
    try {
      const installs = await detectJava(root);
      setJavaInstalls(installs);
      pushToast(
        "success",
        "Java 检测完成",
        installs.length
          ? `找到 ${installs.length} 个运行时，最高 Java ${installs[0]?.major}。`
          : "没有找到 Java，首次启动会自动下载 Temurin JRE。",
      );
    } catch (error) {
      pushToast("error", "Java 检测失败", String(error));
    } finally {
      setJavaDetecting(false);
    }
  }, [pushToast]);

  // Boot: system info provides the default game directory.
  useEffect(() => {
    let alive = true;
    getSystemInfo()
      .then((info) => {
        if (!alive) return;
        setSystemInfo(info);
        setJavaInstalls((current) => (current.length ? current : info.javaInstalls));
        setSettings((current) =>
          current.gameRoot.trim() ? current : { ...current, gameRoot: info.defaultRoot },
        );
      })
      .catch((error) => {
        if (alive) pushToast("error", "无法读取系统信息", String(error));
      });
    return () => {
      alive = false;
    };
  }, [pushToast]);

  // Reload versions whenever the game directory changes.
  useEffect(() => {
    if (!settings.gameRoot) return;
    if (lastRoot.current !== settings.gameRoot) {
      lastRoot.current = settings.gameRoot;
      setInstalled([]);
      setManifest(null);
      setSelectedVersion("");
      setJavaInstalls([]);
      void detectJavaForRoot(settings.gameRoot);
    }
    void refreshManifest(settings.gameRoot);
    void refreshInstalled(settings.gameRoot);
  }, [settings.gameRoot, refreshInstalled, refreshManifest, detectJavaForRoot]);

  // Pick a sensible default instance once data arrives.
  useEffect(() => {
    if (selectedVersion) return;
    if (installed.length > 0) {
      setSelectedVersion(installed[0].id);
    } else if (manifest) {
      setSelectedVersion(manifest.latest.release);
    }
  }, [installed, manifest, selectedVersion]);

  // Wire up backend events once.
  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const track = (promise: Promise<() => void>) => {
      promise
        .then((cleanup) => {
          if (disposed) cleanup();
          else cleanups.push(cleanup);
        })
        .catch((error) => {
          console.error("event subscription failed", error);
        });
    };

    track(
      subscribe("install:progress", (progress) => {
        setInstallProgress(progress);
        setLastInstallProgress(progress);
        latestProgressRef.current = progress;

        const speed = progress.speedBps ?? 0;
        if (speed > 0) {
          if (speed > peakSpeedRef.current) {
            peakSpeedRef.current = speed;
          }
          setPeakSpeedBps((prev) => Math.max(prev, speed));
          setSpeedHistory((prev) => [...prev.slice(-23), speed]);
        }

        const detailKey = `${progress.stage}:${progress.detail}`;
        if (progress.detail && detailKey !== lastDetailRef.current) {
          lastDetailRef.current = detailKey;
          const ev: DownloadFileEvent = {
            id: ++fileEventId.current,
            time: timeNow(),
            versionId: progress.versionId,
            stage: progress.stage,
            detail: progress.detail,
            speedBps: speed,
          };
          setFileEvents((prev) => [ev, ...prev].slice(0, MAX_FILE_EVENTS));
        }

        if (progress.stage === "java" || progress.stage === "launch") {
          setLaunchProgress(progress);
        }
      }),
    );
    track(
      subscribe("game:log", (payload) => {
        pushLog(payload.stream, payload.line);
      }),
    );
    track(
      subscribe("game:status", (status) => {
        setRuntime({
          status: status.state,
          detail: status.detail,
          pid: status.pid,
          versionId: status.versionId,
        });
        if (status.state !== "preparing") {
          setLaunchProgress(null);
        }
        if (status.state === "running" && isDesktop) {
          const vis = activeVisibilityRef.current;
          if (vis === "close") {
            try {
              void getCurrentWindow().close();
            } catch {}
          } else if (vis === "hide") {
            try {
              void getCurrentWindow().hide();
            } catch {}
          }
        } else if (status.state === "idle" && isDesktop && activeVisibilityRef.current === "hide") {
          try {
            const win = getCurrentWindow();
            void win.show();
            void win.setFocus();
          } catch {}
        }
      }),
    );
    track(
      subscribe("game:exit", (payload) => {
        setLaunchProgress(null);
        if (isDesktop && activeVisibilityRef.current === "hide") {
          try {
            const win = getCurrentWindow();
            void win.show();
            void win.setFocus();
          } catch {}
        }
        if (payload.code !== null && payload.code !== 0) {
          pushToast(
            "error",
            "游戏异常退出",
            `进程返回代码 ${payload.code}。查看运行日志定位问题。`,
          );
        }
        void refreshInstalled();
      }),
    );

    track(
      subscribe("multiplayer:install", (state) => {
        applyBackgroundTask(state);
      }),
    );

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [applyBackgroundTask, pushLog, pushToast, refreshInstalled]);

  const bestJava = useMemo(() => {
    if (settings.javaPath) {
      return javaInstalls.find((java) => java.path === settings.javaPath) ?? null;
    }
    return javaInstalls[0] ?? null;
  }, [javaInstalls, settings.javaPath]);

  const effectiveLaunchSettings = useMemo(
    () => resolveVersionLaunchSettings(settings, versionSettings, selectedVersion),
    [selectedVersion, settings, versionSettings],
  );
  const hasVersionOverride = Boolean(
    selectedVersion && versionSettings[selectedVersion],
  );

  const updateVersionLaunchSettings = useCallback(
    (patch: Partial<VersionLaunchSettings>) => {
      if (!selectedVersion) return;
      setVersionSettings((current) => {
        const base = resolveVersionLaunchSettings(
          settingsRef.current,
          current,
          selectedVersion,
        );
        return {
          ...current,
          [selectedVersion]: { ...base, ...patch },
        };
      });
    },
    [selectedVersion],
  );

  const resetVersionLaunchSettings = useCallback(() => {
    if (!selectedVersion) return;
    setVersionSettings((current) => {
      const next = { ...current };
      delete next[selectedVersion];
      return next;
    });
  }, [selectedVersion]);

  const openVersionSettings = useCallback((versionId: string) => {
    setSelectedVersion(versionId);
    setView("version-settings");
  }, []);

  const handleDeleteVersion = useCallback(
    async (versionId: string, edition: "java" | "bedrock") => {
      try {
        if (edition === "java") {
          await deleteVersion(settings.gameRoot, versionId);
          setVersionSettings((curr) => {
            const next = { ...curr };
            delete next[versionId];
            return next;
          });
          pushToast("success", "已成功删除版本", `Java 版本 ${versionId} 目录已彻底移除。`);
          await refreshInstalled(settings.gameRoot);
          if (selectedVersion === versionId) {
            setSelectedVersion("");
          }
        } else {
          await deleteBedrockVersion(versionId, settings.gameRoot);
          pushToast("success", "已成功删除基岩版核心", `基岩版核心 ${versionId} 目录已彻底移除。`);
          if (selectedBedrockVersion === versionId) {
            setSelectedBedrockVersion("uwp");
          }
        }
      } catch (err) {
        pushToast("error", "删除版本失败", String(err));
      }
    },
    [settings.gameRoot, selectedVersion, selectedBedrockVersion, pushToast, refreshInstalled],
  );

  const handleInstall = useCallback(
    async (versionId: string, selection?: LoaderSelection) => {
      if (installingVersion) {
        setInstallQueue((prev) => [...prev, { versionId, selection }]);
        const targetId = selection?.instanceName?.trim() || versionId;
        pushToast(
          "info",
          "已加入安装队列",
          `正在安装 ${installingVersion}，已将 ${targetId} 放入队列（排队第 ${installQueue.length + 1} 位）。`,
        );
        return;
      }
      const root = settingsRef.current.gameRoot;
      if (!root) {
        pushToast("error", "游戏目录为空", "请先在设置中选择游戏目录。");
        setView("settings");
        return;
      }
      const targetId = selection?.instanceName?.trim() || versionId;
      const threads = settingsRef.current.downloadThreads;
      const startedAt = Date.now();
      peakSpeedRef.current = 0;
      setPeakSpeedBps(0);
      setSpeedHistory([]);
      setInstallingVersion(targetId);
      activeInstallParamsRef.current = {
        versionId,
        selection,
        edition: "java",
      };
      isPausedByUserRef.current = false;
      isCancelledByUserRef.current = false;

      const initialProgress: InstallProgress = {
        versionId: targetId,
        stage: "prepare",
        done: 0,
        total: selection?.loaderType || selection?.optifineVersion ? 4 : 3,
        detail: "准备下载",
        downloadedBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        threads,
        activeThreads: 1,
      };
      setInstallProgress(initialProgress);
      setLastInstallProgress(initialProgress);
      latestProgressRef.current = initialProgress;
      pushLog(
        "cobble",
        `开始安装 Minecraft ${targetId}（基础版本 ${versionId}，${threads} 线程全组件并发下载）…`,
      );
      try {
        const res = await installVersion(root, versionId, threads, selection);
        const next = await refreshInstalled(root);
        setSelectedVersion(res.versionId);
        const count = next.find((entry) => entry.id === res.versionId);
        const lastSnap = latestProgressRef.current;
        const record: DownloadHistoryRecord = {
          id: `${res.versionId}-${Date.now()}`,
          versionId: res.versionId,
          status: "completed",
          threads,
          totalFiles: 1 + res.libraries + res.assets,
          totalBytes: lastSnap?.totalBytes || lastSnap?.downloadedBytes || 0,
          peakSpeedBps: peakSpeedRef.current,
          durationMs: Math.max(100, Date.now() - startedAt),
          finishedAt: timeNow(),
        };
        setDownloadHistory((prev) => [record, ...prev].slice(0, 40));
        pushToast(
          "success",
          `${res.versionId} 已安装`,
          count ? "游戏文件与附加工具安装完成，可以开始游戏。" : "可以开始游戏。",
        );
      } catch (error) {
        if (isPausedByUserRef.current || isCancelledByUserRef.current) {
          return;
        }
        const record: DownloadHistoryRecord = {
          id: `${targetId}-${Date.now()}`,
          versionId: targetId,
          status: "failed",
          threads,
          totalFiles: 0,
          totalBytes: latestProgressRef.current?.downloadedBytes ?? 0,
          peakSpeedBps: peakSpeedRef.current,
          durationMs: Math.max(100, Date.now() - startedAt),
          finishedAt: timeNow(),
          error: String(error),
        };
        setDownloadHistory((prev) => [record, ...prev].slice(0, 40));
        pushToast("error", `安装 ${targetId} 失败`, String(error));
        pushLog("cobble", `安装 ${targetId} 失败: ${String(error)}`);
      } finally {
        activeInstallParamsRef.current = null;
        isPausedByUserRef.current = false;
        isCancelledByUserRef.current = false;
        setInstallingVersion(null);
        setInstallProgress(null);
      }
    },
    [installingVersion, installQueue.length, pushLog, pushToast, refreshInstalled],
  );

  const handleInstallBedrock = useCallback(
    async (ver: BedrockVersionItem, apiSource?: string) => {
      const targetLabel = `基岩版 ${ver.version}`;
      if (installingVersion) {
        pushToast(
          "info",
          "已有任务正在下载",
          `正在下载 ${installingVersion}，请稍候。`,
        );
        return;
      }
      const root = settingsRef.current.gameRoot;
      const threads = settingsRef.current.downloadThreads;
      const startedAt = Date.now();
      peakSpeedRef.current = 0;
      setPeakSpeedBps(0);
      setSpeedHistory([]);
      setInstallingVersion(targetLabel);
      activeInstallParamsRef.current = {
        versionId: targetLabel,
        edition: "bedrock",
        bedrockVersionItem: ver,
        apiSource,
      };
      isPausedByUserRef.current = false;
      isCancelledByUserRef.current = false;

      const initialProgress: InstallProgress = {
        versionId: `bedrock:${ver.id}`,
        stage: "prepare",
        done: 0,
        total: 3,
        detail: `准备多线程下载 ${targetLabel}`,
        downloadedBytes: 0,
        totalBytes: ver.size || 85_983_232,
        speedBps: 0,
        threads,
        activeThreads: 1,
      };
      setInstallProgress(initialProgress);
      setLastInstallProgress(initialProgress);
      latestProgressRef.current = initialProgress;
      pushLog(
        "cobble",
        `开始多线程下载 ${targetLabel}（${threads} 线程 Range 分片并发加速）…`,
      );

      try {
        const res = await installBedrockVersion(
          ver.id,
          ver.downloadUrl,
          root,
          apiSource,
          threads,
        );
        const lastSnap = latestProgressRef.current;
        const record: DownloadHistoryRecord = {
          id: `bedrock-${ver.id}-${Date.now()}`,
          versionId: targetLabel,
          status: "completed",
          threads,
          totalFiles: 1,
          totalBytes:
            lastSnap?.totalBytes ||
            lastSnap?.downloadedBytes ||
            ver.size ||
            85_983_232,
          peakSpeedBps: peakSpeedRef.current,
          durationMs: Math.max(100, Date.now() - startedAt),
          finishedAt: timeNow(),
        };
        setDownloadHistory((prev) => [record, ...prev].slice(0, 40));
        setSelectedBedrockVersion(ver.id);
        setSelectedVersion(`bedrock:${ver.id}`);
        try {
          localStorage.setItem("cobble.selected-bedrock", ver.id);
          localStorage.setItem("cobble.selected-version", `bedrock:${ver.id}`);
        } catch {}
        pushToast("success", `${targetLabel} 安装完成`, res);
        pushLog("cobble", `${targetLabel} 安装成功: ${res}`);
      } catch (error) {
        if (isPausedByUserRef.current || isCancelledByUserRef.current) {
          return;
        }
        const record: DownloadHistoryRecord = {
          id: `bedrock-${ver.id}-${Date.now()}`,
          versionId: targetLabel,
          status: "failed",
          threads,
          totalFiles: 0,
          totalBytes: latestProgressRef.current?.downloadedBytes ?? 0,
          peakSpeedBps: peakSpeedRef.current,
          durationMs: Math.max(100, Date.now() - startedAt),
          finishedAt: timeNow(),
          error: String(error),
        };
        setDownloadHistory((prev) => [record, ...prev].slice(0, 40));
        pushToast("error", `安装 ${targetLabel} 失败`, String(error));
        pushLog("cobble", `安装 ${targetLabel} 失败: ${String(error)}`);
      } finally {
        activeInstallParamsRef.current = null;
        isPausedByUserRef.current = false;
        isCancelledByUserRef.current = false;
        setInstallingVersion(null);
        setInstallProgress(null);
      }
    },
    [installingVersion, pushLog, pushToast],
  );

  const handlePauseInstall = useCallback(async () => {
    const currentTask = activeInstallParamsRef.current;
    if (!currentTask) return;
    isPausedByUserRef.current = true;
    await cancelInstall();
    const snap = latestProgressRef.current;
    const targetName =
      currentTask.edition === "bedrock"
        ? currentTask.versionId
        : currentTask.selection?.instanceName?.trim() || currentTask.versionId;
    const pausedRecord: DownloadHistoryRecord = {
      id: `paused-${targetName}-${Date.now()}`,
      versionId: targetName,
      status: "paused",
      threads: settingsRef.current.downloadThreads,
      totalFiles: snap?.total || 1,
      totalBytes: snap?.totalBytes || snap?.downloadedBytes || 0,
      downloadedBytes: snap?.downloadedBytes || 0,
      peakSpeedBps: peakSpeedRef.current,
      durationMs: 0,
      finishedAt: timeNow(),
      selection: currentTask.selection,
      edition: currentTask.edition,
      bedrockVersionItem: currentTask.bedrockVersionItem,
      apiSource: currentTask.apiSource,
      pausedReason: "用户手动暂停",
    };
    setDownloadHistory((prev) => {
      const filtered = prev.filter((r) => r.versionId !== targetName);
      return [pausedRecord, ...filtered].slice(0, 40);
    });
    setInstallingVersion(null);
    setInstallProgress(null);
    pushToast(
      "info",
      "下载已暂停",
      `已保存 ${targetName} 当前分片下载进度，可随时点击【继续下载】恢复。`,
    );
    pushLog("cobble", `已暂停 ${targetName} 下载。`);
  }, [pushLog, pushToast]);

  const handleCancelInstall = useCallback(async () => {
    const currentTask = activeInstallParamsRef.current;
    if (!currentTask) return;
    isCancelledByUserRef.current = true;
    await cancelInstall();
    const targetName =
      currentTask.edition === "bedrock"
        ? currentTask.versionId
        : currentTask.selection?.instanceName?.trim() || currentTask.versionId;
    setInstallingVersion(null);
    setInstallProgress(null);
    pushToast("info", "下载已取消", `已取消 ${targetName} 的下载任务。`);
    pushLog("cobble", `已取消 ${targetName} 下载。`);
  }, [pushLog, pushToast]);

  const handleResumeInstall = useCallback(
    async (record: DownloadHistoryRecord) => {
      setDownloadHistory((prev) => prev.filter((r) => r.id !== record.id));
      if (record.edition === "bedrock" && record.bedrockVersionItem) {
        void handleInstallBedrock(record.bedrockVersionItem, record.apiSource);
      } else if (record.edition === "bedrock") {
        const rawId = record.versionId
          .replace(/^Minecraft 基岩版 /, "")
          .replace(/^基岩版 /, "")
          .replace(/^bedrock:/, "")
          .trim();
        void handleInstallBedrock(
          {
            id: rawId,
            version: rawId,
            name: record.versionId,
            releaseType: "release",
            downloadUrl: "",
            date: "",
            size: record.totalBytes || 0,
          },
          record.apiSource,
        );
      } else {
        const rawId = record.versionId.replace(/^Minecraft /, "").trim();
        void handleInstall(rawId, record.selection);
      }
    },
    [handleInstall, handleInstallBedrock],
  );

  const handleRemoveQueueItem = useCallback((idx: number) => {
    setInstallQueue((prev) => prev.filter((_, i) => i !== idx));
    pushToast("info", "已移出队列", "已取消该任务的等待排队。");
  }, [pushToast]);

  useEffect(() => {
    if (!installingVersion && installQueue.length > 0) {
      const [next, ...rest] = installQueue;
      setInstallQueue(rest);
      void handleInstall(next.versionId, next.selection);
    }
  }, [installingVersion, installQueue, handleInstall]);

  const handleLaunch = useCallback(
    async (versionOverride?: string, options?: { stay?: boolean }) => {
      let versionId = versionOverride ?? selectedVersion;
      if (edition === "bedrock" && !versionOverride && (!versionId || !versionId.includes("bedrock"))) {
        versionId = selectedBedrockVersion ? `bedrock:${selectedBedrockVersion}` : "uwp";
      }
      if (!versionId) {
        pushToast("info", "还没有选择版本", "先从版本选择页安装一个游戏版本。");
        setView("version-select");
        return;
      }
      if (versionOverride) setSelectedVersion(versionOverride);
      if (!options?.stay) setView("version-settings");

      if (runtime.status !== "idle") {
        pushToast("info", "游戏正在运行", "结束当前游戏后再启动另一个实例。");
        return;
      }

      const isBedrock =
        edition === "bedrock" ||
        versionId === "uwp" ||
        versionId === "bedrock-uwp" ||
        versionId.startsWith("bedrock:") ||
        versionId.startsWith("bedrock-") ||
        versionId.includes("基岩版");

      if (isBedrock) {
        try {
          const target =
            versionId === "uwp" || versionId === "bedrock-uwp"
              ? undefined
              : versionId
                  .replace(/^bedrock:/, "")
                  .replace(/^bedrock-/, "")
                  .replace(/^(Minecraft\s*)?基岩版\s*/, "")
                  .trim();
          const msg = await launchBedrock(target, settingsRef.current.gameRoot);
          pushToast("success", "已唤起 Minecraft 基岩版", msg);
          pushLog("cobble", `成功启动 Minecraft 基岩版: ${msg}`);
          if (isDesktop) {
            const vis = settingsRef.current.launcherVisibility;
            if (vis === "close") {
              try {
                void getCurrentWindow().close();
              } catch {}
            } else if (vis === "hide") {
              try {
                void getCurrentWindow().hide();
              } catch {}
            }
          }
        } catch (err) {
          pushToast("error", "启动基岩版失败", String(err));
          pushLog("cobble", `启动基岩版失败: ${String(err)}`);
        }
        return;
      }

      if (!installed.some((entry) => entry.id === versionId)) {
        pushToast("info", `${versionId} 尚未安装`, "请先前往下载页面下载游戏文件。");
        setView("download");
        return;
      }
      if (!settingsRef.current.gameRoot) {
        pushToast("error", "游戏目录为空", "请先在设置中选择游戏目录。");
        return;
      }
      const launchPlayerName = account?.signedIn ? account.name : settings.playerName.trim();
      if (!account?.signedIn && !/^[A-Za-z0-9_]{1,16}$/.test(launchPlayerName)) {
        pushToast("error", "昵称无效", "昵称只能包含字母、数字和下划线，长度 1–16 位。");
        setView("settings");
        return;
      }

      setLaunchProgress({
        versionId,
        stage: "java",
        done: 0,
        total: 0,
        detail: "检查运行环境",
      });
      setRuntime({ status: "preparing", versionId, detail: "正在检查游戏文件与 Java" });
      pushLog("cobble", `准备启动 Minecraft ${versionId}…`);
      pushLog("cobble", "离线模式：单人游戏和离线服务器可用，Realms 请求会被 Mojang 拒绝。");

      const launchSettings = resolveVersionLaunchSettings(
        settingsRef.current,
        versionSettingsRef.current,
        versionId,
      );

      const effectiveWidth =
        launchSettings.windowSize === "custom" ||
        (launchSettings.windowSize === "default" && launchSettings.resolutionEnabled)
          ? launchSettings.width
          : null;
      const effectiveHeight =
        launchSettings.windowSize === "custom" ||
        (launchSettings.windowSize === "default" && launchSettings.resolutionEnabled)
          ? launchSettings.height
          : null;

      activeVisibilityRef.current = launchSettings.launcherVisibility;

      try {
        await launchGame({
          versionId,
          root: settingsRef.current.gameRoot,
          playerName: launchPlayerName,
          memoryMb: launchSettings.memoryMb,
          javaPath: launchSettings.javaPath?.trim() || settings.javaPath.trim() || null,
          width: effectiveWidth,
          height: effectiveHeight,
          skinType: settings.offlineSkinType,
          customSkinPath: settings.customSkinPath || null,
          customSkinModel: settings.offlineSkinModel || null,
          mojangSkinName: settings.mojangSkinName || null,
          versionIsolation: launchSettings.versionIsolation,
          windowTitle: launchSettings.windowTitle || null,
          customInfo: launchSettings.customInfo || null,
          launcherVisibility: launchSettings.launcherVisibility,
          processPriority: launchSettings.processPriority,
          windowSize: launchSettings.windowSize,
          jvmArgs: launchSettings.jvmArgs || null,
          language: launchSettings.language || null,
        });
        // Java may have been installed during launch; reflect it in the UI.
        void detectJavaForRoot(settingsRef.current.gameRoot);
      } catch (error) {
        setRuntime({ status: "idle" });
        setLaunchProgress(null);
        pushToast("error", "启动失败", String(error));
        pushLog("cobble", `启动失败: ${String(error)}`);
      }
    },
    [
      detectJavaForRoot,
      installed,
      pushLog,
      pushToast,
      runtime.status,
      selectedVersion,
      settings.javaPath,
      settings.playerName,
      account,
    ],
  );

  const handleStop = useCallback(async () => {
    try {
      await stopGame();
    } catch (error) {
      pushToast("error", "无法结束游戏", String(error));
    }
  }, [pushToast]);

  const openFolder = useCallback(
    async (path: string) => {
      if (!path) {
        pushToast("info", "目录尚未设置", "请先在设置中选择游戏目录。");
        return;
      }
      if (!isDesktop) {
        pushToast("info", "浏览器预览模式", "打开目录在桌面应用中可用。");
        return;
      }
      try {
        await openFolderPath(path);
      } catch (error) {
        pushToast("error", "无法打开目录", `${path}\n${String(error)}`);
      }
    },
    [pushToast],
  );

  const updateSettings = useCallback((patch: Partial<LauncherSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [view]);

  // A single wallpaper layer for the whole window. It has to live outside the
  // scrolling `<main>`: an absolute layer inside a scroll container stays glued
  // to the top of the content, so changing the wallpaper from the settings page
  // (which is scrolled far down) looked like nothing happened.
  const wallpaperStyle = (() => {
    if (settings.backgroundType !== "custom" || !bgDataUrl) return null;
    const alpha = Math.min(1, Math.max(0.05, settings.backgroundOpacity / 100));
    return {
      backgroundImage: `url(${bgDataUrl})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      filter: settings.backgroundBlur > 0 ? `blur(${settings.backgroundBlur}px)` : undefined,
      opacity: alpha,
      transform: settings.backgroundBlur > 0 ? "scale(1.04)" : undefined,
    } satisfies CSSProperties;
  })();

  return (
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* Solid backdrop: when the UI surfaces are faded for a wallpaper, this
          keeps the desktop from showing through the window itself. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-20"
        style={{ background: "var(--background-solid)" }}
      />
      {wallpaperStyle ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10"
          style={wallpaperStyle}
        />
      ) : null}
      <TitleBar demo={!isDesktop} title={settings.windowTitle} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          view={view}
          onNavigate={setView}
          playerName={settings.playerName}
          installedCount={installed.length}
          installingVersion={installingVersion}
          javaMajor={bestJava?.major}
          javaPath={settings.javaPath}
          javaDetecting={javaDetecting}
          runtimeStatus={runtime.status}
          launcherVersion={systemInfo?.launcherVersion ?? "0.0.7"}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
          skinType={settings.offlineSkinType}
          customSkinPath={settings.customSkinPath}
          mojangSkinName={settings.mojangSkinName}
          signedInName={account?.signedIn ? account.name : null}
        />

        <main
          ref={contentRef}
          className={
            view === "home"
              ? "relative min-h-0 flex-1 overflow-hidden"
              : "relative min-h-0 flex-1 overflow-y-auto"
          }
        >
          {/* 3D World Grid Layer */}
          {settings.showWorldGrid ? (
            <div
              aria-hidden="true"
              className="world-grid pointer-events-none absolute inset-0 opacity-40"
            />
          ) : null}
          {view === "home" ? (
            <HomeView
              installed={installed}
              selectedVersion={selectedVersion}
              playerName={settings.playerName}
              onPlayerNameChange={(playerName) => updateSettings({ playerName })}
              runtime={runtime}
              launchProgress={launchProgress}
              onLaunch={() => void handleLaunch(undefined, { stay: true })}
              onStop={() => void handleStop()}
              onOpenVersionSelect={() => setView("version-select")}
              onOpenVersionSettings={() => setView("version-settings")}
              onOpenSettings={() => setView("settings")}
              gameRoot={settings.gameRoot}
              onOpenDownloadBedrock={() => setView("download")}
              onNotify={pushToast}
              edition={edition}
              onEditionChange={handleEditionChange}
              selectedBedrockVersion={selectedBedrockVersion}
              settings={settings}
              onUpdateSettings={updateSettings}
              accountType={account?.signedIn ? "microsoft" : "offline"}
              account={account}
              onOpenAccount={() => setAccountOpen(true)}
            />
          ) : (
            <div className="relative mx-auto w-full max-w-[1360px] px-5 py-6 lg:px-8">
              {view === "multiplayer" ? (
                <MultiplayerView
                  gameRoot={settings.gameRoot}
                  onNotify={pushToast}
                  edition={edition}
                  selectedVersion={selectedVersion}
                  versionIsolation={effectiveLaunchSettings.versionIsolation}
                  gameRunning={
                    runtime.status === "running" || Boolean(systemInfo?.gameRunning)
                  }
                  installed={installed}
                  onLaunchVersion={(versionId) => void handleLaunch(versionId)}
                />
              ) : null}

              {view === "version-select" ? (
                <VersionSelectView
                  manifest={manifest}
                  installed={installed}
                  selectedVersion={selectedVersion}
                  gameRoot={settings.gameRoot}
                  edition={edition}
                  onEditionChange={handleEditionChange}
                  selectedBedrockVersion={selectedBedrockVersion}
                  onSelectBedrockVersion={handleSelectBedrockVersion}
                  onSelect={(versionId) => {
                    // Picking a version is the end of this page: remember the
                    // choice and go straight back to the launcher home where
                    // the big launch button lives.
                    handleSelectVersion(versionId);
                    setView("home");
                  }}
                  onPlay={(versionId) => void handleLaunch(versionId)}
                  onPlayBedrock={(verId) => {
                    void (async () => {
                      try {
                        const target = verId === "uwp" || !verId ? undefined : verId;
                        const msg = await launchBedrock(target, settings.gameRoot);
                        pushToast("success", "已唤起 Minecraft 基岩版", msg);
                      } catch (err) {
                        pushToast("error", "启动基岩版失败", String(err));
                      }
                    })();
                  }}
                  onOpenVersionSettings={openVersionSettings}
                  onOpenFolder={(path) => void openFolder(path)}
                  onOpenLauncherSettings={() => setView("settings")}
                  onOpenDownloadPage={() => setView("download")}
                  onDeleteVersion={handleDeleteVersion}
                  onNotify={pushToast}
                />
              ) : null}

              {view === "download" ? (
                <DownloadCatalogView
                  manifest={manifest}
                  installed={installed}
                  selectedVersion={selectedVersion}
                  gameRoot={settings.gameRoot}
                  installingVersion={installingVersion}
                  installProgress={installProgress}
                  lastProgress={lastInstallProgress}
                  downloadThreads={settings.downloadThreads}
                  loading={manifestLoading}
                  error={manifestError}
                  onSelectVersion={(version) => {
                    setInstallTarget(version);
                    setView("version-install");
                  }}
                  onOpenProgress={() => setView("download-progress")}
                  onOpenVersionSelect={() => setView("version-select")}
                  onOpenFolder={(path) => void openFolder(path)}
                  onRefresh={() => void refreshManifest(undefined, true)}
                  onDeleteVersion={handleDeleteVersion}
                  onInstallBedrock={handleInstallBedrock}
                  onNotify={pushToast}
                />
              ) : null}

              {view === "version-install" && installTarget ? (
                <VersionInstallView
                  version={installTarget}
                  installed={installed}
                  installingVersion={installingVersion}
                  downloadThreads={settings.downloadThreads}
                  onBack={() => setView("download")}
                  onConfirmInstall={(versionId, selection) => {
                    void handleInstall(versionId, selection);
                    setView("download-progress");
                  }}
                />
              ) : null}

              {view === "download-progress" ? (
                <DownloadsView
                  manifest={manifest}
                  installed={installed}
                  selectedVersion={selectedVersion}
                  installingVersion={installingVersion}
                  installProgress={installProgress}
                  lastProgress={lastInstallProgress}
                  downloadThreads={settings.downloadThreads}
                  peakSpeedBps={peakSpeedBps}
                  speedHistory={speedHistory}
                  fileEvents={fileEvents}
                  history={downloadHistory}
                  backgroundTasks={backgroundTasks}
                  installQueue={installQueue}
                  gameRoot={settings.gameRoot}
                  onSelectVersion={handleSelectVersion}
                  onChangeThreads={(downloadThreads) =>
                    updateSettings({ downloadThreads })
                  }
                  onInstall={(versionId: string) => void handleInstall(versionId)}
                  onLaunch={(versionId) => void handleLaunch(versionId)}
                  onPauseInstall={() => void handlePauseInstall()}
                  onCancelInstall={() => void handleCancelInstall()}
                  onResumeInstall={(record) => void handleResumeInstall(record)}
                  onRemoveQueueItem={(idx) => handleRemoveQueueItem(idx)}
                  onClearHistory={() => {
                    setDownloadHistory([]);
                    setBackgroundTasks((current) =>
                      current.filter(
                        (task) => task.status === "running" || task.status === "paused",
                      ),
                    );
                  }}
                  onRetryBackgroundTask={(id) => void handleRetryBackgroundTask(id)}
                  onDeleteHistoryItem={(id) =>
                    setDownloadHistory((prev) => prev.filter((r) => r.id !== id))
                  }
                  onOpenVersionSelect={() => setView("download")}
                  onOpenFolder={(path) => void openFolder(path)}
                  onNotify={pushToast}
                  onRefreshInstalled={async () => {
                    await refreshInstalled(settings.gameRoot);
                  }}
                />
              ) : null}

              {view === "version-settings" ? (
                <VersionSettingsView
                  manifest={manifest}
                  installed={installed}
                  selectedVersion={selectedVersion}
                  edition={edition}
                  onSelectVersion={handleSelectVersion}
                  playerName={settings.playerName}
                  gameRoot={settings.gameRoot}
                  javaInstalls={javaInstalls}
                  javaDetecting={javaDetecting}
                  javaPath={settings.javaPath}
                  runtime={runtime}
                  installProgress={installProgress}
                  installingVersion={installingVersion}
                  launchProgress={launchProgress}
                  logs={logs}
                  launchSettings={effectiveLaunchSettings}
                  hasOverride={hasVersionOverride}
                  onChangeLaunchSettings={updateVersionLaunchSettings}
                  onResetLaunchSettings={resetVersionLaunchSettings}
                  onLaunch={() => void handleLaunch()}
                  onStop={() => void handleStop()}
                  onInstall={(versionId: string) => void handleInstall(versionId)}
                  onOpenVersionSelect={() => setView("version-select")}
                  onOpenFolder={(path) => void openFolder(path)}
                  onRefreshJava={() => void refreshJava()}
                  onClearLogs={() => setLogs([])}
                  onDeleteVersion={(verId) => handleDeleteVersion(verId, "java")}
                  onNotify={pushToast}
                />
              ) : null}

              {view === "settings" ? (
                <SettingsView
                  settings={settings}
                  onChange={updateSettings}
                  systemInfo={systemInfo}
                  javaInstalls={javaInstalls}
                  javaDetecting={javaDetecting}
                  onRefreshJava={refreshJava}
                  onOpenFolder={(path) => void openFolder(path)}
                  onNotify={pushToast}
                />
              ) : null}
            </div>
          )}
        </main>
      </div>

      <AccountDialog
        open={accountOpen}
        onClose={() => setAccountOpen(false)}
        account={account}
        clientId={settings.msClientId ?? ""}
        onClientIdChange={(msClientId) => updateSettings({ msClientId })}
        onSignedIn={async (next) => {
          setAccount(next);
          // 登录成功后从后端重新获取以确保主界面立即更新
          try {
            const fresh = await getMsAccount(settings.msClientId || undefined);
            if (fresh) setAccount(fresh);
          } catch {
            // 忽略错误，使用对话框传入的账户即可
          }
        }}
        onSignedOut={() => setAccount(null)}
        onNotify={pushToast}
      />

      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}
