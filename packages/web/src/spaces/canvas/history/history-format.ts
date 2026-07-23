// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
 * The id of the entry to mark "current" — the FIRST (newest; the list is
 * newest-first) entry whose content equals the node's live content, or null
 * when none match. Null-guarded on BOTH sides so a node with only failed
 * history (`currentContent == null`) never matches a failed row
 * (`content == null`) via `null === null`. First-match makes it dedup-safe:
 * asset dedup can yield several rows with the same URL, but only the newest is
 * tagged "current".
 * @param entries - The loaded history rows, newest first.
 * @param currentContent - The node's live `data.content` (may be null).
 * @returns The current entry's id, or null.
 */
export function currentEntryId(
  entries: ReadonlyArray<NodeHistoryEntry>,
  currentContent: string | null | undefined,
): string | null {
  if (currentContent == null) return null;
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
 * The credit cost to render, or undefined to hide the credits chip. Guards
 * against an absent or non-finite value (an upload has no cost; a failed
 * generation records none) so the chip never shows `undefined` / `NaN`.
 * Delegates to the shared {@link formatCredits} gate so this row and the
 * activity-feed row can never diverge (spec §6.4). NOTE: `metadata.cost` is the
 * ESTIMATE shown at run time; #1817 will switch this to the actual billed value.
 * @param entry - The history row.
 * @returns The credit cost, or undefined.
 */
export function entryCredits(entry: NodeHistoryEntry): number | undefined {
  return formatCredits(entry.metadata.cost);
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
