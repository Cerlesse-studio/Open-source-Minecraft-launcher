import type { ReactNode } from "react";
import { LoaderCircle, Package, Palette, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RoomResourceItem, RoomResources } from "../lib/types";
import { Panel } from "./MultiplayerShared";

interface RoomResourcesPanelProps {
  resources: RoomResources | null;
  loading: boolean;
  error: string | null;
  running: boolean;
  isGuest: boolean;
  onRefresh: () => void;
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function ResourceColumn({
  title,
  icon,
  items,
  empty,
}: {
  title: string;
  icon: ReactNode;
  items: RoomResourceItem[];
  empty: string;
}) {
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border/55 bg-background/25">
      <div className="flex items-center gap-1.5 border-b border-border/45 px-2.5 py-2">
        {icon}
        <span className="text-[10.5px] font-medium">{title}</span>
        <Badge
          variant="outline"
          className="ml-auto h-4 min-w-4 justify-center px-1 font-mono text-[8.5px] font-normal text-muted-foreground"
        >
          {items.length}
        </Badge>
      </div>
      {items.length === 0 ? (
        <p className="px-2 py-6 text-center text-[10px] text-muted-foreground/45">{empty}</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto p-1">
          {items.map((item) => (
            <li
              key={item.fileName}
              title={item.fileName}
              className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 transition-colors hover:bg-muted/20"
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  item.enabled ? "bg-primary" : "bg-muted-foreground/30",
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[10.5px] leading-4",
                  !item.enabled && "text-muted-foreground/55",
                )}
              >
                {item.name}
              </span>
              {!item.enabled ? (
                <span className="shrink-0 text-[8.5px] text-muted-foreground/50">停用</span>
              ) : null}
              {item.size > 0 ? (
                <span className="shrink-0 font-mono text-[8.5px] text-muted-foreground/45">
                  {formatSize(item.size)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 房间资源是房主版本的一份只读快照：房主本机扫描，访客经 EasyTier
 * 虚拟网络读取；两边渲染的是同一份清单。
 */
export function RoomResourcesPanel({
  resources,
  loading,
  error,
  running,
  isGuest,
  onRefresh,
}: RoomResourcesPanelProps) {
  const total = resources
    ? resources.mods.length + resources.shaders.length + resources.resourcePacks.length
    : 0;

  return (
    <Panel
      title="房间资源"
      icon={<Package className="size-3.5 text-muted-foreground" />}
      action={
        <div className="flex items-center gap-1.5">
          {resources ? (
            <Badge
              variant="outline"
              className="h-4 max-w-40 truncate px-1.5 font-mono text-[8.5px] font-normal text-muted-foreground"
            >
              {resources.versionId}
            </Badge>
          ) : null}
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title="刷新资源列表"
            disabled={!running || loading}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          </Button>
        </div>
      }
      bodyClassName="p-3"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground/65">
          {isGuest ? "来自房主版本" : "当前房间版本"}
        </span>
        <span className="text-[9px] text-muted-foreground/40">·</span>
        <span className="text-[10px] text-muted-foreground/65">所有成员相同</span>
        {resources ? (
          <span className="ml-auto font-mono text-[9px] text-muted-foreground/45">
            {total} 项
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-gold/25 bg-gold/[0.06] px-3 py-2.5">
          <p className="text-[10.5px] leading-4 text-gold/90">{error}</p>
          {isGuest && !error.includes("支持 Java 版") ? (
            <p className="mt-1 text-[9.5px] leading-4 text-muted-foreground/70">
              让房主在创建房间页点一次「一键放行」，或重新发一份分享码。
            </p>
          ) : null}
        </div>
      ) : !running ? (
        <div className="flex items-center justify-center gap-2 py-7 text-muted-foreground/50">
          <Package className="size-4" />
          <p className="text-[10.5px]">网络连接后加载房间资源</p>
        </div>
      ) : loading && !resources ? (
        <div className="flex items-center justify-center gap-2 py-7 text-muted-foreground/60">
          <LoaderCircle className="size-4 animate-spin" />
          <p className="text-[10.5px]">正在读取房主版本的资源…</p>
        </div>
      ) : resources ? (
        <div className="grid gap-2 md:grid-cols-3">
          <ResourceColumn
            title="模组"
            icon={<Package className="size-3 text-muted-foreground/70" />}
            items={resources.mods}
            empty="没有模组"
          />
          <ResourceColumn
            title="光影包"
            icon={<Sparkles className="size-3 text-muted-foreground/70" />}
            items={resources.shaders}
            empty="没有光影包"
          />
          <ResourceColumn
            title="资源包"
            icon={<Palette className="size-3 text-muted-foreground/70" />}
            items={resources.resourcePacks}
            empty="没有资源包"
          />
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2 py-7 text-muted-foreground/50">
          <Package className="size-4" />
          <p className="text-[10.5px]">还没有资源列表</p>
        </div>
      )}
    </Panel>
  );
}
