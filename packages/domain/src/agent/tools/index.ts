// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Tool registry — maps tool names to AI SDK tool definitions.
 */
import type { Tool } from "ai";
import { env } from "@breatic/core";

import { askUser } from "@domain/agent/tools/ask-user.js";
import { askUserChoice } from "@domain/agent/tools/ask-user-choice.js";
import { proposeCanvasAction } from "@domain/agent/tools/propose-canvas-action.js";
import { showSearchResults } from "@domain/agent/tools/show-search-results.js";
import { webFetch } from "@domain/agent/tools/web-fetch.js";
import { webSearch } from "@domain/agent/tools/web-search.js";

/**
 * Complete mapping of tool name to tool instance.
 *
 * Exported so a guard can hold every registered tool to the same rules. It is
 * this map that `buildToolSet` reads, and a tool reaches a turn by being in it
 * — the re-export block at the foot of this file is a convenience for
 * importers and nothing consults it, so a guard standing on that list would
 * miss any tool registered here without also being re-exported.
 */
export const TOOL_MAP: Readonly<Record<string, Tool>> = {
  web_search: webSearch,
  web_fetch: webFetch,
  ask_user_question: askUser,
  // Interaction tools (spec/07 §10.18.4 v13). LLM calls these to send
  // structured payloads the frontend renders as UI components, not for
  // execution. main-agent detects sentinel-prefixed results and yields
  // matching SSE events.
  ask_user_choice: askUserChoice,
  propose_canvas_action: proposeCanvasAction,
  show_search_results: showSearchResults,
} as const;

/**
 * Every tool a skill may ask for, in a stable order.
 *
 * This is what a caller that declares no tools of its own receives. Bare
 * chat used to pass an empty array and end up with no tools at all — the
 * model could not search, so it made things up instead.
 *
 * It happens to equal the whole of `TOOL_MAP` right now. That is arithmetic,
 * not intent: PR-2 deleted six entries and six remain. The moment a tool
 * arrives that is not for everyone, this list stops matching the map, and it
 * is this list — not the map — that answers "what does a caller get by
 * default".
 */
export const BASELINE_TOOLS: readonly string[] = [
  "web_search",
  "web_fetch",
  "ask_user_question",
  "ask_user_choice",
  "propose_canvas_action",
  "show_search_results",
];

/**
 * The tools that put something in front of the user rather than doing work.
 *
 * They do not do anything on their own — each returns a payload the frontend
 * draws as a component. A caller with no way to draw one must not be offered
 * them, or the model will ask a question nobody can see and read its own
 * request back as the answer.
 */
export const INTERACTION_TOOLS: readonly string[] = [
  "ask_user_question",
  "ask_user_choice",
  "propose_canvas_action",
  "show_search_results",
];

export { TOOLS_THAT_BLOCK } from "@domain/agent/tools/blocking-tools.js";

/**
 * What each tool needs configured before it can do anything.
 *
 * A tool missing its configuration is left out rather than offered and
 * allowed to fail. That distinction is the whole point: a tool that returns
 * "Error: key not configured" hands the model a string, and the model cannot
 * tell a failed call from a call whose answer describes a failure — so it
 * retries. A smoke run on a deployment without a search key had the model
 * call web_search over and over until the step ceiling stopped it, and reply
 * nothing at all.
 *
 * Only genuinely required configuration goes here. Something a tool merely
 * prefers would silently remove the tool on a deployment that works fine.
 */
const TOOL_REQUIREMENTS: Readonly<Record<string, string>> = {
  web_search: "BRAVE_SEARCH_API_KEY",
};

/**
 * Whether a tool has what it needs to run.
 * @param name - The tool name to check.
 * @returns True when the tool needs no configuration, or has it.
 */
function isConfigured(name: string): boolean {
  const required = TOOL_REQUIREMENTS[name];
  if (!required) return true;
  const value = (env as unknown as Record<string, unknown>)[required];
  return typeof value === "string" && value.length > 0;
}

/**
 * Build a tool set for the AI SDK from a list of tool names.
 *
 * Unknown names are silently skipped, which is what keeps a stale name in a
 * skill's metadata from taking down the whole assembly. Tools whose required
 * configuration is missing are skipped too — see `TOOL_REQUIREMENTS`.
 * @param toolNames - Array of tool name strings to include.
 * @returns A `Record<string, Tool>` suitable for the AI SDK `tools` option.
 * @example
 * ```ts
 * import { buildToolSet, BASELINE_TOOLS } from "@domain/agent/tools/index.js";
 * const tools = buildToolSet(BASELINE_TOOLS);
 * ```
 */
export function buildToolSet(
  toolNames: readonly string[],
): Record<string, Tool> {
  const result: Record<string, Tool> = {};
  for (const name of toolNames) {
    const t = TOOL_MAP[name];
    if (t && isConfigured(name)) result[name] = t;
  }
  return result;
}

export {
  askUser,
  askUserChoice,
  proposeCanvasAction,
  showSearchResults,
  webFetch,
  webSearch,
};

// The sentinels, forwarded from the tools that write them. A service running
// the agent loop needs them to recognise what a tool just returned, and each
// string stays declared in exactly one file — its own tool.
