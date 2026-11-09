// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as Y from 'yjs';
import {
  durationToFrames, newId as createId, type ProjectRegisteredAsset, type TimelineVideoSource, type TimelineWebResolution,
} from '@breatic/shared';
import {
  attachTimelineRecord as attachRecord, freezeTimelineRecord as freezeRecord, readTimelineDocument, readTimelineSource, timelineRecordJson,
} from '@breatic/shared/space-content';

import { EMPTY_TIMELINE_WEB_RESOLUTION, timelineUploadExtent } from '@web/data/yjs/timeline-arrangement';
import { orderedTimelineClips } from '@web/data/yjs/timeline-order';
import { timelineSourceRoom } from '@web/data/yjs/timeline-time';
import { TimelineEditCommandSchema, planTimelineEdit, type TimelineEditCommand, type TimelineEditPlan } from '@web/data/yjs/timeline-edit';

export { readTimelineContent, readTimelineDocument, type TimelineDamagedRecords } from '@breatic/shared/space-content';

/**
 * Delete one clip record, damaged or not, and the sources no clip names any more, in one transaction; an absent
 * clip writes nothing.
 * @param doc - The content document.
 * @param id - The clip id.
 * @param origin - The transaction origin.
 * @throws {never} Never.
 */
export function removeTimelineClip(doc: Y.Doc, id: string, origin: unknown): void {
  if (!doc.getMap('clips').has(id)) return;
  doc.transact(() => {
    doc.getMap('clips').delete(id);
    reconcileTimelineSources(doc, {}, []);
  }, origin);
}

/**
 * The source id a clip record names, read from the raw record so a damaged record still counts as a reference.
 * @param record - A value of the clips map, or its JSON.
 * @returns Its string `sourceId`, if any.
 * @throws {never} Never.
 */
export function timelineClipSourceId(record: unknown): string | undefined {
  const json = timelineRecordJson(record);
  const id = typeof json === 'object' && json !== null ? (json as { sourceId?: unknown }).sourceId : undefined;
  return typeof id === 'string' ? id : undefined;
}

/**
 * The source ids the clip records name, damaged records included.
 * @param doc - The content document.
 * @returns The referenced source ids.
 * @throws {never} Never.
 */
function timelineReferencedSourceIds(doc: Y.Doc): Set<string> {
  const referenced = new Set<string>();
  doc.getMap<unknown>('clips').forEach((record) => {
    const id = timelineClipSourceId(record);
    if (id !== undefined) referenced.add(id);
  });
  return referenced;
}

/**
 * The referenced sources that `sources` lacks or holds unreadable and `values` holds.
 * @param sources - The sources map.
 * @param referenced - The referenced source ids.
 * @param values - Source values by id that this writer may write.
 * @returns Their ids.
 * @throws {never} Never.
 */
function missingSourceIds(sources: Y.Map<unknown>, referenced: Iterable<string>, values: Readonly<Record<string, TimelineVideoSource>>): string[] {
  // Own keys only: a damaged clip may name any string, including an Object.prototype property.
  return [...referenced].filter((id) => readTimelineSource(sources.get(id), id) === undefined && Object.hasOwn(values, id));
}

/**
 * The referenced sources, damaged clip records included, that `sources` lacks or holds unreadable and `values` holds.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @returns Their ids.
 * @throws {never} Never.
 */
export function missingTimelineSourceIds(doc: Y.Doc, values: Readonly<Record<string, TimelineVideoSource>>): string[] {
  return missingSourceIds(doc.getMap<unknown>('sources'), timelineReferencedSourceIds(doc), values);
}

/**
 * Write referenced sources inside the caller's transaction: the ones in `reset` even when present, and any that is
 * missing, each from `values` when it holds it. Concurrent writes to one key keep only one of them, so a fresh
 * write narrows the window in which a peer's removal leaves a reference without its source; writing back a missing
 * one closes it.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @param reset - Ids of sources a reference was just created or revived for.
 * @returns The referenced source ids.
 * @throws {never} Never.
 */
export function restoreTimelineSources(doc: Y.Doc, values: Readonly<Record<string, TimelineVideoSource>>, reset: Iterable<string>): Set<string> {
  const sources = doc.getMap<unknown>('sources');
  const referenced = timelineReferencedSourceIds(doc);
  /**
   * Write one source value from `values`.
   * @param id - The source id.
   * @throws {never} Never.
   */
  const write = (id: string): void => {
    if (Object.hasOwn(values, id)) sources.set(id, freezeRecord(structuredClone(values[id])));
  };
  for (const id of new Set(reset)) if (referenced.has(id)) write(id);
  for (const id of missingSourceIds(sources, referenced, values)) write(id);
  return referenced;
}

/**
 * Bring `sources` to exactly the sources the clip records name, inside the caller's transaction.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @param reset - Ids of sources a reference was just created or revived for.
 * @throws {never} Never.
 */
export function reconcileTimelineSources(doc: Y.Doc, values: Readonly<Record<string, TimelineVideoSource>>, reset: Iterable<string>): void {
  const referenced = restoreTimelineSources(doc, values, reset);
  const sources = doc.getMap<unknown>('sources');
  for (const id of [...sources.keys()]) if (!referenced.has(id)) sources.delete(id);
}

/** Origin of the record format conversion; no undo manager tracks it. */
const FORMAT_ORIGIN = Symbol('timeline-record-format');

/**
 * Apply a user-confirmed layout edit to the shared Y.Doc, writing only what changed: the user's fields and any landing
 * receipt in one transaction under `origin`, after an untracked conversion of any plain-object record the edit
 * changes. The receipts map is outside every undo manager's scope, so undoing a landing keeps its receipt.
 * @param doc - The current content document.
 * @param command - The normalized edit with the editing user's placement switches.
 * @param origin - The transaction origin; a Y.UndoManager tracking it undoes this edit in one step.
 * @param newId - Supplies ids for clips cut by an overwrite and tracks created by a linkage bump.
 * @param web - The resolution of the document's web-animation references.
 * @returns The applied plan, or why nothing was written.
 * @throws {Error} When the document is structurally invalid.
 */
export function applyTimelineEdit(
  doc: Y.Doc, command: TimelineEditCommand, origin: unknown, newId: () => string = createId, web: TimelineWebResolution = EMPTY_TIMELINE_WEB_RESOLUTION,
): TimelineEditPlan {
  const normalized = TimelineEditCommandSchema.safeParse(command);
  if (!normalized.success) return { ok: false, reason: 'invalid_range' };
  const current = readTimelineDocument(doc);
  const plan = planTimelineEdit(current, normalized.data, newId, web);
  if (!plan.ok) return plan;
  const { next } = plan;
  // An edit that changes no record writes nothing, so it neither sweeps a peer's orphan nor becomes an undo step.
  const layoutSame = sameRecords(current.tracks, next.tracks) && sameRecords(current.clips, next.clips);
  if (layoutSame && sameRecords(current.operationReceipts, next.operationReceipts)) return plan;
  // A peer may have stored a record as a plain value. The ones this edit changes become maps outside the edit's own
  // origin, so undoing the edit reverts only the fields it set.
  const plain = [
    ...plainChangedRecords(doc.getMap<unknown>('tracks'), current.tracks, next.tracks),
    ...plainChangedRecords(doc.getMap<unknown>('clips'), current.clips, next.clips),
  ];
  if (plain.length > 0) doc.transact(() => { for (const [parent, id, value] of plain) attachRecord(parent, id, value); }, FORMAT_ORIGIN);
  doc.transact(() => {
    // A receipt is one fact written once; it is stored whole.
    for (const [actionId, receipt] of Object.entries(next.operationReceipts)) {
      if (JSON.stringify(current.operationReceipts[actionId]) !== JSON.stringify(receipt)) doc.getMap<unknown>('operationReceipts').set(actionId, freezeRecord(structuredClone(receipt)));
    }
    // A landing that adds no copy changes no layout record, so it sweeps nothing and makes no undo step.
    if (layoutSame) return;
    writeRecords(doc.getMap<unknown>('tracks'), current.tracks, next.tracks);
    writeRecords(doc.getMap<unknown>('clips'), current.clips, next.clips);
    reconcileTimelineSources(doc, next.sources, plan.created.flatMap((id) => { const clip = next.clips[id]; return clip?.kind === 'video' ? [clip.sourceId] : []; }));
  }, origin);
  return plan;
}

/**
 * The records of one collection that the plan changes and that are stored as something other than a map.
 * @param parent - The attached collection map.
 * @param before - The records the plan started from.
 * @param after - The planned records.
 * @returns The collection, id and current value of each.
 * @throws {never} Never.
 */
function plainChangedRecords(
  parent: Y.Map<unknown>, before: Readonly<Record<string, object>>, after: Readonly<Record<string, object>>,
): Array<[Y.Map<unknown>, string, object]> {
  return Object.entries(before)
    .filter(([id, was]) => after[id] !== undefined && !(parent.get(id) instanceof Y.Map) && JSON.stringify(was) !== JSON.stringify(after[id]))
    .map(([id, was]) => [parent, id, was]);
}

/**
 * Whether two collections hold the same records by id, whatever their key order.
 * @param before - The current records.
 * @param after - The planned records.
 * @returns Whether no record is added, removed or changed.
 * @throws {never} Never.
 */
function sameRecords(before: Readonly<Record<string, object>>, after: Readonly<Record<string, object>>): boolean {
  return Object.keys(before).length === Object.keys(after).length
    && Object.entries(after).every(([id, record]) => JSON.stringify(before[id]) === JSON.stringify(record));
}

/**
 * Bring one collection to its planned state: attach new records, delete removed ones, set only changed fields.
 * @param parent - The attached collection map.
 * @param before - The records the plan started from.
 * @param after - The planned records.
 * @throws {never} Never.
 */
function writeRecords(parent: Y.Map<unknown>, before: Readonly<Record<string, object>>, after: Readonly<Record<string, object>>): void {
  for (const id of Object.keys(before)) if (after[id] === undefined) parent.delete(id);
  for (const [id, value] of Object.entries(after)) {
    const was = before[id];
    if (was === undefined) {
      attachRecord(parent, id, value);
      continue;
    }
    const target = parent.get(id);
    if (!(target instanceof Y.Map)) continue;
    for (const [key, item] of Object.entries(value)) {
      if (JSON.stringify((was as Record<string, unknown>)[key]) !== JSON.stringify(item)) target.set(key, item);
    }
  }
}

/** Origin of an upload's conversion into video clips; no undo manager tracks it, so no user's history holds it. */
export const TIMELINE_UPLOAD_ORIGIN = Symbol('timeline-upload');

// The fields a video clip keeps when a placeholder becomes one; anything else on the record is dropped.
const VIDEO_CLIP_FIELDS: ReadonlySet<string> = new Set([
  'id', 'trackId', 'kind', 'sourceId', 'startFrame', 'sourceInFrame', 'durationFrames', 'rate', 'gain', 'mute', 'transform',
]);

/**
 * Turn every placeholder of one registered upload into a video clip of its asset, in one untracked transaction
 * (#1434 design §3.1): one source is written for the asset, measured by the registered duration or, when the server
 * has none, by the duration the browser read. An untrimmed placeholder takes the asset's whole length up to the start
 * of the next clip on its track; any other piece is cut to what the asset holds, and a piece left empty is deleted.
 * Tracks and starts never change. A document holding no placeholder of the upload is not written.
 * @param doc - The content document.
 * @param uploadId - The registered upload.
 * @param asset - The registered video asset.
 * @throws {RangeError} When neither duration can be counted in frames.
 */
export function convertTimelineUpload(doc: Y.Doc, uploadId: string, asset: ProjectRegisteredAsset): void {
  const current = readTimelineDocument(doc);
  const placeholders = Object.values(current.clips).flatMap((clip) => (clip.kind === 'upload' && clip.upload.uploadId === uploadId ? [clip] : []));
  const first = placeholders[0];
  if (first === undefined) return;
  const fps = current.settings.fps;
  const duration = asset.durationSeconds ?? first.upload.durationSeconds;
  const source: TimelineVideoSource = {
    id: createId(), kind: 'video', assetId: asset.assetId, timebase: fps, extentFrames: durationToFrames(duration, fps),
    durationSeconds: String(duration), durationOrigin: asset.durationSeconds === null ? 'decoded' : 'registered',
  };
  const clips = doc.getMap<unknown>('clips');
  doc.transact(() => {
    for (const placeholder of placeholders) {
      const untrimmed = placeholder.sourceInFrame === 0 && placeholder.durationFrames === timelineUploadExtent(fps, placeholder)?.extentFrames;
      const room = timelineSourceRoom(placeholder, source, fps);
      const next = orderedTimelineClips(current.clips, placeholder.trackId).find((other) => other.startFrame > placeholder.startFrame);
      const durationFrames = untrimmed
        ? Math.min(room, next === undefined ? room : next.startFrame - placeholder.startFrame)
        : Math.min(room, placeholder.durationFrames);
      if (durationFrames <= 0) {
        clips.delete(placeholder.id);
        continue;
      }
      // A peer may have stored the placeholder as a plain value; it becomes a map so each field is written alone.
      const stored = clips.get(placeholder.id);
      const target: Y.Map<unknown> = stored instanceof Y.Map ? stored as Y.Map<unknown> : attachRecord(clips, placeholder.id, placeholder);
      for (const key of [...target.keys()]) if (!VIDEO_CLIP_FIELDS.has(key)) target.delete(key);
      target.set('kind', 'video');
      target.set('sourceId', source.id);
      if (durationFrames !== placeholder.durationFrames) target.set('durationFrames', durationFrames);
    }
    reconcileTimelineSources(doc, { [source.id]: source }, [source.id]);
  }, TIMELINE_UPLOAD_ORIGIN);
}
