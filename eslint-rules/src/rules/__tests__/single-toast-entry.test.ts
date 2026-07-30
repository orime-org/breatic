// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";
import { singleToastEntry } from "../single-toast-entry";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

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
  ],
});
