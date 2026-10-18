// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Undo, redo and brush size while a drawing tool is open (inner#1302 §6.3).
 * The canvas has two ways in to its history, the keyboard and the view bar,
 * and both route through here, so neither reaches the canvas's own history
 * while the reader is drawing.
 */

import type { HistoryShortcut } from '@web/spaces/canvas/canvas-history-shortcut';
import type { CanvasSessionState } from '@web/stores/canvas-session';
import type { DrawingDraft } from '@web/stores/drawing-draft';
import { markCanRedo, markCanUndo, type MarkDraft } from '@web/stores/mark-draft';

/**
 * Act on an undo or redo: on the drawing while a drawing tool is open, where
 * an empty history or a run under way does nothing; otherwise it is the
 * canvas's to act on.
 * @param session - The canvas session, read when the command arrives.
 * @param action - Undo or redo.
 * @returns `drawing` when it was taken here, `canvas` when the canvas acts on it.
 */
export function routeHistoryCommand(session: CanvasSessionState, action: HistoryShortcut): 'drawing' | 'canvas' {
  const draft = session.miniTool;
  if (draft?.mark != null) {
    if (draft.exporting) return 'drawing';
    // A text being edited is left first, by the usual write-back rules.
    if (draft.mark.editingText !== null) session.markChannel?.exitEditing();
    if (action === 'undo') session.undoMark();
    else session.redoMark();
    return 'drawing';
  }
  if (draft?.drawing == null) return 'canvas';
  if (draft.exporting) return 'drawing';
  if (action === 'undo') session.undoDrawing();
  else session.redoDrawing();
  return 'drawing';
}

/**
 * Whether the view bar's undo and redo can act: on the drawing or the markup
 * while one of those tools is open, on the canvas otherwise.
 * @param drawing - The open tool's drawing or markup, or null without one.
 * @param exporting - Whether the run is exporting.
 * @param canvasUndo - Whether the canvas has something to undo.
 * @param canvasRedo - Whether the canvas has something to redo.
 * @returns The two availabilities.
 */
export function historyAvailability(
  drawing: DrawingDraft | MarkDraft | null,
  exporting: boolean,
  canvasUndo: boolean,
  canvasRedo: boolean,
): { canUndo: boolean; canRedo: boolean } {
  if (drawing === null) return { canUndo: canvasUndo, canRedo: canvasRedo };
  if (exporting) return { canUndo: false, canRedo: false };
  if ('steps' in drawing) return { canUndo: drawing.steps.length > 0, canRedo: drawing.undone.length > 0 };
  // The markup is read as leaving a text edit would leave it, as its panel reads it.
  return { canUndo: markCanUndo(drawing), canRedo: markCanRedo(drawing) };
}

/**
 * Route the delete key while markup is open (inner#1303 §6.2): a text being
 * edited is left (the key goes no further), a selected object is deleted
 * rather than the node; anything else, and anything while the run exports,
 * is the canvas's. Called only when the caret is not in a text field, which
 * the canvas's handler checks first.
 * @param session - The canvas session.
 * @returns Who took the key.
 */
export function routeDeleteCommand(session: CanvasSessionState): 'mark' | 'canvas' {
  const draft = session.miniTool;
  const mark = draft?.mark;
  if (mark == null || draft?.exporting) return 'canvas';
  if (mark.editingText !== null) {
    session.markChannel?.exitEditing();
    return 'mark';
  }
  if (mark.selectedId === null) return 'canvas';
  const gone = mark.selectedId;
  session.selectMark(null);
  session.commitMark(mark.objects.filter((object) => object.id !== gone));
  return 'mark';
}

/**
 * Read `[` and `]` as a step down or up in brush size. The key names the
 * character typed, so Option (a German Mac) or AltGr (Ctrl+Alt on Windows)
 * typing it still counts.
 * @param event - The key event.
 * @returns −1, +1, or null for any other key or a Cmd or Ctrl shortcut.
 */
export function brushSizeStep(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): -1 | 1 | null {
  if (event.metaKey || (event.ctrlKey && !event.altKey)) return null;
  if (event.key === '[') return -1;
  if (event.key === ']') return 1;
  return null;
}
