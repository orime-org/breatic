// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A20, A21: the layers that follow the caret go with the body's
 * focus, the controls that stand aside for the bubble bar read whether it is
 * on screen, and every body layer carries the mark that names where it
 * belongs (design 3.5.1).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';

import {
  closeShared,
  focusBody,
  mountDocumentEditor,
  openSharedBody,
  selectTextRange,
  type HarnessEditor,
} from './bubble-bar-harness';
import { documentBarsOf } from '@web/spaces/document/document-bars';
import { BODY_LAYER, bodyHolds } from '@web/spaces/document/document-body-focus';

afterEach(() => {
  closeShared();
  vi.restoreAllMocks();
});

/**
 * The body scroller a mounted body sits in.
 * @param editor - The editor.
 * @returns It.
 */
function scrollerOf(editor: HarnessEditor): HTMLElement {
  return editor.prosemirrorView!.dom.closest<HTMLElement>('[data-radix-scroll-area-viewport]')!;
}

/**
 * Presses and releases on the body scroller itself, blank space.
 * @param editor - The editor.
 */
function pressBlank(editor: HarnessEditor): void {
  const scroller = scrollerOf(editor);
  act(() => {
    scroller.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    scroller.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  });
}

describe('the bubble bar and the body’s focus', () => {
  it('goes when a press on blank space lets the body go, and says so to the controls that stand aside for it', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const editor = openSharedBody('<p>hello world</p>');
    mountDocumentEditor(editor);
    act(() => {
      focusBody(editor);
      selectTextRange(editor, 0, 5);
    });
    await screen.findByTestId('doc-selection-bubble-bar');
    expect(documentBarsOf(editor).bubbleBarUp).toBe(true);

    pressBlank(editor);

    expect(bodyHolds(editor.prosemirrorView!.state)).toBe(false);
    await waitFor(() => {
      expect(screen.queryByTestId('doc-selection-bubble-bar')).toBeNull();
    });
    expect(documentBarsOf(editor).bubbleBarUp).toBe(false);
  });

  it('carries the body layer mark on its root', async () => {
    const editor = openSharedBody('<p>hello world</p>');
    mountDocumentEditor(editor);
    act(() => {
      focusBody(editor);
      selectTextRange(editor, 0, 5);
    });
    const bar = await screen.findByTestId('doc-selection-bubble-bar');

    expect(bar.closest(`[${BODY_LAYER}]`)).not.toBeNull();
  });
});

describe('the link toolbar the caret raises and the body’s focus', () => {
  it('goes when a press on blank space lets the body go', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const editor = openSharedBody('<p><a href="https://x.example">a link</a> after</p>');
    mountDocumentEditor(editor);
    act(() => {
      focusBody(editor);
      editor.transact((tr) => {
        tr.setSelection(TextSelection.create(tr.doc, 4));
      });
    });
    const toolbar = await screen.findByTestId('doc-link-toolbar');
    expect(toolbar.closest(`[${BODY_LAYER}]`)).not.toBeNull();

    pressBlank(editor);

    await waitFor(() => {
      expect(screen.queryByTestId('doc-link-toolbar')).toBeNull();
    });
  });
});

describe('the cell button and the body’s focus', () => {
  it('goes when a press on blank space lets the body go, and the cell it sat on is no longer published', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const editor = openSharedBody('<p>lead</p>');
    act(() => {
      editor.insertBlocks(
        [{ type: 'table', content: { type: 'tableContent', rows: [{ cells: ['x', 'y'] }] } }] as never,
        (editor.document as { id: string }[])[0]!.id,
        'after',
      );
    });
    mountDocumentEditor(editor);
    const view = editor.prosemirrorView!;
    let inCell = -1;
    view.state.doc.descendants((node, pos) => {
      if (inCell < 0 && node.isText && node.text === 'x') inCell = pos;
      return inCell < 0;
    });
    act(() => {
      focusBody(editor);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, inCell + 1)));
    });
    const button = await screen.findByTestId('doc-table-cell-button');
    expect(button.closest(`[${BODY_LAYER}]`)).not.toBeNull();
    expect(documentBarsOf(editor).cellButtonCell).not.toBeNull();

    pressBlank(editor);

    await waitFor(() => {
      expect(screen.queryByTestId('doc-table-cell-button')).toBeNull();
    });
    expect(documentBarsOf(editor).cellButtonCell).toBeNull();
  });
});
