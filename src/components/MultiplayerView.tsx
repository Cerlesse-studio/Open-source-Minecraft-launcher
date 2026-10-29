import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Network,
  Play,
  RefreshCw,
  Square,
  Users,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchRoomResources,
  getLocalIpv6Addresses,
  getMultiplayerFirewallStatus,
  getMultiplayerInstallState,
  getMultiplayerPeers,
  getMultiplayerStatus,
  installEasytier,
  isDesktop,
  probeMinecraftHost,
  probeMultiplayerEndpoint,
  readMinecraftLanPort,
  setupMultiplayerFirewall,
  startLanBridge,
  startMultiplayer,
  startRoomResources,
  stopLanBridge,
  stopMultiplayer,
  subscribe,
} from "../lib/backend";
import {
  buildShareCode,
  createOverlayIpv4,
  createRoomPassword,
  DEFAULT_HOST_PORT,
  ipv6FromPeer,
  isRoomPassword,
  ROOM_NETWORK_NAME,
  ROOM_PASSWORD_MIN,
  loadActiveRoom,
  loadMultiplayerConfig,
  loadMultiplayerHosts,
  loadPublicAddress,
  parseHostAddress,
  parseIpv6Entry,
  parseShareCode,
  peerFromAddress,
  roomResourcePort,
  roomResourceToken,
  saveActiveRoom,
  saveMultiplayerConfig,
  saveMultiplayerHosts,
  savePublicAddress,
  type ActiveRoom,
} from "../lib/multiplayer";
import type {
  GameEdition,
  InstalledVersion,
  LocalIpv6Address,
  MultiplayerConfig,
  MultiplayerHost,
  MultiplayerInstallState,
  MultiplayerPeer,
  MultiplayerStatus,
  RoomResources,
  VersionIsolation,
} from "../lib/types";
import { MultiplayerFirewallNotice } from "./MultiplayerFirewall";
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
}

function kernelTone(status: MultiplayerStatus | null) {
  if (!status) return "muted" as const;
  if (!status.installed) return "warn" as const;
  return status.running ? ("online" as const) : ("muted" as const);
}

function RoleCard({
  icon: Icon,
  title,
  detail,
  steps,
  onClick,
}: {
  icon: typeof Network;
  title: string;
  detail: string;
  steps: string[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full flex-col rounded-xl border border-border/70 bg-card/55 p-4 text-left transition-colors hover:border-primary/40 hover:bg-card/80 focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:outline-none"
    >
      <span className="flex w-full items-center justify-between">
        <span className="flex size-9 items-center justify-center rounded-lg border border-border/60 bg-muted/20 text-foreground/80 transition-colors group-hover:border-primary/25 group-hover:bg-primary/10 group-hover:text-primary">
          <Icon className="size-4" />
        </span>
        <ArrowRight className="size-4 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
      </span>
      <span className="mt-3 text-[13px] font-medium">{title}</span>
      <span className="mt-1 text-[11px] leading-5 text-muted-foreground">{detail}</span>
      <span className="mt-3 flex flex-wrap gap-1.5">
        {steps.map((step) => (
          <span
            key={step}
            className="rounded border border-border/50 bg-muted/15 px-1.5 py-0.5 text-[9.5px] text-muted-foreground/80"
          >
            {step}
          </span>
        ))}
      </span>
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
}: MultiplayerViewProps) {
  const [config, setConfig] = useState<MultiplayerConfig>(loadMultiplayerConfig);
  const [publicAddress, setPublicAddress] = useState(loadPublicAddress);
  const [hosts, setHosts] = useState<MultiplayerHost[]>(loadMultiplayerHosts);
  const [status, setStatus] = useState<MultiplayerStatus | null>(null);
  const [addresses, setAddresses] = useState<LocalIpv6Address[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  // 房间没解散就还在这间房里：重进联机页时直接回到房间页，
  // 即使内核暂时没跑，也在房间页里显示「网络已断开」和重连按钮。
  const [page, setPage] = useState<MultiplayerPage>(() =>
    loadActiveRoom() ? "room" : "home",
  );
  const [requestingInstall, setRequestingInstall] = useState(false);
  const [installProgress, setInstallProgress] = useState<MultiplayerInstallState | null>(null);
  const [busy, setBusy] = useState<"start" | "stop" | "join" | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  /** 加入房间的两种入口：房主给的分享码，或只填 IPv6 + 密码。 */
  const [joinMode, setJoinMode] = useState<"code" | "direct">("code");
  const [directAddress, setDirectAddress] = useState("");
  const [directPassword, setDirectPassword] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [activeRoom, setActiveRoom] = useState<ActiveRoom | null>(loadActiveRoom);
  const [autoLanPort, setAutoLanPort] = useState<number | null>(null);
  const [roomResources, setRoomResources] = useState<RoomResources | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState<string | null>(null);
  const [resourceTick, setResourceTick] = useState(0);
  const hostsRef = useRef(hosts);
  const statusRef = useRef(status);
  const configRef = useRef(config);
  const lastAutoPortRef = useRef<number | null>(null);
  /** 访客连接验证期间不要被“内核已启动”自动带进房间页。 */
  const joiningRef = useRef(false);
  /** 房主关房时，可能同时触发自动恢复和房间监测，只处理一次。 */
  const leavingClosedRef = useRef(false);
  /** 重进联机页时只主动接回一次房间，避免失败后反复重启内核。 */
  const autoResumeRef = useRef(false);

  hostsRef.current = hosts;
  statusRef.current = status;
  configRef.current = config;

  // 房间版本只认已安装的版本：旧配置里被删掉的版本不能继续开房。
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

  useEffect(() => {
    let alive = true;
    getMultiplayerStatus(gameRoot)
      .then((value) => {
        if (!alive) return;
        setStatus(value);
        if (!value.running || loadActiveRoom()) return;
        // 内核还在跑就是房间还在：本地记录丢了（清过缓存、上次被误判
        // 断开）也要补回来，否则重进联机页会把它当成「没有房间」。
        const current = configRef.current;
        const room: ActiveRoom = {
          role: current.peers.length > 0 ? "guest" : "host",
          networkName: value.networkName || current.networkName,
          startedAt: Date.now(),
        };
        saveActiveRoom(room);
        setActiveRoom(room);
        setPage((previous) => (previous === "home" ? "room" : previous));
      })
      .catch((error) => console.warn("无法读取联机状态", error));
    // 内核下载由后端托管：重进页面时先读回真实进度，避免又提示“重新下载”。
    getMultiplayerInstallState(gameRoot)
      .then((state) => {
        if (alive) setInstallProgress(state);
      })
      .catch((error) => console.warn("无法读取 EasyTier 安装状态", error));
    getLocalIpv6Addresses()
      .then((list) => {
        if (!alive) return;
        setAddresses(list);
        setPublicAddress((current) => {
          const first =
            list.find((entry) => entry.global && !entry.temporary) ??
            list.find((entry) => entry.global);
          if (!first) return current;
          const trimmed = current.trim();
          if (!trimmed) return peerFromAddress(first.address, config.listenPort);
          // 家庭宽带的临时 IPv6 会轮换；旧地址留在分享码里，访客就连不上。
          // 域名或手动填写的非 IPv6 地址保持原样。
          const host = ipv6FromPeer(trimmed);
          if (!host) return current;
          const saved = list.find((entry) => entry.address === host);
          const stable = list.find((entry) => entry.global && !entry.temporary);
          if (saved?.global && (!saved.temporary || !stable)) {
            const normalized = peerFromAddress(host, config.listenPort);
            return normalized === trimmed ? current : normalized;
          }
          return peerFromAddress((stable ?? first).address, config.listenPort);
        });
      })
      .catch((error) => console.warn("无法读取本机 IPv6 地址", error));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameRoot]);

  useEffect(() => {
    saveMultiplayerConfig(config);
  }, [config]);

  useEffect(() => {
    saveMultiplayerHosts(hosts);
  }, [hosts]);

  useEffect(() => {
    savePublicAddress(publicAddress);
  }, [publicAddress]);

  // 游戏里点「对局域网开放」后，Minecraft 会把端口写进本次启动的
  // logs/latest.log；自动读出来，创建页和房主房间都不用再手填。
  useEffect(() => {
    if (!isDesktop || !gameRunning || edition !== "java") return;
    if (!gameRoot || !roomVersion) return;
    if (page !== "create" && page !== "room") return;

    let alive = true;
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const read = async () => {
      if (!alive) return;
      // 访客没有房主的日志；房主（或准备开房）才自动读端口。
      if (page === "room" && configRef.current.peers.length > 0) {
        stop();
        return;
      }
      try {
        const port = await readMinecraftLanPort(
          gameRoot,
          roomVersion,
          versionIsolation,
        );
        if (!alive) return;
        if (port === null) {
          lastAutoPortRef.current = null;
          return;
        }
        if (port === lastAutoPortRef.current) {
          stop();
          return;
        }
        lastAutoPortRef.current = port;
        setAutoLanPort(port);
        setConfig((current) =>
          current.hostPort === port ? current : { ...current, hostPort: port },
        );
        // 端口已经读到，不用继续轮询；重新进入页面时会再读一次。
        stop();
      } catch {
        // 游戏刚启动时日志可能还没写出来，下一轮再读。
      }
    };

    void read();
    timer = window.setInterval(() => void read(), 4000);
    return () => {
      alive = false;
      stop();
    };
  }, [edition, gameRoot, gameRunning, page, roomVersion, versionIsolation]);

  useEffect(() => {
    if (gameRunning) return;
    lastAutoPortRef.current = null;
    setAutoLanPort(null);
  }, [gameRunning]);

  useEffect(() => {
    saveActiveRoom(activeRoom);
  }, [activeRoom]);

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
      current.map((item) =>
        item.id === entry.id ? { ...item, status: result, checkedAt: Date.now() } : item,
      ),
    );
    return result;
  }, []);

  const pingAll = useCallback(async () => {
    const targets = hostsRef.current;
    if (targets.length === 0) return;
    setPinging(true);
    try {
      await Promise.all(targets.map((entry) => pingHost(entry)));
    } finally {
      setPinging(false);
    }
  }, [pingHost]);

  useEffect(() => {
    if (page === "room" && status?.running) void pingAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, status?.running]);

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

  /**
   * 房主关房后，本机 EasyTier 仍然能一个人跑起来，所以不能只看本地
   * `running`。加入/重连后等房主的虚拟节点真正出现在 peer 列表里，
   * 再放进房间页；等不到就当作房间已关闭。
   */
  const waitForHost = useCallback(
    async (hostIpv4: string, timeoutMs = 12_000): Promise<boolean> => {
      const wanted = hostIpv4.trim();
      if (!wanted) return false;
      const deadline = Date.now() + timeoutMs;
      do {
        try {
          const peers = await getMultiplayerPeers(gameRoot);
          if (peers.some((peer) => !peer.isSelf && peer.ipv4 === wanted)) return true;
        } catch {
          // 内核刚启动时 RPC/CLI 可能还没就绪，继续等下一轮。
        }
        await new Promise((resolve) => window.setTimeout(resolve, 900));
      } while (Date.now() < deadline);
      return false;
    },
    [gameRoot],
  );

  /**
   * 只输 IPv6 加入时，房主的虚拟地址和局域网端口都不在手上：先等房主出现
   * 在成员列表里，再用密码推出的端口和令牌去读它的房间清单——第一份
   * 能读通的清单就是房主，端口也从清单里带回来。
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
          // 内核刚启动时 RPC 可能还没就绪，继续等下一轮。
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
            // 这台上没有房间清单，或者清单还没启动：换下一台/下一轮。
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      } while (Date.now() < deadline);
      return null;
    },
    [gameRoot],
  );

  /**
   * 直接探测房主的监听端口；拿不到结果（旧版桌面端没有这个命令）
   * 时返回 null，让调用方退回成员列表判断，避免误杀正常房间。
   */
  const probeHostEndpoint = useCallback(
    async (peer?: string): Promise<boolean | null> => {
      const target = (peer ?? configRef.current.peers[0] ?? "").trim();
      if (!target) return null;
      try {
        return await probeMultiplayerEndpoint(target);
      } catch {
        return null;
      }
    },
    [],
  );

  /**
   * 房主关房后，访客本机的 EasyTier 不会自己退出，界面就会停在
   * 一个看起来还在、实际已经断开的房间里。把内核一起停掉，退回首页。
   */
  const leaveClosedRoom = useCallback(
    async (detail = "房主已经离开，联机网络已断开。") => {
      if (leavingClosedRef.current) return;
      leavingClosedRef.current = true;
      try {
        const next = await stopMultiplayer(gameRoot).catch(() => null);
        if (next) setStatus(next);
        setHosts((current) =>
          current.map((entry) => (entry.bridgePort ? { ...entry, bridgePort: null } : entry)),
        );
        // 房主已经关房，这间房就不再是「没解散」了；清掉记录，
        // 否则下次重进联机页又会被带回一个连不上的房间。
        setActiveRoom(null);
        setPage("home");
        onNotify("error", "房间已关闭", detail);
      } finally {
        leavingClosedRef.current = false;
      }
    },
    [gameRoot, onNotify],
  );

  // 节点一跑起来就进入房间。房主的内核就是房间本身；访客则不能只看
  // 本机 `running`：内核可能是上一次留下的，房主关房后它仍然活着。
  // 所以在首页恢复房间前先确认虚拟网络里还能看到房主节点。
  useEffect(() => {
    if (page !== "home" || !status?.running || joiningRef.current) return;
    const current = configRef.current;
    if (current.peers.length === 0) {
      setPage("room");
      return;
    }
    let cancelled = false;
    void (async () => {
      // 成员列表和端口探测同时做：房主节点出现就进房，端口没了就退出。
      // 单独依赖端口探测时，IPv6 的一次丢包就会把还能用的房间判成已关闭。
      const [online, endpoint] = await Promise.all([
        waitForHost(current.hostIpv4, 8_000),
        probeHostEndpoint(),
      ]);
      if (cancelled) return;
      if (online) {
        setPage("room");
        return;
      }
      // 房主一时联系不上不等于房间没了：这里以前会直接停掉内核并清掉
      // 房间记录，看起来就像「重进联机页房间自动退出」。现在最多提醒，
      // 房间和内核都留着，用「重新连接」再试一次。
      if (endpoint === false) {
        onNotify("info", "暂时联系不上房主", "房间还在，可以点「重新连接」再试一次。");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running, page, probeHostEndpoint, waitForHost, leaveClosedRoom]);

  // 已经在房间里的访客：房主节点还在虚拟网络里就算在线。
  //
  // 不能只靠探测房主端口：房主是服务器时，公网 IPv6 上的一次偶发丢包、
  // 房主防火墙只放行部分来源，都会让探测失败，旧逻辑两次失败就把访客
  // 踢出房间，看起来像「房主断开连接」。现在改成：
  //   1. 成员列表里能看到房主 → 直接算在线，也不再反复连他的监听端口；
  //   2. 看不到房主时才探测端口，而且必须「端口明确拒绝连接」才算一次；
  //   3. 进页面先给十秒稳定期，连续四次（约 40 秒）确认已关闭才退出。
  useEffect(() => {
    if (page !== "room" || !status?.running) return;
    const current = configRef.current;
    if (current.peers.length === 0) return;
    let cancelled = false;
    let misses = 0;
    let checking = false;
    const check = async () => {
      if (cancelled || checking) return;
      checking = true;
      try {
        let hostVisible = false;
        let peersReadable = true;
        try {
          const peers = await getMultiplayerPeers(gameRoot);
          if (cancelled) return;
          hostVisible = peers.some(
            (peer) => !peer.isSelf && peer.ipv4 === current.hostIpv4,
          );
        } catch {
          // CLI 读一次失败不代表房主离开，交给端口探测判断。
          peersReadable = false;
        }
        if (cancelled) return;
        if (hostVisible) {
          misses = 0;
          return;
        }

        const endpoint = await probeHostEndpoint();
        if (cancelled) return;
        if (endpoint === true) {
          // 节点暂时不在列表里，但房主端口还在响应，别误判。
          misses = 0;
          return;
        }
        // 只有「房主端口明确拒绝连接」才算房间真的关了。探测没结果
        // （丢包、旧内核、CLI 一时读不出来）一律不计，否则重进页面
        // 时的网络波动就会把还开着的房间解散。
        if (!peersReadable || endpoint !== false) return;
        misses += 1;
        if (misses >= 4) {
          cancelled = true;
          await leaveClosedRoom("房主已经关闭房间，联机网络已断开。");
        }
      } finally {
        checking = false;
      }
    };
    // 刚进页面时内核/成员列表可能还在就绪中，先给一段稳定期再判断。
    const first = window.setTimeout(() => void check(), 10_000);
    const timer = window.setInterval(() => void check(), 8_000);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [page, status?.running, gameRoot, leaveClosedRoom, probeHostEndpoint]);

  // 房间资源：房主扫描自己的版本并开一个只读 HTTP 服务，访客经虚拟
  // 网络读取同一份快照。只在房间页且网络已连接时工作。
  useEffect(() => {
    if (page !== "room") {
      setRoomResources(null);
      setResourcesLoading(false);
      setResourcesError(null);
      return;
    }
    if (!status?.running) {
      setRoomResources(null);
      setResourcesLoading(false);
      setResourcesError(null);
      return;
    }
    if (edition !== "java") {
      setRoomResources(null);
      setResourcesLoading(false);
      setResourcesError("房间资源列表目前支持 Java 版");
      return;
    }

    const current = configRef.current;
    const guest = current.peers.length > 0;
    if (!guest && !current.hostVersion) {
      setRoomResources(null);
      setResourcesLoading(false);
      setResourcesError("房主还没有选择房间版本");
      return;
    }
    if (guest && (!current.hostIpv4 || !current.resourcePort || !current.resourceToken)) {
      setRoomResources(null);
      setResourcesLoading(false);
      setResourcesError("房主的分享码里没有房间资源列表");
      return;
    }

    let cancelled = false;
    setResourcesLoading(true);
    setResourcesError(null);
    void (async () => {
      try {
        if (guest) {
          const resources = await fetchRoomResources(
            current.hostIpv4,
            current.resourcePort,
            current.resourceToken,
          );
          if (cancelled) return;
          setRoomResources(resources);
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
    config.peers.length,
  ]);

  /** 记住这一局是什么角色、房间叫什么，供重进页面时接回来；null 表示主动解散。 */
  const rememberRoom = useCallback((next: MultiplayerConfig | null) => {
    setActiveRoom(
      next
        ? {
            role: next.peers.length > 0 ? "guest" : "host",
            networkName: next.networkName,
            startedAt: Date.now(),
          }
        : null,
    );
  }, []);

  /**
   * 开房前自动补齐本机防火墙。漏掉这一步时，房主自己看不出异常，而访客会
   * 永远卡在「正在连接」；放行失败只提示，不影响开房（路由器那一层仍需手动）。
   */
  const autoAllowFirewall = useCallback(
    async (target: MultiplayerConfig) => {
      if (!statusRef.current?.installed) return;
      try {
        // 已经放行就别再跑一遍：安装版在安装时就写好了规则。
        const current = await getMultiplayerFirewallStatus(
          gameRoot,
          target.listenPort,
          target.hostPort,
          target.overlayIpv4,
        );
        if (current.ready) return;
        const wall = await setupMultiplayerFirewall(
          gameRoot,
          target.listenPort,
          target.hostPort,
          target.overlayIpv4,
        );
        if (!wall.ready && wall.supported) {
          onNotify(
            "info",
            "Windows 防火墙未放行",
            wall.detail || "访客可能连不进来；用安装版重新安装一次会自动放行。",
          );
        }
      } catch (error) {
        onNotify("info", "Windows 防火墙未自动放行", String(error));
      }
    },
    [gameRoot, onNotify],
  );

  const startWith = useCallback(
    async (initial: MultiplayerConfig, mode: "start" | "join" = "start") => {
      // 只输 IPv6 时，房主的虚拟地址和端口要等网络接上才知道，后面会改写它。
      let next = initial;
      if (!statusRef.current?.installed) {
        onNotify("info", "请先下载 EasyTier 内核");
        return false;
      }
      if (!gameRoot) {
        onNotify("error", "还没有游戏目录", "请先在设置里确认游戏根目录。");
        return false;
      }
      const isGuest = next.peers.length > 0;
      if (!isGuest && !next.hostVersion) {
        onNotify("error", "先选择房间版本", "创建房间前必须选一个已安装的版本。");
        return false;
      }
      if (
        !isGuest &&
        !installedVersions.some((entry) => entry.id === next.hostVersion)
      ) {
        onNotify("error", "房间版本未安装", "请先安装这个版本，或重新创建房间换一个版本。");
        return false;
      }
      if (isGuest) joiningRef.current = true;
      setBusy(mode);
      try {
        // 先看房主的端口还在不在：关房后不必把内核启动起来再等 12 秒。
        if (isGuest) {
          const reachable = await probeHostEndpoint(next.peers[0]);
          if (reachable === false) {
            onNotify(
              "error",
              "无法加入房间",
              "房主可能已经关闭房间，或者入口地址已经失效。",
            );
            return false;
          }
        }
        // 与启动内核并行：检查防火墙要走一次 PowerShell，不必让开房等它。
        const firewall = isGuest ? null : autoAllowFirewall(next);
        const started = await startMultiplayer(gameRoot, next);
        setStatus(started);
        if (firewall) void firewall;
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

          if (next.hostIpv4) {
            const hostOnline = await waitForHost(next.hostIpv4);
            if (!hostOnline) {
              return await rollback(
                "无法加入房间",
                "房主可能已经关闭房间，或者房主的防火墙没有放行。",
              );
            }
          } else {
            // 只输 IPv6：等房主出现在成员列表里，再读它的房间清单。
            setDiscovering(true);
            const found = await discoverHost(next);
            setDiscovering(false);
            if (!found) {
              return await rollback(
                "找不到房主",
                "确认房主已开房、密码一致，并且房主的 IPv6 和防火墙允许入站。",
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
        // 房主先拿到资源端口再进房间，这样刚显示的分享码就已经带上
        // `res` / `rt`，不会让好友拿到一份没有资源列表的旧码。
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
            // 资源列表失败不该阻止开房；房间页仍会重试并显示原因。
            console.warn("房间资源列表启动失败", error);
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
      autoAllowFirewall,
      onNotify,
      probeHostEndpoint,
      rememberRoom,
      versionIsolation,
      waitForHost,
    ],
  );

  // 重进联机页时把上次的房间接回来：内核没在跑（启动器重启过、上次被
  // 误判断开）就按保存的配置自动重新开房/重连，而不是停在一个空房间页。
  useEffect(() => {
    if (autoResumeRef.current) return;
    if (!status || status.running || !status.installed) return;
    if (page !== "room" || !activeRoom || busy) return;
    const current = configRef.current;
    const guest = current.peers.length > 0;
    if (guest ? !current.hostIpv4 : !current.hostVersion) return;
    if (!guest && !installedVersions.some((entry) => entry.id === current.hostVersion)) return;
    autoResumeRef.current = true;
    onNotify("info", "正在接回房间", "用上次的设置重新连接联机网络。");
    void startWith(current);
  }, [activeRoom, busy, installedVersions, onNotify, page, startWith, status]);

  /** 口令、带宽、虚拟地址只在启动内核时生效：正在跑就重开一次网络。 */
  const applyRoomConfig = useCallback(
    async (patch: Partial<MultiplayerConfig>) => {
      const next = { ...configRef.current, ...patch };
      const guest = configRef.current.peers.length > 0;
      setConfig(next);
      if (!statusRef.current?.running) return;
      setBusy("start");
      try {
        await stopMultiplayer(gameRoot);
        const started = await startMultiplayer(gameRoot, next);
        setStatus(started);
        rememberRoom(next);
        // 端口/虚拟地址可能变了，规则要按新值重写。
        if (!guest) void autoAllowFirewall(next);
        if (!guest) setResourceTick((value) => value + 1);
        onNotify(
          "success",
          guest ? "已按新设置重连" : "房间已按新设置重启",
          guest ? "正在用新地址重新连上房主。" : "正在玩的访客需要重新连接。",
        );
      } catch (error) {
        onNotify("error", guest ? "重新连接失败" : "重启房间失败", String(error));
      } finally {
        setBusy(null);
      }
    },
    [autoAllowFirewall, gameRoot, onNotify, rememberRoom],
  );

  const handleCreate = () => {
    if (!roomVersion) {
      onNotify("error", "先选择房间版本", "创建房间前必须选一个已安装的版本。");
      return;
    }
    if (!installedVersions.some((entry) => entry.id === roomVersion)) {
      onNotify("error", "这个版本还没有安装", "换一个已安装的版本再开房。");
      return;
    }
    const password = configRef.current.networkSecret.trim();
    if (!isRoomPassword(password)) {
      onNotify(
        "error",
        "先设置房间密码",
        `密码需要 ${ROOM_PASSWORD_MIN}–32 位，仅限字母、数字和英文符号。`,
      );
      return;
    }
    // 房主的“世界”就是自己的虚拟地址，不再保留上一段访客关系。
    const next = {
      ...configRef.current,
      networkSecret: password,
      peers: [],
      hostIpv4: "",
      hostVersion: roomVersion,
      // 资源端口和令牌都由密码推出，只输 IPv6 的访客同样能算出来。
      resourcePort: roomResourcePort(password),
      resourceToken: roomResourceToken(password),
    };
    setConfig(next);
    void startWith(next);
  };

  const handleJoin = async () => {
    const info = parseShareCode(joinCode);
    if (!info) {
      onNotify("error", "分享码无法识别");
      return;
    }
    if (!info.peer) {
      onNotify("error", "分享码里没有房主入口", "让房主补上公网 IPv6 后重新发一次。");
      return;
    }
    setBusy("join");
    try {
      const current = configRef.current;
      const overlayIpv4 =
        info.hostIpv4 === current.overlayIpv4 ? createOverlayIpv4() : current.overlayIpv4;
      const next: MultiplayerConfig = {
        ...current,
        networkName: info.networkName,
        networkSecret: info.networkSecret,
        overlayIpv4,
        peers: info.peer ? [info.peer] : [],
        hostPort: info.hostPort,
        hostIpv4: info.hostIpv4,
        resourcePort: info.resourcePort,
        resourceToken: info.resourceToken,
      };
      const previousConfig = current;
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
      } else {
        // 加入失败时不要把上一间房/上一角色留成半套状态。
        setConfig(previousConfig);
      }
    } finally {
      setBusy(null);
    }
  };

  /**
   * 不粘分享码，只填房主公网 IPv6 和房间密码：网络名固定、资源端口由
   * 密码推出，剩下要的房主虚拟地址和局域网端口在连上后自动发现。
   */
  const handleJoinDirect = async () => {
    const entry = parseIpv6Entry(directAddress);
    if (!entry) {
      onNotify("error", "IPv6 地址不对", "示例：240e:3a1:…:… 或 [240e:3a1:…:…]:11010");
      return;
    }
    const password = directPassword.trim();
    if (!isRoomPassword(password)) {
      onNotify("error", "房间密码不对", `密码需要 ${ROOM_PASSWORD_MIN}–32 位，和房主设置的一致。`);
      return;
    }
    setBusy("join");
    const previousConfig = configRef.current;
    const next: MultiplayerConfig = {
      ...previousConfig,
      networkName: ROOM_NETWORK_NAME,
      networkSecret: password,
      // 房主的虚拟地址还不知道：换一个自己的，少一个两边撞成同一地址的机会。
      overlayIpv4: createOverlayIpv4(),
      peers: [entry.peer],
      hostIpv4: "",
      hostVersion: "",
      hostPort: DEFAULT_HOST_PORT,
      resourcePort: roomResourcePort(password),
      resourceToken: roomResourceToken(password),
    };
    setConfig(next);
    try {
      if (!(await startWith(next, "join"))) {
        setConfig(previousConfig);
        return;
      }
      setDirectPassword("");
    } finally {
      setBusy(null);
    }
  };

  const handleLeave = async () => {
    setBusy("stop");
    try {
      const next = await stopMultiplayer(gameRoot);
      setStatus(next);
      // 主动离开就是解散：记录和内核一起清掉。留着记录只会在下次进页
      // 时又把同一间房“接回来”，跟用户刚做的选择相反。
      rememberRoom(null);
      setHosts((current) =>
        current.map((entry) => (entry.bridgePort ? { ...entry, bridgePort: null } : entry)),
      );
      setPage("home");
    } catch (error) {
      onNotify("error", "离开失败", String(error));
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

  /** 局域网端口只是分享码里的元数据：改了不用重启网络，重发分享码即可。 */
  const handleChangePort = useCallback(
    (port: number) => {
      setConfig((current) => ({ ...current, hostPort: port }));
      onNotify("success", "端口已更新", "新的分享码已经带上这个端口，发给好友即可。");
    },
    [onNotify],
  );

  const refreshRoomResources = useCallback(() => {
    setResourceTick((value) => value + 1);
  }, []);

  const shareCode = useMemo(
    () => buildShareCode(config, publicAddress),
    [config, publicAddress],
  );
  const joinPreview = useMemo(() => parseShareCode(joinCode), [joinCode]);
  const running = Boolean(status?.running);
  const installed = Boolean(status?.installed);
  // 版本标记还在、文件却不全：上一次安装被截断（典型是只解出两个 exe）。
  const kernelIncomplete = !installed && Boolean(status?.version);
  const installing = requestingInstall || Boolean(installProgress?.active);
  // 内核已随安装包内置：历史下载记录（失败的、暂停的）不该再盖一层
  // “需要下载”的提示，只在真的没装上时才显示。
  const installFailed = !installing && !installed && installProgress?.stage === "error";
  const installPaused = !installing && !installed && installProgress?.stage === "paused";
  const installPartial = Math.max(
    installProgress?.partialBytes ?? 0,
    installProgress?.doneBytes ?? 0,
  );
  const installResumable =
    !installing && !installed && Boolean(installProgress?.resumable) && installPartial > 0;
  const installPercent =
    installProgress && installProgress.totalBytes > 0
      ? Math.min(100, Math.round((installProgress.doneBytes / installProgress.totalBytes) * 100))
      : null;
  const hosted = installedVersions.find((entry) => entry.id === roomVersion);
  const portValid = config.hostPort > 0 && config.hostPort < 65536;
  const passwordValid = isRoomPassword(config.networkSecret);

  const titles: Record<MultiplayerPage, string> = {
    home: "联机",
    create: "创建房间",
    join: "加入房间",
    room: "联机房间",
  };

  const headerActions =
    page === "home" ? (
      <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-1.5">
        <StatusDot
          tone={kernelTone(status)}
          animated={busy === "start" || busy === "join"}
        />
        <span className="text-[11.5px] text-muted-foreground">
          {!status
            ? "检测中…"
            : !installed
              ? installing
                ? "内核下载中"
                : "内核未安装"
              : running
                ? "已连接"
                : "未启动"}
        </span>
      </div>
    ) : page === "room" ? (
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        disabled={busy === "stop"}
        onClick={() => void handleLeave()}
      >
        {busy === "stop" ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : running ? (
          <Square className="size-3.5" />
        ) : (
          <ArrowLeft className="size-3.5" />
        )}
        {running ? "离开房间" : "返回"}
      </Button>
    ) : (
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 text-muted-foreground"
        onClick={() => setPage("home")}
      >
        <ArrowLeft className="size-3.5" />
        返回
      </Button>
    );

  return (
    <div className="space-y-5">
      <PageHeader
        title={titles[page]}
        description={
          page === "home"
            ? "房主开好局域网世界，访客填地址直接进，不经过中转服务器。"
            : page === "create"
              ? "选好房间版本和局域网端口，把世界分享给好友。"
              : page === "join"
                ? "粘贴分享码，或只填房主的 IPv6 地址和房间密码。"
                : undefined
        }
        actions={headerActions}
      />

      {page !== "room" &&
      (installing || installFailed || installResumable || (status !== null && !installed)) ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-primary/35 bg-primary/[0.06] px-4 py-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            {installing ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium">
              {installing
                ? installPercent === null
                  ? "正在下载 EasyTier"
                  : `正在下载 EasyTier · ${installPercent}%`
                : installPaused
                  ? "上次下载未完成"
                  : installFailed
                    ? "EasyTier 内核下载失败"
                    : kernelIncomplete
                      ? "EasyTier 内核文件不完整"
                      : "需要 EasyTier 内核"}
            </p>
            <p className="min-w-0 truncate text-[10.5px] text-muted-foreground">
              {installing
                ? installProgress?.detail
                : installPaused
                  ? installResumable
                    ? `已下载 ${(installPartial / (1024 * 1024)).toFixed(1)} MB，可接着下`
                    : "上次任务未完成，重新点一下即可下载"
                  : installFailed
                    ? (installProgress?.error ?? "可重试，或在下载管理器查看")
                    : kernelIncomplete
                      ? "内置内核释放不完整（缺少 Packet.dll），重新下载即可修复。"
                      : "内核随安装包内置，正常不会走到这一步。"}
            </p>
          </div>
          {!installing ? (
            <Button
              size="sm"
              className="h-7 gap-1.5 text-[11px]"
              onClick={() => void handleInstall()}
            >
              {installFailed && !installResumable ? (
                <RefreshCw className="size-3" />
              ) : (
                <Download className="size-3" />
              )}
              {installResumable
                ? "继续下载"
                : installFailed
                  ? "重试"
                  : kernelIncomplete
                    ? "重新下载"
                    : "下载"}
            </Button>
          ) : null}
        </section>
      ) : null}

      {page === "home" ? (
        <div className="mx-auto w-full max-w-3xl space-y-3">
          {activeRoom && status && !running ? (
            <section className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-primary/35 bg-primary/[0.06] px-4 py-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
                <Network className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium">
                  上次的房间还在
                </p>
                <p className="min-w-0 truncate text-[10.5px] text-muted-foreground">
                  {activeRoom.role === "guest"
                    ? "访客 · 房主还在的话，点一下就能接回去。"
                    : "房主 · 用同样的密码重开，分享码不变。"}
                </p>
              </div>
              <Button
                size="sm"
                className="h-7 shrink-0 gap-1.5 text-[11px]"
                disabled={busy === "start"}
                onClick={() => void startWith(configRef.current)}
              >
                {busy === "start" ? (
                  <LoaderCircle className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                {activeRoom.role === "guest" ? "重新连接" : "重新开房"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 shrink-0 text-[10.5px] text-muted-foreground"
                onClick={() => void handleLeave()}
              >
                解散
              </Button>
            </section>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <RoleCard
              icon={Network}
              title="创建房间"
              detail="选好房间版本并设置密码，把局域网世界分享给访客。"
              steps={["选版本", "设密码", "发分享码"]}
              onClick={() => {
                setConfig((current) =>
                  current.peers.length > 0 || current.hostIpv4
                    ? {
                        ...current,
                        // 之前是访客：对方的房间密码要清掉，让房主重新输入自己的。
                        networkSecret: "",
                        overlayIpv4: createOverlayIpv4(),
                        peers: [],
                        hostIpv4: "",
                      }
                    : { ...current, peers: [], hostIpv4: "" },
                );
                setPage("create");
              }}
            />
            <RoleCard
              icon={Users}
              title="加入房间"
              detail="粘贴分享码，或者只填房主的 IPv6 地址和房间密码。"
              steps={["分享码", "IPv6 + 密码", "直接连接"]}
              onClick={() => setPage("join")}
            />
          </div>
        </div>
      ) : null}

      {page === "create" ? (
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <section className="rounded-xl border border-border/70 bg-card/55 p-4">
            <StepHeader
              step="1"
              title="打开局域网世界"
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
            <p className="mt-2 text-[10.5px] leading-4 text-muted-foreground">
              {installedVersions.length === 0
                ? "还没有安装版本，先去下载页安装一个版本。"
                : edition === "bedrock"
                  ? "基岩版房间暂不支持资源列表。"
                  : hosted
                    ? "访客会在房间里看到这个版本的模组、光影包和资源包。"
                    : "选一个已安装的版本才能创建房间。"}
            </p>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="w-full sm:w-44">
                <FieldLabel>局域网端口</FieldLabel>
                <div className="flex h-11 items-center rounded-lg border border-input bg-background/30 px-3 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                  <span className="font-mono text-[16px] text-muted-foreground">:</span>
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
                    className="h-full w-full bg-transparent px-1.5 font-mono text-[17px] tracking-[0.04em] outline-none placeholder:text-muted-foreground/35"
                  />
                </div>
              </div>
              <p className="flex-1 pb-1.5 text-[10.5px] leading-4 text-muted-foreground">
                {autoLanPort && autoLanPort === config.hostPort
                  ? `已从游戏日志读取端口 ${autoLanPort}，开房时会写进分享码。`
                  : gameRunning
                    ? "进入世界后按 Esc → 对局域网开放，端口会自动填入。"
                    : "启动游戏并开放局域网后，端口会自动填入；也可以手动填写。"}
              </p>
            </div>
            {!portValid ? (
              <p className="mt-1.5 text-[10px] text-gold">端口需要是 1–65535。</p>
            ) : null}
          </section>

          <section className="rounded-xl border border-border/70 bg-card/55 p-4">
            <StepHeader step="2" title="好友从哪里连进来" detail="选择你的公网 IPv6" />

            {addresses.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                {addresses.map((entry) => {
                  const value = peerFromAddress(entry.address, config.listenPort);
                  const active = publicAddress.trim() === value;
                  return (
                    <button
                      key={`${entry.address}-${entry.interface}`}
                      type="button"
                      aria-pressed={active}
                      disabled={!entry.global}
                      title={entry.global ? undefined : "不是公网地址，访客连不上"}
                      onClick={() => setPublicAddress(value)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                        active
                          ? "border-primary/40 bg-primary/[0.06]"
                          : "border-border/60 bg-background/30 hover:border-border",
                        !entry.global && "cursor-not-allowed opacity-45",
                      )}
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full border",
                          active
                            ? "border-primary bg-primary"
                            : entry.global
                              ? "border-muted-foreground/40"
                              : "border-muted-foreground/25",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px]">
                        {entry.address}
                      </span>
                      <span className="shrink-0 rounded border border-border/50 bg-muted/20 px-1 py-0.5 text-[9px] text-muted-foreground">
                        {entry.interface}
                      </span>
                      {entry.temporary ? (
                        <span className="shrink-0 rounded bg-muted/40 px-1 py-0.5 text-[9px] text-muted-foreground">
                          临时
                        </span>
                      ) : !entry.global ? (
                        <span className="shrink-0 rounded bg-muted/40 px-1 py-0.5 text-[9px] text-muted-foreground">
                          仅本机
                        </span>
                      ) : null}
                    </button>
                  );
                })}
                {addresses.every((entry) => !entry.global) ? (
                  <p className="text-[10px] text-gold/80">
                    未检测到公网 IPv6，访客无法直连。
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-3 text-[10.5px] text-muted-foreground">
                未检测到本机 IPv6，请在下面手动填写入口。
              </p>
            )}

            {!publicAddress.trim() ? (
              <p className="mt-2 text-[10px] text-gold">
                还没有可用的公网 IPv6，访客无法连接；请先选择或填写对外地址。
              </p>
            ) : null}

            <details className="mt-2.5 border-t border-border/50 pt-2.5">
              <summary className="cursor-pointer list-none text-[10px] text-muted-foreground transition-colors hover:text-foreground">
                手动填写对外地址
              </summary>
              <Input
                value={publicAddress}
                onChange={(event) => setPublicAddress(event.target.value)}
                placeholder="tcp://[240e:…]:11010"
                className="mt-1.5 h-7 font-mono text-[10.5px]"
              />
            </details>

            <div className="mt-2.5 border-t border-border/50 pt-2.5">
              <MultiplayerFirewallNotice
                gameRoot={gameRoot}
                listenPort={config.listenPort}
                hostPort={config.hostPort}
                overlayIpv4={config.overlayIpv4}
                publicAddress={publicAddress}
              />
            </div>

            <details className="mt-2.5 border-t border-border/50 pt-2.5">
              <summary className="cursor-pointer list-none text-[10px] text-muted-foreground transition-colors hover:text-foreground">
                虚拟地址
              </summary>
              <div className="mt-2">
                <div>
                  <FieldLabel>我的虚拟地址</FieldLabel>
                  <div className="flex gap-1.5">
                    <Input
                      value={config.overlayIpv4}
                      onChange={(event) =>
                        setConfig((current) => ({
                          ...current,
                          overlayIpv4: event.target.value,
                        }))
                      }
                      className="h-7 font-mono text-[10.5px]"
                    />
                    <Button
                      variant="outline"
                      size="icon-sm"
                      className="size-7 shrink-0"
                      title="换一个虚拟地址"
                      onClick={() =>
                        setConfig((current) => ({
                          ...current,
                          overlayIpv4: createOverlayIpv4(),
                        }))
                      }
                    >
                      <RefreshCw className="size-3" />
                    </Button>
                  </div>
                </div>
              </div>
            </details>
          </section>

          <section className="rounded-xl border border-border/70 bg-card/55 p-4">
            <StepHeader step="3" title="设置房间密码" detail="随分享码一起发给访客" />
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-input bg-background/30 px-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={config.networkSecret}
                  maxLength={64}
                  placeholder={`至少 ${ROOM_PASSWORD_MIN} 位，例如 summer2026`}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      networkSecret: event.target.value,
                    }))
                  }
                  className="h-full w-full min-w-0 bg-transparent font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-muted-foreground/40"
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
                className="h-9 shrink-0 gap-1.5 text-[11px]"
                onClick={() =>
                  setConfig((current) => ({ ...current, networkSecret: createRoomPassword() }))
                }
              >
                <RefreshCw className="size-3" />
                随机生成
              </Button>
            </div>
            <p
              className={cn(
                "mt-2 text-[10.5px] leading-4",
                passwordValid ? "text-muted-foreground" : "text-gold",
              )}
            >
              {passwordValid
                ? "分享码里会带上这个密码，只有拿到分享码的人才能进来。"
                : `密码需要 ${ROOM_PASSWORD_MIN}–32 位，仅限字母、数字和英文符号。`}
            </p>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/55 px-4 py-3">
            <p className="text-[10.5px] text-muted-foreground">
              EasyTier 以普通权限运行；好友只通过你的公网 IPv6 直连。
            </p>
            <Button
              size="sm"
              className="h-9 gap-1.5 px-4"
              disabled={
                !installed ||
                !roomVersion ||
                !hosted ||
                !portValid ||
                !passwordValid ||
                !publicAddress.trim() ||
                busy === "start"
              }
              onClick={handleCreate}
            >
              {busy === "start" ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Network className="size-3.5" />
              )}
              创建房间
            </Button>
          </div>
        </div>
      ) : null}

      {page === "join" ? (
        <div className="mx-auto w-full max-w-2xl space-y-3">
          <div className="inline-flex rounded-lg border border-border/70 bg-muted/15 p-0.5">
            {([
              ["code", "分享码"],
              ["direct", "IPv6 直连"],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={joinMode === mode}
                onClick={() => setJoinMode(mode)}
                className={cn(
                  "h-7 rounded-md px-3 text-[11px] transition-colors",
                  joinMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {joinMode === "direct" ? (
            <section className="rounded-xl border border-border/70 bg-card/55 p-4">
              <FieldLabel>房主 IPv6 地址</FieldLabel>
              <Input
                value={directAddress}
                onChange={(event) => setDirectAddress(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleJoinDirect();
                }}
                placeholder="240e:…:… 或 [240e:…:…]:11010"
                className="h-9 font-mono text-[12px]"
              />

              <div className="mt-3">
                <FieldLabel>房间密码</FieldLabel>
                <div className="flex h-9 items-center gap-2 rounded-lg border border-input bg-background/30 px-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
                  <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={directPassword}
                    maxLength={64}
                    placeholder="房主设置的房间密码"
                    onChange={(event) => setDirectPassword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void handleJoinDirect();
                    }}
                    className="h-full w-full min-w-0 bg-transparent font-mono text-[12px] outline-none placeholder:font-sans placeholder:text-muted-foreground/40"
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
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] text-muted-foreground/70">
                  {discovering && busy === "join"
                    ? "已连上虚拟网络，正在寻找房主…"
                    : "房主的虚拟地址和端口会自动发现，不用分享码。"}
                </p>
                <Button
                  className="h-8 gap-1.5"
                  disabled={
                    !installed ||
                    busy === "join" ||
                    !isRoomPassword(directPassword) ||
                    !parseIpv6Entry(directAddress)
                  }
                  onClick={() => void handleJoinDirect()}
                >
                  {busy === "join" ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    <ArrowRight className="size-3.5" />
                  )}
                  {busy === "join" ? "正在连接房主…" : "加入房间"}
                </Button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {page === "join" && joinMode === "code" ? (
        <div className="mx-auto w-full max-w-2xl space-y-3">
          <section className="rounded-xl border border-border/70 bg-card/55 p-4">
            <FieldLabel>分享码</FieldLabel>
            <textarea
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
              rows={3}
              placeholder="cobble-mp://join?peer=…"
              className="w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-[11px] leading-5 outline-none placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />

            {joinPreview ? (
              <div className="mt-2 grid gap-2 rounded-lg border border-border/50 bg-muted/15 px-2.5 py-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_72px]">
                <div className="min-w-0">
                  <p className="text-[9px] text-muted-foreground/70">房主入口</p>
                  <p className="truncate font-mono text-[10.5px]">
                    {joinPreview.peer ?? "缺少入口"}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-[9px] text-muted-foreground/70">房主地址</p>
                  <p className="truncate font-mono text-[10.5px]">{joinPreview.hostIpv4}</p>
                </div>
                <div>
                  <p className="text-[9px] text-muted-foreground/70">端口</p>
                  <p className="font-mono text-[10.5px]">{joinPreview.hostPort}</p>
                </div>
              </div>
            ) : joinCode.trim() ? (
              <p className="mt-2 text-[10.5px] text-destructive">分享码无法识别。</p>
            ) : null}
            {joinPreview && !joinPreview.peer ? (
              <p className="mt-2 text-[10.5px] text-gold">
                分享码里没有房主入口，让房主填好公网 IPv6 后重新发一次。
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] text-muted-foreground/70">
                整段聊天记录直接粘贴也行，会自动取出分享码。
              </p>
              <Button
                className="h-8 gap-1.5"
                disabled={!joinPreview?.peer || !installed || busy === "join"}
                onClick={() => void handleJoin()}
              >
                {busy === "join" ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <ArrowRight className="size-3.5" />
                )}
                {busy === "join" ? "正在连接房主…" : "加入房间"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}

      {page === "room" ? (
        <MultiplayerRoom
          gameRoot={gameRoot}
          config={config}
          publicAddress={publicAddress}
          addresses={addresses}
          status={status}
          busy={busy}
          hosts={hosts}
          logs={logs}
          shareCode={shareCode}
          pinging={pinging}
          resources={roomResources}
          resourcesLoading={resourcesLoading}
          resourcesError={resourcesError}
          onRefreshResources={refreshRoomResources}
          onChangePublicAddress={setPublicAddress}
          onChangePort={handleChangePort}
          onResume={() => void startWith(configRef.current)}
          onApplyConfig={(patch) => void applyRoomConfig(patch)}
          onAddHost={handleAddHost}
          onRemoveHost={(entry) => void handleRemoveHost(entry)}
          onToggleBridge={(entry) => void handleToggleBridge(entry)}
          onPingHost={pingHost}
          onPingAll={() => void pingAll()}
          onNotify={onNotify}
        />
      ) : null}
    </div>
  );
}
