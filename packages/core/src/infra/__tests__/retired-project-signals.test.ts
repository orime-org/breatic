// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Project-channel signals whose facts now reach the page another way keep no publisher in core, so no writer can send
 * them (#1580): a Space's background work goes through its document, and a credits change through the trigger on the
 * credit tables, which tells every live Project of the Studio.
 */

import { describe, expect, it } from "vitest";
import * as core from "@core/index.js";

describe("retired Project-channel signals", () => {
  it("F-09 leave no space-tasks publisher in core", () => {
    expect(Object.keys(core)).not.toContain("publishSpaceTasksChanged");
  });

  it("H-15 leave no per-Project credits publisher in core", () => {
    expect(Object.keys(core)).not.toContain("publishCreditsChanged");
  });
});
