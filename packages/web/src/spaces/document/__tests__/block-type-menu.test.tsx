// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the block type menu draws the model.
 *
 * The tick is the only mark a row carries: it says what the selection already
 * is, and the row fill that used to say the same thing is gone — two marks for
 * one fact, one of them a shade of the hover fill.
 *
 * Every row is pressable. Under the model each of the nine has a result waiting
 * for it, so there is no state where a row reaches nothing; the task list is
 * the one exception and is greyed for a reason of its own (#13).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, act, waitFor, fireEvent } from '@testing-library/react';
import type { Editor } from '@tiptap/react';


import {
  mountDocumentEditor,
  hoverOpenSlot,
  openSharedBody,
  closeShared,
} from './bubble-bar-harness';
import { selectWholeBody } from './block-type-fixtures';

afterEach(() => {
  closeShared();
  vi.restoreAllMocks();
});

const SLOT = 'doc-bubble-block-type';

/**
 * Select the whole body, with the editor really holding the focus.
 * @param editor - The editor.
 */
async function selectFirstBlock(editor: Editor, text?: string): Promise<void> {
  let from = 1;
  let to = 1;
  let found = false;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock || found) return !found;
    if (text !== undefined && node.textContent !== text) return false;
    from = pos + 1;
    to = pos + node.nodeSize - 1;
    found = true;
    return false;
  });
  act(() => {
    editor.view.dom.focus();
    editor.commands.setTextSelection({ from, to });
  });
  await waitFor(() => {
    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
    ).toBeGreaterThan(0);
  });
}

/**
 * Select the whole body, with the editor really holding the focus.
 * @param editor - The editor.
 */
async function selectAll(editor: Editor): Promise<void> {
  act(() => {
    editor.view.dom.focus();
    selectWholeBody(editor);
  });
  await waitFor(() => {
    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
    ).toBeGreaterThan(0);
  });
}

/**
 * The rows of the open menu, in the order they are drawn.
 * @param menu - The menu element.
 * @returns Their block type ids.
 */
function rowIds(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll(`[data-testid^="${SLOT}-item-"]`))
    .map((node) => node.getAttribute('data-testid')?.replace(`${SLOT}-item-`, '') ?? '');
}

/**
 * Which rows carry a tick.
 * @param menu - The menu element.
 * @returns Their block type ids.
 */
function tickedIds(menu: HTMLElement): string[] {
  return rowIds(menu).filter((id) =>
    menu.querySelector(`[data-testid="${SLOT}-tick-${id}"]`) !== null);
}

describe('the menu', () => {
  it('draws the nine in order, the rule after Code block', async () => {
    const editor = openSharedBody('<p>the quick brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);

    expect(rowIds(menu)).toEqual([
      'paragraph',
      'heading-1',
      'heading-2',
      'heading-3',
      'bullet-list',
      'ordered-list',
      'task-list',
      'code-block',
      'quote',
    ]);

    const rows = Array.from(menu.querySelectorAll(`[data-testid^="${SLOT}-item-"]`));
    const rule = menu.querySelector('[data-testid="doc-bubble-rule"]');
    const codeBlock = rows.find(
      (n) => n.getAttribute('data-testid') === `${SLOT}-item-code-block`,
    );
    const quote = rows.find((n) => n.getAttribute('data-testid') === `${SLOT}-item-quote`);
    expect(rule).not.toBeNull();
    expect(codeBlock?.compareDocumentPosition(rule as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(rule?.compareDocumentPosition(quote as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  /**
   * The rows the open menu greys, in the order they are drawn.
   * @param menu - The menu element.
   * @returns Their block type ids.
   */
  function greyedIds(menu: HTMLElement): string[] {
    return rowIds(menu).filter((id) =>
      menu.querySelector(`[data-testid="${SLOT}-item-${id}"]`)
        ?.getAttribute('aria-disabled') === 'true');
  }

  it.each([
    ['a plain paragraph', '<p>the quick brown fox</p>'],
    ['a list item', '<ul><li><p>an item</p></li></ul>'],
    ['a quoted line', '<blockquote><p>a quoted line</p></blockquote>'],
    ['a selection across two blocks', '<h1>a heading</h1><p>a paragraph</p>'],
  ])('greys the task list row and nothing else on %s', async (_name, body) => {
    const editor = openSharedBody(body);
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);
    expect(greyedIds(menu)).toEqual(['task-list']);
  });

  // §6.7's three selections, each with the rows it cannot reach. The first
  // block of an item has to be a paragraph and cannot leave the item; a later
  // block can leave for another list but not become a heading or a code block,
  // which would leave two rows answering for it (§6.0).
  const STUCK: Array<[name: string, body: string, pick: string, greyed: string[]]> = [
    [
      'the first block of an item holding a sub-list',
      '<ul><li><p>one</p><ul><li><p>deep</p></li></ul></li></ul>',
      'one',
      ['paragraph', 'heading-1', 'heading-2', 'heading-3',
        'bullet-list', 'ordered-list', 'task-list', 'code-block'],
    ],
    [
      'a later block of an item holding a sub-list',
      '<ul><li><p>b</p><p>c</p><ul><li><p>d</p></li></ul></li></ul>',
      'c',
      ['paragraph', 'heading-1', 'heading-2', 'heading-3',
        'bullet-list', 'task-list', 'code-block'],
    ],
  ];

  it.each(STUCK)('greys the rows %s cannot reach', async (_name, body, pick, greyed) => {
    const editor = openSharedBody(body);
    mountDocumentEditor(editor);
    await selectFirstBlock(editor, pick);
    const menu = await hoverOpenSlot(SLOT);
    expect(greyedIds(menu)).toEqual(greyed);
  });

  it('draws a row it cannot reach exactly as it draws the task list', async () => {
    const editor = openSharedBody('<ul><li><p>one</p><ul><li><p>deep</p></li></ul></li></ul>');
    mountDocumentEditor(editor);
    await selectFirstBlock(editor);
    const menu = await hoverOpenSlot(SLOT);
    const row = (id: string): Element | null =>
      menu.querySelector(`[data-testid="${SLOT}-item-${id}"]`);
    // The task list is greyed for a reason of its own and is the treatment
    // every other greyed row has to match (§6.7).
    expect(row('heading-1')?.className).toBe(row('task-list')?.className);
    expect(row('heading-1')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('carries no row fill and no data-active', async () => {
    const editor = openSharedBody('<h1>the quick brown fox</h1>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);

    for (const id of rowIds(menu)) {
      const row = menu.querySelector(`[data-testid="${SLOT}-item-${id}"]`);
      expect(row?.getAttribute('data-active')).toBeNull();
      // The hover fill stays; what went is the second mark that said the same
      // thing as the tick, one shade along from hover in the same direction.
      expect(row?.className ?? '').not.toMatch(/(?<!hover:)bg-accent/);
    }
  });
});

describe('the tick', () => {
  it('marks the one exclusive row the selection is, alongside Quote', async () => {
    const editor = openSharedBody('<blockquote><h1>the quick brown fox</h1></blockquote>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);
    expect(tickedIds(menu).sort()).toEqual(['heading-1', 'quote']);
  });

  it('marks nothing in the exclusive group over a mixed selection', async () => {
    const editor = openSharedBody('<h1>the quick</h1><p>brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);
    expect(tickedIds(menu)).toEqual([]);
  });

  it('has a column of its own on every row, ticked or not', async () => {
    const editor = openSharedBody('<h1>the quick brown fox</h1>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);

    // The demo gives the tick a column on every row
    // (`2026-08-29-block-type-transitions.html`'s `.row .tick`), so the one
    // carrying a tick is laid out like the rest and the shortcuts stay in
    // line. That the columns really do line up is measured in the browser
    // (`tests/smoke/document-block-type.spec.ts`); jsdom reports every
    // rectangle as zero.
    for (const id of rowIds(menu)) {
      expect(menu.querySelector(`[data-testid="${SLOT}-tickcol-${id}"]`)).not.toBeNull();
    }
    expect(tickedIds(menu)).toEqual(['heading-1']);
  });

  it('sits after the shortcut in the row', async () => {
    const editor = openSharedBody('<h1>the quick brown fox</h1>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);

    const shortcut = menu.querySelector(`[data-testid="${SLOT}-shortcut-heading-1"]`);
    const tick = menu.querySelector(`[data-testid="${SLOT}-tick-heading-1"]`);
    expect(shortcut).not.toBeNull();
    expect(tick).not.toBeNull();
    expect(shortcut?.compareDocumentPosition(tick as Node))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('the face', () => {
  it('shows the block inside a quote rather than the quote', async () => {
    const editor = openSharedBody('<blockquote><h1>the quick brown fox</h1></blockquote>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    expect(screen.getByTestId(SLOT).getAttribute('data-block-type')).toBe('heading-1');
  });

  it('answers for the anchor over a mixed selection while no row is ticked', async () => {
    const editor = openSharedBody('<h1>the quick</h1><p>brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    expect(screen.getByTestId(SLOT).getAttribute('data-block-type')).toBe('heading-1');
    const menu = await hoverOpenSlot(SLOT);
    expect(tickedIds(menu)).toEqual([]);
  });
});

describe('pressing a row', () => {
  it('changes the document and writes nothing to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const editor = openSharedBody('<p>the quick brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);

    act(() => {
      fireEvent.click(menu.querySelector(`[data-testid="${SLOT}-item-heading-2"]`) as Element);
    });
    await waitFor(() => {
      expect(editor.getHTML()).toBe('<h2>the quick brown fox</h2>');
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('closes the menu', async () => {
    const editor = openSharedBody('<p>the quick brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);

    act(() => {
      fireEvent.click(menu.querySelector(`[data-testid="${SLOT}-item-heading-2"]`) as Element);
    });
    await waitFor(() => {
      expect(screen.queryByTestId(`${SLOT}-menu`)).toBeNull();
    });
  });
});
