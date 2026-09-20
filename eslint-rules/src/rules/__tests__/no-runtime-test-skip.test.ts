// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noRuntimeTestSkip } from "../no-runtime-test-skip";

const ruleTester = new RuleTester();

ruleTester.run("no-runtime-test-skip", noRuntimeTestSkip, {
  valid: [
    // A whole group declared as skipped names itself in the report.
    { code: `test.describe.skip("a group", () => {});` },
    // Declaring a skipped case is a declaration, not a mid-run exit.
    { code: `test.skip("a case", async () => {});` },
    // The same declaration nested in a group is still a declaration. What
    // separates the two shapes is the second argument: a case body means
    // this call declares a case, anything else means it exits one.
    {
      code: `test.describe("a group", () => { test.skip("a case", async () => {}); });`,
    },
    // A group stepped over from inside another group.
    {
      code: `test.describe("outer", () => { test.describe.skip("inner", () => {}); });`,
    },
    // Somebody else's skip.
    { code: `test("a case", async () => { helper.skip(true); });` },
    // A string naming the call is not the call.
    { code: `test("a case", async () => { log("test.skip(true)"); });` },
  ],
  invalid: [
    {
      code: `test("a case", async () => { test.skip(true, "no voices"); });`,
      errors: [{ messageId: "runtimeSkip" }],
    },
    // Guarded by something measured on the page — the shape this rule exists for.
    {
      code: `test("a case", async ({ page }) => { if ((await page.locator("x").count()) < 5) test.skip(true, "too few"); });`,
      errors: [{ messageId: "runtimeSkip" }],
    },
    // Reading an environment variable mid-case skips just as silently.
    {
      code: `test("a case", async () => { test.skip(!process.env.B, "no second account"); });`,
      errors: [{ messageId: "runtimeSkip" }],
    },
    // A hook body is inside the run too.
    {
      code: `test.beforeEach(async () => { test.skip(true, "nothing to do"); });`,
      errors: [{ messageId: "runtimeSkip" }],
    },
    // At file scope it takes every case in the file, which is the line that
    // reported 12 passed and 289 skipped with a zero exit code.
    {
      code: `test.skip(!email, "credentials missing");`,
      errors: [{ messageId: "runtimeSkip" }],
    },
  ],
});
