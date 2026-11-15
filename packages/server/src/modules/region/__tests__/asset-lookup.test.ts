// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Which region a paste asks for a row it does not hold (inner#1955): a region
 * outside the global one asks the global region; the global region asks every
 * other region; a region that does not answer counts as holding nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";

const h = vi.hoisted(() => ({
  env: { REGION: "sg", GLOBAL_REGION: "us-west", REGION_API_URLS: {} },
  callRegion: vi.fn(),
  findAssetByKey: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  env: h.env,
  callRegion: h.callRegion,
  getRegionsConfig: () => ({ cross_region_fanout_timeout_ms: 2000 }),
  logger: { error: h.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({ globalApi: () => ({ findAssetByKey: h.findAssetByKey }) }));

const { findElsewhereByKey } = await import("@server/modules/region/asset-lookup.js");

beforeEach(() => {
  vi.clearAllMocks();
  h.env.REGION = "sg";
  h.env.REGION_API_URLS = {};
});

describe("findElsewhereByKey", () => {
  it("asks the global region from any other region", async () => {
    h.findAssetByKey.mockResolvedValue({ storageKey: "k" });

    expect(await findElsewhereByKey("findAssetByKey", "k")).toEqual({ storageKey: "k" });
    expect(h.findAssetByKey).toHaveBeenCalledWith("k");
    expect(h.callRegion).not.toHaveBeenCalled();
  });

  it("counts a global region that does not answer as holding nothing, and logs it", async () => {
    h.findAssetByKey.mockRejectedValue(new Error("timed out"));

    expect(await findElsewhereByKey("findAssetByKey", "k")).toBeNull();
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ storageKey: "k" }) }), "asset_lookup_elsewhere_failed");
  });

  it("asks every other region from the global region until one holds the row", async () => {
    h.env.REGION = "us-west";
    h.env.REGION_API_URLS = { sg: "http://sg", eu: "http://eu" };
    h.callRegion.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce({ storageKey: "k" });

    expect(await findElsewhereByKey("findAssetByKey", "k")).toEqual({ storageKey: "k" });
    expect(h.callRegion.mock.calls.map((call) => call[0])).toEqual(["sg", "eu"]);
  });
});
