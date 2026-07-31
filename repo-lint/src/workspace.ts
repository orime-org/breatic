// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { minimatch } from "minimatch";
import { parse } from "yaml";
import type { CheckContext } from "#repo-lint/check";

/** Where the workspace is defined, which is the only place it is defined. */
export const WORKSPACE = "pnpm-workspace.yaml";

/**
 * Reads the package globs the workspace declares.
 *
 * Read rather than restated. Two checks ask which packages exist, and a
 * hand-kept list in either of them fails the same way: a package added
 * outside the list is not looked for, so it is never reported — which is what
 * both checks exist to report. Restated twice, the two lists also drift from
 * each other, and the one that drifts is the one nobody notices.
 * @param context The check context.
 * @returns The `packages` entries, in the order the file lists them.
 * @throws {Error} When the workspace file is missing or declares no packages.
 */
export function workspaceGlobs(context: CheckContext): string[] {
  if (!context.exists(WORKSPACE)) {
    throw new Error(
      `${WORKSPACE} is not there, so this check cannot know which packages the workspace has. Guessing would mean reporting clean for packages it never looked for.`,
    );
  }
  // Parsed, not pattern-matched. A hand-written reader stopped at the first
  // line that was not an entry, so a comment or a blank line inside the list
  // silently truncated it — and a package that is never looked for is never
  // reported, which is the subject of both callers. The repository already
  // depends on a YAML parser for its own config files; there was never a
  // reason for this one to be different.
  const parsed: unknown = parse(context.read(WORKSPACE));
  const declared =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { packages?: unknown }).packages
      : undefined;
  const globs = Array.isArray(declared)
    ? declared.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (globs.length === 0) {
    throw new Error(
      `${WORKSPACE} declares no packages, so this check would look at nothing and report clean.`,
    );
  }
  return globs;
}

/** The file whose presence makes a directory a package. */
const MANIFEST = "package.json";

/**
 * Turns a workspace entry into a glob over manifest paths.
 *
 * Which is how pnpm globs them: the entries name directories, and pnpm looks
 * for a manifest beneath each. The distinction is not cosmetic — matching a
 * glob against the directory answers differently at the exclusion's own
 * edge, because a trailing `/**` requires a segment after it while the same
 * glob over `<dir>/package.json` has one.
 * @param entry A workspace entry, without any leading `!`.
 * @returns The glob to match a manifest path against.
 */
function overManifests(entry: string): string {
  return `${entry.replace(/\/+$/, "")}/${MANIFEST}`;
}

/**
 * Decides whether a manifest belongs to a package the workspace declares.
 *
 * pnpm's own documented example for this file is `packages/**` alongside an
 * exclusion entry, and both spellings defeated the converter that used to
 * translate these globs into a regular expression by hand: `*` became one
 * path segment, so `**` looked exactly one directory deep, and the leading
 * `!` became a literal that matched nothing. So the globs go to a glob
 * matcher, and the exclusion form pnpm documents is honoured as one.
 *
 * Matched over manifest paths rather than over directories, which is the
 * shape pnpm globs and the shape that agrees with it at the edge: measured
 * against pnpm, a workspace excluding `**\/fixtures/**` drops a package at
 * `packages/core/fixtures` as well as everything under it, while matching
 * the directory kept the first of the two.
 * @param globs The workspace's `packages` entries, in order.
 * @returns A predicate over repo-relative manifest paths.
 */
export function declaredBy(
  globs: readonly string[],
): (path: string) => boolean {
  const included = globs
    .filter((glob) => !glob.startsWith("!"))
    .map(overManifests);
  const excluded = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => overManifests(glob.slice(1)));
  return (path: string): boolean => {
    if (excluded.some((glob) => minimatch(path, glob))) return false;
    return included.some((glob) => minimatch(path, glob));
  };
}
