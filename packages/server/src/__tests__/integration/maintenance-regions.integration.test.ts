// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Storage reclaim follows the Studio's region (inner#1955, design 6.13): the
 * back office calls the global region, names the region with `?region=`,
 * and the global region hands the call to that region. Real PG + Redis, the
 * other region played by a stand-in.
 *
 * The pins:
 *
 *   1. A call naming another region is answered by that region's maintenance
 *      function with its arguments, and its answer is sent as it came.
 *   2. A call with no region, or naming this one, is answered here.
 *   3. A region this deployment does not reach is 422.
 *   4. A region that is unavailable is 503.
 */

import { describe, expect, it, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { GLOBAL_REGION_SETTINGS } from "./global-region-env.js";
import { StandInRefusal, startRegionStandIn } from "./region-harness.js";
import { call, useInternalApp } from "./internal-api-harness.js";

const sg = await startRegionStandIn();
const suite = useInternalApp("maintenance-regions", {
  REGION: "us-west",
  GLOBAL_REGION: "us-west",
  REGION_API_URLS: JSON.stringify({ sg: sg.url }),
  IDENTITY_SIGNING_KEY: GLOBAL_REGION_SETTINGS.IDENTITY_SIGNING_KEY,
  IDENTITY_SIGNING_KEY_ID: GLOBAL_REGION_SETTINGS.IDENTITY_SIGNING_KEY_ID,
});
const base = "/internal/v1/maintenance";

afterEach(() => {
  sg.reset();
});

afterAll(async () => {
  await sg.close();
});

describe("storage reclaim in another region", () => {
  it("hands a call naming another region to that region and sends its answer", async () => {
    sg.answers.maintenanceCandidates = { status: 200, body: { items: [{ id: "far" }], nextCursor: null } };

    const response = await call(suite.baseUrl, `${base}/reclaim/candidates?pageSize=5&region=sg`);

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ items: [{ id: "far" }], nextCursor: null });
    expect(sg.received).toEqual([{ side: "region", fn: "maintenanceCandidates", args: [5, null], signed: true }]);
  });

  it("hands an operation's control to the region with the whole request", async () => {
    sg.answers.maintenanceControl = { status: 202, body: { state: "pausing" } };
    const operation = `bo-${randomUUID()}`;

    const response = await call(suite.baseUrl, `${base}/reclaim/operations/${operation}/control?region=sg`, {
      body: { action: "pause", expectedVersion: 3 },
      idempotencyKey: `bo-${randomUUID()}`,
    });

    expect(response.status).toBe(202);
    const [request] = sg.received[0]!.args as [{ operationKey: string; action: string; expectedVersion: number }];
    expect(request).toMatchObject({ operationKey: operation, action: "pause", expectedVersion: 3 });
  });

  it("answers here with no region or this region's own name", async () => {
    for (const path of [`${base}/queue`, `${base}/queue?region=us-west`]) {
      const response = await call(suite.baseUrl, path);
      expect(response.status).toBe(200);
    }
    expect(sg.received).toEqual([]);
  });

  it("refuses a region this deployment does not reach with 422", async () => {
    const response = await call(suite.baseUrl, `${base}/queue?region=eu`);

    expect(response.status).toBe(422);
    expect(sg.received).toEqual([]);
  });

  it("answers 503 when the region is unavailable", async () => {
    sg.answers.maintenanceQueue = () => {
      throw new StandInRefusal(503, "unavailable");
    };

    const response = await call(suite.baseUrl, `${base}/queue?region=sg`);

    expect(response.status).toBe(503);
  }, 15_000);
});
