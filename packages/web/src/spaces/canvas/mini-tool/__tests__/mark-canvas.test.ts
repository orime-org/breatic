// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup canvas's write-back and reconcile rules (inner#1303 §6.2), driven
 * through a real Fabric canvas by firing the events Fabric itself fires.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IText, Path, PencilBrush, Point, util } from 'fabric';

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
  controller = new MarkCanvasController(el, BOX, () => store.getState(), 1);
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
  // §6.2: the canvas draws at the pixels the node takes on screen, so Fabric's
  // handles keep one screen size and the strokes stay sharp at any zoom.
  it('draws at the node’s screen size and keeps the scene in drawn pixels', () => {
    controller.setZoom(0.25);
    expect(controller.canvas.width).toBe(100);
    expect(controller.canvas.height).toBe(75);
    expect(controller.canvas.getZoom()).toBe(0.25);
    expect(controller.canvas.getElement().style.width).toBe('400px');
    controller.setZoom(2);
    expect(controller.canvas.width).toBe(800);
    expect(controller.canvas.getZoom()).toBe(2);
    expect(controller.canvas.getElement().style.height).toBe('300px');
  });

  // Fabric puts its text input on the page body at the caret's unzoomed place
  // plus the canvas's screen offset, which is off the caret on a zoomed page
  // and can scroll the page; inside the canvas's own box it follows the node.
  it('keeps Fabric’s text input in the canvas, at the caret in the canvas’s own pixels', () => {
    controller.setZoom(0.5);
    store.getState().setMarkTool('text');
    controller.sync();
    drag([300, 150], [300, 150]);
    const area = editing().hiddenTextarea!;
    expect(area.parentElement).toBe(controller.canvas.wrapperEl);
    expect(Math.abs(parseFloat(area.style.left) - 300)).toBeLessThan(5);
    expect(parseFloat(area.style.top)).toBeGreaterThan(150);
    expect(parseFloat(area.style.top)).toBeLessThan(150 + 100);
  });

  it('builds the canvas at the zoom it is given', () => {
    const el = document.createElement('canvas');
    document.body.appendChild(el);
    const zoomed = new MarkCanvasController(el, BOX, () => store.getState(), 0.5);
    expect(zoomed.canvas.width).toBe(200);
    expect(zoomed.canvas.getZoom()).toBe(0.5);
    expect(zoomed.canvas.getElement().style.width).toBe('400px');
    zoomed.dispose();
  });

  // The click threshold is in screen pixels (§6.2): at 25% a 3px hand tremor
  // spans 12 drawn pixels and is still a click.
  it('takes a press that moves less than the threshold on screen as a click at any zoom', () => {
    controller.setZoom(0.25);
    store.getState().setMarkTool('rect');
    controller.sync();
    const at = (x: number, y: number) => ({ scenePoint: new Point(x, y), viewportPoint: new Point(x * 0.25, y * 0.25) });
    controller.canvas.fire('mouse:down', { e: { button: 0 } as MouseEvent, ...at(100, 100) } as never);
    controller.canvas.fire('mouse:move', { e: { button: 0 } as MouseEvent, ...at(112, 112) } as never);
    controller.canvas.fire('mouse:up', { e: { button: 0 } as MouseEvent, ...at(112, 112) } as never);
    expect(mark().objects).toEqual([]);
    controller.canvas.fire('mouse:down', { e: { button: 0 } as MouseEvent, ...at(100, 100) } as never);
    controller.canvas.fire('mouse:up', { e: { button: 0 } as MouseEvent, ...at(120, 100) } as never);
    expect(mark().objects).toHaveLength(1);
  });

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

  // §6.6: a drag in a text being edited selects a range. Fabric's drag
  // delegate takes a press over the selected words and the press's own
  // handling stops there (`ITextClickBehavior.ts:108-110`); its `start` is the
  // place Fabric names to turn that off and keep the press
  // (`DraggableTextDelegate.ts:62`).
  it('leaves a press over the selected words to the text, so a drag selects a range', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    const delegate = (text as unknown as { draggableTextDelegate: { start: (e: MouseEvent) => boolean; isPointerOverSelection: (e: MouseEvent) => boolean } }).draggableTextDelegate;
    vi.spyOn(delegate, 'isPointerOverSelection').mockReturnValue(true);
    expect(delegate.start(new MouseEvent('mousedown'))).toBe(false);
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
    const samples = [new Point(40, 30), new Point(80, 60), new Point(120, 30)];
    controller.canvas.fire('path:created', { path: new Path(util.getSmoothPathFromPoints(samples, 0.004)) });
    expect(mark().objects).toEqual([expect.objectContaining({ kind: 'pen' })]);
    expect(mark().undo).toHaveLength(1);
    expect(mark().tool).toBe('pen');
  });

  // A hollow object is hit on its stroke, as a shape with no fill is elsewhere:
  // a click inside it reaches what lies under it (A4).
  describe('hit testing', () => {
    /**
     * The markup object under a press.
     * @param x - Across, in drawn pixels.
     * @param y - Down, in drawn pixels.
     * @returns Its id, if any.
     */
    const under = (x: number, y: number): string | undefined =>
      (controller.canvas.findTarget({ clientX: x, clientY: y, button: 0 } as unknown as MouseEvent).target as
        | { markId?: string }
        | undefined)?.markId;

    beforeEach(() => {
      store.getState().commitMark([
        { id: 'r', kind: 'rect', color: INK[0], size: 5, x: 0.45, y: 0.45, w: 0.1, h: 0.1 },
        { id: 'e', kind: 'ellipse', color: INK[1], size: 5, x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
      ]);
      controller.sync();
    });

    // The ellipse's stroke is drawn inside its frame, x 80 to 83.75 on the row
    // through its centre; a press within 6 screen pixels of it on either side
    // hits it (§6.2), whatever the page's zoom.
    describe.each([0.5, 1, 2])('at zoom %s', (zoom) => {
      /**
       * The markup object under a press at the page's zoom.
       * @param x - Across, in drawn pixels.
       * @param y - Down, in drawn pixels.
       * @returns Its id, if any.
       */
      const onScreen = (x: number, y: number): string | undefined => under(x * zoom, y * zoom);

      beforeEach(() => {
        controller.setZoom(zoom);
      });

      it('finds an object inside a later hollow ellipse', () => {
        expect(onScreen(180, 150)).toBe('r');
      });

      it('finds nothing in the empty inside of a hollow ellipse', () => {
        expect(onScreen(120, 150)).toBeUndefined();
      });

      it('finds the hollow ellipse on its stroke', () => {
        expect(onScreen(80, 150)).toBe('e');
      });

      it('finds the hollow ellipse 5 screen pixels inside its stroke', () => {
        expect(onScreen(83.75 + 5 / zoom, 150)).toBe('e');
      });

      it('finds the hollow ellipse 5 screen pixels outside its stroke', () => {
        expect(onScreen(80 - 5 / zoom, 150)).toBe('e');
      });

      /**
       * Select a markup object on the canvas.
       * @param id - Its draft id.
       */
      const select = (id: string): void => {
        controller.canvas.setActiveObject(controller.canvas.getObjects().find((o) => (o as { markId?: string }).markId === id)!);
      };

      it('finds a selected hollow object anywhere inside its frame', () => {
        select('e');
        expect(onScreen(120, 150)).toBe('e');
      });

      it('finds what is drawn above a selected object rather than the selection', () => {
        store.getState().commitMark([...mark().objects].reverse());
        controller.sync();
        select('e');
        expect(onScreen(180, 150)).toBe('r');
      });

      it('finds nothing outside a selected object’s frame where nothing else is drawn', () => {
        select('r');
        expect(onScreen(120, 150)).toBeUndefined();
      });

      it('finds a thin straight line 4 screen pixels off it', () => {
        store.getState().commitMark([{ id: 'l', kind: 'line', color: INK[2], size: 1, x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.1 }]);
        controller.sync();
        expect(onScreen(200, 30 - 4 / zoom)).toBe('l');
        expect(onScreen(200, 30 + 4 / zoom)).toBe('l');
      });
    });
  });

  // A click gives the pencil the press point twice, drawn as an `M` and an
  // `L` a thousandth of the stroke either side of it.
  it('keeps a click as a dot', () => {
    store.getState().setMarkTool('pen');
    controller.sync();
    controller.canvas.fire('path:created', { path: new Path(util.getSmoothPathFromPoints([new Point(40, 30)], 0.004)) });
    const [dot] = mark().objects;
    expect(dot).toMatchObject({ kind: 'pen' });
    const points = dot?.kind === 'pen' ? dot.points : [];
    expect(points).toHaveLength(2);
    for (const [x, y] of points) {
      expect(x).toBeCloseTo(0.1, 4);
      expect(y).toBeCloseTo(0.1, 4);
    }
  });

  // Every sample the pointer gave reaches the stroke; Fabric's decimation
  // would drop the one before the last (PencilBrush.decimatePoints).
  it('keeps every sample the pencil took, the one before the last too', () => {
    store.getState().setMarkTool('pen');
    controller.sync();
    const brush = controller.canvas.freeDrawingBrush as PencilBrush;
    const e = { isPrimary: true } as unknown as PointerEvent;
    const at = [[60, 210], [120, 90], [180, 210], [240, 90], [300, 210]];
    brush.onMouseDown(new Point(at[0]![0]!, at[0]![1]!), { e });
    for (const [x, y] of at.slice(1)) brush.onMouseMove(new Point(x!, y!), { e });
    brush.onMouseUp({ e });
    const [stroke] = mark().objects;
    const points = stroke?.kind === 'pen' ? stroke.points : [];
    expect(points.map(([x, y]) => [Math.round(x * 400), Math.round(y * 300)])).toEqual(at);
  });

  // Fabric's pencil smooths the samples into curves whose end points are the
  // midpoints between them; the stroke keeps the samples the curves go through.
  it('keeps the points the pencil sampled, not the curves’ end points', () => {
    store.getState().setMarkTool('pen');
    controller.sync();
    const samples = [new Point(40, 30), new Point(80, 60), new Point(120, 30)];
    controller.canvas.fire('path:created', { path: new Path(util.getSmoothPathFromPoints(samples, 0)) });
    expect(mark().objects).toEqual([expect.objectContaining({ kind: 'pen', points: [[0.1, 0.1], [0.2, 0.2], [0.3, 0.1]] })]);
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

  // A text is written back in the box it was drawn in; the new box only
  // draws what the draft then holds.
  it('writes a text being edited back where it was when the picture is drawn at a new size', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    text.set({ text: 'eyes' });
    controller.canvas.fire('text:changed', { target: text });
    controller.setBox({ width: BOX.width * 2, height: BOX.height * 2 });
    expect(mark().objects[0]).toMatchObject({ text: 'eyes', x: TEXT.x, y: TEXT.y });
    expect(mark().editingText).toBeNull();
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

  // A press on another object while a text is typed ends the edit, which
  // writes the text back before Fabric's first move; the sync that follows
  // keeps the pressed object, so Fabric's drag of it goes on (§6.6).
  it.each(['hi', ''])('keeps dragging an object pressed straight out of a text edit (typed "%s")', (typed) => {
    store.getState().commitMark([RECT]);
    controller.sync();
    const rect = controller.canvas.getObjects()[0]!;
    store.getState().setMarkTool('text');
    controller.sync();
    drag([300, 200], [300, 200]);
    if (typed !== '') {
      editing().set({ text: typed });
      controller.canvas.fire('text:changed', { target: editing() });
    }
    const press = new MouseEvent('mousedown', { clientX: 60, clientY: 40, button: 0 });
    const canvas = controller.canvas as unknown as {
      _setupCurrentTransform: (e: MouseEvent, target: unknown, alreadySelected: boolean) => void;
      _currentTransform: { target: unknown } | null;
    };
    controller.canvas.setActiveObject(rect, press);
    canvas._setupCurrentTransform(press, rect, false);
    controller.sync();
    expect(controller.canvas.getObjects()).toContain(rect);
    expect(controller.canvas.getActiveObject()).toBe(rect);
    expect(canvas._currentTransform?.target).toBe(rect);
    expect(controller.canvas.getObjects()).toHaveLength(typed === '' ? 1 : 2);
  });

  // Fabric changes a text in place while it is typed; an undo in the same
  // tick as leaving the edit puts back the draft the canvas was drawn from.
  it('draws the undone text when undo follows leaving an edit at once', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    text.set({ text: 'eyes' });
    controller.canvas.fire('text:changed', { target: text });
    controller.channel.exitEditing();
    store.getState().undoMark();
    controller.sync();
    expect(controller.canvas.getObjects().map((shape) => (shape as IText).text)).toEqual(['eye']);
  });

  // A restyle alone changes the text in place too, and Fabric reports no
  // modification for it on leaving.
  it('draws the undone colour when undo follows leaving a restyled edit at once', () => {
    store.getState().commitMark([TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects()[0] as IText;
    controller.canvas.setActiveObject(text);
    text.enterEditing();
    store.getState().setMarkColor(INK[3]);
    controller.sync();
    expect(text.fill).toBe(INK[3]);
    controller.channel.exitEditing();
    store.getState().undoMark();
    controller.sync();
    expect(controller.canvas.getObjects().map((shape) => shape.fill)).toEqual([TEXT.color]);
  });

  // An undo while an object is held ends Fabric's drag of it under the
  // canvas's own changes, which write nothing back.
  it.each(['undo', 'redo'] as const)('draws a held object where the draft has it after %s', (step) => {
    const other: MarkObject = { ...RECT, id: 'r2', x: 0.6, y: 0.6 };
    store.getState().commitMark([RECT]);
    store.getState().commitMark([RECT, other]);
    if (step === 'redo') store.getState().undoMark();
    controller.sync();
    const held = controller.canvas.getObjects()[0]!;
    const press = new MouseEvent('mousedown', { clientX: 60, clientY: 40, button: 0 });
    const canvas = controller.canvas as unknown as {
      _setupCurrentTransform: (e: MouseEvent, target: unknown, alreadySelected: boolean) => void;
      _currentTransform: { actionPerformed: boolean } | null;
    };
    controller.canvas.setActiveObject(held, press);
    canvas._setupCurrentTransform(press, held, false);
    held.set({ left: (held.left ?? 0) + 80 });
    canvas._currentTransform!.actionPerformed = true;
    if (step === 'undo') store.getState().undoMark();
    else store.getState().redoMark();
    controller.sync();
    const drawn = controller.canvas.getObjects().find((shape) => (shape as { markId?: string }).markId === RECT.id);
    expect(drawn?.left).toBeCloseTo(RECT.x * BOX.width, 0);
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

  // Markup opened on another node replaces the draft before this canvas goes.
  it('writes a text being edited into no other opening’s draft when the canvas goes away', () => {
    store.getState().setMarkTool('text');
    controller.sync();
    drag([200, 150], [200, 150]);
    editing().set({ text: 'node one' });
    controller.canvas.fire('text:changed', { target: editing() });
    store.getState().openMiniTool('n2', 'image.mark', { sourceContent: 'b.png', params: {} });
    controller.dispose();
    expect(mark()).toMatchObject({ objects: [], undo: [], editingText: null, selectedId: null });
  });

  // Every write a canvas makes goes to the opening it was built for: what
  // Fabric still sends it after the panel moved on reaches no other draft.
  it('writes none of Fabric’s later events into another opening’s draft', () => {
    store.getState().commitMark([RECT, TEXT]);
    controller.sync();
    const text = controller.canvas.getObjects().find((shape) => (shape as { markId?: string }).markId === 't') as IText;
    store.getState().openMiniTool('n2', 'image.mark', { sourceContent: 'b.png', params: {} });
    controller.canvas.fire('selection:created', { selected: [text] } as never);
    controller.canvas.fire('text:editing:entered', { target: text } as never);
    controller.canvas.fire('text:changed', { target: text } as never);
    pointer('mouse:down', 10, 10);
    pointer('mouse:up', 10, 10);
    expect(mark()).toMatchObject({ objects: [], undo: [], editingText: null, selectedId: null });
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
