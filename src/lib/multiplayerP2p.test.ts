import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PUBLIC_SERVER,
  buildPeerReceipt,
  buildGuestRelayPeers,
  buildRoomRelayPeers,
  buildShareCode,
  defaultMultiplayerConfig,
  isSameRoom,
  normalizeMultiplayerConfig,
  normalizeRoomName,
  parsePeerReceipt,
  parseShareCode,
  pickFastestRelayServer,
  buildMultiplayerPeers,
  inferServerLatencies,
  FALLBACK_REDUNDANT_RELAYS,
  ROOM_BRIDGE_RELAYS,
  supportsIpv6P2p,
} from "./multiplayer.ts";

const HOST_IPV6 = "240e:3b5:7a2c:1f60:8d21:44c7:1b0a:9f3e";

function pureP2pConfig() {
  return {
    ...defaultMultiplayerConfig(),
    networkName: "p2p-room",
    networkSecret: "secret123",
    overlayIpv4: "10.144.144.1",
    hostPort: 25565,
    listenPort: 11010,
    hostEntry: `udp://[${HOST_IPV6}]:11010`,
    role: "host" as const,
  };
}

test("new configs default to pure P2P without public peers or STUN", () => {
  const config = defaultMultiplayerConfig();
  assert.equal(config.p2pOnly, true);
  assert.equal(config.relay, false);
  assert.equal(config.allowPublicStun, false);
  assert.deepEqual(config.peers, []);
  assert.deepEqual(config.relayNodes, []);
  assert.equal(config.publicServer, "");
});

test("share code round-trips a pure P2P host entry without a relay server", () => {
  const config = pureP2pConfig();
  const code = buildShareCode(config);
  assert.match(code, /mode=p2p/);
  assert.match(code, /peer=udp%3A%2F%2F%5B240e/);
  assert.doesNotMatch(code, /server=/);

  const parsed = parseShareCode(code);
  assert.ok(parsed);
  assert.equal(parsed.mode, "p2p");
  assert.equal(parsed.p2pOnly, true);
  assert.equal(parsed.relay, false);
  assert.equal(parsed.allowPublicStun, false);
  assert.equal(parsed.peer, `udp://[${HOST_IPV6}]:11010`);
  assert.equal(parsed.listenPort, 11010);
});

test("a P2P share code with a non-IPv6 peer is rejected", () => {
  const config = pureP2pConfig();
  const code = buildShareCode(config).replace(
    encodeURIComponent(`udp://[${HOST_IPV6}]:11010`),
    encodeURIComponent("tcp://public.easytier.cn:11010"),
  );
  assert.equal(parseShareCode(code), null);
});

test("peer receipt round-trips and prefers a stable global address", () => {
  const config = pureP2pConfig();
  const receipt = buildPeerReceipt(config, [
    {
      address: "240e:3b5:7a2c:1f60:1c2a:9b3e:57d0:4a11",
      interface: "WLAN",
      global: true,
      temporary: true,
    },
    {
      address: HOST_IPV6,
      interface: "WLAN",
      global: true,
      temporary: false,
    },
  ]);
  assert.match(receipt, /^cobble-mp:\/\/reply\?/);
  const parsed = parsePeerReceipt(receipt);
  assert.ok(parsed);
  assert.equal(parsed.networkName, "p2p-room");
  assert.equal(parsed.peer, `udp://[${HOST_IPV6}]:11010`);

  const temporary = "240e:3b5:7a2c:1f60:1c2a:9b3e:57d0:4a11";
  const selected = parsePeerReceipt(buildPeerReceipt(config, [
    {
      address: HOST_IPV6,
      interface: "WLAN",
      global: true,
      temporary: false,
    },
    {
      address: temporary,
      interface: "WLAN",
      global: true,
      temporary: true,
    },
  ], temporary));
  assert.equal(selected?.peer, `udp://[${temporary}]:11010`);
});

test("old P2P configs cannot smuggle a public relay back in", () => {
  const config = normalizeMultiplayerConfig({
    ...pureP2pConfig(),
    p2pOnly: true,
    relay: true,
    peers: [DEFAULT_PUBLIC_SERVER, `udp://[${HOST_IPV6}]:11010`],
    publicServer: DEFAULT_PUBLIC_SERVER,
    allowPublicStun: true,
  });
  assert.deepEqual(config.peers, [`udp://[${HOST_IPV6}]:11010`]);
  assert.equal(config.relay, false);
  assert.equal(config.publicServer, "");
  assert.equal(config.allowPublicStun, false);
});

test("IPv6 P2P requires EasyTier 2.3.0 or newer", () => {
  assert.equal(supportsIpv6P2p("v2.2.9"), false);
  assert.equal(supportsIpv6P2p("v2.3.0"), true);
  assert.equal(supportsIpv6P2p("v2.6.4"), true);
  assert.equal(supportsIpv6P2p(null), false);
});

test("pickFastestRelayServer picks lowest latency reachable server and falls back", () => {
  const dummyServers = [
    { id: "s1", name: "S1", uri: "tcp://s1.example.com:11010", region: "CN", description: "", group: "官方推荐" },
    { id: "s2", name: "S2", uri: "tcp://s2.example.com:11010", region: "CN", description: "", group: "官方推荐" },
    { id: "s3", name: "S3", uri: "tcp://s3.example.com:11010", region: "CN", description: "", group: "国内社区" },
  ];

  // When latencies are available, lowest positive latency is chosen
  const best = pickFastestRelayServer(dummyServers, {
    "tcp://s1.example.com:11010": 120,
    "tcp://s2.example.com:11010": 25,
    "tcp://s3.example.com:11010": 45,
  });
  assert.equal(best, "tcp://s2.example.com:11010");

  // When no servers are reachable, fallback is returned
  const fallback = pickFastestRelayServer(dummyServers, {
    "tcp://s1.example.com:11010": null,
    "tcp://s2.example.com:11010": null,
  }, DEFAULT_PUBLIC_SERVER);
  assert.equal(fallback, DEFAULT_PUBLIC_SERVER);

  // When latencies are empty, fallback is returned
  assert.equal(pickFastestRelayServer(dummyServers, {}), DEFAULT_PUBLIC_SERVER);
});

test("buildMultiplayerPeers builds redundant peer list with primary node first", () => {
  const primary = "tcp://custom.myserver.org:11010";
  const peers = buildMultiplayerPeers(primary);
  assert.equal(peers[0], primary);
  assert.ok(peers.length > 1);
  for (const fallback of FALLBACK_REDUNDANT_RELAYS) {
    assert.ok(peers.includes(fallback));
  }
  // No duplicates
  assert.equal(new Set(peers).size, peers.length);
});

test("inferServerLatencies infers UDP node latency from same host TCP latency", () => {
  const servers = [
    { id: "s1", name: "TCP Node", uri: "tcp://public.easytier.cn:11010", region: "CN", description: "", group: "官方推荐" },
    { id: "s2", name: "UDP Node", uri: "udp://public.easytier.cn:11010", region: "CN", description: "", group: "官方推荐" },
    { id: "s3", name: "Other Node", uri: "tcp://other.host.cn:11010", region: "CN", description: "", group: "国内社区" },
  ];
  const raw = {
    "tcp://public.easytier.cn:11010": 20,
    "udp://public.easytier.cn:11010": null,
    "tcp://other.host.cn:11010": 80,
  };
  const inferred = inferServerLatencies(servers, raw);
  assert.equal(inferred["udp://public.easytier.cn:11010"], 20);
  assert.equal(inferred["tcp://other.host.cn:11010"], 80);
});

test("relay share code carries every host relay so a guest can bridge across relays", () => {
  const hostRelay = "tcp://relay-a.example.com:11010";
  const guestRelay = "udp://relay-b.example.net:11010";
  const hostNodes = buildRoomRelayPeers([hostRelay]);
  const hostConfig = {
    ...defaultMultiplayerConfig(),
    networkName: "星空-abcd",
    networkSecret: "secret123",
    relay: true,
    p2pOnly: false,
    allowPublicStun: true,
    publicServer: hostRelay,
    peers: hostNodes,
    relayNodes: hostNodes,
  };

  const code = buildShareCode(hostConfig);
  assert.match(code, /server=tcp%3A%2F%2Frelay-a/);
  assert.match(code, /[?&]r=/, "其余房主节点要写进 r 参数");

  const parsed = parseShareCode(code);
  assert.ok(parsed);
  assert.equal(parsed.publicServer, hostRelay);
  assert.ok(parsed.relayNodes.includes(hostRelay));
  for (const bridge of ROOM_BRIDGE_RELAYS) {
    assert.ok(parsed.relayNodes.includes(bridge), `分享码应带上交汇节点 ${bridge}`);
  }

  // 访客自己的节点和房主不同：本机节点仍排在最前，同时保留房主节点
  // 与公共交汇节点作为发现入口。
  const guestNodes = buildGuestRelayPeers(guestRelay, [
    parsed.publicServer ?? "",
    ...parsed.relayNodes,
  ]);
  assert.equal(guestNodes[0], guestRelay);
  const shared = guestNodes.filter((peer) => parsed.relayNodes.includes(peer));
  assert.ok(shared.length > 0, "不同中继下的客户端必须有共同引导节点");
});

test("a single isolated relay still gets a public bridge node", () => {
  const peers = buildRoomRelayPeers(["tcp://only-node.example.com:11010"]);
  assert.equal(peers[0], "tcp://only-node.example.com:11010");
  assert.ok(peers.length > 1);
  // 房主再多自建节点也不能把交汇节点挤掉。
  const crowded = buildRoomRelayPeers(
    Array.from({ length: 20 }, (_, index) => `tcp://node-${index}.example.com:11010`),
  );
  assert.ok(crowded.some((peer) => (ROOM_BRIDGE_RELAYS as readonly string[]).includes(peer)));
});

test("guest relay peers put the guest's own reachable node before the host's list", () => {
  const guestRelay = "udp://guest-local.example.net:11010";
  const hostNodes = [
    "tcp://host-a.example.com:11010",
    "udp://host-b.example.com:11010",
  ];
  const peers = buildGuestRelayPeers(guestRelay, hostNodes);
  assert.equal(peers[0], guestRelay);
  for (const node of hostNodes) assert.ok(peers.includes(node));
  for (const bridge of ROOM_BRIDGE_RELAYS) assert.ok(peers.includes(bridge));
  assert.equal(new Set(peers).size, peers.length);
});

test("guest local node is not dropped by a crowded host relay list", () => {
  const guestRelay = "tcp://guest-local.example.net:11010";
  const hostNodes = Array.from({ length: 20 }, (_, index) => `tcp://host-${index}.example.com:11010`);
  const peers = buildGuestRelayPeers(guestRelay, hostNodes);
  assert.equal(peers[0], guestRelay);
  assert.ok(peers.length <= 8);
  for (const bridge of ROOM_BRIDGE_RELAYS) assert.ok(peers.includes(bridge));
});

test("room identity ignores stray whitespace but keeps EasyTier case sensitivity", () => {
  assert.equal(normalizeRoomName("  星空  abcd "), "星空 abcd");
  assert.ok(isSameRoom(" 星空-abcd", "星空-abcd "));
  assert.ok(!isSameRoom("MC-Room", "mc-room"), "EasyTier 网络名区分大小写");
  assert.ok(!isSameRoom("room-1", "room-2"));
});
