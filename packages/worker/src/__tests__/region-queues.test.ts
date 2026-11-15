// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which queues a worker runs depends on its region (inner#1955): the global
 * region alone runs the work on global data (ads conversions) and, when other
 * regions exist, the work it does for them (settling slug reservations,
 * forwarding revocations and email-invitation claims); only a region that is
 * not global relays its outbox. Everything that works on a region's own
 * Studios runs in every region.
 */

import { describe, expect, it } from "vitest";
import { ADS_CONVERSION_QUEUE } from "@breatic/core";
import { workerQueuesFor } from "@worker/runtime/region-queues.js";

const GLOBAL_ONLY = [ADS_CONVERSION_QUEUE];

const GLOBAL_WITH_REGIONS = ["slug-reservation-sweep", "identity-revocation-forward", "invitation-claim-forward"];

const REGIONAL_ONLY = ["region-outbox-relay", "credit-hold-release"];

const EVERY_REGION = [
  "tasks",
  "url-ingest",
  "upload-finish",
  "usage-lookup",
  "media-read",
  "audio-peaks",
  "mail",
  "long-media-dispatch",
  "timeline",
  "timeline-sweep",
  "credit-charge-sweep",
];

describe("workerQueuesFor", () => {
  it("runs the global work and no outbox relay in the region that holds the global data", () => {
    const queues = workerQueuesFor({ region: "us-west", globalRegion: "us-west", otherRegions: ["sg"] });
    for (const queue of [...GLOBAL_ONLY, ...GLOBAL_WITH_REGIONS, ...EVERY_REGION]) expect(queues).toContain(queue);
    for (const queue of REGIONAL_ONLY) expect(queues).not.toContain(queue);
  });

  it("runs the outbox relay and none of the global work in any other region", () => {
    const queues = workerQueuesFor({ region: "sg", globalRegion: "us-west", otherRegions: ["us-west"] });
    for (const queue of [...REGIONAL_ONLY, ...EVERY_REGION]) expect(queues).toContain(queue);
    for (const queue of [...GLOBAL_ONLY, ...GLOBAL_WITH_REGIONS]) expect(queues).not.toContain(queue);
  });

  it("reports storage use to the global region wherever another region exists", () => {
    expect(workerQueuesFor({ region: "us-west", globalRegion: "us-west", otherRegions: ["sg"] })).toContain("storage-usage-sync");
    expect(workerQueuesFor({ region: "sg", globalRegion: "us-west", otherRegions: ["us-west"] })).toContain("storage-usage-sync");
  });

  it("treats a single-region deployment as the global region, with none of the work for other regions", () => {
    const single = workerQueuesFor({ region: "default", globalRegion: "default", otherRegions: [] });
    for (const queue of ["storage-usage-sync", ...GLOBAL_WITH_REGIONS]) expect(single).not.toContain(queue);
    expect([...single].sort()).toEqual([...GLOBAL_ONLY, ...EVERY_REGION].sort());
  });
});
