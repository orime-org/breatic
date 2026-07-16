// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The ONE sanitizer for a node's `focusImages` (#1782). The field is
 * collaborative Yjs data — untrusted — and every reader (the panel
 * view-model, the reference-pool cap count) must agree on what counts as
 * an entry: two readers disagreeing is how malformed remote entries
 * became invisible-but-counted cap slots (adversarial 2026-07-16).
 */

import type { FocusImage } from '@breatic/shared';

/**
 * Field bounds (round-4): a hostile valid-shaped entry with a multi-MB
 * name/url would survive every heal and be JSON.stringify'd on every panel
 * keystroke. url mirrors the server ledger contract (`.max(2048)`).
 */
const MAX_ID = 128;
const MAX_URL = 2048;
const MAX_DIM = 100000;
/**
 * Max entries the sanitizer keeps — comfortably above the configurable
 * pool cap (50 by default; the knob is effectively bounded by this hard
 * ceiling) and a hard ceiling against a hostile megabyte-array write
 * whose per-entry fields are all valid (round-6: unbounded COUNT froze
 * the tab while every reader re-projected it). Exported so the WRITE
 * side (addNodeFocusImage) refuses an append its readers would truncate
 * away (round-7).
 */
export const MAX_FOCUS_ENTRIES = 200;

/**
 * Max stored snapshot-name length — exported so the WRITE side (the crop
 * pipeline) clamps to the same bound the read-side sanitizer enforces
 * (round-5: an unclamped source name made a freshly uploaded crop
 * invisible to every reader and silently healed out of Yjs).
 */
export const MAX_FOCUS_NAME = 300;

/**
 * Narrows an untrusted `focusImages` value to the valid entries: anything
 * but an array is none, and an entry must carry the full FocusImage shape
 * (non-empty string id + url, string name, finite dimensions). Survivors
 * are PROJECTED onto fresh five-field literals — filtering alone would let
 * unvalidated extra properties on a valid-shaped remote entry (e.g. a
 * multi-MB junk string) survive every heal and ride every local rewrite
 * (adversarial round-2 2026-07-16).
 * @param raw - The raw `data.focusImages` value off the wire.
 * @returns Fresh, exact-shape valid entries (empty for malformed input).
 */
export function validFocusImages(raw: unknown): FocusImage[] {
  if (!Array.isArray(raw)) return [];
  // First occurrence wins on duplicate ids: two valid-shaped entries sharing
  // an id (hostile / buggy client) would collide React keys, make the ✕
  // remove both, and double-count the pool (adversarial round-3).
  const seen = new Set<string>();
  return raw
    .filter(
      (f): f is FocusImage =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as FocusImage).id === 'string' &&
        (f as FocusImage).id.length > 0 &&
        (f as FocusImage).id.length <= MAX_ID &&
        typeof (f as FocusImage).url === 'string' &&
        (f as FocusImage).url.length > 0 &&
        (f as FocusImage).url.length <= MAX_URL &&
        typeof (f as FocusImage).name === 'string' &&
        (f as FocusImage).name.length <= MAX_FOCUS_NAME &&
        Number.isFinite((f as FocusImage).width) &&
        (f as FocusImage).width > 0 &&
        (f as FocusImage).width <= MAX_DIM &&
        Number.isFinite((f as FocusImage).height) &&
        (f as FocusImage).height > 0 &&
        (f as FocusImage).height <= MAX_DIM &&
        !seen.has((f as FocusImage).id) &&
        (seen.add((f as FocusImage).id), true),
    )
    .slice(0, MAX_FOCUS_ENTRIES)
    .map((f) => ({
      id: f.id,
      url: f.url,
      name: f.name,
      width: f.width,
      height: f.height,
    }));
}
