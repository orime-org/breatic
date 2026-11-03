// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { newId } from '@breatic/shared';
import { planVideoTimeline, type VideoToolDraftById, type VideoToolId, type VideoToolSourceRef, type VideoToolDialogueRow, type VideoToolTimelineClip } from '@breatic/shared/mini-tools';

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
    'video.erase': { ...common, params: { range: { start: 0, end: source.mediaInfo.duration }, anchor: { frameIndex: 0, pts: 0 }, region: { box: null, points: [] }, trackingPrompt: '', erasePrompt: '' } },
    'video.lip-sync': { ...common, params: { anchor: { frameIndex: 0, pts: 0 }, dialogues: [{ dialogueId: newId(), personId: null, analysisRunId: null, audioInputId: null, startTime: 0 }], syncMode: 'cut_off' } },
    'video.remove-bg': { ...common, params: {} },
    'video.extract-frames': { ...common, params: { mode: 'current', currentTime: 0, interval: 1 } },
    'video.transitions': { ...common, inputs: [{ inputId: sourceInputId, url: source.canonicalURL, mediaInfo: source.mediaInfo, sourceNodeId: source.nodeId }], params: { clips: [{ clipId: newId(), inputId: sourceInputId, in: 0, out: source.mediaInfo.duration, transition: { kind: 'cut', duration: 0 } }] } },
    'video.split': { ...common, params: { cuts: [] } },
  };
  return drafts[toolId];
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
 * Applies track-handle deltas to one source trim.
 * @throws {Error} When the supplied plan is invalid.
 * @param clips - The full ordered source clip sequence.
 * @param id - The stable identity of the row or clip being edited.
 * @param start - The new composition start from the timeline handle.
 * @param end - The new composition end from the timeline handle.
 * @returns The current value derived from these inputs.
 */
export function trimTimelineClip(clips: readonly VideoToolTimelineClip[], id: string, start: number, end: number): VideoToolTimelineClip[] {
  return planVideoTimeline(clips).clips.map((clip) => {
    const { start: at, end: until, overlap: _overlap, ...source } = clip;
    return clip.clipId === id ? { ...source, in: source.in + start - at, out: source.out + end - until } : source;
  });
}

/**
 * Reorders clips by the moved track action's centre.
 * @throws {Error} When the supplied plan is invalid.
 * @param clips - The full ordered source clip sequence.
 * @param id - The stable identity of the row or clip being edited.
 * @param start - The new composition start from the timeline handle.
 * @param end - The new composition end from the timeline handle.
 * @returns The current value derived from these inputs.
 */
export function moveTimelineClip(clips: readonly VideoToolTimelineClip[], id: string, start: number, end: number): VideoToolTimelineClip[] {
  const plan = planVideoTimeline(clips);
  return plan.clips.map((clip, index) => ({ clip: clips[index], position: clip.clipId === id ? (start + end) / 2 : (clip.start + clip.end) / 2, index }))
    .sort((left, right) => left.position - right.position || left.index - right.index).map((entry) => entry.clip);
}
