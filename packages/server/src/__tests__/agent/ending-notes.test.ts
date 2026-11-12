// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The note a later turn reads about how a turn ended (inner#1717).
 *
 * Only the stop button stops a turn now, so a stopped turn is one the user
 * stopped; a turn cut off by a shutdown failed, and reads like any failure.
 */
import { describe, it, expect } from "vitest";
import { endingNote } from "@server/agent/model-messages.js";

describe("endingNote", () => {
  it("says the user pressed stop on a stopped turn (PT-04)", () => {
    expect(endingNote([{ type: "text", text: "half" }, { type: "interrupted" }])).toBe(
      "[This turn did not finish: the user pressed stop.]",
    );
  });

  it("reads a shutdown as an ordinary failure (PT-03)", () => {
    const ordinary = endingNote([{ type: "failed" }]);
    expect(ordinary).toEqual(expect.any(String));
    expect(endingNote([{ type: "failed", reason: "shutdown" }])).toBe(ordinary);
    expect(endingNote([{ type: "failed", reason: "shutdown" }])).not.toBe(endingNote([{ type: "failed", reason: "too_long" }]));
  });
});
