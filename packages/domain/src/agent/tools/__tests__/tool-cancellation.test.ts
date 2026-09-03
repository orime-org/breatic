// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * awaits, which no signature can express; `web-search` has its own tests for
 * that.
 */

import { describe, it, expect } from "vitest";
import { TOOL_MAP } from "@domain/agent/tools/index.js";

/** What a tool's `execute` looks like when all this guard reads is its arity. */
type ExecuteFn = (...args: unknown[]) => unknown;

/**
 * Every registered tool, paired with its `execute`.
 *
 * The registry rather than the file's re-export block, because the registry is
 * what `buildToolSet` reads and therefore what decides whether a tool can reach
 * a turn at all. Nothing consults the re-export block, so a tool registered
 * without being re-exported would slip past a guard standing on that list —
 * and a tool that misses the options argument never sees the abort signal,
 * which is the ceiling on how long a stop takes.
 * @returns Each registered tool's name and its `execute`.
 */
function registeredTools(): Array<[string, ExecuteFn]> {
  return Object.entries(TOOL_MAP).map(([name, tool]) => [
    name,
    (tool as { execute?: unknown }).execute as ExecuteFn,
  ]);
}

describe("tools accept the cancellation signal", () => {
  it("covers every registered tool", () => {
    // A named list rather than a count of what happens to be there. The loop
    // below already gives a sixth tool its own case, so this is not what
    // catches an unchecked tool; what it catches is the other direction -- a
    // tool vanishing from the registry, which the loop cannot see -- and it
    // makes the author of a new tool stop here and read why the arity matters.
    expect(registeredTools().map(([name]) => name).sort()).toEqual([
      "ask_user_choice",
      "ask_user_question",
      "propose_canvas_action",
      "show_search_results",
      "web_search",
    ]);
  });

  for (const [name, execute] of registeredTools()) {
    it(`${name} declares the options argument`, () => {
      expect(typeof execute).toBe("function");
      expect(execute.length).toBeGreaterThanOrEqual(2);
    });
  }
});
