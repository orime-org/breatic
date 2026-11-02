// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Space list the model reads names each Space's id (inner#1552).
 *
 * Names may repeat, so the request tool names a Space by id, and the id it
 * may use is the one this list shows.
 */
import { describe, it, expect } from "vitest";

import { userTurnForModel } from "@server/agent/user-turn.js";

const storyboard = { id: "s1", name: "Storyboard", kind: "document" as const };
const cast = { id: "s2", name: "Cast", kind: "canvas" as const };
const twin = { id: "s3", name: "Cast", kind: "canvas" as const };

describe("the Space list", () => {
  it("writes each line as name, kind and id, the open one still marked", () => {
    const turn = userTurnForModel({
      chips: [],
      message: "hi",
      spaces: [storyboard, cast],
      spaces_total: 2,
      current_space: { ...storyboard, state: "loaded", content: "# Scene 1", total_chars: 9 },
    });

    expect(turn).toContain(
      '## Spaces in this project\n\n- "Storyboard" (document, id: s1) — the reader has this one open\n- "Cast" (canvas, id: s2)',
    );
  });

  it("tells two Spaces of one name apart by id", () => {
    const turn = userTurnForModel({ chips: [], message: "hi", spaces: [cast, twin], spaces_total: 2 });

    expect(turn).toContain('- "Cast" (canvas, id: s2)\n- "Cast" (canvas, id: s3)');
  });
});
