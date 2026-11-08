import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  KeyRound,
  LoaderCircle,
  Network,
  Play,
  RefreshCw,
  Server,
  Settings,
  Square,
  Users,
  Zap,
} from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addMultiplayerPeer,
  fetchRoomResources,
  getLocalIpv6Addresses,
  getMultiplayerInstallState,
  getMultiplayerPeers,
  getMultiplayerStatus,
  installEasytier,
  isDesktop,
  probeMinecraftHost,
  probeMultiplayerLatency,
  readMinecraftLanPort,
  startLanBridge,
  startMultiplayer,
  startRoomResources,
  stopLanBridge,
  stopMultiplayer,
  subscribe,
} from "../lib/backend";
import { watchRoomHealth } from "../lib/multiplayerHealth";
import {
  DEFAULT_HOST_PORT,
  DEFAULT_PUBLIC_SERVER,
  OFFICIAL_PUBLIC_SERVERS,
  ROOM_PASSWORD_MIN,
  buildShareCode,
  createOverlayIpv4,
  createRoomName,
  createRoomPassword,
  ipv6FromPeer,
  isPureP2p,
  isRoomPassword,
  normalizeRoomName,
  loadActiveRoom,
  loadCachedCommunityServers,
  loadCustomServers,
  loadMultiplayerConfig,
  loadMultiplayerHosts,
  parseHostAddress,
  parseServerUri,
  parseShareCode,
  peerFromAddress,
  pickFastestRelayServer,
  buildGuestRelayPeers,
  buildRoomRelayPeers,
  loadCachedServerLatencies,
  batchProbeMultiplayerLatencies,
  roomResourcePort,
  roomResourceToken,
  saveActiveRoom,
  saveCustomServers,
  saveMultiplayerConfig,
  saveMultiplayerHosts,
  supportsIpv6P2p,
  type ActiveRoom,
} from "../lib/multiplayer";
import type {
  EasyTierPublicServer,
  GameEdition,
  InstalledVersion,
  LauncherSettings,
  LocalIpv6Address,
  MultiplayerConfig,
  MultiplayerHost,
  MultiplayerInstallState,
  MultiplayerPeer,
  MultiplayerStatus,
  RoomResources,
  VersionIsolation,
} from "../lib/types";
import { MultiplayerRoom } from "./MultiplayerRoom";
import { FieldLabel, type Notify } from "./MultiplayerShared";
import { PageHeader, StatusDot } from "./ui";

const MAX_LOG_LINES = 240;
type MultiplayerPage = "home" | "create" | "join" | "room";

interface MultiplayerViewProps {
  gameRoot: string;
  onNotify: Notify;
  edition: GameEdition;
  selectedVersion: string;
  versionIsolation: VersionIsolation;
  gameRunning: boolean;
  installed: InstalledVersion[];
  onLaunchVersion: (versionId: string) => void;
  onRefreshInstalled?: () => Promise<unknown> | void;
  settings?: LauncherSettings;
  onOpenSettings?: (tab?: string) => void;
  onUpdateSettings?: (patch: Partial<LauncherSettings>) => void;
}

function freshGuestOverlay(avoid: Array<string | null | undefined>): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const value = createOverlayIpv4();
    if (!avoid.some((item) => item && item === value)) return value;
  }
  return createOverlayIpv4();
}

function RoleCard({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: typeof Network;
  title: string;
  desc?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full flex-col rounded-xl border border-border/70 bg-card/55 p-4 text-left transition-colors hover:border-primary/40 hover:bg-card/80 focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:outline-none"
    >
      <span className="flex w-full items-center justify-between">
        <span className="flex size-9 items-center justify-center rounded-lg border border-border/60 bg-muted/20 text-foreground/80 transition-colors group-hover:border-primary/30 group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="size-4 shrink-0 transition-colors" />
        </span>
        <ArrowRight className="size-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </span>
      <span className="mt-3 text-[13px] font-semibold">{title}</span>
      {desc ? <span className="mt-1 text-[11px] text-muted-foreground">{desc}</span> : null}
    </button>
  );
}

function ModeCard({
  active,
  icon: Icon,
  title,
  desc,
  tag,
  onClick,
}: {
  active: boolean;
  icon: typeof Network;
  title: string;
  desc: string;
  tag: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex w-full flex-col rounded-lg border p-3 text-left transition-colors focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:outline-none",
        active
          ? "border-primary/50 bg-primary/[0.06] ring-1 ring-primary/25"
          : "border-border/70 bg-background/30 hover:border-border hover:bg-card/70",
      )}
    >
      <span className="flex w-full items-center gap-2">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            active ? "text-primary" : "text-muted-foreground",
          )}
        />
        <span className="text-[12px] font-medium">{title}</span>
        <Badge
          variant="outline"
          className={cn(
            "ml-auto h-4 px-1.5 text-[9px] font-normal",
            active
              ? "border-primary/30 text-primary"
              : "border-border/70 text-muted-foreground",
          )}
        >
          {tag}
        </Badge>
      </span>
      <span className="mt-1.5 text-[10.5px] leading-4 text-muted-foreground">{desc}</span>
    </button>
  );
}

function StepHeader({
  step,
  title,
  detail,
}: {
  step: string;
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/10 font-mono text-[10px] text-primary">
        {step}
      </span>
      <span className="text-[13px] font-medium">{title}</span>
      {detail ? (
        <span className="ml-auto text-[10.5px] text-muted-foreground">{detail}</span>
      ) : null}
    </div>
  );
}

export function MultiplayerView({
  gameRoot,
  onNotify,
  edition,
  selectedVersion,
  versionIsolation,
  gameRunning,
  installed: installedVersions,
  onLaunchVersion,
  onRefreshInstalled,
  settings,
  onOpenSettings,
  onUpdateSettings,
}: MultiplayerViewProps) {
  const [config, setConfig] = useState<MultiplayerConfig>(() => {
    const loaded = loadMultiplayerConfig();
    return {
      ...loaded,
      networkName: loaded.networkName || createRoomName(),
      networkSecret: loaded.networkSecret || createRoomPassword(),
      publicServer: loaded.p2pOnly
        ? ""
        : loaded.publicServer || DEFAULT_PUBLIC_SERVER,
      relay: !loaded.p2pOnly,
      p2pOnly: loaded.p2pOnly,
      allowPublicStun: !loaded.p2pOnly,
    };
  });
  const [hosts, setHosts] = useState<MultiplayerHost[]>(loadMultiplayerHosts);
  const [status, setStatus] = useState<MultiplayerStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [page, setPage] = useState<MultiplayerPage>(() =>
    loadActiveRoom() ? "room" : "home",
  );
  const [requestingInstall, setRequestingInstall] = useState(false);
  const [installProgress, setInstallProgress] = useState<MultiplayerInstallState | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | "join" | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // Astral 加入模式：支持「房间名+密码」加入和「一键分享码」加入
  const [joinTab, setJoinTab] = useState<"manual" | "code">("manual");
  const [joinCode, setJoinCode] = useState("");
  const [manualRoomName, setManualRoomName] = useState("");
  const [manualRoomSecret, setManualRoomSecret] = useState("");
  const [manualServer, setManualServer] = useState(DEFAULT_PUBLIC_SERVER);

  // EasyTier 协助节点（内置全量 Relay + 社区动态同步 + 用户自建）
  const [customServers, setCustomServers] = useState<string[]>(loadCustomServers);
  const [syncedServers] = useState<EasyTierPublicServer[]>(loadCachedCommunityServers);
  const [selectedServer, setSelectedServer] = useState<string>(
    config.publicServer || DEFAULT_PUBLIC_SERVER,
  );
  // 优先从本地持久化缓存读取测速结果，杜绝刷新后丢失测速数据导致无法优选
  const [serverLatencies, setServerLatencies] = useState<Record<string, number | null>>(
    () => loadCachedServerLatencies().latencies,
  );
  const [testingLatency, setTestingLatency] = useState(false);
  const autoProbedRef = useRef(false);

  // 纯 P2P 创建页的 IPv6 环境检查；选中的地址实际写在 config.hostEntry 里。
  const [ipv6Addresses, setIpv6Addresses] = useState<LocalIpv6Address[]>([]);
  const [ipv6Loading, setIpv6Loading] = useState(false);
  const [ipv6Error, setIpv6Error] = useState<string | null>(null);
  /** 访客只有与房主建立直连后才开始房间探活，避免等待回执时被误踢。 */
  const [p2pLinked, setP2pLinked] = useState(false);

  // 加入房间模式下的自定义协助节点
  const [manualIsCustom, setManualIsCustom] = useState(false);
  const [manualCustomServer, setManualCustomServer] = useState("");

  // 合并全部可用服务器卡片（内置 14 个全量官方与社区节点 + 动态同步节点 + 用户已保存的自定义节点）
  const allServers = useMemo<EasyTierPublicServer[]>(() => {
    const list: EasyTierPublicServer[] = [...OFFICIAL_PUBLIC_SERVERS];
    const seenUris = new Set(list.map((s) => s.uri));

    // 追加动态同步到的未内置新节点
    syncedServers.forEach((synced) => {
      if (!seenUris.has(synced.uri)) {
        seenUris.add(synced.uri);
        list.push(synced);
      }
    });

    // 追加用户自建节点
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

  // 当测速结果或服务器列表变化时计算自动优选中继节点
  const autoBestServer = useMemo(() => {
    return pickFastestRelayServer(allServers, serverLatencies, DEFAULT_PUBLIC_SERVER);
  }, [allServers, serverLatencies]);

  const effectiveServer = useMemo(() => {
    const mode = settings?.easyTierRelayMode || "auto";
    if (mode === "auto") return autoBestServer;
    return (settings?.easyTierSelectedNode || selectedServer || DEFAULT_PUBLIC_SERVER).trim();
  }, [settings?.easyTierRelayMode, settings?.easyTierSelectedNode, selectedServer, autoBestServer]);

  const [serverGroupTab, setServerGroupTab] = useState<string>("all");

  const filteredServers = useMemo(() => {
    if (serverGroupTab === "all") return allServers;
    if (serverGroupTab === "official") return allServers.filter((s) => s.group === "官方推荐");
    if (serverGroupTab === "community") return allServers.filter((s) => s.group === "国内社区");
    if (serverGroupTab === "crossborder") return allServers.filter((s) => s.group === "海外跨境");
    if (serverGroupTab === "custom") return allServers.filter((s) => s.isCustom);
    return allServers;
  }, [allServers, serverGroupTab]);

  const [discovering, setDiscovering] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(loadActiveRoom);
  const [autoLanPort, setAutoLanPort] = useState<number | null>(null);
  const [roomResources, setRoomResources] = useState<RoomResources | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [resourceTick, setResourceTick] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [globalRefreshTick, setGlobalRefreshTick] = useState(0);

  const hostsRef = useRef(hosts);
  const statusRef = useRef(status);
  const configRef = useRef(config);
  const lastAutoPortRef = useRef<number | null>(null);
  const joiningRef = useRef(false);
  const leavingClosedRef = useRef(false);
  const autoResumeRef = useRef(false);

  hostsRef.current = hosts;
  statusRef.current = status;
  configRef.current = config;

  const roomVersion =
    (config.hostVersion &&
    installedVersions.some((entry) => entry.id === config.hostVersion)
      ? config.hostVersion
      : "") ||
    (installedVersions.some((entry) => entry.id === selectedVersion)
      ? selectedVersion
      : "") ||
    installedVersions[0]?.id ||
    "";

  const appendLog = useCallback((line: string) => {
    setLogs((current) => [...current, line].slice(-MAX_LOG_LINES));
  }, []);

  // 首次挂载时若本地测速缓存为空或过期，在后台静默分批测速一次，确保自动选出最低延迟节点
  useEffect(() => {
    if (autoProbedRef.current || allServers.length === 0) return;
    const cached = loadCachedServerLatencies();
    if (!cached.isFresh || Object.keys(cached.latencies).length === 0) {
      autoProbedRef.current = true;
      void batchProbeMultiplayerLatencies(allServers, 4, probeMultiplayerLatency)
        .then((fresh) => {
          setServerLatencies(fresh);
        })
        .catch(() => {});
    }
  }, [allServers]);

  // 测速所有节点（分批并发，智能推导 UDP 节点延迟并自动持久化缓存）
  const testAllServers = useCallback(async () => {
    setTestingLatency(true);
    try {
      const results = await batchProbeMultiplayerLatencies(
        allServers,
        4,
        probeMultiplayerLatency,
      );
      setServerLatencies(results);
      onNotify("info", "节点测速完成", `已完成 ${allServers.length} 个节点的联机握手与延迟检测`);
    } catch {
      onNotify("error", "测速异常", "网络探测失败，请检查网络连接");
    } finally {
      setTestingLatency(false);
    }
  }, [allServers, onNotify]);

  useEffect(() => {
    let alive = true;
    getMultiplayerStatus(gameRoot)
      .then((value) => {
        if (!alive) return;
        setStatus(value);
        if (!value.running || loadActiveRoom()) return;
        const current = configRef.current;
        const room: ActiveRoom = {
          role: current.role,
          networkName: value.networkName || current.networkName,
          startedAt: Date.now(),
        };
        saveActiveRoom(room);
        setActiveRoom(room);
        setPage((previous) => (previous === "home" ? "room" : previous));
      })
      .catch((error) => console.warn("无法读取联机状态", error));

    getMultiplayerInstallState(gameRoot)
      .then((state) => {
        if (alive) setInstallProgress(state);
      })
      .catch((error) => console.warn("无法读取 EasyTier 安装状态", error));

    return () => {
      alive = false;
    };
  }, [gameRoot]);

  useEffect(() => {
    saveMultiplayerConfig(config);
  }, [config]);

  useEffect(() => {
    saveMultiplayerHosts(hosts);
  }, [hosts]);

  // 进入创建页时探测本机公网 IPv6。没有全球单播地址就无法做纯 P2P，
  // 这里不自动切回公益节点，让用户明确选择。
  useEffect(() => {
    if (page !== "create" || !config.p2pOnly) {
      setIpv6Loading(false);
      return;
    }
    let alive = true;
    setIpv6Loading(true);
    setIpv6Error(null);
    getLocalIpv6Addresses()
      .then((list) => {
        if (!alive) return;
        const global = list.filter((item) => item.global);
        setIpv6Addresses(global);
        setConfig((current) => {
          if (!current.p2pOnly) return current;
          const selected = ipv6FromPeer(current.hostEntry);
          if (selected && global.some((item) => item.address === selected)) {
            // 纯 P2P 优先 UDP；旧配置里的 tcp://[IPv6] 在这里统一升级。
            const normalized = peerFromAddress(selected, current.listenPort);
            return normalized === current.hostEntry
              ? current
              : { ...current, hostEntry: normalized };
          }
          const best = global.find((item) => !item.temporary) ?? global[0];
          return best
            ? { ...current, hostEntry: peerFromAddress(best.address, current.listenPort) }
            : current;
        });
        if (global.length === 0) {
          setIpv6Error("未检测到公网 IPv6 地址。请确认宽带已启用 IPv6，或切换到公益节点模式。");
        }
      })
      .catch((error) => {
        if (alive) setIpv6Error(`读取本机 IPv6 失败：${String(error)}`);
      })
      .finally(() => {
        if (alive) setIpv6Loading(false);
      });
    return () => {
      alive = false;
    };
  }, [page, config.p2pOnly]);

  // 纯 P2P 访客：先等房主登记回执，再开始房间探活。
  useEffect(() => {
    const active =
      page === "room" &&
      Boolean(status?.running) &&
      isPureP2p(config) &&
      config.role === "guest";
    if (!active) {
      setP2pLinked(false);
      return;
    }
    let alive = true;
    setP2pLinked(false);
    const check = async () => {
      try {
        const peers = await getMultiplayerPeers(gameRoot);
        if (!alive) return;
        const linked = config.hostIpv4
          ? peers.some((peer) => !peer.isSelf && peer.ipv4 === config.hostIpv4)
          : peers.some((peer) => !peer.isSelf);
        if (linked) setP2pLinked(true);
      } catch {
        // 内核启动过程中成员表暂时不可读，继续等下一轮。
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [page, status?.running, gameRoot, config.role, config.p2pOnly, config.relay, config.hostIpv4]);

  useEffect(() => {
    saveActiveRoom(activeRoom);
  }, [activeRoom]);

  // 自动从 Minecraft 日志检测局域网端口
  useEffect(() => {
    if (!isDesktop || edition !== "java") return;
    if (!gameRoot || !roomVersion) return;
    if (page !== "create" && page !== "room") return;

    let alive = true;
    const read = async () => {
      if (!alive) return;
      if (page === "room" && configRef.current.role === "guest") {
        return;
      }
      try {
        const port = await readMinecraftLanPort(
          gameRoot,
          roomVersion,
          versionIsolation,
        );
        if (!alive || port === null) return;
        if (port === lastAutoPortRef.current) return;

        lastAutoPortRef.current = port;
        setAutoLanPort(port);
        setConfig((current) => {
          if (current.hostPort === port) return current;
          return { ...current, hostPort: port };
        });
        void pingAll(true);
        if (page === "room") {
          onNotify(
            "success",
            `已同步局域网端口 ${port}`,
            "好友已可直接通过该端口加入。",
          );
        }
      } catch {
        // 等待日志输出
      }
    };

    void read();
    const timer = window.setInterval(() => void read(), 3000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [edition, gameRoot, onNotify, page, roomVersion, versionIsolation]);

  useEffect(() => {
    if (gameRunning) return;
    lastAutoPortRef.current = null;
    setAutoLanPort(null);
  }, [gameRunning]);

  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    const track = (promise: Promise<() => void>) => {
      promise
        .then((cleanup) => {
          if (disposed) cleanup();
          else cleanups.push(cleanup);
        })
        .catch((error) => console.warn("联机事件订阅失败", error));
    };

    track(
      subscribe("multiplayer:status", (next) => {
        setStatus(next);
        if (!next.running) {
          setHosts((current) =>
            current.map((entry) => (entry.bridgePort ? { ...entry, bridgePort: null } : entry)),
          );
        }
      }),
    );
    track(
      subscribe("multiplayer:log", (payload) => {
        appendLog(`[${payload.stream}] ${payload.line}`);
      }),
    );
    track(
      subscribe("multiplayer:install", (payload) => {
        setInstallProgress(payload);
      }),
    );

    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [appendLog]);

  const pingHost = useCallback(async (entry: MultiplayerHost) => {
    const result = await probeMinecraftHost(entry.host, entry.port);
    setHosts((current) =>
      current.map((item) => {
        if (item.id !== entry.id) return item;
        const prev = item.status;
        const unchanged =
          prev &&
          prev.ok === result.ok &&
          prev.latencyMs === result.latencyMs &&
          prev.online === result.online &&
          prev.max === result.max &&
          prev.motd === result.motd &&
          prev.version === result.version;
        if (unchanged && item.checkedAt) return item;
        return { ...item, status: result, checkedAt: Date.now() };
      }),
    );
    return result;
  }, []);

  const pingAll = useCallback(async (quiet = false) => {
    const targets = hostsRef.current;
    if (targets.length === 0) return;
    if (!quiet) setPinging(true);
    try {
      await Promise.all(targets.map((entry) => pingHost(entry)));
    } finally {
      if (!quiet) setPinging(false);
    }
  }, [pingHost]);

  // 房间实时刷新定时器：每 3 秒自动平滑探测一次世界状态与延迟
  useEffect(() => {
    if (page !== "room" || !status?.running || !autoRefresh) return;

    // 首次进入 1 秒后执行初次探测
    const firstTimer = window.setTimeout(() => {
      void pingAll(true);
    }, 1000);

    // 随后每 3 秒自动轮询探测一次世界状态与在线人数
    const timer = window.setInterval(() => {
      void pingAll(true);
    }, 3000);

    return () => {
      window.clearTimeout(firstTimer);
      window.clearInterval(timer);
    };
  }, [page, status?.running, autoRefresh, pingAll]);

  // 访客每 3.5 秒轮询一次房主资源与最新端口
  useEffect(() => {
    if (page !== "room" || !status?.running || config.role !== "guest" || !autoRefresh) return;
    const interval = window.setInterval(() => {
      setResourceTick((value) => value + 1);
    }, 3500);
    return () => window.clearInterval(interval);
  }, [page, status?.running, config.role, autoRefresh]);

  // 全局一键立即刷新全部状态
  const handleRefreshAll = useCallback(async () => {
    setRefreshingAll(true);
    setGlobalRefreshTick((v) => v + 1);
    setResourceTick((v) => v + 1);
    try {
      await Promise.all([
        pingAll(false),
        getMultiplayerStatus(gameRoot)
          .then((val) => setStatus(val))
          .catch(() => {}),
      ]);
      onNotify("success", "已刷新房间", "成员列表、网络延迟与游戏世界状态已更新。");
    } finally {
      setRefreshingAll(false);
    }
  }, [gameRoot, onNotify, pingAll]);

  // 访客加入后自动建立本地通道与局域网广播
  const autoBridgingRef = useRef(false);
  useEffect(() => {
    if (page !== "room" || !status?.running || config.role !== "guest") {
      autoBridgingRef.current = false;
      return;
    }
    const hostOverlay = config.hostIpv4 || config.overlayIpv4;
    const targetHost =
      hosts.find(
        (entry) => entry.host === hostOverlay && entry.port === config.hostPort,
      ) ??
      hosts.find((entry) => entry.host === hostOverlay) ??
      hosts[0];
    if (!targetHost || targetHost.bridgePort || autoBridgingRef.current) return;

    autoBridgingRef.current = true;
    void (async () => {
      try {
        const info = await startLanBridge(
          targetHost.host,
          targetHost.port,
          targetHost.status?.motd || targetHost.label,
        );
        setHosts((current) =>
          current.map((item) =>
            item.id === targetHost.id ? { ...item, bridgePort: info.localPort } : item,
          ),
        );
        onNotify(
          "success",
          "已自动建立本地连接通道",
          `游戏内可直接进入局域网世界，或直接连接 127.0.0.1:${info.localPort}`,
        );
      } catch (err) {
        console.error("Auto bridge failed:", err);
      } finally {
        autoBridgingRef.current = false;
      }
    })();
  }, [page, status?.running, config.hostIpv4, config.overlayIpv4, config.hostPort, hosts, onNotify]);

  const handleInstall = async () => {
    if (!gameRoot) {
      onNotify("error", "还没有游戏目录", "请先在设置里确认游戏根目录。");
      return;
    }
    setRequestingInstall(true);
    try {
      const next = await installEasytier(gameRoot);
      setStatus(next);
      onNotify("success", "EasyTier 内核已就绪", next.version ?? undefined);
    } catch (error) {
      onNotify("error", "下载 EasyTier 失败", String(error));
    } finally {
      setRequestingInstall(false);
    }
  };

  const waitForHost = useCallback(
    async (hostIpv4: string, timeoutMs = 15_000): Promise<boolean> => {
      const wanted = hostIpv4.trim();
      if (!wanted) return false;
      const deadline = Date.now() + timeoutMs;
      do {
        try {
          const peers = await getMultiplayerPeers(gameRoot);
          if (peers.some((peer) => !peer.isSelf && peer.ipv4 === wanted)) return true;
        } catch {
          // 等待
        }
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      } while (Date.now() < deadline);
      return false;
    },
    [gameRoot],
  );

  /**
   * 自动发现房主（Astral 体验核心）：在同一个 EasyTier 虚拟局域网中自动识别房主 IP 与端口
   */
  const discoverHost = useCallback(
    async (
      target: MultiplayerConfig,
      timeoutMs = 25_000,
    ): Promise<{ hostIpv4: string; hostPort: number; version: string } | null> => {
      const deadline = Date.now() + timeoutMs;
      do {
        let peers: MultiplayerPeer[] = [];
        try {
          peers = await getMultiplayerPeers(gameRoot);
        } catch {
          // 等待内核就绪
        }
        for (const peer of peers) {
          if (peer.isSelf || !peer.ipv4 || peer.ipv4 === target.overlayIpv4) continue;
          try {
            const resources = await fetchRoomResources(
              peer.ipv4,
              target.resourcePort,
              target.resourceToken,
            );
            return {
              hostIpv4: peer.ipv4,
              hostPort: resources.hostPort ?? DEFAULT_HOST_PORT,
              version: resources.versionId,
            };
          } catch {
            // 继续探查下一个节点
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      } while (Date.now() < deadline);
      return null;
    },
    [gameRoot],
  );

  const leaveClosedRoom = useCallback(
    async (detail = "房主已经关闭房间，联机网络已断开。") => {
      if (leavingClosedRef.current) return;
      leavingClosedRef.current = true;
      try {
        // 1. 立即停止所有本地局域网广播桥接
        for (const entry of hostsRef.current) {
          if (entry.bridgePort) {
            await stopLanBridge(entry.bridgePort).catch(() => undefined);
          }
        }
        // 2. 彻底停止访客本机的组网内核
        const next = await stopMultiplayer(gameRoot).catch(() => null);
        if (next) setStatus(next);
        setHosts([]);
        setActiveRoom(null);
        setPage("home");
        onNotify("error", "房间已关闭", detail);
      } finally {
        leavingClosedRef.current = false;
      }
    },
    [gameRoot, onNotify],
  );

  // 访客端：房主关闭房间后 EasyTier 的成员/路由表可能还会残留旧节点，
  // 因此不能把“成员列表里还能看到房主”当成房间仍在线的证据。房主的房间
  // 资源服务与房间同生命周期，以它为准；连续失败两次就退出房间并停止组网。
  useEffect(() => {
    if (page !== "room" || !status?.running) return;
    if (configRef.current.role !== "guest") return;
    // 纯 P2P 要等房主先登记回执。在直连建立前房主资源服务必然不可达，
    // 如果这时开始探活，访客会在手动交换回执的过程中被误退出。
    if (isPureP2p(configRef.current) && !p2pLinked) return;

    const controller = new AbortController();
    const probe = async () => {
      const current = configRef.current;
      const targetHostIpv4 =
        current.hostIpv4 ||
        hostsRef.current.find((h) => h.label === "房主" || h.id.includes("房主"))?.host ||
        hostsRef.current[0]?.host;
      if (!targetHostIpv4) return;

      // 房主的资源服务随 Java 房间启动。EasyTier 成员表会残留旧路由，
      // 不能作为存活依据；旧分享码/基岩版没有资源入口时才退回成员表。
      if (edition === "java" && current.resourcePort > 0 && current.resourceToken) {
        await fetchRoomResources(
          targetHostIpv4,
          current.resourcePort,
          current.resourceToken,
          2500,
        );
        return;
      }

      const peers = await getMultiplayerPeers(gameRoot);
      if (!peers.some((peer) => !peer.isSelf && peer.ipv4 === targetHostIpv4)) {
        throw new Error("房主已离开成员列表");
      }
    };

    void watchRoomHealth({
      probe,
      signal: controller.signal,
      onClosed: () => leaveClosedRoom("房主已经关闭房间，联机已断开并自动退出。"),
    }).catch((error) => console.warn("房间存活监控失败", error));

    return () => controller.abort();
  }, [page, status?.running, gameRoot, edition, leaveClosedRoom, p2pLinked]);

  // 节点一跑起来就进入房间
  useEffect(() => {
    if (page !== "home" || !status?.running || joiningRef.current) return;
    const current = configRef.current;
    if (current.role === "host") {
      setPage("room");
      return;
    }
    let cancelled = false;
    void (async () => {
      const online = await waitForHost(current.hostIpv4, 8_000);
      if (cancelled) return;
      if (online) {
        setPage("room");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status?.running, page, waitForHost]);

  // 房间资源快照服务
  useEffect(() => {
    if (page !== "room" || !status?.running || edition !== "java") {
      setRoomResources(null);
      setResourcesLoading(false);
      setResourcesError(null);
      return;
    }

    const current = configRef.current;
    const guest = current.role === "guest";
    if (!guest && !current.hostVersion) {
      setRoomResources(null);
      setResourcesLoading(false);
      return;
    }

    let cancelled = false;
    setResourcesLoading(true);
    setResourcesError(null);
    void (async () => {
      try {
        if (guest) {
          if (!current.hostIpv4 || !current.resourcePort || !current.resourceToken) {
            setResourcesLoading(false);
            return;
          }
          const resources = await fetchRoomResources(
            current.hostIpv4,
            current.resourcePort,
            current.resourceToken,
          );
          if (cancelled) return;
          setRoomResources(resources);
          // 动态同步房主局域网端口
          if (resources?.hostPort && resources.hostPort > 0 && resources.hostPort !== current.hostPort) {
            const newPort = resources.hostPort;
            setConfig((prev) => ({ ...prev, hostPort: newPort }));
            setHosts((currentHosts) =>
              currentHosts.map((item) =>
                item.host === current.hostIpv4 ? { ...item, port: newPort } : item,
              ),
            );
            const targetHost = hostsRef.current.find((item) => item.host === current.hostIpv4);
            if (targetHost?.bridgePort) {
              await stopLanBridge(targetHost.bridgePort).catch(() => undefined);
              const info = await startLanBridge(
                current.hostIpv4,
                newPort,
                targetHost.status?.motd || targetHost.label,
              );
              setHosts((currentHosts) =>
                currentHosts.map((item) =>
                  item.host === current.hostIpv4
                    ? { ...item, port: newPort, bridgePort: info.localPort }
                    : item,
                ),
              );
              onNotify("info", "已自动同步房主最新端口", `已切换到端口 ${newPort}`);
            }
          }
        } else {
          const info = await startRoomResources(
            gameRoot,
            current.hostVersion,
            versionIsolation,
            current.networkSecret,
            roomResourceToken(current.networkSecret),
            roomResourcePort(current.networkSecret),
            current.hostPort,
          );
          if (cancelled) return;
          setRoomResources(info.resources);
          setConfig((previous) =>
            previous.resourcePort === info.port && previous.resourceToken === info.token
              ? previous
              : { ...previous, resourcePort: info.port, resourceToken: info.token },
          );
        }
      } catch (error) {
        if (cancelled) return;
        setRoomResources(null);
        setResourcesError(error instanceof Error ? error.message : String(error));
        // 心跳服务没起来时不能让分享码继续声称有资源入口，否则
        // 访客会探测失败并把正常房间误判为已关闭。
        if (!guest) {
          setConfig((previous) =>
            previous.resourcePort === 0 && !previous.resourceToken
              ? previous
              : { ...previous, resourcePort: 0, resourceToken: "" },
          );
        }
      } finally {
        if (!cancelled) setResourcesLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    edition,
    gameRoot,
    page,
    resourceTick,
    status?.running,
    versionIsolation,
    config.hostVersion,
    config.hostIpv4,
    config.hostPort,
    config.networkSecret,
    config.role,
    onNotify,
  ]);

  const rememberRoom = useCallback((next: MultiplayerConfig | null) => {
    setActiveRoom(
      next
        ? {
            role: next.role,
            networkName: next.networkName,
            startedAt: Date.now(),
          }
        : null,
    );
  }, []);

  /**
   * 启动 EasyTier 联机
   */
  const startWith = useCallback(
    async (initial: MultiplayerConfig, mode: "start" | "join" = "start") => {
      let next = initial;
      if (next.role === "guest") {
        const overlayIpv4 = freshGuestOverlay([next.overlayIpv4, next.hostIpv4]);
        if (overlayIpv4 !== next.overlayIpv4) {
          next = { ...next, overlayIpv4 };
          setConfig(next);
        }
      }
      if (!statusRef.current?.installed) {
        onNotify("info", "请先下载 EasyTier 内核");
        return false;
      }
      if (!gameRoot) {
        onNotify("error", "还没有游戏目录", "请先在设置里确认游戏根目录。");
        return false;
      }
      const isGuest = next.role === "guest";
      if (!isGuest && !next.hostVersion) {
        onNotify("error", "先选择房间版本", "创建房间前必须选一个已安装的版本。");
        return false;
      }
      if (!isGuest && !installedVersions.some((entry) => entry.id === next.hostVersion)) {
        onNotify("error", "房间版本未安装", "请先安装这个版本，或重新创建房间换一个版本。");
        return false;
      }

      if (isGuest) {
        joiningRef.current = true;
      }
      setBusy(mode);

      try {
        const started = await startMultiplayer(gameRoot, next);
        setStatus(started);

        if (isGuest) {
          const rollback = async (title: string, detail: string) => {
            try {
              setStatus(await stopMultiplayer(gameRoot));
            } catch {
              setStatus((current) =>
                current
                  ? { ...current, running: false, networkName: null, overlayIpv4: null, pid: null }
                  : current,
              );
            }
            onNotify("error", title, detail);
            return false;
          };

          if (isPureP2p(next)) {
            // 纯 P2P 的访客先启动内核，等房主在回执面板登记本机入口。
            // 此时房主还看不到访客，不能像中继模式那样在启动后立即判超时。
            setDiscovering(false);
            if (next.hostIpv4) {
              const entry: MultiplayerHost = {
                id: `${next.hostIpv4}-${next.hostPort}`,
                label: "房主",
                host: next.hostIpv4,
                port: next.hostPort,
                status: null,
                bridgePort: null,
              };
              setHosts((currentHosts) =>
                currentHosts.some((item) => item.id === entry.id)
                  ? currentHosts
                  : [...currentHosts, entry],
              );
            }
          } else if (next.hostIpv4) {
            const hostOnline = await waitForHost(next.hostIpv4);
            if (!hostOnline) {
              return await rollback(
                "无法加入房间",
                "房主可能尚未开启房间，或者双方没有共同可达的中继节点；请确认房间名和密码一致，并在设置中选择本机可用的节点。",
              );
            }
          } else {
            setDiscovering(true);
            const found = await discoverHost(next);
            setDiscovering(false);
            if (!found) {
              return await rollback(
                "找不到房主",
                "请确认房主已创建房间并在单人游戏中【对局域网开放】，且双方至少共享一个可达的中继节点。",
              );
            }
            next = {
              ...next,
              hostIpv4: found.hostIpv4,
              hostPort: found.hostPort,
              hostVersion: found.version || next.hostVersion,
            };
            setConfig(next);
            const entry: MultiplayerHost = {
              id: `${found.hostIpv4}-${found.hostPort}`,
              label: "房主",
              host: found.hostIpv4,
              port: found.hostPort,
              status: null,
              bridgePort: null,
            };
            setHosts((currentHosts) =>
              currentHosts.some((item) => item.id === entry.id)
                ? currentHosts
                : [...currentHosts, entry],
            );
            void pingHost(entry);
          }
        }

        let finalConfig = next;
        if (!isGuest && edition === "java") {
          try {
            const info = await startRoomResources(
              gameRoot,
              next.hostVersion,
              versionIsolation,
              next.networkSecret,
              roomResourceToken(next.networkSecret),
              roomResourcePort(next.networkSecret),
              next.hostPort,
            );
            finalConfig = {
              ...next,
              resourcePort: info.port,
              resourceToken: info.token,
            };
            setRoomResources(info.resources);
            setConfig(finalConfig);
          } catch (error) {
            console.warn("房间心跳服务启动失败", error);
            // 没有心跳服务时，分享码不能继续带 res/rt：否则访客会把
            // 探测失败误判成房间已关闭。清掉后退回成员表判断。
            finalConfig = { ...next, resourcePort: 0, resourceToken: "" };
            setConfig(finalConfig);
          }
        }

        rememberRoom(finalConfig);
        setPage("room");
        return true;
      } catch (error) {
        onNotify("error", "启动联机网络失败", String(error));
        return false;
      } finally {
        if (isGuest) joiningRef.current = false;
        setBusy(null);
      }
    },
    [
      edition,
      gameRoot,
      installedVersions,
      onNotify,
      rememberRoom,
      versionIsolation,
      waitForHost,
      discoverHost,
      pingHost,
    ],
  );

  // 恢复之前房间
  useEffect(() => {
    if (autoResumeRef.current) return;
    if (!status || status.running || !status.installed) return;
    if (page !== "room" || !activeRoom || busy) return;
    const current = configRef.current;
    const guest = current.role === "guest";
    if (!guest && !current.hostVersion) return;
    if (!guest && !installedVersions.some((entry) => entry.id === current.hostVersion)) return;
    autoResumeRef.current = true;
    onNotify("info", "正在接回房间", "使用上次的配置重新连接联机网络。");
    void startWith(current).then((success) => {
      if (!success) {
        // 若启动失败，立即清理房间状态并退回主页，杜绝死循环重连刷新
        rememberRoom(null);
        setPage("home");
      }
    });
  }, [activeRoom, busy, installedVersions, onNotify, page, startWith, status]);

  const applyRoomConfig = useCallback(
    async (patch: Partial<MultiplayerConfig>) => {
      const next = { ...configRef.current, ...patch };
      const guest = configRef.current.role === "guest";
      setConfig(next);
      if (!statusRef.current?.running) return;
      setBusy("start");
      try {
        await stopMultiplayer(gameRoot);
        const started = await startMultiplayer(gameRoot, next);
        setStatus(started);
        rememberRoom(next);
        if (!guest) setResourceTick((value) => value + 1);
        onNotify(
          "success",
          guest ? "已按新设置重连" : "房间已按新设置重启",
        );
      } catch (error) {
        onNotify("error", guest ? "重新连接失败" : "重启房间失败", String(error));
      } finally {
        setBusy(null);
      }
    },
    [gameRoot, onNotify, rememberRoom],
  );

  const selectConnectionMode = (mode: "p2p" | "relay") => {
    if (mode === "p2p") {
      setConfig((current) => {
        const address = ipv6FromPeer(current.hostEntry);
        return {
          ...current,
          relay: false,
          p2pOnly: true,
          allowPublicStun: false,
          publicServer: "",
          relayNodes: [],
          // 新建纯 P2P 房间时清空旧 seed，等访客回执再登记。
          peers: [],
          hostEntry: address
            ? peerFromAddress(address, current.listenPort)
            : current.hostEntry,
        };
      });
      return;
    }
    const server = effectiveServer.trim() || DEFAULT_PUBLIC_SERVER;
    const peersList = buildRoomRelayPeers([server]);
    setConfig((current) => ({
      ...current,
      relay: true,
      p2pOnly: false,
      allowPublicStun: true,
      publicServer: server,
      peers: peersList,
      relayNodes: peersList,
      hostEntry: "",
    }));
  };

  const selectIpv6Address = (address: string) => {
    setConfig((current) => ({
      ...current,
      hostEntry: peerFromAddress(address, current.listenPort),
    }));
  };

  const updateListenPort = (raw: string) => {
    const port = Number(raw) || 0;
    setConfig((current) => {
      const address = ipv6FromPeer(current.hostEntry);
      return {
        ...current,
        listenPort: port,
        hostEntry:
          address && port > 0 ? peerFromAddress(address, port) : current.hostEntry,
      };
    });
  };

  // 创建房间（纯 P2P 或公益节点模式）
  const handleCreate = () => {
    if (!roomVersion) {
      onNotify("error", "先选择房间版本", "创建房间前必须选一个已安装的版本。");
      return;
    }
    const roomName = normalizeRoomName(config.networkName || "");
    if (!roomName) {
      onNotify("error", "先填写房间名称", "房间名称用于标识你的联机网络。");
      return;
    }
    const password = config.networkSecret.trim();
    if (!isRoomPassword(password)) {
      onNotify(
        "error",
        "先设置房间密码",
        `密码需要 ${ROOM_PASSWORD_MIN}–32 位，仅限字母、数字和英文符号。`,
      );
      return;
    }

    if (config.p2pOnly) {
      const address = ipv6FromPeer(config.hostEntry);
      if (!address || !ipv6Addresses.some((item) => item.global && item.address === address)) {
        onNotify(
          "error",
          "没有可用的 IPv6 直连地址",
          "请确认本机已获取公网 IPv6，并在创建页选择一个地址。",
        );
        return;
      }
      if (!Number.isInteger(config.listenPort) || config.listenPort <= 0 || config.listenPort > 65535) {
        onNotify("error", "监听端口无效", "EasyTier 监听端口需要在 1–65535 之间。");
        return;
      }
      if (status?.version && !supportsIpv6P2p(status.version)) {
        onNotify(
          "error",
          "EasyTier 版本过低",
          "IPv6 P2P 打洞需要 EasyTier 2.3.0 或更高版本，请重新下载内核。",
        );
        return;
      }
      const next: MultiplayerConfig = {
        ...config,
        networkName: roomName,
        networkSecret: password,
        publicServer: "",
        peers: [],
        relay: false,
        p2pOnly: true,
        relayNodes: [],
        allowPublicStun: false,
        hostEntry: peerFromAddress(address, config.listenPort),
        role: "host",
        hostIpv4: "",
        hostVersion: roomVersion,
        resourcePort: roomResourcePort(password),
        resourceToken: roomResourceToken(password),
      };
      setConfig(next);
      void startWith(next);
      return;
    }

    const srv = effectiveServer.trim() || DEFAULT_PUBLIC_SERVER;
    // 房主也带上官方交汇节点：不同中继下的访客因此总能找到这个房间。
    const peersList = buildRoomRelayPeers([srv]);

    const next: MultiplayerConfig = {
      ...config,
      networkName: roomName,
      networkSecret: password,
      publicServer: srv,
      peers: peersList,
      relay: true,
      p2pOnly: false,
      relayNodes: peersList,
      allowPublicStun: true,
      hostEntry: "",
      role: "host",
      hostIpv4: "",
      hostVersion: roomVersion,
      resourcePort: roomResourcePort(password),
      resourceToken: roomResourceToken(password),
    };

    setConfig(next);
    void startWith(next);
  };

  const handleAddP2pPeer = useCallback(
    async (peer: string) => {
      const current = configRef.current;
      if (!current.p2pOnly) throw new Error("当前房间不是纯 P2P 模式");
      if (current.peers.includes(peer)) {
        onNotify("info", "该访客入口已经登记", "等待对方内核完成握手即可。");
        return;
      }
      await addMultiplayerPeer(gameRoot, peer);
      setConfig((value) =>
        value.p2pOnly && !value.peers.includes(peer)
          ? { ...value, peers: [...value.peers, peer] }
          : value,
      );
      onNotify("success", "已登记访客入口", "正在向对方的 IPv6 地址发起直连。");
    },
    [gameRoot, onNotify],
  );

  // 通过分享码加入
  const handleJoinByCode = async () => {
    const info = parseShareCode(joinCode);
    if (!info) {
      onNotify("error", "分享码无法识别", "请检查分享码是否完整。");
      return;
    }
    setBusy("join");
    try {
      const current = configRef.current;
      const overlayIpv4 =
        info.hostIpv4 === current.overlayIpv4
          ? createOverlayIpv4()
          : current.overlayIpv4;

      // 中继房间：访客先使用自己当前网络的优选/指定节点，再并入房主声明
      // 的节点和官方交汇节点。房主的中继在访客网络可能被屏蔽，不能把它
      // 当成唯一入口；本机节点在前，才能保证访客先有一条可用链路。
      const localRelay = info.p2pOnly
        ? ""
        : (effectiveServer.trim() || DEFAULT_PUBLIC_SERVER);
      const guestRelayPeers = info.p2pOnly
        ? []
        : buildGuestRelayPeers(localRelay, [
            info.publicServer ?? "",
            ...info.relayNodes,
          ]);
      const peersList = info.p2pOnly && info.peer ? [info.peer] : guestRelayPeers;
      const serverUri = info.p2pOnly ? "" : (peersList[0] ?? DEFAULT_PUBLIC_SERVER);

      const next: MultiplayerConfig = {
        ...current,
        networkName: info.networkName,
        networkSecret: info.networkSecret,
        overlayIpv4,
        publicServer: info.p2pOnly ? "" : serverUri,
        peers: peersList,
        relay: !info.p2pOnly,
        p2pOnly: info.p2pOnly,
        relayNodes: info.p2pOnly ? [] : peersList,
        allowPublicStun: info.allowPublicStun,
        listenPort: info.listenPort,
        hostEntry: info.peer ?? "",
        role: "guest",
        hostPort: info.hostPort,
        hostIpv4: info.hostIpv4,
        resourcePort: info.resourcePort,
        resourceToken: info.resourceToken,
      };

      setConfig(next);
      const entry: MultiplayerHost = {
        id: `${info.hostIpv4}-${info.hostPort}`,
        label: "房主",
        host: info.hostIpv4,
        port: info.hostPort,
        status: null,
        bridgePort: null,
      };

      const started = await startWith(next, "join");
      if (started) {
        setHosts((currentHosts) =>
          currentHosts.some((item) => item.id === entry.id)
            ? currentHosts
            : [...currentHosts, entry],
        );
        setJoinCode("");
        void pingHost(entry);
      }
    } finally {
      setBusy(null);
    }
  };

  // Astral 原生模式：通过【房间名 + 密码】加入
  const handleJoinByManual = async () => {
    // 房间名是 EasyTier 的网络标识，空白/大小写不同就会变成另一张网络。
    const roomName = normalizeRoomName(manualRoomName);
    if (!roomName) {
      onNotify("error", "请输入房间名称", "与房主设置的房间名称保持一致。");
      return;
    }
    const password = manualRoomSecret.trim();
    if (!isRoomPassword(password)) {
      onNotify("error", "请输入房间密码", `密码需要 ${ROOM_PASSWORD_MIN}–32 位。`);
      return;
    }

    setBusy("join");
    let serverUri = manualServer.trim() || DEFAULT_PUBLIC_SERVER;
    if (manualIsCustom && manualCustomServer.trim()) {
      const parsed = parseServerUri(manualCustomServer);
      if (!parsed) {
        onNotify("error", "协助节点格式无效", "支持 tcp://主机:端口 或 udp://主机:端口（例如 tcp://vps.com:11010）");
        setBusy(null);
        return;
      }
      serverUri = parsed.full;
      if (!customServers.includes(serverUri)) {
        const nextList = [...customServers, serverUri];
        setCustomServers(nextList);
        saveCustomServers(nextList);
      }
    }

    // 手动加入时拿不到房主的节点清单，只能靠官方交汇节点兜底：双方各自
    // 选中不同中继也能通过这组公共节点互相发现，房间因此不再被中继隔离。
    const peersList = buildRoomRelayPeers([serverUri]);

    const next: MultiplayerConfig = {
      ...configRef.current,
      networkName: roomName,
      networkSecret: password,
      overlayIpv4: createOverlayIpv4(),
      publicServer: peersList[0] ?? serverUri,
      peers: peersList,
      relay: true,
      p2pOnly: false,
      relayNodes: peersList,
      allowPublicStun: true,
      hostEntry: "",
      role: "guest",
      hostIpv4: "",
      hostVersion: "",
      hostPort: DEFAULT_HOST_PORT,
      resourcePort: roomResourcePort(password),
      resourceToken: roomResourceToken(password),
    };

    setConfig(next);
    try {
      const started = await startWith(next, "join");
      if (started) {
        setManualRoomName("");
        setManualRoomSecret("");
      }
    } finally {
      setBusy(null);
    }
  };

  const handleLeave = async () => {
    setBusy("stop");
    try {
      // 1. 彻底停止所有正在运行的局域网代理桥接与广播
      for (const entry of hostsRef.current) {
        if (entry.bridgePort) {
          await stopLanBridge(entry.bridgePort).catch(() => undefined);
        }
      }
      // 2. 彻底停止 EasyTier 内核与网络组网
      const next = await stopMultiplayer(gameRoot);
      setStatus(next);
      autoResumeRef.current = false;
      rememberRoom(null);
      setHosts([]);
      setPage("home");
      onNotify("info", configRef.current.role === "host" ? "房间已关闭" : "已离开房间", "联机服务已停止。");
    } catch (error) {
      onNotify("error", "关闭失败", String(error));
    } finally {
      setBusy(null);
    }
  };

  const handleAddHost = (input: string): boolean => {
    const parsed = parseHostAddress(input);
    if (!parsed) {
      onNotify("error", "地址格式不对", "示例：10.126.126.7:25565");
      return false;
    }
    const entry: MultiplayerHost = {
      id: `${parsed.host}-${parsed.port}`,
      label: parsed.host,
      host: parsed.host,
      port: parsed.port,
      status: null,
      bridgePort: null,
    };
    if (hostsRef.current.some((item) => item.id === entry.id)) {
      onNotify("info", "这个地址已经在列表里了");
      return false;
    }
    setHosts((current) => [...current, entry]);
    if (statusRef.current?.running) void pingHost(entry);
    return true;
  };

  const handleRemoveHost = async (entry: MultiplayerHost) => {
    if (entry.bridgePort) await stopLanBridge(entry.bridgePort).catch(() => undefined);
    setHosts((current) => current.filter((item) => item.id !== entry.id));
  };

  const handleToggleBridge = async (entry: MultiplayerHost) => {
    if (!statusRef.current?.running) {
      onNotify("info", "网络还没有连接");
      return;
    }
    try {
      if (entry.bridgePort) {
        await stopLanBridge(entry.bridgePort);
        setHosts((current) =>
          current.map((item) => (item.id === entry.id ? { ...item, bridgePort: null } : item)),
        );
        return;
      }
      const info = await startLanBridge(entry.host, entry.port, entry.status?.motd || entry.label);
      setHosts((current) =>
        current.map((item) =>
          item.id === entry.id ? { ...item, bridgePort: info.localPort } : item,
        ),
      );
    } catch (error) {
      onNotify("error", "局域网广播失败", String(error));
    }
  };

  const handleChangePort = useCallback(
    (port: number) => {
      setConfig((current) => ({ ...current, hostPort: port }));
      onNotify("success", "端口已更新", "好友可直接在游戏内更新连接。");
    },
    [onNotify],
  );

  const refreshRoomResources = useCallback(() => {
    setResourceTick((value) => value + 1);
  }, []);

  const shareCode = useMemo(
    () => buildShareCode(config),
    [config],
  );

  const joinPreview = useMemo(() => parseShareCode(joinCode), [joinCode]);
  const running = Boolean(status?.running);
  const installed = Boolean(status?.installed);
  const kernelIncomplete = !installed && Boolean(status?.version);
  const installing = requestingInstall || Boolean(installProgress?.active);

  const portValid =
    Number.isInteger(config.hostPort) &&
    config.hostPort > 0 &&
    config.hostPort < 65536;
  const passwordValid = isRoomPassword(config.networkSecret);
  const hosted = Boolean(roomVersion) && installedVersions.some((entry) => entry.id === roomVersion);
  const selectedIpv6 = ipv6FromPeer(config.hostEntry);
  const listenPortValid =
    Number.isInteger(config.listenPort) &&
    config.listenPort > 0 &&
    config.listenPort < 65536;
  const hasGlobalIpv6 = ipv6Addresses.some((item) => item.global);

  const createBlockers: string[] = [];
  if (!installed) createBlockers.push("先下载 EasyTier 内核");
  if (!roomVersion) createBlockers.push("先选择房间版本");
  if (!portValid) createBlockers.push("局域网端口需要是 1–65535");
  if (!passwordValid) createBlockers.push(`房间密码需要 ${ROOM_PASSWORD_MIN}–32 位`);
  if (!config.networkName?.trim()) createBlockers.push("请输入房间名称");
  if (config.p2pOnly) {
    if (ipv6Loading) createBlockers.push("正在检测本机 IPv6…");
    else if (!hasGlobalIpv6) createBlockers.push("本机没有公网 IPv6，无法创建纯 P2P 房间");
    if (!selectedIpv6) createBlockers.push("请选择一个 IPv6 直连地址");
    if (!listenPortValid) createBlockers.push("EasyTier 监听端口需要是 1–65535");
    if (status?.version && !supportsIpv6P2p(status.version)) {
      createBlockers.push("EasyTier 需要 2.3.0 以上才支持 IPv6 打洞");
    }
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <PageHeader
        title="简易联机"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
                running
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : installed
                    ? "border-border/60 bg-muted/20 text-muted-foreground"
                    : "border-gold/30 bg-gold/10 text-gold",
              )}
            >
              <StatusDot tone={running ? "online" : installed ? "muted" : "warn"} />
              {running
                ? "EasyTier 运行中"
                : installed
                  ? `EasyTier ${status?.version || "已安装"}`
                  : kernelIncomplete
                    ? "内核文件不完整"
                    : "未安装 EasyTier"}
            </span>

            {!installed ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-[11px]"
                disabled={installing}
                onClick={handleInstall}
              >
                {installing ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <Download className="size-3" />
                )}
                {installing ? "正在下载内核…" : "一键下载内核"}
              </Button>
            ) : null}

            {page === "room" ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-[11px] text-destructive hover:bg-destructive/10"
                disabled={busy === "stop"}
                onClick={handleLeave}
              >
                {busy === "stop" ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <Square className="size-3" />
                )}
                {config.role === "guest" ? "离开房间" : "关闭房间"}
              </Button>
            ) : null}
          </div>
        }
      />

      {page !== "home" && page !== "room" ? (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => setPage("home")}
          >
            <ArrowLeft className="size-3.5" />
            返回首页
          </Button>
          <span className="text-xs text-muted-foreground">/</span>
          <span className="text-xs font-medium">
            {page === "create" ? "创建房间" : "加入房间"}
          </span>
        </div>
      ) : null}

      {page === "home" ? (
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center justify-center gap-6 py-6">
          <div className="grid w-full gap-4 sm:grid-cols-2">
            <RoleCard
              icon={Network}
              title="我是房主 · 创建房间"
              desc="单人游戏开放局域网后开房，好友用分享码加入"
              onClick={() => setPage("create")}
            />
            <RoleCard
              icon={Users}
              title="我是访客 · 加入房间"
              desc="输入好友的房间名+密码，或粘贴一键分享码"
              onClick={() => setPage("join")}
            />
          </div>

        </div>
      ) : null}

      {page === "create" ? (
        <div className="mx-auto w-full max-w-3xl space-y-4">
          {/* Step 0: 连接方式 */}
          <section className="rounded-xl border border-border/70 bg-card/55 p-4">
            <StepHeader
              step="0"
              title="连接方式"
              detail={config.p2pOnly ? "只允许 IPv6 直连" : "共享节点协助与中继"}
            />
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <ModeCard
                active={config.p2pOnly}
                icon={Globe}
                title="纯 IPv6 P2P"
                desc="双方公网 IPv6 + 回执码交换，强制无中继。"
                tag="无中继"
                onClick={() => selectConnectionMode("p2p")}
              />
              <ModeCard
                active={!config.p2pOnly}
                icon={Server}
                title="公益节点模式"
                desc="没有公网 IPv6 也能用，允许共享节点转发。"
                tag="有中继"
                onClick={() => selectConnectionMode("relay")}
              />
            </div>
          </section>

          {/* Step 1: 游戏世界与端口 */}
          <section className="rounded-xl border border-border/70 bg-card/55 p-4">
            <StepHeader
              step="1"
              title="选择游戏版本与局域网端口"
              detail={edition === "bedrock" ? "基岩版" : "Java 版"}
            />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <FieldLabel>房间版本</FieldLabel>
                <div className="relative">
                  <select
                    value={roomVersion}
                    disabled={installedVersions.length === 0}
                    onChange={(event) => {
                      const value = event.target.value;
                      setConfig((current) => ({ ...current, hostVersion: value }));
                    }}
                    className="h-9 w-full appearance-none rounded-lg border border-input bg-background/30 px-2.5 pr-8 text-[12px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                  >
                    {!roomVersion ? (
                      <option value="">选择要开房的版本</option>
                    ) : null}
                    {installedVersions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.id}
                        {entry.loader ? ` · ${entry.loader}` : ""}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-9 shrink-0 gap-1.5 text-[11px]"
                disabled={!hosted}
                onClick={() => onLaunchVersion(roomVersion)}
              >
                <Play className="size-3 fill-current" />
                启动游戏
              </Button>
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="w-full sm:w-44">
                <FieldLabel>局域网端口</FieldLabel>
                <div className="flex h-9 items-center rounded-lg border border-input bg-background/30 px-3 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                  <span className="font-mono text-[14px] text-muted-foreground">:</span>
                  <input
                    value={config.hostPort ? String(config.hostPort) : ""}
                    inputMode="numeric"
                    placeholder="25565"
                    onChange={(event) => {
                      const raw = event.target.value.replace(/\D/g, "").slice(0, 5);
                      setConfig((current) => ({
                        ...current,
                        hostPort: Number(raw) || 0,
                      }));
                    }}
                    onBlur={() =>
                      setConfig((current) => ({
                        ...current,
                        hostPort: portValid ? current.hostPort : 25565,
                      }))
                    }
                    className="h-full w-full bg-transparent px-1.5 font-mono text-[14px] outline-none placeholder:text-muted-foreground/35"
                  />
                </div>
              </div>
              {autoLanPort && autoLanPort === config.hostPort ? (
                <div className="flex-1 pb-1 text-[11px] leading-5 text-primary font-medium">
                  ✓ 已从游戏日志自动检测并填入端口 {autoLanPort}
                </div>
              ) : null}
            </div>
          </section>

          {/* Step 2: Astral 房间设置 */}
          <section className="rounded-xl border border-border/70 bg-card/55 p-4">
            <StepHeader step="2" title="房间名称与密码" />

            <div className="mt-3 space-y-3">
              <div>
                <FieldLabel>房间名称</FieldLabel>
                <div className="flex gap-2">
                  <Input
                    value={config.networkName}
                    placeholder="例如：mc-room-apple"
                    onChange={(e) =>
                      setConfig((cur) => ({ ...cur, networkName: e.target.value }))
                    }
                    className="h-9 font-mono text-[12px]"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 gap-1 text-[11px]"
                    onClick={() =>
                      setConfig((cur) => ({ ...cur, networkName: createRoomName() }))
                    }
                  >
                    <RefreshCw className="size-3" />
                    随机名称
                  </Button>
                </div>
              </div>

              <div>
                <FieldLabel>房间密码</FieldLabel>
                <div className="flex gap-2">
                  <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background/30 px-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                    <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                    <input
                      type={showPassword ? "text" : "password"}
                      value={config.networkSecret}
                      maxLength={64}
                      placeholder={`至少 ${ROOM_PASSWORD_MIN} 位`}
                      onChange={(event) =>
                        setConfig((current) => ({
                          ...current,
                          networkSecret: event.target.value,
                        }))
                      }
                      className="h-full w-full min-w-0 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground/40"
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 shrink-0 text-muted-foreground"
                      title={showPassword ? "隐藏密码" : "显示密码"}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                    </Button>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 gap-1 text-[11px]"
                    onClick={() =>
                      setConfig((current) => ({ ...current, networkSecret: createRoomPassword() }))
                    }
                  >
                    <RefreshCw className="size-3" />
                    随机密码
                  </Button>
                </div>
              </div>
            </div>
          </section>

          {config.p2pOnly ? (
            <section className="rounded-xl border border-border/70 bg-card/55 p-4">
              <StepHeader
                step="3"
                title="本机 IPv6 直连入口"
                detail="分享码只包含这个地址"
              />
              {ipv6Loading ? (
                <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  正在读取本机 IPv6 地址…
                </div>
              ) : ipv6Error ? (
                <p className="mt-3 rounded-lg border border-gold/30 bg-gold/[0.06] px-3 py-2 text-[10.5px] leading-4 text-gold">
                  {ipv6Error}
                </p>
              ) : (
                <div className="mt-3 space-y-1.5">
                  {ipv6Addresses.map((item) => {
                    const selected = selectedIpv6 === item.address;
                    return (
                      <button
                        key={`${item.interface}-${item.address}`}
                        type="button"
                        onClick={() => selectIpv6Address(item.address)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                          selected
                            ? "border-primary/50 bg-primary/[0.06]"
                            : "border-border/60 bg-background/30 hover:border-border hover:bg-card/70",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-4 shrink-0 items-center justify-center rounded-full border",
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-muted-foreground/30",
                          )}
                        >
                          {selected ? <Check className="size-2.5 stroke-[3]" /> : null}
                        </span>
                        <code className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
                          {item.address}
                        </code>
                        <span className="shrink-0 text-[9px] text-muted-foreground">
                          {item.interface}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "h-4 shrink-0 px-1 text-[8.5px] font-normal",
                            item.temporary
                              ? "border-gold/30 text-gold/80"
                              : "border-primary/25 text-primary/80",
                          )}
                        >
                          {item.temporary ? "临时" : "稳定"}
                        </Badge>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="w-full sm:w-40">
                  <FieldLabel>EasyTier 监听端口</FieldLabel>
                  <Input
                    value={config.listenPort ? String(config.listenPort) : ""}
                    inputMode="numeric"
                    placeholder="11010"
                    onChange={(event) =>
                      updateListenPort(event.target.value.replace(/\D/g, "").slice(0, 5))
                    }
                    className="h-9 font-mono text-[12px]"
                  />
                </div>
              </div>

              <div className="mt-3 rounded-lg border border-border/50 bg-muted/15 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-muted-foreground">当前入口</span>
                  {status?.version ? (
                    <span
                      className={cn(
                        "font-mono text-[9.5px]",
                        supportsIpv6P2p(status.version) ? "text-primary" : "text-destructive",
                      )}
                    >
                      EasyTier {status.version}
                      {supportsIpv6P2p(status.version) ? " 支持 IPv6 P2P" : " 版本过低"}
                    </span>
                  ) : null}
                </div>
                <code className="mt-1 block truncate font-mono text-[10.5px] text-foreground">
                  {config.hostEntry || "未选择 IPv6 地址"}
                </code>
              </div>
            </section>
          ) : null}

          {/* Step 3: EasyTier 协助节点 */}
          <section
            className={cn(
              "rounded-xl border border-border/70 bg-card/55 p-4",
              config.p2pOnly && "hidden",
            )}
          >
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <StepHeader step="3" title="EasyTier 协助节点" detail="打洞与多线路中继" />
              <div className="flex items-center gap-1.5 self-end sm:self-auto">
                {onOpenSettings && (
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 gap-1 px-2 text-[10px] text-primary"
                    onClick={() => onOpenSettings("download")}
                    title="前往设置中的网络设置管理中继节点、自建节点与全量测速"
                  >
                    <Settings className="size-3" />
                    网络设置管理节点
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 gap-1 px-2 text-[10px]"
                  disabled={testingLatency}
                  onClick={testAllServers}
                >
                  {testingLatency ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <Zap className="size-3 text-amber-400" />
                  )}
                  测速选优
                </Button>
              </div>
            </div>

            {/* 当前中继节点与模式摘要 */}
            <div className="mt-3 rounded-xl border border-border/60 bg-background/40 p-3.5">
              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11.5px] font-medium text-foreground">当前中继策略：</span>
                    {(settings?.easyTierRelayMode || "auto") === "auto" ? (
                      <Badge className="h-5 border-0 bg-primary/20 px-2 text-[10px] font-medium text-primary">
                        自动选择最优节点 (默认)
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="h-5 border-border/80 px-2 text-[10px] font-medium text-foreground"
                      >
                        手动指定节点
                      </Badge>
                    )}
                  </div>
                  <p className="text-[10.5px] text-muted-foreground">
                    {(settings?.easyTierRelayMode || "auto") === "auto"
                      ? "启动联机时将自动连接全网延迟最低的中继节点，协助双方 NAT 打洞并作为跨网备用中继通道。"
                      : "在下方节点卡片列表中手动指定固定的协助打洞与多线路中继节点。"}
                  </p>
                </div>

                {/* 快捷切换模式 */}
                {onUpdateSettings && (
                  <div className="flex items-center gap-1 shrink-0 rounded-lg border border-border/60 bg-muted/30 p-0.5 self-start sm:self-auto">
                    <button
                      type="button"
                      onClick={() => {
                        onUpdateSettings({ easyTierRelayMode: "auto" });
                        onNotify("info", "已切换为自动优选中继节点", "将根据网络延迟动态优选最佳协助节点。");
                      }}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors select-none",
                        (settings?.easyTierRelayMode || "auto") === "auto"
                          ? "bg-primary text-primary-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      自动优选
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onUpdateSettings({ easyTierRelayMode: "manual" });
                        onNotify("info", "已切换为手动指定中继节点", "请在下方卡片列表中选择你想要使用的节点。");
                      }}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors select-none",
                        settings?.easyTierRelayMode === "manual"
                          ? "bg-primary text-primary-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      手动选择
                    </button>
                  </div>
                )}
              </div>

              {/* 选定节点展示摘要 */}
              <div className="mt-2.5 flex items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5 text-[11px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-muted-foreground">
                    {(settings?.easyTierRelayMode || "auto") === "auto" ? "当前优选地址:" : "当前指定地址:"}
                  </span>
                  <code className="font-mono font-semibold text-foreground truncate max-w-[280px]">
                    {effectiveServer}
                  </code>
                </div>
                {serverLatencies[effectiveServer] != null ? (
                  <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[9.5px] font-medium text-emerald-400">
                    {serverLatencies[effectiveServer]} ms
                  </span>
                ) : (
                  <span className="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[9.5px] text-muted-foreground">
                    就绪
                  </span>
                )}
              </div>
            </div>

            {/* 手动选择模式下展示与设置一致的卡片列表 */}
            {settings?.easyTierRelayMode === "manual" ? (
              <div className="mt-3 space-y-3">
                {/* 分类筛选标签 */}
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border/50 pb-2">
                  {[
                    { id: "all", label: "全部节点", count: allServers.length },
                    {
                      id: "official",
                      label: "官方推荐",
                      count: allServers.filter((s) => s.group === "官方推荐").length,
                    },
                    {
                      id: "community",
                      label: "国内社区",
                      count: allServers.filter((s) => s.group === "国内社区").length,
                    },
                    {
                      id: "crossborder",
                      label: "海外跨境",
                      count: allServers.filter((s) => s.group === "海外跨境").length,
                    },
                    ...(allServers.some((s) => s.isCustom)
                      ? [
                          {
                            id: "custom",
                            label: "我的自建",
                            count: allServers.filter((s) => s.isCustom).length,
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

                {/* 节点卡片列表 */}
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {filteredServers.map((srv) => {
                    const isSelected =
                      (settings?.easyTierSelectedNode || selectedServer || DEFAULT_PUBLIC_SERVER) === srv.uri;
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
                          setSelectedServer(srv.uri);
                          onUpdateSettings?.({ easyTierSelectedNode: srv.uri });
                          onNotify("success", "已选定协助节点", srv.uri);
                        }}
                        className={cn(
                          "relative flex flex-col justify-between rounded-xl border p-3.5 text-left transition-all cursor-pointer select-none",
                          isSelected
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
                                  isSelected
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-muted-foreground/30 bg-transparent",
                                )}
                              >
                                {isSelected ? <Check className="size-2.5 stroke-[3]" /> : null}
                              </span>
                            </div>
                          </div>

                          {/* URI 地址栏 */}
                          <div className="mt-2.5 flex items-center justify-between gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 font-mono text-[10.5px]">
                            <code className="min-w-0 flex-1 truncate font-medium text-foreground">
                              {srv.uri}
                            </code>
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
                  <span>共载入 {allServers.length} 个 EasyTier 协助中继节点</span>
                  {onOpenSettings && (
                    <button
                      type="button"
                      onClick={() => onOpenSettings("download")}
                      className="flex items-center gap-1 text-primary hover:underline"
                    >
                      在网络设置中添加自建节点或深度管理
                      <ExternalLink className="size-2.5" />
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-muted-foreground/80 px-1">
                <span>已启用自动选择延迟最低的优质协助节点（可随时切换为「手动选择」）</span>
                {onOpenSettings && (
                  <button
                    type="button"
                    onClick={() => onOpenSettings("download")}
                    className="flex items-center gap-1 text-primary hover:underline"
                  >
                    前往网络设置管理节点
                    <ExternalLink className="size-2.5" />
                  </button>
                )}
              </div>
            )}
          </section>

          {/* 创建按钮 */}
          <div className="flex flex-wrap items-center justify-end gap-3 rounded-xl border border-border/70 bg-card/55 px-4 py-3">
            {createBlockers.length > 0 ? (
              <p className="max-w-md text-[10.5px] leading-4 text-gold">
                提示：{createBlockers.join("；")}
              </p>
            ) : null}
            <Button
              size="sm"
              className="h-9 gap-1.5 px-4 font-medium"
              disabled={createBlockers.length > 0}
              onClick={handleCreate}
            >
              {busy === "start" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Network className="size-3.5" />
              )}
              立即创建房间
            </Button>
          </div>
        </div>
      ) : null}

      {page === "join" ? (
        <div className="mx-auto w-full max-w-2xl space-y-4">
          <div className="inline-flex rounded-lg border border-border/70 bg-muted/15 p-0.5">
            <button
              type="button"
              aria-pressed={joinTab === "manual"}
              onClick={() => setJoinTab("manual")}
              className={cn(
                "h-7 rounded-md px-3 text-[11px] font-medium transition-colors",
                joinTab === "manual"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              房间名 + 密码加入（Astral 模式）
            </button>
            <button
              type="button"
              aria-pressed={joinTab === "code"}
              onClick={() => setJoinTab("code")}
              className={cn(
                "h-7 rounded-md px-3 text-[11px] font-medium transition-colors",
                joinTab === "code"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              一键分享码加入
            </button>
          </div>

          {joinTab === "manual" ? (
            <section className="rounded-xl border border-border/70 bg-card/55 p-4 space-y-3.5">
              <div>
                <FieldLabel>房间名称</FieldLabel>
                <Input
                  value={manualRoomName}
                  onChange={(e) => setManualRoomName(e.target.value)}
                  placeholder="房主设置的房间名称（如 mc-room-xxx）"
                  className="h-9 font-mono text-[12px]"
                />
              </div>

              <div>
                <FieldLabel>房间密码</FieldLabel>
                <div className="flex h-9 items-center gap-2 rounded-lg border border-input bg-background/30 px-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                  <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={manualRoomSecret}
                    maxLength={64}
                    placeholder="房主设置的房间密码"
                    onChange={(event) => setManualRoomSecret(event.target.value)}
                    className="h-full w-full min-w-0 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground/40"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 shrink-0 text-muted-foreground"
                    title={showPassword ? "隐藏密码" : "显示密码"}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                  </Button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <FieldLabel>协助节点（需与房主保持一致）</FieldLabel>
                  <button
                    type="button"
                    onClick={() => setManualIsCustom(!manualIsCustom)}
                    className="text-[10px] text-primary hover:underline transition-colors"
                  >
                    {manualIsCustom ? "从预设列表中选择" : "输入自定义协助节点"}
                  </button>
                </div>

                {manualIsCustom ? (
                  <div className="mt-1">
                    <Input
                      value={manualCustomServer}
                      onChange={(e) => setManualCustomServer(e.target.value)}
                      placeholder="tcp://房主的自建节点:11010"
                      className="h-9 font-mono text-[11.5px]"
                    />
                    <p className="mt-1 text-[9.5px] text-muted-foreground">
                      若房主使用了自建服务器，请向房主索取并在此填入相同的节点地址。
                    </p>
                  </div>
                ) : (
                  <div className="relative mt-1">
                    <select
                      value={manualServer}
                      onChange={(e) => setManualServer(e.target.value)}
                      className="h-9 w-full appearance-none rounded-lg border border-input bg-background/30 px-2.5 pr-8 text-[11.5px] font-mono outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                    >
                      {["官方推荐", "国内社区", "海外跨境", "自建节点"].map((groupName) => {
                        const items = allServers.filter(
                          (s) =>
                            s.group === groupName || (groupName === "自建节点" && s.isCustom),
                        );
                        if (items.length === 0) return null;
                        return (
                          <optgroup
                            key={groupName}
                            label={groupName}
                            className="bg-popover text-popover-foreground"
                          >
                            {items.map((srv) => (
                              <option key={srv.id} value={srv.uri}>
                                {srv.name} — {srv.uri}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                    <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
                <p className="text-[10px] text-muted-foreground">
                  {discovering && busy === "join"
                    ? "正在虚拟局域网中自动搜寻房主世界…"
                    : "加入后将自动发现房主并建立本地通道。"}
                </p>
                <Button
                  className="h-8 gap-1.5"
                  disabled={
                    !installed ||
                    busy === "join" ||
                    !manualRoomName.trim() ||
                    !isRoomPassword(manualRoomSecret)
                  }
                  onClick={() => void handleJoinByManual()}
                >
                  {busy === "join" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowRight className="size-3.5" />
                  )}
                  {busy === "join" ? "正在连接…" : "加入房间"}
                </Button>
              </div>
            </section>
          ) : (
            <section className="rounded-xl border border-border/70 bg-card/55 p-4 space-y-3">
              <FieldLabel>粘贴房主分享码</FieldLabel>
              <textarea
                value={joinCode}
                onChange={(event) => setJoinCode(event.target.value)}
                rows={3}
                placeholder="cobble-mp://join?name=..."
                className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[11px] leading-5 outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
              />

              {joinPreview ? (
                <div className="grid gap-2 rounded-lg border border-border/50 bg-muted/15 px-3 py-2.5 sm:grid-cols-3">
                  <div>
                    <p className="text-[9px] text-muted-foreground/70">房间名称</p>
                    <p className="font-mono text-[11px] font-medium truncate">{joinPreview.networkName}</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/70">游戏版本</p>
                    <p className="font-mono text-[11px] truncate">{joinPreview.hostVersion || "未指定"}</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/70">局域网端口</p>
                    <p className="font-mono text-[11px]">{joinPreview.hostPort}</p>
                  </div>
                  <div className="border-t border-border/40 pt-2 sm:col-span-3">
                    <p
                      className={cn(
                        "text-[10px] leading-4",
                        joinPreview.mode === "p2p" ? "text-primary" : "text-muted-foreground",
                      )}
                    >
                      {joinPreview.mode === "p2p"
                        ? "纯 IPv6 P2P：不经过公益中继。加入后把本机回执码发给房主，房主登记后才会建立直连。"
                        : `公益节点：本机 ${effectiveServer}；同时尝试房主节点 ${joinPreview.publicServer ?? DEFAULT_PUBLIC_SERVER} 与公共交汇节点。`}
                    </p>
                  </div>
                </div>
              ) : joinCode.trim() ? (
                <p className="text-[10.5px] text-destructive">无法解析该分享码，请确认是否完整。</p>
              ) : null}

              <div className="flex justify-end pt-2">
                <Button
                  className="h-8 gap-1.5"
                  disabled={!joinPreview || !installed || busy === "join"}
                  onClick={() => void handleJoinByCode()}
                >
                  {busy === "join" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowRight className="size-3.5" />
                  )}
                  {busy === "join" ? "正在加入…" : "加入房间"}
                </Button>
              </div>
            </section>
          )}
        </div>
      ) : null}

      {page === "room" ? (
        <MultiplayerRoom
          gameRoot={gameRoot}
          installedVersions={installedVersions}
          onRefreshInstalled={onRefreshInstalled}
          config={config}
          status={status}
          busy={busy}
          hosts={hosts}
          logs={logs}
          shareCode={shareCode}
          pinging={pinging}
          resources={roomResources}
          resourcesLoading={resourcesLoading}
          resourcesError={resourcesError}
          p2pLinked={p2pLinked}
          gameRunning={gameRunning}
          autoLanPort={autoLanPort}
          autoRefresh={autoRefresh}
          onToggleAutoRefresh={() => setAutoRefresh((prev) => !prev)}
          onRefreshAll={() => void handleRefreshAll()}
          refreshingAll={refreshingAll}
          refreshTick={globalRefreshTick}
          onLaunchVersion={onLaunchVersion}
          onRefreshResources={refreshRoomResources}
          onChangePort={handleChangePort}
          onResume={() => void startWith(configRef.current)}
          onApplyConfig={(patch) => void applyRoomConfig(patch)}
          onAddPeer={handleAddP2pPeer}
          onAddHost={handleAddHost}
          onRemoveHost={(entry) => void handleRemoveHost(entry)}
          onToggleBridge={(entry) => void handleToggleBridge(entry)}
          onPingHost={pingHost}
          onPingAll={() => void pingAll(false)}
          onNotify={onNotify}
        />
      ) : null}
    </div>
  );
}
