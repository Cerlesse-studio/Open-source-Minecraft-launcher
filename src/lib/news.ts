const FEED_URL = "https://launchercontent.mojang.com/v2/javaPatchNotes.json";
const IMAGE_BASE = "https://launchercontent.mojang.com";
const CACHE_MS = 5 * 60 * 1000;
const STORAGE_KEY = "cobble.patch-notes.cache.v1";

export interface PatchNote {
  id: string;
  title: string;
  version: string;
  type: string;
  date: string;
  summary: string;
  imageUrl: string | null;
}

interface RawPatchNote {
  id?: string;
  title?: string;
  version?: string;
  type?: string;
  date?: string;
  shortText?: string;
  image?: { url?: string };
}

interface PatchNoteFeed {
  entries?: RawPatchNote[];
}

function loadStorageCache(): { at: number; entries: PatchNote[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
      return parsed;
    }
  } catch {}
  return null;
}

function saveStorageCache(entries: PatchNote[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), entries }));
  } catch {}
}

let cache: { at: number; entries: PatchNote[] } | null = loadStorageCache();

function cleanText(value?: string): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function imageUrl(value?: string): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${IMAGE_BASE}${value.startsWith("/") ? "" : "/"}${value}`;
}

/** The channel a patch note belongs to, judged from its version string. */
export function channelLabel(note: PatchNote): string {
  const version = note.version.toLowerCase();
  if (version.includes("-rc-")) return "候选版";
  if (version.includes("-pre-")) return "预发布";
  if (version.includes("snapshot")) return "快照";
  if (note.type === "release") return "正式版";
  return "更新";
}

export function isRelease(note: PatchNote): boolean {
  return note.type === "release" && !note.version.toLowerCase().includes("-rc-");
}

export async function getPatchNotes(force = false): Promise<PatchNote[]> {
  // If we already have cache in memory or localStorage:
  // On startup (force = false), return immediately if fresh, or if stale return cached immediately while refreshing in background.
  if (!force && cache && cache.entries.length > 0) {
    if (Date.now() - cache.at < CACHE_MS) {
      return cache.entries;
    }
    // Stale cache: return cached notes right away so the UI loads instantly, and refresh in the background
    void fetchFromRemote().catch(() => {});
    return cache.entries;
  }

  return fetchFromRemote();
}

async function fetchFromRemote(): Promise<PatchNote[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 4000);
  let response: Response;
  try {
    response = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    if (cache && cache.entries.length > 0) {
      return cache.entries;
    }
    if (controller.signal.aborted) {
      throw new Error("连接 Mojang 更新服务超时");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    if (cache && cache.entries.length > 0) {
      return cache.entries;
    }
    throw new Error(`更新日志请求失败 (HTTP ${response.status})`);
  }

  const feed = (await response.json()) as PatchNoteFeed;
  const entries = (feed.entries ?? [])
    .filter(
      (entry): entry is RawPatchNote & { id: string; title: string; version: string } =>
        Boolean(entry.id && entry.title && entry.version),
    )
    .slice(0, 12)
    .map((entry) => ({
      id: entry.id,
      title: cleanText(entry.title),
      version: entry.version,
      type: entry.type ?? "snapshot",
      date: entry.date ?? "",
      summary: cleanText(entry.shortText),
      imageUrl: imageUrl(entry.image?.url),
    }));

  cache = { at: Date.now(), entries };
  saveStorageCache(entries);
  return entries;
}
