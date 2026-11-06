// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import { stepCalls, stepSource } from "../estimate.js";

const params = { elements: ["https://a/1.png", "https://a/2.png"], song: "https://a/song.mp3", empty: "", none: [] };

describe("the calls an extra step makes and the source each reads", () => {
  it("makes one call per item of a per-item step, one for a step over a single source, none for a param that carries nothing", () => {
    expect(stepCalls({ for_param: "elements", per_item: true }, params)).toEqual([0, 1]);
    expect(stepCalls({ for_param: "song" }, params)).toEqual([null]);
    expect(stepCalls({ for_param: "empty" }, params)).toEqual([]);
    expect(stepCalls({ for_param: "none", per_item: true }, params)).toEqual([]);
    expect(stepCalls({}, params)).toEqual([null]);
  });

  it("reads each call's own item, the whole value for a single call, and nothing that is not a url", () => {
    expect(stepSource(params, "elements", 0)).toBe("https://a/1.png");
    expect(stepSource(params, "elements", 1)).toBe("https://a/2.png");
    expect(stepSource(params, "song", null)).toBe("https://a/song.mp3");
    expect(stepSource(params, "elements", null)).toBeUndefined();
    expect(stepSource(params, "empty", null)).toBeUndefined();
    expect(stepSource(params, "elements", 2)).toBeUndefined();
  });
});
