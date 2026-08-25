// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { docLinkResolves } from "../doc-link-resolves";

const ruleTester = new RuleTester();

ruleTester.run("doc-link-resolves", docLinkResolves, {
  valid: [
    {
      // The target is declared in this file.
      code: `function helper(): void {}\n/** See {@link helper}. */\nexport function x(): void { helper(); }`,
    },
    {
      // The target is imported.
      code: `import { thing } from "@core/thing.js";\n/** See {@link thing}. */\nexport const x = thing;`,
    },
    {
      // A type-only import counts: the name exists in this file's world.
      code: `import type { Shape } from "@shared/shape.js";\n/** Returns a {@link Shape}. */\nexport const x: Shape = 1 as unknown as Shape;`,
    },
    {
      // A qualified name resolves through its first segment.
      code: `import { Model } from "@core/model.js";\n/** See {@link Model.mode}. */\nexport const x = Model;`,
    },
    {
      // A path reference is not a symbol and is left alone.
      code: `/** The transports live in {@link ./transports/}. */\nexport const x = 1;`,
    },
    {
      // Neither is a URL.
      code: `/** Background: {@link https://example.com/spec}. */\nexport const x = 1;`,
    },
    {
      // A local inside a function is still part of this file's world.
      code: `export function outer(): void {\n  function inner(): void {}\n  /** Calls {@link inner}. */\n  inner();\n}`,
    },
    {
      // Backticks are the documented way to name something elsewhere, and
      // are not a link at all.
      code: "/** See `somethingInAnotherPackage`. */\nexport const x = 1;",
    },
  ],
  invalid: [
    {
      // The case the documentation resolver cannot see: a dangling link in
      // the comment of a symbol that is never exported.
      code: `/** Dangling: {@link NoSuchSymbolAnywhere}. */\nfunction hidden(): void {}\nexport const x = hidden;`,
      errors: [{ messageId: "unresolvedLink", data: { name: "NoSuchSymbolAnywhere" } }],
    },
    {
      // On an exported symbol too.
      code: `/** Dangling: {@link GoneLongAgo}. */\nexport function x(): void {}`,
      errors: [{ messageId: "unresolvedLink", data: { name: "GoneLongAgo" } }],
    },
    {
      // A qualified name whose root is gone.
      code: `/** See {@link Vanished.field}. */\nexport const x = 1;`,
      errors: [{ messageId: "unresolvedLink", data: { name: "Vanished" } }],
    },
    {
      // Every dangling link in one comment, not just the first.
      code: `/** {@link OneGone} and {@link TwoGone}. */\nexport const x = 1;`,
      errors: [
        { messageId: "unresolvedLink", data: { name: "OneGone" } },
        { messageId: "unresolvedLink", data: { name: "TwoGone" } },
      ],
    },
    {
      // The alternate spellings count as links.
      code: `/** {@linkcode AlsoGone}. */\nexport const x = 1;`,
      errors: [{ messageId: "unresolvedLink", data: { name: "AlsoGone" } }],
    },
  ],
});
