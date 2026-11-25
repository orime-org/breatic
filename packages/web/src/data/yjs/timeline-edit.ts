// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { z } from 'zod';
import {
  TIMELINE_FRAME_PRESETS, TIMELINE_FRAME_PRESET_KEYS, TIMELINE_LAYER_TRANSFORM_LIMITS, TIMELINE_MAIN_TRACK_ID, TimelineAudioClipSchema, TimelineClipSchema,
  TimelineImageClipSchema, TimelineRateSchema, TimelineSourceSchema, TimelineTextClipSchema, TimelineUploadClipSchema, TimelineVideoClipSchema,
  type TimelineClip, type TimelineDocumentV1, type TimelineSource, type TimelineTextClip, type TimelineTrack,
  type TimelineWebAnimationClip, type TimelineWebAnimationContentBinding, type TimelineWebResolution,
} from '@breatic/shared';

import type { SpaceRefusal } from '@web/data/yjs/space-write';
import { EMPTY_TIMELINE_WEB_RESOLUTION, arrangeTimelineClips, resolveTimelineClipExtent } from '@web/data/yjs/timeline-arrangement';
import { isDrawnTimelineClip } from '@web/data/yjs/timeline-layers';
import { compareTimelineIds, orderedTimelineClips, orderedTimelineTracks } from '@web/data/yjs/timeline-order';
import {
  timelineClipIntervalValid, timelineSourceOffset, timelineSourceOverflow, timelineSourceRoom, type TimelineSourceExtent,
} from '@web/data/yjs/timeline-time';

// The command bounds are the persisted clip format's own field schemas.
const {
  startFrame: safeFrame, durationFrames: positiveInteger, id: identity, trackId: trackIdentity, gain: gainSchema, mute: muteSchema,
} = TimelineVideoClipSchema.shape;
const { text: textSchema } = TimelineTextClipSchema.shape;
const placement = z.object({ magnet: z.boolean(), linkage: z.boolean() }).strict();
// The new copy's own extent, carried like add_media carries its source (inner#1711 design §3.3): the result's length.
const webExtent = z.object({ durationFrames: positiveInteger, fps: TimelineRateSchema }).strict();

const { scale, rotation } = TIMELINE_LAYER_TRANSFORM_LIMITS;
// Scale and rotation bounds are the command's data boundary; frame offsets are bounded in planning.
const transformSchema = z.object({
  frameX: z.number(),
  frameY: z.number(),
  scaleX: z.number().min(scale.min).max(scale.max),
  scaleY: z.number().min(scale.min).max(scale.max),
  rotation: z.number().min(rotation.min).max(rotation.max),
}).strict();

/** The rate, gain, mute and transform every newly placed clip starts with. */
export const TIMELINE_DEFAULT_PLACEMENT = {
  rate: { num: 1, den: 1 }, gain: 1, mute: false, transform: { frameX: 0, frameY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
} as const;

/** The editing user's local placement switches, carried with each command. */
export type TimelineEditPlacement = z.infer<typeof placement>;

/** A normalized user-confirmed native edit. */
export const TimelineEditCommandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('add_media'),
    parameters: z.object({
      source: TimelineSourceSchema,
      clip: z.discriminatedUnion('kind', [TimelineVideoClipSchema, TimelineImageClipSchema, TimelineAudioClipSchema]),
      newTrackId: trackIdentity.optional(),
    }).strict(),
    placement,
  }).strict(),
  z.object({
    operation: z.literal('add_upload'),
    parameters: z.object({ clip: TimelineUploadClipSchema, newTrackId: trackIdentity.optional() }).strict(),
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
  z.object({ operation: z.literal('set_transform'), parameters: z.object({ clipId: identity, transform: transformSchema }).strict(), placement }).strict(),
  z.object({ operation: z.literal('delete_track'), parameters: z.object({ trackId: trackIdentity }).strict(), placement }).strict(),
  z.object({ operation: z.literal('set_frame'), parameters: z.object({ preset: z.enum(TIMELINE_FRAME_PRESET_KEYS) }).strict(), placement }).strict(),
  z.object({
    operation: z.literal('add_web_animation'),
    parameters: z.object({
      clipId: identity, startFrame: safeFrame, newTrackId: trackIdentity, extent: webExtent, from: z.object({ sourceVersionId: z.uuid() }).strict(),
    }).strict(),
    placement,
  }).strict(),
  z.object({
    operation: z.literal('add_text'),
    parameters: z.object({ clipId: identity, startFrame: safeFrame, newTrackId: trackIdentity, text: textSchema, durationFrames: positiveInteger }).strict(),
    placement,
  }).strict(),
  z.object({ operation: z.literal('set_text'), parameters: z.object({ clipId: identity, text: textSchema }).strict(), placement }).strict(),
  z.object({ operation: z.literal('set_audio'), parameters: z.object({ clipId: identity, gain: gainSchema, mute: muteSchema }).strict(), placement }).strict(),
]);

/** An edit to the Timeline's collaborative layout. */
export type TimelineEditCommand = z.infer<typeof TimelineEditCommandSchema>;

/** Why a local edit was not applied. */
export type TimelineEditRefusal = 'target_missing' | 'track_missing' | 'invalid_range' | 'id_taken'
  | 'main_track' | 'track_not_empty' | 'source_unavailable' | 'missing_source' | 'source_unresolved';

/** The planned next document, or why the edit was refused: by the layout, or by the Space's size (inner#1790). */
export type TimelineEditPlan =
  | { ok: true; next: TimelineDocumentV1; created: string[]; bumped: string[] }
  | { ok: false; reason: TimelineEditRefusal }
  | SpaceRefusal;

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
function endOf(clip: TimelineClip): number {
  return clip.startFrame + clip.durationFrames;
}

/**
 * Index in a main-track sequence where a clip dropped at `frame` goes: the clips whose midpoint is not after it.
 * @param sequence - The main-track clips without the dropped one.
 * @param frame - The drop frame.
 * @returns The insertion index.
 * @throws {never} Never.
 */
export function timelineInsertionIndex(sequence: readonly TimelineClip[], frame: number): number {
  return sequence.filter((clip) => clip.startFrame * 2 + clip.durationFrames <= frame * 2).length;
}

/**
 * Place a sequence end to end from frame 0.
 * @param clips - The clips being planned, updated in place.
 * @param sequence - The order to pack.
 * @throws {never} Never.
 */
function pack(clips: Record<string, TimelineClip>, sequence: readonly TimelineClip[]): void {
  let at = 0;
  for (const item of sequence) {
    const current = clips[item.id];
    if (current === undefined) continue;
    clips[item.id] = { ...current, startFrame: at };
    at += current.durationFrames;
  }
}

/**
 * Overwrite [start, end) on a track: covered clips are trimmed, split or removed. A clip that cannot be shown is never
 * measured against its source (inner#1709): it loses its tail, or is deleted when its head is covered,
 * and keeps only its left part when its middle is covered.
 * @param tables - The clips being planned, updated in place.
 * @param tables.clips - The clips that can be shown.
 * @param tables.hidden - The clips that cannot be shown.
 * @param trackId - The track.
 * @param range - The covered interval.
 * @param range.start - Its first frame.
 * @param range.end - Its exclusive end frame.
 * @param keepId - The clip doing the covering.
 * @param effects - Where to record what changed.
 * @param effects.newId - Supplies ids for the right part of a clip covered in the middle.
 * @param effects.offset - The source offset of a cut.
 * @param effects.casualties - Clips this overwrite changed or created.
 * @param effects.created - New clip ids.
 * @throws {Refused} When a cut does not land on a whole source frame.
 */
function overwrite(
  tables: { clips: Record<string, TimelineClip>; hidden: Record<string, TimelineClip> }, trackId: string, range: { start: number; end: number }, keepId: string,
  effects: { newId: () => string; offset: (clip: TimelineClip, frames: number) => number; casualties: Set<string>; created: string[] },
): void {
  const { clips, hidden } = tables;
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
      effects.created.push(rightId);
      clips[clip.id] = { ...clip, durationFrames: start - clip.startFrame };
    } else if (clip.startFrame < start) {
      clips[clip.id] = { ...clip, durationFrames: start - clip.startFrame };
    } else {
      clips[clip.id] = { ...clip, startFrame: end, sourceInFrame: clip.sourceInFrame + effects.offset(clip, end - clip.startFrame), durationFrames: clipEnd - end };
    }
  }
  for (const clip of orderedTimelineClips(hidden, trackId)) {
    if (endOf(clip) <= start || clip.startFrame >= end) continue;
    if (clip.startFrame >= start) delete hidden[clip.id];
    else hidden[clip.id] = { ...clip, durationFrames: start - clip.startFrame };
  }
}

/**
 * Non-main clips mapped to the main clip whose interval holds their start.
 * @param clips - The clips that can be shown, before the edit.
 * @returns Attached clip id to main clip id.
 * @throws {never} Never.
 */
function attachments(clips: Record<string, TimelineClip>): Map<string, string> {
  const main = orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID);
  const result = new Map<string, string>();
  for (const clip of Object.values(clips)) {
    if (clip.trackId === TIMELINE_MAIN_TRACK_ID) continue;
    const anchor = main.find((item) => item.startFrame <= clip.startFrame && clip.startFrame < endOf(item));
    if (anchor) result.set(clip.id, anchor.id);
  }
  return result;
}

/**
 * The track a new web-animation copy or text goes on (inner#1711 design §3.3, inner#1709): the first track
 * above the highest clip over its span that `raises` counts (above the main track when there is none) that holds no
 * clip over the span. It never moves or trims a clip.
 * @param tracks - The tracks.
 * @param clips - The clips that can be shown.
 * @param span - The new clip's frames.
 * @param span.start - Its first frame.
 * @param span.end - Its exclusive end frame.
 * @param raises - Which clips over the span the new clip must go above.
 * @returns The free track's id, or null when a new top track is needed.
 * @throws {never} Never.
 */
function placeOnFreeTrack(
  tracks: Record<string, TimelineTrack>, clips: Record<string, TimelineClip>, span: { start: number; end: number }, raises: (clip: TimelineClip) => boolean,
): string | null {
  const ordered = orderedTimelineTracks(tracks);
  const rank = new Map(ordered.map((track, index) => [track.id, index]));
  const over = Object.values(clips).filter((clip) => clip.startFrame < span.end && span.start < endOf(clip));
  let floor = rank.get(TIMELINE_MAIN_TRACK_ID) ?? -1;
  for (const clip of over) if (raises(clip)) floor = Math.max(floor, rank.get(clip.trackId) ?? -1);
  return ordered.find((track, index) => index > floor && track.id !== TIMELINE_MAIN_TRACK_ID && !over.some((clip) => clip.trackId === track.id))?.id ?? null;
}

/**
 * Whether two records hold the same values.
 * @param a - One record.
 * @param b - The other.
 * @returns True when equal.
 * @throws {never} Never.
 */
function sameRecord(a: object, b: object): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Plan one edit against the current document without changing it.
 * @param current - The complete current document.
 * @param command - The normalized edit, with the editing user's placement switches.
 * @param newId - Supplies ids for clips cut by an overwrite and tracks created by a linkage bump.
 * @param web - The resolution of the document's web-animation references, for the extents of web copies.
 * @returns The next document and what changed, or why the edit was refused.
 * @throws {Error} When `newId` throws.
 */
export function planTimelineEdit(
  current: TimelineDocumentV1, command: TimelineEditCommand, newId: () => string, web: TimelineWebResolution = EMPTY_TIMELINE_WEB_RESOLUTION,
): TimelineEditPlan {
  try {
    return planOrThrow(current, command, newId, web);
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.reason };
    throw err;
  }
}

/**
 * The body of `planTimelineEdit`, refusing by throwing `Refused`. It plans on two tables (inner#1709): the
 * clip view, which every layout rule reads, and the clips that cannot be shown, which only an overwrite, a track
 * deletion and main-track packing reach. The plan is written back over the stored clips: a clip changed in either
 * table takes its new value, a deleted one goes, and every other clip keeps its stored value.
 * @param current - The complete current document.
 * @param command - The normalized edit.
 * @param newId - Supplies ids for cut clips and bump tracks.
 * @param web - The resolution of web references.
 * @returns The accepted plan.
 * @throws {Refused} When the edit is refused.
 */
function planOrThrow(current: TimelineDocumentV1, command: TimelineEditCommand, newId: () => string, web: TimelineWebResolution): Extract<TimelineEditPlan, { ok: true }> {
  const { magnet, linkage } = command.placement;
  const tracks: Record<string, TimelineTrack> = { ...current.tracks };
  const before = arrangeTimelineClips(current, web);
  const hiddenBefore: Record<string, TimelineClip> = Object.fromEntries(Object.entries(current.clips).filter(([id]) => !Object.hasOwn(before, id)));
  const clips: Record<string, TimelineClip> = { ...before };
  const hidden: Record<string, TimelineClip> = { ...hiddenBefore };
  const sources: Record<string, TimelineSource> = { ...current.sources };
  const created: string[] = [];
  /**
   * The accepted plan for the records built so far, written back over the stored clips.
   * @param bumped - Clips a linkage bump moved to another track.
   * @returns The plan.
   * @throws {Refused} When a changed clip is not a record the schema takes.
   */
  function done(bumped: string[] = []): Extract<TimelineEditPlan, { ok: true }> {
    const written: Record<string, TimelineClip> = { ...current.clips };
    for (const [now, was] of [[clips, before], [hidden, hiddenBefore]] as const) {
      for (const id of Object.keys(was)) if (now[id] === undefined) delete written[id];
      for (const [id, clip] of Object.entries(now)) {
        const old = was[id];
        if (old !== undefined && sameRecord(old, clip)) continue;
        if (!TimelineClipSchema.safeParse(clip).success) throw new Refused('invalid_range');
        written[id] = clip;
      }
    }
    return { ok: true, next: { ...current, tracks, clips: written, sources }, created, bumped };
  }
  /**
   * The order for a new top track.
   * @returns One above the highest current order.
   * @throws {never} Never.
   */
  function nextOrder(): number {
    return Math.max(-1, ...Object.values(tracks).map((track) => track.order)) + 1;
  }
  /**
   * Whether an id names a stored clip or track.
   * @param id - The id.
   * @returns True when taken.
   * @throws {never} Never.
   */
  function taken(id: string): boolean {
    return current.clips[id] !== undefined || current.tracks[id] !== undefined;
  }
  /**
   * Put a new clip on the first free track above the clips `raises` counts, or on the new top track `newTrackId`.
   * @param span - The clip's frames.
   * @param span.start - Its first frame.
   * @param span.end - Its exclusive end frame.
   * @param newTrackId - The id a new top track takes.
   * @param raises - Which clips the new clip goes above.
   * @returns The track id.
   * @throws {Refused} When a new track is needed and its id is taken.
   */
  function freeTrack(span: { start: number; end: number }, newTrackId: string, raises: (clip: TimelineClip) => boolean): string {
    const trackId = placeOnFreeTrack(tracks, clips, span, raises);
    if (trackId !== null) return trackId;
    if (taken(newTrackId)) throw new Refused('id_taken');
    tracks[newTrackId] = { id: newTrackId, order: nextOrder() };
    return newTrackId;
  }

  /**
   * The extent a clip is measured against, reading sources from the given table.
   * @param from - The sources to read.
   * @param clip - The clip.
   * @returns Its extent, or undefined when its source is missing or its web reference unresolved.
   * @throws {never} Never.
   */
  const extentIn = (from: Record<string, TimelineSource>, clip: TimelineClip): TimelineSourceExtent | undefined =>
    resolveTimelineClipExtent({ ...current, sources: from }, web, clip);

  if (command.operation === 'add_web_animation') {
    const { clipId, startFrame, newTrackId, extent, from } = command.parameters;
    const binding: TimelineWebAnimationContentBinding = { baseSourceResultId: from.sourceVersionId, operationId: null };
    if (taken(clipId)) throw new Refused('id_taken');
    const source = { timebase: extent.fps, extentFrames: extent.durationFrames };
    const draft: TimelineWebAnimationClip = {
      id: clipId, trackId: '', kind: 'web-animation', contentBinding: binding, startFrame, sourceInFrame: 0, durationFrames: 1,
      ...TIMELINE_DEFAULT_PLACEMENT,
    };
    const durationFrames = timelineSourceRoom(draft, source, current.settings.fps);
    // A web copy goes above the drawn clips other than web copies (design §2.4).
    const trackId = freeTrack({ start: startFrame, end: startFrame + durationFrames }, newTrackId, (clip) => clip.kind !== 'web-animation' && isDrawnTimelineClip(clip));
    const placed = { ...draft, trackId, durationFrames };
    if (!timelineClipIntervalValid(placed)) throw new Refused('invalid_range');
    clips[clipId] = placed;
    created.push(clipId);
    return done();
  }

  if (command.operation === 'add_text') {
    const { clipId, startFrame, newTrackId, text, durationFrames } = command.parameters;
    if (taken(clipId)) throw new Refused('id_taken');
    const trackId = freeTrack({ start: startFrame, end: startFrame + durationFrames }, newTrackId, isDrawnTimelineClip);
    const placed: TimelineTextClip = { id: clipId, trackId, kind: 'text', text, startFrame, sourceInFrame: 0, durationFrames, ...TIMELINE_DEFAULT_PLACEMENT };
    if (!timelineClipIntervalValid(placed)) throw new Refused('invalid_range');
    clips[clipId] = placed;
    created.push(clipId);
    return done();
  }

  if (command.operation === 'set_frame') {
    const size = TIMELINE_FRAME_PRESETS[command.parameters.preset];
    const plan = done();
    if (size.width === current.settings.width && size.height === current.settings.height) return plan;
    return { ...plan, next: { ...plan.next, settings: { ...current.settings, width: size.width, height: size.height } } };
  }

  if (command.operation === 'set_transform') {
    const { clipId, transform } = command.parameters;
    const clip = clips[clipId];
    if (clip === undefined) throw new Refused('target_missing');
    const reach = TIMELINE_LAYER_TRANSFORM_LIMITS.offsetCanvasMultiple;
    if (Math.abs(transform.frameX) > reach || Math.abs(transform.frameY) > reach) throw new Refused('invalid_range');
    clips[clipId] = { ...clip, transform };
    return done();
  }

  if (command.operation === 'set_text') {
    const clip = clips[command.parameters.clipId];
    if (clip?.kind !== 'text') throw new Refused('target_missing');
    clips[clip.id] = { ...clip, text: command.parameters.text };
    return done();
  }

  if (command.operation === 'set_audio') {
    const clip = clips[command.parameters.clipId];
    if (clip?.kind !== 'video' && clip?.kind !== 'audio') throw new Refused('target_missing');
    clips[clip.id] = { ...clip, gain: command.parameters.gain, mute: command.parameters.mute };
    return done();
  }

  if (command.operation === 'delete_track') {
    const { trackId } = command.parameters;
    if (trackId === TIMELINE_MAIN_TRACK_ID) throw new Refused('main_track');
    if (tracks[trackId] === undefined) throw new Refused('track_missing');
    if (Object.values(clips).some((clip) => clip.trackId === trackId)) throw new Refused('track_not_empty');
    for (const clip of Object.values(hidden)) if (clip.trackId === trackId) delete hidden[clip.id];
    delete tracks[trackId];
    return done();
  }

  const parameters = command.parameters as { newClipId?: string; newTrackId?: string };
  for (const id of [parameters.newClipId, parameters.newTrackId]) {
    if (id !== undefined && taken(id)) throw new Refused('id_taken');
  }
  const adds = command.operation === 'add_media' || command.operation === 'add_upload';
  const subjectId = adds ? command.parameters.clip.id : command.parameters.clipId;
  const original = clips[subjectId];
  if (adds) {
    if (current.clips[subjectId] !== undefined) throw new Refused('id_taken');
    if (command.operation === 'add_media') {
      const { source, clip } = command.parameters;
      if (sources[source.id] === undefined && clip.sourceId === source.id) sources[source.id] = source;
    }
  } else if (original === undefined) {
    throw new Refused('target_missing');
  }

  const places = adds || command.operation === 'move' || command.operation === 'duplicate';
  let targetTrackId = adds ? command.parameters.clip.trackId : original?.trackId ?? '';
  if (parameters.newTrackId !== undefined) {
    tracks[parameters.newTrackId] = { id: parameters.newTrackId, order: nextOrder() };
    targetTrackId = parameters.newTrackId;
  } else if (command.operation === 'move' && command.parameters.trackId !== undefined) {
    targetTrackId = command.parameters.trackId;
  }
  if (places && tracks[targetTrackId] === undefined) throw new Refused('track_missing');
  const added = adds ? command.parameters.clip : original;
  if (command.operation !== 'delete' && added !== undefined && extentIn(sources, added) === undefined) {
    throw new Refused(original === undefined ? 'source_unavailable' : original.kind === 'web-animation' ? 'source_unresolved' : 'missing_source');
  }

  const attached = linkage ? attachments(before) : new Map<string, string>();
  const fps = current.settings.fps;
  /**
   * The source frames a cut `frames` into a clip advances its in-point; a still's stays 0.
   * @param clip - The cut clip.
   * @param frames - Timeline frames kept before the cut.
   * @returns The source offset.
   * @throws {Refused} When the source is unresolved, or the cut does not land on a whole source frame.
   */
  const offset = (clip: TimelineClip, frames: number): number => {
    const source = extentIn(sources, clip);
    if (source === undefined) throw new Refused(clip.kind === 'web-animation' ? 'source_unresolved' : 'missing_source');
    const value = timelineSourceOffset(clip, source, fps, frames);
    if (value === null) throw new Refused('invalid_range');
    return value;
  };
  const effects = { newId, offset, casualties: new Set<string>(), created };
  const tables = { clips, hidden };
  /**
   * Pack the main track end to end; the clips there that cannot be shown go (design §3.5).
   * @param sequence - The order to pack.
   * @throws {never} Never.
   */
  const packMain = (sequence: readonly TimelineClip[]): void => {
    pack(clips, sequence);
    for (const clip of Object.values(hidden)) if (clip.trackId === TIMELINE_MAIN_TRACK_ID) delete hidden[clip.id];
  };
  const deletedByUser = new Set<string>();

  if (command.operation === 'split' && original !== undefined) {
    const { frame, newClipId } = command.parameters;
    if (!(original.startFrame < frame && frame < endOf(original))) throw new Refused('invalid_range');
    const kept = frame - original.startFrame;
    clips[newClipId] = { ...original, id: newClipId, startFrame: frame, sourceInFrame: original.sourceInFrame + effects.offset(original, kept), durationFrames: original.durationFrames - kept };
    clips[original.id] = { ...original, durationFrames: kept };
    created.push(newClipId);
    if (original.trackId === TIMELINE_MAIN_TRACK_ID && magnet) packMain(orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID));
  } else if (command.operation === 'delete' && original !== undefined) {
    delete clips[original.id];
    deletedByUser.add(original.id);
    if (original.trackId === TIMELINE_MAIN_TRACK_ID && magnet) packMain(orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID));
  } else {
    let subject: TimelineClip;
    if (adds) {
      subject = { ...command.parameters.clip, trackId: targetTrackId };
      created.push(subject.id);
    } else if (command.operation === 'duplicate' && original !== undefined) {
      subject = { ...original, id: command.parameters.newClipId, startFrame: endOf(original) };
      created.push(subject.id);
    } else if (command.operation === 'move' && original !== undefined) {
      subject = { ...original, trackId: targetTrackId, startFrame: command.parameters.startFrame };
    } else if (command.operation === 'set_range' && original !== undefined) {
      const { startFrame, sourceInFrame, durationFrames } = command.parameters;
      subject = { ...original, startFrame, sourceInFrame, durationFrames };
    } else {
      throw new Refused('target_missing');
    }
    delete clips[subject.id];
    const leftMain = original !== undefined && original.trackId === TIMELINE_MAIN_TRACK_ID && command.operation !== 'duplicate';
    if (subject.trackId === TIMELINE_MAIN_TRACK_ID && magnet) {
      const sequence = orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID);
      let index: number;
      if (command.operation === 'set_range' && leftMain) index = orderedTimelineClips(before, TIMELINE_MAIN_TRACK_ID).findIndex((clip) => clip.id === subject.id);
      else if (command.operation === 'duplicate' && original?.trackId === TIMELINE_MAIN_TRACK_ID) index = sequence.findIndex((clip) => clip.id === original.id) + 1;
      else index = timelineInsertionIndex(sequence, subject.startFrame);
      clips[subject.id] = subject;
      sequence.splice(index, 0, subject);
      packMain(sequence);
    } else {
      if (leftMain && magnet) packMain(orderedTimelineClips(clips, TIMELINE_MAIN_TRACK_ID));
      overwrite(tables, subject.trackId, { start: subject.startFrame, end: endOf(subject) }, subject.id, effects);
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
    const was = before[anchorId];
    const now = clips[anchorId];
    if (was === undefined || now === undefined || now.trackId !== TIMELINE_MAIN_TRACK_ID || effects.casualties.has(anchorId)
      || (trimmedSubject && anchorId === subjectId && !magnet)) continue;
    const delta = now.startFrame - was.startFrame;
    if (delta !== 0) {
      clips[attachedId] = { ...attachedClip, startFrame: attachedClip.startFrame + delta };
      shifted.push(attachedId);
    }
  }

  // A shifted clip that lands on another clip keeps its time and moves to the first free track above.
  const bumped: string[] = [];
  const shiftedInOrder = shifted.map((id) => clips[id]).filter((clip): clip is TimelineClip => clip !== undefined)
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
    let trackId = ordered.find((track, rank) => track.id !== TIMELINE_MAIN_TRACK_ID && rank > from && !collides(track.id))?.id;
    if (trackId === undefined) {
      trackId = newId();
      tracks[trackId] = { id: trackId, order: nextOrder() };
    }
    clips[moved.id] = { ...moved, trackId };
    bumped.push(moved.id);
  }

  // A local edit adds no new conflict: overwrite, packing and bumps leave no new overlapped frame, and every changed
  // clip lies inside its source, as the view already plays it there. A web copy whose range is still unknown may be
  // carried along by packing or linkage, or lose its tail to an overwrite.
  for (const clip of Object.values(clips)) {
    const was = before[clip.id];
    if (was !== undefined && RANGE_FIELDS.every((field) => was[field] === clip[field])) continue;
    if (!timelineClipIntervalValid(clip)) throw new Refused('invalid_range');
    if (was !== undefined && extentIn(sources, was) === undefined && was.sourceInFrame === clip.sourceInFrame
      && clip.durationFrames <= was.durationFrames) continue;
    const source = extentIn(sources, clip);
    if (source === undefined || timelineSourceOverflow(clip, source, fps) > 0) throw new Refused('invalid_range');
  }
  return done(bumped);
}
