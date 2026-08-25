// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { describe, expect, it } from "vitest";
import { eofNewline } from "#repo-lint/checks/eof-newline";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

describe("eof-newline", () => {
  it("passes a file that ends with a newline", () => {
    const context = fakeContext({ "a.ts": "export const x = 1;\n" });
    expect(eofNewline.run(context)).toEqual([]);
  });

  it("reports a file that does not", () => {
    const context = fakeContext({ "a.ts": "export const x = 1;" });
    expect(eofNewline.run(context)).toEqual([
      {
        file: "a.ts",
        line: 1,
        message:
          "No trailing newline. The next edit here will read as touching this line too.",
      },
    ]);
  });

  it("names the last line, counting every line including blank ones", () => {
    // The guard this replaces stripped comments with an awk loop that did
    // not execute on empty lines, so blank lines vanished and every reported
    // line number after one was too low.
    const context = fakeContext({ "a.ts": "one\n\n\nfour\n\nsix" });
    expect(eofNewline.run(context)).toEqual([
      expect.objectContaining({ file: "a.ts", line: 6 }),
    ]);
  });

  it("leaves an empty file alone — it has no last line to terminate", () => {
    const context = fakeContext({ "a.ts": "", "b.ts": "x\n" });
    expect(eofNewline.run(context)).toEqual([]);
  });

  it("covers every text kind the repo writes", () => {
    const kinds = [
      "a.ts", "a.tsx", "a.mts", "a.cts", "a.sql", "a.json",
      "a.md", "a.sh", "a.yml", "a.yaml", "a.mjs", "a.cjs", "a.css",
    ];
    const files = Object.fromEntries(kinds.map((k) => [k, "x"]));
    expect(eofNewline.run(fakeContext(files))).toHaveLength(kinds.length);
  });

  it("ignores binaries and anything without a text extension", () => {
    const context = fakeContext({ "logo.png": "x", "a.ts": "x\n" });
    expect(eofNewline.run(context)).toEqual([]);
  });

  it("fails rather than reports clean when it selects no files", () => {
    // The single most important property in this package: a filter that
    // matches nothing is broken, and a broken filter that says "clean" is
    // how the previous guards died silently.
    const context = fakeContext({ "logo.png": "x" });
    expect(() => eofNewline.run(context)).toThrow(/matched none/);
  });
});
