// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one invariant of the shared-transport migration: every call site keeps
 * the deadline it had.
 *
 * Why this file exists at all. The transport replaces whatever `signal` the
 * caller puts on the fetch init with its own deadline (documented on
 * `httpRequest`'s `init` parameter). Every vendor call here currently builds
 * `AbortSignal.timeout(resolved.timeout * 1000)` and hands it over inside the
 * init — so a migration that moves the call across without lifting that figure
 * into `timeoutMs` compiles, passes every existing test, and silently swaps a
 * per-model deadline for the transport's 300s default. Nothing else in the
 * suite would notice: no test asserts on a timeout value.
 *
 * So the check is structural rather than behavioural. Waiting out a real
 * timeout would cost the configured figure per case — 300s for video, 600s for
 * 3D — and asserting "it aborted eventually" would not tell the two figures
 * apart anyway. Reading the source tells them apart exactly.
 *
 * Two halves, and both are needed. The first fails while the old code is
 * there; the second fails if the migration drops a figure on the floor.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

/** Transport sources, relative to the providers directory. */
const PROVIDERS_DIR = join(import.meta.dirname, "..");

/**
 * Every transport source file, tests excluded.
 *
 * Walked with `readdirSync` rather than a glob library: this file exists to
 * guard the migration, and a guard that needs a new dependency to run is one
 * more thing that can be absent when it matters.
 * @returns Absolute paths, sorted for a stable failure message.
 */
function transportSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name.endsWith(".ts") && dir.endsWith("transports")) {
        found.push(full);
      }
    }
  };
  walk(PROVIDERS_DIR);
  return found.sort();
}

/**
 * Read a file and return its lines paired with 1-based numbers.
 * @param path - Absolute file path.
 * @returns One entry per line.
 */
function numberedLines(path: string): Array<{ n: number; text: string }> {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }));
}

describe("shared-transport migration — every deadline survives the move", () => {
  it("leaves no AbortSignal.timeout behind in any transport", () => {
    // The transport ignores a caller's signal, so one left in place is not a
    // stylistic leftover — it is a deadline that silently stopped applying.
    const offenders = transportSources().flatMap((path) =>
      numberedLines(path)
        .filter((l) => l.text.includes("AbortSignal.timeout"))
        .map((l) => `${path.slice(PROVIDERS_DIR.length + 1)}:${l.n}`),
    );

    expect(offenders).toEqual([]);
  });

  it("gives every transport that had a deadline an explicit timeoutMs", () => {
    // Pairing rather than counting: a file that had a deadline must still name
    // one. Counting totals would let a lost deadline in one file be masked by
    // an extra in another.
    const missing = transportSources()
      .map((path) => ({ path, body: readFileSync(path, "utf8") }))
      // Only files that actually issue HTTP. `litellm` goes through the model
      // wrapper and never touches this transport, so it is not in scope.
      .filter(({ body }) => body.includes("httpRequest(") || body.includes("AbortSignal.timeout"))
      .filter(({ body }) => !body.includes("timeoutMs"))
      .map(({ path }) => path.slice(PROVIDERS_DIR.length + 1));

    expect(missing).toEqual([]);
  });

  it("keeps the per-model figure, not a hand-written number", () => {
    // `resolved.timeout` is where the per-model deadline lives. A migration
    // that types a literal instead — or divides it to "keep the old total" —
    // is inventing a figure on the caller's behalf, which is the one thing
    // this layer's contract forbids. topaz's estimate call is the sole
    // exception and carries its own 30s by design.
    const suspicious = transportSources()
      .map((path) => ({ path, lines: numberedLines(path) }))
      .flatMap(({ path, lines }) =>
        lines
          .filter((l) => /timeoutMs:\s*(?!resolved\.timeout|30_000\b)[0-9]/.test(l.text))
          .map((l) => `${path.slice(PROVIDERS_DIR.length + 1)}:${l.n} — ${l.text.trim()}`),
      );

    expect(suspicious).toEqual([]);
  });
});
