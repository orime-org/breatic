// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A server in a deployment with more than one region serves the calls
 * between regions on its internal listener (inner#1955), so it must not start
 * without one.
 */

import { describe, expect, it } from "vitest";
import { lacksRegionListener } from "@server/utils/region-listener.js";

describe("lacksRegionListener", () => {
  it.each([
    ["a single region", { REGION: "default", GLOBAL_REGION: "default", REGION_API_URLS: {}, INTERNAL_API_ENABLED: false }, false],
    ["a region outside the global region with the listener", { REGION: "sg", GLOBAL_REGION: "us-west", REGION_API_URLS: {}, INTERNAL_API_ENABLED: true }, false],
    ["a region outside the global region without it", { REGION: "sg", GLOBAL_REGION: "us-west", REGION_API_URLS: {}, INTERNAL_API_ENABLED: false }, true],
    ["the global region with other regions and without it", { REGION: "us-west", GLOBAL_REGION: "us-west", REGION_API_URLS: { sg: "http://sg" }, INTERNAL_API_ENABLED: false }, true],
  ])("answers for %s", (_label, config, expected) => {
    expect(lacksRegionListener(config)).toBe(expected);
  });
});
