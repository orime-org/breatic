// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/** The worker's cross-region jobs hand work to the right place (inner#1955). */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

const h = vi.hoisted(() => ({
  callRegion: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  recordRegionUsage: vi.fn(async (_report: { usage: unknown[]; asOf: unknown }) => undefined),
  usagePerStudio: vi.fn(async () => [{ studioId: "s-1", bytes: 10 }]),
  listDue: vi.fn(async (): Promise<Array<{ slug: string; studioId: string; region: string | null }>> => []),
  settle: vi.fn(async () => undefined),
  postpone: vi.fn(async () => undefined),
  slugState: vi.fn(async (): Promise<{ slug: string | null; eventsInFlight: boolean }> => ({ slug: null, eventsInFlight: false })),
  logError: vi.fn(),
  relayOutbox: vi.fn(),
  reconcile: vi.fn(async () => 3),
  applyRegionEvent: vi.fn(),
  isRegionUnavailable: vi.fn((err: unknown) => (err as { status: number }).status >= 500),
}));

class FakeGlobalApiError extends Error {
  /**
   * A refusal as core reports it.
   * @param status - The HTTP status.
   */
  constructor(readonly status: number) {
    super(`refused with ${status}`);
  }
}

vi.mock("@breatic/core", () => ({
  env: { REGION: "sg", GLOBAL_REGION: "us-west", INTERNAL_API_SECRET: "secret", REGION_API_URLS: { "us-west": "http://global.invalid" }, DIRECTORY_RECONCILE_ON_START: true, REDIS_KEY_PREFIX: "test" },
  getNodeTaskConfig: () => ({ default_budget_ms: 7_200_000 }),
  logger: { error: h.logError },
  getRegionsConfig: () => ({ global_api_timeout_ms: 5000, slug_reservation_stale_ms: 600000, slug_reservation_sweep_batch: 50, storage_usage_report_batch: 500 }),
  callRegion: h.callRegion,
  GlobalApiError: FakeGlobalApiError,
  isRegionUnavailable: h.isRegionUnavailable,
  assetRepo: { usagePerStudio: h.usagePerStudio },
  studioDirectoryRepo: { listDueSlugReservations: h.listDue },
}));

vi.mock("@breatic/domain", () => ({
  globalApi: () => ({ recordRegionUsage: h.recordRegionUsage, applyRegionEvent: h.applyRegionEvent }),
  regionOutboxService: { relayOutbox: h.relayOutbox },
  directoryWrites: { settleSlugReservation: h.settle, slugState: h.slugState, postponeSlugReservation: h.postpone },
  studioDirectoryService: { reconcileDirectoryAfterUpgrade: h.reconcile },
}));

const { forwardInvitationClaim, forwardRevocation, reconcileDirectoryOnStart, relayRegionOutbox, reportHoldCleanupGaveUp, sweepSlugReservations, syncStorageUsage } = await import("@worker/handlers/region-jobs.js");

beforeEach(() => vi.clearAllMocks());

describe("region jobs", () => {
  it("asks the named region to claim, signed as this region", async () => {
    await forwardInvitationClaim({ data: { region: "us-west", userId: "u-1" } } as Job<{ region: string; userId: string }>);
    expect(h.callRegion).toHaveBeenCalledWith("us-west", "claimEmailInvitations", ["u-1"], 5000);
  });

  it("throws when the region does not answer, so the job retries", async () => {
    h.callRegion.mockRejectedValueOnce(new Error("no address for region eu"));
    await expect(
      forwardRevocation({ data: { region: "eu", userId: "u-1", sids: ["a"] } } as Job<{ region: string; userId: string; sids: string[] }>),
    ).rejects.toThrow("no address for region eu");
  });

  it("reports this region's usage per Studio under its own code", async () => {
    expect(await syncStorageUsage()).toBe(1);
    expect(h.recordRegionUsage).toHaveBeenCalledWith(
      expect.objectContaining({ region: "sg", usage: [{ studioId: "s-1", bytes: 10 }] }),
    );
  });

  it("reports a large region in batches that fit the internal body limit, all as of one instant", async () => {
    h.usagePerStudio.mockResolvedValueOnce(Array.from({ length: 1201 }, (_, i) => ({ studioId: `s-${i}`, bytes: i })));

    expect(await syncStorageUsage()).toBe(1201);
    const sizes = h.recordRegionUsage.mock.calls.map(([report]) => report.usage.length);
    expect(sizes).toEqual([500, 500, 201]);
    const instants = new Set(h.recordRegionUsage.mock.calls.map(([report]) => String(report.asOf)));
    expect(instants.size).toBe(1);
  });

  it("stamps the report with when the measurement started", async () => {
    let started = 0;
    h.usagePerStudio.mockImplementationOnce(async () => {
      started = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [{ studioId: "s-1", bytes: 10 }];
    });

    await syncStorageUsage();
    const [report] = h.recordRegionUsage.mock.calls[0]!;
    expect((report.asOf as Date).getTime()).toBeLessThanOrEqual(started);
  });

  it("throws what stopped the relay, so the job is logged as failed", async () => {
    const down = new Error("global region down");
    h.relayOutbox.mockResolvedValueOnce({ delivered: 2, deadLettered: 0, stoppedBy: down });

    await expect(relayRegionOutbox()).rejects.toBe(down);
  });

  it("raises an alert for every event set aside", async () => {
    h.relayOutbox.mockResolvedValueOnce({ delivered: 1, deadLettered: 2 });

    expect(await relayRegionOutbox()).toEqual({ delivered: 1, deadLettered: 2 });
    expect(h.logError).toHaveBeenCalledWith(expect.objectContaining({ deadLettered: 2, region: "sg" }), "region_outbox_dead_lettered");
  });

  it("sets aside an event the global region refuses outright and retries one it could not take now", async () => {
    let deliver: (event: unknown) => Promise<string> = async () => "applied";
    h.relayOutbox.mockImplementation(async (options: { deliver: typeof deliver }) => {
      deliver = options.deliver;
      return { delivered: 0, deadLettered: 0 };
    });
    await relayRegionOutbox();

    h.applyRegionEvent.mockRejectedValueOnce(new FakeGlobalApiError(413));
    h.isRegionUnavailable.mockReturnValueOnce(false);
    expect(await deliver({ id: "1" })).toBe("permanent_failure");
    const unavailable = new FakeGlobalApiError(401);
    h.applyRegionEvent.mockRejectedValueOnce(unavailable);
    h.isRegionUnavailable.mockReturnValueOnce(true);
    await expect(deliver({ id: "2" })).rejects.toBe(unavailable);
    expect(h.isRegionUnavailable).toHaveBeenLastCalledWith(unavailable);
    h.applyRegionEvent.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(deliver({ id: "3" })).rejects.toThrow("socket hang up");
    h.applyRegionEvent.mockResolvedValueOnce("applied");
    expect(await deliver({ id: "4" })).toBe("applied");
  });

  it("settles a past-due slug from what its region says, and keeps it when the region does not answer", async () => {
    h.listDue.mockResolvedValueOnce([
      { slug: "here", studioId: "s-local", region: "sg" },
      { slug: "there", studioId: "s-us", region: null },
      { slug: "lost", studioId: "s-eu", region: "eu" },
    ]);
    h.slugState.mockResolvedValueOnce({ slug: "here", eventsInFlight: false });
    h.callRegion.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "eu") throw new Error("no address for region eu");
      return { slug: "renamed-again", eventsInFlight: true };
    });

    expect(await sweepSlugReservations()).toBe(2);
    expect(h.slugState).toHaveBeenCalledWith("s-local");
    expect(h.settle).toHaveBeenCalledWith("here", "s-local", { slug: "here", eventsInFlight: false });
    expect(h.callRegion).toHaveBeenCalledWith("us-west", "studioSlugState", ["s-us"], 5000);
    expect(h.settle).toHaveBeenCalledWith("there", "s-us", { slug: "renamed-again", eventsInFlight: true });
    expect(h.settle).not.toHaveBeenCalledWith("lost", expect.anything(), expect.anything());
    expect(h.logError).toHaveBeenCalledWith(expect.objectContaining({ studioId: "s-eu" }), "slug_reservation_ask_failed");
  });

  // inner#1955: a region that stays down must not keep its due reservations
  // at the head of every batch, ahead of every other region's.
  it("postpones what a region could not answer and asks that region nothing more in the pass", async () => {
    h.callRegion.mockReset();
    h.postpone.mockClear();
    h.listDue.mockResolvedValueOnce([
      { slug: "a", studioId: "s-a", region: "eu" },
      { slug: "b", studioId: "s-b", region: "eu" },
      { slug: "c", studioId: "s-c", region: "us-west" },
    ]);
    h.callRegion.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "eu") throw new Error("eu is down");
      return { slug: "c", eventsInFlight: false };
    });

    expect(await sweepSlugReservations()).toBe(1);
    expect(h.callRegion.mock.calls.filter((call) => call[0] === "eu")).toHaveLength(1);
    expect(h.postpone).toHaveBeenCalledWith("a", "s-a");
    expect(h.postpone).toHaveBeenCalledWith("b", "s-b");
    expect(h.settle).toHaveBeenCalledWith("c", "s-c", { slug: "c", eventsInFlight: false });
  });

  // inner#1955: only a region that gave no answer is skipped; a failure
  // writing the answer here says nothing about the region.
  it("keeps asking a region whose answer could not be settled here", async () => {
    h.callRegion.mockReset();
    h.postpone.mockClear();
    h.settle.mockReset();
    h.listDue.mockResolvedValueOnce([
      { slug: "d", studioId: "s-d", region: "us-west" },
      { slug: "e", studioId: "s-e", region: "us-west" },
    ]);
    h.callRegion.mockResolvedValue({ slug: "x", eventsInFlight: false });
    h.settle.mockRejectedValueOnce(new Error("deadlock detected")).mockResolvedValueOnce(undefined);

    expect(await sweepSlugReservations()).toBe(1);
    expect(h.callRegion.mock.calls.filter((call) => call[0] === "us-west")).toHaveLength(2);
    expect(h.postpone).not.toHaveBeenCalled();
    expect(h.logError).toHaveBeenCalledWith(expect.objectContaining({ studioId: "s-d" }), "slug_reservation_settle_failed");
  });

  // inner#1955: every worker instance hears a hold cleanup's final failure;
  // only the one that claims it logs, and a Redis error still logs.
  it("logs a hold cleanup's final failure once across instances, and when the claim cannot be made", async () => {
    const set = vi.fn().mockResolvedValueOnce("OK").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("redis down"));
    const redis = { set } as unknown as Parameters<typeof reportHoldCleanupGaveUp>[0];
    const gaveUp = (): number => h.logError.mock.calls.filter((call) => call[1] === "credit_hold_cleanup_gave_up").length;

    await reportHoldCleanupGaveUp(redis, "task-1", "refused");
    await reportHoldCleanupGaveUp(redis, "task-1", "refused");
    expect(set).toHaveBeenCalledWith("test:hold-cleanup-gave-up:task-1", "1", "PX", 7_200_000, "NX");
    expect(gaveUp()).toBe(1);

    await reportHoldCleanupGaveUp(redis, "task-2", "refused");
    expect(gaveUp()).toBe(2);
  });

  // An extension's job id carries its target after the hold's key; the log
  // names the hold and what gave up.
  it("logs a queued extension that gave up under its hold's key", async () => {
    const set = vi.fn().mockResolvedValueOnce("OK");
    const redis = { set } as unknown as Parameters<typeof reportHoldCleanupGaveUp>[0];

    await reportHoldCleanupGaveUp(redis, "task-3:extend:1763280000000", "refused");

    expect(set).toHaveBeenCalledWith("test:hold-cleanup-gave-up:task-3:extend:1763280000000", "1", "PX", 7_200_000, "NX");
    expect(h.logError).toHaveBeenCalledWith(
      { referenceId: "task-3", action: "extend", jobId: "task-3:extend:1763280000000", failedReason: "refused" },
      "credit_hold_cleanup_gave_up",
    );
  });

  // inner#1955: a self-hosted upgrade swaps every container in one
  // `docker compose up`; the worker starts last, so it aligns the directory.
  it("leaves it alone in a deployment that runs it by hand after the rollout", async () => {
    const { env } = await import("@breatic/core");
    const mutable = env as { REGION: string; DIRECTORY_RECONCILE_ON_START: boolean };
    mutable.REGION = "us-west";
    mutable.DIRECTORY_RECONCILE_ON_START = false;
    try {
      expect(await reconcileDirectoryOnStart()).toBe(0);
      expect(h.reconcile).not.toHaveBeenCalled();
    } finally {
      mutable.REGION = "sg";
      mutable.DIRECTORY_RECONCILE_ON_START = true;
    }
  });

  it("aligns the directory once in the global region", async () => {
    const { env } = await import("@breatic/core");
    const region = env.REGION;
    (env as { REGION: string }).REGION = "us-west";
    try {
      expect(await reconcileDirectoryOnStart()).toBe(3);
      expect(h.reconcile).toHaveBeenCalledTimes(1);
    } finally {
      (env as { REGION: string }).REGION = region;
    }
  });
});
