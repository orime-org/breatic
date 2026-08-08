// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * The entries that talk to the AI SDK. Collab does not, and must not grow a
 * bridge it has no use for.
 */
const AI_ENTRIES: readonly string[] = [
  "packages/server/src/index.ts",
  "packages/worker/src/index.ts",
];

const HOOK = "AI_SDK_LOG_WARNINGS";

/**
 * Both AI SDK entries route the SDK's warnings into the logger, and neither
 * switches them off.
 *
 * The SDK writes warnings to the console by default. Our logs are JSON on
 * disk, so console output lands nowhere anyone reads — and warnings are
 * exactly what matters at 3am: a provider silently dropping a parameter, a
 * model ignoring a setting. The call still succeeds, so nothing else says so.
 *
 * The hook also accepts `false`, which turns warnings off entirely. That is
 * one character away from a working bridge and looks deliberate in a diff, so
 * it is refused by name rather than left to review.
 *
 * A repo-lint check rather than an ESLint rule for the same reason the
 * service-entry check is one: if an entry file is deleted or renamed, no file
 * gets linted and a rule keyed on its contents simply never runs. Absence has
 * to be asserted from outside.
 */
export const aiSdkWarningsBridged = {
  name: "ai-sdk-warnings-bridged",
  description: "Both AI SDK entries send SDK warnings to the logger",
  run(context: CheckContext): Finding[] {
    const findings: Finding[] = [];
    for (const entry of AI_ENTRIES) {
      if (!context.exists(entry)) {
        findings.push({
          file: entry,
          message: `This entry is gone. If it moved, move this expectation with it — a file that does not exist is a file nothing checks, and the ${HOOK} bridge would go missing silently.`,
        });
        continue;
      }
      const source = context.read(entry);
      if (!source.includes(HOOK)) {
        findings.push({
          file: entry,
          message: `No ${HOOK} bridge here. Without it the AI SDK writes its warnings to the console, and this process logs JSON to disk — the warnings go nowhere anyone reads.`,
        });
        continue;
      }
      if (new RegExp(`${HOOK}\\s*=\\s*false`).test(source)) {
        findings.push({
          file: entry,
          message: `${HOOK} is set to false here, which turns the SDK's warnings off rather than routing them. Assign the logger bridge instead.`,
        });
      }
    }
    return findings;
  },
} satisfies Check;
