// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noHelperModuleHooks } from "../no-helper-module-hooks";

const ruleTester = new RuleTester();

ruleTester.run("no-helper-module-hooks", noHelperModuleHooks, {
  valid: [
    // A fixture is the shape this rule steers towards.
    {
      code: `export const test = base.extend({ cleanup: [async ({ page }, use) => { await use(); }, { auto: true }] });`,
    },
    // A hook a function registers runs where the function is called.
    { code: `export function register() { test.afterEach(async () => {}); }` },
    // An arrow function body is not the module's top level either.
    { code: `export const register = () => { test.beforeEach(async () => {}); };` },
    // A helper calling something that only shares the name of a hook is fine.
    { code: `const used = list.includes(item);` },
    // A plain function call at the top level is not a hook.
    { code: `configure();` },
  ],
  invalid: [
    {
      code: `test.beforeEach(async ({ page }) => {});`,
      errors: [{ messageId: "moduleHook" }],
    },
    {
      code: `test.afterEach(async ({ page }) => {});`,
      errors: [{ messageId: "moduleHook" }],
    },
    {
      code: `test.beforeAll(async () => {});`,
      errors: [{ messageId: "moduleHook" }],
    },
    {
      code: `test.afterAll(async () => {});`,
      errors: [{ messageId: "moduleHook" }],
    },
    // Options set at the top level are bound the same way as hooks.
    {
      code: `test.use({ viewport: { width: 1400, height: 900 } });`,
      errors: [{ messageId: "moduleHook" }],
    },
    // An imported alias is the same object.
    {
      code: `base.afterEach(async () => {});`,
      errors: [{ messageId: "moduleHook" }],
    },
    // Awaiting it does not change where it is bound.
    {
      code: `await test.beforeAll(async () => {});`,
      errors: [{ messageId: "moduleHook" }],
    },
  ],
});
