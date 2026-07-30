// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noCjk } from "#repo-lint/checks/no-cjk";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/** The files the allowlist names, which must exist for it to be live. */
const ALLOWLISTED = {
  "packages/web/src/features/preferences/supported-langs.ts": "export const langs = [];\n",
  "repo-lint/src/product-noun-denylist.ts": "export const DENIED = [];\n",
};

/**
 * Builds a context holding the allowlisted files plus the given ones.
 *
 * The check refuses to run against a tree where an exemption points at
 * nothing, so every case has to bring them along.
 * @param files Repo-relative path to contents.
 * @returns A context the check will run against.
 */
function withAllowlisted(files: Record<string, string>) {
  return fakeContext({ ...ALLOWLISTED, ...files });
}

describe("no-cjk", () => {
  it("passes English source", () => {
    const context = withAllowlisted({ "packages/core/src/a.ts": "// hello\n" });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("catches Chinese in a comment, not only in a string", () => {
    const context = withAllowlisted({ "packages/core/src/a.ts": "// 中文注释\n" });
    expect(noCjk.run(context)).toEqual([
      expect.objectContaining({ file: "packages/core/src/a.ts", line: 1 }),
    ]);
  });

  it("catches Japanese and Korean too, not just Chinese", () => {
    const context = withAllowlisted({
      "packages/core/src/ja.ts": 'const a = "こんにちは";\n',
      "packages/core/src/ko.ts": 'const b = "안녕하세요";\n',
    });
    expect(noCjk.run(context)).toHaveLength(2);
  });

  it("catches fullwidth punctuation, which reads as ASCII but is not", () => {
    const context = withAllowlisted({ "packages/core/src/a.ts": "const a = 1；\n" });
    expect(noCjk.run(context)).toHaveLength(1);
  });

  it("leaves ordinary typography alone", () => {
    // Em dash, arrows, checkmarks and accents are not the concern; flagging
    // them would make the check noisy enough to be switched off.
    const context = withAllowlisted({
      "packages/core/src/a.ts": "// a — b → c ✓ café\n",
    });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("names the right line in a multi-line file", async () => {
    const context = withAllowlisted({
      "packages/core/src/a.ts": "one\ntwo\n// 三\nfour\n",
    });
    const findings = await noCjk.run(context);
    expect(findings[0]?.line).toBe(3);
  });

  it("reaches the repository root, which the shell guard could not", () => {
    // The guard enumerated `find packages`, so a root-level config file was
    // outside every one of its three scan blocks and reported clean by
    // construction. Same for anything under scripts/ that was not .sh.
    const context = withAllowlisted({
      "eslint.config.ts": "// 探针\n",
      "scripts/thing.mjs": "// 探针\n",
      "packages/core/src/ok.ts": "// fine\n",
    });
    expect(noCjk.run(context)).toHaveLength(2);
  });

  it("scans YAML config and shell scripts", () => {
    const context = withAllowlisted({
      "config/storage.yaml": "# 注释\n",
      "scripts/thing.sh": "# 注释\n",
    });
    expect(noCjk.run(context)).toHaveLength(2);
  });

  it("skips locale catalogs, tests, vendor and the lockfile", () => {
    const context = withAllowlisted({
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
    const context = withAllowlisted({
      "packages/web/src/features/preferences/supported-langs.ts":
        'const langs = ["简体中文", "日本語"];',
      "repo-lint/src/product-noun-denylist.ts": 'const deny = ["项目"];',
      "packages/core/src/ok.ts": "// fine\n",
    });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("does not scan documentation — specs are allowed to be Chinese", () => {
    const context = withAllowlisted({
      "CLAUDE.md": "# 项目简介",
      "packages/core/src/ok.ts": "// fine\n",
    });
    expect(noCjk.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it selects no files", () => {
    const context = withAllowlisted({ "README.md": "hi" });
    expect(() => noCjk.run(context)).toThrow(/matched none/);
  });

  it("fails rather than reports clean when an exemption outlives its file", () => {
    // An exemption is a hole with a reason attached, and the reason dies
    // with the file. Left pointing at nothing it waves through whatever
    // lands on that path next.
    const context = fakeContext({ "packages/core/src/a.ts": "const a = 1;\n" });
    expect(() => noCjk.run(context)).toThrow(/no such file exists/);
  });
});
