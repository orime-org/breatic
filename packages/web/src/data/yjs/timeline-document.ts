// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as Y from 'yjs';
import { newId as createId, type TimelineVideoSource } from '@breatic/shared';
import {
  attachTimelineRecord as attachRecord, freezeTimelineRecord as freezeRecord, readTimelineDocument, readTimelineSource, timelineRecordJson,
} from '@breatic/shared/space-content';

import { EMPTY_TIMELINE_WEB_RESOLUTION, type TimelineWebResolution } from '@web/data/yjs/timeline-arrangement';
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
