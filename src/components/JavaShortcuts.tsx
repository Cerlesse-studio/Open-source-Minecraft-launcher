import { Camera, FolderOpen, Layers3, Map as MapIcon, Package } from "lucide-react";
import { joinPath, shortPath } from "../lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface JavaShortcutsProps {
  versionId: string;
  gameRoot: string;
  /** Game directory for this instance (already resolved from the isolation mode). */
  gameDir: string;
  onOpenFolder: (path: string) => void;
}

/**
 * PCL2-style shortcut box.
 *
 * Java instances own several folders that players open all the time; the game
 * directory itself depends on the version isolation mode, so the caller passes
 * the resolved path instead of the component guessing it.
 */
export function JavaShortcuts({
  versionId,
  gameRoot,
  gameDir,
  onOpenFolder,
}: JavaShortcutsProps) {
  const shortcuts = [
    {
      key: "version",
      label: "版本文件夹",
      path: joinPath(gameRoot, "versions", versionId),
      icon: Layers3,
      hint: "游戏核心与版本 JSON",
    },
    {
      key: "saves",
      label: "存档文件夹",
      path: joinPath(gameDir, "saves"),
      icon: MapIcon,
      hint: "世界存档",
    },
    {
      key: "mods",
      label: "Mod 文件夹",
      path: joinPath(gameRoot, "versions", versionId, "mods"),
      icon: Package,
      hint: "本版本已安装模组",
    },
    {
      key: "screenshots",
      label: "截图文件夹",
      path: joinPath(gameDir, "screenshots"),
      icon: Camera,
      hint: "游戏内截图",
    },
  ];

  return (
    <Card className="gap-0 border-border/70 bg-card/55 py-0 shadow-sm">
      <CardHeader className="border-b border-border/60 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-3.5 text-primary" />
            <CardTitle className="text-[13px]">快捷方式</CardTitle>
          </div>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            versions/{versionId}
          </span>
        </div>
      </CardHeader>
      <CardContent className="px-4 py-3.5">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {shortcuts.map((item) => (
            <button
              key={item.key}
              type="button"
              title={item.path}
              onClick={() => onOpenFolder(item.path)}
              className="group flex items-center gap-2.5 rounded-lg border border-border/70 bg-background/40 px-3 py-2.5 text-left transition-colors hover:border-primary/35 hover:bg-primary/[0.06]"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/25 text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:bg-primary/10 group-hover:text-primary">
                <item.icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-foreground">
                  {item.label}
                </span>
                <span
                  className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/70"
                  title={item.path}
                >
                  {shortPath(item.path, 34)}
                </span>
              </span>
            </button>
          ))}
        </div>
        <p className="mt-2.5 text-[10.5px] leading-4 text-muted-foreground/80">
          文件夹不存在时会自动创建；存档与截图的位置跟随「版本隔离」设置。
        </p>
      </CardContent>
    </Card>
  );
}
