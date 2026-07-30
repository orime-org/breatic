// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { toRepoRelative } from "#repo-lint/repo-relative";

/** Text files a person authors, where a pasted credential would land. */
const AUTHORED = /\.(ts|mts|cts|tsx|js|jsx|mjs|cjs|json|ya?ml|md|css|scss|html|sh|sql)$/;

/** Machine-authored and large; nobody pastes a key into a lockfile. */
const GENERATED = /(^|\/)pnpm-lock\.yaml$/;

/**
 * How many paths to hand the scanner at once.
 *
 * The shell version passed all ~1400 in a single exec and noted in a
 * comment that this assumed the argument list stayed under the platform
 * limit — an assumption with an expiry date. Batching removes the expiry.
 * It also keeps each JSON reply a manageable size, which matters because
 * the reply embeds the full text of every file it read.
 */
const BATCH = 200;

/** One thing the scanner objected to. */
interface SecretlintMessage {
  /** Human-readable, with the secret itself already masked. */
  readonly message: string;
  /** Which rule fired. */
  readonly ruleId: string;
  /** Where it is. */
  readonly loc: { readonly start: { readonly line: number } };
}

/** The scanner's report for one file. */
interface SecretlintFile {
  /** Absolute path. */
  readonly filePath: string;
  /** Everything found in it. */
  readonly messages: readonly SecretlintMessage[];
}

/**
 * No credential is written literally into a tracked file.
 *
 * A secret committed here is published the moment the repository is, and
 * deleting the line afterwards does not un-publish it — only rotating the
 * credential does. That asymmetry is why this is a hard gate rather than a
 * warning.
 *
 * Detection is secretlint's recommended preset: 27 provider token formats,
 * which are specific enough not to occur by accident, so scanning the whole
 * tree stays quiet. Its companion is the commit hook, which blocks secret
 * FILES (.env, .pem, .key); this covers the complementary case of a secret
 * pasted inline into ordinary source. False positives are handled by a
 * justified entry in .secretlintrc.json, never by narrowing the scan.
 *
 * Findings carry the scanner's own message, which masks the secret. The
 * raw file contents come back in the same reply and are deliberately never
 * read: a guard that prints the credential it found has published it a
 * second time, into the CI log.
 */
export const noHardcodedSecrets = {
  name: "no-hardcoded-secrets",
  description: "No credential is written literally into a tracked file",
  run(context: CheckContext): Finding[] {
    const files = context.files(
      (path) => AUTHORED.test(path) && !GENERATED.test(path),
      "authored text files",
    );

    const binary = resolve(context.repoRoot, "node_modules/.bin/secretlint");
    if (!existsSync(binary)) {
      throw new Error(
        `secretlint is not installed at ${binary} — install dependencies before running this check. ` +
          `Reporting clean because the scanner is missing is exactly what this check exists to prevent.`,
      );
    }

    // A private directory, because the report embeds the full text of every
    // file scanned — including whatever secret was found.
    const workspace = mkdtempSync(join(tmpdir(), "repo-lint-secrets-"));
    try {
      const findings: Finding[] = [];
      for (let start = 0; start < files.length; start += BATCH) {
        const batch = files.slice(start, start + BATCH);
        const report = join(workspace, `batch-${start}.json`);

        // --output rather than reading stdout. Measured: the JSON written
        // to a pipe is truncated at roughly 55 KB, silently, with exit code
        // 0 — the process exits before the write drains. Parsing that
        // leniently would have reported clean; failing to parse is what
        // surfaced it.
        try {
          execFileSync(
            binary,
            [
              "--no-color",
              "--no-glob",
              "--format",
              "json",
              "--output",
              report,
              ...batch,
            ],
            { cwd: context.repoRoot, encoding: "utf8" },
          );
        } catch (error) {
          // A non-zero exit is expected when it finds something; the report
          // is still written. Only a missing report means it could not run.
          if (!existsSync(report)) {
            const failure = error as { message?: string; stderr?: string };
            throw new Error(
              `secretlint could not run: ${failure.stderr ?? failure.message ?? ""}`,
              { cause: error },
            );
          }
        }

        const reports = JSON.parse(
          readFileSync(report, "utf8"),
        ) as SecretlintFile[];
        for (const found of reports) {
          const file = toRepoRelative(context.repoRoot, found.filePath);
          for (const message of found.messages) {
            findings.push({
              file,
              line: message.loc.start.line,
              message: `${message.message} [${message.ruleId}] — rotate the credential; removing the line does not un-publish it. A genuine false positive belongs in .secretlintrc.json with its reason.`,
            });
          }
        }
      }
      return findings;
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  },
} satisfies Check;
