// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which queues a worker runs depends on its region (inner#1955): the global
 * region alone runs the work on global data (ads conversions, finishing
 * pending Studio creations and slug reservations, forwarding revocations to
 * other regions), and only a region that is not global relays its outbox.
 * Everything that works on a region's own Studios runs in every region.
 */

import { describe, expect, it } from "vitest";
import { ADS_CONVERSION_QUEUE } from "@breatic/core";
import { workerQueuesFor } from "@worker/runtime/region-queues.js";

const GLOBAL_ONLY = [
  ADS_CONVERSION_QUEUE,
  "studio-creation-sweep",
  "slug-reservation-sweep",
  "identity-revocation-forward",
];

const REGIONAL_ONLY = ["region-outbox-relay"];

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
  "studio-transfer-accepting-sweep",
];

describe("workerQueuesFor", () => {
  it("runs the global work and no outbox relay in the region that holds the global data", () => {
    const queues = workerQueuesFor({ region: "us-west", globalRegion: "us-west" });
    for (const queue of [...GLOBAL_ONLY, ...EVERY_REGION]) expect(queues).toContain(queue);
    for (const queue of REGIONAL_ONLY) expect(queues).not.toContain(queue);
  });

  it("runs the outbox relay and none of the global work in any other region", () => {
    const queues = workerQueuesFor({ region: "sg", globalRegion: "us-west" });
    for (const queue of [...REGIONAL_ONLY, ...EVERY_REGION]) expect(queues).toContain(queue);
    for (const queue of GLOBAL_ONLY) expect(queues).not.toContain(queue);
  });

  it("treats a single-region deployment as the global region", () => {
    expect(workerQueuesFor({ region: "default", globalRegion: "default" })).toEqual(
      workerQueuesFor({ region: "us-west", globalRegion: "us-west" }),
    );
  });
});
