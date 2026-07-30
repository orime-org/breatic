// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noSyncInRequestPath } from "../no-sync-in-request-path";

const ruleTester = new RuleTester();

ruleTester.run("no-sync-in-request-path", noSyncInRequestPath, {
  valid: [
    // The promise-based counterpart.
    {
      code: "import { readFile } from 'node:fs/promises';\nexport const read = (p: string): Promise<Buffer> => readFile(p);",
    },
    // A method whose name merely ends in Sync but is not on the list.
    {
      code: "declare const clock: { tickSync: () => void };\nclock.tickSync();",
    },
    // The name inside a string.
    { code: 'export const hint = "readFileSync blocks the loop";' },
  ],
  invalid: [
    {
      code: "import { readFileSync } from 'node:fs';\nexport const raw = readFileSync('/etc/hosts');",
      errors: [
        { messageId: "noSyncCall", data: { name: "readFileSync" }, line: 2, column: 20 },
      ],
    },
    {
      // Namespace form.
      code: "import fs from 'node:fs';\nexport const raw = fs.existsSync('/tmp');",
      errors: [
        { messageId: "noSyncCall", data: { name: "existsSync" }, line: 2, column: 20 },
      ],
    },
    {
      // Process spawning blocks just as hard as disk access.
      code: "import { execSync } from 'node:child_process';\nexport const out = execSync('ls');",
      errors: [
        { messageId: "noSyncCall", data: { name: "execSync" }, line: 2, column: 20 },
      ],
    },
  ],
});
