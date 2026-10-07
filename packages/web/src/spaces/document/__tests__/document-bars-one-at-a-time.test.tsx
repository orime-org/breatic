// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127: the document shows one bar at a time. A media block the pointer
 * is on owns the bar; the selection bubble bar, the link toolbar and another
 * media block's toolbar step aside while it does, and come back once the
 * pointer leaves.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';

import {
  closeShared,
  focusBody,
  mountDocumentEditor,
  openSharedBody,
  selectTextRange,
  type HarnessEditor,
} from './bubble-bar-harness';
import { documentBarsOf, setLinkToolbarUp } from '@web/spaces/document/document-bars';

afterEach(() => {
  closeShared();
  vi.restoreAllMocks();
});

const URL_OF = 'https://cdn.example/image/2026-10-07/a.png';

/**
 * Opens and mounts a body, with picture blocks after its first line.
 * @param bodyHtml - The body's HTML.
 * @param pictures - How many picture blocks follow the first line.
 * @returns The editor.
 */
function openWithPictures(bodyHtml: string, pictures: number): HarnessEditor {
  const editor = openSharedBody(bodyHtml);
  act(() => {
    editor.insertBlocks(
      Array.from({ length: pictures }, (_, i) => ({
        type: 'image',
        props: { url: URL_OF, name: `p${i}.png` },
      })) as never,
      (editor.document as { id: string }[])[0]!.id,
      'after',
    );
  });
  mountDocumentEditor(editor);
  return editor;
}

/**
 * Every picture block's element, in document order.
 * @param editor - The editor.
 * @returns The `blockContent` elements.
 */
function pictures(editor: HarnessEditor): HTMLElement[] {
  return [...editor.prosemirrorView!.dom.querySelectorAll<HTMLElement>('[data-content-type="image"]')];
}

/**
 * Whether a picture block's toolbar is the one on screen.
 * @param block - The picture block's element.
 * @returns True when its toolbar is shown.
 */
function toolbarShown(block: HTMLElement): boolean {
  return within(block).getByTestId('doc-media-toolbar').getAttribute('data-shown') === 'true';
}

/**
 * Moves the pointer onto or off what a picture block shows.
 * @param block - The picture block's element.
 * @param on - True to move onto it.
 */
function hover(block: HTMLElement, on: boolean): void {
  const frame = within(block).getByTestId('doc-media-frame');
  act(() => {
    if (on) fireEvent.pointerEnter(frame);
    else fireEvent.pointerLeave(frame);
  });
}

/**
 * Node-selects a picture block, the way a click on it does.
 * @param editor - The editor.
 * @param index - Which picture, in document order.
 */
function selectPicture(editor: HarnessEditor, index: number): void {
  const view = editor.prosemirrorView!;
  const at: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') at.push(pos);
  });
  act(() => {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at[index]!)));
  });
}

describe('one bar at a time in the document', () => {
  it('shows only the hovered picture toolbar while another picture is selected', () => {
    const editor = openWithPictures('<p>start</p>', 2);
    const [first, second] = pictures(editor);
    selectPicture(editor, 0);
    expect(toolbarShown(first!)).toBe(true);

    hover(second!, true);
    expect(toolbarShown(first!)).toBe(false);
    expect(toolbarShown(second!)).toBe(true);

    hover(second!, false);
    expect(toolbarShown(first!)).toBe(true);
    expect(toolbarShown(second!)).toBe(false);
  });

  it('puts the selection bubble bar aside while a picture is hovered', async () => {
    const editor = openWithPictures('<p>hello world</p>', 1);
    act(() => {
      focusBody(editor);
      selectTextRange(editor, 0, 5);
    });
    const bar = await screen.findByTestId('doc-selection-bubble-bar');
    expect(bar.getAttribute('data-standing-aside')).toBeNull();

    hover(pictures(editor)[0]!, true);
    expect(screen.getByTestId('doc-selection-bubble-bar').getAttribute('data-standing-aside')).toBe('true');

    hover(pictures(editor)[0]!, false);
    expect(screen.getByTestId('doc-selection-bubble-bar').getAttribute('data-standing-aside')).toBeNull();
  });

  it('puts the link toolbar aside while a picture is hovered', async () => {
    const editor = openWithPictures('<p><a href="https://x.example">a link</a> after</p>', 1);
    act(() => {
      focusBody(editor);
      editor.transact((tr) => {
        tr.setSelection(TextSelection.create(tr.doc, 4));
      });
    });
    const toolbar = await screen.findByTestId('doc-link-toolbar');
    expect(toolbar.getAttribute('data-standing-aside')).toBeNull();

    hover(pictures(editor)[0]!, true);
    expect(screen.getByTestId('doc-link-toolbar').getAttribute('data-standing-aside')).toBe('true');

    hover(pictures(editor)[0]!, false);
    await waitFor(() => {
      expect(screen.getByTestId('doc-link-toolbar').getAttribute('data-standing-aside')).toBeNull();
    });
  });

  it('keeps a selected picture toolbar down while the link toolbar is up', async () => {
    const editor = openWithPictures('<p><a href="https://x.example">a link</a> after</p>', 1);
    const [picture] = pictures(editor);
    selectPicture(editor, 0);
    expect(toolbarShown(picture!)).toBe(true);

    // The pointer resting on a link raises its toolbar with the picture still
    // selected; the toolbar says so to the document, which is what is read.
    act(() => {
      setLinkToolbarUp(editor, true);
    });
    expect(toolbarShown(picture!)).toBe(false);

    act(() => {
      setLinkToolbarUp(editor, false);
    });
    expect(toolbarShown(picture!)).toBe(true);
  });

  it('is told by the link toolbar when it comes up and goes down', async () => {
    const editor = openWithPictures('<p><a href="https://x.example">a link</a> after</p>', 1);
    act(() => {
      focusBody(editor);
      editor.transact((tr) => {
        tr.setSelection(TextSelection.create(tr.doc, 4));
      });
    });
    await screen.findByTestId('doc-link-toolbar');
    expect(documentBarsOf(editor).linkToolbarUp).toBe(true);

    act(() => {
      editor.transact((tr) => {
        tr.setSelection(TextSelection.create(tr.doc, tr.doc.content.size - 4));
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).toBeNull();
    });
    expect(documentBarsOf(editor).linkToolbarUp).toBe(false);
  });
});
