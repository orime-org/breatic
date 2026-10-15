// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup canvas on the node (inner#1303 §6.2), as a controller over one
 * Fabric canvas. The draft's object list is the only copy of what is drawn:
 * the reader's gestures are written back to it, one step each, and a change
 * made elsewhere (undo, redo, clear, a source reset) is reconciled onto the
 * canvas object by object, dropping a text edit it changed first.
 *
 * Kept apart from React so its rules can be driven through a real Fabric
 * canvas in tests. Loaded only with the markup canvas.
 */

import { Canvas, IText, PencilBrush, type FabricObject, type Point } from 'fabric';

import { newId } from '@breatic/shared';

import { fromFabric, markFontPx, markStrokePx, toFabric, type DrawBox, type MarkFabricObject } from '@web/spaces/canvas/mini-tool/mark-fabric';
import type { CanvasSessionState } from '@web/stores/canvas-session';
import type { MarkChannel, MarkDraft, MarkObject } from '@web/stores/mark-draft';

/** Below this drag, in screen pixels, a shape tool's press is a click and draws nothing. */
export const MARK_MIN_DRAG_PX = 4;

/** What a pointer event from Fabric carries that this canvas reads. */
interface PointerInfo {
  e: { button?: number };
  scenePoint: Point;
  /** Where the pointer is in screen pixels over the canvas; the canvas draws at the node's screen size. */
  viewportPoint: Point;
}

/** The text being edited: its object, whether it is new, and how it stood when the edit began. */
interface Edit {
  id: string;
  isNew: boolean;
  /** The text as the edit began, which says whether leaving it changed anything. */
  textAtEntry: string;
}

/**
 * The tag a Fabric object carries to tie it to its draft object.
 * @param shape - The object.
 * @returns Its draft object's id, when it has one.
 */
const idOf = (shape: FabricObject | undefined): string | undefined => (shape as Partial<MarkFabricObject> | undefined)?.markId;

/**
 * One markup canvas.
 */
export class MarkCanvasController {
  /** The Fabric canvas. */
  readonly canvas: Canvas;

  /** How the handlers outside the canvas ask it to leave a text edit or drop its selection. */
  readonly channel: MarkChannel;

  private box: DrawBox;

  /** The canvas page's zoom, which the node is drawn at on screen. */
  private zoom: number;

  private readonly read: () => CanvasSessionState;

  /** The opening of the panel this canvas draws for; a later one has its own draft. */
  private readonly opening: number;

  /** Set while this canvas changes itself to match the draft; no event is written back then. */
  private suppressed = false;

  /** Each draft object on the canvas, by id, as it stood when it was drawn; Fabric changing one in place forgets it. */
  private readonly drawn = new Map<string, string>();

  /** The object list the canvas last drew or wrote; a draft that differs from it changed under a text edit. */
  private lastSeen = '[]';

  /** The shape being dragged out, with where the press began. */
  private pending: { start: Point; startOnScreen: Point; shape: MarkFabricObject | null } | null = null;

  private edit: Edit | null = null;

  /** The text just left, whose `object:modified` Fabric sends right after and is not written back again. */
  private justLeft: FabricObject | null = null;

  /** The canvas's own uniform-scale key while a text is being scaled. */
  private heldUniScaleKey: Canvas['uniScaleKey'] | undefined;

  private disposed = false;

  /**
   * Build the canvas over an element.
   * @param el - The canvas element.
   * @param box - The picture's drawn size.
   * @param session - Reads the canvas session.
   * @param zoom - The canvas page's zoom.
   */
  constructor(el: HTMLCanvasElement, box: DrawBox, session: () => CanvasSessionState, zoom: number) {
    this.box = box;
    this.zoom = zoom;
    this.read = session;
    this.opening = session().panelSession;
    this.canvas = new Canvas(el, {
      width: box.width,
      height: box.height,
      selection: false,
      stopContextMenu: false,
      fireRightClick: false,
      preserveObjectStacking: true,
    });
    this.fitToScreen();
    this.canvas.freeDrawingBrush = new PencilBrush(this.canvas);
    this.channel = {
      exitEditing: () => this.exitEditing(),
      discardSelection: () => {
        this.canvas.discardActiveObject();
        this.canvas.requestRenderAll();
        this.unselect();
      },
    };
    this.wire();
  }

  /**
   * The canvas session, while the panel is still on the opening this canvas
   * was built for. Every read of the draft and every write goes through it, so
   * a canvas outliving its opening touches no later one.
   * @returns The session, or null once the panel was closed or opened again.
   */
  private live(): CanvasSessionState | null {
    const session = this.read();
    return session.panelSession === this.opening ? session : null;
  }

  /**
   * The markup draft of the opening this canvas was built for.
   * @returns It, or null when markup is not open or the panel was opened again since.
   */
  private draft(): MarkDraft | null {
    return this.live()?.miniTool?.mark ?? null;
  }

  /** Clear the draft's selection, when it has one. */
  private unselect(): void {
    const session = this.live();
    if (session?.miniTool?.mark?.selectedId != null) session.selectMark(null);
  }

  /**
   * Write an object list back, as one step when it changed.
   * @param objects - The list.
   */
  private commit(objects: readonly MarkObject[]): void {
    this.lastSeen = JSON.stringify(objects);
    this.live()?.commitMark(objects);
  }

  /**
   * Resize the canvas to the picture's drawn size and redraw. A text being
   * edited is written back first, in the box it was drawn in.
   * @param box - The size.
   */
  setBox(box: DrawBox): void {
    if (box.width === this.box.width && box.height === this.box.height) return;
    if (this.edit !== null) this.exitEditing();
    this.box = box;
    this.fitToScreen();
    this.drawn.clear();
    this.sync();
  }

  /**
   * Follow the canvas page's zoom.
   * @param zoom - The zoom.
   */
  setZoom(zoom: number): void {
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    this.fitToScreen();
    this.canvas.requestRenderAll();
  }

  /**
   * Size the canvas to the node's screen pixels. The element keeps the drawn
   * size, which the page's zoom scales on screen; its pixels and Fabric's
   * viewport are the screen's, so Fabric's handles keep one screen size and
   * strokes stay sharp, while the scene stays in drawn pixels.
   */
  private fitToScreen(): void {
    this.canvas.setDimensions(this.box, { cssOnly: true });
    this.canvas.setDimensions({ width: this.box.width * this.zoom, height: this.box.height * this.zoom }, { backstoreOnly: true });
    this.canvas.setZoom(this.zoom);
  }

  /**
   * Bring the canvas in line with the draft: the tool, an edited text's style,
   * the objects and the selection. The draft alone says what is selected: undo,
   * redo, clear and a new source drop it there, a restyle keeps it. Objects the
   * draft did not change stay as they are, with any drag Fabric has of them.
   * A selection the draft no longer holds goes first: ending it ends Fabric's
   * drag of the object, which then reports the object changed and is drawn
   * again from the draft.
   */
  sync(): void {
    const before = this.draft();
    if (before === null || this.disposed) return;
    this.settleEdit(before);
    const draft = this.draft();
    if (draft === null) return;
    this.applyTool(draft);
    this.restyleEdit();
    const json = JSON.stringify(draft.objects);
    this.suppressed = true;
    try {
      if (this.edit === null && idOf(this.canvas.getActiveObject()) !== (draft.selectedId ?? undefined)) {
        this.canvas.discardActiveObject();
      }
      this.reconcile(draft.objects);
      this.lastSeen = json;
      this.alignSelection(draft);
    } finally {
      this.suppressed = false;
    }
    this.canvas.requestRenderAll();
  }

  /**
   * Make the canvas's objects the draft's: one whose draft object changed or
   * went is taken off, and the selection with it when it was selected; one the
   * draft has and the canvas lacks is drawn; all are stacked in the draft's
   * order. The text being edited stays, being the canvas's own until it is left.
   * @param objects - The draft's objects.
   */
  private reconcile(objects: readonly MarkObject[]): void {
    const wanted = new Map(objects.map((object) => [object.id, JSON.stringify(object)]));
    for (const shape of this.canvas.getObjects()) {
      const id = idOf(shape);
      if (id !== undefined && id === this.edit?.id) continue;
      const want = id === undefined ? undefined : wanted.get(id);
      if (id !== undefined && want !== undefined && want === this.drawn.get(id)) continue;
      if (shape === this.canvas.getActiveObject()) this.canvas.discardActiveObject();
      this.canvas.remove(shape);
      if (id !== undefined) this.drawn.delete(id);
    }
    const kept = new Map(this.canvas.getObjects().map((shape) => [idOf(shape), shape]));
    objects.forEach((object, index) => {
      let shape = kept.get(object.id);
      if (shape === undefined) {
        shape = toFabric(object, this.box);
        this.canvas.add(shape);
        this.drawn.set(object.id, wanted.get(object.id) ?? '');
      }
      this.canvas.moveObjectTo(shape, index);
    });
  }

  /**
   * End a text edit the canvas is about to lose, before it is reconciled: the
   * draft having left the edit (a new source) or changed under it (an undo, a
   * clear) drops it unwritten. A new size writes it back first, in `setBox`.
   * @param draft - The draft.
   */
  private settleEdit(draft: MarkDraft): void {
    if (this.edit === null) return;
    const json = JSON.stringify(draft.objects);
    if (draft.editingText === null || json !== this.lastSeen) {
      // What was typed is dropped: the text is drawn again from the draft.
      this.drawn.delete(this.edit.id);
      this.edit = null;
      this.suppressed = true;
      try {
        const active = this.canvas.getActiveObject();
        if (active instanceof IText && active.isEditing) active.exitEditing();
      } finally {
        this.suppressed = false;
      }
      if (draft.editingText !== null) this.live()?.setMarkEditingText(null);
    }
  }

  /**
   * Select the draft's selected object again once it is redrawn. `sync` has
   * already dropped a selection the draft no longer holds, so this only adds
   * one, and not while a text is being edited.
   * @param draft - The draft.
   */
  private alignSelection(draft: MarkDraft): void {
    if (this.edit !== null || draft.selectedId === null || this.canvas.getActiveObject() !== undefined) return;
    const wanted = this.canvas.getObjects().find((shape) => idOf(shape) === draft.selectedId);
    if (wanted !== undefined) this.canvas.setActiveObject(wanted);
  }

  /**
   * Set what a press does for the current tool.
   * @param draft - The draft.
   */
  private applyTool(draft: MarkDraft): void {
    const exporting = this.live()?.miniTool?.exporting ?? false;
    this.canvas.isDrawingMode = draft.tool === 'pen' && !exporting;
    this.canvas.skipTargetFind = draft.tool !== 'select' || exporting;
    const brush = this.canvas.freeDrawingBrush;
    if (brush !== undefined) {
      brush.color = draft.color;
      brush.width = markStrokePx(draft.size, this.box);
    }
  }

  /**
   * Give a text being edited the style the draft says it shows; it is written
   * back with the text when the edit ends.
   */
  private restyleEdit(): void {
    const active = this.canvas.getActiveObject() as (IText & Partial<MarkFabricObject>) | undefined;
    const style = this.live()?.markEditStyle() ?? null;
    if (this.edit === null || style === null || !(active instanceof IText)) return;
    if (active.markColor === style.color && active.markSize === style.size) return;
    active.set({ fill: style.color, fontSize: markFontPx(style.size, this.box) });
    Object.assign(active, { markColor: style.color, markSize: style.size });
    this.canvas.requestRenderAll();
  }

  /** Leave the text being edited, writing it back by the rules on `text:editing:exited`. */
  private exitEditing(): void {
    const active = this.canvas.getActiveObject();
    if (active instanceof IText && active.isEditing) active.exitEditing();
    this.canvas.requestRenderAll();
  }

  /** Listen to the canvas. */
  private wire(): void {
    const { canvas } = this;
    canvas.on('mouse:down', (opt) => this.onDown(opt as unknown as PointerInfo));
    canvas.on('mouse:move', (opt) => this.onMove(opt as unknown as PointerInfo));
    canvas.on('mouse:up', (opt) => this.onUp(opt as unknown as PointerInfo));
    canvas.on('path:created', ({ path }) => this.onPath(path));
    canvas.on('text:editing:entered', ({ target }) => this.onEditEntered(target));
    canvas.on('text:changed', ({ target }) => {
      if (this.edit !== null && !this.suppressed && idOf(target) === this.edit.id) this.live()?.setMarkEditingText(target.text);
    });
    canvas.on('text:editing:exited', ({ target }) => this.onEditExited(target));
    canvas.on('object:modified', ({ target }) => this.onModified(target));
    canvas.on('selection:created', ({ selected }) => this.onSelected(selected));
    canvas.on('selection:updated', ({ selected }) => this.onSelected(selected));
    canvas.on('selection:cleared', () => {
      if (!this.suppressed) this.unselect();
    });
    canvas.on('before:transform', ({ transform }) => {
      // A text scales from its corners and always evenly; its scale becomes
      // its font size on write-back.
      if (transform.target instanceof IText && this.heldUniScaleKey === undefined) {
        this.heldUniScaleKey = canvas.uniScaleKey;
        canvas.uniScaleKey = null;
      }
    });
  }

  /**
   * Whether a press is one this canvas draws or selects with.
   * @param opt - The pointer event.
   * @returns True for the left button while nothing is exporting.
   */
  private usable(opt: PointerInfo): boolean {
    const session = this.live();
    return session !== null && !this.suppressed && (opt.e.button ?? 0) === 0 && !(session.miniTool?.exporting ?? false);
  }

  /**
   * Begin dragging out a shape.
   * @param opt - The pointer event.
   */
  private onDown(opt: PointerInfo): void {
    const draft = this.draft();
    if (draft === null || !this.usable(opt)) return;
    // Select and pen are Fabric's own; every other tool starts here.
    if (draft.tool !== 'select' && draft.tool !== 'pen') this.pending = { start: opt.scenePoint, startOnScreen: opt.viewportPoint, shape: null };
  }

  /**
   * The shape the current tool makes from the press to a point.
   * @param draft - The draft.
   * @param id - Its id.
   * @param start - Where the press began.
   * @param end - Where the pointer is.
   * @returns The object.
   */
  private shapeOf(draft: MarkDraft, id: string, start: Point, end: Point): MarkObject | null {
    const { width, height } = this.box;
    const style = { id, color: draft.color, size: draft.size };
    if (draft.tool === 'rect' || draft.tool === 'ellipse') {
      return {
        ...style,
        kind: draft.tool,
        x: Math.min(start.x, end.x) / width,
        y: Math.min(start.y, end.y) / height,
        w: Math.abs(end.x - start.x) / width,
        h: Math.abs(end.y - start.y) / height,
      };
    }
    if (draft.tool === 'line' || draft.tool === 'arrow') {
      return { ...style, kind: draft.tool, x1: start.x / width, y1: start.y / height, x2: end.x / width, y2: end.y / height };
    }
    return null;
  }

  /**
   * Show the shape being dragged out.
   * @param opt - The pointer event.
   */
  private onMove(opt: PointerInfo): void {
    const draft = this.draft();
    if (this.pending === null || draft === null || draft.tool === 'text') return;
    const object = this.shapeOf(draft, 'pending', this.pending.start, opt.scenePoint);
    if (object === null) return;
    this.suppressed = true;
    if (this.pending.shape !== null) this.canvas.remove(this.pending.shape);
    this.pending.shape = toFabric(object, this.box);
    this.canvas.add(this.pending.shape);
    this.suppressed = false;
    this.canvas.requestRenderAll();
  }

  /**
   * Finish a shape, or place a text, on release.
   * @param opt - The pointer event.
   */
  private onUp(opt: PointerInfo): void {
    if (this.heldUniScaleKey !== undefined) {
      this.canvas.uniScaleKey = this.heldUniScaleKey;
      this.heldUniScaleKey = undefined;
    }
    const pending = this.pending;
    this.pending = null;
    const draft = this.draft();
    if (pending === null || draft === null) return;
    if (pending.shape !== null) {
      this.suppressed = true;
      this.canvas.remove(pending.shape);
      this.suppressed = false;
    }
    if (draft.tool === 'text') {
      this.placeText(draft, pending.start);
      return;
    }
    const moved = opt.viewportPoint.subtract(pending.startOnScreen);
    if (Math.max(Math.abs(moved.x), Math.abs(moved.y)) < MARK_MIN_DRAG_PX) return;
    const end = opt.scenePoint;
    const id = newId();
    const object = this.shapeOf(draft, id, pending.start, end);
    if (object === null) return;
    this.commit([...draft.objects, object]);
    const session = this.live();
    session?.setMarkTool('select');
    session?.selectMark(id);
    // The sync selects it, as the draft now says.
    this.sync();
  }

  /**
   * Put a new text where the press was and start editing it.
   * @param draft - The draft.
   * @param at - Where.
   */
  private placeText(draft: MarkDraft, at: Point): void {
    const id = newId();
    const text = toFabric(
      { id, kind: 'text', color: draft.color, size: draft.size, x: at.x / this.box.width, y: at.y / this.box.height, text: '' },
      this.box,
    ) as unknown as IText;
    this.edit = { id, isNew: true, textAtEntry: '' };
    this.suppressed = true;
    this.canvas.add(text);
    this.canvas.setActiveObject(text);
    this.suppressed = false;
    const session = this.live();
    session?.setMarkTool('select');
    session?.selectMark(id);
    session?.setMarkEditingText('');
    text.enterEditing();
    this.canvas.requestRenderAll();
  }

  /**
   * Take a pen stroke as one object, kept as the points the pencil sampled.
   * Fabric's pencil draws one `Q` per sample, the sample being its control
   * point, and ends on an `L`; a click is `M`, `L`.
   * @param path - The stroke Fabric drew.
   */
  private onPath(path: FabricObject): void {
    const draft = this.draft();
    this.suppressed = true;
    this.canvas.remove(path);
    this.suppressed = false;
    if (draft === null) return;
    const commands = (path as unknown as { path: (string | number)[][] }).path;
    const curves = commands.filter((command) => command[0] === 'Q');
    const samples = [...(curves.length === 0 ? commands.slice(0, 1) : curves), ...commands.slice(-1)];
    const points = samples.map((command) => {
      const x = Number(command[1]);
      const y = Number(command[2]);
      return [x / this.box.width, y / this.box.height] as [number, number];
    });
    this.commit([...draft.objects, { id: newId(), kind: 'pen', color: draft.color, size: draft.size, points }]);
    this.sync();
  }

  /**
   * Note a text the reader went into, to compare against on leaving.
   * @param target - The text.
   */
  private onEditEntered(target: IText): void {
    const id = idOf(target);
    // Typing and restyling change the text in place, and Fabric reports a
    // modification on leaving only for a changed text: draw it again from the draft.
    if (id !== undefined) this.drawn.delete(id);
    if (this.suppressed || id === undefined) return;
    if (this.edit === null) {
      this.edit = { id, isNew: false, textAtEntry: target.text };
      // The text being edited is the selected one, so the controls show its style.
      const session = this.live();
      session?.selectMark(id);
      session?.setMarkEditingText(target.text);
    }
  }

  /**
   * Write a text back on leaving it: an empty one goes (a new one with no
   * step), a changed one is one step, an unchanged one is none.
   * @param target - The text.
   */
  private onEditExited(target: IText): void {
    const edit = this.edit;
    // Only the text being edited ends this edit.
    if (this.suppressed || edit === null || idOf(target) !== edit.id) return;
    this.edit = null;
    // Fabric follows a changed text's exit with `object:modified`, which this
    // exit already writes back; an unchanged one sends none.
    if (target.text !== edit.textAtEntry) this.justLeft = target;
    const draft = this.draft();
    const session = this.live();
    if (draft !== null) {
      if (target.text.trim() === '') {
        // Fabric goes on to read this text once this handler returns, so it
        // stays on the canvas until the next sync, which finds it in no draft.
        if (!edit.isNew) this.commit(draft.objects.filter((object) => object.id !== edit.id));
        session?.selectMark(null);
      } else {
        const written = fromFabric(target, this.box);
        this.commit(
          edit.isNew ? [...draft.objects, written] : draft.objects.map((object) => (object.id === edit.id ? written : object)),
        );
      }
    }
    session?.setMarkEditingText(null);
  }

  /**
   * Write a moved or resized object back.
   * @param target - The object.
   */
  private onModified(target: FabricObject | undefined): void {
    const id = idOf(target);
    // Fabric has changed the object in place, written back or not.
    if (id !== undefined) this.drawn.delete(id);
    if (this.heldUniScaleKey !== undefined) {
      this.canvas.uniScaleKey = this.heldUniScaleKey;
      this.heldUniScaleKey = undefined;
    }
    if (target === this.justLeft) {
      this.justLeft = null;
      return;
    }
    const draft = this.draft();
    if (this.suppressed || draft === null || target === undefined || id === undefined) return;
    const written = fromFabric(target, this.box);
    this.commit(draft.objects.map((object) => (object.id === id ? written : object)));
  }

  /**
   * Record which object is selected.
   * @param selected - The selection.
   */
  private onSelected(selected: FabricObject[] | undefined): void {
    if (this.suppressed) return;
    this.live()?.selectMark(idOf(selected?.[0]) ?? null);
  }

  /**
   * Take the canvas down: a text being edited is written back, a shape being
   * dragged out is dropped, and the selection goes.
   */
  dispose(): void {
    if (this.disposed) return;
    if (this.edit !== null) this.exitEditing();
    this.pending = null;
    this.unselect();
    this.disposed = true;
    void this.canvas.dispose();
  }
}
