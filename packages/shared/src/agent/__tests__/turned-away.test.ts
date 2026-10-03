// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The third ending: a call a tool, or the SDK, turned away to steer the
 * model. Nothing failed and the reader is shown nothing, so it carries a
 * reason for the model and no line for the panel.
 */
import { describe, it, expect } from "vitest";
import {
  FAILURE_LINES,
  TURNED_AWAY,
  isReaderLine,
  toolFailureOf,
  wireLineOf,
} from "@shared/agent/tool-failure.js";

/**
 * Hang a failure detail on an error, bypassing the builders.
 * @param failure - What to hang on it, any shape.
 * @returns The error carrying it.
 */
function errorCarrying(failure: unknown): Error {
  const err = new Error("boom");
  Object.defineProperty(err, "toolFailure", { value: failure, enumerable: false });
  return err;
}

describe("a call turned away to steer the model", () => {
  it("reads back with its reason for the model and no line for the reader", () => {
    expect(
      toolFailureOf(errorCarrying({ kind: "turned_away", forModel: "ask one thing at a time" })),
    ).toStrictEqual({ kind: "turned_away", forModel: "ask one thing at a time" });
  });

  it("is not read back when it carries a line for the reader", () => {
    expect(
      toolFailureOf(
        errorCarrying({
          kind: "turned_away",
          forModel: "ask one thing at a time",
          readerKey: FAILURE_LINES.generic,
        }),
      ),
    ).toBeUndefined();
  });

  it("goes on the wire as a value that is not one of the reader's lines", () => {
    expect(isReaderLine(TURNED_AWAY)).toBe(false);
    expect(Object.values(FAILURE_LINES)).not.toContain(TURNED_AWAY);
  });

  it("puts each ending's own value on the wire", () => {
    expect(wireLineOf({ kind: "turned_away", forModel: "x" })).toBe(TURNED_AWAY);
    expect(
      wireLineOf({ kind: "tool_failed", forModel: "x", readerKey: FAILURE_LINES.upstream }),
    ).toBe(FAILURE_LINES.upstream);
    expect(
      wireLineOf({ kind: "user_aborted", forModel: "x", readerKey: FAILURE_LINES.stopped }),
    ).toBe(FAILURE_LINES.stopped);
  });
});
