// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noYjsDocumentsOutsideRepo } from "../no-yjs-documents-outside-repo";

const ruleTester = new RuleTester();

ruleTester.run("no-yjs-documents-outside-repo", noYjsDocumentsOutsideRepo, {
  valid: [
    { code: "import { yjsDocumentsRepo } from '@breatic/core';\nexport const r = yjsDocumentsRepo;" },
    // A longer name that merely contains the token is a different symbol.
    { code: "export const yjsDocumentsRepoCache = new Map();" },
  ],
  invalid: [
    {
      code: "import { yjsDocuments } from '@core/db/yjs-schema';\nexport const t = yjsDocuments;",
      errors: [
        { messageId: "forbiddenToken", data: { token: "yjsDocuments" } },
        { messageId: "forbiddenToken", data: { token: "yjsDocuments" } },
      ],
    },
    {
      code: "export const q = 'SELECT * FROM yjs_documents';",
      errors: [{ messageId: "forbiddenToken", data: { token: "yjs_documents" }, line: 1, column: 18 }],
    },
    {
      code: "declare const sql: (s: TemplateStringsArray) => unknown;\nexport const q = sql`DELETE FROM yjs_documents`;",
      errors: [{ messageId: "forbiddenToken", data: { token: "yjs_documents" } }],
    },
  ],
});
