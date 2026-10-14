// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup canvas's write-back and reconcile rules (inner#1303 §6.2), driven
 * through a real Fabric canvas by firing the events Fabric itself fires.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IText, Path, Point } from 'fabric';

import { MarkCanvasController } from '@web/spaces/canvas/mini-tool/mark-canvas';
import { markFontPx } from '@web/spaces/canvas/mini-tool/mark-fabric';
import { createCanvasSessionStore } from '@web/stores/canvas-session';
import { BRUSH_SIZE, INK } from '@web/stores/drawing-draft';
import { steppedMarkSize, type MarkObject } from '@web/stores/mark-draft';

const BOX = { width: 400, height: 300 };
const RECT: MarkObject = { id: 'r', kind: 'rect', color: INK[0], size: 5, x: 0.1, y: 0.1, w: 0.25, h: 0.2 };
const TEXT: MarkObject = { id: 't', kind: 'text', color: INK[1], size: 5, x: 0.5, y: 0.5, text: 'eye' };

let store: ReturnType<typeof createCanvasSessionStore>;
let controller: MarkCanvasController;

beforeEach(() => {
  store = createCanvasSessionStore();
  store.getState().openMiniTool('n1', 'image.mark', { sourceContent: 'a.png', params: {} });
  const el = document.createElement('canvas');
  document.body.appendChild(el);
  controller = new MarkCanvasController(el, BOX, () => store.getState());
  controller.sync();
});

afterEach(() => {
  controller.dispose();
});

/** The open markup draft. */
const mark = () => store.getState().miniTool!.mark!;

/**
 * Fire a pointer event the way Fabric does.
 * @param type - The event.
 * @param x - Across, in drawn pixels.
 * @param y - Down, in drawn pixels.
 * @param button - The mouse button.
 */
function pointer(type: 'mouse:down' | 'mouse:move' | 'mouse:up', x: number, y: number, button = 0): void {
  const point = new Point(x, y);
  controller.canvas.fire(type, { e: { button } as MouseEvent, scenePoint: point, viewportPoint: point } as never);
}

/**
 * Draw with the current tool from one point to another.
 * @param from - Where the press starts.
 * @param to - Where it ends.
 * @param button - The mouse button.
 */
function drag(from: [number, number], to: [number, number], button = 0): void {
  pointer('mouse:down', ...from, button);
  pointer('mouse:move', ...to, button);
  pointer('mouse:up', ...to, button);
}

/**
 * The draft id of the canvas's active object.
 * @returns It, or undefined when nothing is active.
 */
const idOfActive = (): string | undefined => (controller.canvas.getActiveObject() as { markId?: string } | undefined)?.markId;

/** The text object being edited. */
const editing = (): IText => controller.canvas.getActiveObject() as IText;

describe('MarkCanvasController', () => {
  // Fabric reads its canvas again after `text:editing:exited` when the text
  // changed, so a new text holding only a space must still be on it then.
  it('drops a new text holding only a space without throwing', () => {
    store.getState().setMarkTool('text');
    controller.sync();
    drag([200, 150], [200, 150]);
    editing().set({ text: ' ' });
    controller.canvas.fire('text:changed', { target: editing() });
    expect(() => controller.channel.exitEditing()).not.toThrow();
    controller.sync();
    expect(mark().objects).toEqual([]);
    expect(mark().undo).toHaveLength(0);
    expect(controller.canvas.getObjects()).toHaveLength(0);
  });

  // §6.6: the source changing during a text edit leaves the edit without
  // writing it back, a new text included.
  it('drops a new text being typed when the source changes', () => {
    store.getState().setMarkTool('text');
    controller.sync();
    drag([200, 150], [200, 150]);
    editing().set({ text: 'hello' });
    controller.canvas.fire('text:changed', { target: editing() });
    store.getState().resetMiniToolSource('b.png', {});
    controller.sync();
    controller.dispose();
    expect(mark().objects).toEqual([]);
    expect(mark().undo).toHaveLength(0);
  });

  // Fabric lets a selection inside a text be dragged onto another text; the
  // draft has no such move.
  it('offers no dragging of text from one text to another', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    expect(text.shouldStartDragging()).toBe(false);
    expect(text.canDrop(new Event('drop') as DragEvent)).toBe(false);
  });

  it('draws what the draft holds', () => {
    store.getState().commitMark([RECT, TEXT]);
    controller.sync();
    expect(controller.canvas.getObjects()).toHaveLength(2);
  });

  it('adds a dragged rectangle as one step, goes back to select and selects it', () => {
    store.getState().setMarkTool('rect');
    controller.sync();
    drag([40, 30], [140, 90]);
    expect(mark().objects).toHaveLength(1);
    expect(mark().objects[0]).toMatchObject({ kind: 'rect', x: 0.1, y: 0.1, w: 0.25, h: 0.2, color: INK[0] });
    expect(mark().undo).toHaveLength(1);
    expect(mark().tool).toBe('select');
    expect(mark().selectedId).toBe(mark().objects[0]!.id);
  });

  it('adds nothing for a click with a shape tool', () => {
    store.getState().setMarkTool('rect');
    controller.sync();
    drag([40, 30], [41, 31]);
    expect(mark().objects).toHaveLength(0);
    expect(mark().undo).toHaveLength(0);
  });

  it('draws nothing with the right button', () => {
    store.getState().setMarkTool('ellipse');
    controller.sync();
    drag([40, 30], [140, 90], 2);
    expect(mark().objects).toHaveLength(0);
  });

  it('takes a pen stroke as one step', () => {
    store.getState().setMarkTool('pen');
    controller.sync();
    controller.canvas.fire('path:created', { path: new Path('M 40 30 L 80 60 L 120 30') });
    expect(mark().objects).toEqual([expect.objectContaining({ kind: 'pen', points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.1]] })]);
    expect(mark().undo).toHaveLength(1);
    expect(mark().tool).toBe('pen');
  });

  it('starts a text where the text tool is released and writes it back as one step', () => {
    store.getState().setMarkTool('text');
    controller.sync();
    drag([200, 150], [200, 150]);
    expect(mark().tool).toBe('select');
    expect(mark().editingText).toBe('');
    editing().set({ text: 'look here' });
    controller.canvas.fire('text:changed', { target: editing() });
    expect(mark().editingText).toBe('look here');
    controller.channel.exitEditing();
    expect(mark().objects).toEqual([expect.objectContaining({ kind: 'text', text: 'look here' })]);
    expect(mark().undo).toHaveLength(1);
    expect(mark().editingText).toBeNull();
  });

  it('drops a new text left empty, with no step', () => {
    store.getState().setMarkTool('text');
    controller.sync();
    drag([200, 150], [200, 150]);
    controller.channel.exitEditing();
    expect(mark().objects).toHaveLength(0);
    expect(mark().undo).toHaveLength(0);
    // The store's next sync, a microtask after the edit ends, takes it off.
    controller.sync();
    expect(controller.canvas.getObjects()).toHaveLength(0);
  });

  it('deletes an existing text emptied out, as one step', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    text.set({ text: '' });
    controller.canvas.fire('text:changed', { target: text });
    controller.channel.exitEditing();
    expect(mark().objects).toHaveLength(0);
    expect(mark().undo).toHaveLength(2);
  });

  it('takes no step for a text entered and left unchanged', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    controller.channel.exitEditing();
    expect(mark().undo).toHaveLength(1);
  });

  // §6.2: a text scaled past the slider's range keeps its size; the slider
  // shows it at the nearest step, and entering the text does not apply that.
  it('keeps the size of a text scaled past the slider through an edit', () => {
    store.getState().commitMark([{ ...TEXT, size: 40.5 }]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    const fontSize = text.fontSize;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    controller.sync();
    expect(text.fontSize).toBe(fontSize);
    controller.channel.exitEditing();
    expect(mark().objects[0]).toMatchObject({ size: 40.5 });
  });

  // §6.2: the key moves a scaled text back toward the range, in its edit as out of it.
  it('brings a scaled text into the range with one smaller step in its edit', () => {
    store.getState().commitMark([{ ...TEXT, size: 40.5 }]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    controller.sync();
    const smaller = steppedMarkSize(mark(), -1);
    expect(smaller).toBe(BRUSH_SIZE.max);
    store.getState().setMarkSize(smaller ?? 0);
    controller.sync();
    expect(text.fontSize).toBe(markFontPx(BRUSH_SIZE.max, BOX));
    controller.channel.exitEditing();
    expect(mark().objects[0]).toMatchObject({ size: BRUSH_SIZE.max });
  });

  it('changes only the colour of a scaled text whose colour changes in its edit', () => {
    store.getState().commitMark([{ ...TEXT, size: 40.5 }]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    const fontSize = text.fontSize;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    controller.sync();
    store.getState().setMarkColor(INK[3]);
    controller.sync();
    expect(text.fill).toBe(INK[3]);
    expect(text.fontSize).toBe(fontSize);
    controller.channel.exitEditing();
    expect(mark().objects[0]).toMatchObject({ color: INK[3], size: 40.5 });
  });

  it('keeps an existing text’s own colour through an edit with a different pen', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    controller.sync();
    expect(text.fill).toBe(INK[1]);
    controller.channel.exitEditing();
    expect(mark().objects[0]).toMatchObject({ color: INK[1] });
    expect(mark().undo).toHaveLength(1);
  });

  it('restyles a text being edited on the spot and writes it back once on leaving', () => {
    store.getState().setMarkTool('text');
    controller.sync();
    drag([200, 150], [200, 150]);
    editing().set({ text: 'hi' });
    controller.canvas.fire('text:changed', { target: editing() });
    store.getState().setMarkColor(INK[3]);
    controller.sync();
    expect(editing().fill).toBe(INK[3]);
    expect(mark().undo).toHaveLength(0);
    controller.channel.exitEditing();
    expect(mark().objects[0]).toMatchObject({ color: INK[3], text: 'hi' });
    expect(mark().undo).toHaveLength(1);
  });

  it('folds a resize into the draft and keeps the object selected', () => {
    store.getState().commitMark([RECT]);
    controller.sync();
    const shape = controller.canvas.getObjects()[0]!;
    controller.canvas.setActiveObject(shape);
    shape.set({ scaleX: 2 });
    controller.canvas.fire('object:modified', { target: shape } as never);
    controller.sync();
    expect(mark().objects[0]).toMatchObject({ w: 0.5 });
    expect(mark().undo).toHaveLength(2);
    expect(controller.canvas.getActiveObject()).toBeTruthy();
  });

  it('restyles a selected object as often as the controls change, keeping it selected', () => {
    store.getState().commitMark([RECT]);
    controller.sync();
    const shape = controller.canvas.getObjects()[0]!;
    controller.canvas.setActiveObject(shape);
    controller.canvas.fire('selection:created', { selected: [shape] } as never);
    store.getState().setMarkColor(INK[2]);
    controller.sync();
    store.getState().setMarkSize(9);
    controller.sync();
    expect(mark().objects[0]).toMatchObject({ color: INK[2], size: 9 });
    expect(mark().selectedId).toBe('r');
    expect(idOfActive()).toBe('r');
  });

  it('lets go of the selection on the canvas when a drawing tool is picked', () => {
    store.getState().commitMark([RECT]);
    controller.sync();
    const shape = controller.canvas.getObjects()[0]!;
    controller.canvas.setActiveObject(shape);
    controller.canvas.fire('selection:created', { selected: [shape] } as never);
    store.getState().setMarkTool('rect');
    controller.sync();
    expect(controller.canvas.getActiveObject()).toBeUndefined();
  });

  it('writes a move back after a text was entered and left unchanged', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    controller.channel.exitEditing();
    text.set({ left: (text.left ?? 0) + 40 });
    controller.canvas.fire('object:modified', { target: text } as never);
    expect(mark().objects[0]).toMatchObject({ x: 0.6 });
    expect(mark().undo).toHaveLength(2);
  });

  it('drops the selection when undo changes the objects', () => {
    store.getState().commitMark([RECT]);
    store.getState().commitMark([RECT, TEXT]);
    controller.sync();
    controller.canvas.setActiveObject(controller.canvas.getObjects()[0]!);
    store.getState().undoMark();
    controller.sync();
    expect(controller.canvas.getActiveObject()).toBeUndefined();
    expect(mark().selectedId).toBeNull();
    expect(controller.canvas.getObjects()).toHaveLength(1);
  });

  it('records which object is selected', () => {
    store.getState().commitMark([RECT]);
    controller.sync();
    const shape = controller.canvas.getObjects()[0]!;
    controller.canvas.setActiveObject(shape);
    controller.canvas.fire('selection:created', { selected: [shape] } as never);
    expect(mark().selectedId).toBe('r');
    controller.channel.discardSelection();
    expect(mark().selectedId).toBeNull();
    expect(controller.canvas.getActiveObject()).toBeUndefined();
  });

  it('writes back a text being edited when the canvas goes away', () => {
    store.getState().setMarkTool('text');
    controller.sync();
    drag([200, 150], [200, 150]);
    editing().set({ text: 'kept' });
    controller.canvas.fire('text:changed', { target: editing() });
    controller.dispose();
    expect(mark().objects).toEqual([expect.objectContaining({ text: 'kept' })]);
  });

  it('writes nothing back when the source changes during an edit', () => {
    store.getState().setMarkTool('text');
    controller.sync();
    drag([200, 150], [200, 150]);
    editing().set({ text: 'gone' });
    controller.canvas.fire('text:changed', { target: editing() });
    store.getState().resetMiniToolSource('b.png', {});
    controller.sync();
    expect(mark()).toMatchObject({ objects: [], undo: [], editingText: null });
  });
});
