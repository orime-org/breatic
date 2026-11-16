// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which regions a paste asks about keys it does not hold (inner#1955): a
 * region outside the global one asks the global region; the global region
 * asks every other region at once; every key goes in one call per region; a
 * region that does not answer counts as holding nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@breatic/core";

const h = vi.hoisted(() => ({
  env: { REGION: "sg", GLOBAL_REGION: "us-west", REGION_API_URLS: {} },
  callRegion: vi.fn(),
  findAssetsByKeys: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<typeof CoreModule>()),
  env: h.env,
  callRegion: h.callRegion,
  getRegionsConfig: () => ({ cross_region_fanout_timeout_ms: 2000 }),
  logger: { error: h.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@breatic/domain", () => ({ globalApi: () => ({ findAssetsByKeys: h.findAssetsByKeys }) }));

const { findElsewhereByKeys } = await import("@server/modules/region/asset-lookup.js");

beforeEach(() => {
  vi.clearAllMocks();
  h.env.REGION = "sg";
  h.env.REGION_API_URLS = {};
});

describe("findElsewhereByKeys", () => {
  it("asks the global region once for every key from any other region", async () => {
    h.findAssetsByKeys.mockResolvedValue({ a: { asset: { storageKey: "a" }, cover: null } });

    const found = await findElsewhereByKeys(["a", "b"]);

    expect(found.get("a")).toEqual({ asset: { storageKey: "a" }, cover: null });
    expect(found.get("b")).toEqual({ asset: null, cover: null });
    expect(h.findAssetsByKeys).toHaveBeenCalledTimes(1);
    expect(h.findAssetsByKeys).toHaveBeenCalledWith(["a", "b"]);
    expect(h.callRegion).not.toHaveBeenCalled();
  });

  it("asks nothing for no keys", async () => {
    expect((await findElsewhereByKeys([])).size).toBe(0);
    expect(h.findAssetsByKeys).not.toHaveBeenCalled();
  });

  it("counts a global region that does not answer as holding nothing, and logs it", async () => {
    h.findAssetsByKeys.mockRejectedValue(new Error("timed out"));

    expect((await findElsewhereByKeys(["k"])).get("k")).toEqual({ asset: null, cover: null });
    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ ctx: expect.objectContaining({ region: "us-west" }) }), "asset_lookup_elsewhere_failed");
  });

  it("asks every other region at once from the global region and takes what any holds", async () => {
    h.env.REGION = "us-west";
    h.env.REGION_API_URLS = { sg: "http://sg", eu: "http://eu" };
    let pending = 0;
    let most = 0;
    h.callRegion.mockImplementation(async (region: string) => {
      pending += 1;
      most = Math.max(most, pending);
      await Promise.resolve();
      pending -= 1;
      if (region === "sg") throw new Error("down");
      return { k: { asset: null, cover: { storageKey: "c" } } };
    });

    const found = await findElsewhereByKeys(["k"]);

    expect(found.get("k")).toEqual({ asset: null, cover: { storageKey: "c" } });
    expect(h.callRegion.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([["sg", "findAssetsByKeys", [["k"]]], ["eu", "findAssetsByKeys", [["k"]]]]);
    expect(most).toBe(2);
  });
});
