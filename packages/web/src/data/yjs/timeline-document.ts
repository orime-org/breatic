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
  doc.transact(() => { doc.getMap(kind).delete(id); }, origin);
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
  doc.transact(() => {
    const sources = doc.getMap<unknown>('sources');
    for (const [id, source] of Object.entries(next.sources)) if (!sources.has(id)) sources.set(id, freezeRecord(structuredClone(source)));
    writeRecords(doc.getMap<unknown>('tracks'), current.tracks, next.tracks);
    writeRecords(doc.getMap<unknown>('clips'), current.clips, next.clips);
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
