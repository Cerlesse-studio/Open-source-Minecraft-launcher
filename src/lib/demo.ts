import type {
  BedrockContentItem,
  BedrockLoadersCatalog,
  BedrockModItem,
  BedrockStatus,
  BedrockVersionItem,
  ContentHit,
  ContentProjectType,
  ContentVersionItem,
  DownloadContentRequest,
  DownloadContentResult,
  GameExitPayload,
  GameLogPayload,
  GameStatus,
  InstallPackResult,
  InstallProgress,
  InstallResult,
  InstalledVersion,
  JavaInstall,
  LaunchRequest,
  LoaderSelection,
  SearchContentResult,
  SystemInfo,
  VersionLoadersCatalog,
  VersionManifest,
} from "./types";

export interface DemoEventMap {
  "install:progress": InstallProgress;
  "game:log": GameLogPayload;
  "game:status": GameStatus;
  "game:exit": GameExitPayload;
}

export type DemoEventName = keyof DemoEventMap;
type Listener = (payload: never) => void;

const listeners = new Map<DemoEventName, Set<Listener>>();

export function demoSubscribe<K extends DemoEventName>(
  event: K,
  handler: (payload: DemoEventMap[K]) => void,
): () => void {
  const set = listeners.get(event) ?? new Set<Listener>();
  set.add(handler as Listener);
  listeners.set(event, set);
  return () => {
    set.delete(handler as Listener);
  };
}

function emit<K extends DemoEventName>(event: K, payload: DemoEventMap[K]): void {
  listeners.get(event)?.forEach((handler) => {
    (handler as (value: DemoEventMap[K]) => void)(payload);
  });
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const VERSIONS: Array<[string, string, string]> = [
  ["26.4-snapshot-5", "snapshot", "2026-10-23T07:12:00Z"],
  ["26.3", "release", "2026-09-15T11:23:02Z"],
  ["26.4-snapshot-4", "snapshot", "2026-10-16T07:10:00Z"],
  ["26.2", "release", "2026-08-11T10:14:00Z"],
  ["26.1", "release", "2026-06-23T09:40:00Z"],
  ["1.21.8", "release", "2026-04-08T12:18:00Z"],
  ["1.21.7", "release", "2026-02-19T10:05:00Z"],
  ["1.21.1", "release", "2025-08-08T09:32:00Z"],
  ["1.20.6", "release", "2025-04-29T11:44:00Z"],
  ["1.20.1", "release", "2023-06-12T12:26:00Z"],
  ["1.19.4", "release", "2023-03-14T10:00:00Z"],
  ["1.18.2", "release", "2022-02-28T10:05:00Z"],
  ["1.16.5", "release", "2021-01-14T16:05:00Z"],
  ["1.12.2", "release", "2017-09-18T12:20:00Z"],
  ["1.8.9", "release", "2015-12-09T13:40:00Z"],
  ["1.7.10", "release", "2014-06-26T12:30:00Z"],
  ["1.5.2", "release", "2013-05-02T12:00:00Z"],
  ["b1.7.3", "old_beta", "2011-07-11T12:00:00Z"],
  ["a1.2.6", "old_alpha", "2010-12-03T12:00:00Z"],
];

let installed: InstalledVersion[] = [
  { id: "1.21.8", type: "release", installedAt: Date.parse("2026-10-22T09:20:00Z") / 1000 },
  { id: "1.20.1", type: "release", installedAt: Date.parse("2026-09-03T18:42:00Z") / 1000 },
];

const javaInstalls: JavaInstall[] = [
  {
    path: "C:\\Program Files\\Eclipse Adoptium\\jre-21.0.8.9\\bin\\java.exe",
    major: 21,
    version: "21.0.8+9-LTS",
    source: "系统安装",
  },
  {
    path: "C:\\Program Files\\Java\\jdk-17.0.12\\bin\\java.exe",
    major: 17,
    version: "17.0.12",
    source: "系统安装",
  },
];

let installing: string | null = null;
let gameRunning = false;
let gameTimers: number[] = [];

export function demoManifest(): VersionManifest {
  return {
    latest: { release: "26.3", snapshot: "26.4-snapshot-5" },
    versions: VERSIONS.map(([id, type, releaseTime]) => ({
      id,
      type,
      url: "",
      releaseTime,
      time: releaseTime,
    })),
  };
}

export function demoInstalledVersions(): InstalledVersion[] {
  return installed.map((entry) => ({ ...entry }));
}

export function demoSystemInfo(): SystemInfo {
  return {
    defaultRoot: "C:\\Users\\you\\.cobble",
    os: "windows",
    arch: "x86_64",
    javaInstalls: javaInstalls.map((java) => ({ ...java })),
    gameRunning,
    launcherVersion: "0.1.0",
  };
}

export function demoDetectJava(): JavaInstall[] {
  return javaInstalls.map((java) => ({ ...java }));
}

export async function demoVersionLoaders(
  mcVersion: string,
): Promise<VersionLoadersCatalog> {
  await sleep(180);
  const isSnapshot = mcVersion.includes("snapshot") || mcVersion.includes("w");
  const isLegacy = mcVersion.startsWith("b") || mcVersion.startsWith("a");
  if (isLegacy) {
    return {
      mcVersion,
      forge: [],
      neoforge: [],
      fabric: [],
      quilt: [],
      optifine: [],
      fabricApi: [],
    };
  }
  return {
    mcVersion,
    forge: isSnapshot
      ? []
      : [
          {
            version: "54.1.0",
            stable: true,
            releaseTime: "2026-10-12T10:00:00Z",
            subtitle: "推荐稳定版",
          },
          {
            version: "54.0.28",
            stable: false,
            releaseTime: "2026-10-02T08:30:00Z",
            subtitle: "最新构建",
          },
          {
            version: "54.0.19",
            stable: false,
            releaseTime: "2026-09-20T14:15:00Z",
            subtitle: "正式构建",
          },
        ],
    neoforge: isSnapshot
      ? []
      : [
          {
            version: "21.4.88",
            stable: true,
            releaseTime: "2026-10-18T11:20:00Z",
            subtitle: "稳定版",
          },
          {
            version: "21.4.85-beta",
            stable: false,
            releaseTime: "2026-10-10T09:10:00Z",
            subtitle: "Beta 构建",
          },
        ],
    fabric: [
      {
        version: "0.16.10",
        stable: true,
        subtitle: "推荐稳定版",
      },
      {
        version: "0.16.9",
        stable: true,
        subtitle: "稳定版",
      },
      {
        version: "0.16.8",
        stable: true,
        subtitle: "稳定版",
      },
    ],
    quilt: [
      {
        version: "0.27.1",
        stable: true,
        subtitle: "稳定版",
      },
      {
        version: "0.27.0-beta.4",
        stable: false,
        subtitle: "测试版",
      },
    ],
    optifine:
      isSnapshot || mcVersion.startsWith("26.")
        ? []
        : [
            {
              version: "HD_U_J3",
              stable: true,
              subtitle: "高清修复正式版",
              fileName: `OptiFine_${mcVersion}_HD_U_J3.jar`,
            },
            {
              version: "HD_U_J3_pre4",
              stable: false,
              subtitle: "预览版 (Preview)",
              fileName: `preview_OptiFine_${mcVersion}_HD_U_J3_pre4.jar`,
            },
          ],
    fabricApi: [
      {
        version: `0.115.1+${mcVersion}`,
        stable: true,
        releaseTime: "2026-10-19T12:00:00Z",
        subtitle: `[${mcVersion}] Fabric API 0.115.1`,
        fileName: `fabric-api-0.115.1+${mcVersion}.jar`,
        size: 2_340_000,
      },
      {
        version: `0.115.0+${mcVersion}`,
        stable: true,
        releaseTime: "2026-10-04T12:00:00Z",
        subtitle: `[${mcVersion}] Fabric API 0.115.0`,
        fileName: `fabric-api-0.115.0+${mcVersion}.jar`,
        size: 2_310_000,
      },
    ],
  };
}

export async function demoInstall(
  versionId: string,
  concurrency = 16,
  selection?: LoaderSelection,
): Promise<InstallResult> {
  const targetId = selection?.instanceName?.trim() || versionId;
  if (installing) {
    throw new Error(`正在安装 ${installing}，请等待当前任务完成`);
  }
  installing = targetId;
  const threads = Math.min(64, Math.max(1, concurrency || 16));
  const clientTotalBytes = 28_400_000;
  const libsTotalBytes = 46_200_000;
  const assetsTotalBytes = 94_800_000;
  const grandTotalBytes = clientTotalBytes + libsTotalBytes + assetsTotalBytes;

  const sampleLibs = [
    "lwjgl-3.3.3.jar",
    "lwjgl-glfw-3.3.3.jar",
    "lwjgl-opengl-3.3.3.jar",
    "lwjgl-openal-3.3.3-natives-windows.jar",
    "netty-all-4.1.97.Final.jar",
    "fastutil-8.5.12.jar",
    "icu4j-73.2.jar",
    "gson-2.10.1.jar",
    "joml-1.10.5.jar",
    "oshi-core-6.4.10.jar",
    "commons-io-2.15.1.jar",
    "slf4j-api-2.0.9.jar",
  ];
  const sampleAssets = [
    "74/74da68c99aa578ce8679c0063b060d224f1f0004",
    "a9/a928f9a1c3f14d56e989b2d2274903e127b109d2",
    "3f/3fe4c878450d42e092a3548fb0f0c69f6191472c",
    "c1/c157c56846f0e50620f80c2792069e00d6229c2b",
    "e2/e2984b6f81a88f7e98210779c11b027b4b732018",
    "5b/5b38d2a930c75569f544f08d898c083783b219f1",
    "9d/9d21f845e1920c8b473028b1932048a77c820124",
    "1a/1a847c6092b48c7e09f119837465910283746512",
  ];

  type StageStatus = "pending" | "active" | "done" | "error";
  const makeStages = (
    prepDone: number,
    prepStatus: StageStatus,
    clientDoneFiles: number,
    clientBytes: number,
    clientStatus: StageStatus,
    libDoneFiles: number,
    libBytes: number,
    libStatus: StageStatus,
    assetDoneFiles: number,
    assetBytes: number,
    assetStatus: StageStatus,
  ) => [
    {
      stage: "prepare",
      label: "解析版本与资源清单",
      status: prepStatus,
      doneFiles: prepDone,
      totalFiles: 3,
      doneBytes: 0,
      totalBytes: 0,
    },
    {
      stage: "client",
      label: "客户端核心 Jar",
      status: clientStatus,
      doneFiles: clientDoneFiles,
      totalFiles: 1,
      doneBytes: clientBytes,
      totalBytes: clientTotalBytes,
    },
    {
      stage: "libraries",
      label: "运行依赖库与原生库",
      status: libStatus,
      doneFiles: libDoneFiles,
      totalFiles: 36,
      doneBytes: libBytes,
      totalBytes: libsTotalBytes,
    },
    {
      stage: "assets",
      label: "游戏资源与音频文件",
      status: assetStatus,
      doneFiles: assetDoneFiles,
      totalFiles: 780,
      doneBytes: assetBytes,
      totalBytes: assetsTotalBytes,
    },
  ];

  try {
    emit("install:progress", {
      versionId,
      stage: "prepare",
      done: 1,
      total: 3,
      detail: "读取版本清单与资源索引",
      downloadedBytes: 0,
      totalBytes: grandTotalBytes,
      speedBps: 0,
      threads,
      activeThreads: 1,
      skippedFiles: 0,
      retriedFiles: 0,
      activeTasks: [
        {
          workerId: 1,
          name: `${versionId}.json`,
          stage: "prepare",
          doneBytes: 18_400,
          totalBytes: 32_000,
          segments: 1,
        },
      ],
      stages: makeStages(1, "active", 0, 0, "pending", 0, 0, "pending", 0, 0, "pending"),
    });
    await sleep(350);

    const clientSegments = Math.min(8, Math.max(1, threads));
    for (let step = 1; step <= 4; step += 1) {
      const ratio = step / 4;
      const doneBytes = Math.round(clientTotalBytes * ratio);
      emit("install:progress", {
        versionId,
        stage: "client",
        done: doneBytes,
        total: clientTotalBytes,
        detail:
          step < 4
            ? `${(doneBytes / 1_048_576).toFixed(1)} / ${(clientTotalBytes / 1_048_576).toFixed(1)} MB`
            : "客户端下载完成",
        downloadedBytes: doneBytes,
        totalBytes: grandTotalBytes,
        speedBps: 18_500_000 + step * 1_400_000,
        threads,
        activeThreads: step < 4 ? clientSegments : 0,
        skippedFiles: 0,
        retriedFiles: 0,
        activeTasks:
          step < 4
            ? [
                {
                  workerId: 1,
                  name: `${versionId}.jar`,
                  stage: "client",
                  doneBytes,
                  totalBytes: clientTotalBytes,
                  segments: clientSegments,
                },
              ]
            : [],
        stages: makeStages(
          3,
          "done",
          step === 4 ? 1 : 0,
          doneBytes,
          step === 4 ? "done" : "active",
          0,
          0,
          "pending",
          0,
          0,
          "pending",
        ),
      });
      await sleep(160);
    }

    for (let i = 1; i <= 10; i += 1) {
      await sleep(110);
      const doneFiles = Math.round((i / 10) * 36);
      const libBytes = Math.round((i / 10) * libsTotalBytes);
      const workerCount = Math.min(threads, 8);
      const activeTasks =
        i < 10
          ? Array.from({ length: workerCount }, (_, idx) => {
              const name = sampleLibs[(i + idx) % sampleLibs.length];
              const fileTotal = 1_200_000 + idx * 450_000;
              const fileDone = Math.round(fileTotal * (((i * 3 + idx) % 9) / 9));
              return {
                workerId: idx + 1,
                name,
                stage: "libraries",
                doneBytes: fileDone,
                totalBytes: fileTotal,
                segments: fileTotal > 2_000_000 && threads > 2 ? 4 : 1,
              };
            })
          : [];
      emit("install:progress", {
        versionId,
        stage: "libraries",
        done: doneFiles,
        total: 36,
        detail: sampleLibs[i % sampleLibs.length],
        downloadedBytes: clientTotalBytes + libBytes,
        totalBytes: grandTotalBytes,
        speedBps: 21_400_000 + (i % 4) * 1_850_000,
        threads,
        activeThreads: i < 10 ? Math.min(threads, workerCount * 2) : 0,
        skippedFiles: Math.min(4, Math.floor(i / 3)),
        retriedFiles: 0,
        activeTasks,
        stages: makeStages(
          3,
          "done",
          1,
          clientTotalBytes,
          "done",
          doneFiles,
          libBytes,
          i === 10 ? "done" : "active",
          0,
          0,
          "pending",
        ),
      });
    }

    for (let i = 1; i <= 16; i += 1) {
      await sleep(110);
      const doneFiles = Math.round((i / 16) * 780);
      const assetBytes = Math.round((i / 16) * assetsTotalBytes);
      const workerCount = Math.min(threads, 12);
      const activeTasks =
        i < 16
          ? Array.from({ length: workerCount }, (_, idx) => {
              const name = `objects/${sampleAssets[(i + idx) % sampleAssets.length]}`;
              const fileTotal = 120_000 + idx * 64_000;
              const fileDone = Math.round(fileTotal * (((i * 5 + idx) % 10) / 10));
              return {
                workerId: idx + 1,
                name,
                stage: "assets",
                doneBytes: fileDone,
                totalBytes: fileTotal,
                segments: 1,
              };
            })
          : [];
      emit("install:progress", {
        versionId,
        stage: "assets",
        done: doneFiles,
        total: 780,
        detail: `objects/${sampleAssets[i % sampleAssets.length].slice(0, 19)}…`,
        downloadedBytes: clientTotalBytes + libsTotalBytes + assetBytes,
        totalBytes: grandTotalBytes,
        speedBps: 24_800_000 + (i % 5) * 1_620_000,
        threads,
        activeThreads: i < 16 ? threads : 0,
        skippedFiles: 4 + i * 3,
        retriedFiles: i > 8 ? 1 : 0,
        activeTasks,
        stages: makeStages(
          3,
          "done",
          1,
          clientTotalBytes,
          "done",
          36,
          libsTotalBytes,
          "done",
          doneFiles,
          assetBytes,
          i === 16 ? "done" : "active",
        ),
      });
    }

    await sleep(220);
    emit("install:progress", {
      versionId,
      stage: "done",
      done: 1,
      total: 1,
      detail: "游戏文件已就绪",
      downloadedBytes: grandTotalBytes,
      totalBytes: grandTotalBytes,
      speedBps: 0,
      threads,
      activeThreads: 0,
      skippedFiles: 52,
      retriedFiles: 1,
      activeTasks: [],
      stages: makeStages(
        3,
        "done",
        1,
        clientTotalBytes,
        "done",
        36,
        libsTotalBytes,
        "done",
        780,
        assetsTotalBytes,
        "done",
      ),
    });

    if (!installed.some((entry) => entry.id === targetId)) {
      installed = [
        {
          id: targetId,
          type: versionId.includes("snapshot") ? "snapshot" : "release",
          installedAt: Math.floor(Date.now() / 1000),
          mcVersion: versionId,
          loader: selection?.loaderType,
          loaderVersion: selection?.loaderVersion,
          optifineVersion: selection?.optifineVersion,
          fabricApiVersion: selection?.fabricApiVersion,
        },
        ...installed,
      ];
    }
    return {
      versionId: targetId,
      versionType: versionId.includes("snapshot") ? "snapshot" : "release",
      libraries: 36,
      assets: 780,
      javaMajor: 21,
    };
  } finally {
    installing = null;
  }
}

export async function demoDeleteVersion(versionId: string): Promise<void> {
  await sleep(300);
  installed = installed.filter((v) => v.id !== versionId);
}

export async function demoLaunch(request: LaunchRequest): Promise<number> {
  if (gameRunning) throw new Error("游戏已经在运行");
  gameRunning = true;
  const push = (stage: string, done: number, total: number, detail: string) =>
    emit("install:progress", {
      versionId: request.versionId,
      stage,
      done,
      total,
      detail,
    });

  push("java", 0, 0, "未检测到 Java 21，准备自动安装");
  await sleep(900);
  push("java", 28, 100, "正在下载 Java 21");
  await sleep(700);
  push("java", 100, 100, "Java 21 已就绪");
  await sleep(350);
  push("launch", 0, 1, "正在启动游戏");
  await sleep(500);

  gameTimers.push(
    window.setTimeout(() => {
      emit("game:status", {
        state: "running",
        detail: "游戏已启动，Java 21",
        pid: 4812,
        versionId: request.versionId,
      });
    }, 250),
  );

  const lines = [
    `[main/INFO]: Loading Minecraft ${request.versionId} for windows x86_64`,
    `[main/INFO]: Java is OpenJDK 21.0.8, version 21.0.8+9-LTS`,
    `[Render thread/INFO]: Setting user: ${request.playerName}`,
    "[Render thread/INFO]: Backend library: LWJGL version 3.3.3+5",
    "[Render thread/INFO]: Reloading ResourceManager: vanilla",
    "[Worker-Main-1/INFO]: Found 12 resource packs",
    "[Render thread/INFO]: OpenAL initialized on device OpenAL Soft",
    "[Render thread/INFO]: Sound engine started",
    "[Render thread/INFO]: Created: 1024x512x4 minecraft:textures/atlas/blocks.png",
    "[Render thread/INFO]: Narrator library for x64 successfully loaded",
    "[Render thread/INFO]: Loaded 1421 recipes",
    "[Render thread/INFO]: Time elapsed: 3184 ms",
  ];
  lines.forEach((line, index) => {
    gameTimers.push(
      window.setTimeout(
        () => emit("game:log", { stream: index < 3 ? "cobble" : "stdout", line }),
        500 + index * 110,
      ),
    );
  });

  return 4812;
}

export function demoStopGame(): void {
  gameTimers.forEach((timer) => window.clearTimeout(timer));
  gameTimers = [];
  if (!gameRunning) return;
  gameRunning = false;
  emit("game:log", { stream: "cobble", line: "正在结束游戏进程…" });
  window.setTimeout(() => {
    emit("game:exit", { code: 0, versionId: null });
    emit("game:status", { state: "idle", detail: null, pid: null, versionId: null });
  }, 300);
}

const DEMO_MODS: ContentHit[] = [
  {
    projectId: "AANobbMI",
    slug: "sodium",
    author: "jellysquid3",
    title: "Sodium",
    description: "现代、高度优化的 Minecraft 渲染引擎，大幅提升帧率并减少卡顿。",
    categories: ["optimization"],
    versions: ["1.21.4", "1.21.1", "1.20.1", "1.19.4"],
    downloads: 38_500_000,
    follows: 120_000,
    iconUrl: "https://cdn.modrinth.com/data/AANobbMI/icon.png",
    projectType: "mod",
  },
  {
    projectId: "YL57xq9U",
    slug: "iris",
    author: "coderbot",
    title: "Iris Shaders",
    description: "现代光影模组，兼容现有 OptiFine 光影包，并与 Sodium 深度整合加速渲染。",
    categories: ["shaders", "optimization"],
    versions: ["1.21.4", "1.21.1", "1.20.1"],
    downloads: 24_200_000,
    follows: 85_000,
    iconUrl: "https://cdn.modrinth.com/data/YL57xq9U/icon.png",
    projectType: "mod",
  },
  {
    projectId: "u6dRKJwZ",
    slug: "jei",
    author: "mezz",
    title: "Just Enough Items (JEI)",
    description: "经典实用的物品管理器与合成表查询模组，支持模组配方与快速检索。",
    categories: ["utility", "item-management"],
    versions: ["1.21.4", "1.21.1", "1.20.1", "1.19.2", "1.16.5"],
    downloads: 52_000_000,
    follows: 96_000,
    iconUrl: "https://cdn.modrinth.com/data/u6dRKJwZ/icon.png",
    projectType: "mod",
  },
  {
    projectId: "LNytGWDc",
    slug: "create",
    author: "simibubi",
    title: "Create (机械动力)",
    description: "美轮美奂的动力学工程与工业自动化模组，以齿轮、传动轴与流水线构建奇迹。",
    categories: ["technology"],
    versions: ["1.20.1", "1.19.2", "1.18.2"],
    downloads: 18_400_000,
    follows: 110_000,
    iconUrl: "https://cdn.modrinth.com/data/LNytGWDc/icon.png",
    projectType: "mod",
  },
  {
    projectId: "EsAfCjCV",
    slug: "appleskin",
    author: "squeek502",
    title: "AppleSkin",
    description: "在 HUD 界面直观显示食物饱食度与饱和度恢复量，生存必备辅助。",
    categories: ["utility"],
    versions: ["1.21.4", "1.21.1", "1.20.1"],
    downloads: 31_000_000,
    follows: 62_000,
    iconUrl: "https://cdn.modrinth.com/data/EsAfCjCV/icon.png",
    projectType: "mod",
  },
  {
    projectId: "codex",
    slug: "waystones",
    author: "BlayTheNinth",
    title: "Waystones (指路石)",
    description: "在世界中生成指路石碑，提供平衡且沉浸的传送网络与传送卷轴。",
    categories: ["adventure", "magic"],
    versions: ["1.21.1", "1.20.1"],
    downloads: 14_800_000,
    follows: 44_000,
    iconUrl: "https://cdn.modrinth.com/data/codex/icon.png",
    projectType: "mod",
  },
  {
    projectId: "actions-and-stuff",
    slug: "actions-and-stuff",
    author: "Traxe",
    title: "Actions & Stuff (基岩版动作物理交互模组)",
    description: "基岩版超高清动作行为包，全面重构肢体动作、战斗挥舞、拔刀与游泳物理动作。",
    categories: ["bedrock", "animation", "behavior"],
    versions: ["1.21+", "基岩版"],
    downloads: 890_000,
    follows: 42_000,
    iconUrl: "https://cdn.modrinth.com/data/mOgUt4GM/icon.png",
    projectType: "mod",
  },
  {
    projectId: "essentials-bedrock-addon",
    slug: "essentials-bedrock-addon",
    author: "BedrockTools",
    title: "Essentials Bedrock Add-On (基岩版实用辅助模组)",
    description: "为基岩版带来家园快速传送、背包快捷整理、死亡坐标标记、一键砍树等功能。",
    categories: ["bedrock", "utility", "behavior"],
    versions: ["1.21+", "基岩版"],
    downloads: 512_000,
    follows: 29_000,
    iconUrl: "https://cdn.modrinth.com/data/N3y5K0fK/icon.png",
    projectType: "mod",
  },
];

const DEMO_MODPACKS: ContentHit[] = [
  {
    projectId: "1KVo5zza",
    slug: "fabulously-optimized",
    author: "RobotKoer",
    title: "Fabulously Optimized (精彩优化整合包)",
    description: "专注于最高性能与 OptiFine 功能对标的轻量纯净整合包，开箱即用。",
    categories: ["optimization"],
    versions: ["1.21.4", "1.21.1", "1.20.1"],
    downloads: 4_200_000,
    follows: 38_000,
    iconUrl: "https://cdn.modrinth.com/data/1KVo5zza/icon.png",
    projectType: "modpack",
  },
  {
    projectId: "atm10",
    slug: "all-the-mods-10",
    author: "ATMTeam",
    title: "All the Mods 10 (ATM 10)",
    description: "大型综合魔改冒险整合包，囊括科技、魔法与探索，打造终极全能之星。",
    categories: ["adventure", "technology", "magic"],
    versions: ["1.21.1"],
    downloads: 1_850_000,
    follows: 29_000,
    iconUrl: "https://cdn.modrinth.com/data/atm10/icon.png",
    projectType: "modpack",
  },
  {
    projectId: "cobblemon",
    slug: "cobblemon-official",
    author: "Cobblemon",
    title: "Cobblemon Official Modpack",
    description: "官方宝可梦模组整合包，融入原版生存风格的高品质精灵世界。",
    categories: ["adventure"],
    versions: ["1.21.1", "1.20.1"],
    downloads: 2_600_000,
    follows: 35_000,
    iconUrl: "https://cdn.modrinth.com/data/cobblemon/icon.png",
    projectType: "modpack",
  },
];

const DEMO_SHADERS: ContentHit[] = [
  {
    projectId: "R2FrArrow",
    slug: "complementary-reimagined",
    author: "EminGT",
    title: "Complementary Shaders - Reimagined",
    description: "卓越的原版风格光影，精致的体积云、真实水体与极佳的性能平衡。",
    categories: ["realistic"],
    versions: ["1.21.4", "1.21.1", "1.20.1"],
    downloads: 19_500_000,
    follows: 88_000,
    iconUrl: "https://cdn.modrinth.com/data/R2FrArrow/icon.png",
    projectType: "shader",
  },
  {
    projectId: "Q1IjHDoN",
    slug: "bsl-shaders",
    author: "Capt_Tatsu",
    title: "BSL Shaders",
    description: "经典明亮、色彩柔和的光影包，提供实时的水波反射、体积光与环境光遮蔽。",
    categories: ["realistic"],
    versions: ["1.21.4", "1.21.1", "1.20.1"],
    downloads: 16_200_000,
    follows: 65_000,
    iconUrl: "https://cdn.modrinth.com/data/Q1IjHDoN/icon.png",
    projectType: "shader",
  },
  {
    projectId: "solas",
    slug: "solas-shader",
    author: "septirage",
    title: "Solas Shader",
    description: "注重幻想唯美氛围的光影，绚丽的极光光晕与平滑光照系统。",
    categories: ["fantasy"],
    versions: ["1.21.4", "1.21.1"],
    downloads: 3_800_000,
    follows: 21_000,
    iconUrl: "https://cdn.modrinth.com/data/solas/icon.png",
    projectType: "shader",
  },
  {
    projectId: "bedrock-deferred-pbr",
    slug: "bedrock-deferred-pbr",
    author: "RenderDragon",
    title: "Deferred Lighting PBR (基岩版延迟光影)",
    description: "原生 Render Dragon 延迟着色管线光影，具备体积分光、PBR 粗糙度反射与点光源阴影。",
    categories: ["bedrock", "pbr", "renderdragon"],
    versions: ["1.21+", "基岩版"],
    downloads: 248_900,
    follows: 16_000,
    iconUrl: "https://cdn.modrinth.com/data/b9YQO8q3/icon.png",
    projectType: "shader",
  },
  {
    projectId: "kellys-rtx-conversion",
    slug: "kellys-rtx-conversion",
    author: "Kelly",
    title: "Kelly's RTX Conversion (基岩版光追全特效光影)",
    description: "全特效基岩版 RTX 光线追踪增强光影材质包，具备拟真法线视差凹凸与真实方块反射。",
    categories: ["bedrock", "rtx", "raytracing"],
    versions: ["1.21+", "基岩版"],
    downloads: 680_400,
    follows: 35_000,
    iconUrl: "https://cdn.modrinth.com/data/u6Djgvyi/icon.png",
    projectType: "shader",
  },
  {
    projectId: "yss-shader-bedrock",
    slug: "yss-shader-bedrock",
    author: "YSS Project",
    title: "YSS Shader for Bedrock (基岩版经典软光影)",
    description: "基岩版轻量柔和光影，具备动态水波、摇晃树叶、暖阳漫反射与优美晨昏天空。",
    categories: ["bedrock", "soft", "water"],
    versions: ["1.21+", "基岩版"],
    downloads: 320_100,
    follows: 18_000,
    iconUrl: "https://cdn.modrinth.com/data/lhGA9TYQ/icon.png",
    projectType: "shader",
  },
];

const DEMO_DATAPACKS: ContentHit[] = [
  {
    projectId: "89W04v4l",
    slug: "terralith",
    author: "Starmute",
    title: "Terralith (大地之灵)",
    description: "无需模组支持的原版地形大修数据包，新增 100+ 惊艳的全新自然生物群系。",
    categories: ["worldgen"],
    versions: ["1.21.4", "1.21.1", "1.20.1"],
    downloads: 8_900_000,
    follows: 45_000,
    iconUrl: "https://cdn.modrinth.com/data/89W04v4l/icon.png",
    projectType: "datapack",
  },
  {
    projectId: "incendium",
    slug: "incendium",
    author: "Starmute",
    title: "Incendium (下界重生)",
    description: "下界维度全面重制数据包，包含庞大的下界城堡、熔岩废墟与自定义首领。",
    categories: ["worldgen", "adventure"],
    versions: ["1.21.4", "1.21.1", "1.20.1"],
    downloads: 4_300_000,
    follows: 28_000,
    iconUrl: "https://cdn.modrinth.com/data/incendium/icon.png",
    projectType: "datapack",
  },
  {
    projectId: "nullscape",
    slug: "nullscape",
    author: "Starmute",
    title: "Nullscape (虚空之境)",
    description: "末地维度生成重制数据包，壮观的悬浮浮空岛屿与险峻奇观。",
    categories: ["worldgen"],
    versions: ["1.21.4", "1.21.1", "1.20.1"],
    downloads: 3_600_000,
    follows: 22_000,
    iconUrl: "https://cdn.modrinth.com/data/nullscape/icon.png",
    projectType: "datapack",
  },
];

export async function demoSearchContent(options: {
  query?: string;
  projectType: ContentProjectType;
  gameVersion?: string;
  loader?: string;
  sort?: string;
  offset?: number;
  limit?: number;
}): Promise<SearchContentResult> {
  await sleep(140);
  let pool =
    options.projectType === "mod"
      ? DEMO_MODS
      : options.projectType === "modpack"
        ? DEMO_MODPACKS
        : options.projectType === "shader"
          ? DEMO_SHADERS
          : DEMO_DATAPACKS;

  const q = options.query?.trim().toLowerCase();
  if (q) {
    pool = pool.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.slug.toLowerCase().includes(q),
    );
  }

  if (options.gameVersion && options.gameVersion !== "all") {
    pool = pool.filter((item) =>
      item.versions.some((v) => v.toLowerCase().includes(options.gameVersion!.toLowerCase())),
    );
  }

  if (options.loader && options.loader !== "all") {
    const l = options.loader.toLowerCase();
    pool = pool.filter((item) =>
      item.categories.some((c) => c.toLowerCase().includes(l)),
    );
  }

  return {
    hits: pool,
    offset: options.offset ?? 0,
    limit: options.limit ?? 20,
    totalHits: pool.length,
  };
}

export async function demoGetContentVersions(
  projectId: string,
  gameVersion?: string,
  loader?: string,
): Promise<ContentVersionItem[]> {
  await sleep(150);
  const bedrockItems = await demoGetBedrockContent();
  const bItem = bedrockItems.find((i) => i.id === projectId);
  if (bItem) {
    return [
      {
        id: `${bItem.id}-v1`,
        name: `[基岩版适用] ${bItem.version}`,
        versionNumber: bItem.version,
        gameVersions: ["1.21+", "基岩版"],
        loaders: ["bedrock"],
        datePublished: "2024-12-01T00:00:00Z",
        downloads: bItem.downloads,
        files: [
          {
            url: bItem.downloadUrl,
            filename: bItem.fileName,
            primary: true,
            size: 2_500_000,
          },
        ],
      },
    ];
  }

  const gv = gameVersion && gameVersion !== "all" ? gameVersion : "1.21.4";
  return [
    {
      id: `${projectId}-v1`,
      name: `[${gv}] 推荐正式发布版`,
      versionNumber: "2.1.0",
      gameVersions: [gv, "1.21.1", "1.21"],
      loaders: [loader && loader !== "all" ? loader : "fabric", "forge"],
      datePublished: "2026-10-20T10:00:00Z",
      downloads: 124_000,
      files: [
        {
          url: "https://example.com/download.jar",
          filename: `${projectId}-${gv}-2.1.0.jar`,
          primary: true,
          size: 1_850_000,
        },
      ],
    },
    {
      id: `${projectId}-v0`,
      name: `[${gv}] 前期稳定版`,
      versionNumber: "2.0.4",
      gameVersions: [gv],
      loaders: ["fabric", "forge", "neoforge"],
      datePublished: "2026-09-18T10:00:00Z",
      downloads: 88_000,
      files: [
        {
          url: "https://example.com/download.jar",
          filename: `${projectId}-${gv}-2.0.4.jar`,
          primary: true,
          size: 1_720_000,
        },
      ],
    },
  ];
}

export async function demoDownloadContentFile(
  request: DownloadContentRequest,
): Promise<DownloadContentResult> {
  await sleep(400);
  return {
    success: true,
    filePath: `C:\\Users\\you\\.cobble\\versions\\${request.instanceId || "default"}\\${request.projectType}s\\${request.filename}`,
    bytes: request.size ?? 2_048_000,
  };
}

export async function demoGetBedrockStatus(): Promise<BedrockStatus> {
  await sleep(100);
  return {
    uwpInstalled: true,
    standaloneInstalled: true,
    comMojangPath: "C:\\Users\\you\\AppData\\Local\\Packages\\Microsoft.MinecraftUWP_8wekyb3d8bbwe\\LocalState\\games\\com.mojang",
    portablePath: "C:\\Users\\you\\.cobble\\bedrock\\games\\com.mojang",
    resourcePacksCount: 4,
    behaviorPacksCount: 2,
    worldsCount: 3,
    installedVersions: ["1.21.50.07", "1.21.44.01"],
  };
}

export async function demoGetBedrockVersions(apiSource?: string): Promise<BedrockVersionItem[]> {
  await sleep(150);
  const src = apiSource || "endstone";
  const srcLabel = src === "mcserverjars" ? "MCServerJars API" : src === "azure_mirror" ? "Azure CDN 镜像" : "EndstoneMC API";

  const rawReleases = [
    { v: "1.21.60.10", n: "Minecraft 基岩版 1.21.60 (最新正式版)", d: "2025-02-18", sz: 83_886_080 },
    { v: "1.21.51.02", n: "Minecraft 基岩版 1.21.51", d: "2025-01-14", sz: 81_788_928 },
    { v: "1.21.50.07", n: "Minecraft 基岩版 1.21.50", d: "2024-12-10", sz: 81_264_640 },
    { v: "1.21.44.01", n: "Minecraft 基岩版 1.21.44", d: "2024-11-20", sz: 79_691_776 },
    { v: "1.21.43.01", n: "Minecraft 基岩版 1.21.43", d: "2024-11-12", sz: 79_691_776 },
    { v: "1.21.40.04", n: "Minecraft 基岩版 1.21.40", d: "2024-10-22", sz: 78_643_200 },
    { v: "1.21.31.04", n: "Minecraft 基岩版 1.21.31", d: "2024-09-24", sz: 77_594_624 },
    { v: "1.21.30.03", n: "Minecraft 基岩版 1.21.30", d: "2024-09-17", sz: 77_070_336 },
    { v: "1.21.20.03", n: "Minecraft 基岩版 1.21.20", d: "2024-08-06", sz: 76_021_760 },
    { v: "1.21.0.03",  n: "Minecraft 基岩版 1.21.0",  d: "2024-06-13", sz: 74_973_184 },
    { v: "1.20.81.01", n: "Minecraft 基岩版 1.20.81", d: "2024-04-29", sz: 74_448_896 },
    { v: "1.20.73.01", n: "Minecraft 基岩版 1.20.73", d: "2024-03-26", sz: 73_400_320 },
    { v: "1.20.62.02", n: "Minecraft 基岩版 1.20.62", d: "2024-02-20", sz: 72_351_744 },
    { v: "1.20.51.01", n: "Minecraft 基岩版 1.20.51", d: "2023-12-19", sz: 71_303_168 },
    { v: "1.20.41.02", n: "Minecraft 基岩版 1.20.41", d: "2023-11-02", sz: 70_254_592 },
    { v: "1.20.32.03", n: "Minecraft 基岩版 1.20.32", d: "2023-10-05", sz: 69_206_016 },
    { v: "1.20.15.01", n: "Minecraft 基岩版 1.20.15", d: "2023-08-16", sz: 67_633_152 },
    { v: "1.20.0.01",  n: "Minecraft 基岩版 1.20.0",  d: "2023-06-07", sz: 65_536_000 },
    { v: "1.19.83.01", n: "Minecraft 基岩版 1.19.83", d: "2023-05-10", sz: 64_487_424 },
    { v: "1.19.73.02", n: "Minecraft 基岩版 1.19.73", d: "2023-03-29", sz: 63_438_848 },
    { v: "1.19.63.01", n: "Minecraft 基岩版 1.19.63", d: "2023-02-14", sz: 62_914_560 },
    { v: "1.19.51.01", n: "Minecraft 基岩版 1.19.51", d: "2022-12-06", sz: 61_341_696 },
    { v: "1.19.41.01", n: "Minecraft 基岩版 1.19.41", d: "2022-11-03", sz: 60_817_408 },
    { v: "1.19.22.01", n: "Minecraft 基岩版 1.19.22", d: "2022-08-11", sz: 59_768_832 },
    { v: "1.18.33.02", n: "Minecraft 基岩版 1.18.33", d: "2022-05-10", sz: 57_671_680 },
    { v: "1.18.12.01", n: "Minecraft 基岩版 1.18.12", d: "2022-02-16", sz: 56_098_816 },
    { v: "1.17.41.01", n: "Minecraft 基岩版 1.17.41", d: "2021-10-27", sz: 54_525_952 },
    { v: "1.16.221.01", n: "Minecraft 基岩版 1.16.221", d: "2021-04-22", sz: 51_380_224 },
  ];

  const rawPreviews = [
    { v: "1.21.70.24", n: "Minecraft 基岩预览版 1.21.70.24", d: "2025-02-20", sz: 88_080_384 },
    { v: "1.21.70.22", n: "Minecraft 基岩预览版 1.21.70.22", d: "2025-02-13", sz: 87_556_096 },
    { v: "1.21.60.25", n: "Minecraft 基岩预览版 1.21.60.25", d: "2025-01-23", sz: 86_507_520 },
    { v: "1.21.50.28", n: "Minecraft 基岩预览版 1.21.50.28", d: "2024-11-28", sz: 84_934_656 },
    { v: "1.21.40.24", n: "Minecraft 基岩预览版 1.21.40.24", d: "2024-10-17", sz: 83_886_080 },
  ];

  const list: BedrockVersionItem[] = [];

  for (const r of rawReleases) {
    list.push({
      id: r.v,
      name: r.n,
      version: r.v,
      releaseType: "release",
      downloadUrl: src === "mcserverjars"
        ? `https://mcserverjars.com/api/download/bedrock/${r.v}`
        : `https://minecraft.azureedge.net/bin-win/bedrock-server-${r.v}.zip`,
      storeUrl: "ms-windows-store://pdp/?ProductId=9NBLGGH537BL",
      date: r.d,
      size: r.sz,
      apiSource: srcLabel,
    });
  }

  for (const p of rawPreviews) {
    list.push({
      id: p.v,
      name: p.n,
      version: p.v,
      releaseType: "preview",
      downloadUrl: src === "mcserverjars"
        ? `https://mcserverjars.com/api/download/bedrock/${p.v}`
        : `https://minecraft.azureedge.net/bin-win/bedrock-server-${p.v}.zip`,
      storeUrl: "ms-windows-store://pdp/?ProductId=9P5X4QVLC2XR",
      date: p.d,
      size: p.sz,
      apiSource: srcLabel,
    });
  }

  return list;
}

export async function demoGetBedrockContent(category?: string): Promise<BedrockContentItem[]> {
  await sleep(150);
  const items: BedrockContentItem[] = [
    {
      id: "bedrock-deferred-pbr",
      title: "Deferred Lighting PBR (基岩版延迟光影)",
      author: "RenderDragon",
      description: "原生 Render Dragon 延迟着色管线光影，具备体积分光、PBR 粗糙度反射与点光源实时阴影。",
      contentType: "shader",
      downloadUrl: "https://raw.githubusercontent.com/Pug-Dev/Deferred-PBR/main/DeferredPBR.mcpack",
      fileName: "DeferredPBR.mcpack",
      iconUrl: "https://cdn.modrinth.com/data/b9YQO8q3/icon.png",
      tags: ["光影", "PBR", "RenderDragon", "1.21+"],
      downloads: 248_900,
      version: "v1.2.0",
    },
    {
      id: "kellys-rtx-conversion",
      title: "Kelly's RTX Conversion (光追全特效光影)",
      author: "Kelly",
      description: "全特效基岩版 RTX 光线追踪增强光影材质包，具备拟真法线视差凹凸与真实发光方块反射。",
      contentType: "shader",
      downloadUrl: "https://raw.githubusercontent.com/KellysRTX/Conversion/main/KellysRTX.mcpack",
      fileName: "KellysRTX.mcpack",
      iconUrl: "https://cdn.modrinth.com/data/u6Djgvyi/icon.png",
      tags: ["光影", "RTX", "光线追踪", "拟真"],
      downloads: 680_400,
      version: "v2.1.0",
    },
    {
      id: "yss-shader-bedrock",
      title: "YSS Shader for Bedrock (经典软光影)",
      author: "YSS Project",
      description: "基岩版轻量柔和光影，具备动态水波、摇晃树叶、暖阳漫反射与优美晨昏天空。",
      contentType: "shader",
      downloadUrl: "https://raw.githubusercontent.com/yss-mc/releases/main/YSS_Bedrock.mcpack",
      fileName: "YSS_Bedrock.mcpack",
      iconUrl: "https://cdn.modrinth.com/data/lhGA9TYQ/icon.png",
      tags: ["光影", "低配流畅", "水面波纹"],
      downloads: 320_100,
      version: "v3.0.2",
    },
    {
      id: "actions-and-stuff",
      title: "Actions & Stuff (动作物理交互模组)",
      author: "Traxe",
      description: "基岩版超高清动作行为包，全面重构玩家与生物全部肢体动作、战斗挥舞、拔刀与游泳物理动作。",
      contentType: "mod",
      downloadUrl: "https://raw.githubusercontent.com/Traxe-mc/ActionsStuff/main/ActionsAndStuff.mcaddon",
      fileName: "ActionsAndStuff.mcaddon",
      iconUrl: "https://cdn.modrinth.com/data/mOgUt4GM/icon.png",
      tags: ["模组", "行为包", "物理动作", "生物交互"],
      downloads: 890_000,
      version: "v1.3.4",
    },
    {
      id: "essentials-bedrock-addon",
      title: "Essentials Bedrock Add-On (实用辅助模组)",
      author: "BedrockTools",
      description: "为基岩版带来家园快速传送、背包快捷整理、死亡坐标标记、一键砍树等丰富功能。",
      contentType: "mod",
      downloadUrl: "https://raw.githubusercontent.com/BedrockTools/Essentials/main/Essentials.mcaddon",
      fileName: "Essentials.mcaddon",
      iconUrl: "https://cdn.modrinth.com/data/N3y5K0fK/icon.png",
      tags: ["模组", "辅助工具", "实用命令"],
      downloads: 512_000,
      version: "v2.0.1",
    },
  ];

  if (category && category !== "all") {
    return items.filter((i) => i.contentType === category);
  }
  return items;
}

export async function demoInstallBedrockVersion(versionId: string): Promise<string> {
  await sleep(1000);
  return `已成功安装 Minecraft 基岩版 ${versionId}`;
}

export async function demoDeleteBedrockVersion(_versionId: string): Promise<void> {
  await sleep(300);
}

export async function demoInstallBedrockPack(
  _source: string,
  filename?: string,
): Promise<InstallPackResult> {
  await sleep(800);
  const name = filename || "资源包";
  const isMod = name.includes(".mcaddon") || name.toLowerCase().includes("mod");
  return {
    success: true,
    packName: name,
    packType: isMod ? "模组 / 行为包" : "光影 / 资源包",
    targetPath: "C:\\Users\\you\\.cobble\\bedrock\\games\\com.mojang",
    message: `已成功安装${isMod ? "模组" : "光影"}并部署至基岩版目录`,
  };
}

export async function demoLaunchBedrock(): Promise<string> {
  await sleep(400);
  return "已成功启动 Minecraft 基岩版";
}

export async function demoCleanDownloadCache(): Promise<number> {
  await sleep(300);
  return 94953306;
}

export async function demoGetBedrockLoaders(mcVersion: string): Promise<BedrockLoadersCatalog> {
  await sleep(200);
  return {
    mcVersion,
    levilamina: [
      {
        name: "LeviLamina",
        version: "26.51.8",
        loaderType: "levilamina",
        compatibleMcVersion: mcVersion,
        downloadUrl: "https://github.com/LiteLDev/LeviLamina/releases/download/v26.51.8/levilamina-v26.51.8-client-release-windows-x64.zip",
        description: `LeviLamina 官方基岩版客户端模组加载器 (推荐适配: ${mcVersion})`,
        stable: true,
      },
      {
        name: "LeviLamina",
        version: "1.9.9",
        loaderType: "levilamina",
        compatibleMcVersion: mcVersion,
        downloadUrl: "https://github.com/LiteLDev/LeviLamina/releases/download/v1.9.9/levilamina-v1.9.9-client-release-windows-x64.zip",
        description: "LeviLamina 稳定版客户端模组加载器",
        stable: true,
      },
    ],
    amethyst: [
      {
        name: "Amethyst",
        version: "0.4.1",
        loaderType: "amethyst",
        compatibleMcVersion: mcVersion,
        downloadUrl: "https://github.com/FreerGit/Amethyst/releases/download/v0.4.1/Amethyst-Windows.zip",
        description: "Amethyst 原生 C++ 客户端模组加载器 v0.4.1",
        stable: true,
      },
    ],
  };
}

export async function demoInstallBedrockLoader(
  versionId: string,
  loaderType: string,
  loaderVersion: string,
): Promise<string> {
  await sleep(600);
  return `${loaderType} v${loaderVersion} 已成功安装到基岩版实例 ${versionId}`;
}

export async function demoGetBedrockMods(_versionId: string): Promise<BedrockModItem[]> {
  await sleep(150);
  return [
    {
      id: "Zoomify.dll",
      name: "Zoomify (基岩版缩放视角模组)",
      fileName: "Zoomify.dll",
      path: "C:\\Users\\you\\.cobble\\bedrock\\versions\\1.26.51\\mods\\Zoomify.dll",
      modType: "dll_mod",
      enabled: true,
      injectDelay: 0,
      isPreLoad: true,
      size: 524288,
      modifiedTime: "2026-10-25 12:00:00",
    },
    {
      id: "CustomFov.dll",
      name: "CustomFov (自定义视场角与界面适配)",
      fileName: "CustomFov.dll",
      path: "C:\\Users\\you\\.cobble\\bedrock\\versions\\1.26.51\\mods\\CustomFov.dll",
      modType: "dll_mod",
      enabled: true,
      injectDelay: 0,
      isPreLoad: true,
      size: 262144,
      modifiedTime: "2026-10-24 15:30:00",
    },
  ];
}

export async function demoToggleBedrockMod(
  _versionId: string,
  _modId: string,
  _enabled: boolean,
): Promise<void> {
  await sleep(100);
}

export async function demoDeleteBedrockMod(
  _versionId: string,
  _modId: string,
): Promise<void> {
  await sleep(150);
}

export async function demoInstallBedrockModFile(
  versionId: string,
  _filePath: string,
): Promise<string> {
  await sleep(300);
  return `模组文件已成功导入到基岩版实例 ${versionId}`;
}

