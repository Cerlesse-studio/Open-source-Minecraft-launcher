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

export function formatDate(iso?: string): string {
  if (!iso) return "未知日期";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "未知日期";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
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
