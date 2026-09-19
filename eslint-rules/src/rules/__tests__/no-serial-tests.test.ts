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
    // A plain group is what the rule steers towards.
    { code: `test.describe("a group", () => {});` },
    // Someone else's serial group, not Playwright's.
    { code: `describe.serial("a group", () => {});` },
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
    // The other spelling Playwright offers for the same request, which takes
    // no options object to read.
    {
      code: `test.describe.serial("a group", () => {});`,
      errors: [{ messageId: "serialGroup" }],
    },
    {
      code: `test.describe.serial.only("a group", () => {});`,
      errors: [{ messageId: "serialGroup" }],
    },
    {
      code: `test.describe.only.serial("a group", () => {});`,
      errors: [{ messageId: "serialGroup" }],
    },
  ],
});
