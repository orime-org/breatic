// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import type { Check, CheckContext, Finding } from "#repo-lint/check";

/**
 * Every tracked text file ends with a newline.
 *
 * Without one, the next person's edit shows up as a two-line diff: the last
 * existing line reads as modified even though only a line was added, so a
 * reviewer reads a change nobody made. That happened concretely on #1839,
 * where a one-line addition to a migration journal produced a hunk touching
 * a line the author never edited and the review filed it as unexplained.
 *
 * No exemptions, and that has to mean every text file rather than a list of
 * source extensions — an earlier list left out `.html`, `.js` and `.jsx`, and
 * a tracked HTML entry point had been sitting without its newline the whole
 * time the check reported clean. The migrations directory is included even
 * though drizzle-kit once emitted those files without the newline: every
 * migration since 0018 is hand-written, so nothing regenerates them and there
 * is nothing to fight.
 */
export const eofNewline = {
  name: "eof-newline",
  description: "Tracked text files end with a newline",
  run(context: CheckContext): Finding[] {
    const files = context.textFiles("tracked text files");

    const findings: Finding[] = [];
    for (const file of files) {
      const text = context.read(file);
      // An empty file has no last line to terminate.
      if (text.length === 0) continue;
      if (!text.endsWith("\n")) {
        findings.push({
          file,
          line: text.split("\n").length,
          message:
            "No trailing newline. The next edit here will read as touching this line too.",
        });
      }
    }
    return findings;
  },
} satisfies Check;
