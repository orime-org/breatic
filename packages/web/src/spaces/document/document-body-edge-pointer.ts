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
import { Plugin, PluginKey, type Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import {
  bodyEdgeAt,
  bodyEdgeNeedsTakeover,
  bodyEdgePos,
  dragSelection,
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
  /** Where it was pressed; `shift` for a Shift+click past an edge. */
  readonly zone: PointerZone | 'shift';
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
 * The element of the root block at one end of the body.
 * @param view - The view.
 * @param edge - Which end.
 * @returns The element, or null in an empty body.
 */
function rootBlockElement(view: EditorView, edge: BodyEdge): Element | null {
  const group = view.state.doc.firstChild;
  const block = edge === 'start' ? group?.firstChild : group?.lastChild;
  if (!group || !block) return null;
  const pos = edge === 'start' ? 1 : 1 + group.content.size - block.nodeSize;
  const element = view.nodeDOM(pos);
  return element instanceof Element ? element : null;
}

/**
 * Where a point is: past the block at an end of the body that a drag has to
 * reach past, or over the body. The block's box is measured now, not cached:
 * the body scrolls and grows under a drag.
 * @param view - The view.
 * @param y - The point, vertically.
 * @returns The zone.
 */
function zoneAt(view: EditorView, y: number): PointerZone {
  const { doc } = view.state;
  if (bodyEdgeNeedsTakeover(doc, 'end')) {
    const last = rootBlockElement(view, 'end');
    if (last && y > last.getBoundingClientRect().bottom) return 'end';
  }
  if (bodyEdgeNeedsTakeover(doc, 'start')) {
    const first = rootBlockElement(view, 'start');
    if (first && y < first.getBoundingClientRect().top) return 'start';
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
  }

  /**
   * Starts following a press, or answers a Shift+click past an edge.
   * @param event - The press.
   */
  private readonly onDown = (event: MouseEvent): void => {
    const { view } = this;
    if (!view.editable || !isPlainPress(event)) return;
    const zone = zoneAt(view, event.clientY);
    const at = { startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY };
    if (event.shiftKey) {
      // The browser extends its own range from its own anchor, and an anchor
      // on an edge is not one it can extend from: measured (probe18), a
      // Shift+click on an earlier block left the range where it was. So a
      // Shift+click is taken here when it lands past an edge, or when the
      // anchor is already on one.
      const anchorEdge = bodyEdgeAt(view.state.doc, view.state.selection.anchor);
      if (zone === 'body' && anchorEdge === null) return;
      this.begin({ ...at, zone: 'shift', anchorEdge, left: true, moved: false, onWidget: false });
      event.preventDefault();
      this.sync();
      return;
    }
    const widget = zone === 'end' && onWidget(view, event.clientX, event.clientY);
    this.begin({ ...at, zone, anchorEdge: zone === 'body' ? null : zone, left: false, moved: false, onWidget: widget });
  };

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
