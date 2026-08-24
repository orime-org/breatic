// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noCollabAuthPrimitives } from "../no-collab-auth-primitives";

const ruleTester = new RuleTester();

ruleTester.run("no-collab-auth-primitives", noCollabAuthPrimitives, {
  valid: [
    // The sanctioned route: core owns the decision.
    {
      code: "import { getSession } from '@breatic/core';\nexport const s = getSession;",
    },
    // Other Redis keys are collab's own business.
    { code: "export const key = 'collab:doc:123';" },
  ],
  invalid: [
    {
      code: "export const q = 'SELECT * FROM project_members';",
      errors: [{ messageId: "forbiddenToken", data: { token: "project_members" }, line: 1, column: 18 }],
    },
    {
      // The session key prefix — punctuation on both ends, so no word
      // boundary applies and it matches as written.
      code: "export const key = `breatic:session:${'abc'}`;",
      errors: [{ messageId: "forbiddenToken", data: { token: ":session:" } }],
    },
  ],
});
