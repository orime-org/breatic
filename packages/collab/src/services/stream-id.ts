// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Ordering of Redis stream ids.
 */

/**
 * Parse a stream id into its two integer parts.
 * @param id - A value that may be a stream id.
 * @returns The millisecond and sequence parts, or null when it is not an id.
 */
function parseStreamId(id: unknown): [bigint, bigint] | null {
  if (typeof id !== "string") return null;
  const match = /^(\d+)-(\d+)$/.exec(id);
  if (!match) return null;
  return [BigInt(match[1]!), BigInt(match[2]!)];
}

/**
 * Whether a stream id comes after the version a node holds.
 *
 * Both parts are compared as integers: as text `"9999-5"` sorts after
 * `"10000-0"`. A held value that is missing or not a stream id counts as no
 * version at all.
 * @param candidate - The id of the event being applied.
 * @param held - The version already recorded, if any.
 * @returns True when `candidate` is strictly newer.
 * @throws {Error} When `candidate` itself is not a stream id.
 */
export function isNewerStreamId(candidate: string, held: unknown): boolean {
  const next = parseStreamId(candidate);
  if (!next) throw new Error(`not a stream id: ${candidate}`);
  const current = parseStreamId(held);
  if (!current) return true;
  if (next[0] !== current[0]) return next[0] > current[0];
  return next[1] > current[1];
}
