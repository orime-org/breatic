// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';
import { newId as createId } from '@breatic/shared';
import {
  attachTimelineRecord as attachRecord, freezeTimelineRecord as freezeRecord, readTimelineDocument, readTimelineSource, timelineRecordJson,
} from '@breatic/shared/space-content';

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
 * The referenced sources, damaged clip records included, that `sources` lacks or holds unreadable and `values` holds.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @returns Their ids.
 * @throws {never} Never.
 */
export function missingTimelineSourceIds(doc: Y.Doc, values: Readonly<Record<string, unknown>>): string[] {
  const sources = doc.getMap<unknown>('sources');
  // Own keys only: a damaged clip may name any string, including an Object.prototype property.
  return [...timelineReferencedSourceIds(doc)].filter((id) => readTimelineSource(sources.get(id), id) === undefined && Object.hasOwn(values, id));
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
export function restoreTimelineSources(doc: Y.Doc, values: Readonly<Record<string, unknown>>, reset: Iterable<string>): Set<string> {
  const sources = doc.getMap<unknown>('sources');
  const referenced = timelineReferencedSourceIds(doc);
  /**
   * Write one source value from `values`.
   * @param id - The source id.
   * @throws {never} Never.
   */
  const write = (id: string): void => {
    if (Object.hasOwn(values, id)) sources.set(id, freezeRecord(structuredClone(values[id] as object)));
  };
  for (const id of new Set(reset)) if (referenced.has(id)) write(id);
  for (const id of referenced) if (readTimelineSource(sources.get(id), id) === undefined) write(id);
  return referenced;
}

/**
 * Bring `sources` to exactly the sources the clip records name, inside the caller's transaction.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @param reset - Ids of sources a reference was just created or revived for.
 * @throws {never} Never.
 */
export function reconcileTimelineSources(doc: Y.Doc, values: Readonly<Record<string, unknown>>, reset: Iterable<string>): void {
  const referenced = restoreTimelineSources(doc, values, reset);
  const sources = doc.getMap<unknown>('sources');
  for (const id of [...sources.keys()]) if (!referenced.has(id)) sources.delete(id);
}

/**
 * Apply a user-confirmed layout edit to the shared Y.Doc in one transaction, writing only what changed.
 * @param doc - The current content document.
 * @param command - The normalized edit with the editing user's placement switches.
 * @param origin - The transaction origin; a Y.UndoManager tracking it undoes this edit in one step.
 * @param newId - Supplies ids for clips cut by an overwrite and tracks created by a linkage bump.
 * @returns The applied plan, or why nothing was written.
 * @throws {Error} When the document is structurally invalid.
 */
export function applyTimelineEdit(doc: Y.Doc, command: TimelineEditCommand, origin: unknown, newId: () => string = createId): TimelineEditPlan {
  const normalized = TimelineEditCommandSchema.safeParse(command);
  if (!normalized.success) return { ok: false, reason: 'invalid_range' };
  const current = readTimelineDocument(doc);
  const plan = planTimelineEdit(current, normalized.data, newId);
  if (!plan.ok) return plan;
  const { next } = plan;
  // An edit that changes no record writes nothing, so it neither sweeps a peer's orphan nor becomes an undo step.
  if (sameRecords(current.tracks, next.tracks) && sameRecords(current.clips, next.clips)) return plan;
  doc.transact(() => {
    writeRecords(doc.getMap<unknown>('tracks'), current.tracks, next.tracks);
    writeRecords(doc.getMap<unknown>('clips'), current.clips, next.clips);
    reconcileTimelineSources(doc, next.sources, plan.created.flatMap((id) => next.clips[id]?.sourceId ?? []));
  }, origin);
  return plan;
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
    // A peer may have stored the record as a plain value; the planned value is the whole record, so attach it.
    if (!(target instanceof Y.Map)) {
      attachRecord(parent, id, value);
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      if (JSON.stringify((was as Record<string, unknown>)[key]) !== JSON.stringify(item)) target.set(key, item);
    }
  }
}
