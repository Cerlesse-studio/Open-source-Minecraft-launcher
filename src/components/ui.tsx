import { useEffect, useRef, useState, type ReactNode } from "react";
import { Archive, Boxes, Package, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "cn";
import { progressPercent, stageLabel } from "../lib/format";
import type {
  ContentProjectType,
  InstallProgress,
  OfflineSkinType,
} from "../lib/types";
import { readSkinAsDataUrl } from "../lib/backend";

export function GrassBlock({
  size = 96,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/icons/minecraft/grass_block.png"
      alt="Grass Block"
      width={size}
      height={size}
      className={cn("shrink-0 object-contain [image-rendering:pixelated]", className)}
    />
  );
}

const CONTENT_TYPE_ICONS: Record<
  ContentProjectType,
  typeof Boxes
> = {
  mod: Boxes,
  modpack: Package,
  shader: Sparkles,
  datapack: Archive,
  resourcepack: Package,
};

/**
 * Icon tile for a marketplace project.
 *
 * Modrinth serves icons from several CDN paths (`icon.png` for older projects,
 * hashed `_96.webp` / `.jpeg` files for newer ones), and a project may have no
 * icon at all. Any of those cases must degrade to the type placeholder while
 * keeping the tile's size: a hidden <img> used to leave an empty gap in the
 * list, which read as a rendering bug rather than as "this project has no
 * icon".
 */
export function ContentIcon({
  src,
  alt,
  projectType,
  className,
  iconClassName,
}: {
  src?: string | null;
  alt: string;
  projectType: ContentProjectType;
  className?: string;
  iconClassName?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const TypeIcon = CONTENT_TYPE_ICONS[projectType] ?? Package;
  const url = src?.trim() ?? "";
  const showImage = url.length > 0 && failedSrc !== url;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/20 text-muted-foreground",
        className,
      )}
    >
      {showImage ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
          onError={() => setFailedSrc(url)}
        />
      ) : (
        <TypeIcon
          aria-hidden="true"
          className={cn("size-5 shrink-0 opacity-70", iconClassName)}
        />
      )}
    </div>
  );
}

function hashCode(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

const SKIN_TONES = [
  ["#f1c9a5", "#d9a97e"],
  ["#d9a273", "#b98155"],
  ["#a8744f", "#8a5a3c"],
  ["#f4d4b8", "#dfb691"],
];
const HAIR_TONES = ["#3b2a20", "#6d4a2b", "#22201e", "#8a6b3a", "#4a3a52"];

const STEVE_PIXELS = [
  "#26180f", "#26180f", "#26180f", "#26180f", "#26180f", "#26180f", "#26180f", "#26180f",
  "#26180f", "#26180f", "#26180f", "#26180f", "#26180f", "#26180f", "#26180f", "#26180f",
  "#26180f", "#26180f", "#b98155", "#b98155", "#b98155", "#b98155", "#26180f", "#26180f",
  "#b98155", "#b98155", "#b98155", "#b98155", "#b98155", "#b98155", "#b98155", "#b98155",
  "#ffffff", "#2b1b59", "#b98155", "#a06b43", "#a06b43", "#b98155", "#ffffff", "#2b1b59",
  "#b98155", "#b98155", "#b98155", "#8c5633", "#8c5633", "#b98155", "#b98155", "#b98155",
  "#b98155", "#b98155", "#543827", "#543827", "#543827", "#543827", "#b98155", "#b98155",
  "#b98155", "#b98155", "#543827", "#a06b43", "#a06b43", "#543827", "#b98155", "#b98155",
];

const ALEX_PIXELS = [
  "#b45309", "#b45309", "#b45309", "#b45309", "#b45309", "#b45309", "#b45309", "#b45309",
  "#b45309", "#b45309", "#b45309", "#b45309", "#b45309", "#b45309", "#b45309", "#b45309",
  "#b45309", "#b45309", "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#b45309", "#b45309",
  "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#fde68a",
  "#ffffff", "#059669", "#fde68a", "#fcd34d", "#fcd34d", "#fde68a", "#ffffff", "#059669",
  "#fde68a", "#fde68a", "#fde68a", "#f59e0b", "#f59e0b", "#fde68a", "#fde68a", "#fde68a",
  "#fde68a", "#fde68a", "#fde68a", "#ea580c", "#ea580c", "#fde68a", "#fde68a", "#fde68a",
  "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#fde68a", "#fde68a",
];

export function Avatar({
  name,
  size = 40,
  className,
  skinType = "random",
  customSkinPath,
  mojangSkinName,
  skinUrl,
}: {
  name: string;
  size?: number;
  className?: string;
  skinType?: OfflineSkinType;
  customSkinPath?: string;
  mojangSkinName?: string;
  skinUrl?: string | null;
}) {
  const [customDataUrl, setCustomDataUrl] = useState<string | null>(null);
  const [remoteSkinFailed, setRemoteSkinFailed] = useState(false);
  const [providerIndex, setProviderIndex] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const MOJANG_PROVIDERS = [
    (target: string, sz: number) => `https://crafthead.net/helm/${encodeURIComponent(target)}/${sz}`,
    (target: string, sz: number) => `https://mc-heads.net/avatar/${encodeURIComponent(target)}/${sz}`,
    (target: string, sz: number) => `https://minotar.net/helm/${encodeURIComponent(target)}/${sz}.png`,
    (target: string, sz: number) => `https://mineskin.eu/helm/${encodeURIComponent(target)}/${sz}`,
  ];

  useEffect(() => {
    setRemoteSkinFailed(false);
    setProviderIndex(0);
  }, [skinType, mojangSkinName, name, skinUrl]);

  // Load custom skin data URL or official skinUrl
  useEffect(() => {
    let active = true;
    if (skinType === "custom" && customSkinPath) {
      if (customSkinPath.startsWith("data:") || customSkinPath.startsWith("http")) {
        setCustomDataUrl(customSkinPath);
      } else {
        readSkinAsDataUrl(customSkinPath)
          .then((url) => {
            if (active) setCustomDataUrl(url);
          })
          .catch(() => {
            if (active) setCustomDataUrl(null);
          });
      }
    } else if (skinUrl && (skinType === "mojang" || skinType === "random")) {
      setCustomDataUrl(skinUrl.replace(/^http:\/\//i, "https://"));
    } else {
      setCustomDataUrl(null);
    }
    return () => {
      active = false;
    };
  }, [skinType, customSkinPath, skinUrl]);

  // When customDataUrl is available, draw the head front + hat layer to canvas
  useEffect(() => {
    if (!customDataUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.clearRect(0, 0, 64, 64);
      ctx.imageSmoothingEnabled = false;
      const isMinecraftSkin =
        (img.width === 64 && (img.height === 64 || img.height === 32)) ||
        (img.width === 128 && (img.height === 128 || img.height === 64));
      if (isMinecraftSkin) {
        const scale = img.width / 64;
        ctx.drawImage(img, 8 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 64, 64);
        ctx.drawImage(img, 40 * scale, 8 * scale, 8 * scale, 8 * scale, 0, 0, 64, 64);
      } else {
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, 64, 64);
      }
    };
    img.onerror = () => {
      setCustomDataUrl(null);
    };
    img.src = customDataUrl;
  }, [customDataUrl]);

  // 1. Direct Skin / Custom Skin Rendering on Canvas
  if (customDataUrl) {
    return (
      <canvas
        ref={canvasRef}
        width={64}
        height={64}
        style={{ width: size, height: size }}
        className={cn("shrink-0 [image-rendering:pixelated]", className)}
      />
    );
  }

  // 2. Mojang Skin Rendering
  if ((skinType === "mojang" || skinUrl) && !remoteSkinFailed) {
    const target = mojangSkinName?.trim() || name || "Steve";
    const currentSrc = MOJANG_PROVIDERS[providerIndex]?.(target, size) ?? `https://mc-heads.net/avatar/${encodeURIComponent(target)}/${size}`;
    return (
      <img
        key={`${target}-${providerIndex}`}
        src={currentSrc}
        alt={target}
        width={size}
        height={size}
        className={cn("shrink-0 object-contain [image-rendering:pixelated]", className)}
        onError={() => {
          if (providerIndex < MOJANG_PROVIDERS.length - 1) {
            setProviderIndex((prev) => prev + 1);
          } else {
            setRemoteSkinFailed(true);
          }
        }}
      />
    );
  }

  // 3. Steve Face Rendering
  if (skinType === "steve") {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 8 8"
        shapeRendering="crispEdges"
        className={cn("shrink-0 [image-rendering:pixelated]", className)}
      >
        {STEVE_PIXELS.map((fill, idx) => (
          <rect
            key={idx}
            x={idx % 8}
            y={Math.floor(idx / 8)}
            width="1"
            height="1"
            fill={fill}
          />
        ))}
      </svg>
    );
  }

  // 4. Alex Face Rendering
  if (skinType === "alex") {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 8 8"
        shapeRendering="crispEdges"
        className={cn("shrink-0 [image-rendering:pixelated]", className)}
      >
        {ALEX_PIXELS.map((fill, idx) => (
          <rect
            key={idx}
            x={idx % 8}
            y={Math.floor(idx / 8)}
            width="1"
            height="1"
            fill={fill}
          />
        ))}
      </svg>
    );
  }

  // 5. Default Procedural Avatar
  const hash = hashCode(name || "Steve");
  const [skinLight, skinDark] = SKIN_TONES[hash % SKIN_TONES.length];
  const hair = HAIR_TONES[(hash >> 3) % HAIR_TONES.length];
  const shirt = ["#5b9c3b", "#3b7fa6", "#a6573f", "#7c5ba6"][(hash >> 5) % 4];
  const rows = [
    "HHHHHHHH",
    "HHHHHHHH",
    "HSSSSSSH",
    "SSSSSSSS",
    "SEESSEES",
    "SSSSSSSS",
    "SSSMMSSS",
    "CCCCCCCC",
  ];
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 8 8"
      shapeRendering="crispEdges"
      className={cn("shrink-0 [image-rendering:pixelated]", className)}
    >
      <rect width="8" height="8" fill="#0d110f" />
      {rows.map((row, y) =>
        row.split("").map((pixel, x) => {
          let fill = skinLight;
          if (pixel === "H") fill = hair;
          if (pixel === "E") fill = "#1b2522";
          if (pixel === "M") fill = skinDark;
          if (pixel === "C") fill = shirt;
          if (pixel === "S" && (x + y) % 7 === 0) fill = skinDark;
          return <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={fill} />;
        }),
      )}
    </svg>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-foreground">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function StatusDot({
  tone = "muted",
  className,
  animated = false,
}: {
  tone?: "online" | "warn" | "pending" | "muted" | "live";
  className?: string;
  animated?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        tone === "online" && "bg-primary shadow-[0_0_0_3px] shadow-primary/10",
        tone === "warn" && "bg-gold shadow-[0_0_0_3px] shadow-gold/10",
        tone === "pending" && "animate-pulse bg-gold",
        tone === "muted" && "bg-muted-foreground/50",
        tone === "live" && "bg-diamond shadow-[0_0_0_3px] shadow-diamond/10",
        animated && "animate-pulse",
        className,
      )}
    />
  );
}

export function TypeBadge({
  type,
  tone,
  label,
}: {
  type?: string;
  tone: "grass" | "gold" | "muted";
  label: string;
}) {
  return (
    <Badge
      variant="outline"
      data-type={type}
      className={cn(
        "h-5 rounded-[5px] border px-1.5 font-mono text-[10px] font-medium tracking-wide",
        tone === "grass" && "border-primary/30 bg-primary/10 text-primary",
        tone === "gold" && "border-gold/30 bg-gold/10 text-gold",
        tone === "muted" && "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {label}
    </Badge>
  );
}

export function ProgressBar({
  progress,
  compact = false,
}: {
  progress: InstallProgress;
  compact?: boolean;
}) {
  const percent = progressPercent(progress.done, progress.total);
  return (
    <div className={cn("flex flex-col gap-2", compact && "gap-1.5")}>
      <Progress
        value={percent ?? 30}
        aria-label={`${stageLabel(progress.stage)}进度`}
        aria-valuenow={percent ?? undefined}
        className={cn(
          "h-1.5 rounded-sm bg-primary/15 [&_[data-slot=progress-indicator]]:rounded-sm",
          percent === null && "animate-pulse",
        )}
      />
      <div
        className={cn(
          "flex items-center justify-between gap-3 text-[11px] text-muted-foreground",
          compact && "text-[10px]",
        )}
      >
        <span className="shrink-0">{stageLabel(progress.stage)}</span>
        <span className="tabular truncate text-right" title={progress.detail}>
          {percent === null ? progress.detail : `${percent}% · ${progress.detail}`}
        </span>
      </div>
    </div>
  );
}
