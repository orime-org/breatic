// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noSerialTests } from "../no-serial-tests";

const ruleTester = new RuleTester();

ruleTester.run("no-serial-tests", noSerialTests, {
  valid: [
    // The default. Nothing to say means every case stands on its own.
    { code: `test("a case", async () => {});` },
    // Configuring something other than the mode is untouched.
    { code: `test.describe.configure({ retries: 2 });` },
    // Parallel is the shape this rule steers towards, so it passes.
    { code: `test.describe.configure({ mode: 'parallel' });` },
    // A string that merely reads like the call is not the call.
    { code: `const note = "test.describe.configure({ mode: 'serial' })";` },
    // Someone else's configure, not Playwright's.
    { code: `describe.configure({ mode: 'serial' });` },
  ],
  invalid: [
    {
      code: `test.describe.configure({ mode: 'serial' });`,
      errors: [{ messageId: "serialGroup" }],
    },
    // Double quotes are the same call.
    {
      code: `test.describe.configure({ mode: "serial" });`,
      errors: [{ messageId: "serialGroup" }],
    },
    // Mode alongside other options is still a serial group.
    {
      code: `test.describe.configure({ mode: 'serial', retries: 1 });`,
      errors: [{ messageId: "serialGroup" }],
    },
    // Inside a describe block, which is where these usually sit.
    {
      code: `test.describe("a group", () => { test.describe.configure({ mode: 'serial' }); });`,
      errors: [{ messageId: "serialGroup" }],
    },
  ],
});
