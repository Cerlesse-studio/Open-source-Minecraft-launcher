import type { MultiplayerConfig, MultiplayerHost } from "./types";

const CONFIG_KEY = "cobble.multiplayer.config.v1";
const HOSTS_KEY = "cobble.multiplayer.hosts.v1";
const PUBLIC_ADDRESS_KEY = "cobble.multiplayer.public-address.v1";

export const DEFAULT_LISTEN_PORT = 11010;
export const DEFAULT_HOST_PORT = 25565;

function randomFrom(alphabet: string, length: number): string {
  const values = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(values);
  } else {
    for (let i = 0; i < length; i += 1) values[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[values[i] % alphabet.length];
  }
  return out;
}

/**
 * 房间的网络名固定不变：EasyTier 的网络身份由「网络名 + 密码」共同决定，
 * 实测密码不同的两个节点会被直接拒绝（network identity not match）。
 * 所以密码就是房间本身——访客只填房主 IPv6 和密码就能进同一间房，
 * 不必再额外对网络名。
 */
export const ROOM_NETWORK_NAME = "cobble";

/** 房间密码长度区间：太短挡不住扫网段的人，太长不方便口述。 */
export const ROOM_PASSWORD_MIN = 6;
export const ROOM_PASSWORD_MAX = 32;

/** 随机生成一个方便口述的房间密码（跳过容易看错的 0/o/1/l）。 */
export function createRoomPassword(): string {
  return randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 8);
}

/** 房间密码：可见 ASCII、不含空格，长度 6–32。 */
export function isRoomPassword(value: string): boolean {
  const password = value.trim();
  return (
    password.length >= ROOM_PASSWORD_MIN &&
    password.length <= ROOM_PASSWORD_MAX &&
    /^[\x21-\x7e]+$/.test(password)
  );
}

const RESOURCE_ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 32 位 FNV-1a；只用来把密码摊成稳定的令牌/端口，不做密码学用途。 */
function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) & 0xff;
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 房间资源清单的令牌。房主按密码算出来，只输 IPv6 的访客用同一个密码
 * 算出一模一样的值就能读到清单；密码本身就是这间房的信任边界。
 */
export function roomResourceToken(password: string): string {
  const secret = password.trim();
  let out = "";
  let state = fnv1a(`cobble-room|${secret}`, 0x811c_9dc5);
  while (out.length < 32) {
    state = fnv1a(`${secret}|${out.length}`, state);
    let value = state;
    for (let index = 0; index < 4 && out.length < 32; index += 1) {
      out += RESOURCE_ALPHABET[value % RESOURCE_ALPHABET.length];
      value = Math.floor(value / RESOURCE_ALPHABET.length);
    }
  }
  return out;
}

/** 房间资源服务的端口，20 000–39 999：避开常用端口，也不落在系统临时端口段。 */
export function roomResourcePort(password: string): number {
  return 20_000 + (fnv1a(`cobble-port|${password.trim()}`, 0x27d4_eb2f) % 20_000);
}

/** 虚拟网段与 MCTier 相同（10.126.126.0/24），便于两端互相理解分享码。 */
export function createOverlayIpv4(): string {
  return `10.126.126.${2 + Math.floor(Math.random() * 250)}`;
}

/** 虚拟 IPv4 必须是 a.b.c.d 且每段 0-255，否则内核会直接拒绝启动。 */
export function isOverlayIpv4(value: string): boolean {
  const parts = value.trim().split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function defaultMultiplayerConfig(): MultiplayerConfig {
  return {
    networkName: ROOM_NETWORK_NAME,
    // 房间密码由房主在创建房间时设置；这里不预生成，避免用户跳过输入。
    networkSecret: "",
    overlayIpv4: createOverlayIpv4(),
    peers: [],
    listenPort: DEFAULT_LISTEN_PORT,
    hostPort: DEFAULT_HOST_PORT,
    hostVersion: "",
    hostIpv4: "",
    recvBpsLimit: 0,
    resourcePort: 0,
    resourceToken: "",
  };
}

function clampPort(value: unknown, fallback: number): number {
  const port = typeof value === "number" ? Math.round(value) : Number(value);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : fallback;
}

/** 资源端口允许为 0：表示还没启动，启动后由后端分配。 */
function clampResourcePort(value: unknown): number {
  const port = typeof value === "number" ? Math.round(value) : Number(value);
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : 0;
}

function resourceToken(value: unknown): string {
  if (typeof value !== "string") return "";
  const token = value.trim();
  return /^[A-Za-z0-9]{8,64}$/.test(token) ? token : "";
}

/** Never trust localStorage: an old or hand-edited value must not break start. */
export function normalizeMultiplayerConfig(raw: unknown): MultiplayerConfig {
  const base = defaultMultiplayerConfig();
  if (!raw || typeof raw !== "object") return base;
  const value = raw as Partial<MultiplayerConfig>;
  return {
    // 网络名固定：房间身份只由密码决定，旧配置里的随机名一并归位，
    // 否则老配置开出来的房间，只输 IPv6 的访客对不上。
    networkName: ROOM_NETWORK_NAME,
    // 旧配置里的密码继续保留，已有房间和分享码不会因此失效。
    networkSecret:
      typeof value.networkSecret === "string" ? value.networkSecret.trim().slice(0, 64) : "",
    overlayIpv4:
      typeof value.overlayIpv4 === "string" && isOverlayIpv4(value.overlayIpv4)
        ? value.overlayIpv4.trim()
        : base.overlayIpv4,
    peers: Array.isArray(value.peers)
      ? value.peers.filter((peer): peer is string => typeof peer === "string" && Boolean(peer.trim()))
      : [],
    listenPort: clampPort(value.listenPort, DEFAULT_LISTEN_PORT),
    hostPort: clampPort(value.hostPort, DEFAULT_HOST_PORT),
    hostVersion:
      typeof value.hostVersion === "string" ? value.hostVersion.trim().slice(0, 64) : "",
    hostIpv4: typeof value.hostIpv4 === "string" ? value.hostIpv4.trim() : "",
    recvBpsLimit: clampBps(value.recvBpsLimit),
    resourcePort: clampResourcePort(value.resourcePort),
    resourceToken: resourceToken(value.resourceToken),
  };
}

/** 访客带宽上限：0 表示不限，其余取 1 KB/s – 10 GB/s 之间的整数。 */
function clampBps(value: unknown): number {
  const limit = typeof value === "number" ? Math.round(value) : Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.max(limit, 1024), 10 * 1024 * 1024 * 1024);
}

export function loadMultiplayerConfig(): MultiplayerConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultMultiplayerConfig();
    return normalizeMultiplayerConfig(JSON.parse(raw));
  } catch {
    return defaultMultiplayerConfig();
  }
}

export function saveMultiplayerConfig(config: MultiplayerConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // 配置存不下来也不影响本次联机。
  }
}

function normalizeHosts(raw: unknown): MultiplayerHost[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is MultiplayerHost => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Partial<MultiplayerHost>;
      return typeof value.host === "string" && Boolean(value.host.trim());
    })
    .map((entry) => ({
      id: entry.id || `${entry.host}:${entry.port ?? DEFAULT_HOST_PORT}`,
      label: entry.label || entry.host,
      host: entry.host,
      port: clampPort(entry.port, DEFAULT_HOST_PORT),
      status: entry.status ?? null,
      // 代理端口属于上一次运行，启动器重开后需要重新广播。
      bridgePort: null,
      checkedAt: entry.checkedAt,
    }))
    .slice(0, 40);
}

export function loadMultiplayerHosts(): MultiplayerHost[] {
  try {
    const raw = localStorage.getItem(HOSTS_KEY);
    return raw ? normalizeHosts(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveMultiplayerHosts(hosts: MultiplayerHost[]): void {
  try {
    localStorage.setItem(
      HOSTS_KEY,
      JSON.stringify(
        hosts.map((entry) => ({
          ...entry,
          bridgePort: null,
          status: entry.status ?? null,
        })),
      ),
    );
  } catch {
    // 同上，历史记录不是关键数据。
  }
}

const ROOM_KEY = "cobble.multiplayer.room.v1";

/**
 * 上一间开着的房间。内核只活在启动器进程里（关掉启动器、切出去让游戏
 * 接管窗口都可能把它结束掉），但房间本身——密码、房主入口——都在
 * 配置里；记住角色和密码，重进联机页就能把同一间房接回来。
 */
export interface ActiveRoom {
  role: "host" | "guest";
  networkName: string;
  startedAt: number;
}

export function loadActiveRoom(): ActiveRoom | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<ActiveRoom>;
    if (value.role !== "host" && value.role !== "guest") return null;
    if (typeof value.networkName !== "string" || !value.networkName.trim()) return null;
    return {
      role: value.role,
      networkName: value.networkName.trim(),
      startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

/** 传 null 表示用户主动解散了房间。 */
export function saveActiveRoom(room: ActiveRoom | null): void {
  try {
    if (room) localStorage.setItem(ROOM_KEY, JSON.stringify(room));
    else localStorage.removeItem(ROOM_KEY);
  } catch {
    // 记不住不影响本次联机。
  }
}

export function loadPublicAddress(): string {
  try {
    return localStorage.getItem(PUBLIC_ADDRESS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function savePublicAddress(address: string): void {
  try {
    localStorage.setItem(PUBLIC_ADDRESS_KEY, address);
  } catch {
    // ignore
  }
}

export interface ShareInfo {
  networkName: string;
  networkSecret: string;
  /** 房主的 EasyTier 入口地址，例如 `tcp://[240e:…]:11010`。 */
  peer: string | null;
  /** 房主在虚拟网络里的 IPv4 地址。 */
  hostIpv4: string;
  hostPort: number;
  /** 房主的只读房间资源列表入口；旧分享码没有这两项。 */
  resourcePort: number;
  resourceToken: string;
}

/**
 * 分享码是一个普通 URL，聊天软件里可以整段粘贴：
 * `cobble-mp://join?name=…&secret=…&peer=…&ip=…&port=…&res=…&rt=…`
 */
export function buildShareCode(config: MultiplayerConfig, publicAddress: string): string {
  const params = new URLSearchParams();
  params.set("name", config.networkName);
  params.set("secret", config.networkSecret);
  params.set("ip", config.overlayIpv4);
  params.set("port", String(config.hostPort));
  const peer = publicAddress.trim();
  if (peer) params.set("peer", peer);
  if (config.resourcePort > 0 && config.resourceToken) {
    params.set("res", String(config.resourcePort));
    params.set("rt", config.resourceToken);
  }
  return `cobble-mp://join?${params.toString()}`;
}

export function parseShareCode(text: string): ShareInfo | null {
  const source = text.trim();
  if (!source) return null;
  // 允许把整段聊天记录粘进来：只取其中的分享码。
  const match = source.match(/cobble-mp:\/\/[^\s"'<>]+/i);
  const raw = match ? match[0] : source;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "cobble-mp:") return null;
  const params = url.searchParams;
  const networkName = (params.get("name") ?? "").trim();
  const networkSecret = (params.get("secret") ?? "").trim();
  const hostIpv4 = (params.get("ip") ?? "").trim();
  const hostPort = clampPort(params.get("port"), DEFAULT_HOST_PORT);
  if (!networkName || !networkSecret || !hostIpv4) return null;
  const peer = (params.get("peer") ?? "").trim();
  return {
    networkName,
    networkSecret,
    peer: peer || null,
    hostIpv4,
    hostPort,
    resourcePort: clampResourcePort(params.get("res")),
    resourceToken: resourceToken(params.get("rt")),
  };
}

/** `[240e::1]:25565`、`10.126.126.7:25565` 或裸地址都能解析。 */
export function parseHostAddress(
  input: string,
  fallbackPort = DEFAULT_HOST_PORT,
): { host: string; port: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) return null;
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : fallbackPort;
    return host && Number.isInteger(port) && port > 0 && port < 65536 ? { host, port } : null;
  }
  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon > 0 && firstColon === lastColon) {
    const host = trimmed.slice(0, lastColon);
    const port = Number(trimmed.slice(lastColon + 1));
    if (host && Number.isInteger(port) && port > 0 && port < 65536) return { host, port };
  }
  return { host: trimmed, port: fallbackPort };
}

function isIpv6Literal(value: string): boolean {
  const text = value.trim();
  if (!text.includes(":")) return false;
  try {
    // 方括号里只接受合法的 IPv6；非法分组会直接抛错。
    new URL(`http://[${text}]/`);
    return true;
  } catch {
    return false;
  }
}

export interface Ipv6Entry {
  /** 房主公网 IPv6，不带方括号。 */
  address: string;
  /** 房主的 EasyTier 监听端口。 */
  port: number;
  /** 可直接写进配置的对等入口，例如 `tcp://[240e:…]:11010`。 */
  peer: string;
}

/**
 * 只输 IPv6 加入房间。接受 `240e:…`、`[240e:…]`、`[240e:…]:11010`
 * 以及 `tcp://[240e:…]:11010`。
 *
 * 裸地址不按最后一个 `:` 拆端口——`240e::1:11010` 本身就是合法地址；
 * 要指定端口请用方括号写法。
 */
export function parseIpv6Entry(
  input: string,
  fallbackPort = DEFAULT_LISTEN_PORT,
): Ipv6Entry | null {
  const trimmed = input.trim().replace(/^(?:tcp|udp):\/\//i, "");
  if (!trimmed) return null;
  let address = trimmed;
  let port = fallbackPort;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 0) return null;
    address = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1).trim();
    if (rest.startsWith(":")) {
      const parsed = Number(rest.slice(1));
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return null;
      port = parsed;
    } else if (rest) {
      return null;
    }
  }
  const clean = address.trim();
  if (!isIpv6Literal(clean)) return null;
  return { address: clean, port, peer: peerFromAddress(clean, port) };
}

/** 从 `tcp://[IPv6]:11010`、`[IPv6]:11010` 或裸 IPv6 里取出主机。 */
export function ipv6FromPeer(peer: string): string | null {
  const value = peer.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (!value) return null;
  const host = parseHostAddress(value, DEFAULT_LISTEN_PORT)?.host.trim() ?? "";
  return host.includes(":") ? host : null;
}

/** 把 IPv6 地址格式化成 EasyTier 入口 URI。 */
export function peerFromAddress(address: string, listenPort: number): string {
  const clean = address.trim().replace(/^\[|\]$/g, "");
  if (!clean) return "";
  return clean.includes(":") ? `tcp://[${clean}]:${listenPort}` : `tcp://${clean}:${listenPort}`;
}
