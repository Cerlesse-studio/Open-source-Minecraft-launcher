import test from "node:test";
import assert from "node:assert/strict";
import { isBedrockVersionId, pickAutoVersion } from "./autoVersion.ts";
import type { InstalledVersion, VersionManifest } from "./types.ts";

function version(
  id: string,
  overrides: Partial<InstalledVersion> = {},
): InstalledVersion {
  return { id, type: "release", installedAt: 0, ...overrides };
}

const manifest: VersionManifest = {
  latest: { release: "1.21.3", snapshot: "25w01a" },
  versions: [
    { id: "1.21.3", type: "release", url: "" },
    { id: "1.21.2", type: "release", url: "" },
    { id: "1.20.1", type: "release", url: "" },
    { id: "25w01a", type: "snapshot", url: "" },
  ],
};

test("pickAutoVersion prefers a newly detected version", () => {
  const installed = [version("1.21.3"), version("1.21.2")];
  assert.equal(
    pickAutoVersion(installed, manifest, { prefer: ["1.21.2"] }),
    "1.21.2",
  );
});

test("pickAutoVersion selects the newest release by manifest order", () => {
  const installed = [version("1.20.1"), version("1.21.2"), version("1.21.3")];
  assert.equal(pickAutoVersion(installed, manifest), "1.21.3");
});

test("pickAutoVersion prefers a release over a newer snapshot", () => {
  const installed = [version("25w01a", { type: "snapshot" }), version("1.21.2")];
  assert.equal(pickAutoVersion(installed, manifest), "1.21.2");
});

test("pickAutoVersion prefers a plain client over a modded instance", () => {
  const installed = [
    version("1.21.3-fabric", { loader: "fabric" }),
    version("1.21.3"),
  ];
  assert.equal(pickAutoVersion(installed, manifest), "1.21.3");
});

test("pickAutoVersion falls back to the newest unknown instance", () => {
  const installed = [
    version("OldPack", { installedAt: 100 }),
    version("NewPack", { installedAt: 200 }),
  ];
  assert.equal(pickAutoVersion(installed, manifest), "NewPack");
});

test("pickAutoVersion returns an empty string without instances", () => {
  assert.equal(pickAutoVersion([], manifest), "");
});

test("isBedrockVersionId recognises Bedrock selections", () => {
  assert.equal(isBedrockVersionId("uwp"), true);
  assert.equal(isBedrockVersionId("bedrock:1.21"), true);
  assert.equal(isBedrockVersionId("Minecraft 基岩版"), true);
  assert.equal(isBedrockVersionId("1.21.3"), false);
});
