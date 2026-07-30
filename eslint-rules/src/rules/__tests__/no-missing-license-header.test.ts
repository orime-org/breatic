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
    // The copyright line alone passed the guard, which read one line.
    {
      code: `// Copyright (c) 2026 Orime, Inc.\nexport const x = 1;\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n\n// Copyright (c) 2026 Orime, Inc.\nexport const x = 1;\n`,
    },
    // Right lines, wrong order.
    {
      code: `// SPDX-License-Identifier: LicenseRef-BOSL-1.0\n// Copyright (c) 2026 Orime, Inc.\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n\n// SPDX-License-Identifier: LicenseRef-BOSL-1.0\n// Copyright (c) 2026 Orime, Inc.\n`,
    },
    // A different licence must not satisfy it.
    {
      code: `// Copyright (c) 2026 Orime, Inc.\n// SPDX-License-Identifier: MIT\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n\n// Copyright (c) 2026 Orime, Inc.\n// SPDX-License-Identifier: MIT\n`,
    },
    // Header present but not at the top — it has to be the first thing.
    {
      code: `import { x } from "@core/x";\n${HEADER}\n`,
      errors: [{ messageId: "missingHeader" }],
      output: `${HEADER}\n\nimport { x } from "@core/x";\n${HEADER}\n`,
    },
  ],
});
