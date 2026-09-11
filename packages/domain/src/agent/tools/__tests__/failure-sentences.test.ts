// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The sentences two tools now share, pinned whole.
 *
 * Each is built from a template and one tool's `FailureVoice`, so a word
 * changed for one tool changes it for the other. Every assertion elsewhere
 * reads a fragment, and a rewritten remainder passes all of them.
 */
import { describe, it, expect } from "vitest";

import { readFailedReason, unreachableReason } from "@domain/agent/tools/failure.js";
import type { FailureVoice } from "@domain/agent/tools/failure.js";

/** How `web_search` has always named what it does. */
const SEARCH: FailureVoice = {
  act: "search",
  results: "search results",
  retrying: "Searching once more",
  elsewhere: "search for something else",
  attempting: "Searching for",
};

describe("the sentences a body that stopped arriving produces", () => {
  it("reads for web_search as it always has", () => {
    expect(readFailedReason(SEARCH, "breatic", "socket hang up")).toBe(
      'Searching for "breatic" failed while reading the answer: socket hang up. The service ' +
        "answered, so it is the body that did not arrive. Searching once more may work; if it " +
        "fails again, continue without search results and tell the user search is unavailable.",
    );
  });

  it("reads for web_search as it always has when nothing answered", () => {
    expect(unreachableReason(SEARCH, "breatic", "ENOTFOUND")).toBe(
      'Searching for "breatic" failed: the search service could not be reached (ENOTFOUND). ' +
        "The service is unreachable from here, which is not something a different query would " +
        "fix. Do not repeat this search; continue without search results and tell the user " +
        "search is unavailable.",
    );
  });
});
