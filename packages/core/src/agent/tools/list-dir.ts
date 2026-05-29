/**
 * List directory contents tool.
 *
 * Ported from backend/agent/tools/builtin/filesystem.py (ListDirTool).
 * Paths are confined to the file-tool sandbox (see {@link assertInSandbox}).
 *
 * @module
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { assertInSandbox, SandboxError } from "@core/agent/tools/fs-sandbox.js";

/**
 * List the contents of a directory with type indicators.
 *
 * The path must resolve inside the file-tool sandbox.
 */
export const listDirTool = tool({
  description:
    "List the contents of a directory. " +
    "Paths must be inside the agent workspace sandbox.",
  inputSchema: z.object({
    path: z.string().describe("The directory path to list (relative or absolute, must be inside the workspace sandbox)"),
  }),
  execute: async ({ path }): Promise<string> => {
    let safePath: string;
    try {
      safePath = await assertInSandbox(path);
    } catch (err) {
      if (err instanceof SandboxError) return `Error: ${err.message}`;
      throw err;
    }

    try {
      const entries = await readdir(safePath);
      if (entries.length === 0) return `Directory '${path}' is empty`;

      const sorted = [...entries].sort();
      const lines: string[] = [];
      for (const name of sorted) {
        const info = await stat(join(safePath, name));
        const prefix = info.isDirectory() ? "[dir]  " : "[file] ";
        lines.push(`${prefix}${name}`);
      }
      return lines.join("\n");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) return `Error: Directory not found: ${path}`;
      if (msg.includes("ENOTDIR")) return `Error: Not a directory: ${path}`;
      return `Error listing directory: ${msg}`;
    }
  },
});
