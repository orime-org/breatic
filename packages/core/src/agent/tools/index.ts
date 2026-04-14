/**
 * Tool registry — maps tool names to AI SDK tool definitions.
 *
 * @module
 */
import type { Tool } from "ai";

import { askUser } from "./ask-user.js";
import { editFileTool } from "./edit-file.js";
import { runScript } from "./run-script.js";
import { listDirTool } from "./list-dir.js";
import { readFileTool } from "./read-file.js";
import { webFetch } from "./web-fetch.js";
import { webSearch } from "./web-search.js";
import { writeFileTool } from "./write-file.js";
import { spawnTool } from "./spawn.js";

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
 * import { buildToolSet, DEFAULT_TOOLS } from "./tools/index.js";
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
  editFileTool,
  runScript,
  listDirTool,
  readFileTool,
  spawnTool,
  webFetch,
  webSearch,
  writeFileTool,
};
