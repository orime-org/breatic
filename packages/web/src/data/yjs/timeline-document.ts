// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as Y from 'yjs';
import { newId as createId, type TimelineDocumentV1, type TimelineWebResolution } from '@breatic/shared';
import {
  attachTimelineRecord as attachRecord, freezeTimelineRecord as freezeRecord, readTimelineDocument, reconcileTimelineSources,
  timelineDocumentNeedsUpgrade, upgradeTimelineDocument,
} from '@breatic/shared/space-content';

import { readDocSize } from '@web/data/yjs/doc-size';
import { docNameOf } from '@web/data/yjs/manager';
import { writeSpaceDoc, type SpaceRefusal, type SpaceWriteKind } from '@web/data/yjs/space-write';
import { EMPTY_TIMELINE_WEB_RESOLUTION } from '@web/data/yjs/timeline-arrangement';
import { TimelineEditCommandSchema, planTimelineEdit, type TimelineEditCommand, type TimelineEditPlan } from '@web/data/yjs/timeline-edit';

export {
  missingTimelineSourceIds, readTimelineContent, readTimelineDocument, reconcileTimelineSources, restoreTimelineSources, timelineClipSourceId,
  TIMELINE_UPLOAD_ORIGIN, type TimelineDamagedRecords,
} from '@breatic/shared/space-content';

/**
 * The size-state name of a Timeline document; one not in the document cache has no size state, which
 * `writeSpaceDoc` lets through.
 * @param doc - The content document.
 * @returns Its canonical name, or an empty name.
 * @throws {never} Never.
 */
function timelineSizeName(doc: Y.Doc): string {
  return docNameOf(doc) ?? '';
}

/**
 * Whether the Space's size holds back every write but deletions (full, over its ceiling) or every write
 * (resyncing), inner#1790. Deletions then only delete: no clip moves up, no record is converted and no source is
 * swept or restored; a later normal edit brings the records and sources back in line.
 * @param name - Canonical document name.
 * @returns True while held.
 * @throws {never} Never.
 */
export function timelineSizeHolds(name: string): boolean {
  const { phase } = readDocSize(name);
  return phase === 'full' || phase === 'resyncing';
}

/**
 * Whether an edit answer is a refusal by the Space's size, whose toast `writeSpaceDoc` has shown.
 * @param plan - The answer.
 * @returns True for a size refusal.
 * @throws {never} Never.
 */
export function isTimelineSizeRefusal(plan: TimelineEditPlan): plan is SpaceRefusal {
  return !plan.ok && (plan.reason === 'full' || plan.reason === 'over_ceiling' || plan.reason === 'resyncing');
}

/** Origin of the record format conversion; no undo manager tracks it. */
const FORMAT_ORIGIN = Symbol('timeline-record-format');

/**
 * Apply a user-confirmed layout edit to the shared Y.Doc, writing only what changed: the user's fields and the frame
 * size in one transaction under `origin`, after an untracked conversion of any plain-object record
 * the edit changes and of any clip still stored with pixel offsets (#1502), which also marks a version 1 document
 * version 2. A deletion while the size holds writes back converts nothing, so it stays a pure delete; undoing it
 * revives a pixel clip whose offsets are then read under the frame of that moment. The two
 * transactions go through the Space's size check as one write (inner#1790): a new record is `add`, a
 * changed one `edit`; a deletion whose plan only deletes is `remove`, one that also rewrites a record `compound`.
 * While the size holds writes back a deletion is planned with the magnet off and sweeps no source.
 * @param doc - The current content document.
 * @param command - The normalized edit with the editing user's placement switches.
 * @param origin - The transaction origin; a Y.UndoManager tracking it undoes this edit in one step.
 * @param newId - Supplies ids for clips cut by an overwrite and tracks created by a linkage bump.
 * @param web - The resolution of the document's web-animation references.
 * @param notify - Show the size refusal toast (default true).
 * @returns The applied plan, or why nothing was written.
 * @throws {Error} When the document is structurally invalid.
 */
export function applyTimelineEdit(
  doc: Y.Doc, command: TimelineEditCommand, origin: unknown, newId: () => string = createId, web: TimelineWebResolution = EMPTY_TIMELINE_WEB_RESOLUTION,
  notify = true,
): TimelineEditPlan {
  const normalized = TimelineEditCommandSchema.safeParse(command);
  if (!normalized.success) return { ok: false, reason: 'invalid_range' };
  const name = timelineSizeName(doc);
  const deleting = normalized.data.operation === 'delete' || normalized.data.operation === 'delete_track';
  const onlyDelete = deleting && timelineSizeHolds(name);
  const planned = onlyDelete ? { ...normalized.data, placement: { ...normalized.data.placement, magnet: false } } : normalized.data;
  const current = readTimelineDocument(doc);
  const plan = planTimelineEdit(current, planned, newId, web);
  if (!plan.ok) return plan;
  const { next } = plan;
  // An edit that changes no record writes nothing, so it neither sweeps a peer's orphan nor becomes an undo step.
  const layoutSame = sameRecords(current.tracks, next.tracks) && sameRecords(current.clips, next.clips);
  const settingsSame = JSON.stringify(current.settings) === JSON.stringify(next.settings);
  if (layoutSame && settingsSame) return plan;
  // A peer may have stored a record as a plain value. The ones this edit changes become maps outside the edit's own
  // origin, so undoing the edit reverts only the fields it set.
  const plain = [
    ...plainChangedRecords(doc.getMap<unknown>('tracks'), current.tracks, next.tracks),
    ...plainChangedRecords(doc.getMap<unknown>('clips'), current.clips, next.clips),
  ];
  const written = writeSpaceDoc(name, { kind: editKind(deleting, current, next), notify }, () => {
    // Pixel clips are stored as the frame offsets the plan was read with, before the frame can change under them.
    if (!onlyDelete && (plain.length > 0 || timelineDocumentNeedsUpgrade(doc))) {
      doc.transact(() => {
        upgradeTimelineDocument(doc);
        for (const [parent, id, value] of plain) attachRecord(parent, id, value);
      }, FORMAT_ORIGIN);
    }
    doc.transact(() => {
      if (!settingsSame) doc.getMap<unknown>('timeline').set('settings', freezeRecord(structuredClone(next.settings)));
      // A change of the frame alone writes no layout record.
      if (layoutSame) return;
      writeRecords(doc.getMap<unknown>('tracks'), current.tracks, next.tracks);
      writeRecords(doc.getMap<unknown>('clips'), current.clips, next.clips);
      // Every created clip that names a source re-sets it (inner#1709).
      if (!onlyDelete) reconcileTimelineSources(doc, next.sources, plan.created.flatMap((id) => { const clip = next.clips[id]; return clip !== undefined && 'sourceId' in clip ? [clip.sourceId] : []; }));
    }, origin);
  });
  return written.ok ? plan : written;
}

/**
 * What an edit's records write in Yjs.
 * @param deleting - Whether the user deleted something.
 * @param before - The document the plan started from.
 * @param after - The planned document.
 * @returns `add` for a new record, `remove` or `compound` for a deletion that does or does not only delete, else `edit`.
 * @throws {never} Never.
 */
function editKind(deleting: boolean, before: TimelineDocumentV1, after: TimelineDocumentV1): SpaceWriteKind {
  const collections = [[before.tracks, after.tracks], [before.clips, after.clips]] as const;
  if (collections.some(([was, now]) => Object.keys(now).some((id) => was[id] === undefined))) return 'add';
  if (!deleting) return 'edit';
  const rewrites = collections.some(([was, now]) => Object.entries(now).some(([id, record]) => JSON.stringify(was[id]) !== JSON.stringify(record)));
  return rewrites ? 'compound' : 'remove';
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
