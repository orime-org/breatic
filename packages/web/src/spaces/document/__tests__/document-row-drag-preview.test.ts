// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1350 A1 and §5.2: a row drag hands the browser our scaled preview, and
 * keeps the side menu — the drag's source — in the page until it ends, so the
 * `dragend` of an Esc reaches the document.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { SideMenuExtension } from '@blocknote/core/extensions';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { startRowDrag } from '@web/spaces/document/document-row-drag';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];
/** Drags a case started; ended before the page is cleared, since the library keeps its preview in module state. */
const ends: Array<() => void> = [];

afterEach(() => {
  for (const end of ends.splice(0)) end();
  for (const editor of mounted.splice(0)) editor.unmount();
  document.body.innerHTML = '';
});

/**
 * Opens an editor holding two paragraphs.
 * @returns The editor.
 */
function open(): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [
    { type: 'paragraph', content: 'first' },
    { type: 'paragraph', content: 'second' },
  ] as never);
  return editor;
}

/**
 * A drag's data transfer that records the images it is handed.
 * @returns The data transfer and the recorded calls.
 */
function transfer(): { dataTransfer: DataTransfer; setDragImage: ReturnType<typeof vi.fn> } {
  const setDragImage = vi.fn();
  const dataTransfer = {
    setDragImage,
    setData: vi.fn(),
    clearData: vi.fn(),
    effectAllowed: 'all',
  } as unknown as DataTransfer;
  return { dataTransfer, setDragImage };
}

describe('a row drag', () => {
  it('hands the browser our preview last, scaled on an inner layer', () => {
    const editor = open();
    const { dataTransfer, setDragImage } = transfer();
    ends.push(startRowDrag(editor as never, { dataTransfer, clientY: 0 }, editor.document[0]!.id));
    const [element] = setDragImage.mock.calls.at(-1) as [HTMLElement];
    expect(element.isConnected).toBe(true);
    expect((element.firstElementChild as HTMLElement).style.transform).toMatch(/^scale\(/);
    expect(element.textContent).toContain('first');
  });

  it('freezes the side menu for the drag and lets it go, preview and all, at the end', () => {
    const editor = open();
    const { dataTransfer, setDragImage } = transfer();
    const end = startRowDrag(editor as never, { dataTransfer, clientY: 0 }, editor.document[0]!.id);
    const sideMenu = editor.getExtension(SideMenuExtension)!;
    expect(sideMenu.menuFrozen).toBe(true);
    const [element] = setDragImage.mock.calls.at(-1) as [HTMLElement];
    end();
    expect(sideMenu.menuFrozen).toBe(false);
    expect(element.isConnected).toBe(false);
  });
});
