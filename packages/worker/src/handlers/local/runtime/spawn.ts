/**
 * Child-process spawner for CLI-based local handlers (FFmpeg,
 * ImageMagick, etc.). Handlers that use Node.js libraries (e.g. Sharp)
 * do NOT need this utility — they call the library directly.
 *
 * The wrapper enforces:
 *   - stderr captured in full (FFmpeg/ImageMagick use stderr for
 *     progress + errors). Included in the thrown error for debugging.
 *   - non-zero exit code → thrown `Error` with command + stderr.
 *   - no shell invocation → arguments are passed array-style, so
 *     callers never need to escape user-derived values.
 */

import { spawn, type SpawnOptions } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
}

/**
 * Spawn a command with arguments, capture stdout/stderr, and resolve
 * when the process exits with code 0. Reject otherwise.
 * @param command - Executable name (looked up via PATH) or absolute path.
 *   Expected to be a trusted binary installed in the Worker Docker image
 *   — NEVER a user-supplied string.
 * @param args - CLI arguments as a pre-split array (no shell).
 * @param options - Passed through to `spawn`. Useful for `cwd`.
 * @returns The captured `{ stdout, stderr }` once the process exits with code 0
 * @throws {Error} with `{command, code, signal, stderr}` context on
 *   non-zero exit or spawn failure.
 */
export async function spawnCollected(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args as string[], { ...options, shell: false });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });

    proc.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const tail = stderr.slice(-2000);
      reject(
        new Error(
          `${command} exited with code=${code} signal=${signal}\nstderr: ${tail}`,
        ),
      );
    });
  });
}
