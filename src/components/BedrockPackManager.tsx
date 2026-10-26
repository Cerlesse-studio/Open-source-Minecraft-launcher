import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  CircleSlash2,
  FolderOpen,
  Import,
  LoaderCircle,
  Package,
  Paintbrush,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  UserRound,
  Wrench,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { cn } from "cn";
import {
  deleteBedrockPack,
  getBedrockPacks,
  getBedrockStatus,
  importBedrockPackFile,
  isDesktop,
  setBedrockPackEnabled,
} from "../lib/backend";
import type { BedrockPackItem, BedrockStatus } from "../lib/types";
import { formatBytes, formatDate } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface BedrockPackManagerProps {
  gameRoot: string;
  onOpenFolder: (path: string) => void;
  onNotify?: (
    level: "info" | "success" | "error",
    title: string,
    detail?: string,
  ) => void;
}

type PackTypeInfo = {
  key: string;
  label: string;
  folder: string;
  icon: typeof Boxes;
  tint: string;
  dot: string;
};

/**
 * Pack kinds, in the order the game presents them. The tint is only used for
 * the type badge and the icon placeholder, so a pack without `pack_icon.png`
 * still reads as its kind at a glance.
 */
const PACK_TYPES: PackTypeInfo[] = [
  {
    key: "resource",
    label: "资源包",
    folder: "resource_packs",
    icon: Paintbrush,
    tint: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300",
    dot: "bg-emerald-400",
  },
  {
    key: "behavior",
    label: "行为包",
    folder: "behavior_packs",
    icon: Wrench,
    tint: "border-sky-400/25 bg-sky-400/10 text-sky-300",
    dot: "bg-sky-400",
  },
  {
    key: "skin",
    label: "皮肤包",
    folder: "skin_packs",
    icon: UserRound,
    tint: "border-rose-400/25 bg-rose-400/10 text-rose-300",
    dot: "bg-rose-400",
  },
  {
    key: "template",
    label: "世界模板",
    folder: "world_templates",
    icon: Boxes,
    tint: "border-amber-400/25 bg-amber-400/10 text-amber-300",
    dot: "bg-amber-400",
  },
];

function packTypeInfo(type: string): PackTypeInfo {
  return (
    PACK_TYPES.find((entry) => entry.key === type) ?? {
      key: "resource",
      label: "附加包",
      folder: "resource_packs",
      icon: Package,
      tint: "border-border/70 bg-muted/30 text-muted-foreground",
      dot: "bg-muted-foreground",
    }
  );
}

function PackIcon({ pack }: { pack: BedrockPackItem }) {
  const info = packTypeInfo(pack.packType);
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(pack.icon) && !failed;

  useEffect(() => {
    setFailed(false);
  }, [pack.icon]);

  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border transition-opacity",
        info.tint,
        !pack.enabled && "opacity-55 saturate-50",
      )}
    >
      {showImage ? (
        <img
          src={pack.icon ?? ""}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover [image-rendering:pixelated]"
          onError={() => setFailed(true)}
        />
      ) : (
        <info.icon className="size-4.5" />
      )}
    </div>
  );
}

export function BedrockPackManager({
  gameRoot,
  onOpenFolder,
  onNotify,
}: BedrockPackManagerProps) {
  const [packs, setPacks] = useState<BedrockPackItem[]>([]);
  const [status, setStatus] = useState<BedrockStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [deleting, setDeleting] = useState<BedrockPackItem | null>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const id = ++requestId.current;
      if (!silent) setLoading(true);
      try {
        const [items, bedrockStatus] = await Promise.all([
          getBedrockPacks(gameRoot || undefined),
          getBedrockStatus(gameRoot || undefined).catch(() => null),
        ]);
        if (requestId.current !== id) return;
        setPacks(items);
        if (bedrockStatus) setStatus(bedrockStatus);
      } catch (error) {
        if (requestId.current === id) {
          onNotify?.("error", "读取基岩版附加包失败", String(error));
        }
      } finally {
        if (requestId.current === id) setLoading(false);
      }
    },
    [gameRoot, onNotify],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const byType = new Map<string, number>();
    let enabled = 0;
    let size = 0;
    for (const pack of packs) {
      byType.set(pack.packType, (byType.get(pack.packType) ?? 0) + 1);
      if (pack.enabled) enabled += 1;
      size += pack.size;
    }
    return { byType, enabled, disabled: packs.length - enabled, size };
  }, [packs]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return packs.filter((pack) => {
      if (typeFilter !== "all" && pack.packType !== typeFilter) return false;
      if (!needle) return true;
      return (
        pack.name.toLowerCase().includes(needle) ||
        pack.folder.toLowerCase().includes(needle) ||
        pack.description.toLowerCase().includes(needle) ||
        pack.id.toLowerCase().includes(needle)
      );
    });
  }, [packs, query, typeFilter]);

  const groups = useMemo(
    () =>
      PACK_TYPES.map((info) => ({
        info,
        items: visible.filter((pack) => pack.packType === info.key),
      })).filter((group) => group.items.length > 0),
    [visible],
  );

  const dataDir =
    status?.portablePath || status?.comMojangPath || "";

  const togglePack = useCallback(
    async (pack: BedrockPackItem) => {
      setBusyPath(pack.path);
      // Optimistic flip: the switch should answer the click immediately, the
      // reload below confirms what the disk really contains.
      setPacks((current) =>
        current.map((entry) =>
          entry.path === pack.path ? { ...entry, enabled: !entry.enabled } : entry,
        ),
      );
      try {
        await setBedrockPackEnabled(pack.path, !pack.enabled, gameRoot || undefined);
        onNotify?.(
          "success",
          pack.enabled ? "已停用附加包" : "已启用附加包",
          pack.name,
        );
        await load(true);
      } catch (error) {
        setPacks((current) =>
          current.map((entry) =>
            entry.path === pack.path ? { ...entry, enabled: pack.enabled } : entry,
          ),
        );
        onNotify?.("error", "切换附加包状态失败", String(error));
      } finally {
        setBusyPath(null);
      }
    },
    [gameRoot, load, onNotify],
  );

  const removePack = useCallback(async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    setBusyPath(target.path);
    try {
      await deleteBedrockPack(target.path, gameRoot || undefined);
      onNotify?.("success", "附加包已删除", target.name);
      await load(true);
    } catch (error) {
      onNotify?.("error", "删除附加包失败", String(error));
    } finally {
      setBusyPath(null);
    }
  }, [deleting, gameRoot, load, onNotify]);

  const importPack = useCallback(async () => {
    if (!isDesktop) {
      onNotify?.("info", "浏览器预览无法读取本地文件", "请在桌面应用中使用导入功能。");
      return;
    }
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          { name: "基岩版附加包", extensions: ["mcpack", "mcaddon", "mcworld", "zip"] },
        ],
      });
      if (typeof picked !== "string") return;
      setImporting(true);
      const result = await importBedrockPackFile(picked, gameRoot || undefined);
      onNotify?.("success", "附加包导入完成", result.message);
      await load(true);
    } catch (error) {
      onNotify?.("error", "导入附加包失败", String(error));
    } finally {
      setImporting(false);
    }
  }, [gameRoot, load, onNotify]);

  const bulkToggle = useCallback(
    async (enabled: boolean) => {
      const targets = packs.filter((pack) => pack.enabled !== enabled);
      if (targets.length === 0) return;
      setBusyPath("__bulk__");
      try {
        for (const pack of targets) {
          await setBedrockPackEnabled(pack.path, enabled, gameRoot || undefined);
        }
        onNotify?.(
          "success",
          enabled ? "已启用全部附加包" : "已停用全部附加包",
          `共处理 ${targets.length} 个附加包`,
        );
        await load(true);
      } catch (error) {
        onNotify?.("error", "批量操作失败", String(error));
        await load(true);
      } finally {
        setBusyPath(null);
      }
    },
    [gameRoot, load, onNotify, packs],
  );

  const stats = [
    { label: "全部", value: packs.length },
    { label: "已启用", value: counts.enabled },
    { label: "已停用", value: counts.disabled },
  ];

  return (
    <div className="space-y-4">
      {/* Explains why this panel is not the Java mod manager. */}
      <div className="relative overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-r from-primary/12 via-primary/5 to-transparent px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <Boxes className="size-4.5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">
                基岩版附加包管理器
                <Badge className="ml-2 h-4 border-0 bg-primary/20 px-1.5 text-[9px] font-normal text-primary">
                  .mcpack / .mcaddon
                </Badge>
              </p>
              <p className="mt-0.5 max-w-xl text-[11px] leading-5 text-muted-foreground">
                资源包、行为包与皮肤包直接写入 <span className="font-mono">com.mojang</span>，
                启动游戏后在「设置 → 存储」中即可看到；附加包由所有基岩版实例共用，不按版本隔离。Java 的{" "}
                <span className="font-mono">.jar</span> 模组不适用于基岩版。
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-[11px]"
            disabled={!dataDir}
            title={dataDir || "尚未检测到基岩版数据目录"}
            onClick={() => dataDir && onOpenFolder(dataDir)}
          >
            <FolderOpen className="size-3.5" />
            打开数据目录
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/55 p-2.5">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索附加包名称、UUID 或文件夹…"
            className="h-8 border-border/70 bg-background/50 pl-8 text-[12px]"
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-background/40 p-0.5">
          <button
            type="button"
            onClick={() => setTypeFilter("all")}
            className={cn(
              "h-7 rounded-md px-2 text-[11px] transition-colors",
              typeFilter === "all"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            全部
            <span className="ml-1 font-mono text-[10px] opacity-70">{packs.length}</span>
          </button>
          {PACK_TYPES.map((info) => (
            <button
              key={info.key}
              type="button"
              onClick={() => setTypeFilter(info.key)}
              className={cn(
                "flex h-7 items-center gap-1 rounded-md px-2 text-[11px] transition-colors",
                typeFilter === info.key
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <info.icon className="size-3" />
              {info.label}
              <span className="font-mono text-[10px] opacity-70">
                {counts.byType.get(info.key) ?? 0}
              </span>
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-[11px]"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5 text-[11px]"
            disabled={importing}
            onClick={() => void importPack()}
          >
            {importing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Import className="size-3.5" />
            )}
            导入附加包
          </Button>
        </div>
      </div>

      {/* Summary + bulk actions */}
      <div className="flex flex-wrap items-center gap-3 px-1">
        <div className="flex items-center gap-2">
          {stats.map((entry) => (
            <span
              key={entry.label}
              className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[10.5px] text-muted-foreground"
            >
              {entry.label}
              <span className="font-mono font-semibold text-foreground">{entry.value}</span>
            </span>
          ))}
          <span className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[10.5px] text-muted-foreground">
            占用
            <span className="font-mono font-semibold text-foreground">
              {formatBytes(counts.size)}
            </span>
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            disabled={busyPath !== null || counts.disabled === 0}
            onClick={() => void bulkToggle(true)}
            className="h-7 rounded-md border border-border/60 px-2 text-[10.5px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:pointer-events-none disabled:opacity-40"
          >
            全部启用
          </button>
          <button
            type="button"
            disabled={busyPath !== null || counts.enabled === 0}
            onClick={() => void bulkToggle(false)}
            className="h-7 rounded-md border border-border/60 px-2 text-[10.5px] text-muted-foreground transition-colors hover:border-amber-400/40 hover:text-amber-300 disabled:pointer-events-none disabled:opacity-40"
          >
            全部停用
          </button>
        </div>
      </div>

      {loading && packs.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-card/40 p-3">
          <div className="flex items-center justify-center gap-2 py-10 text-[11.5px] text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在扫描基岩版附加包目录…
          </div>
        </div>
      ) : packs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-5 py-12 text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/50 text-muted-foreground">
            <Boxes className="size-5" />
          </div>
          <p className="mt-3 text-xs font-medium text-foreground">还没有安装任何基岩版附加包</p>
          <p className="mx-auto mt-1 max-w-sm text-[11px] leading-5 text-muted-foreground">
            导入 <span className="font-mono">.mcpack</span> /{" "}
            <span className="font-mono">.mcaddon</span> 文件，启动器会解包并写入所有已存在的{" "}
            <span className="font-mono">com.mojang</span> 目录。
          </p>
          <Button
            size="sm"
            className="mt-4 h-8 gap-1.5 text-[11px]"
            disabled={importing}
            onClick={() => void importPack()}
          >
            <Import className="size-3.5" />
            导入第一个附加包
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-5 py-12 text-center">
          <p className="text-xs font-medium text-foreground">没有匹配的附加包</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {query ? `换个关键词试试（当前：${query}）` : "当前筛选下没有附加包。"}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4 h-8 gap-1.5 text-[11px]"
            onClick={() => {
              setQuery("");
              setTypeFilter("all");
            }}
          >
            <CircleSlash2 className="size-3.5" />
            清除筛选
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(({ info, items }) => (
            <div
              key={info.key}
              className="overflow-hidden rounded-xl border border-border/70 bg-card/55"
            >
              <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
                <span className={cn("size-1.5 rounded-full", info.dot)} />
                <span className="text-[11px] font-medium text-foreground">{info.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {items.filter((pack) => pack.enabled).length}/{items.length} 已启用
                </span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">
                  {info.folder}
                </span>
              </div>

              <div className="divide-y divide-border/50">
                {items.map((pack) => {
                  const busy = busyPath === pack.path;
                  return (
                    <div
                      key={pack.path}
                      className={cn(
                        "group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/[0.16]",
                        !pack.enabled && "bg-muted/[0.07]",
                      )}
                    >
                      <PackIcon pack={pack} />

                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate text-[12.5px] font-medium text-foreground">
                            {pack.name}
                          </span>
                          {pack.version ? (
                            <span className="rounded border border-border/60 bg-background/50 px-1 py-px font-mono text-[9.5px] text-muted-foreground">
                              v{pack.version}
                            </span>
                          ) : null}
                          {!pack.enabled ? (
                            <span className="rounded border border-amber-400/25 bg-amber-400/10 px-1 py-px text-[9.5px] text-amber-300/90">
                              已停用
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {pack.description || "此附加包没有提供简介"}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground/70">
                          <span className="truncate" title={pack.path}>
                            {pack.folder}
                          </span>
                          <span className="text-muted-foreground/40">•</span>
                          <span>{formatBytes(pack.size)}</span>
                          <span className="text-muted-foreground/40">•</span>
                          <span>{formatDate(pack.modifiedTime)}</span>
                          <span className="text-muted-foreground/40">•</span>
                          <span>{pack.location}</span>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        {busy ? (
                          <LoaderCircle className="size-4 animate-spin text-primary" />
                        ) : (
                          <Switch
                            size="sm"
                            checked={pack.enabled}
                            disabled={busyPath !== null}
                            aria-label={pack.enabled ? "停用附加包" : "启用附加包"}
                            onCheckedChange={() => void togglePack(pack)}
                          />
                        )}
                        <button
                          type="button"
                          title="打开所在文件夹"
                          className="flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
                          onClick={() => onOpenFolder(pack.path)}
                        >
                          <FolderOpen className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          title="删除附加包"
                          disabled={busyPath !== null}
                          className="flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                          onClick={() => setDeleting(pack)}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="flex items-start gap-1.5 px-1 text-[10.5px] leading-4 text-muted-foreground/80">
        <ShieldAlert className="mt-px size-3 shrink-0" />
        停用只会把附加包移动到同目录的 <span className="font-mono">cobble_disabled_packs</span>，
        不会删除文件；切换前请先完全关闭游戏，否则文件可能被占用。
      </p>

      {deleting ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-border/80 bg-card p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
                <Trash2 className="size-4" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">确认删除附加包？</h3>
                <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
                  将从所有已存在的 com.mojang 目录移除
                  <span className="mx-1 font-medium text-foreground">{deleting.name}</span>
                  及其中的贴图与数据，此操作不可撤销。
                </p>
                <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/70">
                  {deleting.path}
                </p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11px]"
                onClick={() => setDeleting(null)}
              >
                取消
              </Button>
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-destructive text-[11px] text-destructive-foreground hover:bg-destructive/90"
                onClick={() => void removePack()}
              >
                <Trash2 className="size-3.5" />
                删除
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
