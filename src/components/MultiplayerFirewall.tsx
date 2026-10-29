import { useEffect, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { getMultiplayerFirewallStatus } from "../lib/backend";
import type { MultiplayerFirewallStatus } from "../lib/types";

interface MultiplayerFirewallNoticeProps {
  gameRoot: string;
  listenPort: number;
  hostPort: number;
  overlayIpv4: string;
  publicAddress: string;
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
 *
 * 启动器不再申请管理员权限：安装包在安装时就把 EasyTier 的入站端口写进
 * 防火墙，这里只做只读检查，把“本机这一层是否已放行”显示清楚。
 */
export function MultiplayerFirewallNotice({
  gameRoot,
  listenPort,
  hostPort,
  overlayIpv4,
  publicAddress,
  className,
}: MultiplayerFirewallNoticeProps) {
  const [status, setStatus] = useState<MultiplayerFirewallStatus | null>(null);
  const [checking, setChecking] = useState(true);
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
  }, [gameRoot, listenPort, hostPort, overlayIpv4, tick]);

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
            variant="ghost"
            size="xs"
            className="ml-auto h-6 shrink-0 px-1.5 text-[10px]"
            disabled={checking}
            onClick={() => setTick((value) => value + 1)}
          >
            重新检查
          </Button>
        ) : null}
      </div>
      <p className="text-[9.5px] leading-4 text-muted-foreground/70">
        安装时已自动放行 TCP/UDP {listenPort}；路由器（光猫）还需放行 IPv6 入站
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
