// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noLibraryLogger } from "../no-library-logger";

const ruleTester = new RuleTester();

ruleTester.run("no-library-logger", noLibraryLogger, {
  valid: [
    // What a library does instead of logging.
    { code: "export function load(): never {\n  throw new Error('unreachable');\n}" },
    // Methods outside the logging set stay allowed — the guard this replaces
    // listed exactly info/warn/error/debug/fatal/trace.
    { code: "declare const logger: { child: (o: object) => void };\nlogger.child({});" },
    // A property named like a level, on something that is not the logger.
    { code: "const result = { error: 'boom' };\nexport const e = result.error;" },
    // Prose in a string.
    { code: 'export const hint = "the route handler calls logger.info, not us";' },
  ],
  invalid: [
    // A scoped, child or injected logger is the shape most likely to appear
    // inside a class or a service. The text guard matched all of these; a
    // rule that only knew the bare identifier let exactly them through.
    {
      filename: "/repo/packages/core/src/a.ts",
      code: `class Service { run() { this.logger.error("x"); } }`,
      errors: [{ messageId: "noLoggerCall" }],
    },
    {
      filename: "/repo/packages/core/src/a.ts",
      code: `function run(deps) { deps.logger.warn("x"); }`,
      errors: [{ messageId: "noLoggerCall" }],
    },
    {
      filename: "/repo/packages/domain/src/a.ts",
      code: `function run(ctx) { ctx.logger.info("x"); }`,
      errors: [{ messageId: "noLoggerCall" }],
    },
    {
      filename: "/repo/packages/shared/src/a.ts",
      code: `childLogger.debug("x");`,
      errors: [{ messageId: "noLoggerCall" }],
    },

    {
      code: "declare const logger: { info: (m: string) => void };\nlogger.info('started');",
      errors: [{ messageId: "noLoggerCall", data: { method: "info" }, line: 2, column: 1 }],
    },
    {
      code: "declare const logger: { error: (e: unknown) => void };\nlogger.error({ err: new Error('x') });",
      errors: [{ messageId: "noLoggerCall", data: { method: "error" }, line: 2, column: 1 }],
    },
    {
      code: "console.log('debugging');",
      errors: [{ messageId: "noConsoleCall", data: { method: "log" }, line: 1, column: 1 }],
    },
    {
      // Any console method counts, not just the common ones.
      code: "console.table([1, 2]);",
      errors: [{ messageId: "noConsoleCall", data: { method: "table" }, line: 1, column: 1 }],
    },
  ],
});
