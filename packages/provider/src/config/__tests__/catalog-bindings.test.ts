// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A model that leaves the catalog leaves with its bindings: every bound model is in the catalog.
 */

import { describe, expect, it } from "vitest";
import { REMOVED } from "../../media/wavespeed/__tests__/departures.js";
import { catalog, shipped } from "./shipped.js";

const config = shipped();

describe("models outside the catalog", () => {
  it("have no binding", () => {
    const names = new Set(catalog().models.map((m) => m.name));
    expect(Object.keys(config.media.models).filter((m) => !names.has(m))).toEqual([]);
  });

  it("include the removed models whose frozen cases are skipped, none of them bound or in the catalog", () => {
    const names = new Set(catalog().models.map((m) => m.name));
    expect([...REMOVED].filter((m) => names.has(m) || m in config.media.models)).toEqual([]);
  });
});
