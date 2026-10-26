// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 §5.2: which page events start, feed and end the body's
 * autoscroll session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared/document-body';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { extendFromPress, followFromPoint } from '@web/spaces/document/document-body-edge-pointer';
import { DragWindow, autoScrollOf, countsDragEvents } from '@web/spaces/document/document-drag-autoscroll';
import { startTableDrag } from '@web/spaces/document/document-table-drag';
import { tableBlock } from '@web/spaces/document/__tests__/table-fixtures';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

/** A Chrome user agent; jsdom's own reads as Safari's (`AppleWebKit`, no `Chrome`). */
const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** A Safari user agent. */
const SAFARI = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

beforeEach(() => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Opens an editor inside a body scroller, holding the blocks given.
 * @param blocks - The blocks.
 * @returns The editor and the scroller.
 */
function open(blocks: unknown[] = [{ type: 'paragraph', content: 'one' }]): { editor: Editor; scroller: HTMLElement } {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const scroller = document.createElement('div');
  scroller.setAttribute('data-radix-scroll-area-viewport', '');
  const host = document.createElement('div');
  scroller.append(host);
  document.body.append(scroller);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return { editor, scroller };
}

/**
 * Dispatches a drag event.
 * @param target - Where.
 * @param type - Which.
 * @param init - Pointer and related target.
 * @param init.x - Across.
 * @param init.y - Down.
 * @param init.relatedTarget - The related target.
 * @param init.buttons - The buttons held; 1 unless given.
 * @param init.screenX - Across the screen.
 * @param init.screenY - Down the screen.
 * @param cancel - Whether a handler on the target cancels it first.
 * @returns The event.
 */
function drag(
  target: EventTarget,
  type: string,
  init: { x?: number; y?: number; relatedTarget?: EventTarget | null; buttons?: number; screenX?: number; screenY?: number } = {},
  cancel = false,
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    buttons: init.buttons ?? 1,
    screenX: init.screenX ?? 0,
    screenY: init.screenY ?? 0,
  });
  Object.defineProperty(event, 'relatedTarget', { value: init.relatedTarget ?? null });
  if (cancel) target.addEventListener(type, (e) => e.preventDefault(), { once: true });
  target.dispatchEvent(event);
  return event;
}

describe('the drag session', () => {
  it('starts when the drag first passes over the body, on the body scroller, vertically', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart');
    const auto = autoScrollOf(view)!;
    expect(auto.state).toBe('idle');
    drag(scroller, 'dragover', { x: 600, y: 400 });
    expect(auto.source).toBe('drag');
    expect(auto.target?.el).toBe(scroller);
    expect(auto.target?.axis).toBe('y');
  });

  it('does not start on a drag that never passes over the body, such as a top bar link dragged about', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    const link = document.createElement('a');
    link.href = '/studio';
    document.body.append(link);
    drag(link, 'dragstart');
    drag(link, 'dragover', { x: 40, y: 20 });
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it.each([
    ['a top bar link', 'a'],
    ['text in the Agent column', 'p'],
  ])('starts for %s once it is dragged over the body: the pointer decides, not where the drag began', (_name, tag) => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    const source = document.createElement(tag);
    document.body.append(source);
    drag(source, 'dragstart');
    drag(scroller, 'dragover', { x: 600, y: 400 });
    const auto = autoScrollOf(view)!;
    expect(auto.source).toBe('drag');
    expect(auto.target?.el).toBe(scroller);
  });

  it('does not start on the dragenter that follows a drag from outside the body scroller', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    const link = document.createElement('a');
    link.href = '/studio';
    document.body.append(link);
    drag(link, 'dragstart');
    // The browser enters the drag source first, with no element left behind.
    drag(link, 'dragenter', { relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('starts for something dragged in from outside once a drag from the page ended, by its dragend or by a move with no button held', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    const link = document.createElement('a');
    document.body.append(link);
    drag(link, 'dragstart');
    drag(link, 'dragend');
    drag(view.dom, 'dragenter', { relatedTarget: null });
    expect(autoScrollOf(view)!.source).toBe('drag');
    drag(view.dom, 'drop');
    drag(link, 'dragstart');
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }));
    drag(view.dom, 'dragenter', { relatedTarget: null });
    expect(autoScrollOf(view)!.source).toBe('drag');
  });

  it('tells the loop a drag that leaves the window was started on the page, and one dragged in was not', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    const auto = autoScrollOf(view)!;
    const leave = vi.spyOn(auto, 'leaveWindow');
    const scroller = view.dom.closest('[data-radix-scroll-area-viewport]')!;
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragover', { x: 600, y: 700 });
    drag(window, 'dragleave', { relatedTarget: null });
    expect(leave).toHaveBeenLastCalledWith(expect.objectContaining({ fromPage: true }));
    drag(view.dom, 'dragend');
    drag(scroller, 'dragenter', { x: 600, y: 700, relatedTarget: null });
    drag(window, 'dragleave', { relatedTarget: null });
    expect(leave).toHaveBeenLastCalledWith(expect.objectContaining({ fromPage: false }));
  });

  it('does not start on a cancelled dragstart', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart', {}, true);
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('starts when something is dragged in from outside the window', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragenter', { relatedTarget: null });
    expect(autoScrollOf(view)!.source).toBe('drag');
  });

  it('goes outside on a dragleave to nothing and comes back on the next dragover', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragover', { x: 600, y: 700 });
    // Within the page, a dragleave names where the pointer went.
    drag(window, 'dragleave', { relatedTarget: document.body });
    expect(autoScrollOf(view)!.state).toBe('tracking');
    drag(window, 'dragleave', { relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('outside');
    // On the page, held at the body: the session reads it in the capture
    // phase, and the library's drop cursor, which needs layout a test page
    // does not have, never sees it.
    document.body.addEventListener('dragover', (e) => e.stopPropagation(), { once: true });
    drag(document.body, 'dragover', { x: 10, y: 10 });
    expect(autoScrollOf(view)!.state).toBe('tracking');
  });

  it('reads the pointer off a dragenter too: Chrome sends it instead of a dragover when the element under the pointer changes', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragover', { x: 600, y: 400 });
    const follow = vi.spyOn(autoScrollOf(view)!, 'follow');
    drag(document.body, 'dragenter', { x: 40, y: 890, relatedTarget: view.dom });
    expect(follow).toHaveBeenCalledWith({ x: 40, y: 890 });
  });

  it('ignores the library\'s synthetic drag events, which carry a pointer clamped into the editor', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragover', { x: 600, y: 400 });
    const auto = autoScrollOf(view)!;
    const follow = vi.spyOn(auto, 'follow');
    // The ones BlockNote dispatches (`SideMenu.ts` `dispatchSyntheticEvent`,
    // `closeDropCursor`); the dragleave's relatedTarget is null here, which a
    // real leave of the window also has.
    for (const type of ['dragover', 'dragleave', 'drop']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 497, clientY: 890 });
      Object.defineProperty(event, 'synthetic', { value: true });
      document.body.addEventListener(type, (e) => e.stopPropagation(), { once: true });
      document.body.dispatchEvent(event);
    }
    expect(follow).not.toHaveBeenCalled();
    expect(auto.state).toBe('tracking');
  });

  it.each(['drop', 'dragend'])('ends on %s', (type) => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragover', { x: 600, y: 400 });
    drag(view.dom, type);
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('ends on the first mousemove with no button held, and not on one a drag lets through', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragover', { x: 600, y: 400 });
    // Firefox lets a few pointer events through after a drag starts
    // (Pragmatic drag and drop `detect-broken-drag.js`); the button is held.
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
    expect(autoScrollOf(view)!.state).toBe('tracking');
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }));
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('in Safari, tells leaving the window by the count of dragenter and dragleave', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(SAFARI);
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragenter', { x: 600, y: 400, relatedTarget: null });
    // A real dragenter carries the pointer where it is.
    drag(document.body, 'dragenter', { x: 600, y: 420, relatedTarget: null });
    drag(window, 'dragleave', { relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('tracking');
    drag(window, 'dragleave', { relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('outside');
  });

  it('scrolls the frame of the dragged column sideways and holds the body still until the drag ends', () => {
    const { editor, scroller } = open([
      tableBlock({ rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] }),
    ]);
    const view = editor.prosemirrorView;
    // The frame the body draws around a table (`document-table-blocknote.tsx`)
    // is a React view a test page does not mount; it is put in place.
    const table = view.dom.querySelector('table')!;
    const frame = document.createElement('div');
    frame.setAttribute('data-radix-scroll-area-viewport', '');
    table.replaceWith(frame);
    frame.append(table);
    let cellPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (cellPos < 0 && node.type.name === 'docTableCell') cellPos = pos;
      return cellPos < 0;
    });
    scroller.style.overflowY = 'scroll';
    startTableDrag(view, 'column', cellPos);
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragover', { x: 600, y: 400 });
    const target = autoScrollOf(view)!.target!;
    expect(target.el).toBe(frame);
    expect(target.axis).toBe('x');
    // The browser's own drag autoscroll scrolls any box a reader could scroll
    // that the pointer nears; a column drag leaves the body where it is (A7).
    expect(scroller.style.overflowY).toBe('hidden');
    document.body.addEventListener('drop', (e) => e.stopPropagation(), { once: true });
    drag(document.body, 'drop');
    expect(scroller.style.overflowY).toBe('scroll');
  });
});

describe('leaving the page (design §5.2): ended in the window, or out of it', () => {
  /**
   * A drag over the body, with the dragovers given.
   * @param points - The dragovers, in order.
   * @param from - Where the drag began: on the page, or outside the window.
   * @returns The view.
   */
  function dragOver(points: { x: number; y: number }[], from: 'page' | 'outside' = 'page'): NonNullable<Editor['prosemirrorView']> {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    if (from === 'page') drag(view.dom, 'dragstart');
    else drag(scroller, 'dragenter', { ...points[0], relatedTarget: null });
    for (const point of points) drag(scroller, 'dragover', point);
    return view;
  }

  it('ends on the spot when the dragleave is at the last dragover\'s point (Esc, or a drop nobody took, in Firefox and Safari)', () => {
    const view = dragOver([{ x: 600, y: 400 }]);
    const leave = vi.spyOn(autoScrollOf(view)!, 'leaveWindow');
    drag(window, 'dragleave', { x: 600, y: 400, relatedTarget: null });
    expect(leave).not.toHaveBeenCalled();
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('ends on the spot when the buttons changed since the last dragover (a drop nobody took, in Chrome)', () => {
    const view = dragOver([{ x: 600, y: 400 }]);
    drag(window, 'dragleave', { x: 0, y: 0, buttons: 0, relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('otherwise leaves the window through the edge the last two different dragovers head for', () => {
    const view = dragOver([{ x: 600, y: 700 }, { x: 600, y: 700 }, { x: 610, y: 750 }]);
    const leave = vi.spyOn(autoScrollOf(view)!, 'leaveWindow');
    // Chrome's: (0,0), the buttons as they were.
    drag(window, 'dragleave', { x: 0, y: 0, relatedTarget: null });
    expect(leave).toHaveBeenCalledWith({ fromPage: true, exit: 'bottom', proven: false });
    expect(autoScrollOf(view)!.state).toBe('outside');
  });

  it('takes a drag from outside the window as having left when its dragleave lies beyond the exit edge (Firefox, Safari on macOS)', () => {
    const view = dragOver([{ x: 600, y: 720 }, { x: 605, y: 750 }], 'outside');
    const leave = vi.spyOn(autoScrollOf(view)!, 'leaveWindow');
    drag(window, 'dragleave', { x: 610, y: 800, screenX: 730, screenY: 880, relatedTarget: null });
    expect(leave).toHaveBeenCalledWith({ fromPage: false, exit: 'bottom', proven: true });
  });

  it('does not take the screen\'s origin as proof: Firefox on Windows sends that never-set point', () => {
    const view = dragOver([{ x: 600, y: 40 }, { x: 600, y: 20 }], 'outside');
    const leave = vi.spyOn(autoScrollOf(view)!, 'leaveWindow');
    drag(window, 'dragleave', { x: -120, y: -80, screenX: 0, screenY: 0, relatedTarget: null });
    expect(leave).toHaveBeenCalledWith({ fromPage: false, exit: 'top', proven: false });
  });

  it('in Safari, a drag from the top bar into the body leaves the page only when it leaves the window', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(SAFARI);
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    const link = document.createElement('a');
    document.body.append(link);
    drag(link, 'dragstart');
    drag(link, 'dragenter', { x: 40, y: 20, relatedTarget: null });
    drag(scroller, 'dragenter', { x: 600, y: 700, relatedTarget: null });
    drag(scroller, 'dragover', { x: 600, y: 740 });
    drag(link, 'dragleave', { x: 600, y: 700, relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('tracking');
    drag(window, 'dragleave', { x: 0, y: 0, relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('outside');
  });

  it('in Safari, counts the next drag from nothing after a drag ended with dragend', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(SAFARI);
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragenter', { x: 600, y: 400, relatedTarget: null });
    drag(document.body, 'dragenter', { relatedTarget: null });
    drag(view.dom, 'dragend');
    drag(view.dom, 'dragstart');
    drag(scroller, 'dragenter', { x: 600, y: 700, relatedTarget: null });
    drag(scroller, 'dragover', { x: 600, y: 740 });
    drag(window, 'dragleave', { x: 0, y: 0, relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('outside');
  });
});

describe('leaving the window', () => {
  it('counts on dragenter and dragleave in Safari, whose relatedTarget is always null', () => {
    const win = new DragWindow(true);
    const leave = (): boolean => win.leaves(new MouseEvent('dragleave'));
    win.start();
    win.enter(); // the draggable
    win.enter(); // the next element
    expect(leave()).toBe(false); // the draggable, left for it
    win.enter();
    expect(leave()).toBe(false);
    expect(leave()).toBe(true); // the last one: the window
  });

  it('reads the relatedTarget elsewhere', () => {
    const win = new DragWindow(false);
    const to = (relatedTarget: EventTarget | null): MouseEvent => {
      const event = new MouseEvent('dragleave');
      Object.defineProperty(event, 'relatedTarget', { value: relatedTarget });
      return event;
    };
    win.start();
    expect(win.leaves(to(document.body))).toBe(false);
    expect(win.leaves(to(null))).toBe(true);
  });

  it('counts in Safari and nowhere else, by the user agent', () => {
    expect(countsDragEvents('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toBe(true);
    expect(countsDragEvents('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36')).toBe(false);
    expect(countsDragEvents('Mozilla/5.0 (Macintosh; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe(false);
  });
});

describe('the pulled-selection session', () => {
  it('starts from the press point when the follower takes a blank press, and follows the follower\'s pointer', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    const begin = vi.spyOn(autoScrollOf(view)!, 'beginPress');
    followFromPoint(view, 10, 10);
    expect(begin).toHaveBeenCalledWith(scroller, { x: 10, y: 10 });
    const follow = vi.spyOn(autoScrollOf(view)!, 'follow');
    view.root.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: 30, clientY: 40 }));
    expect(follow).toHaveBeenCalledWith({ x: 30, y: 40 });
    const auto = autoScrollOf(view)!;
    expect(auto.source).toBe('press');
    expect(auto.target?.el).toBe(scroller);
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(auto.state).toBe('idle');
  });

  it('starts when the follower takes a Shift press from the browser', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    view.focus();
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true, clientX: 10, clientY: 100 });
    extendFromPress(view, event);
    expect(event.defaultPrevented).toBe(true);
    expect(autoScrollOf(view)!.source).toBe('press');
  });

  it('gives a Shift press no pointer until it moves, so a still Shift+click does not scroll', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView;
    view.focus();
    const begin = vi.spyOn(autoScrollOf(view)!, 'beginPress');
    extendFromPress(view, new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true, clientX: 10, clientY: 100 }));
    expect(begin).toHaveBeenCalledWith(scroller, null);
    const follow = vi.spyOn(autoScrollOf(view)!, 'follow');
    view.root.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: 12, clientY: 120 }));
    expect(follow).toHaveBeenCalledWith({ x: 12, y: 120 });
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  it('feeds the loop from pointer moves only: a scroll elsewhere on the page leaves a still Shift press without a pointer', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    view.focus();
    extendFromPress(view, new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true, clientX: 10, clientY: 100 }));
    const follow = vi.spyOn(autoScrollOf(view)!, 'follow');
    // The Agent column scrolling to its newest line while the press is held.
    document.body.dispatchEvent(new Event('scroll'));
    expect(follow).not.toHaveBeenCalled();
    document.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  it('does not start on a plain press the browser keeps', () => {
    const { editor } = open();
    const view = editor.prosemirrorView;
    view.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
    expect(autoScrollOf(view)!.state).toBe('idle');
  });
});
