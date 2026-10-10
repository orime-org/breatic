// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { visibleOps, type DrawOp } from '@web/stores/drawing-draft';

const OPEN = { sourceContent: 'https://cdn.example.com/a.png', params: {} };

const STROKE: DrawOp = { kind: 'stroke', erase: false, size: 5, color: '#FF3B30', points: [[0.1, 0.1], [0.2, 0.2]] };
const RECT: DrawOp = { kind: 'rect', size: 5, color: '#FF3B30', x: 0.1, y: 0.1, w: 0.3, h: 0.2 };

/**
 * A store with Inpaint open on node-a.
 * @returns The store.
 */
function withInpaint(): ReturnType<typeof createCanvasSessionStore> {
  const store = createCanvasSessionStore();
  store.getState().openMiniTool('node-a', 'image.inpaint', OPEN);
  return store;
}

describe('visibleOps', () => {
  it('shows only the ops after the last clear', () => {
    expect(visibleOps([STROKE, { kind: 'clear' }, RECT])).toEqual([RECT]);
    expect(visibleOps([STROKE, RECT])).toEqual([STROKE, RECT]);
    expect(visibleOps([STROKE, { kind: 'clear' }])).toEqual([]);
  });
});

describe('the drawing draft', () => {
  it('starts a drawing tool with the brush at size 5, the first ink and a pink mask', () => {
    expect(withInpaint().getState().miniTool?.drawing).toEqual({
      tool: 'brush',
      size: 5,
      color: '#FF3B30',
      maskColor: 'pink',
      steps: [],
      undone: [],
    });
  });

  it('holds no drawing for a tool without one', () => {
    const store = createCanvasSessionStore();
    store.getState().openMiniTool('node-a', 'image.upscale', OPEN);
    expect(store.getState().miniTool?.drawing).toBeNull();
  });

  it('adds a step and empties what was undone', () => {
    const store = withInpaint();
    store.getState().addDrawingStep(STROKE);
    store.getState().undoDrawing();
    store.getState().addDrawingStep(RECT);
    expect(store.getState().miniTool?.drawing?.steps).toEqual([RECT]);
    expect(store.getState().miniTool?.drawing?.undone).toEqual([]);
  });

  it('undoes and redoes one step at a time', () => {
    const store = withInpaint();
    store.getState().addDrawingStep(STROKE);
    store.getState().addDrawingStep(RECT);
    store.getState().undoDrawing();
    expect(store.getState().miniTool?.drawing?.steps).toEqual([STROKE]);
    store.getState().redoDrawing();
    expect(store.getState().miniTool?.drawing?.steps).toEqual([STROKE, RECT]);
  });

  it('takes a clear back with one undo', () => {
    const store = withInpaint();
    store.getState().addDrawingStep(STROKE);
    store.getState().addDrawingStep({ kind: 'clear' });
    expect(visibleOps(store.getState().miniTool!.drawing!.steps)).toEqual([]);
    store.getState().undoDrawing();
    expect(visibleOps(store.getState().miniTool!.drawing!.steps)).toEqual([STROKE]);
  });

  it('changes nothing when there is nothing to undo or redo', () => {
    const store = withInpaint();
    const before = store.getState().miniTool?.drawing;
    store.getState().undoDrawing();
    store.getState().redoDrawing();
    expect(store.getState().miniTool?.drawing).toEqual(before);
  });

  it('keeps the tool, size and colours but drops every step when the source changes', () => {
    const store = withInpaint();
    store.getState().setDrawingTool('rect');
    store.getState().setDrawingSize(12);
    store.getState().setDrawingColor('#0A84FF');
    store.getState().setMaskColor('green');
    store.getState().addDrawingStep(STROKE);
    store.getState().undoDrawing();
    store.getState().resetMiniToolSource('https://cdn.example.com/b.png', {});
    expect(store.getState().miniTool?.drawing).toEqual({
      tool: 'rect',
      size: 12,
      color: '#0A84FF',
      maskColor: 'green',
      steps: [],
      undone: [],
    });
  });

  it('starts a fresh drawing when another tool opens', () => {
    const store = withInpaint();
    store.getState().addDrawingStep(STROKE);
    store.getState().openMiniTool('node-a', 'image.erase', OPEN);
    expect(store.getState().miniTool?.drawing?.steps).toEqual([]);
  });
});

describe('exporting', () => {
  it('starts false and follows the run of the opening it was pressed in', () => {
    const store = withInpaint();
    expect(store.getState().miniTool?.exporting).toBe(false);
    const session = store.getState().panelSession;
    store.getState().setMiniToolExporting(true, session);
    expect(store.getState().miniTool?.exporting).toBe(true);
    store.getState().setMiniToolExporting(false, session);
    expect(store.getState().miniTool?.exporting).toBe(false);
  });

  it('leaves another opening alone when a late run finishes', () => {
    const store = withInpaint();
    const first = store.getState().panelSession;
    store.getState().setMiniToolExporting(true, first);
    store.getState().closeActivePanel();
    store.getState().openMiniTool('node-a', 'image.inpaint', OPEN);
    const second = store.getState().panelSession;
    store.getState().setMiniToolExporting(true, second);
    store.getState().setMiniToolExporting(false, first);
    expect(store.getState().miniTool?.exporting).toBe(true);
  });
});
