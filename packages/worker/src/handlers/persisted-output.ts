// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One output of a generation, as it is written down (#209 + #210).
 *
 * It sits in a file of its own because two ends read it: the dispatcher, which
 * fills it in as each output reaches R2, and the local mini-tools, whose
 * outputs are already ours and reach the node through this shape alone. A copy
 * at either end would let one of them drift while the other still compiles.
 */

import type { StoredAsset } from "@breatic/domain";

/**
 * What one output carries to the node and to the task row.
 *
 * The media numbers ride along because a generation has no browser holding
 * that row: this is the whole of what reaches a node, and one left to measure
 * its own media shows nothing until the bytes decode.
 */
export interface PersistedOutput {
  url?: string;
  cover_url?: string;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  extra?: Record<string, unknown>;
}

/**
 * Pin what the ledger row measured onto the output it belongs to.
 * @param output - The output being persisted.
 * @param stored - The row the bytes registered as.
 */
export function pinMedia(output: PersistedOutput, stored: StoredAsset): void {
  if (stored.coverUrl !== null) output.cover_url = stored.coverUrl;
  output.width = stored.width;
  output.height = stored.height;
  output.duration_seconds = stored.durationSeconds;
}

/**
 * One output built from the row its bytes registered as.
 *
 * What a local mini-tool answers with: its bytes went through the ingest
 * Worker on the way to the temporary file being filed, so the cover and the
 * numbers are already known and nothing later goes looking for them.
 * @param stored - The row the bytes registered as.
 * @returns The output entry, whose URL is the row's.
 */
export function storedAsOutput(
  stored: StoredAsset,
): PersistedOutput & { url: string } {
  const output: PersistedOutput & { url: string } = { url: stored.fileUrl };
  pinMedia(output, stored);
  return output;
}
