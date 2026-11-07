import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PUBLIC_SERVER,
  OFFICIAL_RELAY_CLUSTER,
  OFFICIAL_PUBLIC_SERVERS,
  buildMultiplayerPeers,
  buildShareCode,
  clusterOfServer,
  defaultMultiplayerConfig,
  normalizeMultiplayerConfig,
  parseShareCode,
  relayClusterGuaranteed,
  serversInCluster,
} from "./multiplayer.ts";

const COMMUNITY_NODE = "tcp://225284.xyz:11010";
const CUSTOM_NODE = "tcp://vps.example.com:11010";

function relayConfig(server: string, peers: string[] = []) {
  return {
    ...defaultMultiplayerConfig(),
    networkName: "relay-room",
    networkSecret: "secret123",
    overlayIpv4: "10.144.144.1",
    hostPort: 25565,
    listenPort: 11010,
    role: "host" as const,
    relay: true,
    p2pOnly: false,
    allowPublicStun: true,
    publicServer: server,
    peers: peers.length > 0 ? peers : buildMultiplayerPeers(server),
    relayNodes: peers.length > 0 ? peers : buildMultiplayerPeers(server),
  };
}

test("official public relays share one cluster, community nodes stand alone", () => {
  const official = clusterOfServer(DEFAULT_PUBLIC_SERVER);
  assert.equal(official, OFFICIAL_RELAY_CLUSTER);
  // 四个官方入口（tcp/udp × 两个域名）都是同一个集群，可以互为备用。
  for (const uri of [
    "udp://public.easytier.cn:11010",
    "tcp://easytier.cn:11010",
    "udp://easytier.cn:11010",
  ]) {
    assert.equal(clusterOfServer(uri), OFFICIAL_RELAY_CLUSTER);
  }

  // 社区节点没有集群信息时按主机名独立，绝不能当成和官方集群兼容。
  assert.notEqual(clusterOfServer(COMMUNITY_NODE), OFFICIAL_RELAY_CLUSTER);
  assert.equal(clusterOfServer(COMMUNITY_NODE), "standalone:225284.xyz");
  assert.equal(clusterOfServer(CUSTOM_NODE), "standalone:vps.example.com");
});

test("only the official cluster is a guaranteed common meeting point", () => {
  assert.equal(relayClusterGuaranteed(DEFAULT_PUBLIC_SERVER), true);
  assert.equal(relayClusterGuaranteed(COMMUNITY_NODE), false);
  assert.equal(relayClusterGuaranteed(CUSTOM_NODE), false);
});

test("peer lists never mix independent relays with the official cluster", () => {
  const officialPeers = buildMultiplayerPeers(DEFAULT_PUBLIC_SERVER);
  for (const peer of officialPeers) {
    assert.equal(clusterOfServer(peer), OFFICIAL_RELAY_CLUSTER);
  }

  assert.deepEqual(buildMultiplayerPeers(COMMUNITY_NODE), [COMMUNITY_NODE]);
  assert.deepEqual(buildMultiplayerPeers(CUSTOM_NODE), [CUSTOM_NODE]);

  // 同集群的备用入口来自目录，而不是硬编码的官方列表。
  const cluster = serversInCluster(OFFICIAL_RELAY_CLUSTER);
  assert.ok(cluster.includes("tcp://public.easytier.cn:11010"));
  assert.ok(!cluster.includes(COMMUNITY_NODE));
});

test("share code carries the host cluster and its full same-cluster entry list", () => {
  const config = relayConfig(DEFAULT_PUBLIC_SERVER);
  const code = buildShareCode(config);
  assert.match(code, /cluster=easytier-official/);

  const parsed = parseShareCode(code);
  assert.ok(parsed);
  assert.equal(parsed.cluster, OFFICIAL_RELAY_CLUSTER);
  assert.equal(parsed.publicServer, DEFAULT_PUBLIC_SERVER);
  // 访客照抄房主的整组入口，才能保证落在同一个集群里。
  assert.deepEqual(parsed.relayNodes, buildMultiplayerPeers(DEFAULT_PUBLIC_SERVER));
  assert.deepEqual(
    parsed.relayNodes.map((uri) => clusterOfServer(uri)),
    parsed.relayNodes.map(() => OFFICIAL_RELAY_CLUSTER),
  );
});

test("a community relay room shares exactly that node, never the official cluster", () => {
  const config = relayConfig(COMMUNITY_NODE);
  const code = buildShareCode(config);

  const parsed = parseShareCode(code);
  assert.ok(parsed);
  assert.equal(parsed.cluster, "standalone:225284.xyz");
  assert.equal(parsed.publicServer, COMMUNITY_NODE);
  assert.deepEqual(parsed.relayNodes, [COMMUNITY_NODE]);
  assert.ok(!parsed.relayNodes.some((uri) => uri.includes("easytier.cn")));
});

test("share codes without a cluster field still parse (older hosts)", () => {
  const code = buildShareCode(relayConfig(DEFAULT_PUBLIC_SERVER)).replace(/&cluster=[^&]+/, "");
  const parsed = parseShareCode(code);
  assert.ok(parsed);
  assert.equal(parsed.cluster, undefined);
  assert.equal(parsed.publicServer, DEFAULT_PUBLIC_SERVER);
});

test("relay nodes built for a room are all reachable from the parsed share code", () => {
  for (const server of [DEFAULT_PUBLIC_SERVER, COMMUNITY_NODE, CUSTOM_NODE]) {
    const config = relayConfig(server);
    const parsed = parseShareCode(buildShareCode(config));
    assert.ok(parsed);
    const cluster = parsed.cluster ?? clusterOfServer(parsed.publicServer ?? "");
    for (const uri of parsed.relayNodes) {
      assert.equal(clusterOfServer(uri), cluster, `${uri} 不应跨集群进入 ${server} 房间`);
    }
    assert.ok(parsed.relayNodes.includes(server));
  }
});

test("an old mixed peer list is collapsed to the primary node's cluster on load", () => {
  // 旧版本会把社区节点和官方集群一起存进 peers / relayNodes。
  const legacy = normalizeMultiplayerConfig({
    networkName: "old-room",
    networkSecret: "secret123",
    overlayIpv4: "10.144.144.9",
    role: "host",
    relay: true,
    p2pOnly: false,
    allowPublicStun: true,
    publicServer: COMMUNITY_NODE,
    peers: [COMMUNITY_NODE, "tcp://public.easytier.cn:11010", "udp://public.easytier.cn:11010"],
    relayNodes: [COMMUNITY_NODE, "tcp://public.easytier.cn:11010"],
  });

  assert.deepEqual(legacy.peers, [COMMUNITY_NODE]);
  assert.deepEqual(legacy.relayNodes, [COMMUNITY_NODE]);
  assert.equal(legacy.relayCluster, "standalone:225284.xyz");

  // 官方集群的旧配置则保留整个官方集群作备用（没有 cluster 字段，要推导）。
  const official = normalizeMultiplayerConfig({
    networkName: "old-room",
    networkSecret: "secret123",
    overlayIpv4: "10.144.144.9",
    role: "host",
    relay: true,
    p2pOnly: false,
    publicServer: DEFAULT_PUBLIC_SERVER,
    peers: [DEFAULT_PUBLIC_SERVER, "tcp://easytier.cn:11010", CUSTOM_NODE],
    relayNodes: [DEFAULT_PUBLIC_SERVER, CUSTOM_NODE],
  });
  assert.deepEqual(official.peers, [DEFAULT_PUBLIC_SERVER, "tcp://easytier.cn:11010"]);
  assert.deepEqual(official.relayNodes, [DEFAULT_PUBLIC_SERVER]);
  assert.equal(official.relayCluster, OFFICIAL_RELAY_CLUSTER);
});

test("the public relay catalog keeps exactly one official cluster", () => {
  const officialCount = OFFICIAL_PUBLIC_SERVERS.filter(
    (server) => server.cluster === OFFICIAL_RELAY_CLUSTER,
  ).length;
  assert.equal(officialCount, 4);
  // 社区节点不允许被误标成官方集群。
  const community = OFFICIAL_PUBLIC_SERVERS.filter((server) => server.group === "国内社区");
  assert.ok(community.length > 0);
  for (const server of community) {
    assert.notEqual(server.cluster, OFFICIAL_RELAY_CLUSTER);
  }
});
