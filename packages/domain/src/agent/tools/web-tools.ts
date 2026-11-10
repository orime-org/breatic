// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The tools one turn reads the web with: `web_search` and `web_fetch`, sharing
 * one run of citation numbers (inner#1664).
 */
import type { Tool } from "ai";

import type { ToolContext } from "@domain/agent/tools/index.js";
import { citationNumbers } from "@domain/agent/tools/citation.js";
import { makeFetchTool } from "@domain/agent/tools/web-fetch.js";
import { makeSearchTools } from "@domain/agent/tools/web-search.js";

export { publisherOf } from "@domain/agent/tools/citation.js";

/**
 * This turn's web tools.
 *
 * Built together so a page found by a search and a page read by a fetch never
 * take the same number: the model writes `[N]` against what it was shown, and
 * the panel resolves N to one source.
 * @param context - What the turn knows that the tools need when built. Without
 *   it no link is one the conversation holds.
 * @returns The two tools, keyed as the model names them.
 * @throws {never} Never; the tools it returns throw.
 */
export function makeWebTools(context?: ToolContext): { web_search: Tool; web_fetch: Tool } {
  const numbers = citationNumbers();
  return {
    web_search: makeSearchTools(numbers).web_search,
    web_fetch: makeFetchTool(numbers, context?.pageUrlFor ?? (async () => undefined)),
  };
}
