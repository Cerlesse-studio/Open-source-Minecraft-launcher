import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Coffee,
  Copy,
  Download,
  House,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { cn } from "cn";
import { isDesktop } from "../lib/backend";
import type { GameStateName, ViewId } from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, GrassBlock, StatusDot } from "./ui";

async function withWindow(action: (window: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  if (!isDesktop) return;
  try {
    await action(getCurrentWindow());
  } catch {
    // Window controls are best effort (for example while the window is closing).
  }
}

export function TitleBar({ demo }: { demo: boolean }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    const window = getCurrentWindow();
    let dispose: (() => void) | undefined;
    window
      .isMaximized()
      .then(setMaximized)
      .catch(() => undefined);
    window
      .onResized(() => {
        window.isMaximized().then(setMaximized).catch(() => undefined);
      })
      .then((unlisten) => {
        dispose = unlisten;
      })
      .catch(() => undefined);
    return () => dispose?.();
  }, []);

  return (
    <header className="flex h-11 shrink-0 items-center border-b border-border/70 bg-[#070a08] pl-4">
      <div className="flex items-center gap-2.5" data-tauri-drag-region>
        <GrassBlock size={18} />
        <span className="font-pixel text-[11px] tracking-[0.16em] text-foreground">
          COBBLE
        </span>
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          卵石启动器
        </span>
      </div>
      <div
        className="h-full flex-1"
        data-tauri-drag-region
        onDoubleClick={() => withWindow((window) => window.toggleMaximize())}
      />
      {demo ? (
        <Badge
          variant="outline"
          className="mr-2 border-dashed text-[10px] font-normal text-muted-foreground"
          title="当前在浏览器中预览，不会下载或启动真实游戏"
        >
          预览模式
        </Badge>
      ) : null}
      <div className="flex items-center gap-0.5 pr-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="最小化"
          onClick={() => withWindow((window) => window.minimize())}
        >
          <Minus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={maximized ? "还原窗口" : "最大化"}
          onClick={() =>
            withWindow(async (window) => {
              await window.toggleMaximize();
              setMaximized(await window.isMaximized());
            })
          }
        >
          {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-md text-muted-foreground hover:bg-destructive hover:text-white"
          aria-label="关闭"
          onClick={() => withWindow((window) => window.close())}
        >
          <X />
        </Button>
      </div>
    </header>
  );
}

const NAV_ITEMS: Array<{
  id: ViewId;
  label: string;
  hint: string;
  icon: typeof House;
}> = [
  { id: "home", label: "主页", hint: "更新新闻与快速启动", icon: House },
  { id: "download", label: "下载", hint: "下载新的游戏版本与进入下载进度", icon: Download },
  { id: "settings", label: "设置", hint: "启动器总设置", icon: Settings2 },
];

export function Sidebar({
  view,
  onNavigate,
  playerName,
  installedCount,
  installingVersion,
  javaMajor,
  javaPath,
  javaDetecting,
  runtimeStatus,
  launcherVersion,
  collapsed,
  onToggleCollapsed,
}: {
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  playerName: string;
  installedCount: number;
  installingVersion?: string | null;
  javaMajor?: number;
  javaPath?: string;
  javaDetecting: boolean;
  runtimeStatus: GameStateName;
  launcherVersion: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const javaLabel = javaMajor
    ? `Java ${javaMajor}`
    : javaDetecting
      ? "正在检测 Java"
      : "Java 未检测到";
  const javaDetail = javaMajor
    ? "启动时会再次校验版本"
    : javaDetecting
      ? "正在扫描本机与运行时"
      : "首次启动会自动安装";
  const toggleLabel = collapsed ? "展开菜单" : "收起菜单";

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-border/70 bg-sidebar py-4 transition-[width] duration-200",
        collapsed ? "w-[72px] px-2" : "w-[232px] px-3",
      )}
    >
      <button
        className={cn(
          "group flex w-full items-center rounded-xl border border-sidebar-border bg-sidebar-accent/40 text-left transition-colors hover:bg-sidebar-accent",
          collapsed ? "justify-center p-2" : "gap-3 p-2.5",
        )}
        onClick={() => onNavigate("settings")}
        title={collapsed ? `${playerName} · 打开启动器设置` : "打开启动器设置"}
      >
        <div className="overflow-hidden rounded-lg border border-border/70 bg-background">
          <Avatar name={playerName} size={collapsed ? 36 : 38} />
        </div>
        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">{playerName}</span>
                <Badge
                  variant="outline"
                  className="h-4 shrink-0 border-border/80 px-1.5 text-[9px] font-normal text-muted-foreground"
                >
                  离线
                </Badge>
              </span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                本地账户
              </span>
            </span>
            <Settings2 className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </>
        ) : null}
      </button>

      {!collapsed ? (
        <p className="mb-2 mt-7 px-3 text-[11px] font-medium text-muted-foreground/70">
          导航
        </p>
      ) : (
        <div className="my-4 h-px bg-sidebar-border" />
      )}
      <nav className={cn("flex flex-col gap-1", collapsed && "mt-0")} aria-label="主导航">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active =
            view === item.id ||
            (item.id === "download" &&
              (view === "download-progress" || view === "version-install"));
          const showCount = item.id === "version-select" && installedCount > 0;
          const showDownloading = item.id === "download" && Boolean(installingVersion);
          return (
            <button
              key={item.id}
              className={cn(
                "group relative flex items-center rounded-lg text-[13px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                collapsed ? "h-10 justify-center px-0" : "h-9 gap-2.5 px-3",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              onClick={() => onNavigate(item.id)}
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? item.label : undefined}
              title={collapsed ? `${item.label} — ${item.hint}` : item.hint}
            >
              {active ? (
                <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-primary" />
              ) : null}
              <Icon
                className={cn(
                  "size-4 shrink-0 transition-colors",
                  active ? "text-primary" : "text-muted-foreground/80",
                  showDownloading && !active && "text-gold",
                )}
              />
              {!collapsed ? (
                <>
                  <span className="flex-1 text-left">{item.label}</span>
                  {showCount ? (
                    <Badge
                      variant={active ? "secondary" : "outline"}
                      className="h-5 min-w-5 justify-center px-1 font-mono text-[10px] font-normal"
                    >
                      {installedCount}
                    </Badge>
                  ) : null}
                  {showDownloading ? (
                    <Badge
                      variant="outline"
                      className="h-5 gap-1 border-gold/35 bg-gold/10 px-1.5 text-[9px] font-normal text-gold"
                    >
                      <StatusDot tone="pending" />
                      下载中
                    </Badge>
                  ) : null}
                </>
              ) : showCount || showDownloading ? (
                <span
                  className={cn(
                    "absolute right-2 top-2 size-1.5 rounded-full",
                    showDownloading ? "animate-pulse bg-gold" : "bg-primary",
                  )}
                />
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {collapsed ? (
        <div
          className="flex flex-col items-center gap-2 rounded-xl border border-sidebar-border bg-sidebar-accent/30 py-3"
          title={`${javaLabel} — ${javaDetail}`}
        >
          <Coffee className="size-4 text-gold" />
          <StatusDot
            tone={javaMajor ? "online" : javaDetecting ? "pending" : "warn"}
          />
        </div>
      ) : (
        <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/30 p-3">
          <div className="flex items-center gap-2 text-[11px] font-medium text-foreground">
            <Coffee className="size-3.5 text-gold" />
            {javaLabel}
            <StatusDot
              tone={javaMajor ? "online" : javaDetecting ? "pending" : "warn"}
              className="ml-auto"
            />
          </div>
          <p
            className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-muted-foreground"
            title={javaPath || undefined}
          >
            {javaDetail}
          </p>
        </div>
      )}

      <button
        type="button"
        className={cn(
          "mt-2 flex h-8 items-center rounded-lg text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          collapsed ? "justify-center px-0" : "gap-2 px-2.5",
        )}
        onClick={onToggleCollapsed}
        aria-label={toggleLabel}
        title={toggleLabel}
      >
        {collapsed ? (
          <PanelLeftOpen className="size-3.5" />
        ) : (
          <PanelLeftClose className="size-3.5" />
        )}
        {!collapsed ? <span>{toggleLabel}</span> : null}
      </button>

      <div
        className={cn(
          "mt-2 flex items-center gap-2 text-[10px] text-muted-foreground/70",
          collapsed ? "justify-center" : "px-1",
        )}
        title={collapsed ? `Cobble ${launcherVersion} · ${runtimeStatus === "running" ? "运行中" : "空闲"}` : undefined}
      >
        <GrassBlock size={12} />
        {!collapsed ? (
          <>
            <span className="font-mono">Cobble {launcherVersion}</span>
            <span className="ml-auto flex items-center gap-1.5">
              <StatusDot tone={runtimeStatus === "running" ? "live" : "muted"} />
              {runtimeStatus === "running" ? "运行中" : "空闲"}
            </span>
          </>
        ) : null}
      </div>
    </aside>
  );
}
