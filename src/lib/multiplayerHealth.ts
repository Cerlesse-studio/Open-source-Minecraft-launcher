/**
 * Watches whether a multiplayer room is still alive.
 *
 * EasyTier's peer/route table can keep showing the host after the host closes
 * the room, so the caller's `probe` should check something tied to the room
 * lifecycle (the host's room resource service). One failed probe may just be a
 * network blip; `failureLimit` consecutive failures mean the guest must leave.
 */
export interface RoomHealthWatchOptions {
  /** Resolves while the room is alive; rejects/throws when the probe fails. */
  probe: () => Promise<void>;
  /** Called exactly once after `failureLimit` consecutive failures. */
  onClosed: () => void | Promise<void>;
  /** Delay between probes. Defaults to 2 seconds. */
  intervalMs?: number;
  /** Consecutive failures required before leaving. Defaults to 2. */
  failureLimit?: number;
  /** Aborting stops the watcher without calling `onClosed`. */
  signal?: AbortSignal;
}

export async function watchRoomHealth({
  probe,
  onClosed,
  intervalMs = 2000,
  failureLimit = 2,
  signal,
}: RoomHealthWatchOptions): Promise<void> {
  if (signal?.aborted) return;

  let stopped = false;
  let failures = 0;
  const stop = () => {
    stopped = true;
  };
  signal?.addEventListener("abort", stop, { once: true });

  try {
    while (!stopped) {
      try {
        await probe();
        if (stopped) return;
        failures = 0;
      } catch {
        if (stopped) return;
        failures += 1;
        if (failures >= Math.max(1, failureLimit)) {
          stopped = true;
          await onClosed();
          return;
        }
      }

      if (stopped) return;
      await delay(intervalMs, signal);
    }
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", finish);
      resolve();
    }, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
  });
}
