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
  /** Relay mode only needs outbound connections; no router inbound rule. */
  relay?: boolean;
  className?: string;
}

/**
 * 直连模式先放行本机：双方同时向对方发包，尝试让状态防火墙建立回程。
 * 这不能绕过路由器直接丢弃入站 IPv6 的策略。
 * 启动器不申请管理员权限，安装包会在安装时写入本机规则，这里只做只读检查。
 */
export function MultiplayerFirewallNotice({
  gameRoot,
  listenPort,
  hostPort,
  overlayIpv4,
  relay = false,
  className,
}: MultiplayerFirewallNoticeProps) {
  const [status, setStatus] = useState<MultiplayerFirewallStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // 共享节点只建立出站连接，本机没有任何入站监听需要放行，
    // 不要再显示一个会误导用户去改防火墙/路由器的「未放行」。
    if (relay) {
      setStatus(null);
      setChecking(false);
      return;
    }
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
  }, [gameRoot, listenPort, hostPort, overlayIpv4, relay, tick]);

  const unsupported = status?.supported === false;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {relay || status?.ready ? (
          <ShieldCheck className="size-3.5 shrink-0 text-primary" />
        ) : (
          <ShieldAlert className="size-3.5 shrink-0 text-gold" />
        )}
        <span className="text-[10.5px] font-medium">
          {relay ? "联机方式" : unsupported ? "系统防火墙" : "Windows 防火墙"}
        </span>
        <span
          className={cn(
            "text-[10px]",
            relay || status?.ready ? "text-primary" : "text-muted-foreground",
          )}
        >
          {relay
            ? "无需放行"
            : checking
              ? "检查中…"
              : status?.ready
                ? "已放行"
                : unsupported
                  ? "需手动放行"
                  : "未放行"}
        </span>
        {!relay && !unsupported ? (
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
        {relay
          ? "只建立出站连接，无需任何入站放行。"
          : `本机 TCP/UDP ${listenPort} 已放行；路由器若丢弃入站 IPv6，仍需自行放行。`}
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
