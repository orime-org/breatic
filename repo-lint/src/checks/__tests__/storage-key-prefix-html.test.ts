// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { storageKeyPrefixHtml } from "#repo-lint/checks/storage-key-prefix-html";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

const html = "packages/web/src/index.html";

describe("storage-key-prefix-html", () => {
  it("passes a prefixed key", () => {
    const context = fakeContext({
      [html]: `<script>var raw = localStorage.getItem('breatic.preferences');</script>`,
    });
    expect(storageKeyPrefixHtml.run(context)).toEqual([]);
  });

  it("catches a bare key in the inline script", () => {
    const context = fakeContext({
      [html]: `<script>var raw = localStorage.getItem('preferences');</script>`,
    });
    const findings = storageKeyPrefixHtml.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("'preferences'");
  });

  it("catches every keyed method and both stores", () => {
    const context = fakeContext({
      [html]: [
        `localStorage.getItem("a");`,
        `sessionStorage.setItem("b", 1);`,
        `localStorage.removeItem("c");`,
      ].join("\n"),
    });
    expect(storageKeyPrefixHtml.run(context)).toHaveLength(3);
  });

  it("names the right line", () => {
    const context = fakeContext({
      [html]: `one\ntwo\nlocalStorage.getItem("bare");\n`,
    });
    expect(storageKeyPrefixHtml.run(context)[0]?.line).toBe(3);
  });

  it("reports both accesses when two share a line", () => {
    const context = fakeContext({
      [html]: `localStorage.getItem("a"); localStorage.getItem("b");`,
    });
    expect(storageKeyPrefixHtml.run(context)).toHaveLength(2);
  });

  it("ignores a key written in a script comment", () => {
    const context = fakeContext({
      [html]: `// localStorage.getItem('bare') was here\nvar x = 1;`,
    });
    expect(storageKeyPrefixHtml.run(context)).toEqual([]);
  });

  it("ignores a call that passes a variable", () => {
    const context = fakeContext({
      [html]: `localStorage.getItem(KEY);`,
    });
    expect(storageKeyPrefixHtml.run(context)).toEqual([]);
  });

  it("ignores HTML outside the web package", () => {
    const context = fakeContext({
      "docs/example.html": `localStorage.getItem("bare");`,
      [html]: `var x = 1;`,
    });
    expect(storageKeyPrefixHtml.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it finds no HTML", () => {
    expect(() => storageKeyPrefixHtml.run(fakeContext({ "a.ts": "x" }))).toThrow(
      /matched none/,
    );
  });
});
