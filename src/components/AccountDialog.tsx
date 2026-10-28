import { useCallback, useEffect, useRef, useState } from "react";
import {
  BadgeCheck,
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  KeyRound,
  LogOut,
  RefreshCw,
  ShieldQuestion,
  UserRound,
} from "lucide-react";
import { cn } from "cn";
import {
  beginMsLogin,
  closeMsLoginWindow,
  getMsAccount,
  openExternalUrl,
  openMsLoginWindow,
  pollMsLogin,
  signOutMsAccount,
} from "../lib/backend";
import type { MsAccount, MsDeviceCode } from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface AccountDialogProps {
  open: boolean;
  onClose: () => void;
  account: MsAccount | null;
  clientId: string;
  onClientIdChange: (value: string) => void;
  onSignedIn: (account: MsAccount) => void;
  onSignedOut: () => void;
  onNotify?: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
}

function formatExpiry(seconds: number): string {
  if (!seconds) return "未知";
  const date = new Date(seconds * 1000);
  const hours = Math.floor((seconds * 1000 - Date.now()) / 3_600_000);
  if (hours <= 0) return "即将过期";
  if (hours > 48) return `${date.toLocaleDateString()} 到期`;
  return `约 ${hours} 小时后到期`;
}

/** Compact status chip: signed-in state for one edition. */
function EditionChip({
  label,
  granted,
  hint,
}: {
  label: string;
  granted: boolean;
  hint?: string;
}) {
  return (
    <span
      title={hint}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]",
        granted
          ? "border-primary/35 bg-primary/10 text-primary"
          : "border-border/70 bg-muted/25 text-muted-foreground",
      )}
    >
      {granted ? <Check className="size-2.5" /> : <CircleAlert className="size-2.5" />}
      {label}
    </span>
  );
}

export function AccountDialog({
  open,
  onClose,
  account,
  clientId,
  onClientIdChange,
  onSignedIn,
  onSignedOut,
  onNotify,
}: AccountDialogProps) {
  const [device, setDevice] = useState<MsDeviceCode | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const timer = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Polling lives in an effect so closing the dialog (or signing in) cancels it.
  useEffect(() => {
    if (!device || !open) return;
    let cancelled = false;
    let wait = Math.max(3, device.interval) * 1000;

    const tick = async () => {
      try {
        const result = await pollMsLogin(device.deviceCode, clientId || undefined);
        if (cancelled) return;
        if (result.state === "success" && result.account) {
          setStatus("登录成功");
          setDevice(null);
          void closeMsLoginWindow();
          // 从后端重新读取账户，确保状态与存储一致
          try {
            const fresh = await getMsAccount(clientId || undefined);
            onSignedIn(fresh ?? result.account);
          } catch {
            onSignedIn(result.account);
          }
          onNotify?.(
            "success",
            "已登录 Microsoft 账户",
            `${result.account.name} · Java 版${
              result.account.entitlements.java ? "已授权" : "未授权"
            } · 基岩版${result.account.entitlements.bedrock ? "已授权" : "未授权"}`,
          );
          // 登录成功后自动关闭对话框，回到主界面即可显示正版账户状态
          onClose();
          return;
        }
        if (result.state === "slow_down") {
          wait += 5000;
          setStatus("微软要求放慢轮询，继续等待…");
        } else {
          setStatus("等待你在浏览器中完成登录…");
        }
        timer.current = window.setTimeout(tick, wait);
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        setDevice(null);
        setStatus("");
      }
    };

    setStatus("等待你在浏览器中完成登录…");
    timer.current = window.setTimeout(tick, wait);
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [device, open, clientId, onSignedIn, onNotify, stopPolling, onClose]);

  // Reset transient state whenever the dialog is reopened.
  useEffect(() => {
    if (open) {
      setError(null);
      setCopied(false);
    } else {
      setDevice(null);
      setStatus("");
      stopPolling();
      void closeMsLoginWindow();
    }
  }, [open, stopPolling]);

  if (!open) return null;

  const startLogin = async () => {
    setBusy(true);
    setError(null);
    setStatus("正在向微软申请验证码…");
    try {
      const code = await beginMsLogin(clientId || undefined);
      setDevice(code);
      // The login runs in the launcher's own window on a clean session: the
      // system browser is usually already signed into some Microsoft account
      // (Edge even uses the Windows one) and then the sign-in page locks itself
      // to that address with no way to type a different account.
      const loginUrl = code.verificationUriComplete ?? code.verificationUri;
      try {
        await openMsLoginWindow(loginUrl);
      } catch {
        // Falling back to the system browser still lets the user finish the
        // login, so this is best effort only.
        try {
          await openExternalUrl(loginUrl);
        } catch {
          // The link is shown in the dialog either way.
        }
      }
    } catch (e) {
      setError(String(e));
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be blocked; the code stays visible to type manually.
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await signOutMsAccount();
      onSignedOut();
      onNotify?.("info", "已退出 Microsoft 账户", "启动器已回到离线账户模式。");
    } catch (e) {
      onNotify?.("error", "退出登录失败", String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Microsoft 账户"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-xs animate-in fade-in-0"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-border/80 bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border/60 px-5 py-3.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <KeyRound className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13.5px] font-semibold">微软账户登录</h2>
            <p className="mt-0.5 text-[10.5px] text-muted-foreground">
              一次登录同时用于 Java 版与基岩版
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={onClose}>
            关闭
          </Button>
        </div>

        <div className="space-y-3.5 p-5">
          {account?.signedIn ? (
            <>
              <div className="rounded-lg border border-border/70 bg-background/40 p-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-md border border-border/70 bg-muted/25 text-muted-foreground">
                    <UserRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{account.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {account.uuid}
                    </p>
                  </div>
                  <Badge className="h-5 border-0 bg-primary/15 text-[10px] font-normal text-primary">
                    正版账户
                  </Badge>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <EditionChip
                    label="Java 版 已登录"
                    granted={account.entitlements.java}
                    hint={
                      account.entitlements.java
                        ? "启动 Java 版时使用该账户的会话"
                        : "该账户没有 Minecraft: Java 版"
                    }
                  />
                  <EditionChip
                    label={account.entitlements.bedrock ? "基岩版 已授权" : "基岩版 未授权"}
                    granted={account.entitlements.bedrock}
                    hint={
                      account.entitlements.bedrock
                        ? "Windows 基岩版客户端会用同一账户自动登录"
                        : "该账户没有 Minecraft 基岩版（可另行购买或在商店登录）"
                    }
                  />
                  {account.entitlements.gamePass ? (
                    <span className="inline-flex items-center gap-1 rounded-md border border-gold/35 bg-gold/10 px-1.5 py-0.5 text-[10px] text-gold">
                      <BadgeCheck className="size-2.5" />
                      Game Pass
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 space-y-1 text-[10.5px] text-muted-foreground">
                  <p>Java 会话：{formatExpiry(account.sessionExpiresAt)}</p>
                  {account.xuid ? <p className="font-mono">XUID {account.xuid}</p> : null}
                  {account.sessionError ? (
                    <p className="text-destructive">{account.sessionError}</p>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-[11px]"
                  disabled={busy}
                  onClick={() => void startLogin()}
                >
                  <RefreshCw className="size-3.5" />
                  重新登录
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-[11px] text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => void signOut()}
                >
                  <LogOut className="size-3.5" />
                  退出登录
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[11.5px] leading-5 text-muted-foreground">
                启动器会向微软申请一个一次性代码，并在启动器自带的登录窗口中打开微软登录页 ——
                该窗口不带任何账户会话，因此你可以手动输入任意微软账户邮箱，不会被固定为电脑当前登录的账户。
                整个过程不会接触你的密码，刷新令牌只保存在本机启动器的数据目录中。
              </p>

              {device ? (
                <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3.5">
                  <p className="text-[11px] text-muted-foreground">在浏览器中输入以下代码</p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 rounded-md border border-border/70 bg-background/60 px-2.5 py-2 text-center font-mono text-[17px] tracking-[0.22em] text-foreground">
                      {device.userCode}
                    </code>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-[11px]"
                      onClick={() => void copyCode()}
                    >
                      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copied ? "已复制" : "复制"}
                    </Button>
                  </div>
                  <button
                    type="button"
                    className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                    onClick={() =>
                      void openMsLoginWindow(
                        device.verificationUriComplete ?? device.verificationUri,
                      )
                    }
                  >
                    <ExternalLink className="size-3" />
                    重新打开登录窗口
                  </button>
                  <button
                    type="button"
                    className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
                    onClick={() => void openExternalUrl(device.verificationUri)}
                  >
                    <ExternalLink className="size-3" />
                    或在系统浏览器中打开 {device.verificationUri}
                  </button>
                  <p className="mt-2 text-[10.5px] text-muted-foreground">
                    {status}（约 {Math.round(device.expiresIn / 60)} 分钟内有效）
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-border/70 bg-background/40 p-3.5 text-[11px] text-muted-foreground">
                  <p className="flex items-start gap-2">
                    <ShieldQuestion className="mt-0.5 size-3.5 shrink-0" />
                    未登录时启动器使用离线账户：可以单机游玩，但无法进入正版服务器，基岩版也只能走独立核心。
                  </p>
                </div>
              )}

              {error ? (
                <p className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] leading-5 text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="space-y-1.5">
                <button
                  type="button"
                  className="text-[10.5px] text-muted-foreground hover:text-foreground"
                  onClick={() => setShowAdvanced((value) => !value)}
                >
                  {showAdvanced ? "收起高级设置" : "高级设置：自定义 Azure 应用 ID"}
                </button>
                {showAdvanced ? (
                  <div className="space-y-1.5">
                    <Input
                      value={clientId}
                      onChange={(event) => onClientIdChange(event.target.value.trim())}
                      placeholder="留空使用启动器内置的客户端 ID"
                      spellCheck={false}
                      className="h-8 font-mono text-[11px]"
                    />
                    <p className="text-[10px] leading-4 text-muted-foreground">
                      若微软提示客户端 ID 不可用，可填入自己在 Azure 门户注册、并启用了「允许公共客户端流」的应用 ID。
                    </p>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2">
                {device ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-[11px]"
                    onClick={() => {
                      setDevice(null);
                      setStatus("");
                      void closeMsLoginWindow();
                    }}
                  >
                    取消
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  className="h-8 gap-1.5 text-[11px]"
                  disabled={busy || Boolean(device)}
                  onClick={() => void startLogin()}
                >
                  <KeyRound className="size-3.5" />
                  {busy ? "正在申请…" : "开始正版登录"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
