// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 design §5.5: the body gives itself the focus without moving.
 * WebKit scrolls an editable element to its selection as it takes the focus,
 * `preventScroll` or not, so every way the body is focused — a drop the editor
 * handles itself, the editor's own `focus()`, the end of a row drag — has to
 * leave each scroller above it where it was.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared/document-body';

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
  return { editor, box };
}

/**
 * Makes taking the focus do what WebKit does: it reads `preventScroll`, so
 * upstream prosemirror-view takes the option as supported and stops putting
 * the scroll positions back, and it still scrolls the caret, up at the top,
 * into view. A stand-in that left the option unread would send upstream down
 * its unsupported branch, which puts the positions back with or without the
 * patch.
 * @param box - The box the caret scrolls.
 */
function focusScrollsToCaret(box: HTMLElement): void {
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation((options?: FocusOptions) => {
    void options?.preventScroll;
    box.scrollTop = 0;
  });
}

describe('the body taking the focus', () => {
  it('stays where it is when the editor gives itself the focus', () => {
    const { editor, box } = openScrolled();
    focusScrollsToCaret(box);

    editor.focus();

    expect(HTMLElement.prototype.focus).toHaveBeenCalled();
    expect(box.scrollTop).toBe(500);
  });

  it('stays where it is when a row drag ends', () => {
    const { editor, box } = openScrolled();
    const id = (editor.document[1] as unknown as { id: string }).id;
    const dataTransfer = { setDragImage: vi.fn(), setData: vi.fn(), clearData: vi.fn(), effectAllowed: 'all' } as unknown as DataTransfer;
    const end = startRowDrag(editor, { dataTransfer, clientY: 0 }, id);
    focusScrollsToCaret(box);

    end();

    expect(HTMLElement.prototype.focus).toHaveBeenCalled();
    expect(box.scrollTop).toBe(500);
  });

  it('stays where it is when text dragged in from outside is dropped on it', () => {
    const { editor, box } = openScrolled();
    focusScrollsToCaret(box);
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
