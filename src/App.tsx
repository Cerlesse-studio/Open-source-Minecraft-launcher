import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar, TitleBar } from "./components/Chrome";
import { DownloadCatalogView } from "./components/DownloadCatalogView";
import { DownloadsView, type DownloadFileEvent } from "./components/DownloadsView";
import { HomeView } from "./components/HomeView";
import { SettingsView } from "./components/SettingsView";
import { VersionInstallView } from "./components/VersionInstallView";
import { VersionSelectView } from "./components/VersionSelectView";
import { VersionSettingsView } from "./components/VersionSettingsView";
import type { LogEntry } from "./components/Console";
import { Toaster } from "./components/ui/sonner";
import { toast } from "sonner";
import {
  detectJava,
  getInstalledVersions,
  getSystemInfo,
  getVersionManifest,
  installVersion,
  isDesktop,
  launchGame,
  openFolderPath,
  stopGame,
  subscribe,
} from "./lib/backend";
import { timeNow } from "./lib/format";
import { loadSettings, saveSettings } from "./lib/settings";
import {
  loadVersionSettings,
  resolveVersionLaunchSettings,
  saveVersionSettings,
  type VersionLaunchSettings,
} from "./lib/versionSettings";
import type {
  DownloadHistoryRecord,
  GameStateName,
  InstallProgress,
  InstalledVersion,
  JavaInstall,
  LauncherSettings,
  LoaderSelection,
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
  const [installTarget, setInstallTarget] = useState<VersionSummary | null>(null);
  const [view, setView] = useState<ViewId>("home");
  const [manifestLoading, setManifestLoading] = useState(true);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [installingVersion, setInstallingVersion] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  const [lastInstallProgress, setLastInstallProgress] = useState<InstallProgress | null>(
    null,
  );
  const [peakSpeedBps, setPeakSpeedBps] = useState(0);
  const [speedHistory, setSpeedHistory] = useState<number[]>([]);
  const [fileEvents, setFileEvents] = useState<DownloadFileEvent[]>([]);
  const [downloadHistory, setDownloadHistory] =
    useState<DownloadHistoryRecord[]>(loadDownloadHistory);
  const [launchProgress, setLaunchProgress] = useState<InstallProgress | null>(null);
  const [runtime, setRuntime] = useState<RuntimeView>({ status: "idle" });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [versionSettings, setVersionSettings] = useState(loadVersionSettings);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem("cobble.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });

  const settingsRef = useRef(settings);
  const versionSettingsRef = useRef(versionSettings);
  const logId = useRef(0);
  const fileEventId = useRef(0);
  const lastDetailRef = useRef("");
  const peakSpeedRef = useRef(0);
  const latestProgressRef = useRef<InstallProgress | null>(null);
  const lastRoot = useRef(settings.gameRoot);
  const contentRef = useRef<HTMLElement>(null);

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
    }
    void refreshManifest(settings.gameRoot);
    void refreshInstalled(settings.gameRoot);
    void detectJavaForRoot(settings.gameRoot);
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
      }),
    );
    track(
      subscribe("game:exit", (payload) => {
        setLaunchProgress(null);
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

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [pushLog, pushToast, refreshInstalled]);

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

  const handleInstall = useCallback(
    async (versionId: string, selection?: LoaderSelection) => {
      if (installingVersion) {
        pushToast("info", "已有安装任务", `正在安装 ${installingVersion}，请稍候。`);
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
        `开始安装 Minecraft ${targetId}（基础版本 ${versionId}，${threads} 线程）…`,
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
        setInstallingVersion(null);
        setInstallProgress(null);
      }
    },
    [installingVersion, pushLog, pushToast, refreshInstalled],
  );

  const handleLaunch = useCallback(
    async (versionOverride?: string, options?: { stay?: boolean }) => {
      const versionId = versionOverride ?? selectedVersion;
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
      if (!installed.some((entry) => entry.id === versionId)) {
        pushToast("info", `${versionId} 尚未安装`, "请先前往下载页面下载游戏文件。");
        setView("download");
        return;
      }
      if (!settingsRef.current.gameRoot) {
        pushToast("error", "游戏目录为空", "请先在设置中选择游戏目录。");
        return;
      }
      if (!/^[A-Za-z0-9_]{1,16}$/.test(settings.playerName.trim())) {
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

      try {
        await launchGame({
          versionId,
          root: settingsRef.current.gameRoot,
          playerName: settings.playerName.trim(),
          memoryMb: launchSettings.memoryMb,
          javaPath: settings.javaPath.trim() || null,
          width: launchSettings.resolutionEnabled ? launchSettings.width : null,
          height: launchSettings.resolutionEnabled ? launchSettings.height : null,
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

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar demo={!isDesktop} />
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
          launcherVersion={systemInfo?.launcherVersion ?? "0.1.0"}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
        />

        <main
          ref={contentRef}
          className={
            view === "home"
              ? "relative min-h-0 flex-1 overflow-hidden"
              : "relative min-h-0 flex-1 overflow-y-auto"
          }
        >
          <div
            aria-hidden="true"
            className="world-grid pointer-events-none absolute inset-0 opacity-40"
          />
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
            />
          ) : (
            <div className="relative mx-auto w-full max-w-[1360px] px-5 py-6 lg:px-8">
              {view === "version-select" ? (
                <VersionSelectView
                  manifest={manifest}
                  installed={installed}
                  selectedVersion={selectedVersion}
                  gameRoot={settings.gameRoot}
                  onSelect={setSelectedVersion}
                  onPlay={(versionId) => void handleLaunch(versionId)}
                  onOpenVersionSettings={openVersionSettings}
                  onOpenFolder={(path) => void openFolder(path)}
                  onOpenLauncherSettings={() => setView("settings")}
                  onOpenDownloadPage={() => setView("download")}
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
                  gameRoot={settings.gameRoot}
                  onSelectVersion={setSelectedVersion}
                  onChangeThreads={(downloadThreads) =>
                    updateSettings({ downloadThreads })
                  }
                  onInstall={(versionId) => void handleInstall(versionId)}
                  onClearHistory={() => setDownloadHistory([])}
                  onOpenVersionSelect={() => setView("download")}
                  onOpenFolder={(path) => void openFolder(path)}
                />
              ) : null}

              {view === "version-settings" ? (
                <VersionSettingsView
                  manifest={manifest}
                  installed={installed}
                  selectedVersion={selectedVersion}
                  onSelectVersion={setSelectedVersion}
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
                  onInstall={(versionId) => void handleInstall(versionId)}
                  onOpenVersionSelect={() => setView("version-select")}
                  onOpenFolder={(path) => void openFolder(path)}
                  onRefreshJava={() => void refreshJava()}
                  onClearLogs={() => setLogs([])}
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

      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}
