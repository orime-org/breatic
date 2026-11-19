// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The ONE sanitizer for a node's `focusImages` (#1782), shared by web and collab (frames-split §5.5 delivery row): the field is
 * collaborative Yjs data, untrusted, and every reader and writer (the panel view-model, the reference-pool cap count,
 * collab's video focus-crop append) must agree on what counts as an entry.
 */

import type { FocusImage } from '@shared/types/canvas-node.js';
import { MAX_FOCUS_NAME } from '@shared/mini-tools/video-draft.js';

export { MAX_FOCUS_NAME };

/** Field bounds: a hostile valid-shaped entry with a multi-MB name or url would survive every heal; url mirrors `.max(2048)`. */
const MAX_ID = 128;
const MAX_URL = 2048;
const MAX_DIM = 100000;
/**
 * Max entries the sanitizer keeps: above the configurable pool cap and a hard ceiling against a hostile array write. The
 * write side refuses an append its readers would truncate away.
 */
export const MAX_FOCUS_ENTRIES = 200;

/**
 * Whether a raw value has the full FocusImage shape within the field bounds.
 * @param f - The raw entry.
 * @returns True for a valid entry.
 * @throws {never} Never.
 */
function validEntry(f: unknown): f is FocusImage {
  if (typeof f !== 'object' || f === null) return false;
  const e = f as FocusImage;
  return typeof e.id === 'string' && e.id.length > 0 && e.id.length <= MAX_ID &&
    typeof e.url === 'string' && e.url.length > 0 && e.url.length <= MAX_URL &&
    typeof e.name === 'string' && e.name.length <= MAX_FOCUS_NAME &&
    Number.isFinite(e.width) && e.width > 0 && e.width <= MAX_DIM &&
    Number.isFinite(e.height) && e.height > 0 && e.height <= MAX_DIM;
}

/**
 * Narrows an untrusted `focusImages` value to the valid entries: anything but an array is none, the first entry of an id
 * wins, survivors are projected onto fresh five-field literals and at most `MAX_FOCUS_ENTRIES` are kept.
 * @param raw - The raw `data.focusImages` value off the wire.
 * @returns Fresh, exact-shape valid entries (empty for malformed input).
 * @throws {never} Never.
 */
export function validFocusImages(raw: unknown): FocusImage[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .filter((f): f is FocusImage => validEntry(f) && !seen.has(f.id) && (seen.add(f.id), true))
    .slice(0, MAX_FOCUS_ENTRIES)
    .map(({ id, url, name, width, height }) => ({ id, url, name, width, height }));
}
