// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The markup canvas on the node (inner#1303 §6.2), as a controller over one
 * Fabric canvas. The draft's object list is the only copy of what is drawn:
 * the reader's gestures are written back to it, one step each, and a change
 * made elsewhere (undo, redo, clear, a source reset) is reconciled onto the
 * canvas with the selection and any text edit dropped first.
 *
 * Kept apart from React so its rules can be driven through a real Fabric
 * canvas in tests. Loaded only with the markup canvas.
 */

import { Canvas, IText, PencilBrush, type FabricObject, type Point } from 'fabric';

import { newId } from '@breatic/shared';

import { fromFabric, markFontPx, markStrokePx, toFabric, type DrawBox, type MarkFabricObject } from '@web/spaces/canvas/mini-tool/mark-fabric';
import type { CanvasSessionState } from '@web/stores/canvas-session';
import { editStyleOf, type MarkChannel, type MarkDraft, type MarkObject } from '@web/stores/mark-draft';

/** Below this drag, in drawn pixels, a shape tool's press is a click and draws nothing. */
export const MARK_MIN_DRAG_PX = 4;

/** What a pointer event from Fabric carries that this canvas reads. */
interface PointerInfo {
  e: { button?: number };
  scenePoint: Point;
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

  private readonly session: () => CanvasSessionState;

  /** Set while this canvas changes itself to match the draft; no event is written back then. */
  private suppressed = false;

  /** The object list the canvas shows. */
  private shown = '[]';

  /** The object list this canvas last wrote, to tell its own writes from others'. */
  private lastWritten = '[]';

  /** The shape being dragged out, with where the press began. */
  private pending: { start: Point; shape: MarkFabricObject | null } | null = null;

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
   */
  constructor(el: HTMLCanvasElement, box: DrawBox, session: () => CanvasSessionState) {
    this.box = box;
    this.session = session;
    this.canvas = new Canvas(el, {
      width: box.width,
      height: box.height,
      selection: false,
      stopContextMenu: false,
      fireRightClick: false,
      preserveObjectStacking: true,
    });
    this.canvas.freeDrawingBrush = new PencilBrush(this.canvas);
    this.channel = {
      exitEditing: () => this.exitEditing(),
      discardSelection: () => {
        this.canvas.discardActiveObject();
        this.canvas.requestRenderAll();
        if (this.draft()?.selectedId != null) this.session().selectMark(null);
      },
    };
    this.wire();
  }

  /**
   * The open markup draft.
   * @returns It, or null when markup is not open.
   */
  private draft(): MarkDraft | null {
    return this.session().miniTool?.mark ?? null;
  }

  /**
   * Write an object list back, as one step when it changed.
   * @param objects - The list.
   */
  private commit(objects: readonly MarkObject[]): void {
    this.lastWritten = JSON.stringify(objects);
    this.session().commitMark(objects);
  }

  /**
   * Resize the canvas to the picture's drawn size and redraw.
   * @param box - The size.
   */
  setBox(box: DrawBox): void {
    if (box.width === this.box.width && box.height === this.box.height) return;
    this.box = box;
    this.canvas.setDimensions(box);
    this.shown = '';
    this.sync();
  }

  /**
   * Bring the canvas in line with the draft: the tool, an edited text's style,
   * the objects and the selection. The draft alone says what is selected: undo,
   * redo, clear and a new source drop it there, a restyle keeps it.
   */
  sync(): void {
    const before = this.draft();
    if (before === null || this.disposed) return;
    this.settleEdit(before);
    const draft = this.draft();
    if (draft === null) return;
    this.applyTool(draft);
    this.restyleEdit(draft);
    const json = JSON.stringify(draft.objects);
    this.suppressed = true;
    try {
      if (json !== this.shown) {
        this.canvas.discardActiveObject();
        for (const shape of this.canvas.getObjects()) this.canvas.remove(shape);
        for (const object of draft.objects) this.canvas.add(toFabric(object, this.box));
        this.shown = json;
        this.lastWritten = json;
      }
      this.alignSelection(draft);
    } finally {
      this.suppressed = false;
    }
    this.canvas.requestRenderAll();
  }

  /**
   * End a text edit the canvas is about to lose, before it is rebuilt. The
   * draft having left the edit (a new source) or changed under it (an undo, a
   * clear) drops it unwritten; a rebuild of the canvas alone (a new size)
   * writes it back by the usual rules.
   * @param draft - The draft.
   */
  private settleEdit(draft: MarkDraft): void {
    if (this.edit === null) return;
    const json = JSON.stringify(draft.objects);
    if (draft.editingText === null || (json !== this.shown && json !== this.lastWritten)) {
      this.edit = null;
      this.suppressed = true;
      try {
        const active = this.canvas.getActiveObject();
        if (active instanceof IText && active.isEditing) active.exitEditing();
      } finally {
        this.suppressed = false;
      }
      // A new text is on the canvas only; the rebuild takes it off.
      this.shown = '';
      if (draft.editingText !== null) this.session().setMarkEditingText(null);
      return;
    }
    if (json !== this.shown) this.exitEditing();
  }

  /**
   * Make the canvas's selection the draft's, unless a text is being edited.
   * @param draft - The draft.
   */
  private alignSelection(draft: MarkDraft): void {
    if (this.edit !== null) return;
    const active = this.canvas.getActiveObject();
    if (idOf(active) === (draft.selectedId ?? undefined)) return;
    const wanted =
      draft.selectedId === null ? undefined : this.canvas.getObjects().find((shape) => idOf(shape) === draft.selectedId);
    if (wanted === undefined) this.canvas.discardActiveObject();
    else this.canvas.setActiveObject(wanted);
  }

  /**
   * Set what a press does for the current tool.
   * @param draft - The draft.
   */
  private applyTool(draft: MarkDraft): void {
    const exporting = this.session().miniTool?.exporting ?? false;
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
   * @param draft - The draft.
   */
  private restyleEdit(draft: MarkDraft): void {
    const active = this.canvas.getActiveObject() as (IText & Partial<MarkFabricObject>) | undefined;
    const style = editStyleOf(draft);
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
      if (this.edit !== null && !this.suppressed && idOf(target) === this.edit.id) this.session().setMarkEditingText(target.text);
    });
    canvas.on('text:editing:exited', ({ target }) => this.onEditExited(target));
    canvas.on('object:modified', ({ target }) => this.onModified(target));
    canvas.on('selection:created', ({ selected }) => this.onSelected(selected));
    canvas.on('selection:updated', ({ selected }) => this.onSelected(selected));
    canvas.on('selection:cleared', () => {
      if (!this.suppressed && this.draft()?.selectedId != null) this.session().selectMark(null);
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
    return !this.suppressed && (opt.e.button ?? 0) === 0 && !(this.session().miniTool?.exporting ?? false);
  }

  /**
   * Begin dragging out a shape.
   * @param opt - The pointer event.
   */
  private onDown(opt: PointerInfo): void {
    const draft = this.draft();
    if (draft === null || !this.usable(opt)) return;
    // Select and pen are Fabric's own; every other tool starts here.
    if (draft.tool !== 'select' && draft.tool !== 'pen') this.pending = { start: opt.scenePoint, shape: null };
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
    const end = opt.scenePoint;
    if (Math.max(Math.abs(end.x - pending.start.x), Math.abs(end.y - pending.start.y)) < MARK_MIN_DRAG_PX) return;
    const id = newId();
    const object = this.shapeOf(draft, id, pending.start, end);
    if (object === null) return;
    this.commit([...draft.objects, object]);
    const session = this.session();
    session.setMarkTool('select');
    session.selectMark(id);
    this.sync();
    const made = this.canvas.getObjects().find((shape) => idOf(shape) === id);
    if (made !== undefined) {
      this.suppressed = true;
      this.canvas.setActiveObject(made);
      this.suppressed = false;
    }
    this.canvas.requestRenderAll();
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
    const session = this.session();
    session.setMarkTool('select');
    session.selectMark(id);
    session.setMarkEditingText('');
    text.enterEditing();
    this.canvas.requestRenderAll();
  }

  /**
   * Take a pen stroke as one object.
   * @param path - The stroke Fabric drew.
   */
  private onPath(path: FabricObject): void {
    const draft = this.draft();
    this.suppressed = true;
    this.canvas.remove(path);
    this.suppressed = false;
    if (draft === null) return;
    const commands = (path as unknown as { path: (string | number)[][] }).path;
    const points = commands.map((command) => {
      const x = Number(command[command.length - 2]);
      const y = Number(command[command.length - 1]);
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
    if (this.suppressed) return;
    const id = idOf(target);
    if (id === undefined) return;
    if (this.edit === null) {
      this.edit = { id, isNew: false, textAtEntry: target.text };
      // The text being edited is the selected one, so the controls show its style.
      this.session().selectMark(id);
      this.session().setMarkEditingText(target.text);
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
    const session = this.session();
    if (draft !== null) {
      if (target.text.trim() === '') {
        if (edit.isNew) {
          // Fabric goes on to read this text's canvas once this handler
          // returns, so the next sync takes it off by rebuilding.
          this.shown = '';
        } else {
          // Fabric goes on to fire `object:modified` from this text, so it
          // stays on the canvas until the next sync takes it off.
          this.commit(draft.objects.filter((object) => object.id !== edit.id));
        }
        session.selectMark(null);
      } else {
        const written = fromFabric(target, this.box);
        this.commit(
          edit.isNew ? [...draft.objects, written] : draft.objects.map((object) => (object.id === edit.id ? written : object)),
        );
      }
    }
    session.setMarkEditingText(null);
  }

  /**
   * Write a moved or resized object back.
   * @param target - The object.
   */
  private onModified(target: FabricObject | undefined): void {
    if (this.heldUniScaleKey !== undefined) {
      this.canvas.uniScaleKey = this.heldUniScaleKey;
      this.heldUniScaleKey = undefined;
    }
    if (target === this.justLeft) {
      this.justLeft = null;
      return;
    }
    const draft = this.draft();
    const id = idOf(target);
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
    this.session().selectMark(idOf(selected?.[0]) ?? null);
  }

  /**
   * Take the canvas down: a text being edited is written back, a shape being
   * dragged out is dropped, and the selection goes.
   */
  dispose(): void {
    if (this.disposed) return;
    if (this.edit !== null) this.exitEditing();
    this.pending = null;
    if (this.draft()?.selectedId != null) this.session().selectMark(null);
    this.disposed = true;
    void this.canvas.dispose();
  }
}
