// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { z } from 'zod';
import {
  TIMELINE_MAIN_TRACK_ID, TimelineVideoClipSchema, TimelineVideoSourceSchema,
  type TimelineDocumentV1, type TimelineRate, type TimelineTrack, type TimelineVideoClip, type TimelineVideoSource,
} from '@breatic/shared';

import { compareTimelineIds, orderedTimelineClips, orderedTimelineTracks } from '@web/data/yjs/timeline-order';
import { timelineClipIntervalValid, timelineSourceOffset, timelineSourceRoom } from '@web/data/yjs/timeline-time';

/** The editing user's local placement switches, carried with each command. */
export interface TimelineEditPlacement { magnet: boolean; linkage: boolean }

/** An edit to the Timeline's collaborative layout. */
export type TimelineEditCommand = (
  | { operation: 'add_video'; parameters: { source: TimelineVideoSource; clip: TimelineVideoClip; newTrackId?: string } }
  | { operation: 'move'; parameters: { clipId: string; startFrame: number; trackId?: string; newTrackId?: string } }
  | { operation: 'set_range'; parameters: { clipId: string; startFrame: number; sourceInFrame: number; durationFrames: number } }
  | { operation: 'split'; parameters: { clipId: string; frame: number; newClipId: string } }
  | { operation: 'duplicate'; parameters: { clipId: string; newClipId: string } }
  | { operation: 'delete'; parameters: { clipId: string } }
  | { operation: 'delete_track'; parameters: { trackId: string } }
) & { placement: TimelineEditPlacement };

// The command bounds are the persisted clip format's own field schemas.
const { startFrame: safeFrame, durationFrames: positiveInteger, id: identity } = TimelineVideoClipSchema.shape;
const trackIdentity = z.string().min(1).max(64);
const placement = z.object({ magnet: z.boolean(), linkage: z.boolean() }).strict();

/** A normalized user-confirmed native edit. */
export const TimelineEditCommandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('add_video'),
    parameters: z.object({ source: TimelineVideoSourceSchema, clip: TimelineVideoClipSchema, newTrackId: trackIdentity.optional() }).strict(),
    placement,
  }).strict(),
  z.object({
    operation: z.literal('move'),
    parameters: z.object({ clipId: identity, startFrame: safeFrame, trackId: trackIdentity.optional(), newTrackId: trackIdentity.optional() }).strict()
      .refine((value) => value.trackId === undefined || value.newTrackId === undefined, { message: 'A move names one target track' }),
    placement,
  }).strict(),
  z.object({
    operation: z.literal('set_range'),
    parameters: z.object({ clipId: identity, startFrame: safeFrame, sourceInFrame: safeFrame, durationFrames: positiveInteger }).strict(),
    placement,
  }).strict(),
  z.object({ operation: z.literal('split'), parameters: z.object({ clipId: identity, frame: safeFrame, newClipId: identity }).strict(), placement }).strict(),
  z.object({ operation: z.literal('duplicate'), parameters: z.object({ clipId: identity, newClipId: identity }).strict(), placement }).strict(),
  z.object({ operation: z.literal('delete'), parameters: z.object({ clipId: identity }).strict(), placement }).strict(),
  z.object({ operation: z.literal('delete_track'), parameters: z.object({ trackId: trackIdentity }).strict(), placement }).strict(),
]);

/** Why a local edit was not applied. */
export type TimelineEditRefusal = 'target_missing' | 'track_missing' | 'invalid_range' | 'id_taken'
  | 'main_track' | 'track_not_empty' | 'source_unavailable';

/** The planned next document, or why the edit was refused. */
export type TimelineEditPlan =
  | { ok: true; next: TimelineDocumentV1; created: string[]; bumped: string[] }
  | { ok: false; reason: TimelineEditRefusal };

/** Carries a refusal out of a nested planning step. */
class Refused extends Error {
  /**
   * Record why the edit is refused.
   * @param reason - The refusal to report.
   */
  constructor(readonly reason: TimelineEditRefusal) {
    super(reason);
  }
}

const RANGE_FIELDS = ['trackId', 'startFrame', 'sourceInFrame', 'durationFrames'] as const;

/**
 * The exclusive end frame of a clip.
 * @param clip - The clip.
 * @returns Its end frame.
 * @throws {never} Never.
 */
function endOf(clip: TimelineVideoClip): number {
  return clip.startFrame + clip.durationFrames;
}

/**
 * Count of clip frames whose source sample falls outside the source.
 * @param clip - The clip.
 * @param source - Its source.
 * @param fps - The Timeline frame rate.
 * @returns The out-of-source frames.
 * @throws {RangeError} When a rate or the source duration is invalid.
 */
export function timelineSourceOverflow(clip: TimelineVideoClip, source: TimelineVideoSource, fps: TimelineRate): number {
  return clip.durationFrames - Math.min(clip.durationFrames, timelineSourceRoom(clip, source, fps));
}

/**
 * Index in a main-track sequence where a clip dropped at `frame` goes: the clips whose midpoint is not after it.
 * @param sequence - The main-track clips without the dropped one.
 * @param frame - The drop frame.
 * @returns The insertion index.
 * @throws {never} Never.
 */
export function timelineInsertionIndex(sequence: readonly TimelineVideoClip[], frame: number): number {
  return sequence.filter((clip) => clip.startFrame * 2 + clip.durationFrames <= frame * 2).length;
}

/**
 * Place a sequence end to end from frame 0.
 * @param clips - The clips being planned, updated in place.
 * @param sequence - The order to pack.
 * @throws {never} Never.
 */
function pack(clips: Record<string, TimelineVideoClip>, sequence: readonly TimelineVideoClip[]): void {
  let at = 0;
  for (const item of sequence) {
    const current = clips[item.id];
    if (current === undefined) continue;
    clips[item.id] = { ...current, startFrame: at };
    at += current.durationFrames;
  }
}

/**
 * Overwrite [start, end) on a track: covered clips are trimmed, split or removed.
 * @param clips - The clips being planned, updated in place.
 * @param trackId - The track.
 * @param range - The covered interval.
 * @param range.start - Its first frame.
 * @param range.end - Its exclusive end frame.
 * @param keepId - The clip doing the covering.
 * @param effects - Where to record what changed.
 * @param effects.newId - Supplies ids for the right part of a clip covered in the middle.
 * @param effects.offset - The source offset of a cut.
 * @param effects.casualties - Clips this overwrite changed or created.
 * @param effects.origins - New clip id to the clip it was cut from.
 * @param effects.created - New clip ids.
 * @throws {Refused} When a cut does not land on a whole source frame.
 */
function overwrite(
  clips: Record<string, TimelineVideoClip>, trackId: string, range: { start: number; end: number }, keepId: string,
  effects: { newId: () => string; offset: (clip: TimelineVideoClip, frames: number) => number; casualties: Set<string>; origins: Map<string, string>; created: string[] },
): void {
  const { start, end } = range;
  for (const clip of orderedTimelineClips(clips, trackId)) {
    if (clip.id === keepId || endOf(clip) <= start || clip.startFrame >= end) continue;
    effects.casualties.add(clip.id);
    const clipEnd = endOf(clip);
    if (clip.startFrame >= start && clipEnd <= end) {
      delete clips[clip.id];
    } else if (clip.startFrame < start && clipEnd > end) {
      const rightId = effects.newId();
      clips[rightId] = { ...clip, id: rightId, startFrame: end, sourceInFrame: clip.sourceInFrame + effects.offset(clip, end - clip.startFrame), durationFrames: clipEnd - end };
      effects.casualties.add(rightId);
      effects.origins.set(rightId, clip.id);
      effects.created.push(rightId);
      clips[clip.id] = { ...clip, durationFrames: start - clip.startFrame };
    } else if (clip.startFrame < start) {
      clips[clip.id] = { ...clip, durationFrames: start - clip.startFrame };
    } else {
      clips[clip.id] = { ...clip, startFrame: end, sourceInFrame: clip.sourceInFrame + effects.offset(clip, end - clip.startFrame), durationFrames: clipEnd - end };
    }
  }
}

/**
 * Visual non-main clips mapped to the main clip whose interval holds their start.
 * @param document - The document before the edit.
 * @returns Attached clip id to main clip id.
 * @throws {never} Never.
 */
function attachments(document: TimelineDocumentV1): Map<string, string> {
  const main = orderedTimelineClips(document.clips, TIMELINE_MAIN_TRACK_ID);
  const result = new Map<string, string>();
  for (const clip of Object.values(document.clips)) {
    if (clip.trackId === TIMELINE_MAIN_TRACK_ID || document.tracks[clip.trackId]?.kind !== 'visual') continue;
    const anchor = main.find((item) => item.startFrame <= clip.startFrame && clip.startFrame < endOf(item));
    if (anchor) result.set(clip.id, anchor.id);
  }
  return result;
}

/**
 * Integer fields, a non-negative safe start and end, a positive duration and a present source.
 * @param clip - The clip.
 * @param sources - The document's sources.
 * @returns Whether every stored clip may hold these values.
 * @throws {never} Never.
 */
function wellFormed(clip: TimelineVideoClip, sources: Record<string, TimelineVideoSource>): boolean {
  return sources[clip.sourceId] !== undefined && timelineClipIntervalValid(clip);
}

/**
 * Plan one edit against the current document without changing it.
 * @param current - The complete current document.
 * @param command - The normalized edit, with the editing user's placement switches.
 * @param newId - Supplies ids for clips cut by an overwrite and tracks created by a linkage bump.
 * @returns The next document and what changed, or why the edit was refused.
 * @throws {Error} When `newId` throws.
 */
export function planTimelineEdit(current: TimelineDocumentV1, command: TimelineEditCommand, newId: () => string): TimelineEditPlan {
  try {
    return planOrThrow(current, command, newId);
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }
}

/**
 * The body of `planTimelineEdit`, refusing by throwing `Refused`.
 * @param current - The complete current document.
 * @param command - The normalized edit.
 * @param newId - Supplies ids for cut clips and bump tracks.
 * @returns The accepted plan.
 * @throws {Refused} When the edit is refused.
 */
function planOrThrow(current: TimelineDocumentV1, command: TimelineEditCommand, newId: () => string): Extract<TimelineEditPlan, { ok: true }> {
  const { magnet, linkage } = command.placement;
  const tracks: Record<string, TimelineTrack> = { ...current.tracks };
  const clips: Record<string, TimelineVideoClip> = { ...current.clips };
  const sources: Record<string, TimelineVideoSource> = { ...current.sources };
  const created: string[] = [];
  /**
   * The accepted plan for the records built so far.
   * @param bumped - Clips a linkage bump moved to another track.
   * @returns The plan.
   * @throws {never} Never.
   */
  function done(bumped: string[] = []): Extract<TimelineEditPlan, { ok: true }> {
    return { ok: true, next: { ...current, tracks, clips, sources }, created, bumped };
  }
  /**
   * The order for a new top track.
   * @returns One above the highest current order.
   * @throws {never} Never.
   */
  function nextOrder(): number {
    return Math.max(-1, ...Object.values(tracks).map((track) => track.order)) + 1;
  }

  if (command.operation === 'delete_track') {
    const { trackId } = command.parameters;
    if (trackId === TIMELINE_MAIN_TRACK_ID) throw new Refused('main_track');
    if (tracks[trackId] === undefined) throw new Refused('track_missing');
    if (Object.values(clips).some((clip) => clip.trackId === trackId)) throw new Refused('track_not_empty');
    delete tracks[trackId];
    return done();
  }

  const parameters = command.parameters as { newClipId?: string; newTrackId?: string };
  for (const id of [parameters.newClipId, parameters.newTrackId]) {
    if (id !== undefined && (current.clips[id] !== undefined || current.tracks[id] !== undefined)) throw new Refused('id_taken');
  }
  const subjectId = command.operation === 'add_video' ? command.parameters.clip.id : command.parameters.clipId;
  const original = current.clips[subjectId];
  if (command.operation === 'add_video') {
    if (original !== undefined) throw new Refused('id_taken');
    const { source, clip } = command.parameters;
    if (sources[source.id] === undefined && clip.sourceId === source.id) sources[source.id] = source;
  } else if (original === undefined) {
    throw new Refused('target_missing');
  }

  const places = command.operation === 'add_video' || command.operation === 'move' || command.operation === 'duplicate';
  let targetTrackId = command.operation === 'add_video' ? command.parameters.clip.trackId : original?.trackId ?? '';
  if (parameters.newTrackId !== undefined) {
    tracks[parameters.newTrackId] = { id: parameters.newTrackId, kind: 'visual', order: nextOrder() };
    targetTrackId = parameters.newTrackId;
  } else if (command.operation === 'move' && command.parameters.trackId !== undefined) {
    targetTrackId = command.parameters.trackId;
  }
  if (places && tracks[targetTrackId]?.kind !== 'visual') throw new Refused('track_missing');
  const subjectSource = command.operation === 'add_video' ? command.parameters.clip.sourceId : original?.sourceId ?? '';
  if (command.operation !== 'delete' && sources[subjectSource] === undefined) throw new Refused('source_unavailable');

  const attached = linkage ? attachments(current) : new Map<string, string>();
  const fps = current.settings.fps;
  /**
   * The source frames a cut `frames` into a clip advances its in-point.
   * @param clip - The cut clip.
   * @param frames - Timeline frames kept before the cut.
   * @returns The source offset.
   * @throws {Refused} When the source is missing or the cut does not land on a whole source frame.
   */
  const offset = (clip: TimelineVideoClip, frames: number): number => {
    const source = sources[clip.sourceId];
    const value = source === undefined ? null : timelineSourceOffset(clip, source, fps, frames);
    if (value === null) throw new Refused('invalid_range');
    return value;
  };
  const effects = { newId, offset, casualties: new Set<string>(), origins: new Map<string, string>(), created };
  const deletedByUser = new Set<string>();
  let explicitId: string | null = null;

  if (command.operation === 'split' && original !== undefined) {
    const { frame, newClipId } = command.parameters;
    if (!(original.startFrame < frame && frame < endOf(original))) throw new Refused('invalid_range');
    const kept = frame - original.startFrame;
    clips[newClipId] = { ...original, id: newClipId, startFrame: frame, sourceInFrame: original.sourceInFrame + effects.offset(original, kept), durationFrames: original.durationFrames - kept };
    clips[original.id] = { ...original, durationFrames: kept };
    created.push(newClipId);
    effects.origins.set(newClipId, original.id);
    if (original.trackId === TIMELINE_MAIN_TRACK_ID && magnet) pack(clips, orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID));
  } else if (command.operation === 'delete' && original !== undefined) {
    delete clips[original.id];
    deletedByUser.add(original.id);
    if (original.trackId === TIMELINE_MAIN_TRACK_ID && magnet) pack(clips, orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID));
  } else {
    let subject: TimelineVideoClip;
    if (command.operation === 'add_video') {
      subject = { ...command.parameters.clip, trackId: targetTrackId };
      created.push(subject.id);
      explicitId = subject.id;
    } else if (command.operation === 'duplicate' && original !== undefined) {
      subject = { ...original, id: command.parameters.newClipId, startFrame: endOf(original) };
      created.push(subject.id);
      effects.origins.set(subject.id, original.id);
      explicitId = subject.id;
    } else if (command.operation === 'move' && original !== undefined) {
      subject = { ...original, trackId: targetTrackId, startFrame: command.parameters.startFrame };
    } else if (command.operation === 'set_range' && original !== undefined) {
      const { startFrame, sourceInFrame, durationFrames } = command.parameters;
      subject = { ...original, startFrame, sourceInFrame, durationFrames };
      explicitId = subject.id;
    } else {
      throw new Refused('target_missing');
    }
    delete clips[subject.id];
    const leftMain = original !== undefined && original.trackId === TIMELINE_MAIN_TRACK_ID && command.operation !== 'duplicate';
    if (subject.trackId === TIMELINE_MAIN_TRACK_ID && magnet) {
      const sequence = orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID);
      let index: number;
      if (command.operation === 'set_range' && leftMain) index = orderedTimelineClips(current.clips, TIMELINE_MAIN_TRACK_ID).findIndex((clip) => clip.id === subject.id);
      else if (command.operation === 'duplicate' && original?.trackId === TIMELINE_MAIN_TRACK_ID) index = sequence.findIndex((clip) => clip.id === original.id) + 1;
      else index = timelineInsertionIndex(sequence, subject.startFrame);
      clips[subject.id] = subject;
      sequence.splice(index, 0, subject);
      pack(clips, sequence);
    } else {
      if (leftMain && magnet) pack(clips, orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID));
      overwrite(clips, subject.trackId, { start: subject.startFrame, end: endOf(subject) }, subject.id, effects);
      clips[subject.id] = subject;
    }
  }

  // Linkage: clips attached to a main clip that moved as a whole move with it, including a trimmed or
  // split clip that packing moved; clips attached to a main clip the user deleted go with it.
  const shifted: string[] = [];
  const trimmedSubject = command.operation === 'set_range' || command.operation === 'split';
  for (const [attachedId, anchorId] of attached) {
    const attachedClip = clips[attachedId];
    if (attachedId === subjectId || effects.casualties.has(attachedId) || attachedClip === undefined) continue;
    if (deletedByUser.has(anchorId)) {
      delete clips[attachedId];
      continue;
    }
    const was = current.clips[anchorId];
    const now = clips[anchorId];
    if (was === undefined || now === undefined || now.trackId !== TIMELINE_MAIN_TRACK_ID || effects.casualties.has(anchorId)
      || (trimmedSubject && anchorId === subjectId && !magnet)) continue;
    const delta = now.startFrame - was.startFrame;
    if (delta !== 0) {
      clips[attachedId] = { ...attachedClip, startFrame: attachedClip.startFrame + delta };
      shifted.push(attachedId);
    }
  }

  // A shifted clip that lands on another clip keeps its time and moves to the first free visual track above.
  const bumped: string[] = [];
  const shiftedInOrder = shifted.map((id) => clips[id]).filter((clip): clip is TimelineVideoClip => clip !== undefined)
    .sort((a, b) => a.startFrame - b.startFrame || compareTimelineIds(a.id, b.id));
  for (const moved of shiftedInOrder) {
    /**
     * Whether the moved clip would overlap a clip on a track.
     * @param trackId - The track to test.
     * @returns True when another clip there intersects it.
     * @throws {never} Never.
     */
    function collides(trackId: string): boolean {
      return orderedTimelineClips(clips, trackId).some((other) => other.id !== moved.id && other.startFrame < endOf(moved) && moved.startFrame < endOf(other));
    }
    if (!collides(moved.trackId)) continue;
    const ordered = orderedTimelineTracks(tracks);
    const from = ordered.findIndex((track) => track.id === moved.trackId);
    let trackId = ordered
      .find((track, rank) => track.kind === 'visual' && track.id !== TIMELINE_MAIN_TRACK_ID && rank > from && !collides(track.id))?.id;
    if (trackId === undefined) {
      trackId = newId();
      tracks[trackId] = { id: trackId, kind: 'visual', order: nextOrder() };
    }
    clips[moved.id] = { ...moved, trackId };
    bumped.push(moved.id);
  }

  // A local edit adds no new conflict: overwrite, packing and bumps leave no new overlapped frame, a range the
  // user sets must lie inside its source, and every other changed clip may keep, never grow, the out-of-source
  // frames of the clip it came from. Merge conflicts stay until the user resolves them.
  for (const clip of Object.values(clips)) {
    const was = current.clips[clip.id];
    if (was !== undefined && RANGE_FIELDS.every((field) => was[field] === clip[field])) continue;
    if (!wellFormed(clip, sources)) throw new Refused('invalid_range');
    const source = sources[clip.sourceId] as TimelineVideoSource;
    const from = was ?? current.clips[effects.origins.get(clip.id) ?? ''];
    const fromSource = from === undefined ? undefined : current.sources[from.sourceId];
    const allowed = clip.id === explicitId || from === undefined || fromSource === undefined ? 0 : timelineSourceOverflow(from, fromSource, fps);
    if (timelineSourceOverflow(clip, source, fps) > allowed) throw new Refused('invalid_range');
  }
  return done(bumped);
}
