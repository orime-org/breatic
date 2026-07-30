// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { CheckContext } from "#repo-lint/check";
import { isScannableText, isTextContent } from "#repo-lint/file-kinds";

/**
 * Builds a context over an in-memory file set.
 *
 * Mirrors the real context's contract exactly, including the part that
 * matters most: an empty selection throws rather than returning nothing.
 * A fake that quietly returned `[]` there would let a check's tests pass
 * while the check reports clean forever in production.
 * @param files Repo-relative path to contents.
 * @param repoRoot What to report as the root; only matters to checks that
 *   resolve absolute paths.
 * @returns A context over exactly those files.
 */
export function fakeContext(
  files: Record<string, string>,
  repoRoot = "/repo",
): CheckContext {
  const paths = Object.keys(files);
  return {
    repoRoot,
    files(select: (path: string) => boolean, label: string): string[] {
      const matched = paths.filter(select);
      if (matched.length === 0) {
        throw new Error(
          `selection "${label}" matched none of the ${paths.length} tracked files.`,
        );
      }
      return matched;
    },
    walk(
      directory: string,
      select: (path: string) => boolean,
      label: string,
    ): string[] {
      // The fake treats the same map as if it were on disk: a check that
      // reads build output is given fixture paths under that directory.
      const under = paths.filter((path) => path.startsWith(`${directory}/`));
      if (under.length === 0) {
        throw new Error(`${directory} does not exist.`);
      }
      const matched = under.filter(select);
      if (matched.length === 0) {
        throw new Error(
          `selection "${label}" matched none of the files under ${directory}.`,
        );
      }
      return matched;
    },
    textFiles(select: (path: string) => boolean, label: string): string[] {
      const readable = this.files(
        (path) => isScannableText(path) && select(path),
        label,
      ).filter((path) => isTextContent(files[path] ?? ""));
      if (readable.length === 0) {
        throw new Error(
          `selection "${label}" matched files, but none of them turned out to be text.`,
        );
      }
      return readable;
    },
    read(file: string): string {
      const content = files[file];
      if (content === undefined) throw new Error(`no such file: ${file}`);
      return content;
    },
    exists(path: string): boolean {
      return path in files;
    },
  };
}
