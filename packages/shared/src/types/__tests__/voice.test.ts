// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #1960 — the trust boundary for `GET /models/:name/voices`.
 *
 * The page is assembled from a vendor's response, so it is untrusted the same
 * way the catalog is: sanitize once here, and every reader downstream can
 * trust the types instead of re-guarding each field.
 *
 * A voice missing its id or its name is dropped rather than repaired. Both are
 * load-bearing: the id is what gets written into the request, and the name is
 * the only thing the user has to choose by. A voice with a blank id would let
 * someone pick an entry that sends nothing.
 */

import { describe, it, expect } from "vitest";

import { sanitizeVoicePage } from "@shared/types/voice";

/** A page as the endpoint serves one. */
const GOOD = {
  voices: [
    {
      id: "JBFqnCBsd6RMkjVDRZzb",
      name: "George",
      description: "Warm British narrator",
      languages: ["en"],
      previewUrl: "https://example.test/george.mp3",
    },
  ],
  hasMore: true,
  nextCursor: "page-2",
};

describe("sanitizeVoicePage (#1960 A2, A6)", () => {
  it("keeps a well-formed page whole", () => {
    expect(sanitizeVoicePage(GOOD)).toEqual(GOOD);
  });

  it("keeps a voice that has no sample, since one vendor offers none", () => {
    const out = sanitizeVoicePage({
      voices: [{ id: "x", name: "X" }],
      hasMore: false,
    });
    expect(out.voices).toEqual([{ id: "x", name: "X" }]);
  });

  it("drops a voice with no id, which would submit nothing if picked", () => {
    const out = sanitizeVoicePage({
      voices: [{ name: "Nameless id" }, { id: "x", name: "X" }],
      hasMore: false,
    });
    expect(out.voices.map((v) => v.id)).toEqual(["x"]);
  });

  it("drops a voice with a blank id for the same reason", () => {
    const out = sanitizeVoicePage({
      voices: [{ id: "", name: "Blank" }],
      hasMore: false,
    });
    expect(out.voices).toEqual([]);
  });

  it("drops a voice with no name, the only thing to choose it by", () => {
    const out = sanitizeVoicePage({
      voices: [{ id: "x" }],
      hasMore: false,
    });
    expect(out.voices).toEqual([]);
  });

  it("drops a malformed sample url rather than the voice carrying it", () => {
    const out = sanitizeVoicePage({
      voices: [{ id: "x", name: "X", previewUrl: 42 }],
      hasMore: false,
    });
    expect(out.voices).toEqual([{ id: "x", name: "X" }]);
  });

  it("says there is no more when hasMore is not a boolean", () => {
    const out = sanitizeVoicePage({ voices: [], hasMore: "yes" });
    expect(out.hasMore).toBe(false);
  });

  it("says there is no more when hasMore is true but no cursor came", () => {
    // Paging asks for `nextCursor`. Keeping hasMore true without one would
    // send the list refetching the page it already has, forever.
    const out = sanitizeVoicePage({ voices: [{ id: "x", name: "X" }], hasMore: true });
    expect(out.hasMore).toBe(false);
    expect(out.nextCursor).toBeUndefined();
  });

  it("drops a non-string cursor, and stops paging with it", () => {
    const out = sanitizeVoicePage({ voices: [], hasMore: true, nextCursor: 2 });
    expect(out.nextCursor).toBeUndefined();
    expect(out.hasMore).toBe(false);
  });

  it("yields an empty page for garbage rather than throwing", () => {
    expect(sanitizeVoicePage("nonsense")).toEqual({ voices: [], hasMore: false });
    expect(sanitizeVoicePage(null)).toEqual({ voices: [], hasMore: false });
    expect(sanitizeVoicePage({ voices: "not an array", hasMore: 1 })).toEqual({
      voices: [],
      hasMore: false,
    });
  });

  it("drops a language list that is not a list of strings", () => {
    const out = sanitizeVoicePage({
      voices: [{ id: "x", name: "X", languages: [1, 2] }],
      hasMore: false,
    });
    expect(out.voices).toEqual([{ id: "x", name: "X" }]);
  });
});
