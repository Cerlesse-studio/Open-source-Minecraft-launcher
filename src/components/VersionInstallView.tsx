import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Anvil,
  ArrowLeft,
  Blocks,
  Boxes,
  Check,
  ChevronRight,
  Download,
  Feather,
  Flame,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "cn";
import { getVersionLoaders } from "../lib/backend";
import { formatBytes, formatDate, typeLabel, typeTone } from "../lib/format";
import type {
  InstalledVersion,
  LoaderSelection,
  LoaderVersionItem,
  VersionLoadersCatalog,
  VersionSummary,
} from "../lib/types";
import { TypeBadge } from "./ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

interface VersionInstallViewProps {
  version: VersionSummary;
  installed: InstalledVersion[];
  installingVersion: string | null;
  downloadThreads: number;
  onBack: () => void;
  onConfirmInstall: (versionId: string, selection: LoaderSelection) => void;
}

type AddonSlotId =
  | "forge"
  | "neoforge"
  | "fabric"
  | "fabricApi"
  | "quilt"
  | "optifine";

type ModLoaderKind = "forge" | "neoforge" | "fabric" | "quilt";

const LOADER_NAMES: Record<ModLoaderKind, string> = {
  forge: "Forge",
  neoforge: "NeoForge",
  fabric: "Fabric",
  quilt: "Quilt",
};

function buildSuggestedName(
  mcVersion: string,
  loaderType: ModLoaderKind | null,
  loaderVersion: string | null,
  optifineVersion: string | null,
): string {
  const parts = [mcVersion];
  if (loaderType && loaderVersion) {
    parts.push(`${LOADER_NAMES[loaderType]}_${loaderVersion}`);
  }
  if (optifineVersion) {
    parts.push(`OptiFine_${optifineVersion}`);
  }
  return parts.join("-");
}

function validateFolderName(
  name: string,
  installed: InstalledVersion[],
): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return "文件夹名称不能为空！";
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes(":") ||
    trimmed.includes("*") ||
    trimmed.includes("?") ||
    trimmed.includes('"') ||
    trimmed.includes("<") ||
    trimmed.includes(">") ||
    trimmed.includes("|")
  ) {
    return "文件夹名称包含非法字符！";
  }
  const duplicate = installed.some(
    (entry) => entry.id.toLowerCase() === trimmed.toLowerCase(),
  );
  if (duplicate) {
    return "不可与现有文件夹重名！";
  }
  return null;
}

export function VersionInstallView({
  version,
  installed,
  installingVersion,
  downloadThreads,
  onBack,
  onConfirmInstall,
}: VersionInstallViewProps) {
  const [catalog, setCatalog] = useState<VersionLoadersCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedLoaderType, setSelectedLoaderType] =
    useState<ModLoaderKind | null>(null);
  const [selectedLoaderItem, setSelectedLoaderItem] =
    useState<LoaderVersionItem | null>(null);
  const [selectedOptifine, setSelectedOptifine] =
    useState<LoaderVersionItem | null>(null);
  const [selectedFabricApi, setSelectedFabricApi] =
    useState<LoaderVersionItem | null>(null);

  const [instanceName, setInstanceName] = useState(version.id);
  const [customNameEdited, setCustomNameEdited] = useState(false);
  const [expandedSlot, setExpandedSlot] = useState<AddonSlotId | null>(null);
  const [slotSearch, setSlotSearch] = useState("");

  const fetchCatalog = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getVersionLoaders(version.id);
      setCatalog(data);
    } catch (error) {
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedLoaderType(null);
    setSelectedLoaderItem(null);
    setSelectedOptifine(null);
    setSelectedFabricApi(null);
    setInstanceName(version.id);
    setCustomNameEdited(false);
    setExpandedSlot(null);
    setSlotSearch("");
    void fetchCatalog();
  }, [version.id]);

  const suggestedName = useMemo(
    () =>
      buildSuggestedName(
        version.id,
        selectedLoaderType,
        selectedLoaderItem?.version ?? null,
        selectedOptifine?.version ?? null,
      ),
    [version.id, selectedLoaderType, selectedLoaderItem, selectedOptifine],
  );

  useEffect(() => {
    if (!customNameEdited) {
      setInstanceName(suggestedName);
    }
  }, [suggestedName, customNameEdited]);

  const nameError = useMemo(
    () => validateFolderName(instanceName, installed),
    [instanceName, installed],
  );

  const selectModLoader = (
    kind: ModLoaderKind,
    item: LoaderVersionItem | null,
  ) => {
    if (!item) {
      setSelectedLoaderType(null);
      setSelectedLoaderItem(null);
      setSelectedFabricApi(null);
      return;
    }
    setSelectedLoaderType(kind);
    setSelectedLoaderItem(item);
    // Clear incompatible tools
    if (kind !== "fabric") {
      setSelectedFabricApi(null);
    } else if (!selectedFabricApi && catalog?.fabricApi.length) {
      // Auto-attach latest stable Fabric API if available
      const recommendedApi =
        catalog.fabricApi.find((a) => a.stable) ?? catalog.fabricApi[0];
      if (recommendedApi) {
        setSelectedFabricApi(recommendedApi);
      }
    }
    if (kind !== "forge") {
      setSelectedOptifine(null);
    }
    setExpandedSlot(null);
    setSlotSearch("");
  };

  const handleStartInstall = () => {
    if (nameError || installingVersion) return;
    const selection: LoaderSelection = {
      instanceName: instanceName.trim(),
      loaderType: selectedLoaderType ?? undefined,
      loaderVersion: selectedLoaderItem?.version,
      optifineVersion: selectedOptifine?.version,
      optifineUrl: selectedOptifine?.downloadUrl,
      optifineFilename: selectedOptifine?.fileName,
      fabricApiVersion:
        selectedLoaderType === "fabric"
          ? selectedFabricApi?.version
          : undefined,
      fabricApiUrl:
        selectedLoaderType === "fabric"
          ? selectedFabricApi?.downloadUrl
          : undefined,
      fabricApiFilename:
        selectedLoaderType === "fabric"
          ? selectedFabricApi?.fileName
          : undefined,
    };
    onConfirmInstall(version.id, selection);
  };

  const slots: Array<{
    id: AddonSlotId;
    title: string;
    category: string;
    icon: typeof Anvil;
    items: LoaderVersionItem[];
    selected: LoaderVersionItem | null;
    incompatibleReason: string | null;
    onSelect: (item: LoaderVersionItem | null) => void;
  }> = [
    {
      id: "forge",
      title: "Forge",
      category: "传统模组加载器",
      icon: Anvil,
      items: catalog?.forge ?? [],
      selected: selectedLoaderType === "forge" ? selectedLoaderItem : null,
      incompatibleReason:
        selectedLoaderType && selectedLoaderType !== "forge"
          ? `与 ${LOADER_NAMES[selectedLoaderType]} 不兼容`
          : null,
      onSelect: (item) => selectModLoader("forge", item),
    },
    {
      id: "neoforge",
      title: "NeoForge",
      category: "现代模组加载器",
      icon: Flame,
      items: catalog?.neoforge ?? [],
      selected: selectedLoaderType === "neoforge" ? selectedLoaderItem : null,
      incompatibleReason:
        selectedLoaderType && selectedLoaderType !== "neoforge"
          ? `与 ${LOADER_NAMES[selectedLoaderType]} 不兼容`
          : selectedOptifine
            ? "与 OptiFine 不兼容"
            : null,
      onSelect: (item) => selectModLoader("neoforge", item),
    },
    {
      id: "fabric",
      title: "Fabric",
      category: "轻量模组加载器",
      icon: Feather,
      items: catalog?.fabric ?? [],
      selected: selectedLoaderType === "fabric" ? selectedLoaderItem : null,
      incompatibleReason:
        selectedLoaderType && selectedLoaderType !== "fabric"
          ? `与 ${LOADER_NAMES[selectedLoaderType]} 不兼容`
          : selectedOptifine
            ? "与 OptiFine 不兼容"
            : null,
      onSelect: (item) => selectModLoader("fabric", item),
    },
    {
      id: "optifine",
      title: "OptiFine",
      category: "高清修复与光影工具",
      icon: Sparkles,
      items: catalog?.optifine ?? [],
      selected: selectedOptifine,
      incompatibleReason:
        selectedLoaderType && selectedLoaderType !== "forge"
          ? `与 ${LOADER_NAMES[selectedLoaderType]} 不兼容`
          : null,
      onSelect: (item) => {
        setSelectedOptifine(item);
        setExpandedSlot(null);
        setSlotSearch("");
      },
    },
    {
      id: "quilt",
      title: "Quilt",
      category: "社区分支模组加载器",
      icon: Boxes,
      items: catalog?.quilt ?? [],
      selected: selectedLoaderType === "quilt" ? selectedLoaderItem : null,
      incompatibleReason:
        selectedLoaderType && selectedLoaderType !== "quilt"
          ? `与 ${LOADER_NAMES[selectedLoaderType]} 不兼容`
          : selectedOptifine
            ? "与 OptiFine 不兼容"
            : null,
      onSelect: (item) => selectModLoader("quilt", item),
    },
    {
      id: "fabricApi",
      title: "Fabric API",
      category: "Fabric 核心前置模组",
      icon: Blocks,
      items: catalog?.fabricApi ?? [],
      selected: selectedLoaderType === "fabric" ? selectedFabricApi : null,
      incompatibleReason:
        selectedLoaderType !== "fabric" ? "需要先选择 Fabric" : null,
      onSelect: (item) => {
        setSelectedFabricApi(item);
        setExpandedSlot(null);
        setSlotSearch("");
      },
    },
  ];

  const selectedAddonsSummary = useMemo(() => {
    const tags: string[] = [];
    if (selectedLoaderType && selectedLoaderItem) {
      tags.push(`${LOADER_NAMES[selectedLoaderType]} ${selectedLoaderItem.version}`);
    }
    if (selectedLoaderType === "fabric" && selectedFabricApi) {
      tags.push(`Fabric API ${selectedFabricApi.version}`);
    }
    if (selectedOptifine) {
      tags.push(`OptiFine ${selectedOptifine.version}`);
    }
    return tags;
  }, [
    selectedLoaderType,
    selectedLoaderItem,
    selectedFabricApi,
    selectedOptifine,
  ]);

  return (
    <div className="mx-auto max-w-[920px] space-y-4">
      {/* Top Instance Name & Action Header Card (PCL2/HMCL style matching user screenshot) */}
      <Card className="gap-0 border-primary/25 bg-card/75 p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex items-center gap-3 sm:pt-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-9 shrink-0 rounded-lg border border-border/60 bg-background/40 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              onClick={onBack}
              title="返回版本下载列表"
              aria-label="返回版本下载列表"
            >
              <ArrowLeft className="size-4" />
            </Button>

            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/25 bg-primary/10 p-1">
              <img
                src={
                  version.id.startsWith("bedrock:")
                    ? "/icons/minecraft/bedrock.png"
                    : version.id.includes("april") ||
                        version.id.includes("24w14potato") ||
                        version.id.includes("20w14") ||
                        version.id.includes("22w13one") ||
                        version.id.includes("23w13a") ||
                        version.id.includes("shareware") ||
                        version.id.includes("love_and_hugs") ||
                        version.id.includes("3d_shareware")
                      ? "/icons/minecraft/poisonous_potato.png"
                      : version.type === "snapshot"
                        ? "/icons/minecraft/command_block.png"
                        : version.type === "old_alpha" || version.type === "old_beta"
                          ? "/icons/minecraft/cobblestone.png"
                          : "/icons/minecraft/grass_block.png"
                }
                alt="version icon"
                className="size-7 object-contain [image-rendering:pixelated]"
              />
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <Input
                  value={instanceName}
                  onChange={(event) => {
                    setInstanceName(event.target.value);
                    setCustomNameEdited(true);
                  }}
                  placeholder="输入版本文件夹名称"
                  spellCheck={false}
                  aria-invalid={Boolean(nameError)}
                  className={cn(
                    "h-10 bg-background/65 pr-9 font-mono text-[13px] font-medium transition-colors",
                    nameError
                      ? "border-destructive ring-2 ring-destructive/20 focus-visible:border-destructive focus-visible:ring-destructive/30"
                      : "border-border/80 focus-visible:border-primary",
                  )}
                />
                {customNameEdited && instanceName !== suggestedName ? (
                  <button
                    type="button"
                    onClick={() => {
                      setCustomNameEdited(false);
                      setInstanceName(suggestedName);
                    }}
                    title="恢复推荐名称"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                ) : null}
              </div>

              <Button
                size="sm"
                disabled={Boolean(nameError) || Boolean(installingVersion)}
                onClick={handleStartInstall}
                className="h-10 shrink-0 gap-2 px-5 text-[12.5px] font-medium"
              >
                <Download className="size-4" />
                {selectedAddonsSummary.length > 0 ? "安装组合版本" : "开始安装"}
              </Button>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
              {nameError ? (
                <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-destructive">
                  <AlertCircle className="size-3.5 shrink-0" />
                  {nameError}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>
                    Minecraft{" "}
                    <strong className="font-mono text-foreground">{version.id}</strong>
                  </span>
                  <TypeBadge
                    type={version.type}
                    tone={typeTone(version.type)}
                    label={typeLabel(version.type)}
                  />
                  {version.releaseTime ? (
                    <span>发布于 {formatDate(version.releaseTime)}</span>
                  ) : null}
                  {selectedAddonsSummary.length > 0 ? (
                    <span className="text-primary">
                      · 已选: {selectedAddonsSummary.join(" + ")}
                    </span>
                  ) : (
                    <span>· 纯净原版（可在下方添加模组加载器或工具）</span>
                  )}
                </div>
              )}

              <div className="flex items-center gap-2">
                {(selectedLoaderItem || selectedOptifine || selectedFabricApi) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedLoaderType(null);
                      setSelectedLoaderItem(null);
                      setSelectedOptifine(null);
                      setSelectedFabricApi(null);
                    }}
                    className="flex items-center gap-1 text-[10.5px] text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 className="size-3" />
                    清空已选附加项
                  </button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 gap-1 px-2 text-[10.5px] text-muted-foreground"
                  onClick={() => void fetchCatalog()}
                  disabled={loading}
                >
                  <RefreshCw className={cn("size-3", loading && "animate-spin")} />
                  刷新列表
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {loadError ? (
        <Card className="border-destructive/30 bg-destructive/5 p-3.5 text-[11.5px] text-destructive">
          获取加载器列表失败：{loadError}
        </Card>
      ) : null}

      {/* Expandable Mod Loaders & Tools Stack */}
      <div className="space-y-2.5">
        {slots.map((slot) => {
          const Icon = slot.icon;
          const isExpanded = expandedSlot === slot.id;
          const hasItems = slot.items.length > 0;
          const isBlocked = Boolean(slot.incompatibleReason);
          const canExpand = !loading && hasItems && !isBlocked;

          const filteredItems = slot.items.filter((item) => {
            const q = slotSearch.trim().toLowerCase();
            if (!q) return true;
            return (
              item.version.toLowerCase().includes(q) ||
              (item.subtitle?.toLowerCase().includes(q) ?? false)
            );
          });

          return (
            <Card
              key={slot.id}
              className={cn(
                "gap-0 overflow-hidden border-border/70 bg-card/65 py-0 transition-colors",
                slot.selected && "border-primary/45 bg-primary/[0.03]",
                isExpanded && "border-primary/40",
              )}
            >
              <div
                role={canExpand ? "button" : undefined}
                tabIndex={canExpand ? 0 : -1}
                onClick={() => {
                  if (!canExpand) return;
                  setExpandedSlot((current) =>
                    current === slot.id ? null : slot.id,
                  );
                  setSlotSearch("");
                }}
                onKeyDown={(e) => {
                  if (canExpand && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setExpandedSlot((current) =>
                      current === slot.id ? null : slot.id,
                    );
                    setSlotSearch("");
                  }
                }}
                className={cn(
                  "flex min-h-[54px] items-center gap-4 px-5 py-3.5 transition-colors",
                  canExpand
                    ? "cursor-pointer hover:bg-muted/25"
                    : "cursor-default opacity-85",
                )}
              >
                {/* Left Column: Loader / Tool Name */}
                <div className="flex w-36 shrink-0 items-center gap-2.5 sm:w-44">
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-md border",
                      slot.selected
                        ? "border-primary/35 bg-primary/15 text-primary"
                        : "border-border/70 bg-muted/30 text-muted-foreground",
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <span className="block text-[13px] font-semibold text-foreground">
                      {slot.title}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground/70">
                      {slot.category}
                    </span>
                  </div>
                </div>

                {/* Middle Column: Status Text ("可以添加" / "无" / Selected / Incompatible) */}
                <div className="min-w-0 flex-1">
                  {loading ? (
                    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                      <LoaderCircle className="size-3.5 animate-spin text-primary" />
                      正在查询可用版本…
                    </span>
                  ) : slot.selected ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="h-5 gap-1 border-0 bg-primary/15 px-2 font-mono text-[11px] font-medium text-primary">
                        <Check className="size-3" />
                        {slot.selected.version}
                      </Badge>
                      {slot.selected.subtitle ? (
                        <span className="text-[11px] text-muted-foreground">
                          {slot.selected.subtitle}
                        </span>
                      ) : null}
                    </div>
                  ) : slot.incompatibleReason ? (
                    <span className="text-[12px] text-muted-foreground/60">
                      {slot.incompatibleReason}
                    </span>
                  ) : !hasItems ? (
                    <span className="text-[12px] text-muted-foreground/60">无</span>
                  ) : (
                    <span className="text-[12px] text-muted-foreground">
                      可以添加
                      <span className="ml-2 font-mono text-[10.5px] text-muted-foreground/65">
                        ({slot.items.length} 个版本可用)
                      </span>
                    </span>
                  )}
                </div>

                {/* Right Column: Clear button or Expand Chevron */}
                <div className="flex shrink-0 items-center gap-2">
                  {slot.selected ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-6 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        slot.onSelect(null);
                      }}
                      title={`移除已选的 ${slot.title}`}
                    >
                      <X className="size-3.5" />
                    </Button>
                  ) : null}
                  {canExpand ? (
                    <ChevronRight
                      className={cn(
                        "size-4 text-muted-foreground transition-transform duration-150",
                        isExpanded && "rotate-90 text-foreground",
                      )}
                    />
                  ) : null}
                </div>
              </div>

              {/* Expanded Version Picker Panel */}
              {isExpanded && canExpand ? (
                <div className="border-t border-border/60 bg-background/40 px-5 py-3.5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      选择要安装的 <strong>{slot.title}</strong> 版本（共{" "}
                      {slot.items.length} 个构建）
                    </span>
                    {slot.items.length > 5 ? (
                      <div className="relative w-48">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={slotSearch}
                          onChange={(e) => setSlotSearch(e.target.value)}
                          placeholder="筛选版本号…"
                          className="h-7 bg-card/60 pl-7 pr-6 font-mono text-[11px]"
                        />
                        {slotSearch ? (
                          <button
                            type="button"
                            onClick={() => setSlotSearch("")}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3" />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div className="max-h-64 divide-y divide-border/40 overflow-y-auto rounded-lg border border-border/60 bg-card/55">
                    {filteredItems.length === 0 ? (
                      <div className="py-6 text-center text-[11.5px] text-muted-foreground">
                        没有匹配的构建版本
                      </div>
                    ) : (
                      filteredItems.map((item, idx) => {
                        const isPicked =
                          slot.selected?.version === item.version;
                        return (
                          <button
                            key={item.version}
                            type="button"
                            onClick={() => slot.onSelect(item)}
                            className={cn(
                              "flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/35",
                              isPicked && "bg-primary/10",
                            )}
                          >
                            <div className="flex min-w-0 items-center gap-2.5">
                              <span
                                className={cn(
                                  "flex size-4 shrink-0 items-center justify-center rounded-full border",
                                  isPicked
                                    ? "border-primary bg-primary text-primary-foreground"
                                    : "border-border/80 bg-background/50",
                                )}
                              >
                                {isPicked ? <Check className="size-2.5" /> : null}
                              </span>
                              <span className="font-mono text-[12px] font-medium text-foreground">
                                {item.version}
                              </span>
                              {idx === 0 && item.stable ? (
                                <Badge className="h-4 border-0 bg-primary/15 px-1.5 text-[9.5px] font-normal text-primary">
                                  推荐
                                </Badge>
                              ) : item.stable ? (
                                <Badge
                                  variant="outline"
                                  className="h-4 border-border/80 px-1.5 text-[9.5px] font-normal text-muted-foreground"
                                >
                                  稳定
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="h-4 border-gold/30 bg-gold/10 px-1.5 text-[9.5px] font-normal text-gold"
                                >
                                  测试版
                                </Badge>
                              )}
                              {item.subtitle ? (
                                <span className="truncate text-[10.5px] text-muted-foreground">
                                  {item.subtitle}
                                </span>
                              ) : null}
                            </div>

                            <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
                              {item.size ? (
                                <span>{formatBytes(item.size)}</span>
                              ) : null}
                              {item.releaseTime ? (
                                <span>{formatDate(item.releaseTime)}</span>
                              ) : null}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      {/* Footer Summary Bar */}
      <Card className="flex flex-col items-start justify-between gap-3 border-border/60 bg-card/45 px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Wrench className="size-3.5 text-primary" />
          <span>
            安装将使用多线程下载器（{downloadThreads} 线程）自动拉取原版核心、加载器依赖库与所选附加工具。
          </span>
        </div>
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <Button variant="ghost" size="sm" className="h-8 text-[11.5px]" onClick={onBack}>
            取消返回
          </Button>
          <Button
            size="sm"
            disabled={Boolean(nameError) || Boolean(installingVersion)}
            onClick={handleStartInstall}
            className="h-8 gap-1.5 px-4 text-[11.5px]"
          >
            <Download className="size-3.5" />
            立即安装 {instanceName.trim() || version.id}
          </Button>
        </div>
      </Card>
    </div>
  );
}
