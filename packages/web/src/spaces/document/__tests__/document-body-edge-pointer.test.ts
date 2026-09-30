// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #124 A6: dragging and Shift+clicking past the first or last block of the body
 * (design §5.10.3). jsdom lays nothing out, so each case gives the blocks and
 * the surface their boxes and says which position the pointer is over; the
 * layout itself is measured in a browser (`tests/smoke/`).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { BodyEdgeSelection } from '@web/spaces/document/document-body-edge-selection';
import { declarationsOf } from '@web/spaces/document/__tests__/index-css-rules';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  vi.restoreAllMocks();
});

/** The vertical extent of a box. */
interface Band {
  top: number;
  bottom: number;
}

/**
 * Gives an element a box.
 * @param element - The element.
 * @param band - Its vertical extent; it spans 0 to 600 across.
 */
function place(element: Element, band: Band): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, band.top, 600, band.bottom - band.top),
  );
}

/**
 * Opens an editor holding the given blocks and lays it out: the first root
 * block at 0–20, the last at `lastBottom - 20`–`lastBottom`, the surface at
 * -40–400.
 * @param blocks - What the document starts with.
 * @param lastBottom - The bottom of the last root block.
 * @returns The editor.
 */
function open(blocks: unknown[], lastBottom = 100): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  layOut(editor.prosemirrorView!, lastBottom);
  return editor;
}

/**
 * Gives the surface and its first and last root blocks their boxes.
 * @param view - The view.
 * @param lastBottom - The bottom of the last root block.
 */
function layOut(view: EditorView, lastBottom: number): void {
  const group = view.state.doc.firstChild!;
  const lastPos = 1 + group.content.size - group.lastChild!.nodeSize;
  place(view.dom, { top: -40, bottom: 400 });
  place(view.nodeDOM(1) as Element, { top: 0, bottom: 20 });
  place(view.nodeDOM(lastPos) as Element, { top: lastBottom - 20, bottom: lastBottom });
}

/**
 * Says which document position every point is over.
 * @param view - The view.
 * @param pos - The position.
 */
function pointAt(view: EditorView, pos: number): void {
  vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos, inside: -1 });
}

/**
 * Presses the main button on the surface.
 * @param view - The view.
 * @param y - Where, vertically.
 * @param init - Extra fields for the event.
 * @returns The event, to see whether it was prevented.
 */
function press(view: EditorView, y: number, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('mousedown', {
    clientX: 50, clientY: y, button: 0, buttons: 1, bubbles: true, cancelable: true, ...init,
  });
  view.dom.dispatchEvent(event);
  return event;
}

/**
 * Moves the pointer with the button held.
 * @param y - Where, vertically.
 */
function move(y: number): void {
  document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: y, buttons: 1, bubbles: true }));
}

/**
 * Lets the button go.
 * @param y - Where, vertically.
 */
function release(y: number): void {
  document.dispatchEvent(new MouseEvent('mouseup', { clientX: 50, clientY: y, button: 0, bubbles: true }));
}

/**
 * Where the text of the block holding these words starts.
 * @param view - The view.
 * @param words - The block's text.
 * @returns The position.
 */
function textStart(view: EditorView, words: string): number {
  let at = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === words) at = pos + 1;
    return at < 0;
  });
  return at;
}

/**
 * Puts a text selection in the state, the way the browser's drag would have.
 * @param view - The view.
 * @param anchor - The anchor.
 * @param head - The head.
 */
function select(view: EditorView, anchor: number, head = anchor): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
}

/** A block as `editor.document` hands it back. */
interface ReadBlock {
  id: string;
  type: string;
}

/**
 * The root blocks of the document.
 * @param editor - The editor.
 * @returns Its blocks.
 */
function blocksOf(editor: Editor): ReadBlock[] {
  return editor.document as unknown as ReadBlock[];
}

const ABOVE_DIVIDER = [{ type: 'paragraph', content: 'Above' }, { type: 'divider' }];
const BELOW_DIVIDER = [{ type: 'divider' }, { type: 'paragraph', content: 'Below' }];

describe('a drag that starts in the body', () => {
  it('takes a trailing divider in when it goes below the last block', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above') + 1;
    press(view, 10);
    select(view, at, at + 2);

    move(150);

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([at, view.state.doc.content.size - 1]);
  });

  it('takes a trailing empty line in, nested under the last row', () => {
    const view = open([
      { type: 'bulletListItem', content: 'Parent', children: [{ type: 'paragraph', content: '' }] },
    ]).prosemirrorView!;
    const at = textStart(view, 'Parent');
    press(view, 10);
    select(view, at);

    move(150);

    expect(view.state.selection.head).toBe(view.state.doc.content.size - 1);
  });

  it('takes a leading divider in when it goes above the first block', () => {
    const view = open(BELOW_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Below') + 3;
    press(view, 90);
    select(view, at);

    move(-20);

    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([at, 1]);
  });

  it('follows the pointer from the same anchor after coming back', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above');
    press(view, 10);
    select(view, at);
    move(150);

    pointAt(view, at + 3);
    move(10);

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([at, at + 3]);
  });

  it('leaves the selection to the browser while it stays in the body', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above');
    press(view, 10);
    select(view, at, at + 2);

    move(15);

    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([at, at + 2]);
  });

  it('changes nothing when the body ends in words', () => {
    const view = open(BELOW_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Below');
    press(view, 10);
    select(view, at);

    move(150);

    expect(view.state.selection).toBeInstanceOf(TextSelection);
    expect(view.state.selection.head).toBe(at);
  });

  it('reaches the end when the body scrolls under a pointer that stays still', () => {
    const view = open(ABOVE_DIVIDER, 300).prosemirrorView!;
    const at = textStart(view, 'Above');
    press(view, 10);
    select(view, at);
    move(250);
    expect(view.state.selection).toBeInstanceOf(TextSelection);

    layOut(view, 200);
    document.dispatchEvent(new Event('scroll'));

    expect(view.state.selection.head).toBe(view.state.doc.content.size - 1);
  });

  it('answers the browser with the same selection while the pointer is past the end', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above');
    press(view, 10);
    select(view, at);
    move(150);

    const { doc } = view.state;
    const answer = view.someProp('createSelectionBetween', (f) =>
      f(view, doc.resolve(at), doc.resolve(at + 5)),
    );

    expect(answer?.eq(view.state.selection)).toBe(true);
  });
});

describe('a drag that starts past an end of the body', () => {
  it('anchors on the end and follows the pointer up into the body', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above') + 2;
    pointAt(view, at);
    press(view, 150);

    move(10);

    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([view.state.doc.content.size - 1, at]);
  });

  it('selects the whole document from past the end to past the start', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]).prosemirrorView!;
    pointAt(view, textStart(view, 'Mid'));
    press(view, 150);

    move(-20);

    expect(view.state.selection).toBeInstanceOf(AllSelection);
  });

  it('opens a paragraph under a trailing divider on a click on the space below', () => {
    const editor = open(ABOVE_DIVIDER);
    const view = editor.prosemirrorView!;
    const widget = view.dom.querySelector('.bn-trailing-block')!;
    place(widget, { top: 100, bottom: 400 });
    pointAt(view, view.state.doc.content.size - 1);

    press(view, 150);
    release(150);

    const blocks = blocksOf(editor);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'divider', 'paragraph']);
    expect((editor.getTextCursorPosition().block as unknown as ReadBlock).id).toBe(blocks[2]!.id);
  });

  it('opens nothing when the press moved before it was let go', () => {
    const editor = open(ABOVE_DIVIDER);
    const view = editor.prosemirrorView!;
    place(view.dom.querySelector('.bn-trailing-block')!, { top: 100, bottom: 400 });
    pointAt(view, textStart(view, 'Above'));

    press(view, 150);
    move(10);
    release(10);

    expect(blocksOf(editor).map((b) => b.type)).toEqual(['paragraph', 'divider']);
  });
});

describe('Shift+click past an end of the body', () => {
  it('extends from the current anchor to the end and keeps the browser out', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above') + 1;
    select(view, at);

    const event = press(view, 150, { shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.selection).toBeInstanceOf(BodyEdgeSelection);
    expect([view.state.selection.anchor, view.state.selection.head]).toEqual([at, view.state.doc.content.size - 1]);
  });

  it('is the whole document when the anchor is already on the other edge', () => {
    const view = open([{ type: 'divider' }, { type: 'paragraph', content: 'Mid' }, { type: 'divider' }]).prosemirrorView!;
    view.dispatch(view.state.tr.setSelection(BodyEdgeSelection.fromEdge(view.state.doc, 'start', textStart(view, 'Mid'))));

    press(view, 150, { shiftKey: true });

    expect(view.state.selection).toBeInstanceOf(AllSelection);
  });

  it('leaves a Shift+click in the body to the browser', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above');
    select(view, at);

    const event = press(view, 10, { shiftKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(view.state.selection.head).toBe(at);
  });
});

describe('what ends a press, and what is never one', () => {
  it('stops following once the button is let go', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above');
    press(view, 10);
    select(view, at);
    release(10);

    move(150);

    expect(view.state.selection.head).toBe(at);
  });

  it('stops following once a move arrives with no button held', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above');
    press(view, 10);
    select(view, at);
    // Let go outside the window: no mouseup reaches the page.
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 50, clientY: 10, buttons: 0, bubbles: true }));

    move(150);

    expect(view.state.selection.head).toBe(at);
  });

  it('stops following once the window loses focus', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above');
    press(view, 10);
    select(view, at);
    window.dispatchEvent(new Event('blur'));

    move(150);

    expect(view.state.selection.head).toBe(at);
  });

  it('ignores a press with another button or a modifier', () => {
    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    const at = textStart(view, 'Above');
    select(view, at);
    pointAt(view, at + 3);

    for (const init of [{ button: 2 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      press(view, 150, init);
      move(10);
      release(10);
    }

    expect(view.state.selection.head).toBe(at);
  });

  it('stops following once the document stops being editable', () => {
    const editor = open(ABOVE_DIVIDER);
    const view = editor.prosemirrorView!;
    const at = textStart(view, 'Above');
    press(view, 10);
    select(view, at);
    editor.isEditable = false;

    move(150);

    expect(view.state.selection.head).toBe(at);
  });

  it('ignores presses in a document that is not editable', () => {
    const editor = open(ABOVE_DIVIDER);
    const view = editor.prosemirrorView!;
    const at = textStart(view, 'Above');
    select(view, at);
    editor.isEditable = false;

    press(view, 10);
    move(150);

    expect(view.state.selection.head).toBe(at);
  });
});

describe('the space below a trailing block that has no text', () => {
  it('is marked on the surface so the widget there lets presses through', () => {
    const divider = open(ABOVE_DIVIDER).prosemirrorView!;
    const words = open(BELOW_DIVIDER).prosemirrorView!;

    expect(divider.dom.hasAttribute('data-body-end-takeover')).toBe(true);
    expect(words.dom.hasAttribute('data-body-end-takeover')).toBe(false);
  });

  it('lets presses through the widget on a marked surface', () => {
    const rules = declarationsOf('data-body-end-takeover', 'pointer-events');
    expect(rules).toHaveLength(1);
    const [{ selector, value }] = rules;
    expect(value).toBe('none');

    const view = open(ABOVE_DIVIDER).prosemirrorView!;
    expect(view.dom.parentElement!.querySelector(selector)).toBe(view.dom.querySelector('.bn-trailing-block'));
  });
});
