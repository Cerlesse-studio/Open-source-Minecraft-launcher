import { useEffect, useState, type ReactNode } from "react";
import {
  Boxes,
  Check,
  Database,
  Download,
  LoaderCircle,
  Package,
  Palette,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cloneRoomResources, subscribe } from "../lib/backend";
import type {
  InstalledVersion,
  RoomCloneProgress,
  RoomCloneResult,
  RoomResourceItem,
  RoomResources,
} from "../lib/types";
import { Panel, type Notify } from "./MultiplayerShared";

interface RoomResourcesPanelProps {
  resources: RoomResources | null;
  loading: boolean;
  error: string | null;
  running: boolean;
  isGuest: boolean;
  gameRoot: string;
  installedVersions: InstalledVersion[];
  hostAddress: string;
  resourcePort: number;
  resourceToken: string;
  onRefresh: () => void;
  onRefreshInstalled?: () => Promise<unknown> | void;
  onNotify: Notify;
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
              key={item.relativePath || item.fileName}
              title={item.relativePath || item.fileName}
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

function CloneToggle({
  checked,
  label,
  count,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  count?: number;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10.5px] transition-colors focus-visible:ring-1 focus-visible:ring-primary/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45",
        checked
          ? "border-primary/45 bg-primary/10 text-primary"
          : "border-border/65 bg-background/30 text-muted-foreground hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "flex size-3.5 items-center justify-center rounded-[3px] border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-border/70",
        )}
      >
        {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
      </span>
      {label}
      {count != null ? (
        <span className="font-mono text-[9px] text-muted-foreground/60">{count}</span>
      ) : null}
    </button>
  );
}

function versionLabel(resources: RoomResources): string {
  const info = resources.version;
  const parts: string[] = [];
  if (info?.mcVersion) parts.push(info.mcVersion);
  if (info?.loader) {
    parts.push(
      info.loaderVersion ? `${info.loader} ${info.loaderVersion}` : info.loader,
    );
  }
  if (info?.optifineVersion) parts.push(`OptiFine ${info.optifineVersion}`);
  if (parts.length === 0) parts.push(resources.versionId);
  return parts.join(" · ");
}

/**
 * 房间资源是房主版本的一份只读快照：房主本机扫描，访客经 EasyTier
 * 虚拟网络读取；两边渲染的是同一份清单。访客可以据此安装同版本实例，
 * 再把模组、光影和数据包按原路径克隆到本机。
 */
export function RoomResourcesPanel({
  resources,
  loading,
  error,
  running,
  isGuest,
  gameRoot,
  installedVersions,
  hostAddress,
  resourcePort,
  resourceToken,
  onRefresh,
  onRefreshInstalled,
  onNotify,
}: RoomResourcesPanelProps) {
  const [includeVersion, setIncludeVersion] = useState(true);
  const [includeMods, setIncludeMods] = useState(true);
  const [includeShaders, setIncludeShaders] = useState(true);
  const [includeDatapacks, setIncludeDatapacks] = useState(true);
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneResult, setCloneResult] = useState<RoomCloneResult | null>(null);
  const [cloneProgress, setCloneProgress] = useState<RoomCloneProgress | null>(null);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void subscribe("multiplayer:clone", (progress) => setCloneProgress(progress)).then(
      (unsubscribe) => {
        dispose = unsubscribe;
      },
    );
    return () => dispose?.();
  }, []);

  useEffect(() => {
    setCloneResult(null);
    setCloneError(null);
    setCloneProgress(null);
  }, [resources?.versionId]);

  const datapacks = resources?.datapacks ?? [];
  const total = resources
    ? resources.mods.length +
      resources.shaders.length +
      resources.resourcePacks.length +
      datapacks.length
    : 0;
  const versionInstalled = Boolean(
    resources && installedVersions.some((entry) => entry.id === resources.versionId),
  );
  const hasResourceSelection = includeVersion || includeMods || includeShaders || includeDatapacks;
  const hasFiles = Boolean(
    resources &&
      (includeVersion ? (resources.versionFiles?.length ?? 1) : 0) +
        (includeMods ? resources.mods.length : 0) +
        (includeShaders ? resources.shaders.length : 0) +
        (includeDatapacks ? datapacks.length : 0) >
        0,
  );
  const resourcesSupported = Boolean(
    resources &&
      [resources.versionFiles ?? [], resources.mods, resources.shaders, datapacks].some((items) =>
        items.some((item) => Boolean(item.fileId)),
      ),
  );
  const cloneBlockedReason = !resources
    ? "还没有资源清单"
    : !running
      ? "网络连接后才能克隆"
      : cloning
        ? "正在克隆"
        : !hasResourceSelection
          ? "请选择要克隆的内容"
          : hasResourceSelection && !resourcesSupported
            ? "房主资源服务未提供可传输的文件；请双方更新启动器"
            : !hasFiles
              ? "没有勾选可克隆的文件"
              : null;

  const handleClone = async () => {
    if (!resources) return;
    setCloning(true);
    setCloneError(null);
    setCloneResult(null);
    setCloneProgress(null);
    try {
      if (!gameRoot.trim()) throw new Error("游戏目录为空，请先在设置中指定");
      if (!hostAddress.trim()) throw new Error("房间还没有房主的虚拟地址");
      if (!resourcePort || !resourceToken) {
        throw new Error("分享码里没有房间资源入口，请房主重新发码");
      }

      const result = await cloneRoomResources(
        gameRoot,
        hostAddress,
        resourcePort,
        resourceToken,
        includeVersion,
        includeMods,
        includeShaders,
        includeDatapacks,
      );
      setCloneResult(result);

      if (includeVersion) {
        await onRefreshInstalled?.();
      }

      const summary = result
        ? `已复制 ${result.downloaded} 个文件${result.failed ? `，${result.failed} 个失败` : ""}${result.skipped ? `，跳过 ${result.skipped} 个文件夹` : ""}`
        : "克隆完成";
      if (result?.failed) {
        onNotify("info", "克隆完成，但部分文件失败", summary);
      } else {
        onNotify("success", "房主环境克隆完成", summary);
      }
      onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCloneError(message);
      onNotify("error", "克隆房主环境失败", message);
    } finally {
      setCloning(false);
    }
  };

  const progressPercent =
    cloneProgress && cloneProgress.total > 0
      ? Math.min(100, Math.round((cloneProgress.done / cloneProgress.total) * 100))
      : null;

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
        {resources ? (
          <span className="ml-auto font-mono text-[9px] text-muted-foreground/45">
            {total} 项
          </span>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg border border-gold/25 bg-gold/[0.06] px-3 py-2.5">
          <p className="text-[10.5px] leading-4 text-gold/90">{error}</p>
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
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
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
              title="数据包"
              icon={<Database className="size-3 text-muted-foreground/70" />}
              items={datapacks}
              empty="没有数据包"
            />
            <ResourceColumn
              title="资源包"
              icon={<Palette className="size-3 text-muted-foreground/70" />}
              items={resources.resourcePacks}
              empty="没有资源包"
            />
          </div>

          {isGuest ? (
            <div className="mt-3 rounded-lg border border-primary/25 bg-primary/[0.045] p-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Download className="size-3.5 text-primary" />
                <span className="text-[11.5px] font-medium">克隆房主环境</span>
                <span className="font-mono text-[9.5px] text-muted-foreground">
                  {versionLabel(resources)}
                </span>
                {versionInstalled ? (
                  <Badge
                    variant="outline"
                    className="h-4 border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[8.5px] font-normal text-emerald-400"
                  >
                    版本已安装
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-[10px] leading-4 text-muted-foreground/65">
                直接从房主电脑（文件服务器）克隆游戏版本核心、模组、配置文件、光影和数据包到本机，无需走互联网下载清单。同名文件会被覆盖。
              </p>

              <div className="mt-2 flex flex-wrap gap-1.5">
                <CloneToggle
                  checked={includeVersion}
                  label={`游戏版本${versionInstalled ? "（已安装）" : ""}`}
                  count={resources.versionFiles?.length}
                  onChange={setIncludeVersion}
                />
                <CloneToggle
                  checked={includeMods}
                  label="模组"
                  count={resources.mods.length}
                  onChange={setIncludeMods}
                />
                <CloneToggle
                  checked={includeShaders}
                  label="光影"
                  count={resources.shaders.length}
                  onChange={setIncludeShaders}
                />
                <CloneToggle
                  checked={includeDatapacks}
                  label="数据包"
                  count={datapacks.length}
                  onChange={setIncludeDatapacks}
                />
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 gap-1.5 text-[11px]"
                  disabled={Boolean(cloneBlockedReason)}
                  onClick={() => void handleClone()}
                >
                  {cloning ? (
                    <LoaderCircle className="size-3 animate-spin" />
                  ) : (
                    <Boxes className="size-3" />
                  )}
                  {cloning ? "正在克隆…" : "克隆到本机"}
                </Button>
                <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/60">
                  {cloneBlockedReason ??
                    (cloning && cloneProgress
                      ? cloneProgress.stage === "download"
                        ? `${cloneProgress.current}（${cloneProgress.done + 1}/${cloneProgress.total}）`
                        : "准备中…"
                      : "不会修改房主电脑上的文件")}
                </span>
              </div>

              {cloning && progressPercent != null ? (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-primary/15">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              ) : null}

              {cloneError ? (
                <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-4 text-destructive">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                  {cloneError}
                </p>
              ) : null}

              {cloneResult ? (
                <div className="mt-2 space-y-1 border-t border-primary/15 pt-2">
                  <p className="text-[10px] text-muted-foreground">
                    已下载 {cloneResult.downloaded} 个文件
                    {cloneResult.skipped > 0
                      ? `，跳过 ${cloneResult.skipped} 个文件夹`
                      : ""}
                    {cloneResult.failed > 0 ? `，失败 ${cloneResult.failed} 个` : ""}
                  </p>
                  {cloneResult.failures.slice(0, 3).map((failure) => (
                    <p
                      key={failure}
                      className="truncate text-[9.5px] text-gold/85"
                      title={failure}
                    >
                      {failure}
                    </p>
                  ))}
                  {cloneResult.failures.length > 3 ? (
                    <p className="text-[9.5px] text-muted-foreground/60">
                      其余 {cloneResult.failures.length - 3} 个失败未展开
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="flex items-center justify-center gap-2 py-7 text-muted-foreground/50">
          <Package className="size-4" />
          <p className="text-[10.5px]">还没有资源列表</p>
        </div>
      )}
    </Panel>
  );
}
