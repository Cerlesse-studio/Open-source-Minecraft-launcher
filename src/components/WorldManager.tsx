import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CircleSlash2,
  FolderInput,
  FolderOpen,
  Import,
  LoaderCircle,
  Map as MapIcon,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { open as openDialog } from "@/lib/desktop";
import { cn } from "cn";
import {
  deleteBedrockWorld,
  deleteJavaWorld,
  getBedrockWorlds,
  getJavaWorlds,
  importBedrockWorldFile,
  installJavaWorldFile,
  isDesktop,
} from "../lib/backend";
import type { JavaWorldItem } from "../lib/types";
import { formatBytes, formatDate, joinPath } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Shared row shape: Java and Bedrock expose the same save concepts. */
interface WorldRow {
  id: string;
  name: string;
  folder: string;
  path: string;
  size: number;
  modifiedTime: string;
  icon?: string | null;
  /** Bedrock only: which com.mojang folder this copy lives in. */
  location?: string;
  locationPath?: string;
}

interface WorldManagerProps {
  edition: "java" | "bedrock";
  versionId: string;
  gameRoot: string;
  /** Resolved Java game directory, used for the empty-state folder hint. */
  gameDir?: string;
  isolation?: string;
  onOpenFolder: (path: string) => void;
  onNotify?: (
    level: "info" | "success" | "error",
    title: string,
    detail?: string,
  ) => void;
}

function WorldIcon({ row }: { row: WorldRow }) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(row.icon) && !failed;

  useEffect(() => {
    setFailed(false);
  }, [row.icon]);

  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-amber-400/25 bg-amber-400/10 text-amber-300">
      {showImage ? (
        <img
          src={row.icon ?? ""}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover [image-rendering:pixelated]"
          onError={() => setFailed(true)}
        />
      ) : (
        <MapIcon className="size-4.5" />
      )}
    </div>
  );
}

function toRow(world: JavaWorldItem): WorldRow {
  return { ...world, icon: world.iconDataUrl };
}

export function WorldManager({
  edition,
  versionId,
  gameRoot,
  gameDir,
  isolation,
  onOpenFolder,
  onNotify,
}: WorldManagerProps) {
  const isBedrock = edition === "bedrock";
  const [worlds, setWorlds] = useState<WorldRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState<WorldRow | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  const savesDir = isBedrock ? "" : joinPath(gameDir ?? gameRoot, "saves");

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        if (isBedrock) {
          const rows = await getBedrockWorlds(gameRoot);
          setWorlds(rows.map((world) => ({ ...world })));
        } else {
          setWorlds((await getJavaWorlds(versionId, isolation, gameRoot)).map(toRow));
        }
      } catch (error) {
        onNotify?.("error", "读取存档列表失败", String(error));
      } finally {
        setLoading(false);
      }
    },
    [isBedrock, versionId, isolation, gameRoot, onNotify],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const totalSize = useMemo(
    () => worlds.reduce((sum, world) => sum + world.size, 0),
    [worlds],
  );

  // Bedrock has no single "saves" folder: every com.mojang directory owns one.
  const bedrockWorldsDir = useMemo(() => {
    const dataDir = worlds[0]?.locationPath ?? "";
    return dataDir ? joinPath(dataDir, "minecraftWorlds") : "";
  }, [worlds]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return worlds;
    return worlds.filter(
      (world) =>
        world.name.toLowerCase().includes(needle) ||
        world.folder.toLowerCase().includes(needle),
    );
  }, [worlds, query]);

  const importFile = useCallback(async () => {
    if (!isDesktop) {
      onNotify?.("info", "浏览器预览无法读取本地文件", "请在桌面应用中使用导入功能。");
      return;
    }
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        filters: isBedrock
          ? [{ name: "基岩版世界", extensions: ["mcworld", "zip"] }]
          : [{ name: "Java 存档", extensions: ["zip"] }],
      });
      if (typeof picked !== "string") return;
      setImporting(true);
      if (isBedrock) {
        const result = await importBedrockWorldFile(picked, gameRoot);
        onNotify?.("success", "存档导入完成", result.message);
      } else {
        const message = await installJavaWorldFile(
          versionId,
          picked,
          isolation,
          gameRoot,
        );
        onNotify?.("success", "存档导入完成", message);
      }
      await load(true);
    } catch (error) {
      onNotify?.("error", "导入存档失败", String(error));
    } finally {
      setImporting(false);
    }
  }, [isBedrock, versionId, isolation, gameRoot, load, onNotify]);

  const importFolder = useCallback(async () => {
    if (!isDesktop) return;
    try {
      const picked = await openDialog({ multiple: false, directory: true });
      if (typeof picked !== "string") return;
      setImporting(true);
      const message = await installJavaWorldFile(
        versionId,
        picked,
        isolation,
        gameRoot,
      );
      onNotify?.("success", "存档导入完成", message);
      await load(true);
    } catch (error) {
      onNotify?.("error", "导入存档失败", String(error));
    } finally {
      setImporting(false);
    }
  }, [versionId, isolation, gameRoot, load, onNotify]);

  const removeWorld = useCallback(async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    setBusyPath(target.path);
    try {
      if (isBedrock) {
        await deleteBedrockWorld(target.path, gameRoot);
      } else {
        await deleteJavaWorld(versionId, target.folder, isolation, gameRoot);
      }
      onNotify?.("success", "存档已删除", target.name);
      await load(true);
    } catch (error) {
      onNotify?.("error", "删除存档失败", String(error));
    } finally {
      setBusyPath(null);
    }
  }, [deleting, isBedrock, versionId, isolation, gameRoot, load, onNotify]);

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-xl border border-gold/25 bg-gradient-to-r from-gold/12 via-gold/5 to-transparent px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-gold/30 bg-gold/10 text-gold">
              <MapIcon className="size-4.5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">
                地图管理器
                <Badge
                  variant="outline"
                  className="ml-2 h-4 border-gold/30 bg-gold/10 px-1.5 font-mono text-[9px] font-normal text-gold"
                >
                  {isBedrock ? "minecraftWorlds" : "saves"}
                </Badge>
              </p>
              <p className="mt-0.5 max-w-xl text-[11px] leading-5 text-muted-foreground">
                {isBedrock
                  ? "列出所有 com.mojang 目录中的世界，显示世界名称、图标、占用与所在目录；导入 .mcworld 会写入每个已存在的游戏数据目录。"
                  : "直接管理当前版本存档目录中的世界，可导入 .zip / 文件夹、打开存档文件夹或整份删除（含维度与玩家数据）。"}
              </p>
            </div>
          </div>
          {isBedrock ? (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-[11px]"
              disabled={!bedrockWorldsDir}
              title={bedrockWorldsDir || "尚未检测到基岩版数据目录"}
              onClick={() => bedrockWorldsDir && onOpenFolder(bedrockWorldsDir)}
            >
              <FolderOpen className="size-3.5" />
              打开存档目录
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-[11px]"
              title={savesDir}
              onClick={() => onOpenFolder(savesDir)}
            >
              <FolderOpen className="size-3.5" />
              打开存档目录
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-card/55 p-2.5">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索存档名称或文件夹…"
            className="h-8 border-border/70 bg-background/50 pl-8 text-[12px]"
          />
        </div>

        <span className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[10.5px] text-muted-foreground">
          共
          <span className="font-mono font-semibold text-foreground">{worlds.length}</span>
          个世界
        </span>
        <span className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-[10.5px] text-muted-foreground">
          占用
          <span className="font-mono font-semibold text-foreground">
            {formatBytes(totalSize)}
          </span>
        </span>

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
          {isBedrock ? null : (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-[11px]"
              disabled={importing}
              onClick={() => void importFolder()}
            >
              <FolderInput className="size-3.5" />
              文件夹
            </Button>
          )}
          <Button
            size="sm"
            className="h-8 gap-1.5 text-[11px]"
            disabled={importing}
            onClick={() => void importFile()}
          >
            {importing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Import className="size-3.5" />
            )}
            导入存档
          </Button>
        </div>
      </div>

      {loading && worlds.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-border/70 bg-card/40 py-14 text-[11.5px] text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          正在扫描存档目录…
        </div>
      ) : worlds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-5 py-12 text-center">
          <div className="mx-auto flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/50 text-muted-foreground">
            <MapIcon className="size-5" />
          </div>
          <p className="mt-3 text-xs font-medium text-foreground">还没有任何存档</p>
          <p className="mx-auto mt-1 max-w-sm text-[11px] leading-5 text-muted-foreground">
            {isBedrock
              ? "导入 .mcworld 世界存档，或启动游戏创建一个新的世界。"
              : "启动游戏创建世界，或导入 .zip 存档 / 存档文件夹。"}
          </p>
          <Button
            size="sm"
            className="mt-4 h-8 gap-1.5 text-[11px]"
            disabled={importing}
            onClick={() => void importFile()}
          >
            <Import className="size-3.5" />
            导入第一个存档
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/30 px-5 py-12 text-center">
          <p className="text-xs font-medium text-foreground">没有匹配的存档</p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {query ? `换个关键词试试（当前：${query}）` : "当前筛选下没有存档。"}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-4 h-8 gap-1.5 text-[11px]"
            onClick={() => setQuery("")}
          >
            <CircleSlash2 className="size-3.5" />
            清除筛选
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/70 bg-card/55">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <span className="size-1.5 rounded-full bg-amber-400" />
            <span className="text-[11px] font-medium text-foreground">
              {isBedrock ? "世界存档" : "存档"}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {visible.length}/{worlds.length}
            </span>
            <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground/70">
              {isBedrock ? "com.mojang/minecraftWorlds" : "saves"}
            </span>
          </div>

          <div className="divide-y divide-border/50">
            {visible.map((world) => {
              const busy = busyPath === world.path;
              return (
                <div
                  key={world.path || world.id}
                  className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/[0.16]"
                >
                  <WorldIcon row={world} />

                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-foreground">
                        {world.name}
                      </span>
                      {world.location ? (
                        <span className="rounded border border-border/60 bg-background/50 px-1 py-px text-[9.5px] text-muted-foreground">
                          {world.location}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground/70">
                      <span className="truncate" title={world.path}>
                        {world.folder}
                      </span>
                      <span className="text-muted-foreground/40">•</span>
                      <span>{formatBytes(world.size)}</span>
                      <span className="text-muted-foreground/40">•</span>
                      <span>{formatDate(world.modifiedTime)}</span>
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {busy ? (
                      <LoaderCircle className="size-4 animate-spin text-primary" />
                    ) : null}
                    <button
                      type="button"
                      title="打开存档文件夹"
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted/40 hover:text-foreground"
                      onClick={() => onOpenFolder(world.path)}
                    >
                      <FolderOpen className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="删除存档"
                      disabled={busyPath !== null}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                      onClick={() => setDeleting(world)}
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
        {isBedrock
          ? "存档与附加包共用 com.mojang；导入会写入所有已存在的数据目录，删除也会移除这些副本。操作前请完全关闭游戏。"
          : "存档目录随「版本隔离」设置变化；删除会连同维度文件与玩家数据一起移除，且无法撤销。"}
      </p>

      {deleting ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-xl border border-border/80 bg-card p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-destructive/30 bg-destructive/10 text-destructive">
                <Trash2 className="size-4" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground">确认删除存档？</h3>
                <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
                  将从磁盘移除
                  <span className="mx-1 font-medium text-foreground">{deleting.name}</span>
                  及其中的全部世界数据
                  {isBedrock ? "（包括其他数据目录中的副本）" : ""}，此操作不可撤销。
                </p>
                <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/70">
                  {deleting.path || deleting.folder}
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
                onClick={() => void removeWorld()}
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
