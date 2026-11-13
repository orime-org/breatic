// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/** The worker's cross-region jobs hand work to the right place (inner#1955). */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";

const h = vi.hoisted(() => ({
  callRegion: vi.fn(async () => null),
  recordRegionUsage: vi.fn(async () => undefined),
  usagePerStudio: vi.fn(async () => [{ studioId: "s-1", bytes: 10 }]),
}));

vi.mock("@breatic/core", () => ({
  env: { REGION: "sg", INTERNAL_API_SECRET: "secret", REGION_API_URLS: { "us-west": "http://global.invalid" } },
  getRegionsConfig: () => ({ global_api_timeout_ms: 5000, slug_reservation_stale_ms: 600000 }),
  callRegion: h.callRegion,
  assetRepo: { usagePerStudio: h.usagePerStudio },
  studioDirectoryRepo: { releaseStaleSlugReservations: vi.fn(async () => 0) },
}));

vi.mock("@breatic/domain", () => ({
  globalApi: () => ({ recordRegionUsage: h.recordRegionUsage }),
  regionOutboxService: { relayOutbox: vi.fn() },
}));

const { forwardInvitationClaim, forwardRevocation, syncStorageUsage } = await import("@worker/handlers/region-jobs.js");

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
});
