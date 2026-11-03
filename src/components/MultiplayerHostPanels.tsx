import { useEffect, useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type { MultiplayerConfig } from "../lib/types";
import { isRoomPassword, ROOM_PASSWORD_MIN } from "../lib/multiplayer";

// ---------------------------------------------------------------------------
// 权限管理：房间密码、访客带宽
// ---------------------------------------------------------------------------

interface HostPermissionPanelProps {
  config: MultiplayerConfig;
  onChangeConfig: (patch: Partial<MultiplayerConfig>) => void;
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
  onChangeConfig,
}: HostPermissionPanelProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [draft, setDraft] = useState(config.networkSecret);
  useEffect(() => {
    setDraft(config.networkSecret);
  }, [config.networkSecret]);

  const next = draft.trim();
  const valid = isRoomPassword(draft);
  const changed = valid && next !== config.networkSecret;

  return (
    <section className="rounded-xl border border-border/70 bg-card/55">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <ShieldCheck className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-[12px] font-medium">权限管理</span>
      </header>

      <div className="space-y-4 p-4">
        <div>
          <p className="mb-1.5 text-[10.5px] text-muted-foreground">房间密码</p>
          <div className="flex items-center gap-1.5">
            <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border border-border/50 bg-muted/20 px-2 transition-colors focus-within:border-ring">
              <input
                type={showPassword ? "text" : "password"}
                value={draft}
                maxLength={64}
                placeholder={`至少 ${ROOM_PASSWORD_MIN} 位`}
                onChange={(event) => setDraft(event.target.value)}
                className="h-full w-full min-w-0 bg-transparent font-mono text-[10.5px] outline-none placeholder:font-sans placeholder:text-muted-foreground/40"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6 shrink-0 text-muted-foreground"
                title={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
              </Button>
            </div>
            <Button
              size="xs"
              className="h-7 shrink-0 px-2.5 text-[10.5px]"
              disabled={!changed}
              onClick={() => onChangeConfig({ networkSecret: next })}
            >
              应用
            </Button>
          </div>
          {!valid ? (
            <p className="mt-1.5 text-[10px] leading-4 text-gold">
              密码需要 {ROOM_PASSWORD_MIN}–32 位，仅限字母、数字和英文符号。
            </p>
          ) : null}
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
      </div>
    </section>
  );
}
