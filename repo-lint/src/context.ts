// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CheckContext } from "#repo-lint/check";

/**
 * Lists the files git tracks.
 *
 * `-z` because a path may contain anything but NUL, and because git quotes
 * and escapes non-ASCII paths in its default output — the repo has locale
 * fixtures with such names, and a newline-split list would mangle them.
 * @param repoRoot Absolute path of the repository root.
 * @returns Repo-relative paths.
 * @throws {Error} If git is unavailable or the directory is not a repository.
 */
function listTrackedFiles(repoRoot: string): string[] {
  const stdout = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter((path) => path.length > 0);
}

/**
 * Builds the context every check runs against.
 *
 * The tracked-file list is read once and shared: each check filters the same
 * list rather than shelling out for its own, which is what kept the previous
 * guards' exclude rules from ever agreeing with one another.
 * @param repoRoot Absolute path of the repository root.
 * @returns A context bound to that repository.
 * @throws {Error} If the repository has no tracked files.
 */
export function createContext(repoRoot: string): CheckContext {
  const tracked = listTrackedFiles(repoRoot);
  if (tracked.length === 0) {
    throw new Error(
      `git tracks no files under ${repoRoot} — refusing to report anything as clean`,
    );
  }

  return {
    repoRoot,

    files(select: (path: string) => boolean, label: string): string[] {
      const matched = tracked.filter(select);
      if (matched.length === 0) {
        throw new Error(
          `selection "${label}" matched none of the ${tracked.length} tracked files. ` +
            `A filter that selects nothing reports clean forever, so this is a failure, not a pass.`,
        );
      }
      return matched;
    },

    read(file: string): string {
      return readFileSync(resolve(repoRoot, file), "utf8");
    },

    exists(path: string): boolean {
      return existsSync(resolve(repoRoot, path));
    },
  };
}
