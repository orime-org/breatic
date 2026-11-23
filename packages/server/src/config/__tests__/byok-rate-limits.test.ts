// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The BYOK model-choice limit read from the shipped `config/rate-limits.yaml` (inner#1953), held against the provider
 * configuration it has to fit. The package setup stubs this loader for every file, so the real module is taken with
 * `importActual`.
 */

import { describe, it, expect, vi } from "vitest";
import { readProviderConfig } from "@breatic/domain";
import type * as RateLimitsModule from "@server/config/rate-limits.js";

const { getRateLimit } = await vi.importActual<typeof RateLimitsModule>("@server/config/rate-limits.js");

describe("byok-model-write — config/rate-limits.yaml", () => {
  // Pointing models at an upstream is one write per model, so one window lets a user switch every model the widest
  // upstream runs, and back again.
  it("lets one window switch every model of the widest upstream and back", () => {
    const perUpstream = new Map<string, number>();
    for (const model of Object.values(readProviderConfig().media.models)) {
      for (const { upstream } of model.upstreams) perUpstream.set(upstream, (perUpstream.get(upstream) ?? 0) + 1);
    }
    const widest = Math.max(...perUpstream.values());
    expect(widest).toBeGreaterThan(0);
    expect(getRateLimit("byok-model-write").max).toBeGreaterThanOrEqual(widest * 2);
  });
});
