// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { storageKeyPrefixHtml } from "#repo-lint/checks/storage-key-prefix-html";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** The registry the check reads the prefix out of. */
const REGISTRY = "packages/web/src/lib/storage-keys.ts";

/** Its contents, as far as the check parses them. */
const REGISTRY_SOURCE = "export const STORAGE_PREFIX = 'breatic.';\n";

/**
 * Builds a context holding the registry plus the given files.
 * @param files Repo-relative path to contents.
 * @returns A context the check can read a prefix from.
 */
function withRegistry(files: Record<string, string>) {
  return fakeContext({ [REGISTRY]: REGISTRY_SOURCE, ...files });
}

const html = "packages/web/src/index.html";

describe("storage-key-prefix-html", () => {
  it("passes a prefixed key", () => {
    const context = withRegistry({
      [html]: `<script>var raw = localStorage.getItem('breatic.preferences');</script>`,
    });
    expect(storageKeyPrefixHtml.run(context)).toEqual([]);
  });

  it("catches a bare key in the inline script", () => {
    const context = withRegistry({
      [html]: `<script>var raw = localStorage.getItem('preferences');</script>`,
    });
    const findings = storageKeyPrefixHtml.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("'preferences'");
  });

  it("catches every keyed method and both stores", () => {
    const context = withRegistry({
      [html]: [
        `localStorage.getItem("a");`,
        `sessionStorage.setItem("b", 1);`,
        `localStorage.removeItem("c");`,
      ].join("\n"),
    });
    expect(storageKeyPrefixHtml.run(context)).toHaveLength(3);
  });

  it("names the right line", () => {
    const context = withRegistry({
      [html]: `one\ntwo\nlocalStorage.getItem("bare");\n`,
    });
    expect(storageKeyPrefixHtml.run(context)[0]?.line).toBe(3);
  });

  it("reports both accesses when two share a line", () => {
    const context = withRegistry({
      [html]: `localStorage.getItem("a"); localStorage.getItem("b");`,
    });
    expect(storageKeyPrefixHtml.run(context)).toHaveLength(2);
  });

  it("ignores a key written in a script comment", () => {
    const context = withRegistry({
      [html]: `// localStorage.getItem('bare') was here\nvar x = 1;`,
    });
    expect(storageKeyPrefixHtml.run(context)).toEqual([]);
  });

  it("ignores a call that passes a variable", () => {
    const context = withRegistry({
      [html]: `localStorage.getItem(KEY);`,
    });
    expect(storageKeyPrefixHtml.run(context)).toEqual([]);
  });

  it("ignores HTML outside the web package", () => {
    const context = withRegistry({
      "docs/example.html": `localStorage.getItem("bare");`,
      [html]: `var x = 1;`,
    });
    expect(storageKeyPrefixHtml.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it finds no HTML", () => {
    expect(() => storageKeyPrefixHtml.run(withRegistry({ "a.ts": "x" }))).toThrow(
      /matched none/,
    );
  });

  it("fails rather than reports clean when the registry is gone", () => {
    // The prefix is read from the product rather than restated here, so a
    // registry that moved leaves the check with nothing to enforce. That
    // has to be a failure: enforcing an empty prefix would pass every key.
    const context = fakeContext({ "packages/web/src/index.html": "<html></html>" });
    expect(() => storageKeyPrefixHtml.run(context)).toThrow(/storage-keys\.ts/);
  });

  it("fails rather than reports clean when the registry stops declaring it", () => {
    const context = fakeContext({
      [REGISTRY]: "export const KEYS = {};\n",
      "packages/web/src/index.html": "<html></html>",
    });
    expect(() => storageKeyPrefixHtml.run(context)).toThrow(/STORAGE_PREFIX/);
  });

  it("enforces whatever prefix the registry declares, not a copy of it", () => {
    // The point of reading it: change the product's prefix and the check
    // follows, rather than passing while checking a string nothing uses.
    const context = fakeContext({
      [REGISTRY]: "export const STORAGE_PREFIX = 'orime.';\n",
      "packages/web/src/index.html":
        "<script>localStorage.getItem('breatic.preferences')</script>",
    });
    expect(storageKeyPrefixHtml.run(context)).toHaveLength(1);
  });
});
