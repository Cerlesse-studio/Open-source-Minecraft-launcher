import { useEffect, useState } from "react";
import { LoaderCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
  getMultiplayerFirewallStatus,
  setupMultiplayerFirewall,
} from "../lib/backend";
import type { MultiplayerFirewallStatus } from "../lib/types";
import type { Notify } from "./MultiplayerShared";

interface MultiplayerFirewallNoticeProps {
  gameRoot: string;
  listenPort: number;
  hostPort: number;
  overlayIpv4: string;
  publicAddress: string;
  onNotify: Notify;
  /** Kernel must be installed before a program rule can be written. */
  canFix?: boolean;
  className?: string;
}

function publicHost(value: string): string {
  const withoutScheme = value.trim().replace(/^(?:tcp|udp):\/\//i, "");
  if (withoutScheme.startsWith("[")) {
    const end = withoutScheme.indexOf("]");
    return end > 1 ? withoutScheme.slice(1, end) : "";
  }
  return withoutScheme.split(":")[0] ?? "";
}

/**
 * Windows 防火墙负责本机入站，路由器/光猫负责 IPv6 入站，两层缺一不可。
 * 本机这一层可以一键补齐；路由器这一层给出明确的目标地址和端口。
 */
export function MultiplayerFirewallNotice({
  gameRoot,
  listenPort,
  hostPort,
  overlayIpv4,
  publicAddress,
  onNotify,
  canFix = true,
  className,
}: MultiplayerFirewallNoticeProps) {
  const [status, setStatus] = useState<MultiplayerFirewallStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      getMultiplayerFirewallStatus(gameRoot, listenPort, hostPort, overlayIpv4)
        .then((next) => {
          if (alive) setStatus(next);
        })
        .catch((error) => {
          if (!alive) return;
          setStatus({
            supported: true,
            ready: false,
            detail: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (alive) setChecking(false);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [gameRoot, listenPort, hostPort, overlayIpv4, tick, canFix]);

  const apply = async () => {
    if (status?.ready) {
      setTick((value) => value + 1);
      return;
    }
    setBusy(true);
    try {
      const next = await setupMultiplayerFirewall(
        gameRoot,
        listenPort,
        hostPort,
        overlayIpv4,
      );
      setStatus(next);
      onNotify(
        "success",
        "Windows 防火墙已放行",
        `已允许 EasyTier 的 TCP/UDP ${listenPort} 与房间资源接口；路由器还需放行 IPv6 入站。`,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus({ supported: true, ready: false, detail });
      onNotify("error", "Windows 防火墙放行失败", detail);
    } finally {
      setBusy(false);
    }
  };

  const unsupported = status?.supported === false;
  const host = publicHost(publicAddress);

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {status?.ready ? (
          <ShieldCheck className="size-3.5 shrink-0 text-primary" />
        ) : (
          <ShieldAlert className="size-3.5 shrink-0 text-gold" />
        )}
        <span className="text-[10.5px] font-medium">
          {unsupported ? "系统防火墙" : "Windows 防火墙"}
        </span>
        <span
          className={cn(
            "text-[10px]",
            status?.ready ? "text-primary" : "text-muted-foreground",
          )}
        >
          {checking
            ? "检查中…"
            : status?.ready
              ? "已放行"
              : unsupported
                ? "需手动放行"
                : "未放行"}
        </span>
        {!unsupported ? (
          <Button
            variant={status?.ready ? "ghost" : "outline"}
            size="xs"
            className="ml-auto h-6 shrink-0 px-1.5 text-[10px]"
            disabled={busy || checking || !canFix}
            onClick={() => void apply()}
          >
            {busy ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {status?.ready ? "重新检查" : busy ? "放行中…" : "一键放行"}
          </Button>
        ) : null}
      </div>
      <p className="text-[9.5px] leading-4 text-muted-foreground/70">
        路由器（光猫）还需放行 IPv6 入站 TCP/UDP {listenPort}
        {host ? (
          <>
            {" "}
            到 <span className="font-mono text-foreground/80">{host}</span>
          </>
        ) : null}
        。
      </p>
      {!checking && status?.detail && !status.ready ? (
        <p
          className="truncate text-[9.5px] leading-4 text-gold/75"
          title={status.detail}
        >
          {status.detail}
        </p>
      ) : null}
    </div>
  );
}
