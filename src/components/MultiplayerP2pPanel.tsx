import { useEffect, useState } from "react";
import {
  Check,
  Globe,
  LoaderCircle,
  Plus,
  Radio,
  ShieldCheck,
} from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLocalIpv6Addresses } from "../lib/backend";
import {
  buildPeerReceipt,
  ipv6FromPeer,
  isPureP2p,
  parsePeerReceipt,
  peerFromAddress,
} from "../lib/multiplayer";
import type {
  LocalIpv6Address,
  MultiplayerConfig,
  MultiplayerStatus,
} from "../lib/types";
import {
  CopyButton,
  FieldLabel,
  Panel,
  type Notify,
} from "./MultiplayerShared";

interface MultiplayerP2pPanelProps {
  gameRoot: string;
  config: MultiplayerConfig;
  status: MultiplayerStatus | null;
  running: boolean;
  isGuest: boolean;
  /** 访客是否已经和房主建立直连。 */
  linked: boolean;
  onAddPeer: (peer: string) => Promise<void>;
  onNotify: Notify;
}

/** 纯 P2P 房间的手动信令面板：分享码 + 回执码就是全部“信令服务”。 */
export function MultiplayerP2pPanel(props: MultiplayerP2pPanelProps) {
  if (!isPureP2p(props.config)) return null;
  return <P2pPanelBody {...props} />;
}

function P2pPanelBody({
  config,
  status,
  running,
  isGuest,
  linked,
  onAddPeer,
  onNotify,
}: MultiplayerP2pPanelProps) {
  const [addresses, setAddresses] = useState<LocalIpv6Address[]>([]);
  const [receiptAddress, setReceiptAddress] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [peerDraft, setPeerDraft] = useState("");
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getLocalIpv6Addresses()
      .then((list) => {
        if (!alive) return;
        const global = list.filter((item) => item.global);
        setAddresses(global);
        setReceiptAddress((current) =>
          global.some((item) => item.address === current)
            ? current
            : global.find((item) => !item.temporary)?.address ?? global[0]?.address ?? "",
        );
        setLoadError(null);
      })
      .catch((error) => {
        if (alive) setLoadError(String(error));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const preferred =
    addresses.find((item) => item.address === receiptAddress) ??
    addresses.find((item) => !item.temporary) ??
    addresses[0] ??
    null;
  const ownAddress = preferred?.address ?? "";
  const selectedAddress = ipv6FromPeer(config.hostEntry) ?? ownAddress;
  const ownEndpoint = selectedAddress
    ? peerFromAddress(selectedAddress, config.listenPort)
    : "";
  const displayOwnAddress = isGuest ? ownAddress : selectedAddress || ownAddress;
  const displayTemporary = addresses.find(
    (item) => item.address === displayOwnAddress,
  )?.temporary;
  const hostEndpoint = isGuest ? config.hostEntry : ownEndpoint;
  const receipt = isGuest
    ? buildPeerReceipt(config, addresses, receiptAddress)
    : "";
  const canAdd = Boolean(peerDraft.trim()) && !adding && running;

  const submitPeer = async () => {
    const parsed = parsePeerReceipt(peerDraft);
    if (!parsed) {
      setReceiptError("回执码无法识别，请让访客重新复制完整的 cobble-mp://reply 链接。");
      return;
    }
    if (parsed.networkName !== config.networkName) {
      setReceiptError("回执码属于另一个房间，请确认房主和访客的房间名称一致。");
      return;
    }
    setAdding(true);
    setReceiptError(null);
    try {
      await onAddPeer(parsed.peer);
      setPeerDraft("");
    } catch (error) {
      setReceiptError(String(error));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Panel
      title="纯 IPv6 P2P 直连"
      icon={<Globe className="size-3.5 text-primary" />}
      action={
        <Badge
          variant="outline"
          className="h-4 px-1.5 text-[9px] font-normal border-primary/30 bg-primary/[0.06] text-primary"
        >
          无中继
        </Badge>
      }
      bodyClassName="p-4"
    >
      <div className="grid gap-4 min-[980px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel>{isGuest ? "房主 IPv6 入口" : "本机 IPv6 入口"}</FieldLabel>
            <CopyButton value={hostEndpoint} label="复制入口" onNotify={onNotify} />
          </div>
          <code
            title={hostEndpoint}
            className="block truncate rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 font-mono text-[10.5px] text-foreground"
          >
            {hostEndpoint || "等待本机 IPv6 地址…"}
          </code>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[9.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="size-3 text-primary" />
              强制 p2p-only
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="size-3 text-primary" />
              不联系公共 STUN
            </span>
            <span className="font-mono">UDP/TCP {config.listenPort}</span>
          </div>

          {loading ? (
            <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" />
              正在读取本机公网 IPv6…
            </p>
          ) : loadError ? (
            <p className="text-[10px] leading-4 text-gold">{loadError}</p>
          ) : addresses.length === 0 ? (
            <p className="text-[10px] leading-4 text-gold">
              没有检测到公网 IPv6。纯 P2P 无法建立，可切换到公益节点模式。
            </p>
          ) : (
            <p className="truncate font-mono text-[9.5px] text-muted-foreground/70">
              本机：{displayOwnAddress}
              {displayTemporary ? "（临时地址）" : ""}
            </p>
          )}

          <p className="text-[9.5px] leading-4 text-muted-foreground/70">
            需要本机放行 EasyTier 的 UDP/TCP {config.listenPort} 端口；如果路由器直接丢弃入站
            IPv6 UDP，双方仍可能无法打洞，失败时不会自动回退中继。
          </p>
        </div>

        <div className="min-w-0 space-y-2 border-t border-border/50 pt-3 min-[980px]:border-t-0 min-[980px]:border-l min-[980px]:pt-0 min-[980px]:pl-4">
          {isGuest ? (
            <>
              {addresses.length > 1 ? (
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-[9.5px] text-muted-foreground">
                    回执地址
                  </span>
                  <select
                    value={receiptAddress}
                    onChange={(event) => setReceiptAddress(event.target.value)}
                    className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background/30 px-2 font-mono text-[9.5px] outline-none"
                  >
                    {addresses.map((item) => (
                      <option key={item.address} value={item.address}>
                        {item.address} · {item.interface}
                        {item.temporary ? "（临时）" : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <FieldLabel>本机回执码</FieldLabel>
                <CopyButton
                  value={receipt}
                  label="复制回执码"
                  onNotify={onNotify}
                />
              </div>
              <p
                title={receipt}
                className="truncate rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2 font-mono text-[10px] text-muted-foreground"
              >
                {receipt || "没有可用的公网 IPv6 地址，无法生成回执"}
              </p>
              <ol className="list-decimal list-inside space-y-1 text-[10px] leading-4 text-muted-foreground">
                <li>先把上方回执码发给房主；</li>
                <li>房主在房间的「纯 IPv6 P2P」面板粘贴并登记；</li>
                <li>成员列表出现房主后，直连即建立。</li>
              </ol>
              <p
                className={cn(
                  "text-[9.5px]",
                  linked ? "text-primary" : running ? "text-gold" : "text-muted-foreground",
                )}
              >
                {linked
                  ? "直连已建立，成员列表应已出现房主。"
                  : running
                    ? "等待房主登记回执…"
                    : "联机内核未运行"}
              </p>
            </>
          ) : (
            <>
              <FieldLabel>粘贴访客回执码</FieldLabel>
              <div className="flex gap-1.5">
                <Input
                  value={peerDraft}
                  onChange={(event) => {
                    setPeerDraft(event.target.value);
                    setReceiptError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canAdd) void submitPeer();
                  }}
                  placeholder="cobble-mp://reply?..."
                  className="h-8 min-w-0 flex-1 font-mono text-[10.5px]"
                />
                <Button
                  size="sm"
                  className="h-8 shrink-0 gap-1 px-2.5 text-[10.5px]"
                  disabled={!canAdd}
                  onClick={() => void submitPeer()}
                >
                  {adding ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <Plus className="size-3.5" />
                  )}
                  登记
                </Button>
              </div>
              {receiptError ? (
                <p className="text-[9.5px] leading-4 text-destructive">{receiptError}</p>
              ) : (
                <p className="text-[9.5px] leading-4 text-muted-foreground">
                  访客加入后会在自己的房间里生成回执码；登记后房主内核会主动向对方 IPv6
                  地址发起直连。
                </p>
              )}

              <div className="border-t border-border/40 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">已登记访客</span>
                  <Badge
                    variant="outline"
                    className="h-4 px-1.5 font-mono text-[9px] font-normal text-muted-foreground"
                  >
                    {config.peers.length}
                  </Badge>
                </div>
                {config.peers.length === 0 ? (
                  <p className="mt-1 flex items-center gap-1 text-[9.5px] text-muted-foreground/70">
                    <Radio className="size-3" />
                    还没有访客回执；分享码发给好友即可开始。
                  </p>
                ) : (
                  <div className="mt-1 space-y-1">
                    {config.peers.map((peer) => (
                      <p
                        key={peer}
                        title={peer}
                        className="flex items-center gap-1 truncate rounded border border-border/50 bg-muted/20 px-1.5 py-1 font-mono text-[9px] text-muted-foreground"
                      >
                        <Check className="size-2.5 shrink-0 text-primary" />
                        <span className="truncate">{peer}</span>
                      </p>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {status?.version ? (
        <p className="mt-3 border-t border-border/40 pt-2 font-mono text-[9px] text-muted-foreground/60">
          EasyTier {status.version} · {running ? "名单已就绪" : "内核未运行"}
        </p>
      ) : null}
    </Panel>
  );
}
