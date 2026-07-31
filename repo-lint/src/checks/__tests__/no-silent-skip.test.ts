// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { describe, expect, it } from "vitest";
import { noSilentSkip } from "#repo-lint/checks/no-silent-skip";
import { fakeContext } from "#repo-lint/__tests__/fake-context";

/**
 * Bytes that no content scan can read.
 *
 * Written as escapes rather than typed in: the repository's own
 * no-trojan-source check reports exactly these characters, so a fixture
 * spelling them out would be the first thing it found.
 */
const NOT_TEXT = `\u0000${"\uFFFD".repeat(3)}`;

describe("no-silent-skip", () => {
  it("reports a file that is not text and whose kind is not named", () => {
    // The whole subject: every content scan drops this file and says nothing,
    // so it reads exactly like a file with nothing in it.
    const context = fakeContext({
      "design/mock.psd": NOT_TEXT,
      "packages/core/src/a.ts": "const a = 1;\n",
    });
    const findings = noSilentSkip.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("design/mock.psd");
  });

  it("leaves a file whose kind is already named alone", () => {
    // Named kinds are never opened, so they never reach a scan to drop out
    // of — the skip is accounted for, which is the whole ask.
    const context = fakeContext({
      "packages/web/public/logo.png": NOT_TEXT,
      "packages/core/src/a.ts": "const a = 1;\n",
    });
    expect(noSilentSkip.run(context)).toEqual([]);
  });

  it("leaves ordinary text alone", () => {
    const context = fakeContext({
      "packages/core/src/a.ts": "const a = 1;\n",
      "README.md": "# hello\n",
      "Dockerfile": "FROM node:22\n",
    });
    expect(noSilentSkip.run(context)).toEqual([]);
  });

  it("reports text that is not valid UTF-8, which reads the same way", () => {
    // The case a denylist entry would be the wrong fix for: it is meant to be
    // text, no scan can see inside it, and nothing said so.
    const context = fakeContext({
      "config/broken.yaml": `${"\uFFFD".repeat(50)}key: value\n`,
      "packages/core/src/a.ts": "const a = 1;\n",
    });
    expect(noSilentSkip.run(context)).toHaveLength(1);
  });

  it("fails rather than reports clean when it selects no files", () => {
    expect(() =>
      noSilentSkip.run(fakeContext({ "logo.png": NOT_TEXT })),
    ).toThrow(/matched none/);
  });
});
