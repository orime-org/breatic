// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const VENDOR_PATCH = "patches/@blocknote__core@0.56.0.patch";
const VENDOR_WHITESPACE = "Z=`[\\0- \\xA0\u1680\u180E\u2000-\\u2029\u205F\u3000]`";

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
    textFiles: (
      select: (path: string) => boolean,
      label: string,
    ): string[] => {
      const matched = files.filter(select);
      if (matched.length === 0) throw new Error(`selection "${label}" matched none`);
      return matched;
    },
    walk: (): string[] => {
      throw new Error("not used");
    },
    read: (file: string): string => readFileSync(join(root, file), "utf8"),
    exists: (): boolean => true,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "trojan-"));
  mkdirSync(join(root, "patches"));
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

  it("preserves the exact upstream whitespace expression on both sides of the vendor patch", async () => {
    writeFileSync(join(root, VENDOR_PATCH), `-${VENDOR_WHITESPACE};\n+${VENDOR_WHITESPACE};\n`);
    expect(await noTrojanSource.run(contextOver([VENDOR_PATCH]))).toEqual([]);
  });

  it("still rejects the same control outside that expression in the same vendor patch", async () => {
    writeFileSync(join(root, VENDOR_PATCH), `+${VENDOR_WHITESPACE}; const hidden = "\u180E";\n`);
    const findings = await noTrojanSource.run(contextOver([VENDOR_PATCH]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("U+180E");
  });

  it("still rejects a bidi control beside the exact upstream expression", async () => {
    writeFileSync(join(root, VENDOR_PATCH), `+${VENDOR_WHITESPACE}; // ${RIGHT_TO_LEFT_OVERRIDE}\n`);
    const findings = await noTrojanSource.run(contextOver([VENDOR_PATCH]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("U+202E");
  });

  it("does not exempt that expression in first-party source", async () => {
    writeFileSync(join(root, "upstream-copy.ts"), `const ${VENDOR_WHITESPACE};\n`);
    const findings = await noTrojanSource.run(contextOver(["upstream-copy.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("U+180E");
  });

  it("does not exempt a modified whitespace expression", async () => {
    writeFileSync(join(root, VENDOR_PATCH), `+${VENDOR_WHITESPACE.replace("\\xA0", "\\xA1")};\n`);
    const findings = await noTrojanSource.run(contextOver([VENDOR_PATCH]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain("U+180E");
  });

  it("fails rather than reports clean when it selects no files", async () => {
    await expect(noTrojanSource.run(contextOver([]))).rejects.toThrow(
      /matched none/,
    );
  });
});
