// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Undo and redo while a drawing tool is open (inner#1302 §6.3): both entries
 * the canvas has, the keyboard and the view bar, act on the drawing.
 */

import { describe, expect, it } from 'vitest';

import {
  brushSizeStep,
  historyAvailability,
  routeDeleteCommand,
  routeHistoryCommand,
} from '@web/spaces/canvas/mini-tool/drawing-history';
import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { EMPTY_DRAWING, type DrawingDraft, type DrawOp } from '@web/stores/drawing-draft';
import { EMPTY_MARK, type MarkObject } from '@web/stores/mark-draft';

const STROKE: DrawOp = { kind: 'stroke', erase: false, size: 5, color: '#FF3B30', points: [[0.1, 0.1]] };
const OPEN = { sourceContent: 'a.png', params: {} };

/**
 * A store with a tool open.
 * @param toolId - The tool.
 * @returns The store.
 */
function withTool(toolId: string): ReturnType<typeof createCanvasSessionStore> {
  const store = createCanvasSessionStore();
  store.getState().openMiniTool('n1', toolId, OPEN);
  return store;
}

describe('routeHistoryCommand', () => {
  it('leaves undo to the canvas when no drawing tool is open', () => {
    expect(routeHistoryCommand(createCanvasSessionStore().getState(), 'undo')).toBe('canvas');
    expect(routeHistoryCommand(withTool('image.upscale').getState(), 'undo')).toBe('canvas');
  });

  it('takes undo and redo for the drawing', () => {
    const store = withTool('image.inpaint');
    store.getState().addDrawingStep(STROKE);
    expect(routeHistoryCommand(store.getState(), 'undo')).toBe('drawing');
    expect(store.getState().miniTool?.drawing?.steps).toEqual([]);
    expect(routeHistoryCommand(store.getState(), 'redo')).toBe('drawing');
    expect(store.getState().miniTool?.drawing?.steps).toEqual([STROKE]);
  });

  it('keeps an empty drawing history from reaching the canvas', () => {
    expect(routeHistoryCommand(withTool('image.sketch').getState(), 'undo')).toBe('drawing');
  });

  it('does nothing to the drawing while the run is exporting', () => {
    const store = withTool('image.inpaint');
    store.getState().addDrawingStep(STROKE);
    store.getState().setMiniToolExporting(true, store.getState().panelSession);
    expect(routeHistoryCommand(store.getState(), 'undo')).toBe('drawing');
    expect(store.getState().miniTool?.drawing?.steps).toEqual([STROKE]);
  });
});

describe('historyAvailability', () => {
  const drawing = (steps: number, undone: number): DrawingDraft => ({
    ...EMPTY_DRAWING,
    steps: Array.from({ length: steps }, () => STROKE),
    undone: Array.from({ length: undone }, () => STROKE),
  });

  it('follows the canvas without a drawing tool', () => {
    expect(historyAvailability(null, false, true, false)).toEqual({ canUndo: true, canRedo: false });
  });

  it('follows the drawing while a drawing tool is open', () => {
    expect(historyAvailability(drawing(0, 0), false, true, true)).toEqual({ canUndo: false, canRedo: false });
    expect(historyAvailability(drawing(0, 1), false, true, true)).toEqual({ canUndo: false, canRedo: true });
    expect(historyAvailability(drawing(1, 0), false, false, false)).toEqual({ canUndo: true, canRedo: false });
  });

  it('offers neither while the run is exporting', () => {
    expect(historyAvailability(drawing(1, 1), true, true, true)).toEqual({ canUndo: false, canRedo: false });
  });

  it('reads the markup as leaving the text edit would leave it, as the panel does', () => {
    // The first text is being typed: leaving the edit writes it as a step, and
    // that step clears whatever redo held.
    const typing = { ...EMPTY_MARK, redo: [[]], selectedId: 'new', editingText: 'hello' };
    expect(historyAvailability(typing, false, false, false)).toEqual({ canUndo: true, canRedo: false });
  });
});

describe('brushSizeStep', () => {
  const key = (k: string, over: Partial<KeyboardEvent> = {}) =>
    ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...over }) as KeyboardEvent;

  it('reads [ and ] as one smaller and one larger', () => {
    expect(brushSizeStep(key('['))).toBe(-1);
    expect(brushSizeStep(key(']'))).toBe(1);
  });

  it('ignores them with a modifier, and every other key', () => {
    expect(brushSizeStep(key('[', { metaKey: true }))).toBeNull();
    expect(brushSizeStep(key(']', { ctrlKey: true }))).toBeNull();
    expect(brushSizeStep(key('a'))).toBeNull();
  });

  // A German Mac types [ with Option, and AltGr on Windows is Ctrl+Alt.
  it('reads [ and ] typed with Option or AltGr', () => {
    expect(brushSizeStep(key('[', { altKey: true }))).toBe(-1);
    expect(brushSizeStep(key(']', { ctrlKey: true, altKey: true }))).toBe(1);
  });
});

describe('the markup tool', () => {
  const A: MarkObject = { id: 'a', kind: 'rect', color: '#FF3B30', size: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

  /**
   * A store with markup open and a channel that records what it was asked.
   * @returns The store and the calls.
   */
  function withMark(): { store: ReturnType<typeof createCanvasSessionStore>; calls: string[] } {
    const store = withTool('image.mark');
    const calls: string[] = [];
    store.getState().registerMarkChannel({
      exitEditing: () => {
        calls.push('exitEditing');
        store.getState().setMarkEditingText(null);
      },
      discardSelection: () => {
        calls.push('discardSelection');
        store.getState().selectMark(null);
      },
    });
    return { store, calls };
  }

  it('takes undo and redo for the markup', () => {
    const { store } = withMark();
    store.getState().commitMark([A]);
    expect(routeHistoryCommand(store.getState(), 'undo')).toBe('drawing');
    expect(store.getState().miniTool?.mark?.objects).toEqual([]);
    expect(routeHistoryCommand(store.getState(), 'redo')).toBe('drawing');
    expect(store.getState().miniTool?.mark?.objects).toEqual([A]);
  });

  it('leaves the text being edited before it undoes', () => {
    const { store, calls } = withMark();
    store.getState().setMarkEditingText('hi');
    routeHistoryCommand(store.getState(), 'undo');
    expect(calls).toEqual(['exitEditing']);
  });

  it('follows the markup’s steps for the undo and redo buttons', () => {
    const { store } = withMark();
    store.getState().commitMark([A]);
    expect(historyAvailability(store.getState().miniTool?.mark ?? null, false, false, false)).toEqual({
      canUndo: true,
      canRedo: false,
    });
  });
});

describe('routeDeleteCommand', () => {
  const A: MarkObject = { id: 'a', kind: 'rect', color: '#FF3B30', size: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2 };

  it('leaves the delete key to the canvas without markup, or with nothing selected', () => {
    expect(routeDeleteCommand(createCanvasSessionStore().getState())).toBe('canvas');
    expect(routeDeleteCommand(withTool('image.mark').getState())).toBe('canvas');
  });

  it('deletes the selected object rather than the node', () => {
    const store = withTool('image.mark');
    store.getState().commitMark([A]);
    store.getState().selectMark('a');
    expect(routeDeleteCommand(store.getState())).toBe('mark');
    expect(store.getState().miniTool?.mark).toMatchObject({ objects: [], selectedId: null });
  });

  it('only leaves the text being edited when the caret is not in it', () => {
    const store = withTool('image.mark');
    const calls: string[] = [];
    store.getState().registerMarkChannel({ exitEditing: () => calls.push('exitEditing'), discardSelection: () => undefined });
    store.getState().commitMark([A]);
    store.getState().selectMark('a');
    store.getState().setMarkEditingText('hi');
    expect(routeDeleteCommand(store.getState())).toBe('mark');
    expect(calls).toEqual(['exitEditing']);
    expect(store.getState().miniTool?.mark?.objects).toEqual([A]);
  });

  it('leaves the delete key to the canvas while the press is exporting', () => {
    const store = withTool('image.mark');
    store.getState().commitMark([A]);
    store.getState().selectMark('a');
    store.getState().setMiniToolExporting(true, store.getState().panelSession);
    expect(routeDeleteCommand(store.getState())).toBe('canvas');
  });
});
