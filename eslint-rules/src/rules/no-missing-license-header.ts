// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "#rules/create-rule";

/** The copyright line, which must be the file's first line. */
const COPYRIGHT_LINE = "// Copyright (c) 2026 Orime, Inc.";

/** The licence line, which must directly follow the copyright line. */
const SPDX_LINE = "// SPDX-License-Identifier: LicenseRef-BOSL-1.0";

/** What a file missing the header gets prepended, blank line included. */
const HEADER = `${COPYRIGHT_LINE}\n${SPDX_LINE}\n\n`;

/**
 * A line that is header material, whether or not it is the right one.
 *
 * The wrong year, the wrong licence, the two lines the wrong way round: all
 * of it is somebody's attempt at this header, and all of it has to be
 * rewritten rather than pushed down under a correct copy of itself.
 */
const HEADER_LINE = /^\/\/ (Copyright\b|SPDX-License-Identifier:)/;

/**
 * How many of the file's opening lines are an attempt at the header.
 * @param lines The file's lines.
 * @returns 0 when the file opens with something else, otherwise 1 or 2.
 */
function staleHeaderLines(lines: readonly string[]): number {
  let count = 0;
  while (count < 2 && HEADER_LINE.test(lines[count] ?? "")) count += 1;
  return count;
}

/**
 * Every first-party source file carries the SPDX header.
 *
 * The repository is source-available under its own licence, and a file
 * without the header is a file whose terms are unstated wherever it ends up
 * on its own — in a gist, in an issue, in someone's editor. The vendored
 * shadcn components are exempt in the config: they are third-party IP and
 * must not carry an Orime copyright.
 *
 * Checks both lines, where the guard checked only the first. That is not a
 * verdict change today — measured: every file with the copyright line has
 * the licence line under it — but the mandate is the two-line header, and a
 * check that reads one line only enforces half of it.
 *
 * The fix rewrites whatever attempt at the header the file opens with, and
 * only prepends when it opens with something else. Prepending unconditionally
 * was worse than not fixing at all: a file carrying just the copyright line,
 * or the right lines the wrong way round, came out with the correct two lines
 * on top and its old ones stranded underneath — and then it passed, so
 * nothing ever said the duplicate was there.
 *
 * Keeping the fix here leaves one definition of what the header says. A
 * second copy in a script would drift, and nothing would report the drift
 * until a file was found carrying the wrong licence.
 */
export const noMissingLicenseHeader = createRule<[], "missingHeader">({
  name: "no-missing-license-header",
  meta: {
    type: "problem",
    docs: {
      description: "First-party source files start with the SPDX header",
    },
    fixable: "code",
    schema: [],
    messages: {
      missingHeader:
        "Missing the SPDX header. Every first-party source file opens with the copyright and licence lines — run `eslint --fix` to insert them.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      /**
       * Checks the first two lines of the file.
       * @param node The program node, used to anchor the report at the top.
       */
      Program(node: TSESTree.Program): void {
        const lines = context.sourceCode.getLines();
        const [first, second] = lines;
        if (first === COPYRIGHT_LINE && second === SPDX_LINE) return;

        const stale = staleHeaderLines(lines);
        context.report({
          node,
          messageId: "missingHeader",
          fix: (fixer: TSESLint.RuleFixer): TSESLint.RuleFix => {
            if (stale === 0) return fixer.insertTextBeforeRange([0, 0], HEADER);
            const end = context.sourceCode.getIndexFromLoc({
              line: stale,
              column: lines[stale - 1]?.length ?? 0,
            });
            return fixer.replaceTextRange(
              [0, end],
              `${COPYRIGHT_LINE}\n${SPDX_LINE}`,
            );
          },
        });
      },
    };
  },
});
