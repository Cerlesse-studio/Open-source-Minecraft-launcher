import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "cn";
import { progressPercent, stageLabel } from "../lib/format";
import type { InstallProgress } from "../lib/types";

const GRASS_COLORS: Record<string, string> = {
  g: "#83c956",
  d: "#6cae42",
  k: "#4f8b31",
  b: "#8b6a4a",
  r: "#71523a",
  s: "#5b412c",
  p: "#8d8d84",
  o: "#55554f",
};

const GRASS_PIXELS = [
  "ggdgggdggdgggggd",
  "gdgggkggggdgggkg",
  "ggggdggggggggdgg",
  "dkgggdgggkgdgggg",
  "gddgggdggddgkggd",
  "brrdrrrrrdrrrdrr",
  "rrbrrrrdrrrrbrrr",
  "rrrrrsrrrrrrrrrr",
  "rrbrrrrrrprrrrrr",
  "rrrrrrprrrrrrbrr",
  "rbrrrrrrrrrsrrrr",
  "rrrrsrrrrrrrrrpr",
  "rrprrrrrbrrrrrrr",
  "rrrrrrrrrrrrrrsr",
  "rrrsrrrrrrbrrrrr",
  "rrrrrrrrprrrrrrr",
];

export function GrassBlock({
  size = 96,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={cn("pixelated shrink-0", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
    >
      {GRASS_PIXELS.map((row, y) =>
        row.split("").map((pixel, x) => (
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width="1"
            height="1"
            fill={GRASS_COLORS[pixel] ?? GRASS_COLORS.r}
          />
        )),
      )}
    </svg>
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

export function Avatar({
  name,
  size = 40,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
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
      className={cn("pixelated shrink-0", className)}
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
