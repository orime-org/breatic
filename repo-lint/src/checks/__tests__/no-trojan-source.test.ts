// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckContext } from "#repo-lint/check";
import { noTrojanSource } from "#repo-lint/checks/no-trojan-source";

// The scanner reads from disk, so these fixtures are real files. Written as
// escape sequences on purpose: a literal bidi override in this source would
// be caught by the very check it tests, and a reviewer could not see it.
const RIGHT_TO_LEFT_OVERRIDE = "\u202E";
const ZERO_WIDTH_SPACE = "\u200B";

let root: string;

/**
 * Builds a context over the fixture directory.
 * @param files Names of fixture files to expose.
 * @returns A context whose `files` returns exactly those.
 */
function contextOver(files: string[]): CheckContext {
  return {
    repoRoot: root,
    files: (select: (path: string) => boolean, label: string): string[] => {
      const matched = files.filter(select);
      if (matched.length === 0) throw new Error(`selection "${label}" matched none`);
      return matched;
    },
    // Text-sniffing is not what these cases are about — the sniff itself is
    // covered by file-kinds' unit tests and by the real run — so this hands
    // back the same selection without opening anything.
    textFiles: (label: string): string[] => {
      const matched = files.filter(() => true);
      if (matched.length === 0) throw new Error(`selection "${label}" matched none`);
      return matched;
    },
    walk: (): string[] => {
      throw new Error("not used");
    },
    read: (): string => {
      throw new Error("not used");
    },
    exists: (): boolean => true,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "trojan-"));
  writeFileSync(join(root, "clean.ts"), "export const x = 1;\n");
  writeFileSync(
    join(root, "bidi.ts"),
    `const isAdmin = false; // ${RIGHT_TO_LEFT_OVERRIDE} not really\n`,
  );
  writeFileSync(
    join(root, "invisible.ts"),
    `const a${ZERO_WIDTH_SPACE}b = 1;\n`,
  );
  // Emoji with a variation selector: invisible, but it cannot hide code.
  writeFileSync(join(root, "emoji.ts"), 'const warn = "⚠️ careful";\n');
  writeFileSync(join(root, "cjk.ts"), 'const label = "画布";\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("no-trojan-source", () => {
  it("passes ordinary source", async () => {
    expect(await noTrojanSource.run(contextOver(["clean.ts"]))).toEqual([]);
  });

  it("catches a bidirectional override", async () => {
    const findings = await noTrojanSource.run(contextOver(["bidi.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("bidi.ts");
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.message).toContain("U+202E");
  });

  it("catches a zero-width character inside an identifier", async () => {
    const findings = await noTrojanSource.run(contextOver(["invisible.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("invisible.ts");
  });

  it("leaves emoji variation selectors alone", async () => {
    // Invisible, so the scanner objects — but a variation selector only
    // changes how the emoji before it renders, and is not ID_Continue, so
    // it cannot alter what any code means.
    expect(await noTrojanSource.run(contextOver(["emoji.ts"]))).toEqual([]);
  });

  it("leaves ordinary non-ASCII alone", async () => {
    // CJK in source is a separate concern with its own check. Conflating
    // them would make this one noisy enough to be switched off.
    expect(await noTrojanSource.run(contextOver(["cjk.ts"]))).toEqual([]);
  });

  it("fails rather than reports clean when it selects no files", async () => {
    await expect(noTrojanSource.run(contextOver([]))).rejects.toThrow(
      /matched none/,
    );
  });
});
