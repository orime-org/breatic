// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { singleToastEntry } from "../single-toast-entry";

const ruleTester = new RuleTester();

ruleTester.run("single-toast-entry", singleToastEntry, {
  valid: [
    { code: "import { toast } from '@web/lib/toast';\ntoast.error('boom');" },
    // A module whose name merely starts with the banned one.
    { code: "import x from 'sonner-extras';\nexport const y = x;" },
  ],
  invalid: [
    {
      code: "import { toast } from 'sonner';\ntoast('untyped');",
      errors: [{ messageId: "directSonnerImport", line: 1, column: 1 }],
    },
    {
      // Double quotes — the text guard this replaces only matched single
      // quotes, so this form went unchecked.
      code: 'import { toast } from "sonner";',
      errors: [{ messageId: "directSonnerImport", line: 1, column: 1 }],
    },
    {
      // Re-exporting is how one routes around a wrapper: every consumer then
      // imports from a module of ours and still gets the untyped toast. The
      // text guard this replaced caught it; a rule watching only
      // ImportDeclaration does not.
      code: "export { toast } from 'sonner';",
      errors: [{ messageId: "directSonnerImport", line: 1, column: 1 }],
    },
    {
      code: "export * from 'sonner';",
      errors: [{ messageId: "directSonnerImport", line: 1, column: 1 }],
    },
    {
      code: "const { toast } = await import('sonner');",
      errors: [{ messageId: "directSonnerImport", line: 1, column: 25 }],
    },
  ],
});
