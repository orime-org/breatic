// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import * as miniTools from "../index.js";

// frames-split §7.19: a run is rerun only as a whole, so the mini-tools entry offers no per-output retry.
describe("planned runs have no partial retry", () => {
  it.each(["MINI_TOOL_RETRY_TOOLS", "miniToolExecutionRetryRequestSchema", "plannedFailureRetryable", "plannedOutputRetryable"])(
    "the mini-tools entry exports no %s", (name) => {
      expect(Object.keys(miniTools)).not.toContain(name);
    });
});
