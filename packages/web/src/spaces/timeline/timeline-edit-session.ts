// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as Y from 'yjs';
import type { TimelineEditCommand, TimelineEditPlan } from '@breatic/shared';
import { applyTimelineEdit } from '@breatic/shared/space-content';

import { MAX_UNDO_DEPTH } from '@web/data/yjs/canvas-space';
import { createDocScopedCache } from '@web/data/yjs/doc-scoped-cache';
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
  history.on('stack-item-added', () => {
    while (history.undoStack.length > MAX_UNDO_DEPTH) history.undoStack.shift();
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
        return applyTimelineEdit(doc, command, origin);
      } finally {
        history.captureTimeout = timeout;
        refresh();
      }
    },
    undo() {
      history.undo();
      refresh();
    },
    redo() {
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
