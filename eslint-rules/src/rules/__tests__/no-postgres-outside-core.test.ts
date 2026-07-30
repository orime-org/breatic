// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noPostgresOutsideCore } from "../no-postgres-outside-core";

const ruleTester = new RuleTester();

ruleTester.run("no-postgres-outside-core", noPostgresOutsideCore, {
  valid: [
    // The sanctioned route.
    { code: "import { db } from '@breatic/core';\nexport const handle = db;" },
    // A different module whose name merely contains the banned one.
    { code: "import x from 'postgres-array';\nexport const y = x;" },
    // The Drizzle adapter is a different specifier and every package may use
    // it — the guard this replaces called that exemption out by name.
    {
      code: "import { drizzle } from 'drizzle-orm/postgres-js';\nexport const d = drizzle;",
    },
    // The name in a string is not an import.
    { code: 'export const driver = "postgres";' },
  ],
  invalid: [
    {
      code: "import postgres from 'postgres';\nexport const sql = postgres;",
      errors: [{ messageId: "noDirectClient", line: 1, column: 1 }],
    },
    {
      // Type-only imports still couple the package to the driver, and the
      // regex guard this replaces matched them too.
      code: "import type { Sql } from 'postgres';\nexport type S = Sql;",
      errors: [{ messageId: "noDirectClient", line: 1, column: 1 }],
    },
    {
      code: "export { default } from 'postgres';",
      errors: [{ messageId: "noDirectClient", line: 1, column: 1 }],
    },
    {
      code: "export * from 'postgres';",
      errors: [{ messageId: "noDirectClient", line: 1, column: 1 }],
    },
    {
      // The form the regex guard missed entirely.
      code: "export async function load(): Promise<unknown> {\n  return await import('postgres');\n}",
      errors: [{ messageId: "noDirectClient", line: 2, column: 16 }],
    },
    {
      code: "const pg = require('postgres');",
      errors: [{ messageId: "noDirectClient", line: 1, column: 12 }],
    },
  ],
});
