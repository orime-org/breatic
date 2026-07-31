// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noMissingLicenseHeader } from "../no-missing-license-header";

const ruleTester = new RuleTester();

const HEADER = `// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0`;

ruleTester.run("no-missing-license-header", noMissingLicenseHeader, {
  valid: [
    { code: `${HEADER}\n\nexport const x = 1;\n` },
    // No blank line after the header is a style choice, not a violation.
    { code: `${HEADER}\nexport const x = 1;\n` },
    // A file that is nothing but the header.
    { code: HEADER },
  ],
  invalid: [
    {
      code: `export const x = 1;\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n\nexport const x = 1;\n`,
    },
    {
      code: ``,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n\n`,
    },
    // Right lines, wrong order.
    {
      // Reversed: both lines are header material, so both are rewritten
      // rather than pushed down under a second copy of themselves.
      code: `// SPDX-License-Identifier: LicenseRef-BOSL-1.0\n// Copyright (c) 2026 Orime, Inc.\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n`,
    },
    // A different licence must not satisfy it, and must be corrected in
    // place: prepending left the file with two copyright lines and a stale
    // licence, and then it passed.
    {
      code: `// Copyright (c) 2026 Orime, Inc.\n// SPDX-License-Identifier: MIT\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n`,
    },
    // Only the copyright line: the case `eslint --fix` used to answer with a
    // duplicate, which then satisfied the rule.
    {
      code: `// Copyright (c) 2026 Orime, Inc.\nexport const x = 1;\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\nexport const x = 1;\n`,
    },
    // Header present but not at the top — it has to be the first thing.
    {
      code: `import { x } from "@core/x";\n${HEADER}\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n\nimport { x } from "@core/x";\n${HEADER}\n`,
    },
  ],
});
