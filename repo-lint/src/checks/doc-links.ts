// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { toRepoRelative } from "#repo-lint/repo-relative";

/** Shared validation settings, so no package can drift on the flags. */
const OPTIONS = "typedoc.doclinks.json";

/** How each package is fed to the documentation resolver. */
interface ScanTarget {
  /** Package directory name under packages/. */
  readonly name: string;
  /** What to start from. */
  readonly entry: string;
  /** Whether to follow exports inward or treat every file as a root. */
  readonly strategy: "resolve" | "expand";
}

/**
 * Every package, and how each one has to be scanned.
 *
 * A library is scanned from its public entry and followed inward, so a
 * reference from one of its files to another resolves. An application
 * cannot be: web's entry renders a React tree and exports nothing, so
 * following exports reaches almost no files — measured, by planting a
 * dangling link deep in a canvas component and watching an entry-point
 * scan miss it entirely. web is therefore expanded file by file, which
 * reaches everything but makes each file its own root, so only same-file
 * links can resolve there. That is the rule for web: a link within a
 * file, backticks for anything else.
 */
const TARGETS: readonly ScanTarget[] = [
  { name: "shared", entry: "packages/shared/src/index.ts", strategy: "resolve" },
  { name: "core", entry: "packages/core/src/index.ts", strategy: "resolve" },
  { name: "domain", entry: "packages/domain/src/index.ts", strategy: "resolve" },
  { name: "server", entry: "packages/server/src/index.ts", strategy: "resolve" },
  { name: "worker", entry: "packages/worker/src/index.ts", strategy: "resolve" },
  { name: "collab", entry: "packages/collab/src/index.ts", strategy: "resolve" },
  { name: "web", entry: "packages/web/src", strategy: "expand" },
];

/**
 * The colour codes the resolver wraps its severity in.
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
 * Every doc-comment link points at something that exists.
 *
 * Prose is the only thing this repository produces that nothing verifies.
 * Code is checked by the compiler, by tests, and by running; a comment
 * that lies is checked by nobody, so it survives and misleads whoever
 * reads it next. One review turned up twenty-seven prose defects and zero
 * correctness defects, and among them was a comment pointing at a function
 * that had been moved out of the repository months earlier — the sentence
 * stayed behind, describing something that no longer existed.
 *
 * This closes exactly that hole and nothing wider. It asks a question with
 * a definite answer, "does this symbol still resolve", rather than a
 * question of meaning, "is this sentence true". Approaches that judged
 * meaning were measured at 32-48% false positives and abandoned; symbol
 * resolution has none by construction, because the resolver either finds
 * the target or does not.
 *
 * Cross-package references are out of scope: each package resolves against
 * its own tsconfig, so a link written in one package about a type owned by
 * another cannot resolve and belongs in backticks. Resolving them would
 * need a tsconfig carrying every package's aliases, and building one
 * produced several thousand module-resolution errors.
 */
export const docLinks = {
  name: "doc-links",
  description: "Every doc-comment link resolves",
  run(context: CheckContext): Finding[] {
    if (!context.exists(OPTIONS)) {
      throw new Error(
        `${OPTIONS} is missing. It carries the validation flags, and without it the resolver would run with defaults that check nothing.`,
      );
    }

    const findings: Finding[] = [];
    for (const target of TARGETS) {
      if (!context.exists(target.entry)) {
        throw new Error(
          `${target.entry} does not exist, so the ${target.name} package cannot be scanned. A package that is silently skipped reports clean forever.`,
        );
      }
      const tsconfig = `packages/${target.name}/tsconfig.json`;
      if (!context.exists(tsconfig)) {
        throw new Error(`${tsconfig} does not exist.`);
      }

      // Both streams, and spawnSync rather than execFileSync, because the
      // resolver reports a dangling link as a WARNING on stderr and exits
      // 0. Reading only stdout — which is what the success path of
      // execFileSync returns — sees nothing and passes everything. Caught
      // by running the shell guard against the same planted link and
      // getting a different answer.
      const run = spawnSync(
        resolve(context.repoRoot, "node_modules/.bin/typedoc"),
        [
          "--emit",
          "none",
          "--options",
          OPTIONS,
          "--entryPoints",
          target.entry,
          "--entryPointStrategy",
          target.strategy,
          "--tsconfig",
          tsconfig,
        ],
        {
          cwd: context.repoRoot,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      if (run.error !== undefined) {
        throw new Error(
          `the documentation resolver could not run for ${target.name}`,
          { cause: run.error },
        );
      }
      const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;

      for (const line of output.replace(COLOUR, "").split("\n")) {
        if (!COMPLAINT.test(line)) continue;
        const where = locationOf(context.repoRoot, line);
        findings.push({
          file: where?.file ?? target.entry,
          line: where?.line,
          message: `${line.trim()} — a comment pointing at something that no longer exists is checked by nobody, so it survives and misleads the next reader. Fix the target, or write the name in backticks if it lives in another package.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
