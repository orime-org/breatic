// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import type * as Y from 'yjs';
import { newId } from '@breatic/shared';
import {
  miniToolAnalysisRecordSchema,
  readVideoToolDraft as readStoredVideoToolDraft,
  videoToolAnalysisRefSchema,
  videoToolAnalysisRefs,
  videoToolDraftSchema,
  type MiniToolPresentationRef,
  type VideoToolAnalysisRef,
  type VideoToolDraftById,
  type VideoToolDraftReading,
  type VideoToolId,
} from '@breatic/shared/mini-tools';

import { CANVAS_UNDO, nodeDataMap } from '@web/data/yjs/canvas-space';
import { docNameOf } from '@web/data/yjs/manager';
import { writeSpaceDoc } from '@web/data/yjs/space-write';
import { SCENE_ANALYSIS_APPLIED_PREFIX } from '@web/data/yjs/canvas-field-keys';

const ANALYSIS_METADATA_WRITE = Symbol('mini-tool-analysis-metadata');
/** Origin of a draft write the user did not make (the draft a tool opens with, the Current frame a Run press freezes), which canvas undo does not track. */
const DRAFT_SEED_WRITE = Symbol('mini-tool-draft-seed');

/** What became of one scene result: applied, superseded by an edit made while it ran, or not for this draft at all. */
export type SceneAnalysisOutcome = 'applied' | 'superseded' | 'ignored';

/**
 * Applies one accepted scene result without repeating it after parameter undo. A result whose draft was edited while it ran
 * is not applied, because the user's later edit wins, and is reported as superseded so the panel can say so.
 * @param doc - The live canvas document.
 * @param nodeId - The host video node.
 * @param record - The immutable accepted result.
 * @returns Whether the result was applied, superseded by a later edit of its draft, or ignored.
 * @throws {never} Invalid or superseded records leave the document unchanged.
 */
export function commitVideoSceneAnalysis(doc: Y.Doc, nodeId: string, record: unknown): SceneAnalysisOutcome {
  const parsed = miniToolAnalysisRecordSchema.safeParse(record);
  if (!parsed.success) return 'ignored';
  const accepted = parsed.data;
  if (accepted.kind !== 'scene_cuts' || accepted.status !== 'completed' || accepted.artifactUnavailable || accepted.result?.kind !== 'scene_cuts') return 'ignored';
  const data = nodeDataMap(doc, nodeId);
  const reading = readVideoToolDraft(doc, nodeId, 'video.split');
  if (data === null || data.get('locked') === true || reading.state !== 'supported') return 'ignored';
  const draft = reading.draft;
  if (draft.draftId !== accepted.draftId || draft.source.canonicalURL !== accepted.binding.canonicalURL || data.get('content') !== draft.source.canonicalURL) return 'ignored';
  const references = videoToolAnalysisRefs(Object.fromEntries(data.entries()));
  if (!references.some((reference) => reference.toolId === 'video.split' && reference.draftId === draft.draftId && reference.analysisRunId === accepted.analysisRunId && reference.inputFingerprint === accepted.inputFingerprint)) return 'ignored';
  const key = `${SCENE_ANALYSIS_APPLIED_PREFIX}${accepted.analysisRunId}`;
  if (data.get(key) === true) return 'ignored';
  if (draft.revision !== accepted.revision) return 'superseded';
  const next = videoToolDraftSchema('video.split').parse({ ...draft, revision: newId(), params: { ...draft.params, cuts: accepted.result.cuts.map((cut) => cut.frameIndex) } });
  const name = docNameOf(doc);
  return name !== null && writeSpaceDoc(name, { kind: 'add' }, () => {
    doc.transact(() => {
      data.set(key, true);
      data.set('miniToolDraft:video.split', next);
    }, CANVAS_UNDO);
  }).ok ? 'applied' : 'ignored';
}

/**
 * Reads one tool's scalar without changing unknown or malformed stored data.
 * @param doc - The live canvas document.
 * @param nodeId - The host node.
 * @param toolId - The tool whose snapshot is being read.
 * @param presentationRef - The selected version's ref, against which a draft bound elsewhere reads stale.
 * @returns The supported or stale snapshot, or its original format state.
 * @throws {never} Never.
 */
export function readVideoToolDraft<K extends VideoToolId>(
  doc: Y.Doc,
  nodeId: string,
  toolId: K,
  presentationRef?: MiniToolPresentationRef,
): VideoToolDraftReading<K> {
  return readStoredVideoToolDraft(toolId, nodeDataMap(doc, nodeId)?.get(`miniToolDraft:${toolId}`), presentationRef);
}

/**
 * Binds the stored draft, values unchanged, to the selected version as a new draft (frames-split §7.13 Rebind): a new
 * draftId and revision under the selected presentationRef, and the analysis references of the old draft dropped, as one
 * undo step. The caller has checked the values against the selected grid.
 * @param doc - The live canvas document.
 * @param nodeId - The host node.
 * @param toolId - The tool being rebound.
 * @param presentationRef - The selected version's ref.
 * @param revision - The revision the user saw; a draft changed since is not rebound.
 * @returns Whether the draft was rebound.
 * @throws {never} A missing, malformed or changed draft is left unchanged.
 */
export function rebindVideoToolDraft(doc: Y.Doc, nodeId: string, toolId: VideoToolId, presentationRef: MiniToolPresentationRef, revision: string): boolean {
  const data = nodeDataMap(doc, nodeId);
  const reading = readVideoToolDraft(doc, nodeId, toolId);
  if (data === null || reading.state !== 'supported' || reading.draft.revision !== revision) return false;
  const next = videoToolDraftSchema(toolId).parse({ ...reading.draft, draftId: newId(), revision: newId(), presentationRef: structuredClone(presentationRef) });
  const references = videoToolAnalysisRefs(Object.fromEntries(data.entries()))
    .filter((reference) => reference.draftId === reading.draft.draftId && reference.toolId === toolId);
  const name = docNameOf(doc);
  return name !== null && writeSpaceDoc(name, { kind: 'add' }, () => {
    doc.transact(() => {
      for (const reference of references) data.delete(`miniToolAnalysis:${reference.analysisRunId}`);
      data.set(`miniToolDraft:${toolId}`, next);
    }, CANVAS_UNDO);
  }).ok;
}

/**
 * Commits the caller's complete source, parameters and inputs as one undo step, or, for a write the user did not make, as
 * none.
 * @param doc - The live canvas document.
 * @param nodeId - The host node.
 * @param toolId - The tool being edited.
 * @param draft - A complete snapshot with its caller-generated revision.
 * @param undoable - Whether the write is the user's own edit, an undo step; false for the opening draft or the frame frozen at a press.
 * @returns Whether the host exists and the size gate let it receive the snapshot.
 * @throws {Error} When the snapshot does not match the tool's schema.
 */
export function commitVideoToolDraft<K extends VideoToolId>(
  doc: Y.Doc,
  nodeId: string,
  toolId: K,
  draft: VideoToolDraftById[K],
  undoable = true,
): boolean {
  const data = nodeDataMap(doc, nodeId);
  if (data === null) return false;
  const parsed = videoToolDraftSchema(toolId).parse(draft);
  const name = docNameOf(doc);
  return name !== null && writeSpaceDoc(name, { kind: 'add' }, () => {
    doc.transact(() => data.set(`miniToolDraft:${toolId}`, parsed), undoable ? CANVAS_UNDO : DRAFT_SEED_WRITE);
  }).ok;
}

/**
 * Registers an accepted run independently from parameter edits and their undo.
 * @param doc - The live canvas document.
 * @param nodeId - The host node.
 * @param reference - The identity returned by an accepted analysis request.
 * @returns Whether the host exists and holds the reference; false when the size gate refused it.
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
  const name = docNameOf(doc);
  return name !== null && writeSpaceDoc(name, { kind: 'add' }, () => {
    doc.transact(() => data.set(key, parsed), ANALYSIS_METADATA_WRITE);
  }).ok;
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
  const name = docNameOf(doc);
  return name !== null && writeSpaceDoc(name, { kind: 'remove' }, () => {
    doc.transact(() => {
      data.delete(key);
      for (const reference of references) data.delete(`miniToolAnalysis:${reference.analysisRunId}`);
    }, CANVAS_UNDO);
  }).ok;
}
