import { useEffect, useState } from "react";
import {
  Link2,
  LoaderCircle,
  Network,
  Plus,
  Radio,
  RefreshCw,
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
  createOverlayIpv4,
  isOverlayIpv4,
} from "../lib/multiplayer";
import type {
  LocalIpv6Address,
  MinecraftHostStatus,
  MultiplayerConfig,
  MultiplayerHost,
  MultiplayerPeer,
  MultiplayerStatus,
  RoomResources,
} from "../lib/types";
import { MultiplayerFirewallNotice } from "./MultiplayerFirewall";
import { HostPermissionPanel } from "./MultiplayerHostPanels";
import { RoomResourcesPanel } from "./MultiplayerRoomResources";
import {
  CopyButton,
  FieldLabel,
  Panel,
  RoomLogPanel,
  type Notify,
} from "./MultiplayerShared";
import { StatusDot } from "./ui";

interface MultiplayerRoomProps {
  gameRoot: string;
  config: MultiplayerConfig;
  publicAddress: string;
  addresses: LocalIpv6Address[];
  status: MultiplayerStatus | null;
  busy: "start" | "stop" | "join" | null;
  hosts: MultiplayerHost[];
  logs: string[];
  shareCode: string;
  pinging: boolean;
  resources: RoomResources | null;
  resourcesLoading: boolean;
  resourcesError: string | null;
  onRefreshResources: () => void;
  onChangePublicAddress: (value: string) => void;
  onChangePort: (port: number) => void;
  onResume: () => void;
  onApplyConfig: (patch: Partial<MultiplayerConfig>) => void;
  onAddHost: (address: string) => boolean;
  onRemoveHost: (entry: MultiplayerHost) => void;
  onToggleBridge: (entry: MultiplayerHost) => void;
  onPingHost: (entry: MultiplayerHost) => Promise<MinecraftHostStatus>;
  onPingAll: () => void;
  onNotify: Notify;
}

/**
 * 在线成员：地址来自 EasyTier 自己的 peer 列表，名字显示对方电脑的主机名。
 */
function RoomMembersPanel({
  gameRoot,
  running,
  isGuest,
  hostIpv4,
  className,
}: {
  gameRoot: string;
  running: boolean;
  isGuest: boolean;
  hostIpv4?: string;
  className?: string;
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
    const timer = window.setInterval(() => void load(true), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [gameRoot, running, tick]);

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
          {running && !error && !loading ? (
            <p className="max-w-[260px] text-[9.5px] leading-4 text-muted-foreground/60">
              把分享码发给好友，连上后会显示名字和虚拟 IP。
            </p>
          ) : null}
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
      {peers.length > 0 ? (
        <p className="mt-2 border-t border-border/40 pt-2 text-[9.5px] text-muted-foreground/60">
          来自 EasyTier 虚拟网络 · 每 5 秒自动刷新
        </p>
      ) : null}
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
          "flex size-7 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium",
          peer.isSelf
            ? "border-primary/30 bg-primary/10 text-primary"
            : "border-border/60 bg-muted/25 text-muted-foreground",
        )}
      >
        {name.slice(0, 1).toUpperCase()}
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
  config,
  publicAddress,
  addresses,
  status,
  busy,
  hosts,
  logs,
  shareCode,
  pinging,
  resources,
  resourcesLoading,
  resourcesError,
  onRefreshResources,
  onChangePublicAddress,
  onChangePort,
  onResume,
  onApplyConfig,
  onAddHost,
  onRemoveHost,
  onToggleBridge,
  onPingHost,
  onPingAll,
  onNotify,
}: MultiplayerRoomProps) {
  const isGuest = config.peers.length > 0;
  const running = Boolean(status?.running);
  const hostOverlay = isGuest
    ? config.hostIpv4 || config.overlayIpv4
    : config.overlayIpv4;
  const peer = config.peers[0] ?? "";
  const mainHost =
    hosts.find((entry) => entry.host === hostOverlay && entry.port === config.hostPort) ??
    hosts[0] ??
    null;
  const bridgeAddress = mainHost?.bridgePort ? `127.0.0.1:${mainHost.bridgePort}` : "";
  // 内核以无 TUN 方式运行：房主的虚拟地址在本机没有路由，游戏直接连它也
  // 连不上。访客要进游戏，得先由启动器在本机开好代理端口。
  const connectAddress = isGuest
    ? bridgeAddress || "先在下方启用局域网显示"
    : `${hostOverlay}:${config.hostPort}`;

  const [portDraft, setPortDraft] = useState(String(config.hostPort));
  const [overlayDraft, setOverlayDraft] = useState(config.overlayIpv4);
  const [addAddress, setAddAddress] = useState("");

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

  return (
    <div className="space-y-4">
      {status && !running ? (
        <section className="flex flex-wrap items-center gap-3 rounded-xl border border-gold/25 bg-gold/[0.06] px-4 py-2.5">
          <WifiOff className="size-4 shrink-0 text-gold" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium">网络已断开</p>
            <p className="text-[10.5px] text-muted-foreground">
              房间记录还在，用原来的密码接回去。
            </p>
          </div>
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
            {running ? "已连接" : "未连接"}
          </span>
          <Badge
            variant="outline"
            className="h-4 px-1.5 text-[9px] font-normal text-muted-foreground"
          >
            {isGuest ? "访客" : "房主"}
          </Badge>
          <span className="ml-auto text-[10px] text-muted-foreground">IPv6 直连</span>
        </header>

        <div className="grid gap-4 p-4 min-[980px]:grid-cols-[minmax(0,1.1fr)_minmax(280px,0.9fr)]">
          <div className="min-w-0 rounded-lg border border-primary/20 bg-primary/[0.055] px-3.5 py-3">
            <div className="flex items-center gap-2">
              <span className="text-[10.5px] text-muted-foreground">
                {isGuest ? "直接连接地址" : "好友连接地址"}
              </span>
              <span className="ml-auto text-[9.5px] text-muted-foreground/60">
                {isGuest ? "房主的世界" : "局域网端口已映射"}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <code className="min-w-0 break-all font-mono text-[21px] leading-7 tracking-[-0.02em] text-foreground">
                {connectAddress}
              </code>
              {!isGuest || bridgeAddress ? (
                <CopyButton value={connectAddress} label="复制地址" onNotify={onNotify} />
              ) : null}
            </div>
            <p className="mt-1.5 text-[10.5px] leading-4 text-muted-foreground">
              {isGuest
                ? "游戏 → 多人游戏 → 直接连接，粘贴本机代理地址；也可以用下方的局域网显示。"
                : "好友导入分享码后，用启动器替他们开好的本机地址进入这个世界。"}
            </p>

            {!isGuest ? (
              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-primary/15 pt-2.5">
                <span className="text-[10.5px] text-muted-foreground">局域网端口</span>
                <Input
                  value={portDraft}
                  inputMode="numeric"
                  onChange={(event) =>
                    setPortDraft(event.target.value.replace(/\D/g, "").slice(0, 5))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitPort();
                  }}
                  className="h-7 w-20 font-mono text-[11px]"
                />
                <Button
                  variant={portDirty ? "default" : "ghost"}
                  size="xs"
                  className="h-7 px-2 text-[10.5px]"
                  disabled={!portDirty}
                  onClick={commitPort}
                >
                  更新
                </Button>
                <span className="text-[9.5px] text-muted-foreground/60">
                  换端口后把新分享码再发一次
                </span>
              </div>
            ) : null}

            {!isGuest ? (
              <div className="mt-2 border-t border-primary/15 pt-2">
                <MultiplayerFirewallNotice
                  gameRoot={gameRoot}
                  listenPort={config.listenPort}
                  hostPort={config.hostPort}
                  overlayIpv4={config.overlayIpv4}
                  publicAddress={publicAddress}
                />
              </div>
            ) : null}
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            {isGuest ? (
              <>
                <FieldLabel>房主入口</FieldLabel>
                <div className="flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 font-mono text-[10px]">
                    {peer || "分享码里没有入口地址"}
                  </code>
                  <CopyButton value={peer} onNotify={onNotify} />
                </div>

                <div className="rounded-md border border-border/50 bg-background/40 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <Radio className="size-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 text-[10.5px]">
                      {mainHost?.bridgePort
                        ? "世界已显示在局域网列表"
                        : "在多人游戏列表里显示这个世界"}
                    </span>
                    <Button
                      variant="outline"
                      size="xs"
                      className={cn(
                        "h-6 shrink-0 px-1.5 text-[10px]",
                        mainHost?.bridgePort &&
                          "border-primary/40 bg-primary/10 text-primary",
                      )}
                      disabled={!running || !mainHost}
                      onClick={() => {
                        if (mainHost) onToggleBridge(mainHost);
                      }}
                    >
                      {mainHost?.bridgePort ? "停止显示" : "显示"}
                    </Button>
                  </div>
                  {mainHost?.bridgePort ? (
                    <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/40 pt-1.5">
                      <code className="font-mono text-[9.5px] text-muted-foreground">
                        127.0.0.1:{mainHost.bridgePort}
                      </code>
                      <CopyButton
                        value={`127.0.0.1:${mainHost.bridgePort}`}
                        onNotify={onNotify}
                        className="ml-auto"
                      />
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <FieldLabel>分享码</FieldLabel>
                  <CopyButton
                    value={shareCode}
                    label="复制分享码"
                    onNotify={onNotify}
                    className="ml-auto"
                  />
                </div>
                <p
                  title={shareCode}
                  className="truncate rounded-md border border-border/50 bg-muted/20 px-2 py-1.5 font-mono text-[9.5px] text-muted-foreground"
                >
                  {shareCode}
                </p>
                <p className="text-[9.5px] leading-4 text-muted-foreground/70">
                  实际连接只走房主的公网 IPv6；网络标识由启动器自动生成，不需要填写。
                </p>
                {!publicAddress.trim() ? (
                  <p className="text-[9.5px] leading-4 text-gold/80">
                    填上对外入口，访客才能直连进来。
                  </p>
                ) : null}

                <details className="group mt-auto border-t border-border/40 pt-2">
                  <summary className="cursor-pointer list-none text-[10px] text-muted-foreground transition-colors hover:text-foreground">
                    对外入口 ·{" "}
                    <span className="font-mono text-[9.5px]">
                      {publicAddress.trim() || "未填写"}
                    </span>
                  </summary>
                  <div className="mt-1.5 space-y-1.5">
                    <Input
                      value={publicAddress}
                      onChange={(event) => onChangePublicAddress(event.target.value)}
                      placeholder="tcp://[240e:…]:11010"
                      className="h-7 font-mono text-[10px]"
                    />
                    <div className="flex flex-wrap gap-1">
                      {addresses.map((entry) => (
                        <button
                          key={`${entry.address}-${entry.interface}`}
                          type="button"
                          disabled={!entry.global}
                          title={entry.global ? undefined : "不是公网地址，访客连不上"}
                          onClick={() =>
                            onChangePublicAddress(
                              `tcp://[${entry.address}]:${config.listenPort}`,
                            )
                          }
                          className={cn(
                            "flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[9px] transition-colors",
                            entry.global && !entry.temporary
                              ? "border-primary/25 bg-primary/[0.06] hover:border-primary/50"
                              : "border-border/60 bg-muted/20 text-muted-foreground hover:border-border",
                            !entry.global && "cursor-not-allowed opacity-45",
                          )}
                        >
                          <span
                            className={cn(
                              "size-1 rounded-full",
                              entry.global && !entry.temporary
                                ? "bg-primary"
                                : "bg-muted-foreground/50",
                            )}
                          />
                          {entry.address}
                        </button>
                      ))}
                    </div>
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      </section>

      <RoomResourcesPanel
        resources={resources}
        loading={resourcesLoading}
        error={resourcesError}
        running={running}
        isGuest={isGuest}
        onRefresh={onRefreshResources}
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
                          <Badge
                            variant="outline"
                            className="h-4 shrink-0 border-primary/25 bg-primary/[0.07] px-1 font-mono text-[9px] text-primary"
                          >
                            {entry.status.version}
                          </Badge>
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
            title="我的网络"
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
                <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground/70">
                  改地址会重启网络并重新连上房主。
                </p>
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
          />
          <HostPermissionPanel
            config={config}
            running={running}
            onChangeConfig={onApplyConfig}
          />
        </div>
      )}

      {isGuest ? (
        <RoomMembersPanel
          gameRoot={gameRoot}
          running={running}
          isGuest
          hostIpv4={config.hostIpv4}
        />
      ) : null}

      <RoomLogPanel logs={logs} />
    </div>
  );
}
