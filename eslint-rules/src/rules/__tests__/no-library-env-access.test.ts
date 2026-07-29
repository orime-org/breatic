// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { noLibraryEnvAccess } from "../no-library-env-access";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

ruleTester.run("no-library-env-access", noLibraryEnvAccess, {
  valid: [
    // The sanctioned way a library reads configuration.
    { code: "import { env } from '#core/config';\nexport const url = env.DATABASE_URL;" },
    // cwd is not configuration — the guard this replaces called this out.
    { code: "export const root = process.cwd();" },
    // A local object named `process` is not the Node global's env.
    { code: "const proc = { env: {} };\nexport const e = proc.env;" },
    // Prose in a string is not an access.
    { code: 'export const hint = "entries read process.env, libraries do not";' },
  ],
  invalid: [
    {
      code: "// header\n\nexport const url = process.env.DATABASE_URL;\n",
      errors: [{ messageId: "noProcessEnv", line: 3, column: 20 }],
    },
    {
      code: 'export const url = process["env"].DATABASE_URL;',
      errors: [{ messageId: "noProcessEnv", line: 1, column: 20 }],
    },
    {
      // Destructuring off the whole env object is the same read.
      code: "const { DATABASE_URL } = process.env;",
      errors: [{ messageId: "noProcessEnv", line: 1, column: 26 }],
    },
  ],
});
