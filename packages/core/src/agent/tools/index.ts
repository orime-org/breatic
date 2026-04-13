/**
 * Tool registry — maps tool names to AI SDK tool definitions.
 *
 * The `spawn` tool is NOT included here because it depends on
 * `request-context` (API-only). It lives in @breatic/server and
 * is registered there via `registerTool("spawn", spawnTool)`.
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

/** Mutable tool map — @breatic/server adds `spawn` at startup. */
const TOOL_MAP: Record<string, Tool> = {
  run_script: runScript,
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  list_dir: listDirTool,
  web_search: webSearch,
  web_fetch: webFetch,
  ask_user_question: askUser,
};

/** Names of the default tools available to every agent. */
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
 * Register an additional tool (e.g. `spawn` from the server package).
 */
export function registerTool(name: string, tool: Tool): void {
  TOOL_MAP[name] = tool;
}

/**
 * Build a tool set for the AI SDK from a list of tool names.
 *
 * Unknown names are silently skipped.
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
  webFetch,
  webSearch,
  writeFileTool,
};
