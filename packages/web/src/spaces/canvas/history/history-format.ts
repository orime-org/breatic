// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pure derivations for the node-history panel (#1619) — kept out of the
 * components so the display rules (restorable? which row is "current"? which
 * chips render?) are unit-testable without a DOM. Relative-time formatting is
 * NOT here — it reuses the shared `@web/lib/format-relative-time`.
 */

import { formatCredits } from '@web/lib/format-credits';
import type { NodeHistoryEntry } from '@web/data/api/canvas';

/**
 * Whether a history entry can be restored onto the node — a successful result
 * that actually has content. A failed generation (`status: 'failed'`, or
 * `content == null`) is listed but never restorable.
 * @param entry - The history row.
 * @returns True when the entry has a restorable result.
 */
export function isRestorable(entry: NodeHistoryEntry): boolean {
  return entry.status === 'success' && entry.content != null;
}

/**
 * The id of the entry to mark "current" — WHICH ROW the node is on.
 *
 * A reader who restores a row gets that row, so the node remembers which one
 * and this names it. Content cannot answer that on its own: two snapshots of
 * the same words are two rows a reader is allowed to keep, and asset dedup
 * yields several rows holding one URL. The remembered row is retired by the
 * content check — once the node holds something else, whether a run landed on
 * it or the reader typed, the row it came from is no longer what it is on.
 *
 * Rows that arrived on their own (a run, an upload) were never restored, and
 * for those the newest content match is the answer. Null-guarded on BOTH
 * sides so a node with only failed history (`currentContent == null`) never
 * matches a failed row (`content == null`) via `null === null`; newest-first
 * keeps the dedup case on the newest of the matching rows.
 * @param entries - The loaded history rows, newest first.
 * @param currentContent - The node's live content (may be null).
 * @param restoredFromEntryId - The row the reader last restored onto this node, when one was.
 * @returns The current entry's id, or null.
 */
export function currentEntryId(
  entries: ReadonlyArray<NodeHistoryEntry>,
  currentContent: string | null | undefined,
  restoredFromEntryId?: string | null,
): string | null {
  if (currentContent == null) return null;
  // A reader who restores a row gets THAT row, and the node remembers which
  // one it was. Content cannot tell two rows apart when both hold the same
  // thing — two snapshots of the same words are two rows a reader is allowed
  // to keep (user 2026-09-20). The content check is what retires the memory:
  // once the node holds something else, the row it came from is no longer
  // what it is on.
  if (restoredFromEntryId != null) {
    const restored = entries.find((e) => e.id === restoredFromEntryId);
    if (restored?.content === currentContent) return restored.id;
  }
  for (const e of entries) {
    if (e.content != null && e.content === currentContent) return e.id;
  }
  return null;
}

/**
 * The model label to render for a generation row, or undefined to hide the
 * chip (a generation with no recorded model, or a non-string value).
 * @param entry - The history row.
 * @returns The model label, or undefined.
 */
export function entryModel(entry: NodeHistoryEntry): string | undefined {
  const m = entry.metadata.model;
  return typeof m === 'string' && m.length > 0 ? m : undefined;
}

/**
 * The credits to render, or undefined to hide the chip. Guards against an
 * absent or non-finite value (an upload is charged nothing; a failed
 * generation records nothing) so the chip never shows `undefined` / `NaN`.
 * Delegates to the shared {@link formatCredits} gate so this row and the
 * activity-feed row can never diverge (spec §6.4).
 *
 * Reads `credits`, which is what was charged. A row may also carry `cost` —
 * dollars, what the service charged us — and the two differ by a factor of a
 * hundred and the deployment's multiplier.
 * @param entry - The history row.
 * @returns The credits charged, or undefined.
 */
export function entryCredits(entry: NodeHistoryEntry): number | undefined {
  return formatCredits(entry.metadata.credits);
}

/**
 * The original filename to render for an upload row, or undefined when it was
 * not recorded (falls back to a generic label in the UI).
 * @param entry - The history row.
 * @returns The filename, or undefined.
 */
export function entryFilename(entry: NodeHistoryEntry): string | undefined {
  const f = entry.metadata.filename;
  return typeof f === 'string' && f.length > 0 ? f : undefined;
}
