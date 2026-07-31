// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CheckContext } from "#repo-lint/check";
import { isScannableText, isTextContent } from "#repo-lint/file-kinds";

/**
 * Lists the files the repository is about to consist of.
 *
 * `--cached --others --exclude-standard`, not just the tracked set: a file
 * that has been written but not committed yet is part of what the next
 * commit contains, and judging only the tracked set means a new file is
 * clean right up until the moment it is committed and then is not. That
 * happened here — a check flagged its own newly added source the first time
 * it ran after the commit that added it, having reported clean before.
 * `--exclude-standard` honours .gitignore, so build output and local scratch
 * stay out. On CI's clean checkout the two forms are identical.
 *
 * `-z` because a path may contain anything but NUL, and because git quotes
 * and escapes non-ASCII paths in its default output — the repo has locale
 * fixtures with such names, and a newline-split list would mangle them.
 * @param repoRoot Absolute path of the repository root.
 * @returns Repo-relative paths.
 * @throws {Error} If git is unavailable or the directory is not a repository.
 */
function listTrackedFiles(repoRoot: string): string[] {
  const stdout = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const listed = new Set(stdout.split("\0").filter((path) => path.length > 0));
  // A file deleted from the working tree is still in the index, so it comes
  // back from the listing above with nothing behind it — reading it throws
  // ENOENT and takes the whole run down. Dropping it here is safe in the
  // one way that matters: a file with no contents cannot be hiding a
  // violation, so nothing goes unchecked by leaving it out.
  return [...listed].filter((path) => existsSync(join(repoRoot, path)));
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
          `selection "${label}" matched none of the ${tracked.length} files in the working tree. ` +
            `A filter that selects nothing reports clean forever, so this is a failure, not a pass.`,
        );
      }
      return matched;
    },

    walk(
      directory: string,
      select: (path: string) => boolean,
      label: string,
    ): string[] {
      const absolute = resolve(repoRoot, directory);
      if (!existsSync(absolute)) {
        throw new Error(
          `${directory} does not exist. This check reads build output, so run the build first — ` +
            `reporting clean because there was nothing to look at is the failure mode it exists to prevent.`,
        );
      }
      const entries = readdirSync(absolute, {
        recursive: true,
        withFileTypes: true,
      });
      const found = entries
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const parentRelative = entry.parentPath.slice(repoRoot.length + 1);
          return `${parentRelative}/${entry.name}`;
        })
        .filter(select);
      if (found.length === 0) {
        throw new Error(
          `selection "${label}" matched none of the files under ${directory}.`,
        );
      }
      return found;
    },

    textFiles(select: (path: string) => boolean, label: string): string[] {
      const readable = this.files(
        (path) => isScannableText(path) && select(path),
        label,
      ).filter((path) => isTextContent(this.read(path)));
      if (readable.length === 0) {
        throw new Error(
          `selection "${label}" matched files, but none of them turned out to be text. ` +
            `A scan with nothing readable reports clean forever, so this is a failure, not a pass.`,
        );
      }
      return readable;
    },

    read(file: string): string {
      return readFileSync(resolve(repoRoot, file), "utf8");
    },

    exists(path: string): boolean {
      return existsSync(resolve(repoRoot, path));
    },
  };
}
