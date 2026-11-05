// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';

import { MAX_UNDO_DEPTH } from '@web/data/yjs/canvas-space';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
import {
  applyTimelineEdit, missingTimelineSourceIds, reconcileTimelineSources, restoreTimelineSources, timelineClipSourceId,
} from '@web/data/yjs/timeline-document';
import type { TimelineEditCommand, TimelineEditPlan } from '@web/data/yjs/timeline-edit';
import { withDestroyListenerCleanup } from '@web/data/yjs/undo-manager-cleanup';

/** What the Timeline toolbar and properties read from the personal session. */
export interface TimelineEditSessionSnapshot { canUndo: boolean; canRedo: boolean; selectedClipId: string | null }

/** Whether an edit comes from a held key; it joins the hold's step while that step is the undo top. */
export interface TimelineEditOptions { hold?: boolean }

/** One user's history and selection for one open Timeline document. */
export interface TimelineEditSession {
  readonly origin: symbol;
  getSnapshot: () => TimelineEditSessionSnapshot;
  subscribe: (listener: () => void) => () => void;
  edit: (command: TimelineEditCommand, options?: TimelineEditOptions) => TimelineEditPlan;
  undo: () => void;
  redo: () => void;
  select: (clipId: string | null) => void;
  endHold: () => void;
  setCanWrite: (canWrite: boolean) => void;
  dispose: () => void;
}

/** Clip and track records by id, as JSON, for the records one undo step touched. */
interface RecordSnapshot { clips: Record<string, Record<string, unknown>>; tracks: Record<string, Record<string, unknown>> }

// Writes that complete revived records and their sources; untracked, so they never become an undo step of their own.
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
  const pick = (kind: 'clips' | 'tracks'): Record<string, Record<string, unknown>> => Object.fromEntries(
    Object.entries(from[kind]).filter(([id, record]) => JSON.stringify(record) !== JSON.stringify(other[kind][id])),
  );
  return { clips: pick('clips'), tracks: pick('tracks') };
}

/**
 * Combine two snapshots of one step, record by record.
 * @param base - The snapshot whose records win.
 * @param extra - Records to add where `base` has none.
 * @returns The combined snapshot.
 * @throws {never} Never.
 */
function mergeSnapshots(base: RecordSnapshot, extra: RecordSnapshot | undefined): RecordSnapshot {
  return { clips: { ...extra?.clips, ...base.clips }, tracks: { ...extra?.tracks, ...base.tracks } };
}

/**
 * Repair the document after an undo or redo: give every present record of the step's snapshot the fields it
 * lacks, write again the sources of clips the pop revived, and drop sources no clip names. A pop restores or
 * deletes only this session's items, so a peer's concurrent or earlier edits can leave a revived clip without
 * fields or without its source, or a source without a clip.
 * @param doc - The document.
 * @param records - The snapshot of the step just undone or redone, when the step has one.
 * @param clipsBefore - The clip ids present just before the pop.
 * @param known - Source values this session has seen.
 * @throws {never} Never.
 */
function repairAfterPop(doc: Y.Doc, records: RecordSnapshot | undefined, clipsBefore: ReadonlySet<string>, known: Readonly<Record<string, unknown>>): void {
  doc.transact(() => {
    const revived: string[] = [];
    for (const kind of ['clips', 'tracks'] as const) {
      const collection = doc.getMap<unknown>(kind);
      for (const [id, record] of Object.entries(records?.[kind] ?? {})) {
        const target = collection.get(id);
        if (!(target instanceof Y.Map)) continue;
        for (const [key, value] of Object.entries(record)) if (!target.has(key)) target.set(key, value);
        const sourceId = kind === 'clips' && !clipsBefore.has(id) ? timelineClipSourceId(record) : undefined;
        if (sourceId !== undefined) revived.push(sourceId);
      }
    }
    reconcileTimelineSources(doc, known, revived);
  }, REPAIR_ORIGIN);
}

/**
 * Create the personal session for a Timeline document.
 * @param doc - The live collaborative document.
 * @returns The session; its undo manager tracks only this session's edits to tracks, clips and sources.
 * @throws {never} Never.
 */
function createTimelineEditSession(doc: Y.Doc): TimelineEditSession {
  const origin = Symbol('timeline-local-edit');
  const history = withDestroyListenerCleanup(doc, () => new Y.UndoManager([doc.getMap('tracks'), doc.getMap('clips'), doc.getMap('sources')], { trackedOrigins: new Set([origin]), captureTimeout: 0 }));
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
  // The clips just before the current pop, to tell the clips it revives.
  let clipsBeforePop = new Set<string>();
  // Every source value seen since the session opened; a source never changes once written, so any copy is current.
  const known: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let canWrite = false;
  /**
   * Remember the current sources and, for a session that may write, write back any referenced source a merge
   * removed. Concurrent writes to one key keep only one, so the remover's own write can win and then be swept,
   * leaving a peer's new or revived clip without its source; every editor that saw the value restores it.
   */
  const restoreMissingSources = (): void => {
    if (disposed) return;
    const sources = doc.getMap<unknown>('sources');
    sources.forEach((value, id) => { known[id] = value; });
    if (!canWrite) return;
    if (missingTimelineSourceIds(doc, known).length > 0) doc.transact(() => restoreTimelineSources(doc, known, []), REPAIR_ORIGIN);
  };
  restoreMissingSources();
  doc.on('afterAllTransactions', restoreMissingSources);
  // A peer's edit to a record this step deleted lands in the deleted map, and undo restores only what this
  // session removed, so a revived record can lack fields or its source; repair it from the step's snapshot.
  history.on('stack-item-popped', ({ stackItem, type }: { stackItem: { meta: Map<string, unknown> }; type: 'undo' | 'redo' }) => {
    repairAfterPop(doc, stackItem.meta.get(type === 'undo' ? 'before' : 'after') as RecordSnapshot | undefined, clipsBeforePop, known);
    if (added !== null && added !== stackItem) for (const [key, value] of stackItem.meta) added.meta.set(key, value);
  });
  doc.on('update', refresh);
  // The step the current key hold made; a repeat joins it only while it is still the top step.
  let holdStep: unknown = null;

  return {
    origin,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    edit(command, options = {}) {
      const top = history.undoStack.at(-1);
      const join = options.hold === true && holdStep !== null && top === holdStep;
      const timeout = history.captureTimeout;
      if (join) history.captureTimeout = Number.POSITIVE_INFINITY;
      try {
        const before = snapshotRecords(doc);
        const plan = applyTimelineEdit(doc, command, origin);
        const item = history.undoStack.at(-1);
        if (!join) holdStep = options.hold === true && item !== top ? item : null;
        if (plan.ok && item !== undefined) {
          const after = snapshotRecords(doc);
          // The top item is this edit's own step, a step it joined, or, for an edit that changed nothing, the
          // previous step; merging keeps the earliest prior state and the latest result of every record.
          const prior = item.meta.get('before') as RecordSnapshot | undefined;
          item.meta.set('before', prior === undefined ? touched(before, after) : mergeSnapshots(prior, touched(before, after)));
          item.meta.set('after', mergeSnapshots(touched(after, before), item.meta.get('after') as RecordSnapshot | undefined));
        }
        return plan;
      } finally {
        history.captureTimeout = timeout;
        refresh();
      }
    },
    undo() {
      added = null;
      holdStep = null;
      clipsBeforePop = new Set(doc.getMap('clips').keys());
      history.undo();
      refresh();
    },
    redo() {
      added = null;
      holdStep = null;
      clipsBeforePop = new Set(doc.getMap('clips').keys());
      history.redo();
      refresh();
    },
    select(clipId) {
      holdStep = null;
      selected = clipId !== null && doc.getMap('clips').has(clipId) ? clipId : null;
      refresh();
    },
    endHold() {
      holdStep = null;
    },
    setCanWrite(value) {
      canWrite = value;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      doc.off('update', refresh);
      doc.off('afterAllTransactions', restoreMissingSources);
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
