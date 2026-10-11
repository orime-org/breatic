// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the open Space's content is cut to its limit (inner#1413). The browser
 * cuts it and the server checks it, so both count the same way.
 */

import { describe, it, expect } from "vitest";

import { clipSpaceContent } from "@shared/agent/space-content.js";

describe("clipSpaceContent", () => {
  it("keeps content within the limit whole and says how long it was", () => {
    expect(clipSpaceContent("abc", 5)).toEqual({ text: "abc", total: 3 });
  });

  it("keeps the first characters up to the limit and the full length", () => {
    expect(clipSpaceContent("abcdef", 4)).toEqual({ text: "abcd", total: 6 });
  });

  it("counts UTF-16 code units, as the message length is counted", () => {
    expect(clipSpaceContent("分镜表", 2)).toEqual({ text: "分镜", total: 3 });
  });

  it("does not leave half of a character when the limit falls inside one", () => {
    const clipped = clipSpaceContent("ab😀cd", 3);
    expect(clipped.text).toBe("ab");
    expect(clipped.total).toBe(6);
  });
});
