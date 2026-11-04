import test from "node:test";
import assert from "node:assert/strict";
import { toJsdelivrUrl } from "./format.ts";

test("toJsdelivrUrl rewrites raw.githubusercontent.com URLs", () => {
  const raw =
    "https://raw.githubusercontent.com/Cerlesse-studio/Open-source-Minecraft-launcher/main/docs/images/logo.png";
  const expected =
    "https://cdn.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/logo.png";
  assert.equal(toJsdelivrUrl(raw), expected);
});

test("toJsdelivrUrl rewrites github.com/.../raw/... URLs", () => {
  const raw =
    "https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/raw/main/docs/images/home.png";
  const expected =
    "https://cdn.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/home.png";
  assert.equal(toJsdelivrUrl(raw), expected);
});

test("toJsdelivrUrl rewrites github.com/.../blob/... with raw=true", () => {
  const blob =
    "https://github.com/Cerlesse-studio/Open-source-Minecraft-launcher/blob/main/docs/images/download.png?raw=true";
  const expected =
    "https://cdn.jsdelivr.net/gh/Cerlesse-studio/Open-source-Minecraft-launcher@main/docs/images/download.png";
  assert.equal(toJsdelivrUrl(blob), expected);
});

test("toJsdelivrUrl leaves non-github URLs untouched", () => {
  assert.equal(toJsdelivrUrl("https://example.com/image.png"), "https://example.com/image.png");
  assert.equal(toJsdelivrUrl("/icons/minecraft/grass.png"), "/icons/minecraft/grass.png");
  assert.equal(toJsdelivrUrl(""), "");
  assert.equal(toJsdelivrUrl(null), "");
  assert.equal(toJsdelivrUrl(undefined), "");
});
