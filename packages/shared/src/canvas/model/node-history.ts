// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One node-history row (#1619) — a past generation (success or failed) or a
 * user upload. `createdAt` is an ISO-8601 string over the wire (JSON has no
 * Date). `metadata` is the free-form jsonb the backend recorded: a generation
 * carries `model` / `cost`, an upload carries `filename`.
 */
export interface NodeHistoryEntry {
  id: string;
  /**
   * Display name of the operator, joined server-side from their personal
   * studio (pointer model — renames propagate). `null` when unresolved
   * (studio deleted); the row then shows the time alone (#1619).
   */
  operatorName: string | null;
  entryType: 'generation' | 'upload' | 'snapshot';
  status: 'success' | 'failed';
  /** The result asset URL; `null` for a failed generation. */
  content: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  metadata: {
    model?: string;
    /** What the run was charged. A generation has one; an upload does not. */
    credits?: number;
    filename?: string;
    [k: string]: unknown;
  };
  /**
   * The media numbers this content landed on the node with (#2184), under the
   * node's own field names; a restore writes them back. Null when the medium
   * has no such number, and on rows written before they were kept.
   */
  mediaWidth: number | null;
  mediaHeight: number | null;
  duration: number | null;
  mimeType: string | null;
  size: number | null;
  createdAt: string;
}

/** The host node's modality — picks the thumbnail treatment. */
export type HistoryModality = 'image' | 'video' | 'audio' | 'text';

/**
 * The node types a `HistoryModality` covers, for narrowing a node's own type.
 * Beside the union it enumerates, so the two cannot fall out of step.
 */
export const HISTORY_MODALITIES: ReadonlySet<string> = new Set([
  'image',
  'video',
  'audio',
  'text',
]);
