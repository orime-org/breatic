// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noLibraryProcessExit } from "../no-library-process-exit";

const ruleTester = new RuleTester();

ruleTester.run("no-library-process-exit", noLibraryProcessExit, {
  valid: [
    { code: "export const ok: number = 1;" },
    // A local object that happens to expose `exit` is not the process.
    { code: "const runner = { exit: (): void => {} };\nrunner.exit();" },
    // Mentioning the name in a string is not calling it.
    { code: 'export const hint = "call process.exit only from the entry";' },
  ],
  invalid: [
    {
      // Line/column are asserted against a fixture whose violation sits after
      // a comment and a blank line — exactly the shape where the bash guard
      // reports an off-by-one line.
      code: "// header\n\nexport function bad(): void {\n  process.exit(1);\n}\n",
      errors: [{ messageId: "forbiddenMember", line: 4, column: 3 }],
    },
    {
      code: "process.exit();",
      errors: [{ messageId: "forbiddenMember", line: 1, column: 1 }],
    },
    {
      // Aliasing the member still reaches the same primitive.
      code: "const bail = process.exit;\nbail(1);",
      errors: [{ messageId: "forbiddenMember", line: 1, column: 14 }],
    },
    {
      // Bracket access is the same call written differently. The bash guard
      // it replaces missed this one — its regex only matched `process.exit`.
      code: 'process["exit"](1);',
      errors: [{ messageId: "forbiddenMember", line: 1, column: 1 }],
    },
  ],
});
