// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { resolve } from "node:path";
import { hasConfusablesInFiles } from "anti-trojan-source";
import type { Check, CheckContext, Finding } from "#repo-lint/check";
import { isScannableText } from "#repo-lint/file-kinds";
import { toRepoRelative } from "#repo-lint/repo-relative";

/**
 * Invisible characters that cannot hide code from a reviewer.
 *
 * A variation selector only changes how the emoji before it renders. It is
 * not ID_Continue, so it cannot appear in an identifier, which means it
 * cannot alter what any code means — it is invisible without being
 * deceptive. The repo uses ⚠️ ✅ 🖼️ deliberately in docs and UI, and
 * flagging those would make the check noisy enough to get switched off.
 */
const HARMLESS_CATEGORY = "Variation Selector";

/**
 * No bidirectional overrides or invisible control characters in source.
 *
 * This is CVE-2021-42574. A contributor can hide a logic flip — an early
 * return, a swapped comparison — inside a comment or a string using bidi
 * overrides, so what a reviewer reads is not what the compiler parses. The
 * attack survives human review by construction, which is why it needs a
 * machine.
 *
 * Only the dangerous subset, never ordinary non-ASCII: CJK, accents,
 * typography and emoji all pass. Keeping CJK out of source is a separate
 * concern with its own check, and conflating them would make this one noisy
 * enough to be turned off.
 *
 * Detection is `anti-trojan-source`'s library API rather than its CLI: the
 * CLI unconditionally calls `process.stdin.unref()`, which throws on Node 24
 * whenever stdin is not a pipe — that is, in CI.
 *
 * Scope is every tracked file whose bytes are text. An earlier version
 * skipped the env templates, which is backwards: a bidi override in a
 * template that becomes a deployed environment reads one way and sets
 * another, and nothing else looks at those files.
 */
export const noTrojanSource = {
  name: "no-trojan-source",
  description: "Source contains no bidi overrides or invisible controls",
  async run(context: CheckContext): Promise<Finding[]> {
    const files = context.files(isScannableText, "readable tracked files");

    const reports = await hasConfusablesInFiles({
      filePaths: files.map((file) => resolve(context.repoRoot, file)),
      detailed: true,
      extended: false,
    });

    const findings: Finding[] = [];
    for (const report of reports ?? []) {
      const relative = toRepoRelative(context.repoRoot, report.file);
      for (const hit of report.findings) {
        if (hit.category === HARMLESS_CATEGORY) continue;
        findings.push({
          file: relative,
          line: hit.line,
          message: `${hit.codePoint} ${hit.name} [${hit.category}] at column ${hit.column} — what this line displays as is not what it compiles to.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
