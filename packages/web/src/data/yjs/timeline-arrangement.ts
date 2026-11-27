// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import {
  isPresentableTimelineClip, timelineUploadExtent, type TimelineClip, type TimelineDocumentV1, type TimelineRate, type TimelineSource,
  type TimelineWebResolution,
} from '@breatic/shared';

export { timelineUploadExtent } from '@breatic/shared';

import { compareTimelineIds } from '@web/data/yjs/timeline-order';
import { timelineSourceRoom, type TimelineSourceExtent } from '@web/data/yjs/timeline-time';

/** A resolution that knows no reference. */
export const EMPTY_TIMELINE_WEB_RESOLUTION: TimelineWebResolution = Object.freeze({ sources: Object.freeze({}), executions: Object.freeze({}) });

/**
 * The source version a web-animation copy shows now: its bound result, or the result of the execution it waits for
 * once that has succeeded.
 * @param web - The resolution.
 * @param clip - The copy.
 * @returns The source version id, or null while there is none to show.
 * @throws {never} Never.
 */
export function timelineWebSourceOf(web: TimelineWebResolution, clip: Extract<TimelineClip, { kind: 'web-animation' }>): string | null {
  const { baseSourceResultId, operationId } = clip.contentBinding;
  if (baseSourceResultId !== null) return baseSourceResultId;
  const execution = operationId === null ? undefined : web.executions[operationId];
  return execution?.status === 'succeeded' ? execution.resultSourceVersionId : null;
}

/** A picture or a text has no end of its own (inner#1709). */
const UNBOUNDED = Object.freeze({ extentFrames: Number.MAX_SAFE_INTEGER });

/**
 * The extent a clip's frames are measured against (design §3.2, inner#1709): a video's or sound's
 * registered source; no upper bound for a picture or a text; an upload placeholder's local file (no upper bound for a
 * picture); a web copy's bound source version; a placeholder's result once its execution succeeded, otherwise the
 * length its execution accepted.
 * @param document - The document, for its sources and frame rate.
 * @param web - The resolution of web references.
 * @param clip - The clip.
 * @returns The extent, or undefined when the source record is missing or of another kind, or the reference is unresolved.
 * @throws {never} Never.
 */
export function resolveTimelineClipExtent(document: TimelineDocumentV1, web: TimelineWebResolution, clip: TimelineClip): TimelineSourceExtent | undefined {
  if (clip.kind === 'text') return { ...UNBOUNDED, timebase: document.settings.fps };
  if (clip.kind === 'upload') return timelineUploadExtent(document.settings.fps, clip);
  if (clip.kind !== 'web-animation') {
    const source = Object.hasOwn(document.sources, clip.sourceId) ? document.sources[clip.sourceId] : undefined;
    if (source?.kind !== clip.kind) return undefined;
    return source.kind === 'image' ? { ...UNBOUNDED, timebase: document.settings.fps } : source;
  }
  const sourceId = timelineWebSourceOf(web, clip);
  const source = sourceId === null ? undefined : web.sources[sourceId];
  if (source !== undefined) return { timebase: source.fps, extentFrames: source.durationFrames };
  const execution = clip.contentBinding.baseSourceResultId === null && clip.contentBinding.operationId !== null
    ? web.executions[clip.contentBinding.operationId] : undefined;
  return execution === undefined ? undefined : { timebase: execution.fps, extentFrames: execution.acceptedDurationFrames };
}

/**
 * The registered source a clip shows, for reading its asset: a video, picture or sound; text, web-animation and upload
 * clips have none.
 * @param sources - The document's sources.
 * @param clip - The placement.
 * @returns Its source, or undefined when it has none.
 * @throws {never} Never.
 */
export function timelineClipSource(sources: Record<string, TimelineSource>, clip: TimelineClip): TimelineSource | undefined {
  return 'sourceId' in clip && Object.hasOwn(sources, clip.sourceId) ? sources[clip.sourceId] : undefined;
}

/**
 * The clip view (inner#1709): only the clips that can be shown, each at the length it plays. A clip
 * longer than its source is cut to the frames the source holds; one whose range is unknown (a web copy still waiting)
 * keeps its length; one that plays no frame at all is left out.
 * @param document - The stored document.
 * @param web - The resolution of web references.
 * @returns The clips by id.
 * @throws {never} Never.
 */
export function arrangeTimelineClips(document: TimelineDocumentV1, web: TimelineWebResolution): Record<string, TimelineClip> {
  const view: Record<string, TimelineClip> = {};
  for (const [id, clip] of Object.entries(document.clips)) {
    if (!isPresentableTimelineClip(document, clip)) continue;
    const extent = resolveTimelineClipExtent(document, web, clip);
    const room = extent === undefined ? clip.durationFrames : playedFrames(clip, extent, document.settings.fps);
    if (room <= 0) continue;
    view[id] = room < clip.durationFrames ? { ...clip, durationFrames: room } : clip;
  }
  return view;
}

/**
 * The frames of a clip that sample inside its source.
 * @param clip - The clip.
 * @param extent - Its source extent.
 * @param fps - The Timeline frame rate.
 * @returns The played frames, 0 when the clip's rates cannot be read.
 * @throws {never} Never.
 */
function playedFrames(clip: TimelineClip, extent: TimelineSourceExtent, fps: TimelineRate): number {
  try {
    return timelineSourceRoom(clip, extent, fps);
  } catch (err) {
    if (err instanceof RangeError) return 0;
    throw err;
  }
}

/**
 * The one clip of a track that plays at a frame (inner#1709): of the clips covering it, the one starting
 * last, ties by id with the smaller id on top.
 * @param clips - The view's clips.
 * @param trackId - The track.
 * @param frame - The Timeline frame.
 * @returns The clip, or undefined when none covers the frame.
 * @throws {never} Never.
 */
export function pickTimelineClipAt(clips: Readonly<Record<string, TimelineClip>>, trackId: string, frame: number): TimelineClip | undefined {
  let picked: TimelineClip | undefined;
  for (const clip of Object.values(clips)) {
    if (clip.trackId !== trackId || frame < clip.startFrame || frame >= clip.startFrame + clip.durationFrames) continue;
    if (picked === undefined || clip.startFrame > picked.startFrame || (clip.startFrame === picked.startFrame && compareTimelineIds(clip.id, picked.id) < 0)) picked = clip;
  }
  return picked;
}
