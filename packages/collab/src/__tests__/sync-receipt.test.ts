// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which content documents answer a sync confirmation (#1490 design §3.3): the ones whose unsynced edits the page
 * counts before it lets the user leave. A Motion Space's annotations are such edits, as a Document's comments are.
 */

import { describe, expect, it } from "vitest";

import { confirmsSync } from "@collab/services/sync-receipt.js";

describe("confirmsSync", () => {
  it.each(["canvas", "document", "web_animation"] as const)("answers a sync confirmation on a %s document", (kind) => {
    expect(confirmsSync(kind)).toBe(true);
  });

  it.each(["meta", "timeline", "3d"] as const)("answers none on a %s document", (kind) => {
    expect(confirmsSync(kind)).toBe(false);
  });
});
