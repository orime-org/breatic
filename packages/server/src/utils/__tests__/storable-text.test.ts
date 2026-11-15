// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { asStorable } from "@server/utils/storable-text.js";

describe("a value made storable", () => {
  it("loses NUL and has lone surrogates replaced, in strings and keys at any depth", () => {
    const pair = "😀";
    expect(asStorable({ "k\u0000ey": ["a\u0000b", { deep: `x\ud83dy${pair}` }] })).toEqual({ key: ["ab", { deep: `x�y${pair}` }] });
  });

  it("holds what the store would have made of a value that is not plain JSON", () => {
    expect(asStorable({ image: new URL("https://example.com/a.png"), at: new Date(0), gone: undefined })).toEqual({
      image: "https://example.com/a.png",
      at: "1970-01-01T00:00:00.000Z",
    });
  });
});
