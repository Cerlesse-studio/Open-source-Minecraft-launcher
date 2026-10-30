import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleSlash2,
  FolderOpen,
  Import,
  LoaderCircle,
  Paintbrush,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { open as openDialog } from "@/lib/desktop";
import { cn } from "cn";
import {
  deleteJavaResourcePack,
  getJavaResourcePacks,
  installJavaResourcePackFile,
  isDesktop,
  toggleJavaResourcePack,
} from "../lib/backend";
import type { JavaPackItem } from "../lib/types";
import { formatBytes, formatDate, joinPath } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface JavaPackManagerProps {
  versionId: string;
  gameRoot: string;
  /** Resolved game directory, used for the folder hint and the empty state. */
  gameDir: string;
  isolation?: string;
  onOpenFolder: (path: string) => void;
  onNotify?: (
    level: "info" | "success" | "error",
    title: string,
    detail?: string,
  ) => void;
}

function PackIcon({ pack }: { pack: JavaPackItem }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(pack.iconDataUrl) && !failed;

  useEffect(() => {
    setFailed(false);
  }, [pack.iconDataUrl]);

  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border transition-opacity",
        pack.enabled
          ? "border-success/25 bg-success/10 text-success"
          : "border-border/60 bg-muted/25 text-muted-foreground",
      )}
    >
      {showImage ? (
        <img
          src={pack.iconDataUrl ?? ""}
          alt=""
          loading="lazy"
          decoding="async"
          className={cn(
            "size-full object-cover [image-rendering:pixelated]",
            !pack.enabled && "opacity-55 saturate-50",
          )}
          onError={() => setFailed(true)}
        />
      ) : (
        <Paintbrush className="size-4.5" />
      )}
    </div>
  );
}

export function JavaPackManager({
  versionId,
  gameRoot,
  gameDir,
  isolation,
  onOpenFolder,
  onNotify,
}: JavaPackManagerProps) {
  const [packs, setPacks] = useState<JavaPackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<JavaPackItem | null>(null);

  const packsDir = joinPath(gameDir, "resourcepacks");

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        setPacks(await getJavaResourcePacks(versionId, isolation, gameRoot));
      } catch (error) {
        onNotify?.("error", "读取资源包失败", String(error));
      } finally {
        setLoading(false);
      }
    },
    [versionId, isolation, gameRoot, onNotify],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    let enabled = 0;
    let size = 0;
    for (const pack of packs) {
      if (pack.enabled) enabled += 1;
      size += pack.size;
    }
    return { enabled, disabled: packs.length - enabled, size };
  }, [packs]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return packs.filter((pack) => {
      if (statusFilter === "enabled" && !pack.enabled) return false;
      if (statusFilter === "disabled" && pack.enabled) return false;
      if (!needle) return true;
      return (
        pack.name.toLowerCase().includes(needle) ||
        pack.fileName.toLowerCase().includes(needle) ||
        pack.description.toLowerCase().includes(needle)
      );
    });
  }, [packs, query, statusFilter]);

  const togglePack = useCallback(
    async (pack: JavaPackItem) => {
      setBusyFile(pack.fileName);
      // The switch should answer the click immediately; the reload confirms
      // what options.txt really contains.
      setPacks((current) =>
        current.map((entry) =>
          entry.fileName === pack.fileName
            ? { ...entry, enabled: !entry.enabled }
            : entry,
        ),
      );
      try {
        await toggleJavaResourcePack(
          versionId,
          pack.fileName,
          !pack.enabled,
          isolation,
          gameRoot,
        );
        onNotify?.(
          "success",
          pack.enabled ? "已停用资源包" : "已启用资源包",
          `${pack.name} · 重启游戏后生效`,
        );
        await load(true);
      } catch (error) {
        setPacks((current) =>
          current.map((entry) =>
            entry.fileName === pack.fileName
              ? { ...entry, enabled: pack.enabled }
              : entry,
          ),
        );
        onNotify?.("error", "切换资源包状态失败", String(error));
      } finally {
        setBusyFile(null);
      }
    },
    [versionId, isolation, gameRoot, load, onNotify],
  );

  const bulkToggle = useCallback(
    async (enabled: boolean) => {
      const targets = packs.filter((pack) => pack.enabled !== enabled);
      if (targets.length === 0) return;
      setBusyFile("__bulk__");
      try {
        for (const pack of targets) {
          await toggleJavaResourcePack(
            versionId,
            pack.fileName,
            enabled,
            isolation,
            gameRoot,
          );
        }
        onNotify?.(
          "success",
          enabled ? "已启用全部资源包" : "已停用全部资源包",
          `共处理 ${targets.length} 个资源包，重启游戏后生效`,
        );
        await load(true);
      } catch (error) {
        onNotify?.("error", "批量操作失败", String(error));
        await load(true);
      } finally {
        setBusyFile(null);
      }
    },
    [packs, versionId, isolation, gameRoot, load, onNotify],
  );

  const removePack = useCallback(async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    setBusyFile(target.fileName);
    try {
      await deleteJavaResourcePack(versionId, target.fileName, isolation, gameRoot);
      onNotify?.("success", "资源包已删除", target.name);
      await load(true);
    } catch (error) {
      onNotify?.("error", "删除资源包失败", String(error));
    } finally {
      setBusyFile(null);
    }
  }, [deleting, versionId, isolation, gameRoot, load, onNotify]);

  const importPack = useCallback(async () => {
    if (!isDesktop) {
      onNotify?.("info", "浏览器预览无法读取本地文件", "请在桌面应用中使用导入功能。");
      return;
    }
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "资源包", extensions: ["zip"] }],
      });
      if (typeof picked !== "string") return;
      setImporting(true);
      const message = await installJavaResourcePackFile(
        versionId,
        picked,
        isolation,
        gameRoot,
      );
      onNotify?.("success", "资源包导入完成", message);
      await load(true);
    } catch (error) {
      onNotify?.("error", "导入资源包失败", String(error));
    } finally {
      setImporting(false);
    }
  }, [versionId, isolation, gameRoot, load, onNotify]);

  const stats = [
    { label: "全部", value: packs.length },
    { label: "已启用", value: counts.enabled },
    { label: "已停用", value: counts.disabled },
  ];

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-r from-primary/12 via-primary/5 to-transparent px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
              <Paintbrush className="size-4.5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">
                资源包管理器
                <Badge className="ml-2 h-4 border-0 bg-primary/20 px-1.5 text-[9px] font-normal text-primary">
                  resourcepacks
                </Badge>
              </p>
              <p className="mt-0.5 max-w-xl text-[11px] leading-5 text-muted-foreground">
                开关状态直接写入 <span className="font-mono">options.txt</span> 的{" "}
                <span className="font-mono">resourcePacks</span> 列表，与游戏内
                「选项 → 资源包」保持一致；导入的包会放进{" "}
                <span className="font-mono">resourcepacks</span>。
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-[11px]"
            title={packsDir}
            onClick={() => onOpenFolder(packsDir)}
          >
            <FolderOpen className="size-3.5" />
            打开文件夹
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/55 p-2.5">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索资源包名称或文件名…"
            className="h-8 border-border/70 bg-background/50 pl-8 text-[12px]"
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-background/40 p-0.5">
          {(
            [
              { key: "all", label: "全部" },
              { key: "enabled", label: "已启用" },
              { key: "disabled", label: "已停用" },
            ] as const
          ).map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setStatusFilter(entry.key)}
              className={cn(
                "h-7 rounded-md px-2 text-[11px] transition-colors",
                statusFilter === entry.key
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
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
            导入资源包
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 px-1">
        <div className="flex flex-wrap items-center gap-2">
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
            disabled={busyFile !== null || counts.disabled === 0}
            onClick={() => void bulkToggle(true)}
            className="h-7 rounded-md border border-border/60 px-2 text-[10.5px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary disabled:pointer-events-none disabled:opacity-40"
          >
            全部启用
          </button>
          <button
            type="button"
            disabled={busyFile !== null || counts.enabled === 0}
            onClick={() => void bulkToggle(false)}
            className="h-7 rounded-md border border-border/60 px-2 text-[10.5px] text-muted-foreground transition-colors hover:border-amber-400/40 hover:text-amber-300 disabled:pointer-events-none disabled:opacity-40"
          >
            全部停用
          </button>
        </div>
      </div>

      {loading && packs.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/40 py-14 text-[11.5px] text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在扫描资源包目录…
        </div>
      ) : packs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-5 py-12 text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/50 text-muted-foreground">
            <Paintbrush className="size-5" />
          </div>
          <p className="mt-3 text-xs font-medium text-foreground">这个版本还没有资源包</p>
          <p className="mx-auto mt-1 max-w-sm text-[11px] leading-5 text-muted-foreground">
            导入 <span className="font-mono">.zip</span> 资源包，启动器会放进{" "}
            <span className="font-mono" title={packsDir}>
              resourcepacks
            </span>
            ，启用状态写入 <span className="font-mono">options.txt</span>。
          </p>
          <Button
            size="sm"
            className="mt-4 h-8 gap-1.5 text-[11px]"
            disabled={importing}
            onClick={() => void importPack()}
          >
            <Import className="size-3.5" />
            导入第一个资源包
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-5 py-12 text-center">
          <p className="text-xs font-medium text-foreground">没有匹配的资源包</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {query ? `换个关键词试试（当前：${query}）` : "当前筛选下没有资源包。"}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4 h-8 gap-1.5 text-[11px]"
            onClick={() => {
              setQuery("");
              setStatusFilter("all");
            }}
          >
            <CircleSlash2 className="size-3.5" />
            清除筛选
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card/55">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <span className="size-1.5 rounded-full bg-success" />
            <span className="text-[11px] font-medium text-foreground">资源包</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {counts.enabled}/{packs.length} 已启用
            </span>
            <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground/70">
              resourcepacks
            </span>
          </div>
          <div className="divide-y divide-border/50">
            {visible.map((pack) => {
              const busy = busyFile === pack.fileName;
              return (
                <div
                  key={pack.fileName}
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
                      {pack.packFormat ? (
                        <span className="rounded border border-border/60 bg-background/50 px-1 py-px font-mono text-[9.5px] text-muted-foreground">
                          format {pack.packFormat}
                        </span>
                      ) : null}
                      {!pack.enabled ? (
                        <span className="rounded border border-amber-400/25 bg-amber-400/10 px-1 py-px text-[9.5px] text-amber-300/90">
                          已停用
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {pack.description || "此资源包没有提供简介"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground/70">
                      <span className="truncate" title={pack.path}>
                        {pack.fileName}
                      </span>
                      <span className="text-muted-foreground/40">•</span>
                      <span>{formatBytes(pack.size)}</span>
                      <span className="text-muted-foreground/40">•</span>
                      <span>{formatDate(pack.modifiedTime)}</span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {busy ? (
                      <LoaderCircle className="size-4 animate-spin text-primary" />
                    ) : (
                      <Switch
                        size="sm"
                        checked={pack.enabled}
                        disabled={busyFile !== null}
                        aria-label={pack.enabled ? "停用资源包" : "启用资源包"}
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
                      title="删除资源包"
                      disabled={busyFile !== null}
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
      )}

      <p className="flex items-start gap-1.5 px-1 text-[10.5px] leading-4 text-muted-foreground/80">
        <ShieldAlert className="mt-px size-3 shrink-0" />
        切换资源包只修改 <span className="font-mono">options.txt</span>，不会移动或删除包文件；
        建议先退出游戏再修改，否则游戏关闭时会用内存中的旧列表覆盖。
      </p>

      {deleting ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-border/80 bg-card p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
                <Trash2 className="size-4" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">确认删除资源包？</h3>
                <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
                  将删除
                  <span className="mx-1 font-medium text-foreground">{deleting.name}</span>
                  及其中的贴图文件，此操作不可撤销。
                </p>
                <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/70">
                  {deleting.path || deleting.fileName}
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
