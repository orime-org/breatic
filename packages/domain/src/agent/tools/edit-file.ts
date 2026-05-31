/**
 * Edit file tool — replace an exact block of text.
 *
 * Ported from backend/agent/tools/builtin/filesystem.py (EditFileTool).
 * Paths are confined to the file-tool sandbox (see {@link assertInSandbox}).
 *
 * @module
 */
import { readFile, writeFile } from "node:fs/promises";
import { tool } from "ai";
import { z } from "zod";
import { assertInSandbox, SandboxError } from "@domain/agent/tools/fs-sandbox.js";

/**
 * Edit a file by replacing `old_text` with `new_text`.
 *
 * The `old_text` must appear exactly once in the file. If it does not
 * exist or appears multiple times, an error is returned. The path must
 * resolve inside the file-tool sandbox.
 */
export const editFileTool = tool({
  description:
    "Edit a file by replacing old_text with new_text. " +
    "The old_text must exist exactly once in the file. " +
    "Paths must be inside the agent workspace sandbox.",
  inputSchema: z.object({
    path: z.string().describe("The file path to edit (relative or absolute, must be inside the workspace sandbox)"),
    old_text: z.string().describe("The exact text to find and replace"),
    new_text: z.string().describe("The replacement text"),
  }),
  execute: async ({ path, old_text, new_text }): Promise<string> => {
    let safePath: string;
    try {
      safePath = await assertInSandbox(path);
    } catch (err) {
      if (err instanceof SandboxError) return `Error: ${err.message}`;
      throw err;
    }

    try {
      const content = await readFile(safePath, "utf-8");

      if (!content.includes(old_text)) {
        return `Error: old_text not found in ${path}. Verify the file content with read_file first.`;
      }

      const count = content.split(old_text).length - 1;
      if (count > 1) {
        return (
          `Error: old_text appears ${count} times in ${path}. ` +
          "Provide more surrounding context to make it unique."
        );
      }

      const newContent = content.replace(old_text, new_text);
      await writeFile(safePath, newContent, "utf-8");
      return `Successfully edited ${path}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ENOENT")) return `Error: File not found: ${path}`;
      return `Error editing file: ${msg}`;
    }
  },
});
