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
  /**
   * The text a read answered with, for a run that produces no file.
   *
   * Beside `url` rather than sharing it: `persistOutputs` decides what to
   * store by whether an output names an address, and a sentence that happens
   * to begin with `http` is not one.
   */
  content?: string;
  cover_url?: string;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  /** What the ledger judged this file to be, off the bytes that landed. */
  mime_type?: string | null;
  /** What the ledger counted the bytes at. */
  size_bytes?: number | null;
  extra?: Record<string, unknown>;
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
  return {
    url: stored.fileUrl,
    // Absent rather than null when there is none, so a caller spreading this
    // over an output that already carries one does not blank it.
    ...(stored.coverUrl !== null && { cover_url: stored.coverUrl }),
    width: stored.width,
    height: stored.height,
    duration_seconds: stored.durationSeconds,
    mime_type: stored.mimeType,
    size_bytes: stored.sizeBytes,
  };
}

/**
 * What each target node is told, read off the outputs this run produced.
 *
 * The two vocabularies meet here and nowhere else: an output names its fields
 * the way the transports and storage do, and a node's event names them the
 * way the document does. Three exits carry this — the redelivery of a paid
 * result, the Stage-4 publish, and the crash net's recovery — and each one
 * spelling the mapping out for itself is three places to edit when a field
 * joins, which is how this run's own two arrived.
 * @param nodeIds - The nodes this run writes to, in output order.
 * @param outputs - What it produced, one per node.
 * @returns One result per node, in the shape the event carries.
 */
export function nodeResultsFrom(
  nodeIds: readonly string[],
  outputs: readonly PersistedOutput[],
): Array<{
  nodeId: string;
  content: string | undefined;
  coverUrl: string | undefined;
  width: number | null;
  height: number | null;
  duration: number | null;
  mimeType: string | null;
  size: number | null;
}> {
  return nodeIds.map((nodeId, i) => ({
    nodeId,
    content: outputs[i]?.content ?? outputs[i]?.url,
    coverUrl: outputs[i]?.cover_url,
    // The paid result already holds what the container measured, and these
    // deliveries are the only ones the node will get for it.
    width: outputs[i]?.width ?? null,
    height: outputs[i]?.height ?? null,
    duration: outputs[i]?.duration_seconds ?? null,
    mimeType: outputs[i]?.mime_type ?? null,
    size: outputs[i]?.size_bytes ?? null,
  }));
}
