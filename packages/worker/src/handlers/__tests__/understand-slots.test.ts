// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many readings of media one worker holds in memory at once (inner#1337
 * §3.3).
 *
 * A reading loads up to `max_media_bytes` into memory, and the tasks queue
 * runs many jobs at once. A reading that finds every place taken does not
 * wait in its worker slot: it goes back to the queue and comes back later.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@breatic/core", () => ({
  getUnderstandConfig: () => ({ max_concurrent: 2 }),
  getWorkerConfig: () => ({ poll_interval: 3_000 }),
}));

const { withUnderstandSlot } = await import("@worker/handlers/understand-slots.js");
const { StillRunning } = await import("@worker/handlers/still-running.js");

const NOW = 1_800_000_000_000;

/**
 * A reading that stays open until the test lets it finish.
 * @returns The reading's promise and its two ways out.
 */
function openReading(): { run: Promise<string>; finish: () => void; fail: () => void } {
  let finish = (): void => undefined;
  let fail = (): void => undefined;
  const run = withUnderstandSlot(
    () =>
      new Promise<string>((resolve, reject) => {
        finish = () => resolve("read");
        fail = () => reject(new Error("refused"));
      }),
  );
  return { run, finish: () => finish(), fail: () => fail() };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withUnderstandSlot", () => {
  it("runs a reading while a place is free", async () => {
    await expect(withUnderstandSlot(async () => "read")).resolves.toBe("read");
  });

  it("sends a reading back to the queue, without starting it, when every place is taken", async () => {
    const a = openReading();
    const b = openReading();
    const third = vi.fn(async () => "read");

    const err = await withUnderstandSlot(third).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StillRunning);
    expect((err as InstanceType<typeof StillRunning>).resumeAt).toBe(NOW + 3_000);
    expect(third).not.toHaveBeenCalled();
    a.finish();
    b.finish();
    await Promise.all([a.run, b.run]);
  });

  it("gives the place back when a reading finishes", async () => {
    const a = openReading();
    const b = openReading();
    a.finish();
    await a.run;

    await expect(withUnderstandSlot(async () => "next")).resolves.toBe("next");
    b.finish();
    await b.run;
  });

  it("gives the place back when a reading fails", async () => {
    const a = openReading();
    const b = openReading();
    a.fail();
    await expect(a.run).rejects.toThrow("refused");

    await expect(withUnderstandSlot(async () => "next")).resolves.toBe("next");
    b.finish();
    await b.run;
  });
});
