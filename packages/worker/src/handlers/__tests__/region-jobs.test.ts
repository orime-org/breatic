// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The worker's cross-region jobs hand work to the right place (inner#1955). */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

const h = vi.hoisted(() => ({
  callRegion: vi.fn(async () => null),
  recordRegionUsage: vi.fn(async () => undefined),
  usagePerStudio: vi.fn(async () => [{ studioId: "s-1", bytes: 10 }]),
  listDue: vi.fn(async (): Promise<Array<{ slug: string; studioId: string; region: string | null }>> => []),
  settle: vi.fn(async () => undefined),
  getById: vi.fn(async (): Promise<{ slug: string } | null> => null),
  logError: vi.fn(),
}));

vi.mock("@breatic/core", () => ({
  env: { REGION: "sg", GLOBAL_REGION: "us-west", INTERNAL_API_SECRET: "secret", REGION_API_URLS: { "us-west": "http://global.invalid" } },
  logger: { error: h.logError },
  getRegionsConfig: () => ({ global_api_timeout_ms: 5000, slug_reservation_stale_ms: 600000 }),
  callRegion: h.callRegion,
  assetRepo: { usagePerStudio: h.usagePerStudio },
  studioDirectoryRepo: { listDueSlugReservations: h.listDue },
}));

vi.mock("@breatic/domain", () => ({
  globalApi: () => ({ recordRegionUsage: h.recordRegionUsage }),
  regionOutboxService: { relayOutbox: vi.fn() },
  directoryWrites: { settleSlugReservation: h.settle },
  studioRepo: { getById: h.getById },
}));

const { forwardInvitationClaim, forwardRevocation, sweepSlugReservations, syncStorageUsage } = await import("@worker/handlers/region-jobs.js");

beforeEach(() => vi.clearAllMocks());

describe("region jobs", () => {
  it("asks the named region to claim, signed as this region", async () => {
    await forwardInvitationClaim({ data: { region: "us-west", userId: "u-1" } } as Job<{ region: string; userId: string }>);
    expect(h.callRegion).toHaveBeenCalledWith("claimEmailInvitations", ["u-1"], expect.objectContaining({ callerRegion: "sg", url: "http://global.invalid" }));
  });

  it("throws for a region with no address, so the job retries", async () => {
    await expect(
      forwardRevocation({ data: { region: "eu", userId: "u-1", sids: ["a"] } } as Job<{ region: string; userId: string; sids: string[] }>),
    ).rejects.toThrow("no address for region eu");
    expect(h.callRegion).not.toHaveBeenCalled();
  });

  it("reports this region's usage per Studio under its own code", async () => {
    expect(await syncStorageUsage()).toBe(1);
    expect(h.recordRegionUsage).toHaveBeenCalledWith(
      expect.objectContaining({ region: "sg", usage: [{ studioId: "s-1", bytes: 10 }] }),
    );
  });

  it("settles a past-due slug from the slug its region holds, and keeps it when the region does not answer", async () => {
    h.listDue.mockResolvedValueOnce([
      { slug: "here", studioId: "s-local", region: "sg" },
      { slug: "there", studioId: "s-us", region: null },
      { slug: "lost", studioId: "s-eu", region: "eu" },
    ]);
    h.getById.mockResolvedValueOnce({ slug: "here" });
    h.callRegion.mockResolvedValueOnce("renamed-again" as never);

    expect(await sweepSlugReservations()).toBe(2);
    expect(h.settle).toHaveBeenCalledWith("here", "s-local", "here");
    expect(h.callRegion).toHaveBeenCalledWith("studioSlug", ["s-us"], expect.objectContaining({ url: "http://global.invalid" }));
    expect(h.settle).toHaveBeenCalledWith("there", "s-us", "renamed-again");
    expect(h.settle).not.toHaveBeenCalledWith("lost", expect.anything(), expect.anything());
    expect(h.logError).toHaveBeenCalledWith(expect.objectContaining({ studioId: "s-eu" }), "slug_reservation_settle_failed");
  });
});
