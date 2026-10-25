// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as Y from 'yjs';
import {
  readVideoToolDraft as readStoredVideoToolDraft,
  videoToolAnalysisRefSchema,
  videoToolAnalysisRefs,
  videoToolDraftSchema,
  type VideoToolAnalysisRef,
  type VideoToolDraftById,
  type VideoToolDraftReading,
  type VideoToolId,
} from '@breatic/shared/mini-tools';

import { CANVAS_UNDO, nodeDataMap } from '@web/data/yjs/canvas-space';

const ANALYSIS_METADATA_WRITE = Symbol('mini-tool-analysis-metadata');

/**
 * Applies one accepted scene result without repeating it after parameter undo.
 * @param doc - The live canvas document.
 * @param nodeId - The host video node.
 * @param record - The immutable accepted result.
 * @returns Whether one guarded parameter edit was committed.
 * @throws {never} Never while the scene application lane is unimplemented.
 */
export function commitVideoSceneAnalysis(doc: Y.Doc, nodeId: string, record: unknown): boolean {
  void doc; void nodeId; void record;
  return false;
}

/**
 * Reads one tool's scalar without changing unknown or malformed stored data.
 * @param doc - The live canvas document.
 * @param nodeId - The host node.
 * @param toolId - The tool whose snapshot is being read.
 * @returns The supported snapshot or its original format state.
 * @throws {never} Never.
 */
export function readVideoToolDraft<K extends VideoToolId>(
  doc: Y.Doc,
  nodeId: string,
  toolId: K,
): VideoToolDraftReading<K> {
  return readStoredVideoToolDraft(toolId, nodeDataMap(doc, nodeId)?.get(`miniToolDraft:${toolId}`));
}

/**
 * Commits the caller's complete source, parameters and inputs as one undo step.
 * @param doc - The live canvas document.
 * @param nodeId - The host node.
 * @param toolId - The tool being edited.
 * @param draft - A complete snapshot with its caller-generated revision.
 * @returns Whether the host exists and received the snapshot.
 * @throws {Error} When the snapshot does not match the tool's schema.
 */
export function commitVideoToolDraft<K extends VideoToolId>(
  doc: Y.Doc,
  nodeId: string,
  toolId: K,
  draft: VideoToolDraftById[K],
): boolean {
  const data = nodeDataMap(doc, nodeId);
  if (data === null) return false;
  const parsed = videoToolDraftSchema(toolId).parse(draft);
  doc.transact(() => data.set(`miniToolDraft:${toolId}`, parsed), CANVAS_UNDO);
  return true;
}

/**
 * Registers an accepted run independently from parameter edits and their undo.
 * @param doc - The live canvas document.
 * @param nodeId - The host node.
 * @param reference - The identity returned by an accepted analysis request.
 * @returns Whether the host exists and holds the reference.
 * @throws {Error} When the reference is invalid or the run holds another identity.
 */
export function commitVideoToolAnalysisRef(
  doc: Y.Doc,
  nodeId: string,
  reference: VideoToolAnalysisRef,
): boolean {
  const data = nodeDataMap(doc, nodeId);
  if (data === null) return false;
  const parsed = videoToolAnalysisRefSchema.parse(reference);
  const key = `miniToolAnalysis:${parsed.analysisRunId}`;
  if (data.has(key)) {
    const held = videoToolAnalysisRefSchema.safeParse(data.get(key));
    if (held.success
      && held.data.draftId === parsed.draftId
      && held.data.analysisRunId === parsed.analysisRunId
      && held.data.inputFingerprint === parsed.inputFingerprint
      && held.data.toolId === parsed.toolId
      && held.data.kind === parsed.kind) return true;
    throw new Error('An accepted analysis run already holds a different reference');
  }
  doc.transact(() => data.set(key, parsed), ANALYSIS_METADATA_WRITE);
  return true;
}

/**
 * Clears a tool and references owned by its draft in the same undo transaction.
 * @param doc - The live canvas document.
 * @param nodeId - The host node.
 * @param toolId - The tool being cleared.
 * @returns Whether a stored snapshot was cleared.
 * @throws {never} Never.
 */
export function clearVideoToolDraft(doc: Y.Doc, nodeId: string, toolId: VideoToolId): boolean {
  const data = nodeDataMap(doc, nodeId);
  const key = `miniToolDraft:${toolId}`;
  if (data === null || !data.has(key)) return false;
  const stored: unknown = data.get(key);
  const draftId = stored !== null && typeof stored === 'object' && 'draftId' in stored && typeof stored.draftId === 'string'
    ? stored.draftId
    : undefined;
  const references = videoToolAnalysisRefs(Object.fromEntries(data.entries()))
    .filter((reference) => reference.draftId === draftId && reference.toolId === toolId);
  doc.transact(() => {
    data.delete(key);
    for (const reference of references) data.delete(`miniToolAnalysis:${reference.analysisRunId}`);
  }, CANVAS_UNDO);
  return true;
}
