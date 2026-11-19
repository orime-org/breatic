// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Where a Motion annotation points (#1490 design §10.2, §13.6): the result's execution, a time inside the result and
 * an optional point on the frame as fractions of its width and height. The page writes it and #1488's external Agent
 * reads it, so the shape lives here once.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { WebAnimationAnchorSchema, anchorTimeWithin, readWebAnimationAnchor } from "../web-animation.js";

const EXEC = "e0000000-0000-4000-8000-000000000001";

describe("WebAnimationAnchorSchema", () => {
  it("accepts a time with a point and a time without one", () => {
    const withPoint = { executionId: EXEC, timeSeconds: 2.5, point: { x: 0, y: 1 } };
    const withoutPoint = { executionId: EXEC, timeSeconds: 0, point: null };
    expect(WebAnimationAnchorSchema.parse(withPoint)).toEqual(withPoint);
    expect(WebAnimationAnchorSchema.parse(withoutPoint)).toEqual(withoutPoint);
  });

  it.each([
    ["a negative time", { executionId: EXEC, timeSeconds: -0.1, point: null }],
    ["a point left of the frame", { executionId: EXEC, timeSeconds: 1, point: { x: -0.01, y: 0.5 } }],
    ["a point below the frame", { executionId: EXEC, timeSeconds: 1, point: { x: 0.5, y: 1.01 } }],
    ["no execution", { timeSeconds: 1, point: null }],
    ["an execution that is no id", { executionId: "x", timeSeconds: 1, point: null }],
    ["a field it does not know", { executionId: EXEC, timeSeconds: 1, point: null, frame: 24 }],
  ])("refuses %s", (_name, anchor) => {
    expect(WebAnimationAnchorSchema.safeParse(anchor).success).toBe(false);
  });
});

describe("readWebAnimationAnchor", () => {
  it("reads the anchor out of a thread's metadata", () => {
    const anchor = { executionId: EXEC, timeSeconds: 2.5, point: null };
    expect(readWebAnimationAnchor({ webAnimationAnchor: anchor, assignment: { agent: "x" } })).toEqual(anchor);
  });

  it("answers null for metadata without a valid anchor", () => {
    expect(readWebAnimationAnchor(undefined)).toBeNull();
    expect(readWebAnimationAnchor({})).toBeNull();
    expect(readWebAnimationAnchor({ webAnimationAnchor: { executionId: EXEC, timeSeconds: -1, point: null } })).toBeNull();
  });
});

describe("anchorTimeWithin", () => {
  it("keeps the playhead's time inside 0 and the result's length", () => {
    fc.assert(fc.property(fc.double({ noNaN: true, min: -1e6, max: 1e6 }), fc.double({ noNaN: true, min: 0.1, max: 600 }), (time, duration) => {
      const kept = anchorTimeWithin(time, duration);
      return kept >= 0 && kept <= duration && (time < 0 || time > duration || kept === time);
    }));
  });
});
