// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Space's background work reaches the page only through its document (#1580): core keeps no publisher for the old
 * Project-channel signal, so no writer can send it.
 */

import { describe, expect, it } from "vitest";
import * as core from "@core/index.js";

describe("the old space-tasks signal", () => {
  it("F-09 has no publisher in core", () => {
    expect(Object.keys(core)).not.toContain("publishSpaceTasksChanged");
  });
});
