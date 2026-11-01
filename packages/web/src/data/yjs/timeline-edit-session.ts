// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';

import { MAX_UNDO_DEPTH } from '@web/data/yjs/canvas-space';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import { applyTimelineEdit } from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand, TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { withDestroyListenerCleanup } from '@web/data/yjs/undo-manager-cleanup';

/** What the Timeline toolbar and properties read from the personal session. */
export interface TimelineEditSessionSnapshot { canUndo: boolean; canRedo: boolean; selectedClipId: string | null }

/** One user's history and selection for one open Timeline document. */
export interface TimelineEditSession {
  readonly origin: symbol;
  getSnapshot: () => TimelineEditSessionSnapshot;
  subscribe: (listener: () => void) => () => void;
  edit: (command: TimelineEditCommand, options?: { joinPrevious?: boolean }) => TimelineEditPlan;
  undo: () => void;
  redo: () => void;
  select: (clipId: string | null) => void;
  dispose: () => void;
}

/** Clip and track records by id, as JSON, for the records one undo step touched. */
interface RecordSnapshot { clips: Record<string, Record<string, unknown>>; tracks: Record<string, Record<string, unknown>> }

// Writes that complete revived records; untracked, so they never become an undo step of their own.
const REPAIR_ORIGIN = Symbol('timeline-record-repair');

/**
 * Every clip and track record as JSON.
 * @param doc - The document.
 * @returns The records.
 * @throws {never} Never.
 */
function snapshotRecords(doc: Y.Doc): RecordSnapshot {
  return { clips: doc.getMap('clips').toJSON(), tracks: doc.getMap('tracks').toJSON() };
}

/**
 * The records of `from` whose content differs from `other`, including ones `other` lacks.
 * @param from - The snapshot to keep records from.
 * @param other - The snapshot on the other side of the edit.
 * @returns The touched records of `from`.
 * @throws {never} Never.
 */
function touched(from: RecordSnapshot, other: RecordSnapshot): RecordSnapshot {
  /**
   * The touched records of one collection.
   * @param kind - The collection.
   * @returns Its touched records.
   * @throws {never} Never.
   */
  const pick = (kind: keyof RecordSnapshot): Record<string, Record<string, unknown>> => Object.fromEntries(
    Object.entries(from[kind]).filter(([id, record]) => JSON.stringify(record) !== JSON.stringify(other[kind][id])),
  );
  return { clips: pick('clips'), tracks: pick('tracks') };
}

/**
 * Give every present record of the snapshot the fields it lacks, leaving fields it has untouched.
 * @param doc - The document.
 * @param records - The snapshot of the step just undone or redone.
 * @throws {never} Never.
 */
function completeRecords(doc: Y.Doc, records: RecordSnapshot): void {
  doc.transact(() => {
    for (const kind of ['clips', 'tracks'] as const) {
      const collection = doc.getMap<unknown>(kind);
      for (const [id, record] of Object.entries(records[kind])) {
        const target = collection.get(id);
        if (!(target instanceof Y.Map)) continue;
        for (const [key, value] of Object.entries(record)) if (!target.has(key)) target.set(key, value);
      }
    }
  }, REPAIR_ORIGIN);
}

/**
 * Create the personal session for a Timeline document.
 * @param doc - The live collaborative document.
 * @returns The session; its undo manager tracks only this session's edits to tracks and clips.
 * @throws {never} Never.
 */
function createTimelineEditSession(doc: Y.Doc): TimelineEditSession {
  const origin = Symbol('timeline-local-edit');
  const history = withDestroyListenerCleanup(doc, () => new Y.UndoManager([doc.getMap('tracks'), doc.getMap('clips')], { trackedOrigins: new Set([origin]), captureTimeout: 0 }));
  const listeners = new Set<() => void>();
  let selected: string | null = null;
  let snapshot: TimelineEditSessionSnapshot = { canUndo: false, canRedo: false, selectedClipId: null };
  let disposed = false;

  /** Recompute the snapshot from the stacks and the document, notifying only on change. */
  const refresh = (): void => {
    if (disposed) return;
    if (selected !== null && !doc.getMap('clips').has(selected)) selected = null;
    const next = { canUndo: history.undoStack.length > 0, canRedo: history.redoStack.length > 0, selectedClipId: selected };
    if (next.canUndo === snapshot.canUndo && next.canRedo === snapshot.canRedo && next.selectedClipId === snapshot.selectedClipId) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  // The opposite-stack step an undo or redo creates, so it inherits the popped step's snapshots.
  let added: { meta: Map<string, unknown> } | null = null;
  history.on('stack-item-added', ({ stackItem }: { stackItem: { meta: Map<string, unknown> } }) => {
    added = stackItem;
    while (history.undoStack.length > MAX_UNDO_DEPTH) history.undoStack.shift();
  });
  // A peer's edit to a record this step deleted lands in the deleted map, and undo restores only what this
  // session removed, so a revived record can lack fields; complete it from the step's snapshot.
  history.on('stack-item-popped', ({ stackItem, type }: { stackItem: { meta: Map<string, unknown> }; type: 'undo' | 'redo' }) => {
    const records = stackItem.meta.get(type === 'undo' ? 'before' : 'after') as RecordSnapshot | undefined;
    if (records !== undefined) completeRecords(doc, records);
    if (added !== null && added !== stackItem) for (const [key, value] of stackItem.meta) added.meta.set(key, value);
  });
  doc.on('update', refresh);

  return {
    origin,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    edit(command, options = {}) {
      const join = options.joinPrevious === true && history.undoStack.length > 0;
      const timeout = history.captureTimeout;
      if (join) history.captureTimeout = Number.POSITIVE_INFINITY;
      try {
        const before = snapshotRecords(doc);
        const plan = applyTimelineEdit(doc, command, origin);
        const item = history.undoStack[history.undoStack.length - 1];
        if (plan.ok && item !== undefined) {
          const after = snapshotRecords(doc);
          if (!item.meta.has('before')) item.meta.set('before', touched(before, after));
          item.meta.set('after', touched(after, before));
        }
        return plan;
      } finally {
        history.captureTimeout = timeout;
        refresh();
      }
    },
    undo() {
      added = null;
      history.undo();
      refresh();
    },
    redo() {
      added = null;
      history.redo();
      refresh();
    },
    select(clipId) {
      selected = clipId !== null && doc.getMap('clips').has(clipId) ? clipId : null;
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      doc.off('update', refresh);
      listeners.clear();
      history.destroy();
    },
  };
}

const sessions = createDocScopedCache<TimelineEditSession>((doc) => createTimelineEditSession(doc), (session) => session.dispose());

/**
 * The personal edit session of an open Timeline document, kept across body remounts.
 * @param doc - The live collaborative document.
 * @param name - Its canonical document name.
 * @returns The cached or new session.
 * @throws {never} Never.
 */
export function getTimelineEditSession(doc: Y.Doc, name: string): TimelineEditSession {
  return sessions.get(doc, name, undefined);
}

/**
 * Discard a closed tab's personal history and selection.
 * @param name - Its canonical document name.
 * @throws {never} Never.
 */
export function evictTimelineEditSession(name: string): void {
  sessions.evict(name);
}
