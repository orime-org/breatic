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
  routeHistoryCommand,
} from '@web/spaces/canvas/mini-tool/drawing-history';
import { createCanvasSessionStore } from '@web/stores/canvas-session';
import type { DrawOp } from '@web/stores/drawing-draft';

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
  it('follows the canvas without a drawing tool', () => {
    expect(historyAvailability(createCanvasSessionStore().getState(), true, false)).toEqual({
      canUndo: true,
      canRedo: false,
    });
  });

  it('follows the drawing while a drawing tool is open', () => {
    const store = withTool('image.inpaint');
    expect(historyAvailability(store.getState(), true, true)).toEqual({ canUndo: false, canRedo: false });
    store.getState().addDrawingStep(STROKE);
    store.getState().undoDrawing();
    expect(historyAvailability(store.getState(), true, true)).toEqual({ canUndo: false, canRedo: true });
    store.getState().redoDrawing();
    store.getState().setMiniToolExporting(true, store.getState().panelSession);
    expect(historyAvailability(store.getState(), true, true)).toEqual({ canUndo: false, canRedo: false });
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
});
