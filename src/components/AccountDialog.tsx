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
  beginLittleSkinLogin,
  beginMsLogin,
  cancelLittleSkinLogin,
  closeMsLoginWindow,
  getLittleSkinAccount,
  getMsAccount,
  openLittleSkinAuthorization,
  openExternalUrl,
  openMsLoginWindow,
  pollLittleSkinLogin,
  pollMsLogin,
  selectLittleSkinProfile,
  signOutLittleSkinAccount,
  signOutMsAccount,
} from "../lib/backend";
import type {
  LittleSkinAccount,
  LsDeviceCode,
  LsProfileChoice,
  MsAccount,
  MsDeviceCode,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Provider = "microsoft" | "littleskin";

interface AccountDialogProps {
  open: boolean;
  onClose: () => void;
  msAccount: MsAccount | null;
  lsAccount: LittleSkinAccount | null;
  clientId: string;
  onClientIdChange: (value: string) => void;
  littleskinClientId: string;
  onLittleskinClientIdChange: (value: string) => void;
  onMsSignedIn: (account: MsAccount) => void;
  onLsSignedIn: (account: LittleSkinAccount) => void;
  onMsSignedOut: () => void;
  onLsSignedOut: () => void;
  onNotify?: (tone: "success" | "error" | "info", title: string, detail?: string) => void;
}

const PROVIDER_LABEL: Record<Provider, string> = {
  microsoft: "Microsoft",
  littleskin: "LittleSkin",
};

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

/** The one-time code block shared by both login methods. */
function DeviceCodeCard({
  device,
  copied,
  onCopy,
  onOpenBrowser,
  status,
  remaining,
}: {
  device: MsDeviceCode | LsDeviceCode;
  copied: boolean;
  onCopy: () => void;
  onOpenBrowser: () => void;
  status: string;
  remaining: number | null;
}) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3.5">
      <p className="text-[11px] text-muted-foreground">在浏览器中输入以下代码</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 rounded-md border border-border/70 bg-background/60 px-2.5 py-2 text-center font-mono text-[17px] tracking-[0.22em] text-foreground">
          {device.userCode}
        </code>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-[11px]" onClick={onCopy}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
      <button
        type="button"
        className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        onClick={onOpenBrowser}
      >
        <ExternalLink className="size-3" />
        重新打开授权页面
      </button>
      <p className="mt-2 text-[10.5px] text-muted-foreground">
        {status}
        {remaining !== null
          ? `（剩余 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}）`
          : `（约 ${Math.round(device.expiresIn / 60)} 分钟内有效）`}
      </p>
    </div>
  );
}

export function AccountDialog({
  open,
  onClose,
  msAccount,
  lsAccount,
  clientId,
  onClientIdChange,
  littleskinClientId,
  onLittleskinClientIdChange,
  onMsSignedIn,
  onLsSignedIn,
  onMsSignedOut,
  onLsSignedOut,
  onNotify,
}: AccountDialogProps) {
  const [provider, setProvider] = useState<Provider>("microsoft");
  const [device, setDevice] = useState<MsDeviceCode | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const timer = useRef<number | null>(null);

  // LittleSkin has its own device code, polling timer and deadline: the code
  // expires in minutes, so the dialog counts down instead of polling forever.
  const [lsDevice, setLsDevice] = useState<LsDeviceCode | null>(null);
  const [lsProfiles, setLsProfiles] = useState<LsProfileChoice[]>([]);
  const [lsPendingId, setLsPendingId] = useState<string | null>(null);
  const [lsStatus, setLsStatus] = useState<string>("");
  const [lsError, setLsError] = useState<string | null>(null);
  const [lsBusy, setLsBusy] = useState(false);
  const [lsCopied, setLsCopied] = useState(false);
  const [lsDeadline, setLsDeadline] = useState<number | null>(null);
  const [lsRemaining, setLsRemaining] = useState<number | null>(null);
  const [showLsAdvanced, setShowLsAdvanced] = useState(false);
  const lsTimer = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // 已登录的 LittleSkin 账户记着自己的应用 ID，设置被清空时仍能续登。
  const effectiveLsClientId = (littleskinClientId.trim() || lsAccount?.clientId || "").trim();

  const stopLsPolling = useCallback(() => {
    if (lsTimer.current !== null) {
      window.clearTimeout(lsTimer.current);
      lsTimer.current = null;
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
            onMsSignedIn(fresh ?? result.account);
          } catch {
            onMsSignedIn(result.account);
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
  }, [device, open, clientId, onMsSignedIn, onNotify, stopPolling, onClose]);

  const finishLittleSkinLogin = useCallback(
    async (next: LittleSkinAccount, name: string) => {
      try {
        const fresh = await getLittleSkinAccount();
        onLsSignedIn(fresh ?? next);
      } catch {
        onLsSignedIn(next);
      }
      onNotify?.("success", "已登录 LittleSkin 账户", `${name} · 外置登录（authlib-injector）`);
      onClose();
    },
    [onLsSignedIn, onNotify, onClose],
  );

  useEffect(() => {
    if (!lsDevice || !open) return;
    let cancelled = false;
    let wait = Math.max(3, lsDevice.interval) * 1000;

    const tick = async () => {
      try {
        const result = await pollLittleSkinLogin(lsDevice.deviceCode, effectiveLsClientId);
        if (cancelled) return;
        if (result.state === "success" && result.account) {
          setLsStatus("登录成功");
          setLsDevice(null);
          setLsDeadline(null);
          await finishLittleSkinLogin(result.account, result.account.name);
          return;
        }
        if (result.state === "select_profile") {
          // Several characters: keep the OAuth token in the backend and let the
          // user pick; polling stops here.
          setLsDevice(null);
          setLsDeadline(null);
          setLsProfiles(result.profiles);
          setLsPendingId(result.pendingId ?? null);
          setLsStatus("请选择要使用的角色");
          return;
        }
        if (result.state === "slow_down") {
          wait += 5000;
          setLsStatus("LittleSkin 要求放慢轮询，继续等待…");
        } else {
          setLsStatus("等待你在浏览器中完成授权…");
        }
        lsTimer.current = window.setTimeout(tick, wait);
      } catch (e) {
        if (cancelled) return;
        setLsError(String(e));
        setLsDevice(null);
        setLsDeadline(null);
        setLsStatus("");
      }
    };

    setLsStatus("等待你在浏览器中完成授权…");
    lsTimer.current = window.setTimeout(tick, wait);
    return () => {
      cancelled = true;
      stopLsPolling();
    };
  }, [lsDevice, open, effectiveLsClientId, finishLittleSkinLogin, stopLsPolling]);

  // Countdown for the LittleSkin code; the flow stops itself once it expires.
  useEffect(() => {
    if (!lsDeadline) {
      setLsRemaining(null);
      return;
    }
    const update = () => {
      const left = Math.max(0, Math.floor((lsDeadline - Date.now()) / 1000));
      setLsRemaining(left);
      if (left === 0) {
        stopLsPolling();
        setLsDevice(null);
        setLsDeadline(null);
        setLsStatus("");
        setLsError("授权码已过期，请重新获取。");
      }
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [lsDeadline, stopLsPolling]);

  // Reset transient state whenever the dialog is reopened.
  useEffect(() => {
    if (open) {
      setError(null);
      setCopied(false);
      setLsError(null);
      setLsCopied(false);
      // 打开时默认选中已登录的那一种；两种都登录时优先 Microsoft。
      setProvider(msAccount?.signedIn ? "microsoft" : lsAccount?.signedIn ? "littleskin" : "microsoft");
    } else {
      setDevice(null);
      setStatus("");
      setLsDevice(null);
      setLsProfiles([]);
      setLsPendingId(null);
      setLsStatus("");
      setLsDeadline(null);
      stopPolling();
      stopLsPolling();
      void closeMsLoginWindow();
    }
  }, [open, stopPolling, stopLsPolling, msAccount?.signedIn, lsAccount?.signedIn]);

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

  const startLittleSkinLogin = async () => {
    setLsBusy(true);
    setLsError(null);
    setLsProfiles([]);
    setLsPendingId(null);
    setLsStatus("正在向 LittleSkin 申请授权码…");
    try {
      const code = await beginLittleSkinLogin(effectiveLsClientId);
      setLsDevice(code);
      setLsDeadline(Date.now() + Math.max(30, code.expiresIn) * 1000);
      // LittleSkin 的授权页要输入 LittleSkin 密码，必须用系统浏览器打开，
      // 绝不能让启动器自己的 WebView 收集它。
      try {
        await openLittleSkinAuthorization(
          code.verificationUriComplete ?? code.verificationUri,
        );
      } catch {
        // 链接也显示在对话框里，用户仍可手动打开。
      }
    } catch (e) {
      setLsError(String(e));
      setLsStatus("");
    } finally {
      setLsBusy(false);
    }
  };

  const chooseLittleSkinProfile = async (uuid: string) => {
    if (!lsPendingId) return;
    setLsBusy(true);
    setLsError(null);
    try {
      const result = await selectLittleSkinProfile(lsPendingId, uuid);
      if (result.state === "success" && result.account) {
        setLsProfiles([]);
        setLsPendingId(null);
        await finishLittleSkinLogin(result.account, result.account.name);
        return;
      }
      setLsError(result.message ?? "角色选择失败，请重试。");
    } catch (e) {
      setLsError(String(e));
    } finally {
      setLsBusy(false);
    }
  };

  const copyCode = async (value: string, mark: (next: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(value);
      mark(true);
      window.setTimeout(() => mark(false), 1600);
    } catch {
      // Clipboard may be blocked; the code stays visible to type manually.
    }
  };

  const signOutMs = async () => {
    setBusy(true);
    try {
      await signOutMsAccount();
      onMsSignedOut();
      onNotify?.("info", "已退出 Microsoft 账户", "该登录方式已清空，LittleSkin 登录不受影响。");
    } catch (e) {
      onNotify?.("error", "退出登录失败", String(e));
    } finally {
      setBusy(false);
    }
  };

  const signOutLs = async () => {
    setLsBusy(true);
    try {
      await signOutLittleSkinAccount();
      onLsSignedOut();
      onNotify?.("info", "已退出 LittleSkin 账户", "该登录方式已清空，微软登录不受影响。");
    } catch (e) {
      onNotify?.("error", "退出登录失败", String(e));
    } finally {
      setLsBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="游戏账户"
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
            <h2 className="text-[13.5px] font-semibold">游戏账户</h2>
            <p className="mt-0.5 text-[10.5px] text-muted-foreground">
              Microsoft 与 LittleSkin 是两种独立的登录方式，也可直接使用离线账户
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={onClose}>
            关闭
          </Button>
        </div>

        <div className="flex gap-1 border-b border-border/60 px-5 py-2">
          {(["microsoft", "littleskin"] as Provider[]).map((id) => {
            const signed = id === "microsoft" ? msAccount?.signedIn : lsAccount?.signedIn;
            return (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setProvider(id);
                  setError(null);
                  setLsError(null);
                }}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                  provider === id
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                {PROVIDER_LABEL[id]}
                {signed ? " · 已登录" : ""}
              </button>
            );
          })}
        </div>

        <div className="space-y-3.5 p-5">
          {provider === "microsoft" ? (
            msAccount?.signedIn ? (
              <>
                <div className="rounded-lg border border-border/70 bg-background/40 p-3.5">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-8 items-center justify-center rounded-md border border-border/70 bg-muted/25 text-muted-foreground">
                      <UserRound className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{msAccount.name}</p>
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {msAccount.uuid}
                      </p>
                    </div>
                    <Badge className="h-5 border-0 bg-primary/15 text-[10px] font-normal text-primary">
                      正版账户
                    </Badge>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <EditionChip
                      label="Java 版 已登录"
                      granted={msAccount.entitlements.java}
                      hint={
                        msAccount.entitlements.java
                          ? "启动 Java 版时使用该账户的会话"
                          : "该账户没有 Minecraft: Java 版"
                      }
                    />
                    <EditionChip
                      label={msAccount.entitlements.bedrock ? "基岩版 已授权" : "基岩版 未授权"}
                      granted={msAccount.entitlements.bedrock}
                      hint={
                        msAccount.entitlements.bedrock
                          ? "Windows 基岩版客户端会用同一账户自动登录"
                          : "该账户没有 Minecraft 基岩版（可另行购买或在商店登录）"
                      }
                    />
                    {msAccount.entitlements.gamePass ? (
                      <span className="inline-flex items-center gap-1 rounded-md border border-gold/35 bg-gold/10 px-1.5 py-0.5 text-[10px] text-gold">
                        <BadgeCheck className="size-2.5" />
                        Game Pass
                      </span>
                    ) : null}
                  </div>

                  <div className="mt-3 space-y-1 text-[10.5px] text-muted-foreground">
                    <p>Java 会话：{formatExpiry(msAccount.sessionExpiresAt)}</p>
                    {msAccount.xuid ? <p className="font-mono">XUID {msAccount.xuid}</p> : null}
                    {msAccount.sessionError ? (
                      <p className="text-destructive">{msAccount.sessionError}</p>
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
                    onClick={() => void signOutMs()}
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
                  <DeviceCodeCard
                    device={device}
                    copied={copied}
                    onCopy={() => void copyCode(device.userCode, setCopied)}
                    onOpenBrowser={() =>
                      void openMsLoginWindow(device.verificationUriComplete ?? device.verificationUri)
                    }
                    status={status}
                    remaining={null}
                  />
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
            )
          ) : lsAccount?.signedIn && lsProfiles.length === 0 && !lsDevice ? (
            <>
              <div className="rounded-lg border border-border/70 bg-background/40 p-3.5">
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-md border border-border/70 bg-muted/25 text-muted-foreground">
                    <UserRound className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{lsAccount.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {lsAccount.uuid}
                    </p>
                  </div>
                  <Badge className="h-5 border-0 bg-primary/15 text-[10px] font-normal text-primary">
                    LittleSkin
                  </Badge>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <EditionChip
                    label="Java 版 外置登录"
                    granted
                    hint="启动时通过 authlib-injector 注入 LittleSkin 的 Yggdrasil 地址"
                  />
                  <EditionChip
                    label="基岩版 不适用"
                    granted={false}
                    hint="LittleSkin 外置登录只作用于 Java 版"
                  />
                </div>

                <div className="mt-3 space-y-1 text-[10.5px] text-muted-foreground">
                  <p>Java 会话：{formatExpiry(lsAccount.sessionExpiresAt)}</p>
                  <p className="font-mono">
                    Yggdrasil · {lsAccount.yggdrasilApi ?? "littleskin.cn/api/yggdrasil"}
                  </p>
                  {lsAccount.sessionError ? (
                    <p className="text-destructive">{lsAccount.sessionError}</p>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-[11px]"
                  disabled={lsBusy}
                  onClick={() => void startLittleSkinLogin()}
                >
                  <RefreshCw className="size-3.5" />
                  重新登录
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 text-[11px] text-destructive hover:text-destructive"
                  disabled={lsBusy}
                  onClick={() => void signOutLs()}
                >
                  <LogOut className="size-3.5" />
                  退出登录
                </Button>
              </div>

              {/* 重新登录会切到下面的登录态并显示授权码，这里只显示错误。 */}
              {lsError ? (
                <p className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] leading-5 text-destructive">
                  {lsError}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <p className="text-[11.5px] leading-5 text-muted-foreground">
                使用 LittleSkin 的 OAuth 设备授权流登录，启动器不会接触你的 LittleSkin 密码。
                登录后通过 authlib-injector 把皮肤站认证注入游戏，因此只能进入同样启用了外置登录的服务器；
                它不能代替正版账号。
              </p>

              {lsProfiles.length > 0 ? (
                <div className="rounded-lg border border-primary/30 bg-primary/[0.05] p-3.5">
                  <p className="text-[11px] text-muted-foreground">
                    该账号有多个角色，选择要用于游戏的角色：
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {lsProfiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        disabled={lsBusy}
                        onClick={() => void chooseLittleSkinProfile(profile.id)}
                        className="flex w-full items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2.5 py-2 text-left text-[11.5px] transition-colors hover:border-primary/40 hover:bg-primary/10 disabled:opacity-60"
                      >
                        <UserRound className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                        <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">
                          {profile.id.slice(0, 8)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : lsDevice ? (
                <DeviceCodeCard
                  device={lsDevice}
                  copied={lsCopied}
                  onCopy={() => void copyCode(lsDevice.userCode, setLsCopied)}
                  onOpenBrowser={() =>
                    void openLittleSkinAuthorization(
                      lsDevice.verificationUriComplete ?? lsDevice.verificationUri,
                    )
                  }
                  status={lsStatus}
                  remaining={lsRemaining}
                />
              ) : (
                <div className="rounded-lg border border-border/70 bg-background/40 p-3.5 text-[11px] text-muted-foreground">
                  <p className="flex items-start gap-2">
                    <ShieldQuestion className="mt-0.5 size-3.5 shrink-0" />
                    需要先在 LittleSkin 创建 OAuth 应用，并把应用 ID 填在下面；设备代码流还需向
                    support@littleskin.cn 申请白名单，否则会返回 invalid_client。
                  </p>
                </div>
              )}

              {lsError ? (
                <p className="rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[11px] leading-5 text-destructive">
                  {lsError}
                </p>
              ) : null}

              <div className="space-y-1.5">
                <button
                  type="button"
                  className="text-[10.5px] text-muted-foreground hover:text-foreground"
                  onClick={() => setShowLsAdvanced((value) => !value)}
                >
                  {showLsAdvanced ? "收起高级设置" : "高级设置：LittleSkin 应用 ID"}
                </button>
                {showLsAdvanced || !littleskinClientId ? (
                  <div className="space-y-1.5">
                    <Input
                      value={littleskinClientId}
                      onChange={(event) => onLittleskinClientIdChange(event.target.value.trim())}
                      placeholder="LittleSkin OAuth 应用的 Client ID"
                      spellCheck={false}
                      className="h-8 font-mono text-[11px]"
                    />
                    <p className="text-[10px] leading-4 text-muted-foreground">
                      在 littleskin.cn/oauth/applications 创建应用（回调地址填
                      https://open.littleskin.cn/oauth/callback）后复制 Client ID；桌面端不使用
                      client_secret。
                    </p>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[10.5px] text-primary hover:underline"
                      onClick={() => void openExternalUrl("https://littleskin.cn/oauth/applications")}
                    >
                      <ExternalLink className="size-3" />
                      打开 LittleSkin 应用管理
                    </button>
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2">
                {lsDevice || lsProfiles.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-[11px]"
                    onClick={() => {
                      if (lsPendingId) void cancelLittleSkinLogin(lsPendingId);
                      setLsDevice(null);
                      setLsProfiles([]);
                      setLsPendingId(null);
                      setLsStatus("");
                      setLsDeadline(null);
                      stopLsPolling();
                    }}
                  >
                    取消
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  className="h-8 gap-1.5 text-[11px]"
                  disabled={lsBusy || Boolean(lsDevice) || lsProfiles.length > 0}
                  onClick={() => void startLittleSkinLogin()}
                >
                  <KeyRound className="size-3.5" />
                  {lsBusy ? "正在申请…" : "开始 LittleSkin 登录"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
