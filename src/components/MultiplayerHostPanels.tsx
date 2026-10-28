import { useState } from "react";
import { Copy, Eye, EyeOff, KeyRound, ShieldCheck } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { MultiplayerConfig } from "../lib/types";

type Notify = (tone: "success" | "error" | "info", title: string, detail?: string) => void;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 权限管理：网络密钥、访客带宽
// ---------------------------------------------------------------------------

interface HostPermissionPanelProps {
  config: MultiplayerConfig;
  running: boolean;
  onChangeConfig: (patch: Partial<MultiplayerConfig>) => void;
  /** 换一把新的网络密钥；正在跑的房间会重启，旧分享码随即失效。 */
  onRotateSecret: () => void;
  onNotify: Notify;
}

/** EasyTier 的限速单位是字节/秒；这里按常见的 Mbps 给几档。 */
const BANDWIDTH_PRESETS = [
  { value: 0, label: "不限" },
  { value: 250_000, label: "2 Mbps" },
  { value: 1_250_000, label: "10 Mbps" },
  { value: 6_250_000, label: "50 Mbps" },
];

export function HostPermissionPanel({
  config,
  running,
  onChangeConfig,
  onRotateSecret,
  onNotify,
}: HostPermissionPanelProps) {
  const [showSecret, setShowSecret] = useState(false);

  return (
    <section className="rounded-xl border border-border/70 bg-card/55">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <ShieldCheck className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-[12px] font-medium">权限管理</span>
      </header>

      <div className="space-y-4 p-4">
        <div>
          <p className="mb-1.5 text-[10.5px] text-muted-foreground">网络密钥</p>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[10.5px] text-muted-foreground">密钥</span>
              <code className="min-w-0 flex-1 truncate rounded-md border border-border/50 bg-muted/20 px-2 py-1 font-mono text-[10.5px]">
                {showSecret ? config.networkSecret : "•".repeat(12)}
              </code>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 shrink-0 text-muted-foreground"
                title={showSecret ? "隐藏密钥" : "显示密钥"}
                onClick={() => setShowSecret((value) => !value)}
              >
                {showSecret ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 shrink-0 text-muted-foreground"
                title="复制密钥"
                onClick={async () => {
                  const ok = await copyText(config.networkSecret);
                  onNotify(ok ? "success" : "error", ok ? "密钥已复制" : "复制失败");
                }}
              >
                <Copy className="size-3" />
              </Button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[10px] text-muted-foreground/70">
              {running ? "换密钥会重启房间，旧分享码作废。" : "换密钥后旧分享码作废。"}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1.5 border-amber-500/40 px-2.5 text-[10.5px] text-amber-400 hover:bg-amber-500/10"
              onClick={onRotateSecret}
            >
              <KeyRound className="size-3" />
              轮换密钥
            </Button>
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[10.5px] text-muted-foreground">访客总带宽</p>
          <div className="flex flex-wrap gap-1.5">
            {BANDWIDTH_PRESETS.map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => onChangeConfig({ recvBpsLimit: preset.value })}
                className={cn(
                  "rounded-md border px-2 py-1 text-[10.5px] transition-colors",
                  config.recvBpsLimit === preset.value
                    ? "border-primary/40 bg-primary/[0.07] text-foreground"
                    : "border-border/60 bg-muted/20 text-muted-foreground hover:border-border",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>

        </div>

        <p className="border-t border-border/50 pt-3 text-[10px] leading-4 text-muted-foreground/70">
          真正的门禁是网络密钥，要立即清场就轮换密钥。
        </p>
      </div>
    </section>
  );
}
