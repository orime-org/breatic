// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noIoredisOutsideCore } from "../no-ioredis-outside-core";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-ioredis-outside-core", noIoredisOutsideCore, {
  valid: [
    // The sanctioned route.
    { code: "import { db } from '@breatic/core';\nexport const handle = db;" },
    // A different module whose name merely contains the banned one.
    { code: "import x from 'ioredis-mock';\nexport const y = x;" },
    // The name in a string is not an import.
    { code: 'export const driver = "ioredis";' },
  ],
  invalid: [
    {
      code: "import Redis from 'ioredis';\nexport const client = Redis;",
      errors: [{ messageId: "noDirectClient", line: 1, column: 1 }],
    },
    {
      // Type-only imports still couple the package to the driver, and the
      // regex guard this replaces matched them too.
      code: "import type { RedisOptions } from 'ioredis';\nexport type O = RedisOptions;",
      errors: [{ messageId: "noDirectClient", line: 1, column: 1 }],
    },
    {
      code: "export { default } from 'ioredis';",
      errors: [{ messageId: "noDirectClient", line: 1, column: 1 }],
    },
    {
      code: "export * from 'ioredis';",
      errors: [{ messageId: "noDirectClient", line: 1, column: 1 }],
    },
    {
      // The form the regex guard missed entirely.
      code: "export async function load(): Promise<unknown> {\n  return await import('ioredis');\n}",
      errors: [{ messageId: "noDirectClient", line: 2, column: 16 }],
    },
    {
      code: "const redis = require('ioredis');",
      errors: [{ messageId: "noDirectClient", line: 1, column: 15 }],
    },
  ],
});
