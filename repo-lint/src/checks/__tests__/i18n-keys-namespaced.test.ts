// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { i18nKeysNamespaced } from "#repo-lint/checks/i18n-keys-namespaced";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * Builds a context over one English catalog.
 * @param body The catalog.
 * @returns A context the check can run against.
 */
function catalog(body: Record<string, unknown>) {
  return fakeContext({ "locales/en.json": JSON.stringify(body) });
}

describe("i18n-keys-namespaced", () => {
  it("passes a catalog whose top level is all namespaces", () => {
    expect(
      i18nKeysNamespaced.run(
        catalog({ common: { cancel: "Cancel" }, canvas: { upload: {} } }),
      ),
    ).toEqual([]);
  });

  it("catches a message sitting at the top level", () => {
    const findings = i18nKeysNamespaced.run(
      catalog({ common: { cancel: "Cancel" }, loading: "Loading…" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("loading");
  });

  it("reports every offending key rather than stopping at the first", () => {
    // A check that reported one at a time would read as "almost clean" on a
    // catalog that is wrong in several places, and each fix would reveal the
    // next — which is how a batch gets abandoned half-done.
    const findings = i18nKeysNamespaced.run(
      catalog({ cancel: "Cancel", loading: "Loading…" }),
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.message).join(" ")).toContain(
      "cancel",
    );
  });

  it("reads every locale, not only the source catalog", () => {
    // The source catalog is not privileged here the way it is for dead keys:
    // a key that exists only in a translation is invisible to every check that
    // reads English alone, so this one reads all five. Fixture deliberately
    // keeps English clean, so a version scanning only `en.json` reports
    // nothing and fails this test.
    const findings = i18nKeysNamespaced.run(
      fakeContext({
        "locales/en.json": JSON.stringify({ common: { cancel: "Cancel" } }),
        "locales/ja.json": JSON.stringify({
          common: { cancel: "キャンセル" },
          loading: "読み込み中...",
        }),
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("locales/ja.json");
  });

  it("catches a top-level value that is neither a namespace nor a message", () => {
    // `null`, a number and an array are all "not an object with messages in
    // it". They are caught by the same assertion rather than by a list of
    // rejected types, because the requirement is what a top-level value must
    // BE, and a rejection list is only ever as long as what someone thought of.
    const findings = i18nKeysNamespaced.run(
      catalog({ common: { cancel: "Cancel" }, broken: null, count: 3, tags: [] }),
    );
    expect(findings).toHaveLength(3);
  });

  it("says nothing about a catalog with no keys at all", () => {
    // Deliberate boundary, not an oversight: an empty catalog breaks no
    // promise this check makes — every key it has does live in a namespace.
    // Whether an empty catalog should fail at all is a different question,
    // owned by the dead-key check's handling of degenerate input.
    expect(i18nKeysNamespaced.run(catalog({}))).toEqual([]);
  });
});
