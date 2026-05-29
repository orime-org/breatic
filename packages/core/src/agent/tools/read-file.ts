/**
 * Read file tool.
 *
 * Ported from backend/agent/tools/builtin/filesystem.py (ReadFileTool).
 * Paths are confined to the file-tool sandbox (see {@link assertInSandbox}).
 *
 * @module
 */
import { readFile, stat } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { assertInSandbox, SandboxError } from "@core/agent/tools/fs-sandbox.js";

/** Maximum file size in bytes (~128 KB). */
const MAX_SIZE = 128 * 1024;

/**
 * Read the contents of a file at the given path.
 *
 * Files larger than 128 KB are rejected. The content is returned as
 * UTF-8 text. The path must resolve inside the file-tool sandbox.
 */
export const readFileTool = tool({
  description:
    "Read the contents of a file at the given path. " +
    "Paths must be inside the agent workspace sandbox.",
  inputSchema: z.object({
    path: z.string().describe("The file path to read (relative or absolute, must be inside the workspace sandbox)"),
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
      const info = await stat(safePath);
      if (!info.isFile()) return `Error: Not a file: ${path}`;
      if (info.size > MAX_SIZE) {
        return `Error: File too large (${info.size.toLocaleString()} bytes). Try reading a smaller file or a specific section.`;
      }
      return await readFile(safePath, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) return `Error: File not found: ${path}`;
      return `Error reading file: ${msg}`;
    }
  },
});
