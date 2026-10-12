// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 design §5.5: the body gives itself the focus without moving.
 * WebKit scrolls an editable element to its selection as it takes the focus,
 * `preventScroll` or not, so every way the body is focused — a drop the editor
 * handles itself, the editor's own `focus()` — has to leave each scroller above
 * it where it was. The row drag's end is `document-row-drag-end-focus.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * An editor in a box that scrolls, whose scroll position reads back what was
 * written, scrolled to 500.
 * @returns The editor and the box.
 */
function openScrolled(): { editor: Editor; box: HTMLElement } {
  const box = document.createElement('div');
  let top = 0;
  Object.defineProperty(box, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  document.body.appendChild(box);
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  editor.mount(box);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'first' },
    { type: 'paragraph', content: 'second' },
  ] as never);
  box.scrollTop = 500;
  // What WebKit does: it honours `preventScroll` (ProseMirror reads the option
  // to find that out), and still scrolls the caret, up at the top, into view
  // as the element takes the focus.
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation((options?: FocusOptions) => {
    void options?.preventScroll;
    box.scrollTop = 0;
  });
  return { editor, box };
}

describe('the body taking the focus', () => {
  it('stays where it is when the editor gives itself the focus', () => {
    const { editor, box } = openScrolled();

    editor.focus();

    expect(HTMLElement.prototype.focus).toHaveBeenCalled();
    expect(box.scrollTop).toBe(500);
  });

  it('stays where it is when text dragged in from outside is dropped on it', () => {
    const { editor, box } = openScrolled();
    const view = editor.prosemirrorView!;
    let at = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'second') at = pos;
    });
    vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: at + 3, inside: -1 });
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: 10, clientY: 10 });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['text/plain'], files: [], getData: (type: string) => (type === 'text/plain' ? 'dropped' : '') },
    });

    view.dom.dispatchEvent(event);

    expect(view.state.doc.textContent).toContain('secdroppedond');
    expect(box.scrollTop).toBe(500);
  });
});
