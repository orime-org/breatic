// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noBorrowedProject } from "../no-borrowed-project";

const ruleTester = new RuleTester();

ruleTester.run("no-borrowed-project", noBorrowedProject, {
  valid: [
    // What replaces all three routes: setup built it, the helper hands it over.
    { code: `const url = await projectFor("A", 0);` },
    // Other selectors on the same page are untouched.
    { code: `page.locator('a[href^="/studio/"]').first();` },
    // A project id that came from somewhere accountable.
    { code: `const id = projects.A[0];` },
  ],
  invalid: [
    {
      code: `const first = page.locator('a[href^="/project/"]').first();`,
      errors: [{ messageId: "forbiddenToken" }],
    },
    // Dropping the tag name is the same route.
    {
      code: `const first = page.locator('[href^="/project/"]');`,
      errors: [{ messageId: "forbiddenToken" }],
    },
    {
      code: `const projectUrl = process.env.SMOKE_PROJECT_URL;`,
      errors: [{ messageId: "forbiddenToken" }],
    },
    // Reading it by string index is the same variable.
    {
      code: `const projectUrl = process.env["SMOKE_PROJECT_URL"];`,
      errors: [{ messageId: "forbiddenToken" }],
    },
  ],
});
