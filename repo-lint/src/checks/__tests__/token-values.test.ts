// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CheckContext } from "#repo-lint/check";
import { tokenValues } from "#repo-lint/checks/token-values";

const TOKENS = "packages/web/src/theme/tokens.css";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const REAL = readFileSync(resolve(REPO_ROOT, TOKENS), "utf-8");

/**
 * Builds a context serving one stylesheet in place of the real one.
 *
 * Every case mutates the real file rather than a hand-written fixture, so
 * a case cannot pass because the fixture happened to omit the thing under
 * test — the same reason the shell version generated its fixtures from the
 * real file.
 * @param css The stylesheet to serve.
 * @returns A context whose token file is that stylesheet.
 */
function withTokens(css: string): CheckContext {
  return {
    repoRoot: REPO_ROOT,
    files: (): string[] => [TOKENS],
    walk: (): string[] => {
      throw new Error("not used");
    },
    read: (file: string): string => {
      if (file !== TOKENS) throw new Error(`unexpected read: ${file}`);
      return css;
    },
    exists: (file: string): boolean => file === TOKENS,
  };
}

/**
 * Replaces the first occurrence, asserting it was there.
 * @param css The stylesheet.
 * @param from Text to find.
 * @param to Replacement.
 * @returns The mutated stylesheet.
 */
function mutate(css: string, from: string | RegExp, to: string): string {
  const next = css.replace(from, to);
  expect(next, `anchor not found: ${String(from)}`).not.toBe(css);
  return next;
}

describe("token-values", () => {
  it("passes the real token file", () => {
    expect(tokenValues.run(withTokens(REAL))).toEqual([]);
  });

  it("catches an eighth palette colour", () => {
    const css = mutate(
      REAL,
      "--color-palette-teal:",
      "--color-palette-yellow: #b8860b;\n  --color-palette-yellow-bg: color-mix(in srgb, var(--color-palette-yellow) 14%, transparent);\n  --color-palette-teal:",
    );
    const findings = tokenValues.run(withTokens(css));
    expect(findings.some((f) => f.message.includes("yellow"))).toBe(true);
  });

  it("catches a hue in the neutral ramp", () => {
    const css = mutate(REAL, /--neutral-500:\s*#[0-9a-f]{6};/i, "--neutral-500: hsl(30, 45%, 40%);");
    const findings = tokenValues.run(withTokens(css));
    expect(findings.some((f) => f.message.includes("--neutral-500"))).toBe(true);
  });

  it("catches a surface pushed to pure white", () => {
    const css = mutate(
      REAL,
      /--color-background:\s*[^;]+;/i,
      "--color-background: rgb(255, 255, 255);",
    );
    const findings = tokenValues.run(withTokens(css));
    expect(
      findings.some((f) => f.message.includes("brighter than #f5f5f5")),
    ).toBe(true);
  });

  it("catches a second dark block that re-flattens a colour", () => {
    const light = /--color-palette-red:\s*(#[0-9a-f]{3,6})/i.exec(REAL);
    expect(light).not.toBeNull();
    const css = `${REAL}\nhtml[data-theme='dark'] {\n  --color-palette-red: ${light?.[1] ?? ""};\n}\n`;
    const findings = tokenValues.run(withTokens(css));
    expect(
      findings.some((f) => f.message.includes("same colour in both modes")),
    ).toBe(true);
  });

  it("catches a tint that is not the canonical mix", () => {
    const css = mutate(
      REAL,
      /--color-palette-red-bg:\s*[^;]+;/i,
      "--color-palette-red-bg: color-mix(in srgb, color-mix(in srgb, var(--color-palette-red) 50%, transparent) 14%, transparent);",
    );
    const findings = tokenValues.run(withTokens(css));
    expect(
      findings.some((f) => f.message.includes("canonical 14% mix")),
    ).toBe(true);
  });

  it("sees through three-digit and six-digit spellings of one colour", () => {
    // #c23 and #cc2233 are the same colour; a naive string compare would
    // call the pair distinct and pass a flattened palette entry.
    const css = mutate(
      mutate(REAL, /--color-palette-red:\s*#[0-9a-f]{3,6};/i, "--color-palette-red: #c23;"),
      /(html\[data-theme=['"]dark['"\]][^}]*?)--color-palette-red:\s*#[0-9a-f]{3,6};/is,
      "$1--color-palette-red: #cc2233;",
    );
    const findings = tokenValues.run(withTokens(css));
    expect(
      findings.some((f) => f.message.includes("same colour in both modes")),
    ).toBe(true);
  });

  it("catches a palette token moved inside @theme", () => {
    const declaration = /--color-palette-red:\s*#[0-9a-f]{3,6};/i.exec(REAL);
    expect(declaration).not.toBeNull();
    const stripped = REAL.replace(declaration?.[0] ?? "", "");
    const css = mutate(
      stripped,
      /@theme\s*\{/,
      `@theme {\n  ${declaration?.[0] ?? ""}`,
    );
    const findings = tokenValues.run(withTokens(css));
    expect(findings.some((f) => f.message.includes("@theme"))).toBe(true);
  });

  it("catches a status alias cross-wired to the wrong colour", () => {
    const css = mutate(
      REAL,
      /--color-status-error:\s*var\(--color-palette-red\);/i,
      "--color-status-error: var(--color-palette-blue);",
    );
    const findings = tokenValues.run(withTokens(css));
    expect(
      findings.some((f) => f.message.includes("--color-status-error")),
    ).toBe(true);
  });

  it("catches a tint re-declared in the dark block", () => {
    const css = REAL.replace(
      /(html\[data-theme=['"]dark['"]\]\s*\{)/i,
      "$1\n  --color-palette-red-bg: color-mix(in srgb, var(--color-palette-red) 20%, transparent);",
    );
    const findings = tokenValues.run(withTokens(css));
    expect(
      findings.some((f) => f.message.includes("re-declared in the dark block")),
    ).toBe(true);
  });

  it("fails rather than reports clean when the file is missing", () => {
    const context: CheckContext = { ...withTokens(""), exists: (): boolean => false };
    expect(() => tokenValues.run(context)).toThrow(/does not exist/);
  });

  it("fails rather than reports clean when the parse finds nothing", () => {
    expect(() => tokenValues.run(withTokens("/* empty */"))).toThrow(
      /no custom properties/,
    );
  });
});
