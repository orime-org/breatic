// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * No tool glues a sentinel in front of what it hands back.
 *
 * Tools once marked their output with a prefix -- `__ASK_USER__{...}` -- so the
 * turn loop could tell which of them spoke. A tool part carries that already,
 * in its own type (`tool-ask_user`, and so on), so the prefixes are gone.
 */
import { describe, it, expect } from "vitest";

describe("the sentinel mechanism", () => {
  it("is gone from what the tools package exports", async () => {
    // The prefixes were exported so the turn loop could match on them. With
    // the loop gone and the tool part carrying the name, an export that
    // survives means a reader somewhere survived with it.
    const tools = await import("@domain/agent/tools/index.js");
    const exported = Object.keys(tools).filter((key) => key.endsWith("_SENTINEL"));
    expect(exported).toEqual([]);
  });
});
