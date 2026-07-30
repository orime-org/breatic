// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noRelativeImport } from "../no-relative-import";

const ruleTester = new RuleTester();

ruleTester.run("no-relative-import", noRelativeImport, {
  valid: [
    { code: `import { db } from "@core/db";` },
    { code: `import { thing } from "@shared/types";` },
    { code: `import postgres from "postgres";` },
    { code: `export { x } from "@domain/asset";` },
    { code: `const m = await import("@worker/handlers");` },
    // A package whose name merely begins with a dot-free prefix.
    { code: `import x from "dotenv";` },
    // No specifier at all — must not throw.
    { code: `const x = 1; export { x };` },
  ],
  invalid: [
    {
      code: `import { helper } from "./helper";`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    {
      code: `import { helper } from "../lib/helper";`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    {
      code: `export { helper } from "./helper";`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    {
      code: `export * from "../lib/helper";`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    {
      code: `import "./side-effect";`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    {
      code: `import type { T } from "./types";`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    // The guard read `from "..."` text only, so these two were invisible.
    {
      code: `const m = await import("./lazy");`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    {
      code: `const m = require("../legacy");`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    // The message names the one alias this file should use, not all seven.
    {
      filename: "/repo/packages/core/src/infra/thing.ts",
      code: `import { x } from "./y";`,
      errors: [
        {
          messageId: "noRelativeImport",
          data: { specifier: "./y", alias: "@core/*" },
        },
      ],
    },
    {
      filename: "/repo/packages/web/src/spaces/canvas/thing.tsx",
      code: `import { x } from "../y";`,
      errors: [
        {
          messageId: "noRelativeImport",
          data: { specifier: "../y", alias: "@web/*" },
        },
      ],
    },
    // Bare directory specifiers: relative, and the guard's regex needed a slash.
    {
      code: `import { x } from ".";`,
      errors: [{ messageId: "noRelativeImport" }],
    },
    {
      code: `import { x } from "..";`,
      errors: [{ messageId: "noRelativeImport" }],
    },
  ],
});
