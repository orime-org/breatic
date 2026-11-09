// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { Editor } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { DRAG_IMAGE_CLASS } from '@web/lib/drag-image';
import { buildTextNodeExtensions } from '@web/spaces/canvas/nodes/TextNodeEditor';

/**
 * Gives a synthetic dragstart the data transfer ProseMirror reads.
 * @param event - The dragstart.
 * @param setDragImage - What the drag image is handed to.
 */
function attachDataTransfer(event: Event, setDragImage: (el: HTMLElement) => void): void {
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      clearData: (): void => undefined,
      setData: (): void => undefined,
      getData: (): string => '',
      types: [] as string[],
      setDragImage,
      effectAllowed: 'copyMove',
      files: [],
    },
  });
}

describe('canvas text node drag image (inner#1515)', () => {
  it('draws the dragged words the way the prompt box and the document do', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: buildTextNodeExtensions({ fragment: new Y.Doc().getXmlFragment('body'), placeholder: '' }),
    });
    try {
      editor.chain().insertContent('plain words only').run();
      editor.commands.setTextSelection({ from: 2, to: 8 });
      let image: HTMLElement | null = null;
      const setDragImage = vi.fn((el: HTMLElement) => {
        image = el;
      });
      const dragstart = new Event('dragstart', { bubbles: true, cancelable: true });
      attachDataTransfer(dragstart, setDragImage);
      editor.view.dom.dispatchEvent(dragstart);

      expect(setDragImage).toHaveBeenCalledTimes(1);
      const root = image as unknown as HTMLElement;
      expect(root.classList.contains(DRAG_IMAGE_CLASS)).toBe(true);
      expect(root.textContent).toBe('lain w');
      expect([root, ...root.querySelectorAll<HTMLElement>('*')].filter((el) => el.style.opacity !== '')).toEqual([]);
    } finally {
      editor.destroy();
    }
  });
});
