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
  return raw
    .filter(
      (f): f is FocusImage =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as FocusImage).id === 'string' &&
        (f as FocusImage).id.length > 0 &&
        typeof (f as FocusImage).url === 'string' &&
        (f as FocusImage).url.length > 0 &&
        typeof (f as FocusImage).name === 'string' &&
        Number.isFinite((f as FocusImage).width) &&
        Number.isFinite((f as FocusImage).height),
    )
    .map((f) => ({
      id: f.id,
      url: f.url,
      name: f.name,
      width: f.width,
      height: f.height,
    }));
}
