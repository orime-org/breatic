// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { unreachableScript } from "@desktop/unreachable/render.js";

const TOKENS = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "web", "src", "theme", "tokens.css"), "utf8");
const DARK_START = TOKENS.indexOf("html[data-theme='dark'] {");

/**
 * A token's value in the web app's light or dark theme, following its `var()` chain.
 * @param name - The custom property.
 * @param dark - Which theme.
 * @returns The hex value.
 */
function token(name: string, dark: boolean): string {
  const pattern = new RegExp(`${name}:\\s*([^;]+);`);
  // A token the dark theme does not redefine keeps its light declaration, whose var() then resolves in the dark theme.
  const value = ((dark ? pattern.exec(TOKENS.slice(DARK_START)) : null) ?? pattern.exec(TOKENS.slice(0, DARK_START)))?.[1]?.trim() ?? "";
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? token(ref[1]!, dark) : value;
}

/**
 * The page's own colour variables, as its CSS declares them for one scheme.
 * @param dark - Which scheme.
 * @returns Variable name to value.
 */
function pageColours(dark: boolean): Record<string, string> {
  const script = unreachableScript({ lang: "en", title: "t", address: "a", reason: "r", retry: "Retry", retrying: "s", busy: false });
  const block = dark ? /prefers-color-scheme: dark\)\s*{\s*:root\s*{([^}]*)}/.exec(script)?.[1] : /:root\s*{([^}]*)}/.exec(script)?.[1];
  return Object.fromEntries([...(block ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

describe("the can't-reach page", () => {
  it.each([false, true])("draws in the web app's colours (dark: %s), so recovering into the app does not change the surface", (dark) => {
    const page = pageColours(dark);
    expect(page["--bg"]).toBe(token("--color-background", dark));
    expect(page["--text"]).toBe(token("--color-foreground", dark));
    expect(page["--muted"]).toBe(token("--color-muted-foreground", dark));
    expect(page["--primary"]).toBe(token("--color-primary", dark));
    expect(page["--primary-text"]).toBe(token("--color-primary-foreground", dark));
    expect(page["--error"]).toBe(token("--color-status-error", dark));
  });

  it("shapes Retry like the app's form buttons", () => {
    const script = unreachableScript({ lang: "en", title: "t", address: "a", reason: "r", retry: "Retry", retrying: "s", busy: false });
    const button = /button\s*{([^}]*)}/.exec(script)?.[1] ?? "";
    expect(button).toContain(`height: ${/--control-height:\s*([^;]+);/.exec(TOKENS)?.[1]}`);
    expect(button).toContain(`border-radius: ${/--radius-chrome:\s*([^;]+);/.exec(TOKENS)?.[1]}`);
  });
});
