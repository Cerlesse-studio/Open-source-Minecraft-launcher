import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import {
  ArrowDownToLine,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Heart,
  LoaderCircle,
  Package,
  RefreshCw,
  Search,
  UserRound,
  X,
} from "lucide-react";
import {
  downloadContentFile,
  getContentVersions,
  getInstalledVersions,
  openExternalUrl,
  resolveMcmodEntry,
} from "../lib/backend";
import { formatBytes, formatRelativeDate } from "../lib/format";
import type {
  ContentHit,
  ContentProjectType,
  ContentVersionItem,
  InstalledVersion,
  WikiEntry,
} from "../lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ContentIcon } from "@/components/ui";

export interface ContentVersionSelectViewProps {
  project: ContentHit;
  projectType: ContentProjectType;
  gameRoot: string;
  initialGameVersion?: string;
  initialLoader?: string;
  onBack: () => void;
  onOpenFolder: (path: string) => void;
  onNotify: (
    tone: "success" | "error" | "info",
    title: string,
    detail?: string,
  ) => void;
}

const LOADERS = ["all", "fabric", "forge", "neoforge", "quilt", "bedrock"];

function projectTypeLabel(type: ContentProjectType): string {
  switch (type) {
    case "mod":
      return "模组";
    case "shader":
      return "光影包";
    case "datapack":
      return "数据包";
    case "resourcepack":
      return "资源包";
    case "modpack":
      return "整合包";
    default:
      return "资源";
  }
}

function typeDestinationPath(type: ContentProjectType): string {
  switch (type) {
    case "mod":
      // Mods live with their instance; there is no shared `mods/` folder.
      return "versions/<对应版本>/mods";
    case "shader":
      return "shaderpacks/";
    case "datapack":
      return "datapacks/";
    case "resourcepack":
      return "resourcepacks/";
    case "modpack":
      return "modpacks/";
    default:
      return "downloads/";
  }
}

/** Modrinth path segment for each project type. */
function modrinthSegment(type: ContentProjectType): string {
  switch (type) {
    case "modpack":
      return "modpack";
    case "shader":
      return "shader";
    case "resourcepack":
      return "resourcepack";
    case "datapack":
      return "datapack";
    default:
      return "mod";
  }
}

/**
 * Browsable page of a project, matching the store it was listed on: Java
 * projects live on Modrinth, Bedrock add-ons on CurseForge.
 */
function projectSiteLink(
  project: ContentHit,
  projectType: ContentProjectType,
  isBedrock: boolean,
): { label: string; url: string } {
  const slug = (project.slug || project.projectId).trim();
  if (isBedrock) {
    const section = projectType === "resourcepack" ? "texture-packs" : "addons";
    return {
      label: "CurseForge",
      url: `https://www.curseforge.com/minecraft-bedrock/${section}/${encodeURIComponent(
        slug.replace(/^cfb:/, ""),
      )}`,
    };
  }
  return {
    label: "Modrinth",
    url: `https://modrinth.com/${modrinthSegment(projectType)}/${encodeURIComponent(slug)}`,
  };
}

function formatCount(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(1)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return String(num);
}

function normalizeMcVersion(value: string): string {
  return value.trim().replace(/^v/i, "").toLowerCase();
}

/** Collapse `1.21.4` to the `1.21` pill the filter bar shows. */
function majorMinor(value: string): string {
  const clean = normalizeMcVersion(value);
  const match = clean.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : clean;
}

function versionParts(value: string): string[] {
  return normalizeMcVersion(value)
    .split(/[.\-+_]/)
    .filter(Boolean);
}

const PRERELEASE_TAGS = new Set(["pre", "rc", "snapshot", "alpha", "beta", "dev"]);

/** Numeric-aware compare so `1.21.10` sorts above `1.21.9`, `26.3` above `26.2`,
 *  and a release above its own `pre`/`rc`/`snapshot` builds. */
function compareMcVersions(a: string, b: string): number {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) {
      return PRERELEASE_TAGS.has(right[i]) ? 1 : -1;
    }
    if (r === undefined) {
      return PRERELEASE_TAGS.has(l) ? -1 : 1;
    }
    const ln = Number(l);
    const rn = Number(r);
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln - rn;
      continue;
    }
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

function isPreviewVersion(value: string): boolean {
  return versionParts(value).some((part) => PRERELEASE_TAGS.has(part));
}

/** `26.3-snapshot-10` and `26.3-rc-1` both belong to the `26.3` section. */
function releaseBase(value: string): string {
  const parts = versionParts(value);
  const cut = parts.findIndex((part) => PRERELEASE_TAGS.has(part));
  return (cut > 0 ? parts.slice(0, cut) : parts).join(".");
}

function newestGameVersion(list: string[]): string {
  return list.reduce(
    (best, value) => (!best || compareMcVersions(value, best) > 0 ? value : best),
    "",
  );
}

/** Release channel of a build, shown only for pre-releases like the reference UI. */
function channelLabel(...values: string[]): string | null {
  const text = values.join(" ").toLowerCase();
  if (/alpha/.test(text)) return "早期测试版";
  if (/beta/.test(text)) return "测试版";
  if (/(snapshot|preview|pre[.\d-]|rc[.\d-])/.test(text)) return "预览版";
  return null;
}

interface LoaderMeta {
  key: string;
  label: string;
  short: string;
  tile: string;
}

function loaderMeta(raw?: string | null, bedrock = false): LoaderMeta {
  const key = (raw ?? "").trim().toLowerCase();
  if (bedrock || key === "bedrock" || key === "基岩版") {
    return {
      key: "bedrock",
      label: "基岩版",
      short: "BE",
      tile: "border-primary/30 bg-primary/10 text-primary",
    };
  }
  switch (key) {
    case "fabric":
      return {
        key,
        label: "Fabric",
        short: "FA",
        tile: "border-amber-500/30 bg-amber-500/10 text-amber-300",
      };
    case "forge":
      return {
        key,
        label: "Forge",
        short: "FO",
        tile: "border-slate-400/30 bg-slate-400/10 text-slate-300",
      };
    case "neoforge":
      return {
        key,
        label: "NeoForge",
        short: "NE",
        tile: "border-orange-500/30 bg-orange-500/10 text-orange-300",
      };
    case "quilt":
      return {
        key,
        label: "Quilt",
        short: "QU",
        tile: "border-violet-500/30 bg-violet-500/10 text-violet-300",
      };
    case "liteloader":
      return {
        key,
        label: "LiteLoader",
        short: "LL",
        tile: "border-sky-500/30 bg-sky-500/10 text-sky-300",
      };
    case "minecraft":
      return {
        key,
        label: "原版",
        short: "VA",
        tile: "border-border/70 bg-muted/30 text-muted-foreground",
      };
    default:
      return {
        key: key || "generic",
        label: key || "通用",
        short: key ? key.slice(0, 2).toUpperCase() : "GE",
        tile: "border-border/70 bg-muted/30 text-muted-foreground",
      };
  }
}

/**
 * Which local instance a build belongs in. Mirrors the Rust resolver that
 * actually picks the mods folder: same Minecraft version first, an instance
 * with the same loader preferred, newest install wins ties.
 */
function findMatchingInstance(
  installed: InstalledVersion[],
  gameVersions: string[],
  loaders: string[],
): InstalledVersion | undefined {
  const wanted = new Set(gameVersions.map(normalizeMcVersion).filter(Boolean));
  if (wanted.size === 0) return undefined;

  const sameGame = installed.filter(
    (iv) => iv.mcVersion && wanted.has(normalizeMcVersion(iv.mcVersion)),
  );
  if (sameGame.length === 0) return undefined;

  const wantedLoaders = loaders
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && l !== "all");
  const sameLoader = sameGame.filter(
    (iv) => iv.loader && wantedLoaders.includes(iv.loader.toLowerCase()),
  );
  const pool = sameLoader.length > 0 ? sameLoader : sameGame;

  return pool.reduce<InstalledVersion | undefined>(
    (best, iv) => (!best || iv.installedAt > best.installedAt ? iv : best),
    undefined,
  );
}

interface VersionGroup {
  key: string;
  meta: LoaderMeta;
  mcVersion: string;
  preview: boolean;
  items: ContentVersionItem[];
  hasLocal: boolean;
}

export function ContentVersionSelectView({
  project,
  projectType,
  gameRoot,
  initialGameVersion = "all",
  initialLoader = "all",
  onBack,
  onOpenFolder,
  onNotify,
}: ContentVersionSelectViewProps) {
  const [versionFilter, setVersionFilter] = useState(
    initialGameVersion && initialGameVersion !== "all"
      ? majorMinor(initialGameVersion)
      : "all",
  );
  const [loader, setLoader] = useState(initialLoader);
  const [query, setQuery] = useState("");
  const [versions, setVersions] = useState<ContentVersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloadingIds, setDownloadingIds] = useState<Set<string>>(new Set());
  const [downloadedSet, setDownloadedSet] = useState<Set<string>>(new Set());
  const [installedVersions, setInstalledVersions] = useState<InstalledVersion[]>([]);
  const [manualToggles, setManualToggles] = useState<Record<string, boolean>>({});
  const [copiedName, setCopiedName] = useState(false);
  const [wikiEntry, setWikiEntry] = useState<WikiEntry | null>(null);
  const [wikiLoading, setWikiLoading] = useState(false);

  // Bedrock projects come from CurseForge; their files are pack archives that
  // the installer unpacks into the game data folder, not a Java instance.
  const isCurseForgeBedrock = project.projectId.startsWith("cfb:");

  // CurseForge hits carry a `cfb:` id; the category check keeps older cached
  // entries (and the demo dataset) on the same code path.
  const isBedrockSource =
    isCurseForgeBedrock ||
    project.categories.some((c) => /基岩版|bedrock/i.test(c));
  const isJavaMod = !isBedrockSource && projectType === "mod";

  // MC 百科 only covers Java mods, data packs and modpacks: shaders, resource
  // packs and every Bedrock add-on have no entry, so the button is hidden for
  // them instead of sending people to a search that cannot match.
  const supportsWiki =
    !isBedrockSource &&
    (projectType === "mod" ||
      projectType === "modpack" ||
      projectType === "datapack");

  // Resolve the exact wiki page once per project, like PCL does with its
  // bundled slug → class id table, but through mcmod.cn's own search.
  useEffect(() => {
    let cancelled = false;
    if (!supportsWiki) {
      setWikiEntry(null);
      setWikiLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setWikiEntry(null);
    setWikiLoading(true);
    void resolveMcmodEntry(project.title, project.slug, projectType)
      .then((entry) => {
        if (!cancelled) setWikiEntry(entry);
      })
      .catch(() => {
        if (!cancelled) setWikiEntry(null);
      })
      .finally(() => {
        if (!cancelled) setWikiLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [project.projectId, project.title, project.slug, projectType, supportsWiki]);

  // Local instances decide where a Java mod lands, so they are read once per
  // root instead of on every row.
  useEffect(() => {
    let cancelled = false;
    void getInstalledVersions(gameRoot)
      .then((list) => {
        if (!cancelled) setInstalledVersions(list);
      })
      .catch(() => {
        if (!cancelled) setInstalledVersions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gameRoot]);

  // The full file list is fetched once per loader and filtered in the browser:
  // the version pills must know every game version the project supports, not
  // just the ones matching the current filter.
  const loadVersions = async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getContentVersions(
        project.projectId,
        undefined,
        loader !== "all" ? loader : undefined,
      );
      setVersions(list);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadVersions();
  }, [project.projectId, loader]);

  const versionPills = useMemo(() => {
    const seen = new Set<string>();
    for (const v of versions) {
      for (const gv of v.gameVersions) {
        const label = majorMinor(gv);
        if (label) seen.add(label);
      }
    }
    // Every supported major version gets a pill: a project with a long history
    // must not hide its older (1.16/1.12) builds behind a truncated list.
    const list = [...seen].sort((a, b) => compareMcVersions(b, a));
    if (versionFilter !== "all" && !list.includes(versionFilter)) {
      list.unshift(versionFilter);
    }
    return list;
  }, [versions, versionFilter]);

  const availableLoaders = useMemo(() => {
    const seen = new Set<string>();
    for (const v of versions) {
      for (const l of v.loaders) {
        const key = l.trim().toLowerCase();
        if (key && key !== "all") seen.add(key);
      }
    }
    return [...seen].sort();
  }, [versions]);

  const filteredVersions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return versions.filter((v) => {
      if (
        versionFilter !== "all" &&
        !v.gameVersions.some((gv) => majorMinor(gv) === versionFilter)
      ) {
        return false;
      }
      if (!q) return true;
      return (
        v.versionNumber.toLowerCase().includes(q) ||
        v.name.toLowerCase().includes(q) ||
        v.files.some((f) => f.filename.toLowerCase().includes(q))
      );
    });
  }, [versions, query, versionFilter]);

  // One collapsible section per loader + Minecraft version, like the reference
  // picker: "NeoForge 1.21.4" first, older versions below.
  const groups = useMemo<VersionGroup[]>(() => {
    const map = new Map<string, VersionGroup>();
    for (const item of filteredVersions) {
      const meta = loaderMeta(
        item.loaders.find((l) => l && l !== "all"),
        isCurseForgeBedrock,
      );
      const primary = newestGameVersion(item.gameVersions);
      const preview = isPreviewVersion(primary);
      const mcVersion = primary ? releaseBase(primary) : "";
      const key = `${meta.key}|${mcVersion || "unknown"}|${preview ? "preview" : "stable"}`;
      const group: VersionGroup =
        map.get(key) ?? {
          key,
          meta,
          mcVersion,
          preview,
          items: [],
          hasLocal: false,
        };
      group.items.push(item);
      if (isJavaMod && findMatchingInstance(installedVersions, item.gameVersions, item.loaders)) {
        group.hasLocal = true;
      }
      map.set(key, group);
    }

    const list = [...map.values()];
    for (const group of list) {
      group.items.sort((a, b) => {
        const aTime = a.datePublished ? Date.parse(a.datePublished) : 0;
        const bTime = b.datePublished ? Date.parse(b.datePublished) : 0;
        if (aTime !== bTime) return bTime - aTime;
        return b.downloads - a.downloads;
      });
    }
    list.sort((a, b) => {
      if (a.mcVersion && b.mcVersion) {
        const byVersion = compareMcVersions(b.mcVersion, a.mcVersion);
        if (byVersion !== 0) return byVersion;
      } else if (a.mcVersion) {
        return -1;
      } else if (b.mcVersion) {
        return 1;
      }
      if (a.mcVersion === b.mcVersion && a.preview !== b.preview) {
        return a.preview ? 1 : -1;
      }
      return a.meta.label.localeCompare(b.meta.label);
    });
    return list;
  }, [filteredVersions, installedVersions, isJavaMod, isCurseForgeBedrock]);

  const siteLink = projectSiteLink(project, projectType, isBedrockSource);
  const wikiLink = `https://search.mcmod.cn/s?key=${encodeURIComponent(project.title)}`;

  const openLink = async (url: string, label: string) => {
    try {
      await openExternalUrl(url);
    } catch (e) {
      onNotify("error", `无法打开 ${label}`, String(e));
    }
  };

  const copyProjectName = async () => {
    const text = project.title;
    let copied = false;

    // WebView2 can deny the async clipboard API on some systems, so fall back
    // to the hidden-textarea trick before giving up.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        copied = document.execCommand("copy");
        document.body.removeChild(area);
      } catch {
        copied = false;
      }
    }

    if (!copied) {
      onNotify("error", "复制名称失败", "系统剪贴板不可用，请手动选中复制。");
      return;
    }

    setCopiedName(true);
    window.setTimeout(() => setCopiedName(false), 1600);
    onNotify("success", "已复制名称", text);
  };

  const handleDownload = async (versionItem: ContentVersionItem) => {
    const file = versionItem.files.find((f) => f.primary) ?? versionItem.files[0];
    if (!file) {
      onNotify("error", "下载失败", "未找到可下载的文件链接");
      return;
    }
    // Install into the instance this build belongs to; passing it explicitly
    // keeps the backend on the same instance the row already advertises.
    const matched = isJavaMod
      ? findMatchingInstance(
          installedVersions,
          versionItem.gameVersions,
          versionItem.loaders,
        )
      : undefined;
    if (isJavaMod && !matched) {
      onNotify(
        "error",
        `无法安装 ${project.title}`,
        "本地没有与该构建匹配的游戏版本，模组只能安装到对应版本。请先安装对应版本再下载。",
      );
      return;
    }
    setDownloadingIds((prev) => new Set(prev).add(versionItem.id));
    try {
      const res = await downloadContentFile({
        root: gameRoot,
        instanceId: matched?.id,
        projectType,
        url: file.url,
        filename: file.filename,
        sha1: file.sha1,
        size: file.size,
        title: project.title,
        gameVersions: versionItem.gameVersions,
        loader: versionItem.loaders[0],
      });
      setDownloadedSet((prev) => new Set(prev).add(versionItem.id));
      const matchedNote =
        res.autoMatched && res.instanceId
          ? `已自动匹配本地版本 ${res.instanceId}，`
          : "";
      onNotify(
        "success",
        `已成功下载 ${project.title} (${versionItem.versionNumber})`,
        `${matchedNote}已保存至 ${res.filePath} (${formatBytes(res.bytes)})`,
      );
    } catch (err) {
      onNotify("error", `下载 ${project.title} 失败`, String(err));
    } finally {
      setDownloadingIds((prev) => {
        const next = new Set(prev);
        next.delete(versionItem.id);
        return next;
      });
    }
  };

  const toggleGroup = (group: VersionGroup, open: boolean) => {
    setManualToggles((prev) => ({ ...prev, [group.key]: !open }));
  };

  // Java mods are only installed into the instance they were built for, so the
  // header chip points at the newest matching install. Without one there is no
  // shared `mods/` folder to fall back to and the chip only explains why.
  const defaultModInstance = useMemo(() => {
    if (!isJavaMod) return undefined;
    let best: InstalledVersion | undefined;
    for (const v of versions) {
      const match = findMatchingInstance(
        installedVersions,
        v.gameVersions,
        v.loaders,
      );
      if (match && (!best || match.installedAt > best.installedAt)) best = match;
    }
    return best;
  }, [versions, installedVersions, isJavaMod]);

  const modTargetPath = defaultModInstance
    ? `versions/${defaultModInstance.id}/mods`
    : null;

  const destinationFolder = isCurseForgeBedrock
    ? "bedrock/games/com.mojang"
    : isJavaMod
      ? (modTargetPath ?? "versions/<对应版本>/mods")
      : typeDestinationPath(projectType);
  const folderToOpen = isCurseForgeBedrock
    ? destinationFolder
    : isJavaMod
      ? modTargetPath
      : typeDestinationPath(projectType);

  const showLoaderFilter =
    !isCurseForgeBedrock &&
    (projectType === "mod" || projectType === "modpack");
  const loaderOptions = [
    "all",
    ...(availableLoaders.length > 0 ? availableLoaders : LOADERS.slice(1)),
  ];

  return (
    <div className="space-y-4">
      {/* Top Project Banner & Navigation */}
      <Card className="gap-0 border-border/70 bg-card/75 p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <Button
              variant="outline"
              size="icon-sm"
              className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={onBack}
              title={`返回${projectTypeLabel(projectType)}列表`}
            >
              <ArrowLeft className="size-4" />
            </Button>

            <ContentIcon
              src={project.iconUrl}
              alt={project.title}
              projectType={projectType}
              className="size-14 rounded-xl"
              iconClassName="size-6"
            />

            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[17px] font-bold text-foreground">
                  {project.title}
                </h1>
                <Badge
                  variant="outline"
                  className="h-4 border-primary/30 bg-primary/10 px-1.5 text-[9.5px] font-medium text-primary"
                >
                  {projectTypeLabel(projectType)}
                </Badge>
                {isCurseForgeBedrock ? (
                  <Badge className="h-4 border-0 bg-primary/15 px-1.5 text-[9.5px] font-medium text-primary">
                    CurseForge · 基岩版
                  </Badge>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <UserRound className="size-3" />
                  {project.author}
                </span>
                <span>·</span>
                <span className="flex items-center gap-1 font-mono">
                  <ArrowDownToLine className="size-3" />
                  {formatCount(project.downloads)} 下载
                </span>
                {project.follows ? (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1 font-mono">
                      <Heart className="size-3 text-rose-500/80" />
                      {formatCount(project.follows)} 关注
                    </span>
                  </>
                ) : null}
              </div>

              <p className="mt-1 max-w-2xl text-[11.5px] leading-5 text-muted-foreground">
                {project.description || "暂无简介"}
              </p>

              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {project.categories.map((c) => (
                  <Badge
                    key={c}
                    variant="outline"
                    className="h-4 border-border/60 bg-muted/20 px-1.5 text-[9.5px] text-muted-foreground/80"
                  >
                    {c}
                  </Badge>
                ))}
              </div>

              {/* Jump out to the project page, the Chinese wiki, or copy the
                  name for a manual search. */}
              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openLink(siteLink.url, siteLink.label)}
                  title={siteLink.url}
                  className="h-8 gap-1.5 rounded-lg border-primary/40 bg-primary/5 px-3 text-[11.5px] font-medium text-primary shadow-xs hover:border-primary/60 hover:bg-primary/15 hover:text-primary"
                >
                  <ExternalLink className="size-3.5" />
                  转到 {siteLink.label}
                </Button>
                {supportsWiki ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      void openLink(wikiEntry?.url ?? wikiLink, "MC 百科")
                    }
                    disabled={wikiLoading}
                    title={
                      wikiLoading
                        ? "正在 MC 百科查找对应条目…"
                        : (wikiEntry?.title ??
                          `${wikiLink}\n未找到完全对应的条目，将打开搜索页`)
                    }
                    className="h-8 gap-1.5 rounded-lg border-primary/40 bg-primary/5 px-3 text-[11.5px] font-medium text-primary shadow-xs hover:border-primary/60 hover:bg-primary/15 hover:text-primary"
                  >
                    {wikiLoading ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <BookOpen className="size-3.5" />
                    )}
                    {wikiLoading
                      ? "查找 MC 百科…"
                      : wikiEntry
                        ? "转到 MC 百科"
                        : "在 MC 百科搜索"}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copyProjectName()}
                  title={`复制项目名称：${project.title}`}
                  className="h-8 gap-1.5 rounded-lg border-border/70 bg-background/40 px-3 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent/60 hover:text-foreground"
                >
                  {copiedName ? (
                    <Check className="size-3.5 text-success" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copiedName ? "已复制" : "复制名称"}
                </Button>
              </div>
            </div>
          </div>

          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 self-start text-[11.5px] text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <ArrowLeft className="size-3.5" />
            返回列表
          </Button>
        </div>
      </Card>

      {/* Version pills + search, mirroring the launcher-style picker */}
      <Card className="gap-3 border-border/70 bg-card/60 p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setVersionFilter("all")}
            aria-pressed={versionFilter === "all"}
            className={cn(
              "h-7 shrink-0 rounded-full px-3 text-[11.5px] font-medium transition-colors",
              versionFilter === "all"
                ? "bg-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            全部
          </button>
          {versionPills.map((pill) => (
            <button
              key={pill}
              type="button"
              onClick={() => setVersionFilter(pill)}
              aria-pressed={versionFilter === pill}
              title={`只看支持 Minecraft ${pill} 的构建`}
              className={cn(
                "h-7 shrink-0 rounded-full px-3 font-mono text-[11.5px] font-medium transition-colors",
                versionFilter === pill
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {pill}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-1.5">
            {/* Loader Filter */}
            {showLoaderFilter ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 rounded-lg border-border/70 bg-background/50 px-2.5 text-xs font-normal hover:bg-accent/60"
                  >
                    <span className="text-[11px] text-muted-foreground">加载器:</span>
                    <span className="font-mono font-medium capitalize text-foreground">
                      {loader === "all"
                        ? "全部"
                        : loader === "bedrock"
                          ? "基岩版"
                          : loader}
                    </span>
                    <ChevronDown className="size-3 text-muted-foreground opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuLabel className="text-[11px] text-muted-foreground">
                    选择模组加载器
                  </DropdownMenuLabel>
                  {loaderOptions.map((l) => (
                    <DropdownMenuItem
                      key={l}
                      onClick={() => setLoader(l)}
                      className="flex cursor-pointer items-center justify-between font-mono text-xs capitalize"
                    >
                      <span>
                        {l === "all"
                          ? "全部加载器"
                          : l === "bedrock"
                            ? "基岩版 (Bedrock)"
                            : l}
                      </span>
                      {loader === l && <Check className="size-3.5 text-primary" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <Button
              variant="outline"
              size="icon"
              className="size-8 shrink-0 rounded-lg border-border/70 text-muted-foreground shadow-xs hover:text-foreground"
              onClick={() => void loadVersions()}
              disabled={loading}
              title="重新刷新版本列表"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-border/40 pt-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full shrink-0 sm:w-64">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索版本号或文件名…"
              className="h-8 rounded-lg border-border/70 bg-background/50 pl-8 pr-7 font-mono text-xs shadow-xs"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
            <span>
              {isJavaMod
                ? "模组只会安装到游戏版本一致的本地实例"
                : isCurseForgeBedrock
                  ? "附加包会解包安装到游戏数据目录"
                  : "文件将保存到目标目录"}
            </span>
            {folderToOpen ? (
              <button
                type="button"
                onClick={() => {
                  onOpenFolder(`${gameRoot}/${folderToOpen}`);
                }}
                title="点击打开对应存储文件夹"
                className="group flex items-center gap-1.5 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1 text-[10.5px] text-muted-foreground transition hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
              >
                <FolderOpen className="size-3.5 text-primary/80 transition-transform group-hover:scale-110" />
                <span>目标:</span>
                <code className="font-mono text-[10px] text-foreground/85 transition-colors group-hover:text-primary">
                  {destinationFolder}
                </code>
              </button>
            ) : (
              <span
                title="本地没有与这些构建匹配的游戏版本，装好对应版本后即可下载"
                className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-background/40 px-2.5 py-1 text-[10.5px] text-muted-foreground"
              >
                <FolderOpen className="size-3.5 text-muted-foreground/60" />
                <span>目标:</span>
                <code className="font-mono text-[10px] text-foreground/85">
                  {destinationFolder}
                </code>
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* Count & Status */}
      <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
        <span>
          共 <strong className="font-mono text-foreground">{filteredVersions.length}</strong>{" "}
          个构建 ·{" "}
          <strong className="font-mono text-foreground">{groups.length}</strong> 个分组
        </span>
        {loading ? (
          <span className="flex items-center gap-1.5 text-primary">
            <LoaderCircle className="size-3 animate-spin" />
            正在同步版本清单…
          </span>
        ) : null}
      </div>

      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-4 text-[12px] text-destructive">
          获取版本列表失败：{error}
        </Card>
      ) : null}

      {/* Grouped, collapsible version list */}
      <div className="space-y-2">
        {loading && versions.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="h-12 animate-pulse border-border/60 bg-card/40" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <Card className="flex min-h-[200px] flex-col items-center justify-center p-8 text-center text-muted-foreground">
            <Package className="size-8 text-muted-foreground/50" />
            <p className="mt-2 text-[12.5px] font-medium text-foreground">
              未找到匹配的可用构建
            </p>
            <p className="mt-1 text-[11px]">
              {isCurseForgeBedrock
                ? "该附加包在 CurseForge 上暂无可用下载文件，或网络无法连接镜像源。"
                : "尝试切换到「全部」版本、调整加载器，或清除搜索关键词。"}
            </p>
          </Card>
        ) : (
          groups.map((group, index) => {
            const open = manualToggles[group.key] ?? (index === 0 || group.hasLocal);
            return (
              <Card
                key={group.key}
                className="gap-0 overflow-hidden border-border/70 bg-card/60 py-0"
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(group, open)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/30"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[12.5px] font-semibold text-foreground">
                      {group.meta.label} {group.mcVersion || "未标注版本"}
                      {group.preview ? (
                        <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                          预览版
                        </span>
                      ) : null}
                    </span>
                    {group.hasLocal ? (
                      <Badge className="h-4 shrink-0 border-0 bg-success/15 px-1.5 text-[9px] font-medium text-success">
                        本地已安装
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-[10.5px] text-muted-foreground">
                    <span className="font-mono">{group.items.length} 个构建</span>
                    <ChevronDown
                      className={cn(
                        "size-4 transition-transform duration-200",
                        open && "rotate-180",
                      )}
                    />
                  </span>
                </button>

                {open ? (
                  <div className="divide-y divide-border/30 border-t border-border/40">
                    {group.items.map((v) => {
                      const primaryFile =
                        v.files.find((f) => f.primary) ?? v.files[0];
                      const isBusy = downloadingIds.has(v.id);
                      const isDownloaded = downloadedSet.has(v.id);
                      const matchedInstance = isJavaMod
                        ? findMatchingInstance(
                            installedVersions,
                            v.gameVersions,
                            v.loaders,
                          )
                        : undefined;
                      // Every mod has to land in a matching instance: there is
                      // no shared mods folder, so an unmatched build cannot be
                      // downloaded until its version is installed.
                      const canDownload = !isJavaMod || Boolean(matchedInstance);
                      const channel = channelLabel(v.versionNumber, v.name);
                      const describedVersion =
                        group.mcVersion ||
                        newestGameVersion(v.gameVersions) ||
                        "未标注版本";

                      return (
                        <div
                          key={v.id}
                          className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/25"
                        >
                          <span
                            className={cn(
                              "flex size-8 shrink-0 items-center justify-center rounded-lg border font-mono text-[9px] font-bold uppercase",
                              group.meta.tile,
                            )}
                            title={group.meta.label}
                          >
                            {group.meta.short}
                          </span>

                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[12.5px] font-medium text-foreground">
                              {project.title}{" "}
                              <span className="font-mono">{v.versionNumber}</span>{" "}
                              for {group.meta.label} {describedVersion}
                              {group.preview ? " 预览版" : ""}
                            </p>
                            <p className="mt-0.5 truncate text-[10.5px] leading-4 text-muted-foreground">
                              <span>{group.meta.label}</span>
                              <span className="text-muted-foreground/50">, </span>
                              <span className="font-mono">
                                {primaryFile?.filename || "未命名文件"}
                              </span>
                              <span className="text-muted-foreground/50">, </span>
                              <span>下载 {formatCount(v.downloads)} 次</span>
                              {v.datePublished ? (
                                <>
                                  <span className="text-muted-foreground/50">, </span>
                                  <span>
                                    更新于 {formatRelativeDate(v.datePublished)}
                                  </span>
                                </>
                              ) : null}
                              {primaryFile?.size ? (
                                <>
                                  <span className="text-muted-foreground/50">, </span>
                                  <span className="font-mono">
                                    {formatBytes(primaryFile.size)}
                                  </span>
                                </>
                              ) : null}
                              {channel ? (
                                <>
                                  <span className="text-muted-foreground/50">, </span>
                                  <span className="text-amber-400/80">{channel}</span>
                                </>
                              ) : null}
                            </p>
                          </div>

                          {isJavaMod ? (
                            matchedInstance ? (
                              <span
                                className="hidden shrink-0 items-center gap-1 rounded-md border border-success/25 bg-success/10 px-1.5 py-1 font-mono text-[9.5px] text-success lg:flex"
                                title={`将自动安装到 versions/${matchedInstance.id}/mods`}
                              >
                                <CircleCheck className="size-3" />
                                {matchedInstance.id}/mods
                              </span>
                            ) : (
                              <span
                                className="hidden shrink-0 items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-1 text-[9.5px] text-amber-400/90 lg:flex"
                                title={`本地没有 ${describedVersion} 的实例；模组只能安装到对应版本，请先安装该版本`}
                              >
                                <FolderOpen className="size-3" />
                                需先安装 {describedVersion}
                              </span>
                            )
                          ) : null}

                          <Button
                            size="sm"
                            disabled={isBusy || !canDownload}
                            onClick={() => void handleDownload(v)}
                            title={
                              canDownload
                                ? `下载 ${v.versionNumber}`
                                : `本地没有 ${describedVersion} 的实例，装好该版本后才能安装这个模组`
                            }
                            className="h-7 shrink-0 gap-1.5 px-3 text-[11px]"
                          >
                            {isBusy ? (
                              <LoaderCircle className="size-3.5 animate-spin" />
                            ) : isDownloaded ? (
                              <Check className="size-3.5" />
                            ) : (
                              <Download className="size-3.5" />
                            )}
                            {isBusy ? "下载中" : isDownloaded ? "再次下载" : "下载"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
