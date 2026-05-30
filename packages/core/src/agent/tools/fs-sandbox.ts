/**
 * Filesystem sandbox for the agent file tools.
 *
 * The `read_file`, `write_file`, `edit_file`, and `list_dir` tools
 * used to accept any absolute path, letting an agent-driven request
 * read `/app/.env`, overwrite skill scripts, or escape via symlink.
 * This module constrains every file operation to a single sandbox
 * root (default `sandbox/` under the monorepo root).
 *
 * The check follows the "realpath and prefix" pattern:
 *
 *   1. Resolve the user-supplied path to an absolute path, treating
 *      bare names as relative to the sandbox root.
 *   2. Walk up until an existing ancestor is found, and call
 *      `fs.realpath()` on it (to resolve symlinks). This handles the
 *      `write_file` case where the target does not yet exist.
 *   3. Reattach any non-existent suffix components.
 *   4. Require the resolved path to be equal to, or a child of, the
 *      sandbox root — with the path-separator boundary enforced so
 *      `/sandbox/foo` cannot match against `/sandbox-escape`.
 *
 * The sandbox root itself is realpath-normalized at module load so
 * that symlinked install layouts (pnpm, worktrees) behave correctly.
 */

import { realpath } from "node:fs/promises";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { env, MONOREPO_ROOT } from "@core/config/env.js";

/** Error thrown when a path would escape the sandbox. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/**
 * Resolved, realpath-normalized sandbox root. Lazily computed on
 * first use so that module import has no filesystem side effects
 * (important for unit tests that mock `config/env`).
 */
let _sandboxRoot: string | null = null;

/**
 * Return the sandbox root, initializing it on first call.
 *
 * Reads `FILE_TOOL_SANDBOX_DIR` if set, otherwise defaults to
 * `<monorepo root>/sandbox`. The directory is created on first call
 * so subsequent `realpath` lookups succeed.
 */
function getSandboxRootLazy(): string {
  if (_sandboxRoot !== null) return _sandboxRoot;
  const configured = env.FILE_TOOL_SANDBOX_DIR?.trim();
  const dir = configured && configured.length > 0
    ? resolve(configured)
    : resolve(MONOREPO_ROOT, "sandbox");
  mkdirSync(dir, { recursive: true });
  _sandboxRoot = realpathSync(dir);
  return _sandboxRoot;
}

/** Expose for testing. The value is already realpath-normalized. */
export function getSandboxRoot(): string {
  return getSandboxRootLazy();
}

/**
 * Validate a user-supplied path and return its normalized, real,
 * absolute location inside the sandbox.
 *
 * Throws {@link SandboxError} for any of:
 *   - Absolute path pointing outside the sandbox
 *   - Relative path with `..` segments that escape the sandbox
 *   - Path whose realpath (after symlink resolution) escapes
 *
 * @param userPath - The path argument received from the agent tool
 * @returns The resolved real absolute path inside the sandbox
 * @throws SandboxError if the path would escape the sandbox
 */
export async function assertInSandbox(userPath: string): Promise<string> {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new SandboxError("Path must be a non-empty string");
  }

  const sandboxRoot = getSandboxRootLazy();

  // Step 1: resolve to absolute. Relative paths are rooted at sandbox.
  const absolute = isAbsolute(userPath)
    ? resolve(userPath)
    : resolve(sandboxRoot, userPath);

  // Step 2: walk up to find an existing ancestor and realpath it,
  // then reattach the non-existent suffix. This supports write_file
  // creating new files inside an existing sandbox subdirectory.
  const resolvedReal = await resolveRealPathAllowingMissing(absolute);

  // Step 3: require the result to be at or under the sandbox root.
  // The `sep` suffix prevents `/sandbox-foo` from passing as
  // `/sandbox/foo`.
  if (
    resolvedReal !== sandboxRoot &&
    !resolvedReal.startsWith(sandboxRoot + sep)
  ) {
    throw new SandboxError(
      `Path '${userPath}' resolves outside the file tool sandbox`,
    );
  }

  return resolvedReal;
}

/**
 * Resolve symlinks on the longest existing ancestor of `target` and
 * rejoin the non-existent suffix components. Used so that
 * `write_file` can create new files inside an existing sandbox
 * directory without confusing `realpath` by passing it a nonexistent
 * path.
 */
async function resolveRealPathAllowingMissing(target: string): Promise<string> {
  const suffix: string[] = [];
  let probe = target;

  for (;;) {
    try {
      const real = await realpath(probe);
      if (suffix.length === 0) return real;
      // suffix was collected top-down as we walked up; reverse for join
      return resolve(real, ...suffix.reverse());
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") throw err;
      const parent = dirname(probe);
      if (parent === probe) {
        // Reached filesystem root and still can't realpath — abort
        // rather than return an unnormalized path. This is unreachable
        // in practice because `/` always realpaths.
        throw new SandboxError(
          `Unable to resolve real path for '${target}'`,
        );
      }
      suffix.push(basename(probe));
      probe = parent;
    }
  }
}
