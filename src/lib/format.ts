export function typeLabel(type: string): string {
  switch (type) {
    case "release":
      return "正式版";
    case "snapshot":
      return "快照";
    case "april_fools":
      return "愚人节限定";
    case "old_beta":
      return "Beta";
    case "old_alpha":
      return "Alpha";
    default:
      return type || "未知";
  }
}

export function typeTone(type: string): "grass" | "gold" | "muted" {
  if (type === "release") return "grass";
  if (type === "snapshot") return "gold";
  return "muted";
}

export function formatDate(iso?: string, locale = "zh-CN"): string {
  if (!iso) return "未知日期";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知日期";
  return date.toLocaleDateString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function formatRelativeDate(iso?: string): string {
  if (!iso) return "未知日期";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知日期";

  const diff = Date.now() - date.getTime();
  if (diff < 0) return formatDate(iso);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;

  const days = Math.floor(diff / day);
  if (days < 30) return `${days} 天前`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;

  return `${Math.floor(months / 12)} 年前`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

export function formatSpeed(bytesPerSec?: number): string {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "0 B/s";
  }
  return `${formatBytes(bytesPerSec)}/s`;
}

/**
 * 任务管理器/路由器按 Mbps（兆比特每秒）显示速率，而下载器按 KB/s 显示字节速率。
 * 845 KB/s 其实是 6.9 Mbps，同屏给出换算值，免得被当成只有 8 Mbps 带宽的十分之一。
 */
export function formatBitRate(bytesPerSec?: number): string {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "0 Mbps";
  }
  const mbps = (bytesPerSec * 8) / 1_000_000;
  return `${mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`;
}

export function progressPercent(done: number, total: number): number | null {
  if (!total || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

export function stageLabel(stage: string): string {
  switch (stage) {
    case "prepare":
      return "准备";
    case "client":
      return "客户端";
    case "libraries":
      return "依赖库";
    case "assets":
      return "资源文件";
    case "addons":
      return "加载器与附加工具";
    case "java":
      return "Java";
    case "launch":
      return "启动";
    case "downloading":
      return "下载中";
    case "extracting":
      return "解压";
    case "done":
      return "完成";
    default:
      return stage || "处理中";
  }
}

export function shortPath(path: string, max = 38): string {
  if (!path) return "未设置";
  if (path.length <= max) return path;
  const head = path.slice(0, 10);
  const tail = path.slice(-(max - 13));
  return `${head}…${tail}`;
}

export function timeNow(): string {
  return new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function joinPath(root: string, ...parts: string[]): string {
  if (!root) return parts.join("/");
  const separator = root.includes("\\") ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  return [base, ...parts].join(separator);
}

export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/** Game directory the launcher uses for a Java version under the current
 * isolation mode. Mirrors the backend resolver so folder hints and downloads
 * point at the same `saves/` the game reads. */
export function resolveJavaGameDir(
  gameRoot: string,
  versionId: string,
  isolation: string | undefined,
  isModded: boolean,
): string {
  const mode = isolation || "all";
  if (mode === "none") return gameRoot;
  if (mode === "modded" && !isModded) return gameRoot;
  if (!versionId) return gameRoot;
  return joinPath(gameRoot, "versions", versionId);
}

export function pathUnderRoot(path: string, root: string): string {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  if (!normalizedRoot) return path;
  if (path === normalizedRoot) return ".";
  const prefix = `${normalizedRoot}/`;
  const windowsPrefix = `${normalizedRoot}\\`;
  if (path.startsWith(prefix)) return path.slice(prefix.length).replace(/\\/g, "/");
  if (path.startsWith(windowsPrefix)) return path.slice(windowsPrefix.length).replace(/\\/g, "/");
  return path;
}

/**
 * Rewrite GitHub and GitHub Raw URLs to jsDelivr CDN URLs to accelerate image/asset loading.
 * Supports:
 * - https://raw.githubusercontent.com/:owner/:repo/:branch/:path
 * - https://github.com/:owner/:repo/raw/:branch/:path
 * - https://github.com/:owner/:repo/blob/:branch/:path?raw=true
 */
export function toJsdelivrUrl(url: string | null | undefined): string {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";

  // https://raw.githubusercontent.com/:owner/:repo/:branch/:path
  const rawMatch = trimmed.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i);
  if (rawMatch) {
    const [, owner, repo, branch, path] = rawMatch;
    return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`;
  }

  // https://github.com/:owner/:repo/raw/:branch/:path
  const ghRawMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/([^/]+)\/(.+)$/i);
  if (ghRawMatch) {
    const [, owner, repo, branch, path] = ghRawMatch;
    return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`;
  }

  // https://github.com/:owner/:repo/blob/:branch/:path?raw=true
  const ghBlobMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/([^?#]+)(?:\?.*raw=true.*)?$/i);
  if (ghBlobMatch && trimmed.includes("raw=true")) {
    const [, owner, repo, branch, path] = ghBlobMatch;
    return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`;
  }

  return trimmed;
}
