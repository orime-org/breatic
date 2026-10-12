// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 design §5.5: a row drag gives the body the focus back when it
 * ends, and the body stays where the drag left it. WebKit scrolls an editable
 * element to its selection when it takes the focus, `preventScroll` or not;
 * after the body scrolled under the drag the reader's caret is often off
 * screen, and the body would jump back to it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { startRowDrag } from '@web/spaces/document/document-row-drag';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * A box that scrolls, whose scroll position reads back what was written.
 * @returns The box.
 */
function scroller(): HTMLElement {
  const box = document.createElement('div');
  let top = 0;
  Object.defineProperty(box, 'scrollTop', {
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  document.body.appendChild(box);
  return box;
}

describe('the end of a row drag', () => {
  it('gives the body the focus where it is, even where taking the focus scrolls to the caret', () => {
    const box = scroller();
    const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
    editor.mount(box);
    mounted.push(editor);
    editor.replaceBlocks(editor.document, [
      { type: 'paragraph', content: 'first' },
      { type: 'paragraph', content: 'second' },
    ] as never);
    const id = (editor.document[1] as unknown as { id: string }).id;
    const dataTransfer = { setDragImage: vi.fn(), setData: vi.fn(), clearData: vi.fn(), effectAllowed: 'all' } as unknown as DataTransfer;
    const end = startRowDrag(editor, { dataTransfer, clientY: 0 }, id);
    box.scrollTop = 500;
    // What WebKit does: it honours `preventScroll` (ProseMirror reads the
    // option to find that out), and still scrolls the caret, up at the top,
    // into view as the element takes the focus.
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation((options?: FocusOptions) => {
      void options?.preventScroll;
      box.scrollTop = 0;
    });

    end();

    expect(HTMLElement.prototype.focus).toHaveBeenCalled();
    expect(box.scrollTop).toBe(500);
  });
});
