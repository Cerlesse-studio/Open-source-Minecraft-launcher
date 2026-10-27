import { useEffect, useState } from "react";
import {
  Boxes,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Package,
  Power,
  RefreshCw,
  Trash2,
  Upload,
  Wrench,
  X,
  FileCode,
} from "lucide-react";
import { cn } from "cn";
import {
  deleteBedrockMod,
  getBedrockLoaders,
  getBedrockMods,
  installBedrockLoader,
  installBedrockModFile,
  openFolder,
  toggleBedrockMod,
} from "../lib/backend";
import { formatBytes } from "../lib/format";
import type {
  BedrockLoaderItem,
  BedrockLoadersCatalog,
  BedrockModItem,
  BedrockVersionItem,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface BedrockModLoaderModalProps {
  version: BedrockVersionItem;
  gameRoot?: string;
  onClose: () => void;
}

export function BedrockModLoaderModal({
  version,
  gameRoot,
  onClose,
}: BedrockModLoaderModalProps) {
  const [activeTab, setActiveTab] = useState<"loaders" | "mods">("loaders");
  const [catalog, setCatalog] = useState<BedrockLoadersCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [selectedLoaderType, setSelectedLoaderType] = useState<"levilamina" | "amethyst">("levilamina");
  const [selectedLoaderVersion, setSelectedLoaderVersion] = useState<string>("");
  const [installingLoader, setInstallingLoader] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [mods, setMods] = useState<BedrockModItem[]>([]);
  const [loadingMods, setLoadingMods] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [importingMod, setImportingMod] = useState(false);

  // Load loaders catalog
  const loadLoaders = async () => {
    setLoadingCatalog(true);
    try {
      const data = await getBedrockLoaders(version.version || version.id);
      setCatalog(data);
      if (data.levilamina.length > 0 && !selectedLoaderVersion) {
        setSelectedLoaderVersion(data.levilamina[0].version);
      }
    } catch (e) {
      console.error("加载基岩版模组加载器失败", e);
    } finally {
      setLoadingCatalog(false);
    }
  };

  // Load installed mods
  const loadMods = async () => {
    setLoadingMods(true);
    try {
      const list = await getBedrockMods(version.id, gameRoot);
      setMods(list);
    } catch (e) {
      console.error("获取基岩版模组列表失败", e);
    } finally {
      setLoadingMods(false);
    }
  };

  useEffect(() => {
    void loadLoaders();
    void loadMods();
  }, [version.id]);

  const handleInstallLoader = async () => {
    if (!selectedLoaderVersion) return;
    setInstallingLoader(true);
    setStatusMessage(null);
    try {
      const msg = await installBedrockLoader(
        version.id,
        selectedLoaderType,
        selectedLoaderVersion,
        gameRoot,
      );
      setStatusMessage(msg);
      await loadMods();
    } catch (e: any) {
      setStatusMessage(`安装失败: ${e?.message || e}`);
    } finally {
      setInstallingLoader(false);
    }
  };

  const handleToggleMod = async (mod: BedrockModItem) => {
    setTogglingId(mod.id);
    try {
      await toggleBedrockMod(version.id, mod.id, !mod.enabled, gameRoot);
      await loadMods();
    } catch (e: any) {
      alert(`切换模组状态失败: ${e?.message || e}`);
    } finally {
      setTogglingId(null);
    }
  };

  const handleDeleteMod = async (mod: BedrockModItem) => {
    if (!confirm(`确定要删除模组 ${mod.name} 吗？`)) return;
    setDeletingId(mod.id);
    try {
      await deleteBedrockMod(version.id, mod.id, gameRoot);
      await loadMods();
    } catch (e: any) {
      alert(`删除模组失败: ${e?.message || e}`);
    } finally {
      setDeletingId(null);
    }
  };

  const handleOpenModsFolder = async () => {
    const defaultBase = gameRoot || "";
    const p = defaultBase
      ? `${defaultBase}/bedrock/versions/${version.id}/mods`
      : "";
    try {
      await openFolder(p);
    } catch {
      // fallback
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportingMod(true);
    try {
      // For web/mock or if path is available
      const filePath = (file as any).path || file.name;
      const res = await installBedrockModFile(version.id, filePath, gameRoot);
      setStatusMessage(res);
      await loadMods();
    } catch (err: any) {
      alert(`导入模组失败: ${err?.message || err}`);
    } finally {
      setImportingMod(false);
      e.target.value = "";
    }
  };

  const availableLoaders =
    selectedLoaderType === "levilamina"
      ? catalog?.levilamina ?? []
      : catalog?.amethyst ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 animate-in fade-in-0"
    >
      <div className="relative flex flex-col w-full max-w-2xl max-h-[85vh] rounded-xl border border-border/80 bg-card shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60 bg-muted/20">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary border border-primary/30">
              <Boxes className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  基岩版模组加载与加载器
                </h3>
                <Badge
                  variant="outline"
                  className="h-4 border-primary/40 bg-primary/10 text-[9px] font-mono text-primary"
                >
                  BedrockBoot 架构
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                当前实例: <span className="font-mono text-foreground font-medium">{version.name}</span> ({version.id})
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            className="size-7 rounded-lg text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-1 px-5 pt-3 border-b border-border/40 bg-muted/10">
          <button
            type="button"
            onClick={() => setActiveTab("loaders")}
            className={cn(
              "flex items-center gap-1.5 pb-2.5 px-3 text-xs font-medium transition-colors border-b-2",
              activeTab === "loaders"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Wrench className="size-3.5" />
            模组加载器 (Loaders)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("mods")}
            className={cn(
              "flex items-center gap-1.5 pb-2.5 px-3 text-xs font-medium transition-colors border-b-2",
              activeTab === "mods"
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Package className="size-3.5" />
            模组与插件管理 ({mods.length})
          </button>
        </div>

        {/* Status Alert Banner */}
        {statusMessage && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-primary/10 border border-primary/30 text-xs text-primary flex items-center justify-between">
            <span>{statusMessage}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setStatusMessage(null)}
              className="size-5 text-primary hover:bg-primary/20"
            >
              <X className="size-3" />
            </Button>
          </div>
        )}

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {activeTab === "loaders" ? (
            <div className="space-y-4">
              {/* Loader Type Selectors */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedLoaderType("levilamina");
                    if (catalog?.levilamina?.[0]) {
                      setSelectedLoaderVersion(catalog.levilamina[0].version);
                    }
                  }}
                  className={cn(
                    "flex flex-col text-left p-3.5 rounded-xl border transition-all",
                    selectedLoaderType === "levilamina"
                      ? "border-primary/80 bg-primary/10 shadow-sm"
                      : "border-border/60 hover:bg-muted/30",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <Boxes className="size-3.5 text-primary" />
                      LeviLamina
                    </span>
                    <Badge className="h-3.5 text-[8px] bg-success/20 text-success border-0">
                      官方主推
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    原 LiteLoaderBDS，轻量模块化基岩版 C++ 模组加载器，支持动态注入与插件生态。
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setSelectedLoaderType("amethyst");
                    if (catalog?.amethyst?.[0]) {
                      setSelectedLoaderVersion(catalog.amethyst[0].version);
                    }
                  }}
                  className={cn(
                    "flex flex-col text-left p-3.5 rounded-xl border transition-all",
                    selectedLoaderType === "amethyst"
                      ? "border-purple-500/80 bg-purple-500/10 shadow-sm"
                      : "border-border/60 hover:bg-muted/30",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <FileCode className="size-3.5 text-purple-400" />
                      Amethyst
                    </span>
                    <Badge className="h-3.5 text-[8px] bg-purple-500/20 text-purple-400 border-0">
                      客户端专属
                    </Badge>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    原生 C++ 客户端 Mod 注入框架，支持自定义 HUD、缩放视角与按键绑定扩展。
                  </p>
                </button>
              </div>

              {/* Version Selector for chosen loader */}
              <div className="rounded-xl border border-border/60 bg-muted/15 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-foreground">
                      适配 {selectedLoaderType === "levilamina" ? "LeviLamina" : "Amethyst"} 版本
                    </span>
                    {loadingCatalog && <LoaderCircle className="size-3 animate-spin text-muted-foreground" />}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void loadLoaders()}
                    disabled={loadingCatalog}
                    className="size-6 text-muted-foreground hover:text-foreground"
                    title="刷新版本清单"
                  >
                    <RefreshCw className={cn("size-3", loadingCatalog && "animate-spin")} />
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto pr-1">
                  {availableLoaders.map((item: BedrockLoaderItem) => {
                    const isSelected = selectedLoaderVersion === item.version;
                    return (
                      <button
                        key={item.version}
                        type="button"
                        onClick={() => setSelectedLoaderVersion(item.version)}
                        className={cn(
                          "flex items-center justify-between p-2.5 rounded-lg border text-left transition-all",
                          isSelected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border/40 hover:bg-muted/20 text-muted-foreground",
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-xs font-semibold">
                            v{item.version}
                          </span>
                          {item.stable && (
                            <Badge className="h-3.5 text-[8px] border-0 bg-success/20 text-success">
                              推荐稳定
                            </Badge>
                          )}
                          <span className="text-[10px] text-muted-foreground truncate">
                            {item.description}
                          </span>
                        </div>
                        {isSelected && <Check className="size-3.5 text-primary shrink-0" />}
                      </button>
                    );
                  })}
                  {availableLoaders.length === 0 && !loadingCatalog && (
                    <div className="py-6 text-center text-xs text-muted-foreground">
                      暂未查询到此版本特化匹配加载器，可点击上方刷新或选用通用构建。
                    </div>
                  )}
                </div>

                {/* Installation Button */}
                <div className="flex items-center justify-between pt-2 border-t border-border/40">
                  <span className="text-[11px] text-muted-foreground">
                    目标环境: <code className="font-mono text-foreground">bedrock/versions/{version.id}/</code>
                  </span>
                  <Button
                    size="sm"
                    disabled={!selectedLoaderVersion || installingLoader}
                    onClick={() => void handleInstallLoader()}
                    className="h-8 gap-1.5 text-xs"
                  >
                    {installingLoader ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    {installingLoader ? "正在下载并部署..." : `安装 ${selectedLoaderType} v${selectedLoaderVersion}`}
                  </Button>
                </div>
              </div>

              {/* Ecosystem Info Footer */}
              <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/20 border border-border/40 text-[11px] text-muted-foreground">
                <span>基于 BedrockBoot 与 LiteLDev 官方生态构建</span>
                <a
                  href="https://github.com/Round-Studio/BedrockBoot"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Round-Studio/BedrockBoot
                  <ExternalLink className="size-2.5" />
                </a>
              </div>
            </div>
          ) : (
            /* Mods Management Tab */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  共检测到 <span className="font-mono font-medium text-foreground">{mods.length}</span> 个模组/插件
                </span>
                <div className="flex items-center gap-2">
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      accept=".dll,.mcpack,.zip,.mcaddon"
                      className="hidden"
                      onChange={handleImportFile}
                      disabled={importingMod}
                    />
                    <span className="inline-flex items-center gap-1 h-7 px-2.5 rounded-lg border border-border/60 text-xs font-medium hover:bg-muted/30 transition-colors">
                      {importingMod ? (
                        <LoaderCircle className="size-3 animate-spin" />
                      ) : (
                        <Upload className="size-3" />
                      )}
                      导入模组文件
                    </span>
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    onClick={() => void handleOpenModsFolder()}
                  >
                    <FolderOpen className="size-3" />
                    打开模组目录
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7"
                    onClick={() => void loadMods()}
                    disabled={loadingMods}
                  >
                    <RefreshCw className={cn("size-3", loadingMods && "animate-spin")} />
                  </Button>
                </div>
              </div>

              {/* Mods List */}
              <div className="space-y-2">
                {mods.map((mod) => {
                  const isToggling = togglingId === mod.id;
                  const isDeleting = deletingId === mod.id;
                  return (
                    <div
                      key={mod.id}
                      className={cn(
                        "flex items-center justify-between p-3 rounded-xl border transition-all",
                        mod.enabled
                          ? "border-border/80 bg-muted/20"
                          : "border-border/30 bg-muted/5 opacity-60",
                      )}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div
                          className={cn(
                            "flex size-8 shrink-0 items-center justify-center rounded-lg border",
                            mod.modType === "dll_mod"
                              ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-400"
                              : "border-purple-500/30 bg-purple-500/10 text-purple-400",
                          )}
                        >
                          {mod.modType === "dll_mod" ? (
                            <FileCode className="size-4" />
                          ) : (
                            <Package className="size-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground truncate">
                              {mod.name}
                            </span>
                            <Badge
                              variant="outline"
                              className={cn(
                                "h-3.5 text-[8px] font-mono",
                                mod.modType === "dll_mod"
                                  ? "border-cyan-500/40 text-cyan-400"
                                  : "border-purple-500/40 text-purple-400",
                              )}
                            >
                              {mod.modType === "dll_mod" ? "Native DLL" : "LeviLamina 插件"}
                            </Badge>
                            {mod.enabled ? (
                              <Badge className="h-3.5 text-[8px] bg-success/20 text-success border-0">
                                已启用
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="h-3.5 text-[8px] text-muted-foreground border-border/40">
                                已禁用
                              </Badge>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground font-mono">
                            <span>{mod.fileName}</span>
                            <span>•</span>
                            <span>{formatBytes(mod.size)}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 ml-3">
                        <Button
                          variant={mod.enabled ? "default" : "outline"}
                          size="sm"
                          className="h-7 gap-1 text-xs"
                          disabled={isToggling}
                          onClick={() => void handleToggleMod(mod)}
                        >
                          {isToggling ? (
                            <LoaderCircle className="size-3 animate-spin" />
                          ) : (
                            <Power className="size-3" />
                          )}
                          {mod.enabled ? "启用中" : "已停用"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="size-7 text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                          disabled={isDeleting}
                          onClick={() => void handleDeleteMod(mod)}
                          title="删除模组"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}

                {mods.length === 0 && !loadingMods && (
                  <div className="py-12 text-center rounded-xl border border-dashed border-border/60 bg-muted/5 space-y-2">
                    <Package className="size-8 mx-auto text-muted-foreground/50" />
                    <p className="text-xs text-muted-foreground">
                      当前实例暂未安装任何基岩版原生 DLL 模组或 LeviLamina 插件
                    </p>
                    <p className="text-[11px] text-muted-foreground/70">
                      您可以点击右上角“导入模组文件”或将 .dll 模组放入 mods 目录。
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
