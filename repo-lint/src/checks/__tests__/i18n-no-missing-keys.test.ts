// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { i18nNoMissingKeys } from "#repo-lint/checks/i18n-no-missing-keys";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * Builds a context over one catalog plus the sources that ask it for messages.
 * @param body The English catalog.
 * @param sources Repo-relative path to contents, for everything else.
 * @returns A context the check can run against.
 */
function repo(body: Record<string, unknown>, sources: Record<string, string>) {
  return fakeContext({ "locales/en.json": JSON.stringify(body), ...sources });
}

describe("i18n-no-missing-keys", () => {
  it("passes a key the catalog answers", () => {
    expect(
      i18nNoMissingKeys.run(
        repo(
          { server: { error: { not_found: "Not found" } } },
          { "packages/server/src/a.ts": 't("server.error.not_found")' },
        ),
      ),
    ).toEqual([]);
  });

  it("catches a key the catalog has no answer for", () => {
    // The shape this check exists for: `notFound` where the catalog says
    // `not_found`. Nothing rejects it, so the id reaches the user as text.
    const findings = i18nNoMissingKeys.run(
      repo(
        { server: { error: { not_found: "Not found" } } },
        { "packages/server/src/a.ts": 't("server.error.notFound")' },
      ),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("packages/server/src/a.ts");
    expect(findings[0]?.message).toContain("server.error.notFound");
  });

  it("reads single quotes as well as double", () => {
    expect(
      i18nNoMissingKeys.run(
        repo({ a: { b: "B" } }, { "packages/web/src/a.tsx": "t('a.missing')" }),
      ),
    ).toHaveLength(1);
  });

  it("reads a backtick literal, which is a literal like any other", () => {
    // A key in backticks with nothing interpolated is spelled out as fully as
    // one in quotes. `packages/web` forbids the form by lint, `packages/server`
    // does not — and server is where the typo this check exists for shipped.
    expect(
      i18nNoMissingKeys.run(
        repo(
          { server: { error: { not_found: "Not found" } } },
          { "packages/server/src/a.ts": "t(`server.error.notFound`)" },
        ),
      ),
    ).toHaveLength(1);
  });

  it("says nothing about an interpolated id", () => {
    // `t(`a.${kind}`)` names no key in full, so this check cannot tell whether
    // the catalog answers it. Silence here is a stated limit, not coverage —
    // the sibling dead-key check is the one that reasons about prefixes.
    expect(
      i18nNoMissingKeys.run(
        repo({ a: { b: "B" } }, { "packages/web/src/a.tsx": "t(`a.${kind}`)" }),
      ),
    ).toEqual([]);
  });

  it("says nothing about a key handed in through a variable", () => {
    // The other half of the same limit, and the larger half: the key here IS
    // written out, in a lookup table, and still cannot be seen — the match
    // needs the literal inside the call. BellMenu.tsx does exactly this with
    // two role tables. Pinned so the limit is a measured behaviour rather than
    // a sentence in a docstring; widening the match must turn this case red.
    expect(
      i18nNoMissingKeys.run(
        repo(
          { a: { b: "B" } },
          {
            "packages/web/src/a.tsx": [
              'const KEYS = { one: "a.missingOne" };',
              "t(KEYS[kind])",
            ].join("\n"),
          },
        ),
      ),
    ).toEqual([]);
  });

  it("says nothing about a literal glued to something else", () => {
    // `t('a.b' + suffix)` writes a PREFIX, not a key. Matching it and stopping
    // at the closing quote reports the namespace as a missing message: a false
    // finding, against a call whose real key this check cannot know. It has to
    // be silent here for the same reason it is silent on a variable — the key
    // is not written out — so the literal must be the whole argument.
    expect(
      i18nNoMissingKeys.run(
        repo(
          { a: { b: { c: "C" } } },
          { "packages/web/src/a.tsx": "t('a.b' + suffix)" },
        ),
      ),
    ).toEqual([]);
  });

  it("ignores a dotted string that is not asked of the catalog", () => {
    // Only the argument of a `t(...)` call counts. Plenty of dotted literals
    // are file paths, property chains or ids, and reporting those would make
    // the check unusable.
    expect(
      i18nNoMissingKeys.run(
        repo(
          { a: { b: "B" } },
          { "packages/web/src/a.tsx": 'import x from "./some.module.css"' },
        ),
      ),
    ).toEqual([]);
  });

  it("does not read test material", () => {
    // A test may name a key on purpose to prove it is absent — the removed-key
    // tombstone list does exactly that. Reading tests would turn every such
    // assertion into a finding.
    //
    // A live source sits alongside it deliberately. The context throws when a
    // selection matches nothing, so a repo of tests alone would pass this case
    // by never running the scan — which is the failure it is meant to exclude.
    expect(
      i18nNoMissingKeys.run(
        repo(
          { a: { b: "B" } },
          {
            "packages/web/src/a.tsx": 't("a.b")',
            "packages/web/src/__tests__/a.test.ts": 't("a.deliberatelyGone")',
          },
        ),
      ),
    ).toEqual([]);
  });

  it("does not read a key that only a comment names", () => {
    // Measured: the first repo-wide run reported two keys from a docstring
    // showing callers how the hook is used, one of them about a shopping cart
    // this product does not have. A key in a comment renders nothing.
    expect(
      i18nNoMissingKeys.run(
        repo({ a: { b: "B" } }, {
          "packages/web/src/a.tsx": [
            "/**",
            ' * Usage: t("cart.items") returns the label.',
            " */",
            't("a.b")',
          ].join("\n"),
        }),
      ),
    ).toEqual([]);
  });

  it("reports every miss, not just the first", () => {
    const findings = i18nNoMissingKeys.run(
      repo(
        { a: { b: "B" } },
        {
          "packages/server/src/a.ts": 't("a.one")',
          "packages/web/src/b.tsx": 't("a.two")',
        },
      ),
    );
    expect(findings).toHaveLength(2);
  });

  it("treats a key whose value is an object as unanswered", () => {
    // `t("server.error")` against `{ error: { not_found: ... } }` lands on a
    // branch, not a message. `resolveKey` returns a string or nothing
    // (shared/src/i18n/index.ts:180), so `t` falls through to `return key` and
    // the user reads `server.error` — the same symptom as a key that is simply
    // absent, which is why it is the same finding.
    expect(
      i18nNoMissingKeys.run(
        repo(
          { server: { error: { not_found: "Not found" } } },
          { "packages/server/src/a.ts": 't("server.error")' },
        ),
      ),
    ).toHaveLength(1);
  });
});
