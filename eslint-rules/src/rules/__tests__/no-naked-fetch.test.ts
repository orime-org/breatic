// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noNakedFetch } from "../no-naked-fetch";

const ruleTester = new RuleTester();

ruleTester.run("no-naked-fetch", noNakedFetch, {
  valid: [
    // What every call site does instead.
    {
      code: `import { httpRequest } from "@breatic/shared";\nexport const go = () => httpRequest("https://x.test", {}, { replaySafe: true, timeoutMs: 1, label: "x" });`,
    },
    // An injected implementation is the transport handing its own fetch to a
    // guard — the arrangement this rule protects, not one it should break.
    { code: `export const run = (fetchImpl: typeof fetch) => fetchImpl("https://x.test");` },
    { code: `export const run = (deps: { fetchImpl: typeof fetch }) => deps.fetchImpl("https://x.test");` },
    // Naming a fetch without calling one. This has to stay valid — the
    // transport itself is written this way (`options.fetchImpl ?? fetch`) —
    // and it is also, unavoidably, half of the two-line way around this rule.
    // The other half (calling the binding) is unmatched too; see the rule's
    // own doc comment on why a syntactic rule cannot follow a value.
    { code: `export const impl: typeof fetch = globalThis.fetch;` },
    { code: `export const hint = "call httpRequest, never fetch(url)";` },
    // A method that merely shares the name.
    { code: `declare const repo: { fetch: (id: string) => Promise<void> };\nexport const go = () => repo.fetch("id");` },
  ],
  invalid: [
    {
      filename: "/repo/packages/worker/src/a.ts",
      code: `export const go = () => fetch("https://vendor.test/x");`,
      errors: [{ messageId: "nakedFetch" }],
    },
    // The explicit global forms are the same call with more typing, and a
    // guard that only knew the bare identifier would wave them through.
    {
      filename: "/repo/packages/web/src/a.ts",
      code: `export const go = () => globalThis.fetch("https://vendor.test/x");`,
      errors: [{ messageId: "nakedFetch" }],
    },
    {
      filename: "/repo/packages/web/src/a.ts",
      code: `export const go = () => window.fetch("https://vendor.test/x");`,
      errors: [{ messageId: "nakedFetch" }],
    },
    {
      filename: "/repo/packages/core/src/a.ts",
      code: `export const go = () => global.fetch("https://vendor.test/x");`,
      errors: [{ messageId: "nakedFetch" }],
    },
    // Awaited, inside a method — the shape the two survivors actually had.
    {
      filename: "/repo/packages/web/src/data/api/assets.ts",
      code: `export const api = { async put(url: string, file: Blob) { const res = await fetch(url, { method: "PUT", body: file }); return res.ok; } };`,
      errors: [{ messageId: "nakedFetch" }],
    },
  ],
});
