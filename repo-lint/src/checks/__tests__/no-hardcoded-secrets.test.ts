// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CheckContext } from "#repo-lint/check";
import { noHardcodedSecrets } from "#repo-lint/checks/no-hardcoded-secrets";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

// A syntactically valid Anthropic key shape with no real entropy behind it.
// Assembled so this file does not itself read as a leaked credential.
const FAKE_KEY = `sk-ant-api03-${"A".repeat(95)}`;

let root: string;

/**
 * Builds a context over the fixture directory.
 * @param files Names of fixture files to expose.
 * @returns A context rooted at the fixture directory.
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
    read: (): string => {
      throw new Error("not used");
    },
    exists: (): boolean => true,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "secrets-"));
  // The check runs the real scanner, so the fixture repo needs it on disk.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  // secretlint refuses to run without a config, which is the right
  // behaviour and is asserted below; the fixture gets the real one.
  copyFileSync(
    join(REPO_ROOT, ".secretlintrc.json"),
    join(root, ".secretlintrc.json"),
  );
  writeFileSync(join(root, "clean.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "leaked.ts"), `const key = "${FAKE_KEY}";\n`);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("no-hardcoded-secrets", () => {
  it("passes source with no credential", async () => {
    expect(await noHardcodedSecrets.run(contextOver(["clean.ts"]))).toEqual([]);
  });

  it("catches a provider key and names its line", async () => {
    const findings = await noHardcodedSecrets.run(contextOver(["leaked.ts"]));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("leaked.ts");
    expect(findings[0]?.line).toBe(1);
  });

  it("never repeats the secret in its own output", async () => {
    // The scanner's reply embeds the full source of every file it read.
    // A guard that echoed the credential would publish it a second time,
    // into the CI log.
    const findings = await noHardcodedSecrets.run(contextOver(["leaked.ts"]));
    expect(findings[0]?.message).not.toContain(FAKE_KEY);
    expect(findings[0]?.message).toContain("rotate the credential");
  });

  it("survives a report larger than a pipe would carry", async () => {
    // Measured: the JSON written to a pipe truncates at roughly 55 KB,
    // silently, with exit code 0. The reply embeds every file's full text,
    // so a handful of ordinary files exceeds that. This is the regression
    // test for reading the report from a file instead.
    const big = Array.from({ length: 12 }, (_unused, index) => {
      const name = `big-${index}.ts`;
      writeFileSync(join(root, name), `// ${"x".repeat(8000)}\nexport const a = 1;\n`);
      return name;
    });
    const findings = await noHardcodedSecrets.run(contextOver(big));
    expect(findings).toEqual([]);
  });

  it("fails rather than reports clean when it selects no files", () => {
    expect(() => noHardcodedSecrets.run(contextOver([]))).toThrow(
      /matched none/,
    );
  });

  it("fails rather than reports clean when the scanner is missing", () => {
    const bare = mkdtempSync(join(tmpdir(), "secrets-bare-"));
    writeFileSync(join(bare, "a.ts"), "export const a = 1;\n");
    const context: CheckContext = { ...contextOver(["a.ts"]), repoRoot: bare };
    expect(() => noHardcodedSecrets.run(context)).toThrow(/not installed/);
    rmSync(bare, { recursive: true, force: true });
  });

  it("fails rather than reports clean when the scanner has no config", () => {
    // secretlint refuses to run without one. Its refusal must surface as a
    // failure, not be swallowed into an empty result.
    const unconfigured = mkdtempSync(join(tmpdir(), "secrets-noconf-"));
    symlinkSync(
      join(REPO_ROOT, "node_modules"),
      join(unconfigured, "node_modules"),
    );
    writeFileSync(join(unconfigured, "a.ts"), "export const a = 1;\n");
    const context: CheckContext = {
      ...contextOver(["a.ts"]),
      repoRoot: unconfigured,
    };
    expect(() => noHardcodedSecrets.run(context)).toThrow(/could not run/);
    rmSync(unconfigured, { recursive: true, force: true });
  });
});
