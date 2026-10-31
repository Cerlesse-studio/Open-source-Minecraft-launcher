import { useState, useMemo } from "react";
import {
  Palette,
  Star,
  Pencil,
  FileText,
  Sparkles,
  ChevronDown,
  X,
  Check,
  Image as ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { open as openDialog } from "@/lib/desktop";
import { readSkinAsDataUrl } from "../lib/backend";
import { cn } from "cn";
import type { VersionLaunchSettings } from "../lib/versionSettings";

export const VERSION_PRESET_ICONS = [
  { value: "auto", label: "自动", iconSrc: "/icons/minecraft/grass_block.png" },
  { value: "grass_block", label: "草方块", iconSrc: "/icons/minecraft/grass_block.png" },
  { value: "crafting_table", label: "工作台", iconSrc: "/icons/minecraft/crafting_table.png" },
  { value: "furnace", label: "熔炉", iconSrc: "/icons/minecraft/furnace.png" },
  { value: "chest", label: "箱子", iconSrc: "/icons/minecraft/chest.png" },
  { value: "netherite_sword", label: "下界合金剑", iconSrc: "/icons/minecraft/netherite_sword.png" },
  { value: "diamond_pickaxe", label: "钻石镐", iconSrc: "/icons/minecraft/diamond_pickaxe.png" },
  { value: "golden_apple", label: "金苹果", iconSrc: "/icons/minecraft/golden_apple.png" },
  { value: "redstone_dust", label: "红石", iconSrc: "/icons/minecraft/redstone_dust.png" },
  { value: "redstone_repeater", label: "红石中继器", iconSrc: "/icons/minecraft/redstone_repeater.png" },
  { value: "book_and_quill", label: "书与笔", iconSrc: "/icons/minecraft/book_and_quill.png" },
  { value: "totem_of_undying", label: "不死图腾", iconSrc: "/icons/minecraft/totem_of_undying.png" },
  { value: "anvil", label: "铁砧", iconSrc: "/icons/minecraft/anvil.png" },
  { value: "command_block", label: "命令方块", iconSrc: "/icons/minecraft/command_block.png" },
  { value: "bedrock", label: "基岩", iconSrc: "/icons/minecraft/bedrock.png" },
  { value: "cobblestone", label: "圆石", iconSrc: "/icons/minecraft/cobblestone.png" },
  { value: "compass", label: "指南针", iconSrc: "/icons/minecraft/compass.png" },
  { value: "poisonous_potato", label: "毒马铃薯", iconSrc: "/icons/minecraft/poisonous_potato.png" },
  { value: "barrier", label: "屏障", iconSrc: "/icons/minecraft/barrier.png" },
];

export const VERSION_PRESET_CATEGORIES = [
  { value: "auto", label: "自动" },
  { value: "default", label: "默认" },
  { value: "survival", label: "日常生存" },
  { value: "vanilla", label: "纯净原版" },
  { value: "modded", label: "模组整合" },
  { value: "building", label: "建筑 / 光影" },
  { value: "multiplayer", label: "联机专用" },
  { value: "snapshot", label: "快照测试" },
  { value: "legacy", label: "远古版本" },
];

export interface PersonalizationCardProps {
  versionId: string;
  settings: VersionLaunchSettings;
  onChange: (patch: Partial<VersionLaunchSettings>) => void;
  onNotify?: (level: "info" | "success" | "error", title: string, detail?: string) => void;
}

export function PersonalizationCard({
  versionId,
  settings,
  onChange,
  onNotify,
}: PersonalizationCardProps) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameVal, setRenameVal] = useState(settings.customName || "");
  const [descOpen, setDescOpen] = useState(false);
  const [descVal, setDescVal] = useState(settings.description || "");
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [customCategoryInput, setCustomCategoryInput] = useState("");

  const currentIconVal = settings.icon || "auto";
  const currentCategoryVal = settings.category || "auto";
  const isFavorite = Boolean(settings.favorite);

  const matchedIcon = VERSION_PRESET_ICONS.find((i) => i.value === currentIconVal);
  const isCustomIconImage =
    !matchedIcon &&
    (currentIconVal.startsWith("data:") ||
      currentIconVal.includes("\\") ||
      currentIconVal.includes("/"));

  const currentCategoryLabel = useMemo(() => {
    const matched = VERSION_PRESET_CATEGORIES.find((c) => c.value === currentCategoryVal);
    if (matched) return matched.label;
    return currentCategoryVal === "auto" ? "自动" : currentCategoryVal;
  }, [currentCategoryVal]);

  const handlePickLocalImage = async () => {
    try {
      const selected = await openDialog({
        title: "选择版本图标图片",
        filters: [{ name: "图片文件 (*.png;*.jpg;*.jpeg;*.webp;*.ico)", extensions: ["png", "jpg", "jpeg", "webp", "ico"] }],
      });
      if (!selected || typeof selected !== "string") return;
      const dataUrl = await readSkinAsDataUrl(selected);
      onChange({ icon: dataUrl });
      onNotify?.("success", "已更新图标", "已成功更换为本地自定义版本图标");
    } catch (err) {
      onNotify?.("error", "选择图标失败", String(err));
    }
  };

  const handleToggleFavorite = () => {
    const next = !isFavorite;
    onChange({ favorite: next });
    if (next) {
      onNotify?.("success", "已加入收藏夹", `版本 ${settings.customName || versionId} 已加入快捷收藏`);
    } else {
      onNotify?.("info", "已移出收藏夹", `版本 ${settings.customName || versionId} 已从收藏夹移出`);
    }
  };

  const handleSaveRename = () => {
    const trimmed = renameVal.trim();
    onChange({ customName: trimmed });
    setRenameOpen(false);
    onNotify?.("success", "版本名称已更新", trimmed ? `新显示名称为: ${trimmed}` : "已恢复原始版本 ID 名称");
  };

  const handleSaveDesc = () => {
    const trimmed = descVal.trim();
    onChange({ description: trimmed });
    setDescOpen(false);
    onNotify?.("success", "版本描述已保存", "已更新该版本的描述说明信息");
  };

  const handleSaveCustomCategory = () => {
    const trimmed = customCategoryInput.trim();
    if (!trimmed) {
      onChange({ category: "auto" });
    } else {
      onChange({ category: trimmed });
    }
    setCategoryModalOpen(false);
    onNotify?.("success", "分类已修改", `已归类至: ${trimmed || "自动"}`);
  };

  return (
    <>
      <Card className="rounded-xl border border-primary/20 bg-card/65 shadow-xs overflow-hidden">
        <CardHeader className="pb-3 pt-3.5 px-5 border-b border-border/40 bg-primary/5">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold text-primary flex items-center gap-2">
              <Palette className="size-4 text-primary" />
              个性化
            </CardTitle>
            {isFavorite ? (
              <Badge className="h-5 gap-1 border-amber-500/40 bg-amber-500/10 text-amber-500 text-[10px] font-normal">
                <Star className="size-3 fill-current text-amber-500" />
                已收藏
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="p-5 space-y-4">
          {/* 图标选择行 */}
          <div className="grid grid-cols-[56px_1fr] items-center gap-3">
            <Label className="text-xs text-foreground font-medium">图标</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-between border-border/70 bg-background/50 px-3 text-left font-normal text-xs hover:bg-muted/30"
                >
                  <div className="flex items-center gap-2 truncate">
                    {matchedIcon ? (
                      <img
                        src={matchedIcon.iconSrc}
                        alt=""
                        className="size-4 shrink-0 object-contain [image-rendering:pixelated]"
                      />
                    ) : isCustomIconImage ? (
                      <img
                        src={currentIconVal}
                        alt=""
                        className="size-4 shrink-0 rounded object-contain"
                      />
                    ) : (
                      <img
                        src="/icons/minecraft/grass_block.png"
                        alt=""
                        className="size-4 shrink-0 object-contain [image-rendering:pixelated]"
                      />
                    )}
                    <span className="truncate">
                      {matchedIcon ? matchedIcon.label : isCustomIconImage ? "本地自定义图片" : "自动"}
                    </span>
                  </div>
                  <ChevronDown className="size-3.5 shrink-0 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-h-72 overflow-y-auto">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                  选择版本图标
                </DropdownMenuLabel>
                {VERSION_PRESET_ICONS.map((item) => (
                  <DropdownMenuItem
                    key={item.value}
                    className="flex items-center gap-2.5 text-xs py-1.5 cursor-pointer"
                    onSelect={() => onChange({ icon: item.value })}
                  >
                    <img
                      src={item.iconSrc}
                      alt=""
                      className="size-4 object-contain [image-rendering:pixelated]"
                    />
                    <span className="flex-1 truncate">{item.label}</span>
                    {currentIconVal === item.value ? (
                      <Check className="size-3.5 text-primary ml-auto" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="flex items-center gap-2.5 text-xs py-1.5 text-primary cursor-pointer"
                  onSelect={() => void handlePickLocalImage()}
                >
                  <ImageIcon className="size-4" />
                  <span>浏览本地自定义图片…</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* 分类选择行 */}
          <div className="grid grid-cols-[56px_1fr] items-center gap-3">
            <Label className="text-xs text-foreground font-medium">分类</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-between border-border/70 bg-background/50 px-3 text-left font-normal text-xs hover:bg-muted/30"
                >
                  <span className="truncate">{currentCategoryLabel}</span>
                  <ChevronDown className="size-3.5 shrink-0 opacity-50" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                  选择版本分类
                </DropdownMenuLabel>
                {VERSION_PRESET_CATEGORIES.map((c) => (
                  <DropdownMenuItem
                    key={c.value}
                    className="flex items-center justify-between text-xs py-1.5 cursor-pointer"
                    onSelect={() => onChange({ category: c.value })}
                  >
                    <span>{c.label}</span>
                    {currentCategoryVal === c.value ? (
                      <Check className="size-3.5 text-primary" />
                    ) : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="flex items-center gap-2 text-xs py-1.5 text-primary cursor-pointer"
                  onSelect={() => {
                    setCustomCategoryInput(
                      VERSION_PRESET_CATEGORIES.some((c) => c.value === currentCategoryVal)
                        ? ""
                        : currentCategoryVal
                    );
                    setCategoryModalOpen(true);
                  }}
                >
                  <Pencil className="size-3.5" />
                  <span>自定义新分类名称…</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* 三个操作按钮行 */}
          <div className="grid grid-cols-3 gap-2.5 pt-1">
            <Button
              type="button"
              variant="outline"
              className="h-9 w-full text-xs font-normal border-border/80 bg-background/50 hover:bg-muted/40 transition-colors"
              onClick={() => {
                setRenameVal(settings.customName || "");
                setRenameOpen(true);
              }}
            >
              修改版本名
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-9 w-full text-xs font-normal border-border/80 bg-background/50 hover:bg-muted/40 transition-colors"
              onClick={() => {
                setDescVal(settings.description || "");
                setDescOpen(true);
              }}
            >
              修改版本描述
            </Button>
            <Button
              type="button"
              variant={isFavorite ? "secondary" : "outline"}
              className={cn(
                "h-9 w-full text-xs font-normal border-border/80 bg-background/50 hover:bg-muted/40 gap-1.5 transition-colors",
                isFavorite &&
                  "border-amber-500/40 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"
              )}
              onClick={handleToggleFavorite}
            >
              <Star className={cn("size-3.5", isFavorite && "fill-current text-amber-500")} />
              {isFavorite ? "移出收藏夹" : "加入收藏夹"}
            </Button>
          </div>

          {/* 当前个性化详情预览条 */}
          {settings.customName || settings.description ? (
            <div className="rounded-lg border border-border/50 bg-muted/15 p-3 space-y-1 text-xs text-muted-foreground animate-in fade-in-50">
              {settings.customName ? (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground/70 shrink-0">显示别名:</span>
                  <span className="font-semibold text-foreground">{settings.customName}</span>
                </div>
              ) : null}
              {settings.description ? (
                <div className="flex items-start gap-2">
                  <span className="text-[11px] text-muted-foreground/70 shrink-0">版本描述:</span>
                  <span className="text-[11.5px] text-foreground/90 whitespace-pre-wrap leading-relaxed">
                    {settings.description}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 修改版本名弹窗 */}
      {renameOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRenameOpen(false);
          }}
        >
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-border/80 bg-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border/50 pb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Pencil className="size-4 text-primary" />
                修改版本显示名称
              </h3>
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                onClick={() => setRenameOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="rename-input" className="text-xs text-muted-foreground">
                版本显示别名（用于界面显示，原目录名保持不变）
              </Label>
              <Input
                id="rename-input"
                value={renameVal}
                onChange={(e) => setRenameVal(e.target.value)}
                placeholder={`原始 ID: ${versionId}`}
                className="h-9 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveRename();
                }}
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => {
                  setRenameVal("");
                  onChange({ customName: "" });
                  setRenameOpen(false);
                  onNotify?.("info", "已恢复默认名称", "已清除自定义版本显示别名");
                }}
              >
                恢复默认 ID
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setRenameOpen(false)}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleSaveRename}
                >
                  保存
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 修改版本描述弹窗 */}
      {descOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) setDescOpen(false);
          }}
        >
          <div className="w-full max-w-md overflow-hidden rounded-xl border border-border/80 bg-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border/50 pb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <FileText className="size-4 text-primary" />
                修改版本描述
              </h3>
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                onClick={() => setDescOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="desc-input" className="text-xs text-muted-foreground">
                填写该版本的备忘信息、整合包介绍或存档说明
              </Label>
              <textarea
                id="desc-input"
                value={descVal}
                onChange={(e) => setDescVal(e.target.value)}
                placeholder="例如：1.20 极限生电纯净档；配置了钠 + 光影优化模组..."
                rows={4}
                className="w-full rounded-md border border-input bg-background/50 p-2.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
            </div>
            <div className="flex items-center justify-between pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs text-muted-foreground"
                onClick={() => {
                  setDescVal("");
                  onChange({ description: "" });
                  setDescOpen(false);
                  onNotify?.("info", "描述已清空", "已清空该版本的描述信息");
                }}
              >
                清空描述
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setDescOpen(false)}
                >
                  取消
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleSaveDesc}
                >
                  保存
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* 自定义分类弹窗 */}
      {categoryModalOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs animate-in fade-in-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCategoryModalOpen(false);
          }}
        >
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-border/80 bg-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border/50 pb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Sparkles className="size-4 text-primary" />
                自定义分类名称
              </h3>
              <Button
                variant="ghost"
                size="sm"
                className="size-7 p-0"
                onClick={() => setCategoryModalOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="cat-input" className="text-xs text-muted-foreground">
                输入新的版本分类标签（如：生电服务器、生化危机模组）
              </Label>
              <Input
                id="cat-input"
                value={customCategoryInput}
                onChange={(e) => setCustomCategoryInput(e.target.value)}
                placeholder="分类名称 (留空则恢复自动分类)"
                className="h-9 text-xs"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveCustomCategory();
                }}
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setCategoryModalOpen(false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={handleSaveCustomCategory}
              >
                确认
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
