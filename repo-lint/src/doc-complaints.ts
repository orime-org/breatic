// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Finding } from "#repo-lint/check";
import { toRepoRelative } from "#repo-lint/repo-relative";

/**
 * The colour codes the documentation resolver wraps its severity in.
 *
 * It writes them even when its output is a pipe, so the severity marker is
 * not at the start of the line until they are removed. Measured the hard
 * way: a first probe on a clean package produced no output at all, and
 * "no escape codes in an empty string" is not evidence about a failing one.
 *
 * The rule against control characters in a pattern exists to catch typos,
 * and cannot tell one from a deliberate escape sequence, so it is disabled
 * for this line alone.
 */
// eslint-disable-next-line no-control-regex -- deliberate; see above
const COLOUR = /\u001b\[[0-9;]*m/g;

/** A warning or error line from the resolver, once uncoloured. */
const COMPLAINT = /^\[(warning|error)\]/;

/**
 * Pulls a file and line out of a resolver complaint, when it names one.
 *
 * The resolver writes `... in /abs/path/file.ts:12`, so the location is
 * recoverable and worth recovering: a finding that names the file is one
 * somebody can act on without searching.
 * @param repoRoot Absolute path of the repository root.
 * @param text One complaint line.
 * @returns The file and line it names, or null.
 */
function locationOf(
  repoRoot: string,
  text: string,
): { file: string; line?: number } | null {
  const match = /(\/[^\s:]+\.tsx?):(\d+)/.exec(text);
  if (match === null) return null;
  return {
    file: toRepoRelative(repoRoot, match[1] ?? ""),
    line: Number(match[2]),
  };
}

/**
 * Turns the resolver's output into findings.
 *
 * Separate from the check that runs the resolver so it can be tested
 * against recorded output. Everything interesting here — the colour codes,
 * the two severities, the location that may or may not be present — is
 * shaped by a tool whose behaviour was measured rather than assumed, and a
 * measurement worth making is worth keeping.
 * @param repoRoot Absolute path of the repository root.
 * @param output Both streams of one resolver run, concatenated.
 * @param fallbackFile File to name when a complaint names none.
 * @returns One finding per complaint.
 */
export function complaintsFrom(
  repoRoot: string,
  output: string,
  fallbackFile: string,
): Finding[] {
  const findings: Finding[] = [];
  for (const line of output.replace(COLOUR, "").split("\n")) {
    if (!COMPLAINT.test(line)) continue;
    const where = locationOf(repoRoot, line);
    findings.push({
      file: where?.file ?? fallbackFile,
      line: where?.line,
      message: `${line.trim()} — a comment pointing at something that no longer exists is checked by nobody, so it survives and misleads the next reader. Fix the target, or write the name in backticks if it lives in another package.`,
    });
  }
  return findings;
}
