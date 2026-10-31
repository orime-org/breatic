// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readCookie } from "@collab/infra/cookie.js";

describe("readCookie", () => {
  it.each([
    [undefined, "session", null],
    ["", "session", null],
    ["other=x; session=", "session", ""],
    ["other=x; session=one; session=two", "session", "one"],
    ["session-other=x; other=y", "session", null],
    ["junk; session = %61%2Fb%3Dc ; x=y", "session", "a/b=c"],
    ["session=a=b=c", "session", "a=b=c"],
    ["session=a+b", "session", "a+b"],
    ["other=%E0%A4%A; session=good", "session", "good"],
    ["consent=%7B%22analytics%22%3Atrue%7D", "consent", '{"analytics":true}'],
  ] as const)("reads %s using the existing decoding rules", (header, name, expected) => {
    expect(readCookie(header, name)).toBe(expected);
  });

  it("reports malformed encoding in the matching cookie", () => {
    expect(() => readCookie("session=%E0%A4%A", "session")).toThrow(URIError);
  });

  it("round trips generated cookie values through URI encoding", () => {
    fc.assert(fc.property(
      fc.array(fc.integer({ min: 32, max: 126 }), { maxLength: 64 }),
      (characters) => {
        const value = String.fromCharCode(...characters);
        expect(readCookie(`other=first; session=${encodeURIComponent(value)}; session=second`, "session")).toBe(value);
      },
    ), { seed: 1570, numRuns: 64 });
  });
});
