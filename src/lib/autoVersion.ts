import type { InstalledVersion, VersionManifest } from "./types";

/**
 * The launcher used to take `installed[0]`, which is whatever order the
 * version scan happened to produce. Automatic selection instead ranks the
 * detected instances: newly detected ones first, then official releases
 * (newest first), then snapshots and loader instances.
 */

/** Mojang lists manifest versions newest-first, so a lower index is newer. */
function manifestRanks(manifest: VersionManifest | null): Map<string, number> {
  const ranks = new Map<string, number>();
  manifest?.versions.forEach((version, index) => ranks.set(version.id, index));
  return ranks;
}

function releaseRank(type: string): number {
  switch (type) {
    case "release":
      return 0;
    case "snapshot":
      return 1;
    case "old_beta":
      return 2;
    case "old_alpha":
      return 3;
    default:
      return 1;
  }
}

function numericParts(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number);
}

/** Descending comparison so "1.20.2" sorts before "1.20.1". */
function compareNumericIds(left: string, right: string): number {
  const a = numericParts(left);
  const b = numericParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (b[index] ?? 0) - (a[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return right.localeCompare(left);
}

export interface PickAutoVersionOptions {
  /** Versions just detected by a scan; one of them wins if possible. */
  prefer?: Iterable<string>;
}

/**
 * Picks the instance the launcher should select on its own. Returns an empty
 * string when nothing is installed.
 */
export function pickAutoVersion(
  installed: InstalledVersion[],
  manifest: VersionManifest | null,
  options: PickAutoVersionOptions = {},
): string {
  if (installed.length === 0) return "";
  const ranks = manifestRanks(manifest);
  const preferred = new Set(options.prefer ?? []);

  const rankOf = (version: InstalledVersion) =>
    ranks.get(version.id) ??
    (version.mcVersion ? ranks.get(version.mcVersion) : undefined);

  const sorted = [...installed].sort((left, right) => {
    const preferredDiff =
      Number(!preferred.has(left.id)) - Number(!preferred.has(right.id));
    if (preferredDiff !== 0) return preferredDiff;

    const typeDiff = releaseRank(left.type) - releaseRank(right.type);
    if (typeDiff !== 0) return typeDiff;

    const leftRank = rankOf(left);
    const rightRank = rankOf(right);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }

    // Prefer the plain client over a modded instance of the same version.
    const loaderDiff =
      Number(Boolean(left.loader || left.optifineVersion)) -
      Number(Boolean(right.loader || right.optifineVersion));
    if (loaderDiff !== 0) return loaderDiff;

    if (left.installedAt !== right.installedAt) {
      return right.installedAt - left.installedAt;
    }

    return compareNumericIds(left.id, right.id);
  });

  return sorted[0]?.id ?? "";
}

/** True when `id` names a Bedrock selection rather than a Java instance. */
export function isBedrockVersionId(id: string): boolean {
  return (
    id === "uwp" ||
    id === "bedrock-uwp" ||
    id.startsWith("bedrock:") ||
    id.startsWith("bedrock-") ||
    id.includes("基岩版")
  );
}
