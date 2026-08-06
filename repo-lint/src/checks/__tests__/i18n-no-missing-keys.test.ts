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
    // `t("server.error")` against `{ error: { not_found: ... } }` resolves to a
    // branch, not a message. Rendering that puts "[object Object]" on screen.
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
