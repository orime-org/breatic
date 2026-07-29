// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noCorsWildcardCredentials } from "../no-cors-wildcard-credentials";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-cors-wildcard-credentials", noCorsWildcardCredentials, {
  valid: [
    // How the real middleware is written: an explicit whitelist.
    {
      code: "export const opts = { origin: ['https://a.example'], credentials: true };",
    },
    // A wildcard without credentials is a public read-only API, not a leak.
    { code: "export const opts = { origin: '*' };" },
    // Credentials alone say nothing about which origins are allowed.
    { code: "export const opts = { credentials: true };" },
    // A wildcard on some unrelated key.
    {
      code: "export const opts = { pattern: '*', credentials: true };",
    },
  ],
  invalid: [
    {
      code: "export const opts = { origin: '*', credentials: true };",
      errors: [{ messageId: "wildcardWithCredentials", line: 1, column: 23 }],
    },
    {
      // Array form — the shape the guard's regex also accepted.
      code: "export const opts = { origin: ['*'], credentials: true };",
      errors: [{ messageId: "wildcardWithCredentials", line: 1, column: 23 }],
    },
    {
      // Split across two objects: same shipped behaviour, and the file-level
      // guard this replaces caught it.
      code: "const base = { credentials: true };\nexport const opts = { ...base, origin: '*' };",
      errors: [{ messageId: "wildcardWithCredentials", line: 2, column: 32 }],
    },
  ],
});
