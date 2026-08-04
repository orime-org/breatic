// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one invariant of the shared-transport migration: every call keeps the
 * deadline it had, unchanged.
 *
 * Why this file exists. The transport replaces whatever `signal` the caller
 * puts on a fetch init with its own deadline (documented on `httpRequest`'s
 * `init` parameter). Every vendor call here used to build
 * `AbortSignal.timeout(resolved.timeout * 1000)` inside that init, so a
 * migration that moves the call across without lifting the figure into a
 * deadline argument compiles, passes every other test, and silently swaps a
 * per-model deadline for the transport's 300s default. Nothing else in the
 * suite asserts on a timeout value.
 *
 * The check is structural rather than behavioural. Waiting out a real timeout
 * would cost the configured figure per case — 300s for video, 600s for 3D —
 * and asserting "it aborted eventually" cannot tell those two apart anyway.
 * Reading the source tells them apart exactly.
 *
 * WHY THE SCOPE IS WRITTEN DOWN AND NOT DERIVED. The first version of this
 * file worked out which files to check by looking for `httpRequest(` or
 * `AbortSignal.timeout` in the post-migration text. That is the hole, and it
 * is worth stating plainly because it looks so reasonable: eleven transports
 * carry their deadline as a bare positional argument to `requestWithRetry`
 * and contain neither string, so they were dropped from the scope before any
 * assertion ran. Deleting 3D's 600s deadline left all three tests green —
 * measured. A guard whose scope comes from the thing it guards stops watching
 * the moment that thing goes missing. So the list below is a fact about the
 * code BEFORE the migration, and it is only correct to edit it when a call
 * site is genuinely added or removed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

/** Provider sources live here; list entries are relative to it. */
const PROVIDERS_DIR = join(import.meta.dirname, "..");

/**
 * Every deadline that existed before the migration, by file, in source order.
 *
 * Taken from `git show 141cc19e~1` — one entry per `AbortSignal.timeout` that
 * the pre-migration source carried, holding the exact expression it was given.
 * Order matters: it is what catches two deadlines in one file being swapped.
 */
const DEADLINES_BEFORE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["audio/transports/elevenlabs.ts", ["resolved.timeout * 1000"]],
  ["audio/transports/fal.ts", ["resolved.timeout * 1000"]],
  ["audio/transports/minimax.ts", ["resolved.timeout * 1000"]],
  ["audio/transports/wavespeed.ts", ["resolved.timeout * 1000"]],
  ["image/transports/byteplus.ts", ["resolved.timeout * 1000"]],
  ["image/transports/dashscope.ts", ["resolved.timeout * 1000"]],
  ["image/transports/google.ts", ["resolved.timeout * 1000"]],
  // topaz carries three: the estimate call's own 30s, then the sync submit and
  // the async submit, both on the model's figure.
  ["image/transports/topaz.ts", ["30_000", "resolved.timeout * 1000", "resolved.timeout * 1000"]],
  ["image/transports/wavespeed.ts", ["resolved.timeout * 1000"]],
  ["three-d/transports/wavespeed.ts", ["resolved.timeout * 1000"]],
  ["tts/transports/elevenlabs.ts", ["resolved.timeout * 1000"]],
  ["tts/transports/fal.ts", ["resolved.timeout * 1000"]],
  ["tts/transports/fish.ts", ["resolved.timeout * 1000"]],
  ["tts/transports/minimax.ts", ["resolved.timeout * 1000"]],
  ["tts/transports/wavespeed.ts", ["resolved.timeout * 1000"]],
  ["understand/transports/wavespeed.ts", ["resolved.timeout * 1000"]],
  ["video/transports/byteplus.ts", ["resolved.timeout * 1000"]],
  ["video/transports/google.ts", ["resolved.timeout * 1000"]],
  ["video/transports/klingai.ts", ["resolved.timeout * 1000"]],
  ["video/transports/wavespeed.ts", ["resolved.timeout * 1000"]],
  // Not a transport, but it was migrated in the same pass and carried a
  // deadline of its own.
  ["http.ts", ["httpConfig().billingTimeout"]],
];

/**
 * Transport sources that issue no HTTP and therefore hold no deadline.
 *
 * Named rather than skipped silently, so the completeness check below stays
 * total: a new transport is either in the list above or in this one.
 */
const ISSUES_NO_HTTP: readonly string[] = ["understand/transports/litellm.ts"];

/**
 * Every transport source file, tests excluded.
 *
 * Walked with `readdirSync` rather than a glob library: this file exists to
 * guard the migration, and a guard that needs a new dependency to run is one
 * more thing that can be absent when it matters.
 * @returns Paths relative to the providers directory, sorted.
 */
function transportSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name.endsWith(".ts") && dir.endsWith("transports")) {
        found.push(full.slice(PROVIDERS_DIR.length + 1));
      }
    }
  };
  walk(PROVIDERS_DIR);
  return found.sort();
}

/**
 * Split a call's argument list into its top-level arguments, verbatim.
 *
 * Hand-written rather than regex-driven because the two argument shapes that
 * carry a deadline cannot both be matched by a pattern: one is a named field
 * inside an object literal, the other is a bare fourth positional argument
 * with no marker of any kind. Quotes and template literals are stepped over
 * so a brace or paren inside a url cannot throw the depth off.
 * @param source - The whole file.
 * @param openParen - Index of the call's opening parenthesis.
 * @returns One entry per argument, trimmed.
 * @throws {Error} When the parentheses never balance.
 */
function topLevelArgs(source: string, openParen: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = openParen + 1;
  let quote: string | null = null;

  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" && depth === 0) {
      args.push(source.slice(start, i).trim());
      return args.filter((a) => a.length > 0);
    } else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error("unbalanced call arguments");
}

/**
 * Every deadline a file hands to the transport, in source order.
 *
 * Both shapes count, and they look nothing alike:
 *
 *   - `httpRequest(url, init, { replaySafe, timeoutMs: X })` — named field.
 *   - `requestWithRetry(url, init, provider, X)` — fourth positional.
 *
 * A `requestWithRetry` call with only three arguments is not an omission: the
 * poll loop deliberately leaves the transport's default in place, and it has
 * no entry in the list above to answer for.
 * @param source - The whole file.
 * @returns The deadline expressions, verbatim, in the order they appear.
 */
function deadlinesIn(source: string): string[] {
  const found: string[] = [];
  const calls = /(?<![A-Za-z_$.])(httpRequest|requestWithRetry)\s*\(/g;

  for (let m = calls.exec(source); m !== null; m = calls.exec(source)) {
    // The declaration of `requestWithRetry` itself is not a call site.
    if (/\bfunction\s+$/.test(source.slice(Math.max(0, m.index - 20), m.index))) continue;

    const args = topLevelArgs(source, m.index + m[0].length - 1);
    if (m[1] === "requestWithRetry") {
      if (args.length >= 4) found.push(args[3]!);
      continue;
    }
    const named = /timeoutMs:\s*([^,}]+)/.exec(args[2] ?? "");
    if (named) found.push(named[1]!.trim());
  }
  return found;
}

describe("shared-transport migration — every deadline survives the move", () => {
  it("leaves no AbortSignal.timeout behind", () => {
    // The transport discards a caller's signal, so one left in place is not a
    // stylistic leftover — it is a deadline that silently stopped applying.
    const offenders = [...transportSources(), "http.ts"].flatMap((rel) =>
      readFileSync(join(PROVIDERS_DIR, rel), "utf8")
        .split("\n")
        .map((text, i) => ({ n: i + 1, text }))
        .filter((l) => l.text.includes("AbortSignal.timeout"))
        .map((l) => `${rel}:${l.n}`),
    );

    expect(offenders).toEqual([]);
  });

  it.each(DEADLINES_BEFORE)("%s keeps its deadlines, unchanged", (rel, expected) => {
    // Per file and in order, so neither a dropped deadline nor a rewritten one
    // can hide. This is the assertion the previous version could not make for
    // the eleven positional-argument files, because they never reached it.
    const actual = deadlinesIn(readFileSync(join(PROVIDERS_DIR, rel), "utf8"));
    expect(actual).toEqual([...expected]);
  });

  it("accounts for every transport file", () => {
    // Without this, a transport added later could carry a deadline nobody
    // watches — the list would simply not mention it, and silence would read
    // as approval.
    const listed = new Set([
      ...DEADLINES_BEFORE.map(([rel]) => rel),
      ...ISSUES_NO_HTTP,
    ]);
    const unaccounted = transportSources().filter((rel) => !listed.has(rel));

    expect(unaccounted).toEqual([]);
  });
});
