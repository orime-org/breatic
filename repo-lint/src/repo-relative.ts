// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/**
 * Turns a path an external tool reported into a repo-relative one.
 *
 * Tools differ in whether they resolve symlinks before reporting a path.
 * On macOS the temporary directory is reached through one — /var/folders
 * is a link to /private/var/folders — so a tool that resolves and a root
 * that does not will never share a prefix, and a naive comparison leaves
 * the finding pointing at an absolute path nobody can act on. Resolving
 * both sides removes the difference.
 * @param repoRoot Absolute path of the repository root.
 * @param reported The path as the tool gave it.
 * @returns A repo-relative path, or the original if it lies outside.
 */
export function toRepoRelative(repoRoot: string, reported: string): string {
  if (!isAbsolute(reported)) return reported;
  const resolvedRoot = resolveIfPossible(repoRoot);
  const resolvedPath = resolveIfPossible(reported);
  const inside = relative(resolvedRoot, resolvedPath);
  return inside === "" || inside.startsWith("..") ? reported : inside;
}

/**
 * Resolves symlinks, leaving the path alone when it cannot be resolved.
 * @param path An absolute path that may or may not exist.
 * @returns The resolved path, or the input.
 */
function resolveIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
