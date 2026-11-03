import test from "node:test";
import assert from "node:assert/strict";
import { watchRoomHealth } from "./multiplayerHealth.ts";

test("leaves the room after two consecutive failed probes", async () => {
  let probes = 0;
  let closed = 0;

  await watchRoomHealth({
    probe: async () => {
      probes += 1;
      throw new Error("host resource service stopped");
    },
    onClosed: () => {
      closed += 1;
    },
    intervalMs: 1,
    failureLimit: 2,
  });

  assert.equal(probes, 2);
  assert.equal(closed, 1);
});

test("a successful probe resets the failure count", async () => {
  const controller = new AbortController();
  let probes = 0;
  let closed = 0;

  await watchRoomHealth({
    probe: async () => {
      probes += 1;
      // Fail twice in a row would close the room, so alternate a success
      // between failures and abort once enough probes have been observed.
      if (probes === 1 || probes === 3) {
        throw new Error("temporary network blip");
      }
      if (probes >= 5) controller.abort();
    },
    onClosed: () => {
      closed += 1;
    },
    intervalMs: 1,
    failureLimit: 2,
    signal: controller.signal,
  });

  assert.equal(probes, 5);
  assert.equal(closed, 0);
});

test("aborting does not kick the guest", async () => {
  const controller = new AbortController();
  let closed = 0;

  await watchRoomHealth({
    probe: async () => {
      controller.abort();
      throw new Error("request was interrupted");
    },
    onClosed: () => {
      closed += 1;
    },
    intervalMs: 1,
    failureLimit: 1,
    signal: controller.signal,
  });

  assert.equal(closed, 0);
});
