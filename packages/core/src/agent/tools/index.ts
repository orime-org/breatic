/**
 * Tool registry — maps tool names to AI SDK tool definitions.
 *
 * @module
 */
import type { Tool } from "ai";

import { askUser } from "@core/agent/tools/ask-user.js";
import { askUserChoice } from "@core/agent/tools/ask-user-choice.js";
import { editFileTool } from "@core/agent/tools/edit-file.js";
import { runScript } from "@core/agent/tools/run-script.js";
import { listDirTool } from "@core/agent/tools/list-dir.js";
import { proposeCanvasAction } from "@core/agent/tools/propose-canvas-action.js";
import { readFileTool } from "@core/agent/tools/read-file.js";
import { showSearchResults } from "@core/agent/tools/show-search-results.js";
import { webFetch } from "@core/agent/tools/web-fetch.js";
import { webSearch } from "@core/agent/tools/web-search.js";
import { writeFileTool } from "@core/agent/tools/write-file.js";
import { spawnTool } from "@core/agent/tools/spawn.js";

/** Complete mapping of tool name to tool instance. */
const TOOL_MAP: Readonly<Record<string, Tool>> = {
  run_script: runScript,
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  list_dir: listDirTool,
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
  spawn: spawnTool,
} as const;

/** Names of the default tools available to every agent (including spawn). */
export const DEFAULT_TOOLS: ReadonlySet<string> = new Set([
  "run_script",
  "read_file",
  "write_file",
  "edit_file",
  "list_dir",
  "web_search",
  "web_fetch",
  "spawn",
]);

/**
 * Build a tool set for the AI SDK from a list of tool names.
 *
 * Unknown names are silently skipped. Pass an empty array to get an
 * empty set — use `DEFAULT_TOOLS` for the standard set.
 *
 * @param toolNames - Array of tool name strings to include.
 * @returns A `Record<string, Tool>` suitable for the AI SDK `tools` option.
 *
 * @example
 * ```ts
 * import { buildToolSet, DEFAULT_TOOLS } from "@core/agent/tools/tools/index.js";
 * const tools = buildToolSet([...DEFAULT_TOOLS, "ask_user_question"]);
 * ```
 */
export function buildToolSet(
  toolNames: readonly string[],
): Record<string, Tool> {
  const result: Record<string, Tool> = {};
  for (const name of toolNames) {
    const t = TOOL_MAP[name];
    if (t) result[name] = t;
  }
  return result;
}

export {
  askUser,
  askUserChoice,
  editFileTool,
  runScript,
  listDirTool,
  proposeCanvasAction,
  readFileTool,
  showSearchResults,
  spawnTool,
  webFetch,
  webSearch,
  writeFileTool,
};
