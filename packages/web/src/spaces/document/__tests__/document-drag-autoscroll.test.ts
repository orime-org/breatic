// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 §5.2: which page events start, feed and end the body's
 * autoscroll session.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { extendFromPress, followFromPoint } from '@web/spaces/document/document-body-edge-pointer';
import { autoScrollOf } from '@web/spaces/document/document-drag-autoscroll';
import { startTableDrag } from '@web/spaces/document/document-table-drag';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
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
 * @param cancel - Whether a handler on the target cancels it first.
 * @returns The event.
 */
function drag(
  target: EventTarget,
  type: string,
  init: { x?: number; y?: number; relatedTarget?: EventTarget | null } = {},
  cancel = false,
): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x ?? 0, clientY: init.y ?? 0 });
  Object.defineProperty(event, 'relatedTarget', { value: init.relatedTarget ?? null });
  if (cancel) target.addEventListener(type, (e) => e.preventDefault(), { once: true });
  target.dispatchEvent(event);
  return event;
}

describe('the drag session', () => {
  it('starts on a dragstart nobody cancelled, on the body scroller, vertically', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView!;
    drag(view.dom, 'dragstart');
    const auto = autoScrollOf(view)!;
    expect(auto.source).toBe('drag');
    expect(auto.target?.el).toBe(scroller);
    expect(auto.target?.axis).toBe('y');
  });

  it('does not start on a cancelled dragstart', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    drag(view.dom, 'dragstart', {}, true);
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('starts when something is dragged in from outside the window', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    drag(view.dom, 'dragenter', { relatedTarget: null });
    expect(autoScrollOf(view)!.source).toBe('drag');
  });

  it('goes outside on a dragleave to nothing and comes back on the next dragover', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    drag(view.dom, 'dragstart');
    drag(window, 'dragleave', { relatedTarget: null });
    expect(autoScrollOf(view)!.state).toBe('outside');
    drag(view.dom, 'dragover', { x: 10, y: 10 });
    expect(autoScrollOf(view)!.state).toBe('tracking');
  });

  it.each(['drop', 'dragend'])('ends on %s', (type) => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    drag(view.dom, 'dragstart');
    drag(view.dom, type);
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('ends on the first mousemove, which a live drag never produces', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    drag(view.dom, 'dragstart');
    drag(document.body, 'mousemove');
    expect(autoScrollOf(view)!.state).toBe('idle');
  });

  it('scrolls the frame nearest the dragged column sideways, ungated', () => {
    const { editor } = open([
      { type: 'table', content: { type: 'tableContent', rows: [{ cells: ['a1', 'b1'] }, { cells: ['a2', 'b2'] }] } },
    ]);
    const view = editor.prosemirrorView!;
    let cellPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (cellPos < 0 && node.type.name === 'tableCell') cellPos = pos;
      return cellPos < 0;
    });
    const frame = (view.nodeDOM(cellPos) as HTMLElement).closest('[data-radix-scroll-area-viewport]');
    startTableDrag(view, 'column', cellPos);
    drag(view.dom, 'dragstart');
    const target = autoScrollOf(view)!.target!;
    expect(target.el).toBe(frame);
    expect(target.axis).toBe('x');
    expect(target.gate).toBe(false);
  });
});

describe('the pulled-selection session', () => {
  it('starts when the follower takes a blank press from the browser, and ends with the press', () => {
    const { editor, scroller } = open();
    const view = editor.prosemirrorView!;
    followFromPoint(view, 10, 10);
    const auto = autoScrollOf(view)!;
    expect(auto.source).toBe('press');
    expect(auto.target?.el).toBe(scroller);
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(auto.state).toBe('idle');
  });

  it('starts when the follower takes a Shift press from the browser', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    view.focus();
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey: true, clientX: 10, clientY: 100 });
    extendFromPress(view, event);
    expect(event.defaultPrevented).toBe(true);
    expect(autoScrollOf(view)!.source).toBe('press');
  });

  it('does not start on a plain press the browser keeps', () => {
    const { editor } = open();
    const view = editor.prosemirrorView!;
    view.dom.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 }));
    expect(autoScrollOf(view)!.state).toBe('idle');
  });
});
