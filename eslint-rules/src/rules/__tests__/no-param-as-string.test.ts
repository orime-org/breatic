// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noParamAsString } from "../no-param-as-string";

const ruleTester = new RuleTester();

ruleTester.run("no-param-as-string", noParamAsString, {
  valid: [
    // Validated rather than asserted.
    {
      code: "declare const c: { req: { param: (n: string) => string | undefined } };\nconst id = c.req.param('id');\nif (!id) throw new Error('missing id');",
    },
    // A different method that happens to be asserted.
    {
      code: "declare const c: { req: { query: (n: string) => string } };\nexport const q = c.req.query('q') as string;",
    },
    // Asserting to an array type is a different shape; the guard this
    // replaces excluded `as string[]` explicitly.
    {
      code: "declare const c: { req: { param: (n: string) => unknown } };\nexport const ids = c.req.param('ids') as string[];",
    },
  ],
  invalid: [
    {
      code: "declare const c: { req: { param: (n: string) => string | undefined } };\nexport const id = c.req.param('id') as string;",
      errors: [{ messageId: "noParamAssertion", line: 2, column: 19 }],
    },
    {
      // Shorthand where the request object is destructured first.
      code: "declare const req: { param: (n: string) => string | undefined };\nexport const id = req.param('id') as string;",
      errors: [{ messageId: "noParamAssertion", line: 2, column: 19 }],
    },
  ],
});
