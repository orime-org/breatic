// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noCjk } from "#repo-lint/checks/no-cjk";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

describe("no-cjk", () => {
  it("passes English source", () => {
    const context = fakeContext({ "packages/core/src/a.ts": "// hello\n" });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("catches Chinese in a comment, not only in a string", () => {
    const context = fakeContext({ "packages/core/src/a.ts": "// 中文注释\n" });
    expect(noCjk.run(context)).toEqual([
      expect.objectContaining({ file: "packages/core/src/a.ts", line: 1 }),
    ]);
  });

  it("catches Japanese and Korean too, not just Chinese", () => {
    const context = fakeContext({
      "packages/core/src/ja.ts": 'const a = "こんにちは";\n',
      "packages/core/src/ko.ts": 'const b = "안녕하세요";\n',
    });
    expect(noCjk.run(context)).toHaveLength(2);
  });

  it("catches fullwidth punctuation, which reads as ASCII but is not", () => {
    const context = fakeContext({ "packages/core/src/a.ts": "const a = 1；\n" });
    expect(noCjk.run(context)).toHaveLength(1);
  });

  it("leaves ordinary typography alone", () => {
    // Em dash, arrows, checkmarks and accents are not the concern; flagging
    // them would make the check noisy enough to be switched off.
    const context = fakeContext({
      "packages/core/src/a.ts": "// a — b → c ✓ café\n",
    });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("names the right line in a multi-line file", async () => {
    const context = fakeContext({
      "packages/core/src/a.ts": "one\ntwo\n// 三\nfour\n",
    });
    const findings = await noCjk.run(context);
    expect(findings[0]?.line).toBe(3);
  });

  it("reaches the repository root, which the shell guard could not", () => {
    // The guard enumerated `find packages`, so a root-level config file was
    // outside every one of its three scan blocks and reported clean by
    // construction. Same for anything under scripts/ that was not .sh.
    const context = fakeContext({
      "eslint.config.ts": "// 探针\n",
      "scripts/thing.mjs": "// 探针\n",
      "packages/core/src/ok.ts": "// fine\n",
    });
    expect(noCjk.run(context)).toHaveLength(2);
  });

  it("scans YAML config and shell scripts", () => {
    const context = fakeContext({
      "config/storage.yaml": "# 注释\n",
      "scripts/thing.sh": "# 注释\n",
    });
    expect(noCjk.run(context)).toHaveLength(2);
  });

  it("skips locale catalogs, tests, vendor and the lockfile", () => {
    const context = fakeContext({
      "locales/zh-CN.json": '{"a":"中文"}',
      "packages/core/src/__tests__/a.test.ts": 'const a = "中文";',
      "packages/core/src/b.test.ts": 'const a = "中文";',
      "packages/web/src/components/ui/x.tsx": 'const a = "中文";',
      "pnpm-lock.yaml": "# 中文",
      "packages/core/src/ok.ts": "// fine\n",
    });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("skips the two allowlisted files", () => {
    const context = fakeContext({
      "packages/web/src/features/preferences/supported-langs.ts":
        'const langs = ["简体中文", "日本語"];',
      "repo-lint/src/checks/product-noun-denylist.ts": 'const deny = ["项目"];',
      "packages/core/src/ok.ts": "// fine\n",
    });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("does not scan documentation — specs are allowed to be Chinese", () => {
    const context = fakeContext({
      "CLAUDE.md": "# 项目简介",
      "packages/core/src/ok.ts": "// fine\n",
    });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it selects no files", () => {
    const context = fakeContext({ "README.md": "hi" });
    expect(() => noCjk.run(context)).toThrow(/matched none/);
  });
});
