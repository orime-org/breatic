// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Drags and Shift+clicks that go past the first or last block of the body
 * (#124, A6; design §5.10.3).
 *
 * WHY THE POINTER, NOT THE BROWSER'S RANGE. When the last block is an empty
 * line, Chrome reports the end of a drag below it as a position inside that
 * line (probe13 `b`), the same as a drag that stopped on it. And ProseMirror
 * reads the browser's range only when it changes
 * (`prosemirror-view` `domobserver.ts:181`), so a drag that rests on the last
 * line and then goes further down produces no reading at all. Which side of
 * the block the pointer is on answers both, so this plugin follows the pointer
 * and dispatches the selection itself when that changes.
 *
 * The press is watched in the capture phase and left to go on: ProseMirror's
 * own `mousedown` still runs, and with it Chrome's protection of the selection
 * during a drag (`input.ts:396-398`, `selection.ts:62-72`).
 *
 * THE WIDGET BELOW. BlockNote draws a stand-in block under a last block that
 * is not an empty paragraph and inserts a paragraph on a press on it
 * (`TrailingNode.ts`). While the last block is one a drag has to reach past,
 * the surface is marked and the stylesheet lets presses through the widget, so
 * a press there can start a drag; a press that is let go without moving opens
 * the paragraph the widget would have.
 */

import { createExtension } from '@blocknote/core';
import { isMacOS } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
  bodyEdgeAt,
  bodyEdgeBlockPos,
  bodyEdgeNeedsTakeover,
  bodyEdgePos,
  dragSelection,
  extensionEnds,
  type BodyEdge,
  type PointerZone,
} from '@web/spaces/document/document-body-edge-selection';

/**
 * How far the pointer can travel before a press is a drag rather than a click:
 * ProseMirror's own threshold (`LeftMouseDown.updateAllowDefault`,
 * `input.ts:452-456`), so both sides agree on which presses were clicks.
 */
const CLICK_SLOP = 4;

/** The class BlockNote gives the stand-in block. */
const TRAILING_CLASS = 'bn-trailing-block';

/** The attribute that lets presses through the stand-in block. */
const TAKEOVER_ATTR = 'data-body-end-takeover';

/** A press this plugin is following. */
interface Press {
  /** Where it was pressed. */
  readonly zone: PointerZone;
  /** The anchor when it is an edge; otherwise the selection's own anchor is read. */
  readonly anchorEdge: BodyEdge | null;
  /** Where it was pressed. */
  readonly startX: number;
  readonly startY: number;
  /** Where the pointer is now. */
  readonly x: number;
  readonly y: number;
  /** Whether the pointer has been anywhere but where it was pressed. */
  readonly left: boolean;
  /** Whether it has travelled further than a click. */
  readonly moved: boolean;
  /** Whether it was pressed on the stand-in block. */
  readonly onWidget: boolean;
}

/**
 * The line of the block at one end of the body: the element of its content
 * node, the deepest last block at the end.
 * @param view - The view.
 * @param edge - Which end.
 * @returns The element, or null in an empty body.
 */
function edgeLine(view: EditorView, edge: BodyEdge): Element | null {
  const pos = bodyEdgeBlockPos(view.state.doc, edge);
  const element = pos === null ? null : view.nodeDOM(pos);
  return element instanceof Element ? element : null;
}

/**
 * Where a point is: over or past the block at an end of the body that a drag
 * has to reach past, or over the body. Over the block counts: an empty line
 * holds one position, at its start, so a range the browser ends on it never
 * takes the line in, and a block without text holds none. The block's box is
 * measured now, not cached: the body scrolls and grows under a drag.
 * @param view - The view.
 * @param y - The point, vertically.
 * @returns The zone.
 */
function zoneAt(view: EditorView, y: number): PointerZone {
  const { doc } = view.state;
  if (bodyEdgeNeedsTakeover(doc, 'end')) {
    const last = edgeLine(view, 'end');
    if (last && y >= last.getBoundingClientRect().top) return 'end';
  }
  if (bodyEdgeNeedsTakeover(doc, 'start')) {
    const first = edgeLine(view, 'start');
    if (first && y <= first.getBoundingClientRect().bottom) return 'start';
  }
  return 'body';
}

/**
 * The document position under a point, the point first brought inside the
 * editable surface.
 * @param view - The view.
 * @param x - The point, across.
 * @param y - The point, down.
 * @returns The position, or null when there is none.
 */
function positionAt(view: EditorView, x: number, y: number): number | null {
  const box = view.dom.getBoundingClientRect();
  const left = Math.min(Math.max(x, box.left + 1), box.right - 1);
  const top = Math.min(Math.max(y, box.top + 1), box.bottom - 1);
  return view.posAtCoords({ left, top })?.pos ?? null;
}

/**
 * Whether a point is on the stand-in block.
 * @param view - The view.
 * @param x - The point, across.
 * @param y - The point, down.
 * @returns True when the block is there and the point is inside it.
 */
function onWidget(view: EditorView, x: number, y: number): boolean {
  const widget = view.dom.querySelector(`.${TRAILING_CLASS}`);
  if (!widget) return false;
  const box = widget.getBoundingClientRect();
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/**
 * Whether a press is one this plugin follows: the main button, no modifier
 * other than Shift.
 * @param event - The press.
 * @returns True for such a press.
 */
function isPlainPress(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * The end of a selection a Shift+click keeps, as the page keeps it. On macOS
 * the selection has no direction: the end nearer the click in text moves, and
 * a tie moves the start (Chromium `ExtendSelectionAsNonDirectional`, which
 * measures with `TextIterator::RangeLength`: characters, one per line break,
 * none for a block without text; probe42). Elsewhere the anchor stays.
 * @param doc - The document.
 * @param ends - The selection's anchor and head.
 * @param ends.anchor - The anchor.
 * @param ends.head - The head.
 * @param target - Where the click lands.
 * @returns The position that stays.
 */
function keptEnd(doc: Node, { anchor, head }: { anchor: number; head: number }, target: number): number {
  if (!isMacOS()) return anchor;
  const start = Math.min(anchor, head);
  const end = Math.max(anchor, head);
  return textDistance(doc, start, target) <= textDistance(doc, target, end) ? end : start;
}

/**
 * How far apart two positions are in what the page reads as text: characters,
 * one per line break between blocks, none for a block without text.
 * @param doc - The document.
 * @param a - One position.
 * @param b - The other.
 * @returns The distance.
 */
function textDistance(doc: Node, a: number, b: number): number {
  return doc.textBetween(Math.min(a, b), Math.max(a, b), '\n').length;
}

/** What the plugin needs from the BlockNote editor. */
interface ParagraphOpener {
  /** Inserts a paragraph after the last root block and puts the caret in it. */
  openParagraphBelow: (view: EditorView) => void;
}

/**
 * Follows one view's presses.
 */
class PointerFollower {
  /** The press being followed, or null. */
  private press: Press | null = null;

  /**
   * Starts listening for presses on the view.
   * @param view - The view.
   * @param opener - How a click on the stand-in block opens a paragraph.
   */
  constructor(
    private readonly view: EditorView,
    private readonly opener: ParagraphOpener,
  ) {
    view.dom.addEventListener('mousedown', this.onDown, true);
    view.dom.addEventListener('dragstart', this.onDragStart);
  }

  /**
   * The selection the press gives now, or null to leave it to ProseMirror and
   * the browser.
   * @returns The selection.
   */
  current(): Selection | null {
    const { press, view } = this;
    if (press === null) return null;
    const { doc, selection } = view.state;
    const zone = zoneAt(view, press.y);
    const anchor = press.anchorEdge === null ? selection.anchor : bodyEdgePos(doc, press.anchorEdge);
    const pointer = zone === 'body' ? positionAt(view, press.x, press.y) : null;
    return dragSelection(doc, { press: press.zone, anchor, left: press.left }, zone, pointer);
  }

  /**
   * Ends following when the view stops being editable.
   * @param view - The view.
   */
  update(view: EditorView): void {
    if (!view.editable) this.end();
  }

  /** Stops listening. */
  destroy(): void {
    this.end();
    this.view.dom.removeEventListener('mousedown', this.onDown, true);
    this.view.dom.removeEventListener('dragstart', this.onDragStart);
  }

  /**
   * Starts following a press, or answers a Shift+click this plugin takes.
   * @param event - The press.
   */
  private readonly onDown = (event: MouseEvent): void => {
    const { view } = this;
    if (!view.editable || !isPlainPress(event)) return;
    const zone = zoneAt(view, event.clientY);
    const at = { startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    if (event.shiftKey) {
      this.extendFrom(event, zone, at);
      return;
    }
    const widget = zone === 'end' && onWidget(view, event.clientX, event.clientY);
    this.begin({ ...at, zone, anchorEdge: zone === 'body' ? null : zone, left: false, moved: false, onWidget: widget });
  };

  /**
   * Answers a Shift+click (design §5.10.5). The end that stays is the one the
   * page keeps ({@link keptEnd}). The plugin takes the click when
   * the page cannot extend the selection without losing part of it: a click
   * past an edge, a selection over the whole document or a selected block, or
   * an end that stays on an edge, which the page reads as the caret inside the
   * edge block. Any other click is the page's, and is followed like a plain
   * press, so a drag that goes on past an edge reaches it.
   * @param event - The press.
   * @param zone - Where it was pressed.
   * @param at - Where it was pressed, as the press records it.
   * @param at.startX - Across.
   * @param at.startY - Down.
   * @param at.x - Across.
   * @param at.y - Down.
   */
  private extendFrom(event: MouseEvent, zone: PointerZone, at: Pick<Press, 'startX' | 'startY' | 'x' | 'y'>): void {
    const { view } = this;
    const { doc, selection } = view.state;
    const pointer = zone === 'body' ? positionAt(view, event.clientX, event.clientY) : null;
    const target = zone === 'body' ? pointer : bodyEdgePos(doc, zone);
    if (target === null) {
      this.begin({ ...at, zone, anchorEdge: bodyEdgeAt(doc, selection.anchor), left: false, moved: false, onWidget: false });
      return;
    }
    // Past an edge the selection grows towards it, even from a block selected
    // at that very edge, whose position is the edge's own.
    const dir = zone === 'end' ? 1 : zone === 'start' ? -1 : target >= selection.from ? 1 : -1;
    const swapped = extensionEnds(selection, dir);
    const fixed = keptEnd(doc, swapped ?? selection, target);
    if (zone === 'body' && swapped === null && bodyEdgeAt(doc, fixed) === null) {
      this.begin({ ...at, zone, anchorEdge: null, left: false, moved: false, onWidget: false });
      return;
    }
    this.begin({ ...at, zone, anchorEdge: bodyEdgeAt(doc, fixed), left: true, moved: false, onWidget: false });
    // Taking the press from the browser takes its focus move with it, and
    // ProseMirror does not focus on a Shift press: a selection set in a body
    // without the focus is neither painted nor where the next keys go.
    event.preventDefault();
    if (!view.hasFocus()) view.focus();
    const next = dragSelection(doc, { press: zone, anchor: fixed, left: true }, zone, pointer);
    if (next !== null && !next.eq(selection)) view.dispatch(view.state.tr.setSelection(next));
  }

  /**
   * Follows the pointer.
   * @param event - The move.
   */
  private readonly onMove = (event: MouseEvent): void => {
    if (event.buttons === 0) {
      this.end();
      return;
    }
    this.moveTo(event.clientX, event.clientY);
  };

  /** Re-reads where the pointer is when the body scrolls under it. */
  private readonly onScroll = (): void => {
    if (this.press) this.moveTo(this.press.x, this.press.y);
  };

  /**
   * Ends the press; a click on the stand-in block opens the paragraph it
   * stands in for.
   * @param event - The release.
   */
  private readonly onUp = (event: MouseEvent): void => {
    const { press } = this;
    this.end();
    if (press === null || press.zone !== 'end' || !press.onWidget) return;
    if (press.moved || travelled(press, event.clientX, event.clientY)) return;
    this.opener.openParagraphBelow(this.view);
  };

  /**
   * Ends the press when the browser starts dragging the selected words: the
   * selection then is what the drop moves (prosemirror-view `input.ts` drop,
   * `tr.deleteSelection()`), and the page scrolling under the drag must not
   * change it.
   */
  private readonly onDragStart = (): void => {
    this.end();
  };

  /** Ends the press when the window loses focus. */
  private readonly onBlur = (): void => {
    this.end();
  };

  /**
   * Records where the pointer is and dispatches the selection that gives.
   * @param x - Across.
   * @param y - Down.
   */
  private moveTo(x: number, y: number): void {
    const { press } = this;
    if (press === null) return;
    const left = press.left || zoneAt(this.view, y) !== press.zone;
    this.press = { ...press, x, y, left, moved: press.moved || travelled(press, x, y) };
    this.sync();
  }

  /** Dispatches the selection the press gives, when it differs. */
  private sync(): void {
    const next = this.current();
    if (next === null || next.eq(this.view.state.selection)) return;
    this.view.dispatch(this.view.state.tr.setSelection(next));
  }

  /**
   * Starts following.
   * @param press - The press.
   */
  private begin(press: Press): void {
    this.end();
    this.press = press;
    const root = this.view.root;
    root.addEventListener('mousemove', this.onMove as EventListener);
    root.addEventListener('scroll', this.onScroll, true);
    // On the window, so it runs after ProseMirror's own `mouseup` on the root
    // has settled the click.
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** Stops following. */
  private end(): void {
    if (this.press === null) return;
    this.press = null;
    const root = this.view.root;
    root.removeEventListener('mousemove', this.onMove as EventListener);
    root.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
  }
}

/**
 * Whether the pointer is further from where it was pressed than a click.
 * @param press - The press.
 * @param x - Across.
 * @param y - Down.
 * @returns True past the slop.
 */
function travelled(press: Press, x: number, y: number): boolean {
  return Math.abs(x - press.startX) > CLICK_SLOP || Math.abs(y - press.startY) > CLICK_SLOP;
}

/** The follower of each view, for `createSelectionBetween` to ask. */
const followers = new WeakMap<EditorView, PointerFollower>();

/**
 * The extension that lets a drag or a Shift+click reach past the first or last
 * block of the body.
 * @returns The extension, for the assembly to register.
 */
export const documentBodyEdgePointerExtension = createExtension(({ editor }) => {
  const opener: ParagraphOpener = {
    openParagraphBelow: (view) => {
      const lastId = view.state.doc.firstChild?.lastChild?.attrs['id'] as string | undefined;
      if (lastId === undefined) return;
      editor.transact((tr) => {
        const [inserted] = editor.insertBlocks([{ type: 'paragraph' }], lastId, 'after');
        if (inserted) editor.setTextCursorPosition(inserted, 'start');
        tr.scrollIntoView();
      });
      view.focus();
    },
  };
  return {
    key: 'document-body-edge-pointer',
    prosemirrorPlugins: [
      new Plugin({
        key: new PluginKey('documentBodyEdgePointer'),
        view: (view) => {
          const follower = new PointerFollower(view, opener);
          followers.set(view, follower);
          return {
            update: (next: EditorView) => follower.update(next),
            destroy: () => {
              follower.destroy();
              followers.delete(view);
            },
          };
        },
        props: {
          attributes: (state): Record<string, string> =>
            bodyEdgeNeedsTakeover(state.doc, 'end') ? { [TAKEOVER_ATTR]: '' } : {},
          createSelectionBetween: (view) => followers.get(view)?.current() ?? null,
        },
      }),
    ],
  } as never;
});
