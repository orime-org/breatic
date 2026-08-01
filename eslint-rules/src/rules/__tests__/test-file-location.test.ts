// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { testFileLocation } from "../test-file-location";

const ruleTester = new RuleTester();

ruleTester.run("test-file-location", testFileLocation, {
  valid: [
    { code: "export const a = 1;", filename: "packages/core/src/__tests__/thing.test.ts" },
    { code: "export const a = 1;", filename: "packages/web/src/ui/__tests__/Button.test.tsx" },
    // Not a test file at all.
    { code: "export const a = 1;", filename: "packages/core/src/thing.ts" },
    // A directory that merely contains the word is not the directory.
    { code: "export const a = 1;", filename: "packages/core/src/my__tests__helpers/x.ts" },
  ],
  invalid: [
    {
      code: "export const a = 1;",
      filename: "packages/core/src/thing.test.ts",
      errors: [{ messageId: "wrongLocation" }],
    },
    {
      code: "export const a = 1;",
      filename: "packages/web/src/ui/Button.spec.tsx",
      errors: [{ messageId: "wrongLocation" }],
    },
  ],
});
