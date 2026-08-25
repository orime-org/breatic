// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { noTranslatedProductNoun } from "#repo-lint/checks/no-translated-product-noun";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * Wraps a catalog body so every case reads as one locale file.
 * @param body The catalog object.
 * @returns A context over that one catalog.
 */
function catalog(body: Record<string, unknown>) {
  return fakeContext({ "locales/zh-CN.json": JSON.stringify(body) });
}

describe("no-translated-product-noun", () => {
  it("passes a catalog that keeps the noun in English", () => {
    expect(
      noTranslatedProductNoun.run(catalog({ title: "新建 Project" })),
    ).toEqual([]);
  });

  it("catches a translated noun inside a sentence", async () => {
    const findings = await noTranslatedProductNoun.run(
      catalog({ project: { title: "新建项目" } }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("project.title");
    expect(findings[0]?.message).toContain("Project");
  });

  it("catches every language's form, not only Simplified Chinese", () => {
    const context = fakeContext({
      "locales/zh-TW.json": JSON.stringify({ a: "專案" }),
      "locales/ja.json": JSON.stringify({ a: "プロジェクト" }),
      "locales/ko.json": JSON.stringify({ a: "프로젝트" }),
    });
    expect(noTranslatedProductNoun.run(context)).toHaveLength(3);
  });

  it("reads leaf strings only, never key names", () => {
    // A key called 项目 would be odd but is not a user-facing string, and
    // treating it as one would report a violation nobody can act on.
    expect(noTranslatedProductNoun.run(catalog({ 项目: "Project" }))).toEqual(
      [],
    );
  });

  it("descends into nested groups", async () => {
    const findings = await noTranslatedProductNoun.run(
      catalog({ a: { b: { c: "工作室" } } }),
    );
    expect(findings[0]?.message).toContain("a.b.c");
  });

  it("leaves the collision forms alone — they are frozen per key elsewhere", () => {
    // Canvas's form is also the drawing surface and Timeline's is also the
    // video track, so neither can be banned outright. The web package's
    // frozen-product-terms test pins those by key instead.
    expect(
      noTranslatedProductNoun.run(catalog({ a: "画布", b: "时间轴" })),
    ).toEqual([]);
  });

  it("does not scan the English source catalog", () => {
    const context = fakeContext({
      "locales/en.json": JSON.stringify({ a: "Project" }),
      "locales/zh-CN.json": JSON.stringify({ a: "Project" }),
    });
    expect(noTranslatedProductNoun.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it finds no catalogs", () => {
    const context = fakeContext({ "packages/core/src/a.ts": "x" });
    expect(() => noTranslatedProductNoun.run(context)).toThrow(/matched none/);
  });
});
