// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import globals from "globals";
import { noNakedFetch } from "../no-naked-fetch";

/**
 * The shapes below are not arbitrary examples — they are the two ways a caller
 * can reach the platform's `fetch`, enumerated.
 *
 *   - By NAME: the identifier resolves to the global. Calling it is only one
 *     of the things you can then do with it; handing it to something else is
 *     just as much a bare fetch, and is how one actually escapes into a
 *     third-party client.
 *   - By MEMBER: through one of the objects that carries it. There are three
 *     such carriers, and all three are exercised — a set with two of its
 *     members covered is a gap, not a limit.
 *
 * A first draft of this rule matched call shapes with a selector
 * (`CallExpression[callee.name='fetch']`). Measured, it caught the ones that
 * call `fetch` on the spot and missed every form that hands it to something
 * else, while flagging a locally-bound parameter that happens to be named
 * fetch — the one case that must NOT be reported. Asking "what does this name
 * resolve to" instead of "what does this line look like" is what makes the
 * last case free rather than a special case.
 *
 * Counts deliberately stay out of this comment. An earlier version said "three
 * of the seven", and adding one case made it false; the list below is the
 * count, and it cannot drift from itself.
 */
const CASES = {
  valid: [
    // The sanctioned route.
    {
      code: "import { httpRequest } from '@breatic/shared';\nexport const go = () => httpRequest('https://x', {}, { replaySafe: true });",
    },
    // A parameter named fetch is not the global. This is the case a
    // shape-matching selector gets wrong.
    {
      code: "export function h(fetch: (u: string) => Promise<Response>): Promise<Response> {\n  return fetch('https://x');\n}",
    },
    // A local binding shadows the global for the rest of the scope.
    {
      code: "export function h(impl: (u: string) => Promise<Response>): Promise<Response> {\n  const fetch = impl;\n  return fetch('https://x');\n}",
    },
    // A property KEY named fetch is a name in an object, not a reference to
    // the global — the value beside it is what would be.
    {
      code: "declare const myImpl: unknown;\nexport const adapter = { fetch: myImpl };",
    },
    // Some other object's method that happens to share the name.
    {
      code: "declare const client: { fetch: (u: string) => Promise<Response> };\nexport const go = (): Promise<Response> => client.fetch('https://x');",
    },
    // TYPE POSITIONS. Everything below is erased before anything runs and
    // cannot send a request, so reporting it would be the guard refusing a
    // spelling rather than an action. The rule tells them apart by the
    // identifier's syntactic parent, against a five-entry set copied from
    // ESLint's own no-restricted-globals — the scope analyser cannot help
    // here, because `typeof fetch` reports `isValueReference === true` just
    // like a real call does.
    //
    // There is one case per entry in that set, and that is the point of the
    // three below that do not typecheck: without them, four of the five
    // entries could be deleted with the whole suite still green, which is the
    // same half-guarded state this file was rewritten to end. Which spellings
    // the compiler happens to reject today is not what pins the set — the set
    // is upstream's answer to "what counts as a type position", and each
    // entry needs something that goes red when it is dropped.
    {
      // TSTypeQuery.
      code: "export type Injected = typeof fetch;",
    },
    {
      // TSTypeQuery, in a parameter annotation.
      code: "export function h(impl: typeof fetch): void {\n  void impl;\n}",
    },
    {
      // TSQualifiedName — a dotted `typeof` query. This one is legal
      // TypeScript that anybody can write today: `tsc --strict` accepts it
      // with zero errors.
      code: "export type FetchName = typeof fetch.name;",
    },
    {
      // TSTypeReference. `fetch` is a value, so tsc rejects this with TS2749;
      // the parser still produces the node, and the entry still needs a case.
      code: "declare const x: fetch;\nexport const y = x;",
    },
    {
      // TSInterfaceHeritage. Also TS2749.
      code: "export interface I extends fetch {}",
    },
    {
      // TSClassImplements. Also TS2749.
      code: "export class C implements fetch {}",
    },
  ],
  invalid: [
    // By name — called.
    {
      code: "export const go = (): Promise<Response> => fetch('https://x');",
      errors: [{ messageId: "nakedFetch" as const, line: 1, column: 44 }],
    },
    // By name — assigned. The call happens later, possibly elsewhere.
    {
      code: "export const f = fetch;",
      errors: [{ messageId: "nakedFetch" as const, line: 1, column: 18 }],
    },
    // By name — handed to a library as a shorthand property. This is the
    // realistic way a bare fetch ends up inside a third-party client.
    {
      code: "declare function lib(o: unknown): void;\nexport const go = (): void => lib({ fetch });",
      errors: [{ messageId: "nakedFetch" as const, line: 2, column: 37 }],
    },
    // By name — handed over as an argument.
    {
      code: "declare function wrap(f: unknown): void;\nexport const go = (): void => wrap(fetch);",
      errors: [{ messageId: "nakedFetch" as const, line: 2, column: 36 }],
    },
    // By member — globalThis.
    {
      code: "export const go = (): Promise<Response> => globalThis.fetch('https://x');",
      errors: [{ messageId: "nakedFetch" as const, line: 1, column: 44 }],
    },
    // By member — window. Reachable in the browser package.
    {
      code: "export const go = (): Promise<Response> => window.fetch('https://x');",
      errors: [{ messageId: "nakedFetch" as const, line: 1, column: 44 }],
    },
    // By member — self. The third carrier, and the one a worker-style file
    // reaches for. Leaving it untested let the whole carrier be deleted with
    // a green suite.
    {
      code: "export const go = (): Promise<Response> => self.fetch('https://x');",
      errors: [{ messageId: "nakedFetch" as const, line: 1, column: 44 }],
    },
    // By member — computed. Reads the same property as the dotted form, so a
    // rule that watched only the dotted one would guard punctuation.
    {
      code: "export const go = (): Promise<Response> => globalThis['fetch']('https://x');",
      errors: [{ messageId: "nakedFetch" as const, line: 1, column: 44 }],
    },
  ],
};

/**
 * Which global environment the file being linted declares.
 *
 * This is not a thoroughness flourish — it decides which half of the rule
 * runs. When the config names an environment, `fetch` is a declared global and
 * its uses hang off `scope.variables`; when it names none, the same uses stay
 * unresolved in `scope.through`. A suite that only ever ran the second one
 * passed in full against a rule with the first half deleted, while the shipped
 * config reported nothing. So every environment the repo actually lints under
 * gets the whole case list, and the environment nobody configures is kept too,
 * because it is the branch that would otherwise go unpinned.
 *
 * `globals.node` covers the six backend packages (root `eslint.config.ts`);
 * `globals.browser` covers `packages/web/src` (its own flat config).
 */
const ENVIRONMENTS: ReadonlyArray<{
  name: string;
  globals: Record<string, boolean | "readonly" | "writable" | "off">;
}> = [
  { name: "no environment declared", globals: {} },
  { name: "globals.node, the six backend packages", globals: globals.node },
  { name: "globals.browser, the web package", globals: globals.browser },
];

for (const environment of ENVIRONMENTS) {
  const ruleTester = new RuleTester({
    languageOptions: { globals: environment.globals },
  });
  ruleTester.run(`no-naked-fetch (${environment.name})`, noNakedFetch, CASES);
}

/**
 * The one case the module-mode list above structurally cannot reach.
 *
 * `reportGlobalFetchReferences` skips global variables that carry a definition
 * site, because a name someone declared in source is theirs and not the
 * platform's. Every shadowing case above is a LOCAL binding, which never enters
 * the global scope at all, so none of them exercise that check — measured, it
 * can be deleted with the rest of the suite still green, and deleting it makes
 * the rule report a caller's own `fetch` twice.
 *
 * Reaching it needs a top-level declaration that lands in the global scope,
 * which in turn needs script mode: under `sourceType: 'module'` a top-level
 * `var` belongs to the module, not to the world.
 *
 * No file this rule currently governs is linted as a script — the root config
 * names no sourceType, and web's script block covers `**\/*.cjs`, which its
 * `src/**\/*.{ts,tsx}` glob cannot intersect. The case is here anyway: "no
 * configured file reaches it today" is a fact about the config, and a guard
 * whose removal is invisible is exactly the state this file was rewritten to
 * end.
 */
const scriptModeTester = new RuleTester({
  languageOptions: {
    // It has to go in `parserOptions`, not beside `globals`. RuleTester merges
    // `sourceType: 'module'` into parserOptions itself, and parserOptions wins
    // — setting the top-level field instead leaves every case below running as
    // a module, where the guard this block exists for is unreachable and the
    // block silently proves nothing.
    parserOptions: { sourceType: "script" },
    globals: { fetch: "readonly" },
  },
});

scriptModeTester.run("no-naked-fetch (script mode, global scope)", noNakedFetch, {
  valid: [
    {
      // A top-level `var fetch` in script mode IS a global variable, but one
      // with a definition site. It is the caller's own function.
      code: 'var fetch = function (u) { return u; };\nfetch("https://x");',
    },
  ],
  invalid: [
    {
      // Same environment, no declaration: still the platform's.
      code: 'fetch("https://x");',
      errors: [{ messageId: "nakedFetch" as const, line: 1, column: 1 }],
    },
  ],
});
