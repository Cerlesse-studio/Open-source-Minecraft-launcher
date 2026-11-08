import type { EasyTierPublicServer, LocalIpv6Address, MultiplayerConfig, MultiplayerHost } from "./types";

const CONFIG_KEY = "cobble.multiplayer.config.v1";
const HOSTS_KEY = "cobble.multiplayer.hosts.v1";
const PUBLIC_ADDRESS_KEY = "cobble.multiplayer.public-address.v1";
const CUSTOM_SERVERS_KEY = "cobble.multiplayer.custom-servers.v1";

export const DEFAULT_LISTEN_PORT = 11010;
export const DEFAULT_HOST_PORT = 25565;

export const DEFAULT_PUBLIC_SERVER = "tcp://public.easytier.cn:11010";

/** 规范化清理节点输入中的不可见字符、全角冒号与数字 */
export function cleanRelayNodeText(raw: string): string {
  return raw
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    .replace(/：/g, ":")
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\u00A0/g, " ");
}

/**
 * 通用 EasyTier 节点 URI 解析器：
 * 支持 `tcp://host:port`、`udp://host:port`、`ws://`、`wss://`、`quic://`、`wg://`、`txt://`，
 * 也能智能兼容省略协议的 `host:port`、省略端口的 `tcp://host`、裸 IPv6 `240e::1` 等。
 * 不依赖脆弱的 `new URL`（彻底解决 Chromium 对非标准 scheme 解析出空 hostname 导致格式报错的缺陷）。
 */
export function parseServerUri(raw: string): { scheme: string; host: string; port: number; full: string } | null {
  let text = cleanRelayNodeText(raw).trim();
  if (!text) return null;

  // 1. 提取协议 scheme（默认为 tcp）
  let scheme = "tcp";
  const schemeMatch = text.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    text = schemeMatch[2].trim();
  }

  const validSchemes = ["tcp", "udp", "ws", "wss", "quic", "wg", "txt"];
  if (!validSchemes.includes(scheme)) return null;

  // 2. 剥离可能误带的尾随斜杠或路径
  const slashIdx = text.indexOf("/");
  if (slashIdx >= 0) {
    text = text.slice(0, slashIdx).trim();
  }

  let host = "";
  let port: number = scheme === "wss" ? 443 : scheme === "ws" ? 80 : DEFAULT_LISTEN_PORT;
  let hasExplicitPort = false;

  // 3. 解析 IPv6 或 IPv4 / 域名
  if (text.startsWith("[")) {
    const endBracket = text.indexOf("]");
    if (endBracket === -1) return null;
    host = text.slice(1, endBracket).trim();
    const after = text.slice(endBracket + 1).trim();
    if (after.startsWith(":")) {
      const p = Number(after.slice(1));
      if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
      port = p;
      hasExplicitPort = true;
    }
  } else if (text.includes(":") && text.indexOf(":") !== text.lastIndexOf(":")) {
    // 裸 IPv6 地址（含有多个冒号，如 240e:3a1:2000::1）
    host = text;
  } else if (text.includes(":")) {
    // IPv4:port 或 domain:port
    const parts = text.split(":");
    host = parts[0].trim();
    const p = Number(parts[1]);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) return null;
    port = p;
    hasExplicitPort = true;
  } else {
    // 仅域名或 IPv4
    host = text;
  }

  if (!host || /\s/.test(host)) return null;

  const hostForUri = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let full = `${scheme}://${hostForUri}:${port}`;
  if (scheme === "txt") {
    // txt 协议无端口
    full = `txt://${hostForUri}`;
    port = 0;
  } else if (scheme === "wss" && !hasExplicitPort) {
    full = `wss://${hostForUri}`;
  } else if (scheme === "ws" && !hasExplicitPort) {
    full = `ws://${hostForUri}`;
  }

  return { scheme, host, port, full };
}

/** 校验节点 URI 是否合法有效 */
export function isValidServerUri(raw: string): boolean {
  return parseServerUri(raw) !== null;
}

/** 格式化补齐节点 URI */
export function normalizeServerUri(raw: string): string {
  const parsed = parseServerUri(raw);
  return parsed ? parsed.full : raw.trim();
}

/** 共享节点规范化（兼容旧调用） */
export function normalizeRelayNode(raw: string): string | null {
  const parsed = parseServerUri(raw);
  return parsed ? parsed.full : null;
}

/** 读取用户自定义的 EasyTier 节点列表 */
export function loadCustomServers(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_SERVERS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list)
      ? list.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
  } catch {
    return [];
  }
}

/** 保存用户自定义的 EasyTier 节点列表 */
export function saveCustomServers(servers: string[]): void {
  try {
    localStorage.setItem(CUSTOM_SERVERS_KEY, JSON.stringify(servers));
  } catch {
    // 忽略异常
  }
}

/** 社区动态同步节点缓存键名 */
export const COMMUNITY_SERVERS_CACHE_KEY = "cobble_easytier_community_synced_v1";

/**
 * EasyTier 官方与社区免费公益服务器节点列表（全部内置）。
 * 涵盖 EasyTier 官方免费节点以及 https://info.qtet.cn/uptime/easytier 社区监控维护的全部 Relay 服务器。
 * 所有节点均无需玩家自建，即开即用，支持 P2P 穿透打洞与多线路中继转发。
 */
export const OFFICIAL_PUBLIC_SERVERS: EasyTierPublicServer[] = [
  // 官方节点
  {
    id: "official-tcp",
    name: "官方公益节点 (TCP)",
    uri: "tcp://public.easytier.cn:11010",
    region: "全国 BGP 线路",
    description: "EasyTier 官方免费公益节点，自动协助 P2P 打洞与中继转发（推荐）",
    group: "官方推荐",
    author: "EasyTier 官方",
  },
  {
    id: "official-udp",
    name: "官方公益节点 (UDP)",
    uri: "udp://public.easytier.cn:11010",
    region: "全国 BGP 线路",
    description: "UDP 协议通道，延迟低，适合抗丢包网络环境",
    group: "官方推荐",
    author: "EasyTier 官方",
  },
  {
    id: "backup-tcp",
    name: "官方备用节点 (TCP)",
    uri: "tcp://easytier.cn:11010",
    region: "官方备用线路",
    description: "EasyTier 备用公共服务器，主节点负载高时可选用",
    group: "官方推荐",
    author: "EasyTier 官方",
  },
  {
    id: "backup-udp",
    name: "官方备用节点 (UDP)",
    uri: "udp://easytier.cn:11010",
    region: "官方备用线路",
    description: "EasyTier 备用 UDP 公共服务器，低延迟备选",
    group: "官方推荐",
    author: "EasyTier 官方",
  },

  // 社区国内节点 (数据源：https://info.qtet.cn/uptime/easytier)
  {
    id: "community-haibo-shanghai",
    name: "海波 · 上海电信 (TCP)",
    uri: "tcp://225284.xyz:11010",
    region: "上海电信",
    description: "社区优质中继节点，由海波提供，支持 P2P 协助与中继转发",
    group: "国内社区",
    author: "海波",
  },
  {
    id: "community-weiai-xiamen",
    name: "为爱唯爱 · 厦门电信 (TCP)",
    uri: "tcp://easytier.weiai.org.cn:11010",
    region: "厦门电信",
    description: "社区中继节点，由为爱，唯爱提供，电信线路低延迟",
    group: "国内社区",
    author: "为爱，唯爱",
  },
  {
    id: "community-chinokou-wss",
    name: "ChinoKou · EdgeOne (WSS)",
    uri: "wss://et.chinokou.cn",
    region: "EdgeOne CDN",
    description: "WSS 安全中继节点，穿透性极强，适合校园网与受限防火墙环境",
    group: "国内社区",
    author: "ChinoKou",
  },
  {
    id: "community-basd1-zaozhuang",
    name: "宇智波.希 · 枣庄BGP (UDP)",
    uri: "udp://et.basd1.de:11010",
    region: "枣庄 BGP",
    description: "枣庄 BGP 高性能 UDP 中继，由宇智波.希提供",
    group: "国内社区",
    author: "宇智波.希",
  },
  {
    id: "community-cq-crossline",
    name: "Just the Two · 重庆移动 (TCP)",
    uri: "tcp://183.230.36.171:11010",
    region: "重庆移动跨网专线",
    description: "重庆移动跨网专线，适合不同宽带运营商玩家联机穿透中继",
    group: "国内社区",
    author: "Just the Two of Us",
  },
  {
    id: "community-sumnight-shanghai",
    name: "夏夜 · 上海BGP (TCP)",
    uri: "tcp://et.sumnight.top:11010",
    region: "上海 BGP",
    description: "上海 BGP 节点，由夏夜提供（中继限速 500kb，轻量联机）",
    group: "国内社区",
    author: "夏夜",
  },
  {
    id: "community-lctn-yunnan",
    name: "凉城听暖 · 云南联通 (WSS)",
    uri: "wss://et-public.lctn.site",
    region: "云南联通",
    description: "云南联通 WSS 加密节点，由凉城听暖提供，中继性能稳定",
    group: "国内社区",
    author: "凉城听暖",
  },
  {
    id: "community-qicwken-nanchang",
    name: "Qicwken · 南昌电信 (TXT)",
    uri: "txt://net.qicwken.top",
    region: "南昌电信",
    description: "DNS TXT 动态域名解析中继，由 Qicwken 提供",
    group: "国内社区",
    author: "Qicwken",
  },

  // 社区海外/跨境节点 (数据源：https://info.qtet.cn/uptime/easytier)
  {
    id: "community-haibo-crossborder",
    name: "海波 · 云南电信跨境 (UDP)",
    uri: "udp://us01.225284.xyz:11010",
    region: "云南电信跨境",
    description: "跨境专线 UDP 协助节点，由海波提供，海外玩家联机推荐",
    group: "海外跨境",
    author: "海波",
  },
  {
    id: "community-linran-cf",
    name: "林然 · Cloudflare (WSS)",
    uri: "wss://et.xn--mes358a.com",
    region: "Cloudflare 全球",
    description: "海外 CDN 节点（et.南梁.com），由林然提供，全球高可用中继",
    group: "海外跨境",
    author: "林然",
  },
];

/** 从本地缓存中读取动态同步的社区节点 */
export function loadCachedCommunityServers(): EasyTierPublicServer[] {
  try {
    const raw = localStorage.getItem(COMMUNITY_SERVERS_CACHE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * 在线从 info.qtet.cn 同步最新的 EasyTier 社区中继节点。
 * 当网站未来添加新节点时，用户无需升级启动器即可一键同步获取。
 */
export async function syncCommunityRelayNodes(): Promise<{ count: number; servers: EasyTierPublicServer[] }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch("https://info.qtet.cn/uptime/api/status-page/easytier", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const fetched: EasyTierPublicServer[] = [];
    const groups = Array.isArray(data?.publicGroupList) ? data.publicGroupList : [];

    for (const group of groups) {
      const gName = String(group.name || "");
      if (gName.includes("网站") || gName.includes("控制台")) continue;
      const groupCategory = gName.includes("海外") ? "海外跨境" : "国内社区";
      for (const m of group.monitorList || []) {
        const name = String(m.name || "");
        const match = name.match(/((?:tcp|udp|wss|ws|txt):\/\/[^\s（(]+)/i);
        if (!match) continue;
        let uri = match[1].trim();
        if (uri.includes("*")) continue; // 排除打码未公开节点

        let author = "";
        let region = groupCategory;
        const commentMatch = name.match(/[（(]([^）)]+)[）)]/);
        if (commentMatch) {
          const comment = commentMatch[1];
          const parts = comment.split(/[:：]/);
          if (parts.length > 1) {
            author = parts[0].trim();
            region = parts.slice(1).join(" ").trim();
          } else {
            region = comment;
          }
        }

        // 处理中文字符域名 Punycode
        if (uri.includes("et.南梁.com")) {
          uri = "wss://et.xn--mes358a.com";
        }

        const scheme = uri.split("://")[0].toUpperCase();
        const displayName = author ? `${author} (${scheme})` : uri;
        fetched.push({
          id: `synced-${uri}`,
          name: displayName,
          uri,
          region: region || groupCategory,
          description: `来自 info.qtet.cn 社区监控 (${region})`,
          group: groupCategory,
          author: author || undefined,
        });
      }
    }

    if (fetched.length > 0) {
      localStorage.setItem(COMMUNITY_SERVERS_CACHE_KEY, JSON.stringify(fetched));
    }
    return { count: fetched.length, servers: fetched };
  } catch (err) {
    const cached = loadCachedCommunityServers();
    return { count: cached.length, servers: cached };
  }
}

/** 中继节点延迟缓存键名（持久化到 localStorage，避免刷新后延迟数据丢失） */
export const RELAY_LATENCY_CACHE_KEY = "cobble_easytier_latencies_cache_v1";

export interface RelayLatencyCacheEntry {
  latencies: Record<string, number | null>;
  timestamp: number;
}

/** 读取本地持久化的中继节点测速缓存（默认 15 分钟内视为新鲜） */
export function loadCachedServerLatencies(maxAgeMs = 15 * 60 * 1000): {
  latencies: Record<string, number | null>;
  isFresh: boolean;
  timestamp: number;
} {
  try {
    const raw = localStorage.getItem(RELAY_LATENCY_CACHE_KEY);
    if (!raw) return { latencies: {}, isFresh: false, timestamp: 0 };
    const parsed = JSON.parse(raw) as RelayLatencyCacheEntry;
    if (!parsed || typeof parsed.timestamp !== "number" || !parsed.latencies) {
      return { latencies: {}, isFresh: false, timestamp: 0 };
    }
    const isFresh = Date.now() - parsed.timestamp < maxAgeMs;
    return {
      latencies: parsed.latencies,
      isFresh,
      timestamp: parsed.timestamp,
    };
  } catch {
    return { latencies: {}, isFresh: false, timestamp: 0 };
  }
}

/** 保存中继节点测速结果到本地持久化缓存 */
export function saveCachedServerLatencies(latencies: Record<string, number | null>): void {
  try {
    const entry: RelayLatencyCacheEntry = {
      latencies,
      timestamp: Date.now(),
    };
    localStorage.setItem(RELAY_LATENCY_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // 忽略异常
  }
}

/**
 * 房间引导节点（跨中继交汇点）。
 *
 * EasyTier 没有房间目录服务：两个客户端只有「至少连上同一个节点」时，才会
 * 在握手阶段互相发现并出现在成员列表里。房主和访客如果各自选中不同的公益/
 * 自建节点，即使房间名和密码完全一致，也会停留在两张互不相连的孤岛网络上，
 * 表现为「同一个房间却互相看不到」。
 *
 * 下面这组官方节点全球可达，固定追加进每个房间的启动参数（不是把流量交给
 * 它们，只是提供发现入口）。任意两个房间标识相同的客户端因此至少共享一个
 * 引导节点，跨中继也能发现彼此；实际数据链路仍按 EasyTier 的延迟优先策略
 * 走最优直连或最优中继。
 */
export const ROOM_BRIDGE_RELAYS = [
  "tcp://public.easytier.cn:11010",
  "udp://public.easytier.cn:11010",
  "tcp://easytier.cn:11010",
] as const;

/** 兼容旧名字：这些节点同时承担「多线路冗余兜底」的角色。 */
export const FALLBACK_REDUNDANT_RELAYS: readonly string[] = ROOM_BRIDGE_RELAYS;

/** 一个房间最多携带的引导节点数：足够跨中继，又不至于让启动握手变慢。 */
const MAX_ROOM_RELAY_PEERS = 8;

/**
 * 是否已经登记过同一个节点。
 *
 * `tcp://` 和 `udp://` 指向同一台机器的不同传输入口，EasyTier 视为两条独立
 * 连接，所以只按完整 URI（忽略大小写）判重，不按域名合并。
 */
function hasSameRelay(list: readonly string[], uri: string): boolean {
  const target = uri.trim().toLowerCase();
  return Boolean(target) && list.some((item) => item.trim().toLowerCase() === target);
}

/** 中继 URI 去重（保持首次出现顺序），非法项直接丢掉。 */
function uniqueRelayNodes(nodes: Iterable<string>): string[] {
  const peers: string[] = [];
  for (const raw of nodes) {
    if (typeof raw !== "string") continue;
    const node = normalizeRelayNode(raw);
    if (node && !hasSameRelay(peers, node)) peers.push(node);
  }
  return peers;
}

/**
 * 房间的权威引导节点清单：房主声明的节点在前，官方交汇节点追加在后。
 *
 * 房主以这份清单启动；访客先通过 buildGuestRelayPeers 放入自己的本机
 * 节点，再并入这份清单。两份清单都包含官方交汇节点，任取两个客户端
 * 至少有一个共同入口，同时各自保留本机可用的中继。
 */
export function buildRoomRelayPeers(hostNodes: Iterable<string> = []): string[] {
  const bridgeSlots = ROOM_BRIDGE_RELAYS.length;
  // 给交汇节点预留位置，房主再多的自建节点也不能把它们挤掉。
  const peers = uniqueRelayNodes(hostNodes).slice(0, MAX_ROOM_RELAY_PEERS - bridgeSlots);
  if (peers.length === 0) peers.push(DEFAULT_PUBLIC_SERVER);
  for (const bridge of ROOM_BRIDGE_RELAYS) {
    if (!hasSameRelay(peers, bridge)) peers.push(bridge);
  }
  return peers.slice(0, MAX_ROOM_RELAY_PEERS);
}

/**
 * 访客侧的中继节点清单。
 *
 * 分享码加入不能直接把房主的节点表当成访客的节点表：房主选中的中继在
 * 访客所在网络可能被屏蔽。访客先连自己当前网络测速优选/手动指定的节点，
 * 再并入房主声明的节点和公共交汇节点；这样本机至少有一条可用入口，
 * 同时仍能通过共同节点发现房主。
 */
export function buildGuestRelayPeers(
  localServer: string,
  hostNodes: Iterable<string> = [],
): string[] {
  return buildRoomRelayPeers([localServer, ...hostNodes]);
}

/**
 * 构造高可用多线路中继与对等节点列表。
 * 将优选的主节点置于首位（首要连接与分享标识），
 * 同时按需追加官方高可用公益中继作为冗余备用，
 * 避免单一节点瞬间不可达或丢包时导致 EasyTier 无法连接或异常退出。
 */
export function buildMultiplayerPeers(primaryServer: string): string[] {
  return buildRoomRelayPeers([primaryServer]);
}

/**
 * 房间标识归一化。
 *
 * EasyTier 的 `--network-name` 区分大小写和空白：房主写 `MC-Room`、访客写
 * `mc-room ` 会各自建一张网络，房间号再一致也永远看不到对方。分享码、回执码
 * 和内核参数统一经过这里，保证「房间标识匹配」只有一种写法。
 */
export function normalizeRoomName(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, 48);
}

/** 两个房间标识归一化后是否同一个房间（分享码 / 回执码校验用）。 */
export function isSameRoom(a: string, b: string): boolean {
  return normalizeRoomName(a) === normalizeRoomName(b);
}

/**
 * 智能补全/推导节点延迟（针对 UDP 或 WSS 等协议节点）：
 * 当同域名/主机的 TCP 节点测出延迟时，UDP 节点可共享该主机延迟作为可靠参考。
 */
export function inferServerLatencies(
  servers: EasyTierPublicServer[],
  rawLatencies: Record<string, number | null>,
): Record<string, number | null> {
  const merged: Record<string, number | null> = { ...rawLatencies };

  // 建立 host -> latency 映射（取同 host 下最低有效延迟）
  const hostLatencyMap = new Map<string, number>();
  for (const [uri, lat] of Object.entries(rawLatencies)) {
    if (typeof lat === "number" && lat > 0) {
      const parsed = parseServerUri(uri);
      if (parsed) {
        const existing = hostLatencyMap.get(parsed.host);
        if (existing === undefined || lat < existing) {
          hostLatencyMap.set(parsed.host, lat);
        }
      }
    }
  }

  // 为未测出延迟但同 host 有有效 TCP 延迟的节点补齐参考延迟
  for (const server of servers) {
    if (merged[server.uri] === null || merged[server.uri] === undefined) {
      const parsed = parseServerUri(server.uri);
      if (parsed && hostLatencyMap.has(parsed.host)) {
        merged[server.uri] = hostLatencyMap.get(parsed.host)!;
      }
    }
  }

  return merged;
}

/**
 * 分批并发探测节点列表的握手延迟，避免瞬间大并发造成网络丢包或超时。
 */
export async function batchProbeMultiplayerLatencies(
  servers: EasyTierPublicServer[],
  batchSize = 4,
  probeFn: (peer: string) => Promise<{ reachable: boolean | null; latencyMs: number | null }>,
): Promise<Record<string, number | null>> {
  const results: Record<string, number | null> = {};

  // 优先测官方推荐节点，再测社区节点与自建节点
  const sorted = [...servers].sort((a, b) => {
    if (a.group === "官方推荐" && b.group !== "官方推荐") return -1;
    if (a.group !== "官方推荐" && b.group === "官方推荐") return 1;
    return 0;
  });

  for (let i = 0; i < sorted.length; i += batchSize) {
    const chunk = sorted.slice(i, i + batchSize);
    await Promise.all(
      chunk.map(async (server) => {
        try {
          // 如果是 UDP 节点，同时尝试 probe 对应的同端口 tcp 节点以大幅提高测速成功率
          let targetUri = server.uri;
          if (server.uri.startsWith("udp://")) {
            targetUri = server.uri.replace("udp://", "tcp://");
          }
          const probe = await probeFn(targetUri);
          results[server.uri] = probe.reachable ? probe.latencyMs : null;
        } catch {
          results[server.uri] = null;
        }
      }),
    );
  }

  const finalized = inferServerLatencies(servers, results);
  saveCachedServerLatencies(finalized);
  return finalized;
}

/**
 * 从可用服务器列表和测速结果中挑选延迟最低的中继节点。
 * 默认优先挑选有效连通且延迟绝对最低的节点；
 * 若无有效测速结果或节点均不可达，回退到 fallbackUri 或 DEFAULT_PUBLIC_SERVER。
 */
export function pickFastestRelayServer(
  servers: EasyTierPublicServer[],
  latencies: Record<string, number | null>,
  fallbackUri = DEFAULT_PUBLIC_SERVER,
): string {
  let bestUri = fallbackUri;
  let minLatency = Infinity;
  for (const server of servers) {
    const lat = latencies[server.uri];
    if (typeof lat === "number" && lat > 0 && lat < minLatency) {
      minLatency = lat;
      bestUri = server.uri;
    }
  }
  return bestUri;
}

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

/** 随机生成一个友好易记的房间名称（Astral 风格）。 */
export function createRoomName(): string {
  const prefixes = ["星空", "方块", "生存", "探险", "末影", "红石", "浮空", "像素"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = randomFrom("23456789abcdefghjkmnpqrstuvwxyz", 4);
  return `${prefix}-${suffix}`;
}

export const ROOM_NETWORK_NAME = "cobble";

/** 房间密码长度区间：至少 6 位，支持自定义。 */
export const ROOM_PASSWORD_MIN = 6;
export const ROOM_PASSWORD_MAX = 32;

/** 随机生成一个方便口述的房间密码（跳过容易看错的 0/o/1/l）。 */
export function createRoomPassword(): string {
  return randomFrom("abcdefghijkmnpqrstuvwxyz23456789", 6);
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
 * 房间资源清单的令牌。房主按密码算出来，访客用同一个密码算出一模一样的值。
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

/** 虚拟网段（10.126.126.0/24），两端互相理解。 */
export function createOverlayIpv4(): string {
  return `10.126.126.${2 + Math.floor(Math.random() * 250)}`;
}

/** 虚拟 IPv4 必须是 a.b.c.d 且每段 0-255。 */
export function isOverlayIpv4(value: string): boolean {
  const parts = value.trim().split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 纯 P2P：不连共享节点，只允许已验证的直连链路。 */
export function isPureP2p(config: Pick<MultiplayerConfig, "relay" | "p2pOnly">): boolean {
  return config.p2pOnly && !config.relay;
}

/** EasyTier 的 IPv6 打洞从 2.3.0 开始默认可用。 */
export function supportsIpv6P2p(version: string | null | undefined): boolean {
  const match = (version ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 2 || (major === 2 && (minor > 3 || (minor === 3 && patch >= 0)));
}

export function defaultMultiplayerConfig(): MultiplayerConfig {
  const secret = createRoomPassword();
  return {
    networkName: createRoomName(),
    networkSecret: secret,
    overlayIpv4: createOverlayIpv4(),
    // 新配置默认走纯 IPv6 P2P：没有 seed 节点、没有公共 STUN，
    // 也不会因为 peers 为空而在后端回落到公益节点。仍然可以在创建页
    // 一键切回公益节点模式。
    peers: [],
    listenPort: DEFAULT_LISTEN_PORT,
    hostPort: DEFAULT_HOST_PORT,
    hostVersion: "",
    hostIpv4: "",
    role: "host",
    publicServer: "",
    relay: false,
    p2pOnly: true,
    allowPublicStun: false,
    relayNodes: [],
    hostEntry: "",
    recvBpsLimit: 0,
    resourcePort: roomResourcePort(secret),
    resourceToken: roomResourceToken(secret),
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
  const peers = Array.isArray(value.peers)
    ? value.peers.filter((peer): peer is string => typeof peer === "string" && Boolean(peer.trim()))
    : [];
  const p2pOnly = value.p2pOnly === true;
  const storedRelayNodes = normalizeRelayNodes(value.relayNodes);
  const relayNodes = p2pOnly
    ? storedRelayNodes
    : storedRelayNodes.length > 0
      ? storedRelayNodes
      : [DEFAULT_PUBLIC_SERVER];
  // 纯 P2P 房主可以没有任何 seed 节点，等待访客回执后再加；
  // 不能在这里回落到公益节点，否则会悄悄重连第三方中继。
  // 旧配置里残留的共享节点也必须丢掉：纯 P2P 只接受 IPv6 入口。
  const p2pPeers = peers.filter((peer) => Boolean(ipv6FromPeer(peer)));
  const finalPeers = p2pOnly ? p2pPeers : peers.length > 0 ? peers : relayNodes;
  const publicServer = p2pOnly
    ? ""
    : value.publicServer || finalPeers[0] || DEFAULT_PUBLIC_SERVER;
  return {
    networkName:
      typeof value.networkName === "string" && normalizeRoomName(value.networkName)
        ? normalizeRoomName(value.networkName)
        : base.networkName,
    networkSecret:
      typeof value.networkSecret === "string" ? value.networkSecret.trim().slice(0, 64) : "",
    overlayIpv4:
      typeof value.overlayIpv4 === "string" && isOverlayIpv4(value.overlayIpv4)
        ? value.overlayIpv4.trim()
        : base.overlayIpv4,
    peers: finalPeers,
    listenPort: clampPort(value.listenPort, DEFAULT_LISTEN_PORT),
    hostPort: clampPort(value.hostPort, DEFAULT_HOST_PORT),
    hostVersion:
      typeof value.hostVersion === "string" ? value.hostVersion.trim().slice(0, 64) : "",
    hostIpv4: typeof value.hostIpv4 === "string" ? value.hostIpv4.trim() : "",
    role: normalizeRole(value, finalPeers),
    publicServer,
    relay: p2pOnly ? false : value.relay === true,
    p2pOnly,
    allowPublicStun: p2pOnly ? false : value.allowPublicStun !== false,
    relayNodes,
    hostEntry: normalizeHostEntry(value, finalPeers),
    recvBpsLimit: clampBps(value.recvBpsLimit),
    resourcePort: clampResourcePort(value.resourcePort),
    resourceToken: resourceToken(value.resourceToken),
  };
}

function normalizeRole(
  value: Partial<MultiplayerConfig>,
  peers: string[],
): "host" | "guest" {
  if (value.role === "host" || value.role === "guest") return value.role;
  // 旧配置没有显式角色：有对等节点或房主虚拟地址的，是访客。
  return peers.length > 0 || Boolean(value.hostIpv4?.trim()) ? "guest" : "host";
}

function normalizeRelayNodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const nodes: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const node = normalizeRelayNode(item);
    if (node && !nodes.includes(node)) nodes.push(node);
  }
  return nodes.slice(0, 8);
}

function normalizeHostEntry(value: Partial<MultiplayerConfig>, peers: string[]): string {
  if (typeof value.hostEntry === "string" && value.hostEntry.trim()) {
    return value.hostEntry.trim();
  }
  // 旧分享码把房主入口放在 peers[0]；中继房主的 peers 是共享节点，不能误当房主。
  if (value.role === "host" || value.relay === true) return "";
  return peers[0] ?? "";
}

/**
 * 从网页/聊天软件复制地址时经常混入零宽空格、全角冒号等字符，
 * 它们在界面上看不出来，却会让 `new URL()` 直接失败。
 */
/** 把一行或逗号分隔的共享节点整理成去重列表。 */
export function parseRelayNodes(text: string): string[] {
  const nodes: string[] = [];
  for (const part of text.split(/[\s,;，；]+/)) {
    if (!part) continue;
    const node = normalizeRelayNode(part);
    if (node && !nodes.includes(node)) nodes.push(node);
  }
  return nodes.slice(0, 8);
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
      networkName: normalizeRoomName(value.networkName),
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

export type MultiplayerMode = "relay" | "p2p";

export interface ShareInfo {
  networkName: string;
  networkSecret: string;
  publicServer?: string;
  hostVersion?: string;
  /** 房主的 EasyTier 入口地址，例如 `udp://[240e:…]:11010` 或 `tcp://1.2.3.4:11010`。 */
  peer: string | null;
  /** 房主在虚拟网络里的 IPv4 地址。 */
  hostIpv4: string;
  hostPort: number;
  /** `relay` 走公益节点；`p2p` 只允许双方 IPv6 直连，无中继。 */
  mode: MultiplayerMode;
  /** 房主和访客都连接共享节点，不要求房主有公网地址。 */
  relay: boolean;
  /** 直连房间禁止中继，只允许已建立的 P2P 链路。 */
  p2pOnly: boolean;
  /** 纯 P2P 模式不联系公共 STUN。 */
  allowPublicStun: boolean;
  /** 双方 EasyTier 监听端口；纯 P2P 分享码里由房主决定。 */
  listenPort: number;
  relayNodes: string[];
  /** 房主的只读房间资源列表入口；旧分享码没有这两项。 */
  resourcePort: number;
  resourceToken: string;
}

/**
 * 一键分享码：Astral 风格 URL 格式，包含房间名、密码、公共服务器以及房主虚拟 IP 和端口。
 * `cobble-mp://join?name=…&secret=…&server=…&r=…&ip=…&port=…&res=…&rt=…`
 */
export function buildShareCode(config: MultiplayerConfig, _legacyAddress = ""): string {
  const params = new URLSearchParams();
  params.set("name", normalizeRoomName(config.networkName));
  params.set("secret", config.networkSecret);
  params.set("ip", config.overlayIpv4);
  params.set("port", String(config.hostPort));
  if (isPureP2p(config)) {
    params.set("mode", "p2p");
    if (config.hostEntry) params.set("peer", config.hostEntry);
    params.set("lp", String(config.listenPort));
  } else {
    // 房主实际连着的全部引导节点都写进分享码。EasyTier 没有房间目录，
    // 访客只有连到和房主相同的节点才能发现彼此；旧版只带 `server` 一个
    // 节点，一旦房主换了节点或它在访客侧不互通，访客就落进另一张孤岛网络。
    const publicServer = (config.publicServer ?? "").trim();
    const declared = config.relayNodes.length > 0 ? config.relayNodes : config.peers;
    const nodes = buildRoomRelayPeers([publicServer, ...declared]);
    const primary = publicServer || nodes[0] || DEFAULT_PUBLIC_SERVER;
    params.set("server", primary);
    for (const node of nodes) {
      if (node !== primary) params.append("r", node);
    }
  }
  if (config.hostVersion) {
    params.set("v", config.hostVersion);
  }
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
  const networkName = normalizeRoomName(params.get("name") ?? "");
  const networkSecret = (params.get("secret") ?? "").trim();
  const hostIpv4 = (params.get("ip") ?? "").trim();
  const hostPort = clampPort(params.get("port"), DEFAULT_HOST_PORT);
  if (!networkName || !networkSecret) return null;
  const modeParam = (params.get("mode") ?? "").trim().toLowerCase();
  const p2p = modeParam === "p2p";
  const peerParam = (params.get("peer") ?? params.get("server") ?? "").trim();
  // `r` 是房主声明的完整引导节点清单（可重复出现），`server` 是主节点。
  // 两者合并去重后才能还原房主的真实网络位置，跨中继也不会漏掉交汇节点。
  const declaredRelayNodes = uniqueRelayNodes(params.getAll("r"));
  const parsedPeer = peerParam ? parseServerUri(peerParam) : null;
  if (p2p && (!parsedPeer || !ipv6FromPeer(parsedPeer.full))) return null;
  const server = peerParam ? normalizeRelayNode(peerParam) : null;
  const hostRelayNodes = p2p
    ? []
    : uniqueRelayNodes([server ?? "", ...declaredRelayNodes]);
  const finalServer = p2p ? "" : (hostRelayNodes[0] || DEFAULT_PUBLIC_SERVER);
  const hostVersion = (params.get("v") ?? "").trim();
  const listenPort = p2p
    ? clampPort(params.get("lp") ?? parsedPeer?.port, parsedPeer?.port ?? DEFAULT_LISTEN_PORT)
    : DEFAULT_LISTEN_PORT;
  return {
    networkName,
    networkSecret,
    publicServer: p2p ? undefined : finalServer,
    hostVersion: hostVersion || undefined,
    peer: parsedPeer?.full ?? finalServer,
    hostIpv4,
    hostPort,
    mode: p2p ? "p2p" : "relay",
    relay: !p2p,
    p2pOnly: p2p,
    allowPublicStun: !p2p,
    listenPort,
    relayNodes: p2p
      ? []
      : hostRelayNodes.length > 0
        ? hostRelayNodes
        : [DEFAULT_PUBLIC_SERVER],
    resourcePort: clampResourcePort(params.get("res")),
    resourceToken: resourceToken(params.get("rt")),
  };
}

/** 访客把本机公网 IPv6 入口回传给房主，房主再加进 EasyTier。 */
export interface PeerReceipt {
  networkName: string;
  /** 访客的 EasyTier 入口，例如 `udp://[240e:…]:11010`。 */
  peer: string;
}

export function buildPeerReceipt(
  config: MultiplayerConfig,
  addresses?: LocalIpv6Address[],
  preferredAddress = "",
): string {
  // 优先用户显式选择的地址，其次稳定地址；临时地址会轮换，不适合发给房主。
  const address =
    addresses?.find(
      (item) => item.global && item.address === preferredAddress.trim(),
    ) ??
    addresses?.find((item) => item.global && !item.temporary) ??
    addresses?.find((item) => item.global);
  if (!address || !isIpv6Literal(address.address)) return "";
  const peer = peerFromAddress(address.address, config.listenPort);
  if (!peer) return "";
  const params = new URLSearchParams();
  params.set("name", normalizeRoomName(config.networkName));
  params.set("peer", peer);
  return `cobble-mp://reply?${params.toString()}`;
}

export function parsePeerReceipt(text: string): PeerReceipt | null {
  const source = text.trim();
  const match = source.match(/cobble-mp:\/\/reply[^\s"'<>]+/i);
  const raw = match ? match[0] : source;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "cobble-mp:") return null;
  const networkName = normalizeRoomName(url.searchParams.get("name") ?? "");
  const peerParam = (url.searchParams.get("peer") ?? "").trim();
  if (!networkName || !peerParam) return null;
  const peer = parseServerUri(peerParam);
  if (!peer || !isIpv6Literal(peer.host)) return null;
  return { networkName, peer: peer.full };
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

export interface DirectEntry {
  /** 房主的主机名或 IP，不带方括号。 */
  address: string;
  /** 房主的 EasyTier 监听端口。 */
  port: number;
  /** 可直接写进配置的对等入口，例如 `tcp://[240e:…]:11010`。 */
  peer: string;
}

function isIpv4Literal(value: string): boolean {
  const parts = value.trim().split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isHostname(value: string): boolean {
  if (value.length > 253 || !value.includes(".")) return false;
  return value
    .split(".")
    .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/**
 * 直接填写房主入口加入房间：IPv6、IPv4 或域名都行。
 * 接受 `240e:…`、`[240e:…]:11010`、`1.2.3.4:11010`、`mc.example.com`
 * 以及带 `tcp://` / `udp://` 前缀的写法。
 *
 * 裸 IPv6 不按最后一个 `:` 拆端口——`240e::1:11010` 本身就是合法地址；
 * 要指定端口请用方括号写法。
 */
export function parseDirectEntry(
  input: string,
  fallbackPort = DEFAULT_LISTEN_PORT,
): DirectEntry | null {
  const trimmed = input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (!trimmed) return null;
  const parsed = parseHostAddress(trimmed, fallbackPort);
  if (!parsed) return null;
  const address = parsed.host.trim();
  if (!address || /[\s/?#]/.test(address)) return null;
  if (!isIpv4Literal(address) && !isIpv6Literal(address) && !isHostname(address)) return null;
  return { address, port: parsed.port, peer: peerFromAddress(address, parsed.port) };
}

/** 兼容旧调用名；直连入口现在也接受 IPv4 和域名。 */
export const parseIpv6Entry = parseDirectEntry;
export type Ipv6Entry = DirectEntry;

/** 从 `tcp://[IPv6]:11010`、`[IPv6]:11010` 或裸 IPv6 里取出主机。 */
export function ipv6FromPeer(peer: string): string | null {
  const value = peer.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (!value) return null;
  const host = parseHostAddress(value, DEFAULT_LISTEN_PORT)?.host.trim() ?? "";
  return host.includes(":") ? host : null;
}

/**
 * 把地址格式化成 EasyTier 入口 URI。IPv6 优先用 UDP：
 * 双方同时向对方发包时，UDP 更容易在状态防火墙上建立回程。
 */
export function peerFromAddress(address: string, listenPort: number): string {
  const clean = address.trim().replace(/^\[|\]$/g, "");
  if (!clean) return "";
  return clean.includes(":")
    ? `udp://[${clean}]:${listenPort}`
    : `tcp://${clean}:${listenPort}`;
}

/** 旧配置/旧分享码里的 IPv6 TCP 入口统一升级成 UDP。 */
export function preferUdpForIpv6(peer: string): string {
  const trimmed = peer.trim();
  if (!trimmed) return "";
  if (/^tcp:\/\/\[/i.test(trimmed)) return trimmed.replace(/^tcp:\/\//i, "udp://");
  if (/^\[[0-9a-f:]+\]/i.test(trimmed)) return `udp://${trimmed}`;
  return trimmed;
}
