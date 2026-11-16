// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The grid split stays free once it runs in the media container (inner#1968
 * design 3.2.2, test spec B-12). The guide marks every container tool
 * "billed by how long it runs"; the grid is the one container tool whose
 * definition says `billing: "free"`, and the guide reads that mark, so it
 * still lists the grid among the free tools and does not mark it billed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadLocales } from "@breatic/core";
import { t } from "@breatic/shared";
import { miniToolById } from "@breatic/shared/mini-tools";

import { renderProductGuide } from "@domain/agent/tools/product-guide.js";

beforeAll(() => {
  loadLocales();
});

describe("B-12 the guide on the grid split's price", () => {
  it("lists the grid as a container tool without the billed-by-run-time mark, and among the free tools", () => {
    const spec = miniToolById("image.grid");
    expect(spec?.run.kind).toBe("container");
    const guide = renderProductGuide();
    const line = guide.split("\n").find((l) => l.startsWith(`  - "${t(spec!.labelKey)}":`));
    expect(line).toBeDefined();
    expect(line).not.toContain("billed by how long it runs");
    expect(guide).toContain("grid split are free");
  });
});
