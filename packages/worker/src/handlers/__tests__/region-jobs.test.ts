// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The worker's cross-region jobs hand work to the right place (inner#1955). */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

const h = vi.hoisted(() => ({
  callRegion: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  recordRegionUsage: vi.fn(async (_report: { usage: unknown[]; asOf: unknown }) => undefined),
  usagePerStudio: vi.fn(async () => [{ studioId: "s-1", bytes: 10 }]),
  listDue: vi.fn(async (): Promise<Array<{ slug: string; studioId: string; region: string | null }>> => []),
  settle: vi.fn(async () => undefined),
  getById: vi.fn(async (): Promise<{ slug: string } | null> => null),
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
  env: { REGION: "sg", GLOBAL_REGION: "us-west", INTERNAL_API_SECRET: "secret", REGION_API_URLS: { "us-west": "http://global.invalid" }, DIRECTORY_RECONCILE_ON_START: true },
  logger: { error: h.logError },
  getRegionsConfig: () => ({ global_api_timeout_ms: 5000, slug_reservation_stale_ms: 600000, slug_reservation_sweep_batch: 50 }),
  callRegion: h.callRegion,
  GlobalApiError: FakeGlobalApiError,
  isRegionUnavailable: h.isRegionUnavailable,
  assetRepo: { usagePerStudio: h.usagePerStudio },
  studioDirectoryRepo: { listDueSlugReservations: h.listDue },
}));

vi.mock("@breatic/domain", () => ({
  globalApi: () => ({ recordRegionUsage: h.recordRegionUsage, applyRegionEvent: h.applyRegionEvent }),
  regionOutboxService: { relayOutbox: h.relayOutbox },
  directoryWrites: { settleSlugReservation: h.settle },
  studioRepo: { getById: h.getById },
  studioDirectoryService: { reconcileDirectoryAfterUpgrade: h.reconcile },
}));

const { forwardInvitationClaim, forwardRevocation, reconcileDirectoryOnStart, relayRegionOutbox, sweepSlugReservations, syncStorageUsage } = await import("@worker/handlers/region-jobs.js");

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

  it("settles a past-due slug from the slug its region holds, and keeps it when the region does not answer", async () => {
    h.listDue.mockResolvedValueOnce([
      { slug: "here", studioId: "s-local", region: "sg" },
      { slug: "there", studioId: "s-us", region: null },
      { slug: "lost", studioId: "s-eu", region: "eu" },
    ]);
    h.getById.mockResolvedValueOnce({ slug: "here" });
    h.callRegion.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === "eu") throw new Error("no address for region eu");
      return "renamed-again";
    });

    expect(await sweepSlugReservations()).toBe(2);
    expect(h.settle).toHaveBeenCalledWith("here", "s-local", "here");
    expect(h.callRegion).toHaveBeenCalledWith("us-west", "studioSlug", ["s-us"], 5000);
    expect(h.settle).toHaveBeenCalledWith("there", "s-us", "renamed-again");
    expect(h.settle).not.toHaveBeenCalledWith("lost", expect.anything(), expect.anything());
    expect(h.logError).toHaveBeenCalledWith(expect.objectContaining({ studioId: "s-eu" }), "slug_reservation_settle_failed");
  });

  // inner#1955: a self-hosted upgrade swaps every container in one
  // `docker compose up`; the worker starts last, so it aligns the directory.
  it("leaves the directory alignment to the global region", async () => {
    expect(await reconcileDirectoryOnStart()).toBe(0);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

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
