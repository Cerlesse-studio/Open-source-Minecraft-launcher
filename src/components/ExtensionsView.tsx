import { useEffect, useState, useRef } from "react";
import {
  Puzzle,
  Download,
  Sparkles,
  RefreshCw,
  FolderOpen,
  FolderInput,
  FileArchive,
  BookOpen,
  Terminal,
  ExternalLink,
  Trash2,
  Share2,
  ShieldCheck,
  Search,
  CheckCircle2,
  X,
  Code2,
  Cpu,
  Layers,
  Play,
} from "lucide-react";
import { cn } from "cn";
import type { ExtensionItem } from "../lib/types";
import {
  listExtensions,
  installExtensionZip,
  toggleExtension,
  uninstallExtension,
  exportExtensionZip,
  createSampleExtension,
  installExtensionDir,
  openExternalUrl,
  openFolder,
} from "../lib/backend";
import { open as openDialog } from "@/lib/desktop";
import { extensionRuntime, type ExtensionLogEntry } from "../lib/extensions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "./ui";

interface ExtensionsViewProps {
  gameRoot?: string;
  onNotification?: (title: string, message: string, type?: "info" | "success" | "warning" | "error") => void;
}

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "launcher:game": "监听游戏启动、退出与状态变化事件",
  "launcher:storage": "拥有独立的持久化键值存储空间",
  "launcher:notification": "向启动器桌面与托盘发送交互通知",
  "launcher:rust": "调用扩展内置的高性能 Rust (WASM) 协处理器",
  "network": "允许通过网络请求远程数据与资源",
  storage: "使用 chrome.storage 保存扩展数据",
  notifications: "通过 chrome.notifications 发送系统通知",
  unlimitedStorage: "Chrome 存储权限，与本地扩展共享同一存储区",
};

type ExtensionFilter = "all" | "enabled" | "disabled" | "rust" | "chrome" | "ui";

const FILTERS: ReadonlyArray<{ id: ExtensionFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "enabled", label: "已启用" },
  { id: "disabled", label: "已停用" },
  { id: "rust", label: "Rust" },
  { id: "chrome", label: "Chrome" },
  { id: "ui", label: "UI" },
];

export function ExtensionsView({ gameRoot, onNotification }: ExtensionsViewProps) {
  const [extensions, setExtensions] = useState<ExtensionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  const [showConsole, setShowConsole] = useState(false);
  const [logs, setLogs] = useState<ExtensionLogEntry[]>([]);
  const [activePopupExt, setActivePopupExt] = useState<ExtensionItem | null>(null);
  const [rustTestExt, setRustTestExt] = useState<ExtensionItem | null>(null);
  const [rustTestArgA, setRustTestArgA] = useState("64");
  const [rustTestArgB, setRustTestArgB] = useState("36");
  const [rustTestResult, setRustTestResult] = useState<string | null>(null);
  const [rustTesting, setRustTesting] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const notify = (title: string, message: string, type: "info" | "success" | "warning" | "error" = "info") => {
    if (onNotification) {
      onNotification(title, message, type);
    }
  };

  useEffect(() => {
    extensionRuntime.setNotificationHandler(notify);
    const unbind = extensionRuntime.addLogListener((updated) => setLogs(updated));
    return unbind;
  }, []);

  const loadExtensions = async () => {
    setLoading(true);
    try {
      const items = await listExtensions(gameRoot);
      setExtensions(items);
      // Auto-activate enabled extensions
      for (const item of items) {
        if (item.enabled) {
          extensionRuntime.activateExtension(item);
        }
      }
    } catch (err) {
      const message = String(err);
      notify(
        "加载扩展失败",
        message.includes("Unknown command")
          ? "当前运行的核心进程还不包含扩展接口。请完全退出启动器后重新运行 npm run electron:dev。"
          : message,
        "error",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadExtensions();
  }, [gameRoot]);

  // Handle postMessage communication from the iframe popup.
  useEffect(() => {
    type PopupMessage = {
      type?: string;
      payload?: {
        title?: string;
        message?: string;
        type?: "info" | "success" | "warning" | "error";
      };
      callId?: string;
      fnName?: string;
      args?: Record<string, unknown>;
      extId?: string;
      message?: unknown;
    };

    const handleMessage = async (ev: MessageEvent) => {
      const data = ev.data as PopupMessage | null;
      if (!data?.type) return;
      if (iframeRef.current?.contentWindow && ev.source !== iframeRef.current.contentWindow) {
        return;
      }
      const reply = ev.source as WindowProxy | null;

      if (data.type === "EXT_NOTIFY") {
        const payload = data.payload ?? {};
        notify(
          payload.title || "扩展提示",
          payload.message || "",
          payload.type || "info",
        );
      } else if (data.type === "EXT_RUNTIME_SEND") {
        const { callId, extId, message } = data;
        if (!callId || !extId) return;
        if (activePopupExt && activePopupExt.id !== extId) return;
        try {
          const response = await extensionRuntime.dispatchMessage(extId, message, {
            id: extId,
            url: "popup",
          });
          reply?.postMessage({ type: "EXT_RUNTIME_RESPONSE", callId, response }, "*");
        } catch (err) {
          reply?.postMessage(
            { type: "EXT_RUNTIME_RESPONSE", callId, error: String(err) },
            "*",
          );
        }
      } else if (data.type === "EXT_CALL_RUST") {
        const { callId, fnName, args, extId } = data;
        if (!callId || !fnName || !extId) return;
        const targetExt = extensions.find((e) => e.id === extId);
        if (!targetExt) return;
        try {
          const wasm = await extensionRuntime.getOrInitWasm(targetExt);
          let res: unknown;
          if (wasm && wasm.exports && typeof (wasm.exports as Record<string, unknown>)[fnName] === "function") {
            const fn = (wasm.exports as Record<string, unknown>)[fnName] as (...a: unknown[]) => unknown;
            res = fn(Number(args?.a || 0), Number(args?.b || 0));
          } else {
            const { executeExtensionRust } = await import("../lib/backend");
            res = await executeExtensionRust(extId, fnName, args ?? {}, gameRoot);
          }
          reply?.postMessage({ type: "EXT_RUST_RESULT", callId, result: res }, "*");
        } catch (err) {
          reply?.postMessage({ type: "EXT_RUST_RESULT", callId, error: String(err) }, "*");
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [extensions, gameRoot, activePopupExt]);

  const handleToggle = async (ext: ExtensionItem) => {
    const nextState = !ext.enabled;
    try {
      await toggleExtension(ext.id, nextState, gameRoot);
      notify("状态已更改", `扩展 ${ext.manifest.name} 已${nextState ? "启用" : "禁用"}`, "success");
      await loadExtensions();
    } catch (err) {
      notify("更改失败", String(err), "error");
    }
  };

  const handleUninstall = async (ext: ExtensionItem) => {
    if (!confirm(`确定要卸载扩展「${ext.manifest.name}」吗？`)) {
      return;
    }
    try {
      await uninstallExtension(ext.id, gameRoot);
      notify("已卸载", `扩展 ${ext.manifest.name} 已移除`, "success");
      await loadExtensions();
    } catch (err) {
      notify("卸载失败", String(err), "error");
    }
  };

  const handleExport = async (ext: ExtensionItem) => {
    try {
      const defaultName = `${ext.id}-v${ext.manifest.version}.zip`;
      const targetPath = `${ext.folderPath}/../${defaultName}`;
      const msg = await exportExtensionZip(ext.id, targetPath, gameRoot);
      notify("导出成功", msg, "success");
    } catch (err) {
      notify("导出失败", String(err), "error");
    }
  };

  const handleCreateSample = async () => {
    try {
      const zipPath = await createSampleExtension(undefined, gameRoot);
      notify("已生成并安装示例扩展", `已成功生成 ZIP 并完成挂载: ${zipPath}`, "success");
      await loadExtensions();
    } catch (err) {
      notify("生成示例失败", String(err), "error");
    }
  };

  const handleInstallPackage = async () => {
    try {
      const selected = await openDialog({
        title: "选择扩展安装包",
        filters: [{ name: "扩展包 (*.zip, *.crx)", extensions: ["zip", "crx"] }],
      });
      if (typeof selected !== "string") return;
      const installed = await installExtensionZip(selected, gameRoot);
      notify(
        "扩展安装成功",
        `已成功载入 ${installed.manifest.name} (v${installed.manifest.version})`,
        "success",
      );
      await loadExtensions();
    } catch (err) {
      notify("安装失败", String(err), "error");
    }
  };

  const handleInstallDirectory = async () => {
    try {
      const selected = await openDialog({
        title: "选择已解压的扩展目录",
        directory: true,
      });
      if (typeof selected !== "string") return;
      const installed = await installExtensionDir(selected, gameRoot);
      notify(
        "扩展安装成功",
        `已载入 ${installed.manifest.name} (v${installed.manifest.version})`,
        "success",
      );
      await loadExtensions();
    } catch (err) {
      notify("安装失败", String(err), "error");
    }
  };

  const handleOpenDocs = () => {
    openExternalUrl(
      "https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/blob/main/docs/extensions.md",
    ).catch(() => notify("提示", "无法打开扩展开发文档", "warning"));
  };

  const handleOpenFolder = () => {
    const dir = gameRoot ? `${gameRoot}/extensions` : "";
    if (dir) {
      openFolder(dir).catch(() => notify("提示", "无法打开扩展目录", "warning"));
    }
  };

  const runRustComputation = async (ext: ExtensionItem) => {
    setRustTesting(true);
    setRustTestResult(null);
    try {
      const a = Number(rustTestArgA) || 0;
      const b = Number(rustTestArgB) || 0;
      const wasm = await extensionRuntime.getOrInitWasm(ext);
      if (wasm && wasm.exports && typeof (wasm.exports as Record<string, unknown>)["compute"] === "function") {
        const fn = (wasm.exports as Record<string, unknown>)["compute"] as (a: number, b: number) => number;
        const res = fn(a, b);
        setRustTestResult(`WebAssembly 原生执行结果: compute(${a}, ${b}) = ${res}`);
      } else {
        const { executeExtensionRust } = await import("../lib/backend");
        const res = await executeExtensionRust(ext.id, "compute", { a, b }, gameRoot);
        setRustTestResult(`后端 Rust 引擎响应: compute(${a}, ${b}) = ${res.result ?? JSON.stringify(res)}`);
      }
    } catch (err) {
      setRustTestResult(`执行异常: ${String(err)}`);
    } finally {
      setRustTesting(false);
    }
  };

  const filteredExtensions = extensions.filter((ext) => {
    const matchSearch =
      ext.manifest.name.toLowerCase().includes(search.toLowerCase()) ||
      ext.id.toLowerCase().includes(search.toLowerCase()) ||
      (ext.manifest.description || "").toLowerCase().includes(search.toLowerCase());

    if (!matchSearch) return false;
    if (filter === "enabled") return ext.enabled;
    if (filter === "disabled") return !ext.enabled;
    if (filter === "rust") return ext.hasRust;
    if (filter === "chrome") return ext.format === "chrome";
    if (filter === "ui") return ext.hasUi;
    return true;
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title="扩展"
        description="支持本机扩展和 Chrome MV2 / MV3 扩展：安装 ZIP、CRX 或已解压目录，自动读取弹窗、后台脚本与本地化文案。"
        actions={
          <>
            <Button
              size="sm"
              className="h-8 gap-1.5 px-3 text-[11.5px]"
              onClick={handleInstallPackage}
            >
              <Download className="size-3.5" />
              安装扩展
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-border/80 bg-card/70 px-3 text-[11.5px]"
              onClick={handleInstallDirectory}
              title="加载已解压的 Chrome 扩展目录"
            >
              <FolderInput className="size-3.5 text-muted-foreground" />
              载入目录
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-border/80 bg-card/70 px-3 text-[11.5px]"
              onClick={handleCreateSample}
              title="生成演示完整的 Rust + JS 示例扩展并自动载入"
            >
              <Sparkles className="size-3.5 text-gold" />
              示例扩展
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              className="border-border/80 bg-card/70"
              onClick={loadExtensions}
              title="重新扫描并刷新"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin text-primary")} />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              className="border-border/80 bg-card/70"
              onClick={handleOpenFolder}
              title="打开扩展保存文件夹"
            >
              <FolderOpen className="size-3.5 text-muted-foreground" />
            </Button>
            <Button
              variant={showConsole ? "secondary" : "outline"}
              size="sm"
              className={cn(
                "h-8 gap-1.5 px-3 text-[11.5px]",
                !showConsole && "border-border/80 bg-card/70",
              )}
              onClick={() => setShowConsole(!showConsole)}
            >
              <Terminal className="size-3.5" />
              控制台{logs.length > 0 ? ` (${logs.length})` : ""}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-[11.5px] text-muted-foreground"
              onClick={handleOpenDocs}
              title="查看扩展开发与 Chrome 兼容性文档"
            >
              <BookOpen className="size-3.5" />
              开发文档
            </Button>
          </>
        }
      />

      {/* Summary Stats */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="gap-0 border-border/70 bg-card/60 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Layers className="size-3.5 text-primary" />
              已安装扩展
            </span>
          </div>
          <p className="mt-1.5 font-mono text-[20px] font-semibold tracking-tight text-foreground">
            {extensions.length}
          </p>
        </Card>
        <Card className="gap-0 border-border/70 bg-card/60 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-success" />
              运行中
            </span>
          </div>
          <p className="mt-1.5 font-mono text-[20px] font-semibold tracking-tight text-success">
            {extensions.filter((e) => e.enabled).length}
          </p>
        </Card>
        <Card className="gap-0 border-border/70 bg-card/60 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Cpu className="size-3.5 text-gold" />
              Rust 协处理
            </span>
          </div>
          <p className="mt-1.5 font-mono text-[20px] font-semibold tracking-tight text-gold">
            {extensions.filter((e) => e.hasRust).length}
          </p>
        </Card>
        <Card className="gap-0 border-border/70 bg-card/60 p-3.5">
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <FileArchive className="size-3.5 text-diamond" />
              Chrome 扩展
            </span>
          </div>
          <p className="mt-1.5 font-mono text-[20px] font-semibold tracking-tight text-diamond">
            {extensions.filter((e) => e.format === "chrome").length}
          </p>
        </Card>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索扩展名称、功能或 ID…"
            className="h-8 border-border/80 bg-card/70 pl-8 text-[12px]"
          />
        </div>

        <div className="flex w-fit items-center gap-1 rounded-lg border border-border/70 bg-card/60 p-1">
          {FILTERS.map(({ id, label }) => (
            <Button
              key={id}
              variant={filter === id ? "secondary" : "ghost"}
              size="xs"
              className={cn(
                "h-6 px-2.5 text-[11px]",
                filter === id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setFilter(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* Extensions Grid */}
      {filteredExtensions.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-card/30 p-10 text-center">
          <div className="mb-3 rounded-full bg-muted p-3 text-muted-foreground">
            <Puzzle className="size-7" />
          </div>
          <h3 className="mb-1 text-[13px] font-medium text-foreground">
            {extensions.length === 0 ? "还没有安装扩展" : "没有匹配的扩展"}
          </h3>
          <p className="mb-4 max-w-sm text-[12px] leading-5 text-muted-foreground">
            {extensions.length === 0
              ? "点击「安装扩展」载入 ZIP / CRX，或「载入目录」选择已解压的 Chrome 扩展。"
              : "换个关键词或筛选条件试试。"}
          </p>
          <Button size="sm" className="h-8 gap-1.5 px-3 text-[11.5px]" onClick={handleCreateSample}>
            <Sparkles className="size-3.5" />
            生成示例扩展
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {filteredExtensions.map((ext) => (
            <Card
              key={ext.id}
              className={cn(
                "gap-0 p-5 transition-colors",
                ext.enabled
                  ? "border-border/70 bg-card/60 hover:border-primary/40"
                  : "border-border/50 bg-card/30",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  {ext.iconDataUrl ? (
                    <img
                      src={ext.iconDataUrl}
                      alt={ext.manifest.name}
                      className="size-10 shrink-0 rounded-lg border border-border/70 bg-background/50 object-contain p-1"
                    />
                  ) : (
                    <div
                      className={cn(
                        "flex size-10 shrink-0 items-center justify-center rounded-lg border",
                        ext.enabled
                          ? "border-primary/25 bg-primary/10 text-primary"
                          : "border-border/70 bg-muted text-muted-foreground",
                      )}
                    >
                      <Puzzle className="size-5" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-[13px] font-medium text-foreground">
                        {ext.manifest.name}
                      </h3>
                      <Badge
                        variant="outline"
                        className="h-4 shrink-0 px-1.5 font-mono text-[9px] text-muted-foreground"
                      >
                        v{ext.manifest.version}
                      </Badge>
                      {ext.format === "chrome" ? (
                        <Badge
                          variant="outline"
                          className="h-4 shrink-0 border-diamond/40 bg-diamond/10 px-1.5 font-mono text-[9px] text-diamond"
                        >
                          Chrome{ext.manifestVersion ? ` MV${ext.manifestVersion}` : ""}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {ext.manifest.author ? `作者 ${ext.manifest.author}` : `ID ${ext.id}`}
                    </div>
                  </div>
                </div>

                <Switch
                  checked={ext.enabled}
                  onCheckedChange={() => handleToggle(ext)}
                  aria-label={`${ext.enabled ? "禁用" : "启用"} ${ext.manifest.name}`}
                />
              </div>

              <p className="mt-3 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
                {ext.manifest.description || "暂无描述"}
              </p>

              {/* Badges / Tech Stack */}
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {ext.hasRust ? (
                  <Badge variant="outline" className="h-5 border-gold/40 bg-gold/10 px-1.5 text-[10px] text-gold">
                    <Cpu /> Rust (WASM)
                  </Badge>
                ) : null}
                {ext.hasJavascript ? (
                  <Badge
                    variant="outline"
                    className="h-5 border-border/70 bg-secondary/50 px-1.5 text-[10px] text-secondary-foreground"
                  >
                    <Code2 /> JavaScript
                  </Badge>
                ) : null}
                {ext.hasUi ? (
                  <Badge
                    variant="outline"
                    className="h-5 border-primary/40 bg-primary/10 px-1.5 text-[10px] text-primary"
                  >
                    <ExternalLink /> UI 界面
                  </Badge>
                ) : null}
              </div>

              {/* Permissions Preview */}
              {(ext.manifest.permissions?.length ?? 0) + (ext.hostPermissions?.length ?? 0) > 0 ? (
                <div className="mt-3 rounded-lg border border-border/60 bg-background/40 p-2.5">
                  <div className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                    <ShieldCheck className="size-3.5 text-primary" />
                    申请权限
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {ext.manifest.permissions?.map((perm) => (
                      <span
                        key={perm}
                        title={PERMISSION_DESCRIPTIONS[perm] || perm}
                        className="rounded border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {perm}
                      </span>
                    ))}
                    {ext.hostPermissions?.map((perm) => (
                      <span
                        key={perm}
                        title="Chrome 主机权限：启动器不拦截或注入网页，仅作信息展示"
                        className="rounded border border-border/60 bg-card/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {perm}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Card Footer: Action Buttons */}
              <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {ext.hasUi ? (
                    <Button
                      variant="outline"
                      size="xs"
                      className="border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                      onClick={() => setActivePopupExt(ext)}
                    >
                      <ExternalLink className="size-3" />
                      打开扩展窗口
                    </Button>
                  ) : null}
                  {ext.hasRust ? (
                    <Button
                      variant="outline"
                      size="xs"
                      className="border-gold/30 bg-gold/10 text-gold hover:bg-gold/15 hover:text-gold"
                      onClick={() => setRustTestExt(ext)}
                    >
                      <Play className="size-3" />
                      测试 Rust 模块
                    </Button>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    onClick={() => handleExport(ext)}
                    title="导出扩展为 ZIP 压缩包"
                  >
                    <Share2 />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => handleUninstall(ext)}
                    title="卸载扩展"
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Developer Console */}
      {showConsole ? (
        <Card className="gap-0 overflow-hidden border-border/70 bg-card/60 p-0">
          <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
            <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
              <Terminal className="size-3.5 text-primary" />
              扩展运行控制台
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                className="text-[10.5px] text-muted-foreground"
                onClick={() => extensionRuntime.clearLogs()}
              >
                清空日志
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                onClick={() => setShowConsole(false)}
                title="关闭控制台"
              >
                <X />
              </Button>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto px-4 py-3 font-mono text-[11px]">
            {logs.length === 0 ? (
              <div className="py-3 text-center text-muted-foreground">暂无扩展输出日志</div>
            ) : (
              <div className="space-y-1">
                {logs.map((log) => (
                  <div key={log.id} className="flex items-start gap-2">
                    <span className="shrink-0 text-muted-foreground/70">[{log.time}]</span>
                    <span className="shrink-0 rounded bg-secondary/60 px-1.5 py-0.5 text-[9.5px] text-muted-foreground">
                      {log.extensionId}
                    </span>
                    <span
                      className={cn(
                        log.level === "error"
                          ? "text-destructive"
                          : log.level === "warn"
                            ? "text-gold"
                            : "text-foreground/80",
                      )}
                    >
                      {log.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      ) : null}

      {/* Extension Popup Modal */}
      {activePopupExt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <Card className="w-full max-w-md gap-0 overflow-hidden border-border/70 bg-popover p-0 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border/60 bg-card/40 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2.5">
                {activePopupExt.iconDataUrl ? (
                  <img
                    src={activePopupExt.iconDataUrl}
                    alt=""
                    className="size-5 shrink-0 rounded object-contain"
                  />
                ) : (
                  <Puzzle className="size-4 shrink-0 text-primary" />
                )}
                <span className="truncate text-[12.5px] font-medium text-foreground">
                  {activePopupExt.manifest.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  v{activePopupExt.manifest.version}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                onClick={() => setActivePopupExt(null)}
                title="关闭"
              >
                <X />
              </Button>
            </div>
            <div className="bg-background p-2">
              <iframe
                ref={iframeRef}
                title="Extension UI"
                srcDoc={extensionRuntime.preparePopupHtml(activePopupExt)}
                sandbox="allow-scripts allow-forms allow-same-origin"
                className="h-[380px] w-full rounded-lg border border-border/60 bg-background"
              />
            </div>
          </Card>
        </div>
      ) : null}

      {/* Rust Module Interactive Test Modal */}
      {rustTestExt ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <Card className="w-full max-w-md gap-0 border-gold/30 bg-popover p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-border/60 pb-4">
              <div className="flex items-center gap-2.5">
                <div className="rounded-lg border border-gold/30 bg-gold/10 p-2 text-gold">
                  <Cpu className="size-5" />
                </div>
                <div>
                  <h3 className="text-[13px] font-semibold text-foreground">Rust 模块交互测试</h3>
                  <div className="text-[11px] text-muted-foreground">{rustTestExt.manifest.name}</div>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                onClick={() => setRustTestExt(null)}
                title="关闭"
              >
                <X />
              </Button>
            </div>

            <p className="mb-4 text-[11.5px] leading-5 text-muted-foreground">
              直接调用该扩展内置的 Rust (WebAssembly) 导出函数，验证高性能协同运算。
            </p>

            <div className="mb-4 grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">入参 A (i32)</label>
                <Input
                  type="number"
                  value={rustTestArgA}
                  onChange={(e) => setRustTestArgA(e.target.value)}
                  className="h-8 font-mono text-[12px]"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] text-muted-foreground">入参 B (i32)</label>
                <Input
                  type="number"
                  value={rustTestArgB}
                  onChange={(e) => setRustTestArgB(e.target.value)}
                  className="h-8 font-mono text-[12px]"
                />
              </div>
            </div>

            <Button
              size="sm"
              className="mb-4 h-8 w-full gap-1.5 border-gold/30 bg-gold/15 text-[11.5px] text-gold hover:bg-gold/20"
              onClick={() => runRustComputation(rustTestExt)}
              disabled={rustTesting}
            >
              <Cpu className="size-3.5" />
              {rustTesting ? "正在执行 Rust 代码…" : "触发 Rust WASM 计算 (compute)"}
            </Button>

            {rustTestResult ? (
              <div className="rounded-lg border border-gold/30 bg-gold/5 p-3 font-mono text-[11px] text-gold">
                {rustTestResult}
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
