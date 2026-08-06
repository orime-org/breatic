// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noNakedFetch } from "../no-naked-fetch";

const ruleTester = new RuleTester();

/**
 * The eight shapes below are not eight arbitrary examples — they are the two
 * ways a caller can reach the platform's `fetch`, enumerated.
 *
 *   - By NAME: the identifier resolves to the global. Calling it is only one
 *     of the things you can then do with it; handing it to something else is
 *     just as much a bare fetch, and is how one actually escapes into a
 *     third-party client.
 *   - By MEMBER: through one of the objects that carries it.
 *
 * A first draft of this rule matched call shapes with a selector
 * (`CallExpression[callee.name='fetch']`). Measured, that caught three of the
 * seven and flagged the eighth — a locally-bound parameter that happens to be
 * named fetch — which is the one case that must NOT be reported. Asking "what
 * does this name resolve to" instead of "what does this line look like" is
 * what makes the last case free rather than a special case.
 */
ruleTester.run("no-naked-fetch", noNakedFetch, {
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
  ],
  invalid: [
    // By name — called.
    {
      code: "export const go = (): Promise<Response> => fetch('https://x');",
      errors: [{ messageId: "nakedFetch", line: 1, column: 44 }],
    },
    // By name — assigned. The call happens later, possibly elsewhere.
    {
      code: "export const f = fetch;",
      errors: [{ messageId: "nakedFetch", line: 1, column: 18 }],
    },
    // By name — handed to a library as a shorthand property. This is the
    // realistic way a bare fetch ends up inside a third-party client.
    {
      code: "declare function lib(o: unknown): void;\nexport const go = (): void => lib({ fetch });",
      errors: [{ messageId: "nakedFetch", line: 2, column: 37 }],
    },
    // By name — handed over as an argument.
    {
      code: "declare function wrap(f: unknown): void;\nexport const go = (): void => wrap(fetch);",
      errors: [{ messageId: "nakedFetch", line: 2, column: 36 }],
    },
    // By member — globalThis.
    {
      code: "export const go = (): Promise<Response> => globalThis.fetch('https://x');",
      errors: [{ messageId: "nakedFetch", line: 1, column: 44 }],
    },
    // By member — window. Reachable in the browser package.
    {
      code: "export const go = (): Promise<Response> => window.fetch('https://x');",
      errors: [{ messageId: "nakedFetch", line: 1, column: 44 }],
    },
    // By member — computed. Reads the same property as the dotted form, so a
    // rule that watched only the dotted one would guard punctuation.
    {
      code: "export const go = (): Promise<Response> => globalThis['fetch']('https://x');",
      errors: [{ messageId: "nakedFetch", line: 1, column: 44 }],
    },
  ],
});
