// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { newId } from '@breatic/shared';
import { latestMiniToolAnalysis } from '@web/data/api/mini-tool-analyses';
import { planVideoTimelineSeconds, type MiniToolAnalysisRecord, type MiniToolAnalysisResult, type VideoToolDraftById, type VideoToolId, type VideoToolSourceRef, type VideoToolDialogueRow, type VideoToolTimelineClip } from '@breatic/shared/mini-tools';

/**
 * Creates a complete tool draft bound to the current registered source.
 * @throws {never} Never.
 * @param toolId - The selected supported video tool.
 * @param source - The registered source and its authoritative media information.
 * @returns The current value derived from these inputs.
 */
export function createVideoToolDraft<K extends VideoToolId>(toolId: K, source: VideoToolSourceRef): VideoToolDraftById[K] {
  const sourceInputId = newId();
  const common = { version: 1 as const, draftId: newId(), revision: newId(), source, inputs: [] };
  const drafts: VideoToolDraftById = {
    'video.expand': { ...common, params: { frame: { x: 0, y: 0, width: 1, height: 1 }, ratio: 'free', prompt: '' } },
    'video.erase': { ...common, params: { range: { start: 0, end: source.mediaInfo.duration }, anchor: { frameIndex: 0, pts: 0 }, region: { box: null, points: [] }, trackingPrompt: '' } },
    'video.lip-sync': { ...common, params: { anchor: { frameIndex: 0, pts: 0 }, dialogues: [{ dialogueId: newId(), personId: null, analysisRunId: null, audioInputId: null, startTime: 0 }], syncMode: 'cut_off' } },
    'video.remove-bg': { ...common, params: {} },
    'video.extract-frames': { ...common, params: { mode: 'current', currentTime: 0 } },
    'video.transitions': { ...common, inputs: [{ inputId: sourceInputId, url: source.canonicalURL, mediaInfo: source.mediaInfo, sourceNodeId: source.nodeId }], params: { clips: [{ clipId: newId(), inputId: sourceInputId, in: 0, out: source.mediaInfo.duration, transition: { kind: 'cut', duration: 0 } }] } },
    'video.split': { ...common, params: { cuts: [] } },
  };
  return drafts[toolId];
}

/**
 * The input a transitions draft opens with, the current video; any other input is the one picked into the slot.
 * @param draft - The transitions draft.
 * @returns The current video's input id, undefined for a draft without one.
 * @throws {never} Never.
 */
export function transitionHostInputId(draft: VideoToolDraftById['video.transitions']): string | undefined {
  return draft.inputs.find((input) => input.url === draft.source.canonicalURL && input.sourceNodeId === draft.source.nodeId)?.inputId;
}

/** What the erase panel says about tracking (canvas design §4 erase row). */
export type EraseTrackingStatus = 'tracked' | 'stale' | 'draw';

/**
 * Whether the draft's tracking applies to its current selection, applied to an earlier one, or was never made; a cleared
 * selection asks to draw again, as the demo's reset does.
 * @param state - What the panel knows.
 * @param state.selected - The draft has a selection.
 * @param state.matched - A completed tracking matches the current selection.
 * @param state.judged - The draft's records have been judged against the current selection.
 * @param state.records - The draft's tracking records.
 * @returns The status to show.
 * @throws {never} Never.
 */
export function eraseTrackingStatus(state: { selected: boolean; matched: boolean; judged: boolean; records: readonly Pick<MiniToolAnalysisRecord, 'kind' | 'status' | 'artifactUnavailable'>[] }): EraseTrackingStatus {
  if (state.matched) return 'tracked';
  return state.selected && state.judged && state.records.some((record) => record.kind === 'tracked_mask' && record.status === 'completed' && !record.artifactUnavailable) ? 'stale' : 'draw';
}

/**
 * The people of the newest identification, which the panel and the node show; while a newer one runs, after it failed or
 * once its artifacts are gone there are none, even if an older one found people (demo lip-sync-controls.tsx redetectPatch).
 * @param records - The draft's analysis records.
 * @returns The newest identification's result, or undefined.
 * @throws {never} Never.
 */
export function currentPeopleResult(records: readonly MiniToolAnalysisRecord[]): Extract<MiniToolAnalysisResult, { kind: 'people' }> | undefined {
  const latest = latestMiniToolAnalysis(records.filter((record) => record.kind === 'people'));
  return latest?.status === 'completed' && !latest.artifactUnavailable && latest.result?.kind === 'people' ? latest.result : undefined;
}

/**
 * Clears person identities while retaining independent audio and timing.
 * @throws {never} Never.
 * @param rows - Every independent dialogue row in display order.
 * @returns The current value derived from these inputs.
 */
export function resetDialoguePeople(rows: readonly VideoToolDialogueRow[]): VideoToolDialogueRow[] {
  return rows.map((row) => ({ ...row, personId: null, analysisRunId: null }));
}

/**
 * Whether binding a person to a row would take the run past its people limit (canvas design §4 lip-sync row): the run
 * takes every distinct person the other rows hold, plus this one.
 * @param rows - Every dialogue row.
 * @param dialogueId - The row being bound.
 * @param personId - The person to bind.
 * @param maxPeople - The people limit, absent while unknown.
 * @returns True when it would.
 * @throws {never} Never.
 */
export function overPeopleLimit(rows: readonly VideoToolDialogueRow[], dialogueId: string, personId: string, maxPeople: number | undefined): boolean {
  return maxPeople !== undefined && new Set([...rows.filter((row) => row.dialogueId !== dialogueId && row.personId !== null).map((row) => row.personId), personId]).size > maxPeople;
}

/**
 * Applies a row edit by its stable identity.
 * @throws {never} Never.
 * @param rows - Every independent dialogue row in display order.
 * @param id - The stable identity of the row or clip being edited.
 * @param partial - Only the fields changed by this edit.
 * @returns The current value derived from these inputs.
 */
export function editDialogue(rows: readonly VideoToolDialogueRow[], id: string, partial: Partial<VideoToolDialogueRow>): VideoToolDialogueRow[] {
  return rows.map((row) => row.dialogueId === id ? { ...row, ...partial, dialogueId: row.dialogueId } : row);
}

/**
 * Applies track-handle deltas to one source trim. The handles report seconds through the timeline library's pixel round
 * trip, so the trim is settled to whole milliseconds inside the source; a trim that settles to no length leaves the clips as
 * they were.
 * @throws {Error} When the supplied plan is invalid.
 * @param clips - The full ordered source clip sequence.
 * @param id - The stable identity of the row or clip being edited.
 * @param start - The new composition start from the timeline handle.
 * @param end - The new composition end from the timeline handle.
 * @param duration - The edited clip's source duration in seconds, when known.
 * @returns The current value derived from these inputs.
 */
export function trimTimelineClip(clips: readonly VideoToolTimelineClip[], id: string, start: number, end: number, duration?: number): VideoToolTimelineClip[] {
  /**
   * Settles a handle's seconds to whole milliseconds.
   * @param seconds - The seconds the handle reported.
   * @returns The nearest whole millisecond.
   * @throws {never} Never.
   */
  const millis = (seconds: number): number => Math.round(seconds * 1000) / 1000;
  const trimmed = planVideoTimelineSeconds(clips).clips.map((clip) => {
    const { start: at, end: until, overlap: _overlap, ...source } = clip;
    return clip.clipId === id ? { ...source, in: Math.max(0, millis(source.in + start - at)), out: Math.min(duration ?? Infinity, millis(source.out + end - until)) } : source;
  });
  return trimmed.some((clip) => clip.out <= clip.in) ? [...clips] : trimmed;
}
