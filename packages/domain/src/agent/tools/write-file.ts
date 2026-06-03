// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Write file tool.
 *
 * Ported from backend/agent/tools/builtin/filesystem.py (WriteFileTool).
 * Paths are confined to the file-tool sandbox (see {@link assertInSandbox}).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { assertInSandbox, SandboxError } from "@domain/agent/tools/fs-sandbox.js";

/**
 * Write content to a file at the given path.
 *
 * Parent directories are created automatically if they do not exist.
 * The path must resolve inside the file-tool sandbox.
 */
export const writeFileTool = tool({
  description:
    "Write content to a file at the given path. " +
    "Creates parent directories if needed. " +
    "Paths must be inside the agent workspace sandbox.",
  inputSchema: z.object({
    path: z.string().describe("The file path to write to (relative or absolute, must be inside the workspace sandbox)"),
    content: z.string().describe("The content to write"),
  }),
  execute: async ({ path, content }): Promise<string> => {
    let safePath: string;
    try {
      safePath = await assertInSandbox(path);
    } catch (err) {
      if (err instanceof SandboxError) return `Error: ${err.message}`;
      throw err;
    }

    try {
      await mkdir(dirname(safePath), { recursive: true });
      await writeFile(safePath, content, "utf-8");
      return `Successfully wrote ${content.length.toLocaleString()} chars to ${path}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error writing file: ${msg}`;
    }
  },
});
