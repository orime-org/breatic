// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reasons a reader is shown for a tool that did not finish (inner#1620),
 * and the two endings that show none.
 */
import { describe, it, expect } from "vitest";
import {
  FAILURE_LINES,
  LEGACY_FAILURE_LINES,
  NEVER_RAN,
  NOTHING_SAID_WHY,
  isReaderLine,
  toolFailureOf,
  wireLineOf,
} from "@shared/agent/tool-failure.js";

/**
 * An error carrying a failure detail of any shape.
 * @param failure - What it carries.
 * @returns The error.
 */
function errorCarrying(failure: unknown): Error {
  const err = new Error("boom");
  Object.defineProperty(err, "toolFailure", { value: failure, enumerable: false });
  return err;
}

const REASONS = [
  "busy",
  "noConnection",
  "refused",
  "unavailable",
  "badAnswer",
  "linkUnreachable",
  "fileTooLarge",
  "unsupportedType",
  "emptyFile",
  "tooSlow",
  "storageFull",
  "noPermission",
  "tooFrequent",
  "declined",
  "ourFault",
];

describe("the reasons a reader is shown", () => {
  it("are the fifteen causes, each its own key, beside the line for a stop", () => {
    const { stopped, ...reasons } = FAILURE_LINES;
    expect(Object.keys(reasons).sort()).toEqual([...REASONS].sort());
    expect(Object.values(reasons)).toEqual(Object.keys(reasons).map((key) => `chat.tool.failure.${key}`));
    expect(stopped).toBe("chat.tool.unfinished");
  });

  it("still include the three keys rows stored before them carry", () => {
    expect(Object.values(LEGACY_FAILURE_LINES).sort()).toEqual([
      "chat.tool.failure.generic",
      "chat.tool.failure.unreachable",
      "chat.tool.failure.upstream",
    ]);
    for (const key of Object.values(LEGACY_FAILURE_LINES)) expect(isReaderLine(key)).toBe(true);
    for (const key of Object.values(FAILURE_LINES)) expect(isReaderLine(key)).toBe(true);
  });

  it("put a failure nothing recorded the reason of down to our server", () => {
    expect(NOTHING_SAID_WHY).toMatchObject({ kind: "tool_failed", readerKey: FAILURE_LINES.ourFault });
  });
});

describe("a call that never ran", () => {
  it("reads back with its reason for the model and no line for the reader", () => {
    expect(toolFailureOf(errorCarrying({ kind: "never_ran", forModel: "Never ran." }))).toEqual({
      kind: "never_ran",
      forModel: "Never ran.",
    });
    expect(
      toolFailureOf(errorCarrying({ kind: "never_ran", forModel: "Never ran.", readerKey: FAILURE_LINES.ourFault })),
    ).toBeUndefined();
  });

  it("goes on the wire as a value that is not one of the reader's lines", () => {
    expect(wireLineOf({ kind: "never_ran", forModel: "x" })).toBe(NEVER_RAN);
    expect(isReaderLine(NEVER_RAN)).toBe(false);
  });
});
