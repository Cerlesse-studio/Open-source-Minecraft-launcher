import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Link2,
  LoaderCircle,
  Network,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Server,
  Trash2,
  Users,
  WifiOff,
} from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getMultiplayerPeers } from "../lib/backend";
import {
  DEFAULT_HOST_PORT,
  DEFAULT_PUBLIC_SERVER,
  createOverlayIpv4,
  isOverlayIpv4,
  isPureP2p,
} from "../lib/multiplayer";
import type {
  InstalledVersion,
  MinecraftHostStatus,
  MultiplayerConfig,
  MultiplayerHost,
  MultiplayerPeer,
  MultiplayerStatus,
  RoomResources,
} from "../lib/types";
import { HostPermissionPanel } from "./MultiplayerHostPanels";
import { MultiplayerP2pPanel } from "./MultiplayerP2pPanel";
import { RoomResourcesPanel } from "./MultiplayerRoomResources";
import {
  CopyButton,
  FieldLabel,
  Panel,
  RoomLogPanel,
  type Notify,
} from "./MultiplayerShared";
import { Avatar, StatusDot } from "./ui";

interface MultiplayerRoomProps {
  gameRoot: string;
  installedVersions: InstalledVersion[];
  onRefreshInstalled?: () => Promise<unknown> | void;
  config: MultiplayerConfig;
  status: MultiplayerStatus | null;
  busy: "start" | "stop" | "join" | null;
  hosts: MultiplayerHost[];
  logs: string[];
  shareCode: string;
  pinging: boolean;
  resources: RoomResources | null;
  resourcesLoading: boolean;
  resourcesError: string | null;
  p2pLinked?: boolean;
  gameRunning?: boolean;
  autoLanPort?: number | null;
  autoRefresh?: boolean;
  onToggleAutoRefresh?: () => void;
  onRefreshAll?: () => void;
  refreshingAll?: boolean;
  refreshTick?: number;
  onLaunchVersion?: (versionId: string) => void;
  onRefreshResources: () => void;
  onChangePort: (port: number) => void;
  onResume: () => void;
  onApplyConfig: (patch: Partial<MultiplayerConfig>) => void;
  onAddPeer: (peer: string) => Promise<void>;
  onAddHost: (address: string) => boolean;
  onRemoveHost: (entry: MultiplayerHost) => void;
  onToggleBridge: (entry: MultiplayerHost) => void;
  onPingHost: (entry: MultiplayerHost) => Promise<MinecraftHostStatus>;
  onPingAll: () => void;
  onNotify: Notify;
}

/**
 * 在线成员：展示当前接入同一 EasyTier 虚拟局域网的设备。
 */
function RoomMembersPanel({
  gameRoot,
  running,
  isGuest,
  hostIpv4,
  className,
  refreshTick,
}: {
  gameRoot: string;
  running: boolean;
  isGuest: boolean;
  hostIpv4?: string;
  className?: string;
  refreshTick?: number;
}) {
  const [peers, setPeers] = useState<MultiplayerPeer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!running) {
      setPeers([]);
      setError(null);
      return;
    }
    let alive = true;
    const load = async (quiet: boolean) => {
      if (!quiet) setLoading(true);
      try {
        const list = await getMultiplayerPeers(gameRoot);
        if (!alive) return;
        setPeers(list);
        setError(null);
      } catch (reason) {
        if (!alive) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (alive && !quiet) setLoading(false);
      }
    };
    void load(false);
    // 实时刷新成员状态：每 2.5 秒更新一次网络对等节点
    const timer = window.setInterval(() => void load(true), 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [gameRoot, running, tick, refreshTick]);

  return (
    <Panel
      title="房间成员"
      icon={<Users className="size-3.5 text-muted-foreground" />}
      action={
        <div className="flex items-center gap-1">
          <Badge
            variant="outline"
            className="h-4 px-1.5 text-[9px] font-normal text-muted-foreground"
          >
            {running ? `${peers.length} 台在线` : "未连接"}
          </Badge>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title="刷新成员"
            disabled={!running || loading}
            onClick={() => setTick((value) => value + 1)}
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          </Button>
        </div>
      }
      className={className}
      bodyClassName="p-3"
    >
      {peers.length > 0 ? (
        <div className="space-y-1.5">
          {peers.map((peer) => (
            <RoomMemberRow
              key={peer.ipv4}
              peer={peer}
              isHostPeer={isGuest && Boolean(hostIpv4) && peer.ipv4 === hostIpv4}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-1.5 py-6 text-center text-muted-foreground">
          <Users className="size-4 opacity-40" />
          <p className="text-[10.5px]">
            {!running
              ? "网络断开后，成员列表会清空"
              : loading
                ? "正在读取成员…"
                : error
                  ? "暂时读不到成员列表"
                  : "还没有其他设备加入"}
          </p>
          {running && error ? (
            <p
              title={error}
              className="max-w-[300px] truncate text-[9.5px] text-gold/70"
            >
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function RoomMemberRow({
  peer,
  isHostPeer,
}: {
  peer: MultiplayerPeer;
  isHostPeer: boolean;
}) {
  const name = peer.hostname || peer.ipv4;
  const latency = peer.latencyMs > 0 ? `${peer.latencyMs} ms` : null;
  const link = peer.cost && peer.cost !== "local" ? peer.cost : null;

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border",
          peer.isSelf
            ? "border-primary/35 bg-primary/10"
            : "border-border/60 bg-muted/25",
        )}
      >
        <Avatar name={name} size={28} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[11.5px] font-medium">{name}</span>
          <Badge
            variant="outline"
            className={cn(
              "h-4 shrink-0 px-1 text-[9px] font-normal",
              peer.isSelf
                ? "border-primary/30 bg-primary/[0.07] text-primary"
                : "border-border/70 text-muted-foreground/80",
            )}
          >
            {peer.isSelf ? "我" : isHostPeer ? "房主" : "访客"}
          </Badge>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[9.5px] text-muted-foreground/70">
          <span className="shrink-0">{peer.ipv4}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {latency ? (
          <span className="font-mono text-[9.5px] text-muted-foreground">{latency}</span>
        ) : null}
        {link ? (
          <span className="text-[8.5px] tracking-wide text-muted-foreground/50 uppercase">
            {link}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function MultiplayerRoom({
  gameRoot,
  installedVersions,
  onRefreshInstalled,
  config,
  status,
  busy,
  hosts,
  logs,
  shareCode,
  pinging,
  resources,
  resourcesLoading,
  resourcesError,
  p2pLinked,
  gameRunning,
  autoLanPort,
  autoRefresh = true,
  onToggleAutoRefresh,
  onRefreshAll,
  refreshingAll = false,
  refreshTick = 0,
  onLaunchVersion,
  onRefreshResources,
  onChangePort,
  onResume,
  onApplyConfig,
  onAddPeer,
  onAddHost,
  onRemoveHost,
  onToggleBridge,
  onPingHost,
  onPingAll,
  onNotify,
}: MultiplayerRoomProps) {
  const isGuest = config.role === "guest";
  const running = Boolean(status?.running);
  const hostOverlay = isGuest
    ? config.hostIpv4 || config.overlayIpv4
    : config.overlayIpv4;
  const mainHost =
    hosts.find((entry) => entry.host === hostOverlay && entry.port === config.hostPort) ??
    hosts[0] ??
    null;
  const bridgeAddress = mainHost?.bridgePort ? `127.0.0.1:${mainHost.bridgePort}` : "";

  const [portDraft, setPortDraft] = useState(String(config.hostPort));
  const [overlayDraft, setOverlayDraft] = useState(config.overlayIpv4);
  const [addAddress, setAddAddress] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    setPortDraft(String(config.hostPort));
  }, [config.hostPort]);

  useEffect(() => {
    setOverlayDraft(config.overlayIpv4);
  }, [config.overlayIpv4]);

  const portNumber = Number(portDraft);
  const portValid =
    Number.isInteger(portNumber) && portNumber > 0 && portNumber < 65536;
  const portDirty = portValid && portNumber !== config.hostPort;
  const commitPort = () => {
    if (!portDirty) return;
    onChangePort(portNumber);
  };

  const addWorld = () => {
    if (!addAddress.trim()) return;
    if (onAddHost(addAddress)) setAddAddress("");
  };

  const activeServer =
    config.publicServer ||
    (config.relayNodes && config.relayNodes.length > 0
      ? config.relayNodes[0]
      : DEFAULT_PUBLIC_SERVER);

  return (
    <div className="space-y-4">
      {status && !running ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-gold/25 bg-gold/[0.06] px-4 py-2.5">
          <WifiOff className="size-4 shrink-0 text-gold" />
          <p className="min-w-0 flex-1 text-[12px] font-medium">网络已断开</p>
          <Button
            size="sm"
            className="h-7 shrink-0 gap-1.5 text-[11px]"
            disabled={busy === "start"}
            onClick={onResume}
          >
            {busy === "start" ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {isGuest ? "重新连接" : "重新开房"}
          </Button>
        </section>
      ) : null}

      <section className="overflow-hidden rounded-xl border border-border/70 bg-card/55">
        <header className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <StatusDot tone={running ? "online" : "muted"} animated={busy === "start"} />
          <span className="text-[12px] font-medium">
            {running ? "EasyTier 网络已连接" : "未连接"}
          </span>
          <Badge
            variant="outline"
            className="h-4 px-1.5 text-[9px] font-normal text-muted-foreground"
          >
            {isGuest ? "访客" : "房主"}
          </Badge>

          {/* 实时刷新控制器 */}
          {running ? (
            <div className="flex items-center gap-1.5 ml-2">
              <button
                type="button"
                onClick={onToggleAutoRefresh}
                title={autoRefresh ? "自动实时刷新中，点击可暂停" : "自动实时刷新已暂停，点击恢复"}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9.5px] transition-colors cursor-pointer select-none",
                  autoRefresh
                    ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                    : "border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted/70",
                )}
              >
                <span
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    autoRefresh ? "bg-emerald-400 animate-pulse" : "bg-muted-foreground",
                  )}
                />
                <span>{autoRefresh ? "实时刷新中" : "已暂停刷新"}</span>
              </button>

              <Button
                variant="ghost"
                size="icon-xs"
                className="size-6 text-muted-foreground hover:text-foreground"
                title="立即刷新房间所有状态与成员"
                disabled={refreshingAll || pinging}
                onClick={onRefreshAll}
              >
                <RefreshCw
                  className={cn(
                    "size-3",
                    (refreshingAll || pinging) && "animate-spin text-primary",
                  )}
                />
              </Button>
            </div>
          ) : null}

          <Badge
            variant="outline"
            className="ml-auto h-4 px-1.5 text-[9px] font-normal border-primary/30 bg-primary/[0.06] text-primary"
          >
            {isPureP2p(config) ? "纯 IPv6 P2P · 无中继" : "P2P 直连 + 公益中继兜底"}
          </Badge>
        </header>

        <div className="grid gap-4 p-4 min-[980px]:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          {/* 左侧：游戏端入口与联机说明 */}
          {isGuest ? (
            <div className="min-w-0 space-y-3 rounded-lg border border-border/80 bg-card/60 px-3.5 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-foreground">游戏内连接入口</span>
                {bridgeAddress ? (
                  <Badge variant="outline" className="h-4 px-1.5 text-[9px] border-primary/30 text-primary">
                    本地通道已就绪
                  </Badge>
                ) : (
                  <Badge variant="outline" className="h-4 px-1.5 text-[9px] text-muted-foreground">
                    正在协商通道...
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <code className="min-w-0 break-all font-mono text-[22px] leading-7 font-bold tracking-[-0.02em] text-foreground">
                  {bridgeAddress || "127.0.0.1:..."}
                </code>
                {bridgeAddress ? (
                  <CopyButton value={bridgeAddress} label="复制地址" onNotify={onNotify} />
                ) : null}
              </div>
              <div className="rounded border border-primary/15 bg-primary/5 p-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">连接方式：</p>
                <ol className="mt-1 list-decimal list-inside space-y-0.5 text-[10px]">
                  <li>启动相同版本的 Minecraft 游戏；</li>
                  <li>进入【多人游戏】，稍等片刻通常可直接在【局域网世界】列表中看到房主世界；</li>
                  <li>如局域网列表中未出现，点击【直接连接】并输入上方通道地址加入即可。</li>
                </ol>
              </div>
            </div>
          ) : (
            <div className="min-w-0 space-y-3 rounded-lg border border-border/80 bg-card/60 px-3.5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-foreground">房主联机世界</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "h-4 px-1.5 text-[9px]",
                      autoLanPort || config.hostPort !== DEFAULT_HOST_PORT
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-gold/40 bg-gold/10 text-gold",
                    )}
                  >
                    {autoLanPort
                      ? `局域网端口已同步: ${config.hostPort}`
                      : config.hostPort !== DEFAULT_HOST_PORT
                        ? `局域网端口: ${config.hostPort}`
                        : "等待游戏开放局域网"}
                  </Badge>
                </div>
                {onLaunchVersion && config.hostVersion && !gameRunning ? (
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 gap-1 px-2 text-[10px]"
                    onClick={() => onLaunchVersion(config.hostVersion)}
                  >
                    <Play className="size-2.5 fill-current" />
                    启动游戏 ({config.hostVersion})
                  </Button>
                ) : null}
              </div>

              {/* 关键防错提醒框 */}
              <div className="rounded-lg border border-amber-500/35 bg-amber-500/[0.08] p-3 text-[10.5px] leading-relaxed text-amber-200/90 shadow-sm">
                <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  <span>联机正确操作（避免 Connection refused 错误）：</span>
                </div>
                <ol className="mt-1.5 list-decimal list-inside space-y-1 text-[10px] text-amber-100/80">
                  <li>在启动器中启动游戏，点击<strong>【单人游戏】</strong>进入你的存档世界；</li>
                  <li>在游戏内按 <kbd className="rounded border border-amber-500/30 bg-amber-500/20 px-1 font-mono text-[9px] text-amber-200">ESC</kbd> 键，点击<strong>【对局域网开放】</strong>开启；</li>
                  <li>
                    {isPureP2p(config)
                      ? "把分享码发给访客；访客把回执码发回后，在下方「纯 IPv6 P2P」面板登记即可建立直连。"
                      : "启动器会自动读取端口并同步，好友输入右侧房间信息即可加入！"}
                  </li>
                </ol>
                <div className="mt-2 rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[9.5px] text-amber-200">
                  ❗ <strong>特别注意：</strong>房主已经在单人游戏中，<strong>切勿在【多人游戏】中尝试连接自己</strong>，否则必然提示 Connection refused！
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-primary/15 pt-2.5">
                <span className="text-[10px] text-muted-foreground">局域网端口</span>
                <Input
                  value={portDraft}
                  inputMode="numeric"
                  onChange={(event) =>
                    setPortDraft(event.target.value.replace(/\D/g, "").slice(0, 5))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitPort();
                  }}
                  className="h-6 w-20 font-mono text-[10.5px]"
                />
                <Button
                  variant={portDirty ? "default" : "ghost"}
                  size="xs"
                  className="h-6 px-2 text-[10px]"
                  disabled={!portDirty}
                  onClick={commitPort}
                >
                  更新
                </Button>
                {autoLanPort ? (
                  <span className="text-[9px] text-primary">已自动从游戏日志检测</span>
                ) : (
                  <span className="text-[9px] text-muted-foreground">游戏内开放局域网后会自动读取</span>
                )}
              </div>
            </div>
          )}

          {/* 右侧：Astral 风格房间信息卡片 */}
          <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border/60 bg-background/40 p-3">
            <div>
              <div className="flex items-center justify-between">
                <FieldLabel>房间名称</FieldLabel>
                <CopyButton value={config.networkName} label="复制" onNotify={onNotify} />
              </div>
              <div className="mt-1 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] font-medium text-foreground">
                {config.networkName}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <FieldLabel>房间密码</FieldLabel>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-5 text-muted-foreground"
                    title={showPassword ? "隐藏密码" : "显示密码"}
                    onClick={() => setShowPassword((v) => !v)}
                  >
                    {showPassword ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                  </Button>
                  <CopyButton value={config.networkSecret} label="复制" onNotify={onNotify} />
                </div>
              </div>
              <div className="mt-1 rounded-md border border-border/50 bg-muted/20 px-2.5 py-1.5 font-mono text-[11px] text-foreground">
                {showPassword ? config.networkSecret : "••••••••••••"}
              </div>
            </div>

            <div className="border-t border-border/40 pt-2">
              {isGuest ? (
                <>
                  <div className="flex items-center justify-between">
                    <FieldLabel>
                      {isPureP2p(config) ? "房主 IPv6 入口" : "公益协助节点"}
                    </FieldLabel>
                    <CopyButton
                      value={isPureP2p(config) ? config.hostEntry : activeServer}
                      label="复制"
                      onNotify={onNotify}
                    />
                  </div>
                  <p
                    title={isPureP2p(config) ? config.hostEntry : activeServer}
                    className="mt-1 truncate rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 font-mono text-[9.5px] text-muted-foreground"
                  >
                    {isPureP2p(config) ? config.hostEntry : activeServer}
                  </p>
                  <p className="mt-1 text-[9px] text-muted-foreground/80">
                    {isPureP2p(config)
                      ? "这是房主的直连入口；你的回执码在下方「纯 IPv6 P2P」面板。"
                      : "双方通过这个共享节点建立虚拟局域网。"}
                  </p>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <FieldLabel>一键分享码</FieldLabel>
                    <CopyButton value={shareCode} label="复制分享码" onNotify={onNotify} />
                  </div>
                  <p
                    title={shareCode}
                    className="mt-1 truncate rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 font-mono text-[9.5px] text-muted-foreground"
                  >
                    {shareCode}
                  </p>
                  <p className="mt-1 text-[9px] text-muted-foreground/80">
                    {isPureP2p(config)
                      ? "分享码只包含房主 IPv6 入口；访客加入后把回执码发给你，在下方 P2P 面板登记。"
                      : "好友可在加入界面直接粘贴分享码，或输入房间名与密码快速加入。"}
                  </p>
                </>
              )}
            </div>

            <div className="mt-auto border-t border-border/40 pt-2">
              {isPureP2p(config) ? (
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Network className="size-3 text-primary" />
                  <span>连接模式：</span>
                  <span className="font-mono text-[9px] text-primary">
                    纯 IPv6 P2P · 无中继
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Server className="size-3 text-primary" />
                  <span>公益协助节点：</span>
                  <span className="font-mono text-[9px] text-foreground truncate max-w-[170px]" title={activeServer}>
                    {activeServer}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <MultiplayerP2pPanel
        gameRoot={gameRoot}
        config={config}
        status={status}
        running={running}
        isGuest={isGuest}
        linked={Boolean(p2pLinked)}
        onAddPeer={onAddPeer}
        onNotify={onNotify}
      />

      <RoomResourcesPanel
        resources={resources}
        loading={resourcesLoading}
        error={resourcesError}
        running={running}
        isGuest={isGuest}
        gameRoot={gameRoot}
        installedVersions={installedVersions}
        hostAddress={config.hostIpv4}
        resourcePort={config.resourcePort}
        resourceToken={config.resourceToken}
        onRefresh={onRefreshResources}
        onRefreshInstalled={onRefreshInstalled}
        onNotify={onNotify}
      />

      {isGuest ? (
        <div className="grid gap-4 min-[1080px]:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
          <Panel
            title="局域网世界"
            icon={<Network className="size-3.5 text-muted-foreground" />}
            action={
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                title="重新探测"
                disabled={!running || pinging}
                onClick={onPingAll}
              >
                <RefreshCw className={cn("size-3", pinging && "animate-spin")} />
              </Button>
            }
          >
            <div className="space-y-2 p-3">
              <div className="flex gap-1.5">
                <Input
                  value={addAddress}
                  onChange={(event) => setAddAddress(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") addWorld();
                  }}
                  placeholder="10.126.126.7:25565"
                  className="h-7 font-mono text-[10.5px]"
                />
                <Button
                  variant="outline"
                  size="icon-sm"
                  className="size-7 shrink-0"
                  title="添加世界"
                  onClick={addWorld}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>

              {hosts.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-1.5 py-7 text-center text-muted-foreground">
                  <Radio className="size-4 opacity-40" />
                  <p className="text-[10.5px]">加入房间后，房主的世界会自动出现在这里</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {hosts.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                          {entry.label}
                        </span>
                        {entry.status?.ok ? (
                          <div className="flex items-center gap-1 shrink-0">
                            <Badge
                              variant="outline"
                              className="h-4 border-primary/25 bg-primary/[0.07] px-1 font-mono text-[9px] text-primary"
                            >
                              {entry.status.version}
                            </Badge>
                            {entry.status.latencyMs > 0 ? (
                              <Badge
                                variant="outline"
                                className="h-4 border-emerald-500/25 bg-emerald-500/[0.07] px-1 font-mono text-[9px] text-emerald-400"
                              >
                                {entry.status.latencyMs}ms
                              </Badge>
                            ) : null}
                          </div>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground/60"
                          title="移除"
                          onClick={() => onRemoveHost(entry)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                      <p className="truncate font-mono text-[9.5px] text-muted-foreground/70">
                        {entry.host}:{entry.port}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                          {entry.status?.ok
                            ? `${entry.status.motd} · ${entry.status.online}/${entry.status.max} 人`
                            : entry.status
                              ? entry.status.error || "连接失败"
                              : "未检测"}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground/60"
                          title="重新探测"
                          disabled={!running}
                          onClick={() => void onPingHost(entry)}
                        >
                          <RefreshCw className="size-3" />
                        </Button>
                        <Button
                          variant="outline"
                          size="xs"
                          className={cn(
                            "h-6 px-1.5 text-[10px]",
                            entry.bridgePort &&
                              "border-primary/40 bg-primary/10 text-primary",
                          )}
                          onClick={() => onToggleBridge(entry)}
                        >
                          <Radio className="mr-1 size-3" />
                          {entry.bridgePort ? "停止" : "显示到局域网"}
                        </Button>
                      </div>
                      {entry.bridgePort ? (
                        <p className="mt-1.5 border-t border-border/40 pt-1.5 font-mono text-[9.5px] text-muted-foreground">
                          本机入口 127.0.0.1:{entry.bridgePort}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Panel>

          <Panel
            title="我的虚拟网络"
            icon={<Link2 className="size-3.5 text-muted-foreground" />}
            action={
              <Badge
                variant="outline"
                className={cn(
                  "h-4 px-1.5 text-[9px] font-normal",
                  running
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border/70 bg-muted/30 text-muted-foreground",
                )}
              >
                {running ? "已连接" : "已断开"}
              </Badge>
            }
          >
            <div className="space-y-3 p-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="w-16 shrink-0 text-[10.5px] text-muted-foreground">
                    虚拟地址
                  </span>
                  <Input
                    value={overlayDraft}
                    onChange={(event) => setOverlayDraft(event.target.value)}
                    className="h-7 min-w-0 flex-1 font-mono text-[10.5px]"
                  />
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="size-7 shrink-0"
                    title="随机换一个虚拟地址"
                    onClick={() => setOverlayDraft(createOverlayIpv4())}
                  >
                    <RefreshCw className="size-3" />
                  </Button>
                  <Button
                    size="xs"
                    className="h-7 shrink-0 px-2.5 text-[10.5px]"
                    disabled={
                      busy !== null ||
                      !isOverlayIpv4(overlayDraft) ||
                      overlayDraft.trim() === config.overlayIpv4
                    }
                    onClick={() => onApplyConfig({ overlayIpv4: overlayDraft.trim() })}
                  >
                    {busy === "start" ? (
                      <LoaderCircle className="size-3 animate-spin" />
                    ) : null}
                    应用
                  </Button>
                </div>
              </div>
            </div>
          </Panel>
        </div>
      ) : (
        <div className="grid items-start gap-4 min-[1080px]:grid-cols-[minmax(0,1fr)_minmax(340px,0.95fr)]">
          <RoomMembersPanel
            gameRoot={gameRoot}
            running={running}
            isGuest={false}
            refreshTick={refreshTick}
          />
          <HostPermissionPanel config={config} onChangeConfig={onApplyConfig} />
        </div>
      )}

      {isGuest ? (
        <RoomMembersPanel
          gameRoot={gameRoot}
          running={running}
          isGuest
          hostIpv4={config.hostIpv4}
          refreshTick={refreshTick}
        />
      ) : null}

      <RoomLogPanel logs={logs} />
    </div>
  );
}
