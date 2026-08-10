// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Every tool takes the cancellation signal the SDK offers it.
 *
 * The SDK hands each `execute` a second argument carrying an `abortSignal`,
 * merged from the turn's signal and the tool's own timeout — measured on
 * ai@7.0.58, where the call site composes them and passes the result into
 * `executeTool`. A tool that only declares the first argument never sees it.
 *
 * What that costs is the whole turn, not just the tool. Measured with a real
 * `streamText`: with the signal raised while a tool was running, the turn's
 * stream produced nothing further until the tool returned of its own accord —
 * 4 seconds for a tool that ignored its signal, 8 milliseconds for one that
 * did not. So the ceiling on how long a stop takes is set here.
 *
 * The four tools that only assemble a value and return it cannot be stopped
 * early and have nothing to do with the signal. They declare it anyway, and
 * that is the point of a guard rather than four separate tests: the next tool
 * added is the one at risk, and it will be written by copying one of these.
 *
 * What this does NOT catch is a tool that declares the parameter and then
 * ignores it. Whether a signal is honoured is a property of what the tool
 * awaits, which no signature can express; `web-fetch` and `web-search` have
 * their own tests for that.
 */

import { describe, it, expect } from "vitest";
import * as toolBarrel from "@domain/agent/tools/index.js";

/** Anything the barrel exports, seen only through the field that matters. */
type MaybeTool = { execute?: unknown };

/** What a tool's `execute` looks like when all this guard reads is its arity. */
type ExecuteFn = (...args: unknown[]) => unknown;

/**
 * Every tool the barrel exports, paired with its `execute`.
 *
 * The barrel also exports lists and functions; a tool is recognised by having
 * an `execute`, which is the only thing this guard has an opinion about.
 * @returns Each exported tool's name and its `execute`.
 */
function exportedTools(): Array<[string, ExecuteFn]> {
  const found: Array<[string, ExecuteFn]> = [];
  for (const [name, value] of Object.entries(toolBarrel as Record<string, MaybeTool>)) {
    if (typeof value?.execute === "function") {
      found.push([name, value.execute as ExecuteFn]);
    }
  }
  return found;
}

describe("tools accept the cancellation signal", () => {
  it("covers every tool the barrel exports", () => {
    // A count, so that adding a seventh tool fails here and its author has to
    // come and look at what this file is guarding. Without it a new tool could
    // be added and simply not be checked, which is the failure this guard
    // exists to prevent.
    expect(exportedTools().map(([name]) => name).sort()).toEqual([
      "askUser",
      "askUserChoice",
      "proposeCanvasAction",
      "showSearchResults",
      "webFetch",
      "webSearch",
    ]);
  });

  for (const [name, execute] of exportedTools()) {
    it(`${name} declares the options argument`, () => {
      expect(execute.length).toBeGreaterThanOrEqual(2);
    });
  }
});
