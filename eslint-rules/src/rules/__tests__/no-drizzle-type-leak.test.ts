// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noDrizzleTypeLeak } from "../no-drizzle-type-leak";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-drizzle-type-leak", noDrizzleTypeLeak, {
  valid: [
    // What a caller should see instead: the mapped domain entity.
    { code: "import type { UserEntity } from '@domain/user';\nexport type U = UserEntity;" },
    // Other Drizzle members are not row shapes and stay allowed.
    { code: "declare const users: { $inferAlias: string };\nexport const a = users.$inferAlias;" },
    // The name inside a string is not a type reference.
    { code: 'export const doc = "repos map $inferSelect to entities";' },
  ],
  invalid: [
    {
      // The common form: a type alias over the row shape.
      code: "declare const users: object;\nexport type Row = typeof users.$inferSelect;",
      errors: [{ messageId: "noTypeLeak", data: { member: "$inferSelect" }, line: 2, column: 26 }],
    },
    {
      // In a parameter position, which is how repos leak it to callers.
      code: "declare const users: object;\nexport function f(row: typeof users.$inferInsert): void {}",
      errors: [{ messageId: "noTypeLeak", data: { member: "$inferInsert" }, line: 2, column: 31 }],
    },
    {
      // Value position — rarer, but the regex guard matched it too.
      code: "declare const users: { $inferSelect: object };\nexport const r = users.$inferSelect;",
      errors: [{ messageId: "noTypeLeak", data: { member: "$inferSelect" }, line: 2, column: 18 }],
    },
  ],
});
