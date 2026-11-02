// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';
import { newId as createId } from '@breatic/shared';
import {
  attachTimelineRecord as attachRecord, freezeTimelineRecord as freezeRecord, readTimelineDocument,
} from '@breatic/shared/space-content';

import { TimelineEditCommandSchema, planTimelineEdit, type TimelineEditCommand, type TimelineEditPlan } from '@web/data/yjs/timeline-edit';

export { readTimelineContent, readTimelineDocument, type TimelineDamagedRecords } from '@breatic/shared/space-content';

/**
 * Delete one clip or track record, damaged or not, in one transaction.
 * @param doc - The content document.
 * @param kind - The collection.
 * @param id - The record id.
 * @param origin - The transaction origin.
 * @throws {never} Never.
 */
export function removeTimelineRecord(doc: Y.Doc, kind: 'clips' | 'tracks', id: string, origin: unknown): void {
  doc.transact(() => {
    doc.getMap(kind).delete(id);
    if (kind === 'clips') reconcileTimelineSources(doc, {}, []);
  }, origin);
}

/**
 * The source id a clip record names, read from the raw record so a damaged record still counts as a reference.
 * @param record - A value of the clips map, or its JSON.
 * @returns Its string `sourceId`, if any.
 * @throws {never} Never.
 */
export function timelineClipSourceId(record: unknown): string | undefined {
  const id = record instanceof Y.Map ? record.get('sourceId') : typeof record === 'object' && record !== null ? (record as { sourceId?: unknown }).sourceId : undefined;
  return typeof id === 'string' ? id : undefined;
}

/**
 * The source ids the clip records name, damaged records included.
 * @param doc - The content document.
 * @returns The referenced source ids.
 * @throws {never} Never.
 */
export function timelineReferencedSourceIds(doc: Y.Doc): Set<string> {
  const referenced = new Set<string>();
  doc.getMap<unknown>('clips').forEach((record) => {
    const id = timelineClipSourceId(record);
    if (id !== undefined) referenced.add(id);
  });
  return referenced;
}

/**
 * Write referenced sources inside the caller's transaction: the ones in `reset` even when present, and any that is
 * missing, each from `values` when it holds it. Concurrent writes to one key keep only one of them, so a fresh
 * write narrows the window in which a peer's removal leaves a reference without its source; writing back a missing
 * one closes it.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @param reset - Ids of sources a reference was just created or revived for.
 * @throws {never} Never.
 */
export function restoreTimelineSources(doc: Y.Doc, values: Readonly<Record<string, unknown>>, reset: Iterable<string>): void {
  const sources = doc.getMap<unknown>('sources');
  const referenced = timelineReferencedSourceIds(doc);
  /**
   * Write one source value from `values`.
   * @param id - The source id.
   * @throws {never} Never.
   */
  const write = (id: string): void => {
    if (values[id] !== undefined) sources.set(id, freezeRecord(structuredClone(values[id] as object)));
  };
  for (const id of new Set(reset)) if (referenced.has(id)) write(id);
  for (const id of referenced) if (!sources.has(id)) write(id);
}

/**
 * Bring `sources` to exactly the sources the clip records name, inside the caller's transaction.
 * @param doc - The content document.
 * @param values - Source values by id that this writer may write.
 * @param reset - Ids of sources a reference was just created or revived for.
 * @throws {never} Never.
 */
export function reconcileTimelineSources(doc: Y.Doc, values: Readonly<Record<string, unknown>>, reset: Iterable<string>): void {
  restoreTimelineSources(doc, values, reset);
  const sources = doc.getMap<unknown>('sources');
  const referenced = timelineReferencedSourceIds(doc);
  for (const id of [...sources.keys()]) if (!referenced.has(id)) sources.delete(id);
}

/**
 * Apply a user-confirmed layout edit to the shared Y.Doc in one transaction, writing only what changed.
 * @param doc - The current content document.
 * @param command - The normalized edit with the editing user's placement switches.
 * @param origin - The transaction origin; a Y.UndoManager tracking it undoes this edit in one step.
 * @param newId - Supplies ids for clips cut by an overwrite and tracks created by a linkage bump.
 * @returns The applied plan, or why nothing was written.
 * @throws {Error} When the document or command is structurally invalid.
 */
export function applyTimelineEdit(doc: Y.Doc, command: TimelineEditCommand, origin: unknown, newId: () => string = createId): TimelineEditPlan {
  const normalized = TimelineEditCommandSchema.parse(command);
  const current = readTimelineDocument(doc);
  const plan = planTimelineEdit(current, normalized, newId);
  if (!plan.ok) return plan;
  const { next } = plan;
  // An edit that changes no record writes nothing, so it neither sweeps a peer's orphan nor becomes an undo step.
  if (JSON.stringify([next.tracks, next.clips]) === JSON.stringify([current.tracks, current.clips])) return plan;
  doc.transact(() => {
    writeRecords(doc.getMap<unknown>('tracks'), current.tracks, next.tracks);
    writeRecords(doc.getMap<unknown>('clips'), current.clips, next.clips);
    reconcileTimelineSources(doc, next.sources, plan.created.flatMap((id) => next.clips[id]?.sourceId ?? []));
  }, origin);
  return plan;
}

/**
 * Bring one collection to its planned state: attach new records, delete removed ones, set only changed fields.
 * @param parent - The attached collection map.
 * @param before - The records the plan started from.
 * @param after - The planned records.
 * @throws {Error} When an existing record is not an attached map.
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
    if (!(target instanceof Y.Map)) throw new Error('Timeline record is not an attached map');
    for (const [key, item] of Object.entries(value)) {
      if (JSON.stringify((was as Record<string, unknown>)[key]) !== JSON.stringify(item)) target.set(key, item);
    }
  }
}
