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
import { open as openDialog } from "@/lib/desktop";
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
  /**
   * When set, the panel is scoped to one pack kind (the version settings page
   * shows a dedicated 资源包 manager next to the all-kinds add-on manager).
   */
  fixedType?: string;
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
  /** Where the game lets the user switch this kind on. */
  enableHint: string;
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
    // The four kinds share one legend, so each needs its own hue. Green is
    // avoided here: it is the state colour (启用/完成), and a green chip in the
    // theme panel reads as "the launcher is themed green again".
    tint: "border-violet-400/25 bg-violet-400/10 text-violet-300",
    dot: "bg-violet-400",
    enableHint: "启动游戏后在「设置 → 全局资源 → 我的包」中启用。",
  },
  {
    key: "behavior",
    label: "行为包",
    folder: "behavior_packs",
    icon: Wrench,
    tint: "border-sky-400/25 bg-sky-400/10 text-sky-300",
    dot: "bg-sky-400",
    // Behaviour packs never appear in 全局资源 — that screen only lists
    // resource packs, which is why an installed addon can look "not loaded".
    enableHint: "行为包不出现在「全局资源」里：进入某个存档，在「设置 → 行为包」中启用。",
  },
  {
    key: "skin",
    label: "皮肤包",
    folder: "skin_packs",
    icon: UserRound,
    tint: "border-rose-400/25 bg-rose-400/10 text-rose-300",
    dot: "bg-rose-400",
    enableHint: "启动游戏后在「更衣室 → 经典皮肤」中启用。",
  },
  {
    key: "template",
    label: "世界模板",
    folder: "world_templates",
    icon: Boxes,
    tint: "border-amber-400/25 bg-amber-400/10 text-amber-300",
    dot: "bg-amber-400",
    enableHint: "新建世界时从「世界模板」中选择。",
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
      enableHint: "启动游戏后按包类型在对应的管理界面启用。",
    }
  );
}

/** `1.18.3104` / `1.21` -> comparable triple. */
function parseCoreVersion(text?: string | null): [number, number, number] | null {
  if (!text) return null;
  const parts = text.trim().split(/[.\-_ ]/).slice(0, 3);
  const numbers: number[] = [];
  for (const part of parts) {
    const digits = /^\d+/.exec(part)?.[0];
    numbers.push(digits === undefined ? 0 : Number(digits));
  }
  if (numbers.length === 0 || numbers.every((value) => Number.isNaN(value))) return null;
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}

function compareCoreVersion(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Highest core the launcher deployed; packs are shared, so it is the yardstick. */
function newestCoreVersion(status: BedrockStatus | null): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  for (const id of status?.installedVersions ?? []) {
    const parsed = parseCoreVersion(id);
    if (!parsed) continue;
    if (!best || compareCoreVersion(parsed, best) > 0) best = parsed;
  }
  return best;
}

/**
 * Minecraft silently drops packs whose `min_engine_version` is newer than the
 * running core, so an installed pack can look like a failed install.
 */
function engineIsTooNew(
  pack: BedrockPackItem,
  newest: [number, number, number] | null,
): boolean {
  const required = parseCoreVersion(pack.engineVersion);
  return Boolean(required && newest && compareCoreVersion(required, newest) > 0);
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
  fixedType,
  onOpenFolder,
  onNotify,
}: BedrockPackManagerProps) {
  const [packs, setPacks] = useState<BedrockPackItem[]>([]);
  const [status, setStatus] = useState<BedrockStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>(fixedType ?? "all");
  const scopedType = fixedType
    ? (PACK_TYPES.find((entry) => entry.key === fixedType) ?? null)
    : null;
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

  // A scoped panel (资源包 manager) works on one pack kind only: counts, bulk
  // actions and the list itself must not leak the other kinds.
  const scopedPacks = useMemo(
    () => (fixedType ? packs.filter((pack) => pack.packType === fixedType) : packs),
    [packs, fixedType],
  );

  const counts = useMemo(() => {
    const byType = new Map<string, number>();
    let enabled = 0;
    let size = 0;
    for (const pack of scopedPacks) {
      byType.set(pack.packType, (byType.get(pack.packType) ?? 0) + 1);
      if (pack.enabled) enabled += 1;
      size += pack.size;
    }
    return { byType, enabled, disabled: scopedPacks.length - enabled, size };
  }, [scopedPacks]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scopedPacks.filter((pack) => {
      if (typeFilter !== "all" && pack.packType !== typeFilter) return false;
      if (!needle) return true;
      return (
        pack.name.toLowerCase().includes(needle) ||
        pack.folder.toLowerCase().includes(needle) ||
        pack.description.toLowerCase().includes(needle) ||
        pack.id.toLowerCase().includes(needle)
      );
    });
  }, [scopedPacks, query, typeFilter]);

  const groups = useMemo(
    () =>
      PACK_TYPES.filter((info) => !fixedType || info.key === fixedType)
        .map((info) => ({
          info,
          items: visible.filter((pack) => pack.packType === info.key),
        }))
        .filter((group) => group.items.length > 0),
    [visible, fixedType],
  );

  const dataDir =
    status?.portablePath || status?.comMojangPath || "";

  const newestCore = useMemo(() => newestCoreVersion(status), [status]);
  const tooNew = useMemo(
    () => visible.filter((pack) => engineIsTooNew(pack, newestCore)),
    [visible, newestCore],
  );

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
      const targets = scopedPacks.filter((pack) => pack.enabled !== enabled);
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
    [gameRoot, load, onNotify, scopedPacks],
  );

  const stats = [
    { label: "全部", value: scopedPacks.length },
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
                {scopedType ? `基岩版${scopedType.label}管理器` : "基岩版附加包管理器"}
                <Badge className="ml-2 h-4 border-0 bg-primary/20 px-1.5 text-[9px] font-normal text-primary">
                  {scopedType ? scopedType.folder : ".mcpack / .mcaddon"}
                </Badge>
              </p>
              <p className="mt-0.5 max-w-xl text-[11px] leading-5 text-muted-foreground">
                {scopedType
                  ? `只显示 ${scopedType.label}，存放在 com.mojang/${scopedType.folder}；启用状态通过目录切换，游戏启动时读取。${scopedType.enableHint}`
                  : "资源包、行为包与皮肤包直接写入 com.mojang。资源包在「设置 → 全局资源 → 我的包」启用；行为包只对单个存档生效，需进入存档后在「设置 → 行为包」启用；皮肤包在更衣室启用。附加包由所有基岩版实例共用，不按版本隔离，Java 的 .jar 模组不适用于基岩版。"}
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

      {/* A pack newer than the installed core is invisible in game; say why. */}
      {tooNew.length > 0 ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-3">
          <ShieldAlert className="mt-px size-4 shrink-0 text-amber-300" />
          <div className="min-w-0 text-[11px] leading-5 text-amber-100/85">
            <p className="font-semibold text-amber-200">
              {tooNew.length} 个附加包要求的引擎版本高于当前核心，游戏会直接忽略它们
            </p>
            <p className="mt-0.5 text-amber-100/75">
              {tooNew
                .slice(0, 4)
                .map((pack) => `${pack.name}（需 ${pack.engineVersion}）`)
                .join("、")}
              {tooNew.length > 4 ? ` 等 ${tooNew.length} 个` : ""}
              。当前最高核心为{" "}
              <span className="font-mono">{newestCore?.join(".")}</span>，请先下载{" "}
              <span className="font-mono">{tooNew[0]?.engineVersion}</span>{" "}
              或更新版本的核心再启动游戏。
            </p>
          </div>
        </div>
      ) : null}

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

        {scopedType ? (
          <span className="flex h-8 items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/10 px-2.5 text-[11px] text-primary">
            <scopedType.icon className="size-3" />
            {scopedType.label}
            <span className="font-mono text-[10px] opacity-70">{scopedPacks.length}</span>
          </span>
        ) : (
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
        )}

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

      {loading && scopedPacks.length === 0 ? (
        <div className="rounded-xl border border-border/70 bg-card/40 p-3">
          <div className="flex items-center justify-center gap-2 py-10 text-[11.5px] text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在扫描基岩版附加包目录…
          </div>
        </div>
      ) : scopedPacks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-5 py-12 text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/50 text-muted-foreground">
            <Boxes className="size-5" />
          </div>
          <p className="mt-3 text-xs font-medium text-foreground">
            {scopedType
              ? `还没有安装任何基岩版${scopedType.label}`
              : "还没有安装任何基岩版附加包"}
          </p>
          <p className="mx-auto mt-1 max-w-sm text-[11px] leading-5 text-muted-foreground">
            导入 <span className="font-mono">.mcpack</span> /{" "}
            <span className="font-mono">.mcaddon</span> 文件，启动器会解包并写入所有已存在的{" "}
            <span className="font-mono">com.mojang</span> 目录
            {scopedType ? `，${scopedType.label}会进入 ${scopedType.folder}` : ""}。
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
              setTypeFilter(fixedType ?? "all");
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
                          {pack.engineVersion ? (
                            <span
                              title={`要求 Minecraft ${pack.engineVersion} 或更高`}
                              className={cn(
                                "rounded border px-1 py-px font-mono text-[9.5px]",
                                engineIsTooNew(pack, newestCore)
                                  ? "border-amber-400/35 bg-amber-400/10 text-amber-300"
                                  : "border-border/60 bg-background/50 text-muted-foreground",
                              )}
                            >
                              ≥ {pack.engineVersion}
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
