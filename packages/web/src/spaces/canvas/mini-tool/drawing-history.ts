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
  if (draft?.drawing == null) return 'canvas';
  if (draft.exporting) return 'drawing';
  if (action === 'undo') session.undoDrawing();
  else session.redoDrawing();
  return 'drawing';
}

/**
 * Whether the view bar's undo and redo can act: on the drawing while a drawing
 * tool is open, on the canvas otherwise.
 * @param drawing - The open tool's drawing, or null without one.
 * @param exporting - Whether the run is exporting.
 * @param canvasUndo - Whether the canvas has something to undo.
 * @param canvasRedo - Whether the canvas has something to redo.
 * @returns The two availabilities.
 */
export function historyAvailability(
  drawing: DrawingDraft | null,
  exporting: boolean,
  canvasUndo: boolean,
  canvasRedo: boolean,
): { canUndo: boolean; canRedo: boolean } {
  if (drawing === null) return { canUndo: canvasUndo, canRedo: canvasRedo };
  return {
    canUndo: !exporting && drawing.steps.length > 0,
    canRedo: !exporting && drawing.undone.length > 0,
  };
}

/**
 * Read `[` and `]` as a step down or up in brush size.
 * @param event - The key event.
 * @returns −1, +1, or null for any other key or a key with a modifier.
 */
export function brushSizeStep(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): -1 | 1 | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === '[') return -1;
  if (event.key === ']') return 1;
  return null;
}
