// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shipped } from "../config/__tests__/shipped.js";

/** The files that route, switch and price for every upstream alike; each upstream's own ways live in its adapter. */
const MAIN_FLOW = ["src/llm/llm.ts", "src/llm/switching.ts", "src/provider.ts", "src/messages/relay.ts", "src/messages/index.ts"];

/** Every upstream kind the shipped configuration names. */
const KINDS = [...new Set(Object.values(shipped().upstreams).map((u) => u.kind))];

/**
 * A source file without its comments; a `//` inside a string (a URL) is kept.
 * @param source - The file's text.
 * @returns The code alone.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("the main flow names no upstream", () => {
  it("knows the kinds it guards against", () => {
    expect(KINDS).toEqual(expect.arrayContaining(["openrouter", "google", "anthropic", "deepseek", "openai", "wavespeed", "fal", "sandbase"]));
  });

  it.each(MAIN_FLOW)("%s names no upstream kind outside its comments", (file) => {
    const code = codeOf(readFileSync(resolve(__dirname, "../..", file), "utf8"));
    // A hyphenated name, such as the Messages protocol's `anthropic-version` header, names a protocol, not an upstream.
    const named = KINDS.flatMap((kind) => [...code.matchAll(new RegExp(`(?<![\\w-])${kind}(?![\\w-])`, "gi"))].map((m) => `${kind} at offset ${m.index}`));
    expect(named).toEqual([]);
  });
});
