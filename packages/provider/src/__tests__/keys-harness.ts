// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import fc from "fast-check";
import { vi, type Mock } from "vitest";
import type { KeySet } from "../index.js";

/**
 * The key set of one account: its keys by upstream name, nothing else.
 * @param keys - The account's key for each upstream it filled.
 * @returns The key set.
 */
export function accountKeys(keys: Record<string, string>): KeySet {
  return { owner: "account", keyOf: (upstream: string) => keys[upstream] };
}

/**
 * A deployment key reader that records every variable it is asked for.
 * @param keys - The deployment's environment.
 * @returns The spy.
 */
export function deploymentKeyOf(keys: Record<string, string>): Mock<(env: string) => string | undefined> {
  return vi.fn((env: string) => keys[env]);
}

/**
 * Everything a value says about itself, its cause chain included, as text: what a log line or an error report would hold.
 * @param value - An error, an answer or anything else.
 * @returns The text.
 */
export function textOf(value: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  for (let current = value; current !== undefined && current !== null && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    parts.push(String(current));
    if (current instanceof Error) parts.push(current.message, current.stack ?? "");
    try {
      parts.push(JSON.stringify(current, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
    } catch {
      // A circular value still gave its String form above.
    }
    if (typeof current === "object") parts.push(...Object.values(current as Record<string, unknown>).map((v) => (typeof v === "string" ? v : "")));
  }
  return parts.join("\n");
}

/** The kinds of failure a call on a key set ends with, beyond the ones it ends with today. */
export type KeyFailureKind = "account_key_missing" | "account_key_failed" | "upstream_unavailable";

/**
 * The first error on a value's cause chain (or carried as a failed answer's reason) that names one of the key failure kinds.
 * @param value - What a call threw, or the answer it gave.
 * @returns That error, or undefined.
 */
export function keyFailureOf(value: unknown): { kind: KeyFailureKind; reason?: string; upstream?: string } | undefined {
  const start = typeof value === "object" && value !== null && (value as { state?: unknown }).state === "failed" ? (value as { reason?: unknown }).reason : value;
  const seen = new Set<unknown>();
  for (let current = start; typeof current === "object" && current !== null && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const kind = (current as { kind?: unknown }).kind;
    if (kind === "account_key_missing" || kind === "account_key_failed" || kind === "upstream_unavailable") return current as { kind: KeyFailureKind; reason?: string; upstream?: string };
  }
  return undefined;
}

/**
 * Settle a call: what it answered, or what it threw.
 * @param call - The call.
 * @returns The answer or the error.
 */
export async function settled<T>(call: Promise<T>): Promise<{ answer: T } | { error: unknown }> {
  try {
    return { answer: await call };
  } catch (error) {
    return { error };
  }
}

/** A well-formed key: printable ASCII, long and distinct enough never to occur in a ticket by chance. */
export const printableKeyArb: fc.Arbitrary<string> = fc
  .array(fc.integer({ min: 0x21, max: 0x7e }), { minLength: 20, maxLength: 60 })
  .map((codes) => `k~${String.fromCharCode(...codes)}`);

/** A key with one character that is not printable ASCII (a control character, a space, DEL or a non-ASCII letter) somewhere inside. */
export const malformedKeyArb: fc.Arbitrary<string> = fc
  .tuple(
    printableKeyArb,
    fc.constantFrom("\n", "\r\n", "\t", "\u0000", "\u001b", " ", "\u007f", "é", " "),
    fc.nat(),
  )
  .map(([key, bad, at]) => {
    const i = at % key.length;
    return `${key.slice(0, i)}${bad}${key.slice(i)}`;
  });
