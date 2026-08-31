// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * When the greying judgement is asked, and what it answers about (§6.7).
 *
 * Two things at once. It is not asked at all while the menu is shut: it builds
 * the nine transactions the presses would build, which is what makes it
 * trustworthy and what makes it cost with the square of the selection — over a
 * select-all one pass measures 42ms at 200 list items, 303ms at 600 and 764ms
 * at 1000 — and a co-editor typing into a long document is a stream of
 * transactions, so paying that over rows nobody is looking at would freeze the
 * document.
 *
 * And while the menu IS down it follows the document. A37 and A38 say a greyed
 * row does nothing and dispatches nothing, and the press reads the state it is
 * given at the moment of the press. An answer from when the menu opened would
 * therefore be a row that says one thing and does another as soon as anything
 * moves underneath it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, waitFor } from '@testing-library/react';

import { canRunBlockType } from '@web/spaces/document/document-block-press';

import {
  mountDocumentEditor,
  hoverOpenSlot,
  openSharedBody,
  closeShared,
} from './bubble-bar-harness';
import { selectBlock, selectWholeBody } from './block-type-fixtures';

const SLOT = 'doc-bubble-block-type';

/**
 * The rows the open menu greys.
 * @param menu - The menu element.
 * @returns Their ids, in the order the menu draws them.
 */
function greyedIds(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll(`[data-testid^="${SLOT}-item-"]`))
    .filter((row) => row.getAttribute('aria-disabled') === 'true')
    .map((row) => row.getAttribute('data-testid')?.replace(`${SLOT}-item-`, '') ?? '');
}

vi.mock('@web/spaces/document/document-block-press', async (importOriginal) => {
  const real = await importOriginal<
    typeof import('@web/spaces/document/document-block-press')
  >();
  return { ...real, canRunBlockType: vi.fn(real.canRunBlockType) };
});

const asked = vi.mocked(canRunBlockType);

afterEach(() => {
  closeShared();
  vi.restoreAllMocks();
});

describe('the greying judgement', () => {
  it('is not asked while the menu is shut, and is once it is down', async () => {
    const editor = openSharedBody('<p>the quick brown fox</p><p>a second line</p>');
    mountDocumentEditor(editor);
    act(() => {
      editor.view.dom.focus();
      selectWholeBody(editor);
    });
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
      ).toBeGreaterThan(0);
    });

    // The bar is up with the menu shut. What the selector answers to is a
    // transaction reaching the editor, whoever sent it and whatever it carried
    // — a co-editor's keystroke arrives as one of these — so one that leaves
    // the selection alone is the case to press on.
    asked.mockClear();
    const seen = vi.fn();
    editor.on('transaction', seen);
    act(() => {
      editor.view.dispatch(editor.state.tr.setMeta('probe', true));
    });
    expect(seen, 'no transaction reached the editor').toHaveBeenCalled();
    expect(asked, 'asked with nobody looking').not.toHaveBeenCalled();

    await hoverOpenSlot(SLOT);
    expect(asked).toHaveBeenCalled();
  });

  it('follows the document while the menu stays down', async () => {
    // The reader gets to this body in two presses of this very menu: take the
    // second line of a two-line item, press Quote, then take the first line.
    // Rule 5 greys Quote there, because the wrapping would have to go around a
    // list that already holds a quote.
    const editor = openSharedBody('<ul><li><p>a</p><blockquote><p>b</p></blockquote></li></ul>');
    mountDocumentEditor(editor);
    act(() => {
      editor.view.dom.focus();
      selectBlock(editor, 'a');
    });
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
      ).toBeGreaterThan(0);
    });
    const menu = await hoverOpenSlot(SLOT);
    expect(greyedIds(menu), 'the quote rule holds when the menu opens')
      .toEqual(['task-list', 'quote']);

    // A co-editor takes that quote away. Their keystroke reaches this editor as
    // a transaction, and the menu stays down through it.
    act(() => {
      const { doc } = editor.state;
      let from = -1;
      let to = -1;
      doc.descendants((node, pos) => {
        if (node.type.name !== 'blockquote' || from >= 0) return true;
        from = pos;
        to = pos + node.nodeSize;
        return false;
      });
      editor.view.dispatch(editor.state.tr.delete(from, to));
    });

    await waitFor(() => {
      expect(greyedIds(menu), 'still drawn greyed after the quote went away')
        .toEqual(['task-list']);
    });
  });

  it('follows the selection while the menu stays down', async () => {
    const editor = openSharedBody('<ul><li><p>a</p><blockquote><p>b</p></blockquote></li></ul>');
    mountDocumentEditor(editor);
    act(() => {
      editor.view.dom.focus();
      selectBlock(editor, 'a');
    });
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
      ).toBeGreaterThan(0);
    });
    const menu = await hoverOpenSlot(SLOT);
    expect(greyedIds(menu)).toEqual(['task-list', 'quote']);

    // The quoted line is inside a quote already, so Quote takes it off there
    // and the row is live.
    act(() => { selectBlock(editor, 'b'); });
    await waitFor(() => {
      expect(greyedIds(menu), 'still drawn greyed on a line Quote reaches')
        .toEqual(['task-list']);
    });
  });
});
