// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noRelativeImport } from "../no-relative-import";

const ruleTester = new RuleTester();

const core = "/repo/packages/core/src/infra/thing.ts";
const web = "/repo/packages/web/src/spaces/canvas/Thing.tsx";

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
      filename: core,
      code: `import { helper } from "./helper";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `import { helper } from "@core/infra/helper";`,
    },
    {
      filename: core,
      code: `import { helper } from "../lib/helper";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `import { helper } from "@core/lib/helper";`,
    },
    {
      filename: core,
      code: `export { helper } from "./helper";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `export { helper } from "@core/infra/helper";`,
    },
    {
      filename: core,
      code: `export * from "../lib/helper";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `export * from "@core/lib/helper";`,
    },
    {
      filename: core,
      code: `import "./side-effect";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `import "@core/infra/side-effect";`,
    },
    {
      filename: core,
      code: `import type { T } from "./types";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `import type { T } from "@core/infra/types";`,
    },
    // The text guard read `from "..."` only, so these two were invisible.
    {
      filename: core,
      code: `const m = await import("./lazy");`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `const m = await import("@core/infra/lazy");`,
    },
    {
      filename: core,
      code: `const m = require("../legacy");`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `const m = require("@core/legacy");`,
    },
    // The message names the one alias this file should use, not all seven.
    {
      filename: core,
      code: `import { x } from "./y";`,
      errors: [
        {
          messageId: "noRelativeImport",
          data: { specifier: "./y", alias: "@core/*" },
        },
      ],
      output: `import { x } from "@core/infra/y";`,
    },
    {
      // web writes single quotes; the fix must not flip the file's style.
      filename: web,
      code: `import { x } from '../../lib/y';`,
      errors: [
        {
          messageId: "noRelativeImport",
          data: { specifier: "../../lib/y", alias: "@web/*" },
        },
      ],
      output: `import { x } from '@web/lib/y';`,
    },
    // Nested climbing resolves to the same file the relative path named.
    {
      filename: "/repo/packages/web/src/a/b/c/Deep.tsx",
      code: `import { x } from "../../d/e";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `import { x } from "@web/a/d/e";`,
    },
    // This package aliases itself through a Node subpath import, not tsconfig.
    {
      filename: "/repo/eslint-rules/src/rules/thing.ts",
      code: `import { createRule } from "../create-rule";`,
      errors: [
        {
          messageId: "noRelativeImport",
          data: { specifier: "../create-rule", alias: "#rules/*" },
        },
      ],
      output: `import { createRule } from "#rules/create-rule";`,
    },
    // Bare directory specifiers: relative, and the text guard needed a slash.
    {
      filename: core,
      code: `import { x } from ".";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `import { x } from "@core/infra";`,
    },
    {
      filename: core,
      code: `import { x } from "..";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: `import { x } from "@core";`,
    },
    // Climbing out of the package root is a cross-package import: still a
    // violation, but no alias names it, so it is reported without a fix.
    {
      filename: core,
      code: `import { x } from "../../../shared/src/y";`,
      errors: [{ messageId: "noRelativeImport" }],
      output: null,
    },
    // Outside every known root: reported, with the generic message, no fix.
    {
      filename: "/somewhere/else/file.ts",
      code: `import { x } from "./y";`,
      errors: [
        {
          messageId: "noRelativeImport",
          data: { specifier: "./y", alias: "the package's alias" },
        },
      ],
      output: null,
    },
  ],
});
