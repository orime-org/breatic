// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A turn that ended as too long keeps saying so after it is stored
 * (inner#1567, A5; design 6.7).
 *
 * It is a failed turn with a reason, so the reader is shown "try a narrower
 * request" rather than "send it again", live and after a reload, and the
 * model reads back that the turn did not finish because there was too much
 * to process, not because something broke. Every hop between the wire, the
 * store and the model has to carry the reason or the reload shows the
 * ordinary failure.
 */

import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { MessagePart } from "@breatic/shared";
import { endingNote } from "@server/agent/model-messages.js";
import { toStoredParts, toUiParts } from "@server/modules/conversation/message-part-mapping.js";

const TOO_LONG = { type: "failed", reason: "too_long" } as unknown as MessagePart;

describe("storing a too-long ending", () => {
  it("keeps the reason from the wire into the store", () => {
    const parts = [
      { type: "text", text: "partial" },
      { type: "data-failed", data: { reason: "too_long" } },
    ] as unknown as UIMessage["parts"];

    expect(toStoredParts(parts)).toEqual([{ type: "text", text: "partial" }, TOO_LONG]);
  });

  it("keeps the reason from the store back onto the wire", () => {
    expect(toUiParts([TOO_LONG])).toEqual([{ type: "data-failed", data: { reason: "too_long" } }]);
  });

  it("carries the reason through a round trip, and leaves an ordinary failure without one", () => {
    const wire = [{ type: "data-failed", data: {} }] as unknown as UIMessage["parts"];

    expect(toStoredParts(wire)).toEqual([{ type: "failed" }]);
    expect(toUiParts([{ type: "failed" }])).toEqual([{ type: "data-failed", data: {} }]);
    expect(toStoredParts(toUiParts([TOO_LONG]))).toEqual([TOO_LONG]);
  });
});

describe("what the model reads back about a too-long turn", () => {
  it("is a note of its own, not the ordinary failure's", () => {
    const tooLong = endingNote([TOO_LONG]);
    const failed = endingNote([{ type: "failed" }]);

    expect(tooLong).toEqual(expect.any(String));
    expect(tooLong).not.toBe(failed);
    expect(tooLong).toMatch(/too long|too much/i);
  });
});
