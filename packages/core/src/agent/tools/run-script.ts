/**
 * Skill script execution tool with path sandboxing.
 *
 * Only allows execution of scripts inside `skills/{skillName}/scripts/`.
 * Prevents path traversal and arbitrary command execution.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { resolve, extname } from "node:path";
import { existsSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { MONOREPO_ROOT } from "../../config/env.js";

const MAX_OUTPUT = 10_000;
const TIMEOUT_MS = 60_000;

/** Root directory for built-in skills. */
const SKILLS_DIR = resolve(MONOREPO_ROOT, "skills");

/** Map file extensions to their interpreter commands. */
const INTERPRETERS: Readonly<Record<string, string>> = {
  ".py": "python3",
  ".sh": "/bin/sh",
  ".js": "node",
  ".ts": "npx tsx",
};

/**
 * Execute a script from a Skill's `scripts/` directory.
 *
 * Path is sandboxed to `skills/{skillName}/scripts/{scriptName}`.
 * The interpreter is chosen automatically based on file extension.
 * Scripts are killed after a 60-second timeout. Output is capped
 * at 10,000 characters.
 */
export const runScript = tool({
  description:
    "Execute a script bundled with a Skill. " +
    "Can only run scripts inside skills/{skillName}/scripts/. " +
    "Use this for Skill-defined automation like image processing or data transforms.",
  inputSchema: z.object({
    skill: z.string().describe("Name of the skill (e.g. 'afame')"),
    script: z.string().describe("Script filename (e.g. 'illustrate.py')"),
    args: z
      .record(z.string(), z.string())
      .optional()
      .describe("Key-value arguments passed as environment variables to the script"),
  }),
  execute: async ({ skill, script, args }): Promise<string> => {
    // Resolve and validate the script path
    const scriptPath = resolve(SKILLS_DIR, skill, "scripts", script);

    // Prevent path traversal (e.g. skill="../../etc", script="passwd")
    const safePrefix = resolve(SKILLS_DIR) + "/";
    if (!scriptPath.startsWith(safePrefix)) {
      return "Error: Invalid script path — path traversal detected.";
    }

    // Check the script exists
    if (!existsSync(scriptPath)) {
      return `Error: Script not found at skills/${skill}/scripts/${script}`;
    }

    // Select interpreter by extension
    const ext = extname(script).toLowerCase();
    const interpreter = INTERPRETERS[ext];
    if (!interpreter) {
      return `Error: Unsupported script type '${ext}'. Supported: ${Object.keys(INTERPRETERS).join(", ")}`;
    }

    // Build environment: inherit minimal env + script args
    const scriptEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      ...(args ?? {}),
    };

    // Execute
    const interpreterParts = interpreter.split(" ");
    const cmd = interpreterParts[0]!;
    const cmdArgs = [...interpreterParts.slice(1), scriptPath];

    return new Promise<string>((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      execFile(
        cmd,
        cmdArgs,
        {
          cwd: SKILLS_DIR,
          env: scriptEnv,
          signal: controller.signal,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          clearTimeout(timer);

          if (error && error.name === "AbortError") {
            resolve(`Error: Script timed out after ${TIMEOUT_MS / 1000} seconds`);
            return;
          }

          const parts: string[] = [];
          if (stdout) parts.push(stdout);
          if (stderr && stderr.trim()) parts.push(`STDERR:\n${stderr}`);
          if (error && error.code !== undefined) {
            parts.push(`\nExit code: ${error.code}`);
          }

          let result = parts.length > 0 ? parts.join("\n") : "(no output)";
          if (result.length > MAX_OUTPUT) {
            result =
              result.slice(0, MAX_OUTPUT) +
              `\n... (truncated, ${result.length - MAX_OUTPUT} more chars)`;
          }
          resolve(result);
        },
      );
    });
  },
});
