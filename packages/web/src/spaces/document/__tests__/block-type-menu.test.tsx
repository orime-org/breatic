// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the block type menu draws the model.
 *
 * The tick is the only mark a row carries: it says what the selection already
 * is, and the row fill that used to say the same thing is gone — two marks for
 * one fact, one of them a shade of the hover fill.
 *
 * Greying answers one question for all nine rows at once. In the flat model
 * any block can become any of them, so the only selection a row cannot reach
 * is one covering no block at all, and every row is drawn greyed there
 * together.
 *
 * What the menu shows while it stays open is its own group below. The rows are
 * read through `useEditorSnapshot`, which follows the document and the
 * selection separately, and a row that answered from the moment the menu
 * opened would say one thing and do another as soon as either moved.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, act, waitFor, fireEvent } from '@testing-library/react';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import {
  mountDocumentEditor,
  hoverOpenSlot,
  openSharedBody,
  closeShared,
  focusBody,
  selectBlockText,
  selectWholeBody,
  waitForBar,
  sharedDoc,
  type HarnessEditor,
} from './bubble-bar-harness';

/**
 * The one heading element in the shared document.
 * @param node - Where to look.
 * @returns That element.
 * @throws {Error} When the body holds no heading.
 */
function headingElement(node: Y.XmlFragment | Y.XmlElement): Y.XmlElement {
  for (let i = 0; i < node.length; i += 1) {
    const child: unknown = node.get(i);
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'heading') return child;
      const deeper = headingElement(child);
      if (deeper.nodeName === 'heading') return deeper;
    }
  }
  throw new Error('no heading in the body');
}

afterEach(() => {
  closeShared();
  vi.restoreAllMocks();
});

const SLOT = 'doc-bubble-block-type';

/**
 * Select the whole body, with the editor really holding the focus.
 * @param editor - The editor.
 */
async function selectAll(editor: HarnessEditor): Promise<void> {
  act(() => {
    focusBody(editor);
    selectWholeBody(editor);
  });
  await waitForBar();
}

/**
 * Select the block holding the given text, with the editor holding the focus.
 * @param editor - The editor.
 * @param text - The text to look for.
 */
async function selectBlock(
  editor: HarnessEditor,
  text: string,
): Promise<void> {
  act(() => {
    focusBody(editor);
    selectBlockText(editor, text);
  });
  await waitForBar();
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

/** Puts the first block of the shared document inside a quote. */
function quoteFirstBlock(): void {
  const shared = sharedDoc();
  const first = (node: Y.XmlFragment | Y.XmlElement): Y.XmlElement | null => {
    for (let i = 0; i < node.length; i += 1) {
      const child: unknown = node.get(i);
      if (child instanceof Y.XmlElement) {
        if (child.nodeName === 'heading' || child.nodeName === 'paragraph') {
          return child;
        }
        const deeper = first(child);
        if (deeper !== null) return deeper;
      }
    }
    return null;
  };
  const block = first(documentBodyFragment(shared));
  if (block === null) throw new Error('no block to quote');
  shared.transact(() => {
    block.setAttribute('quoted', true as never);
  });
}

/** The body as the shared document holds it, read off the editor. */
function bodyText(editor: HarnessEditor): string {
  return editor.prosemirrorState.doc.textContent;
}

describe('the menu', () => {
  it('draws the nine in three groups: the seven, then Ordered, then Quote', async () => {
    const editor = openSharedBody('<p>the quick brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);

    // Rows and rules read together, in the one order the DOM has them, so the
    // rules are pinned where they fall rather than by a pair of comparisons
    // that hold for more than one arrangement.
    const drawn = Array.from(
      menu.querySelectorAll(`[data-testid^="${SLOT}-item-"], [data-testid="doc-bubble-rule"]`),
    ).map((node) => {
      const id = node.getAttribute('data-testid') ?? '';
      return id === 'doc-bubble-rule' ? '—' : id.replace(`${SLOT}-item-`, '');
    });

    // The three groups are the three things a row can set, and they are
    // separate because a row in one can hold at the same time as a row in
    // another (user 2026-09-02): the seven set the block's type and are
    // mutually exclusive, Ordered sets its numbering, Quote sets its quoting.
    expect(drawn).toEqual([
      'paragraph',
      'heading-1',
      'heading-2',
      'heading-3',
      'code-block',
      'bullet-list',
      'task-list',
      '—',
      'ordered-list',
      '—',
      'quote',
    ]);
  });

  it.each([
    ['a plain paragraph', '<p>the quick brown fox</p>'],
    ['a list item', '<ul><li><p>an item</p></li></ul>'],
    ['a code block', '<pre><code>npm install</code></pre>'],
    ['a selection across two blocks', '<h1>a heading</h1><p>a paragraph</p>'],
  ])('greys nothing on %s', async (_name, body) => {
    const editor = openSharedBody(body);
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);
    expect(greyedIds(menu)).toEqual([]);
  });

  it('draws every row live over a selection the rows reach', async () => {
    const editor = openSharedBody('<p>the quick brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);
    const row = (id: string): Element | null =>
      menu.querySelector(`[data-testid="${SLOT}-item-${id}"]`);
    expect(row('paragraph')?.getAttribute('aria-disabled')).not.toBe('true');
    expect(row('paragraph')?.className).toContain('cursor');
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

describe('what the menu shows while it stays open', () => {
  it('follows a co-editor’s change to the block under the selection', async () => {
    // Their edit reaches this editor with no render behind it. A tick read
    // when the menu opened would go on saying the selection is a level one
    // heading after they made it a level two.
    const editor = openSharedBody('<h1>a heading</h1>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await hoverOpenSlot(SLOT);
    expect(tickedIds(menu)).toEqual(['heading-1']);

    const shared = sharedDoc();
    await act(async () => {
      headingElement(documentBodyFragment(shared));
      const heading = headingElement(documentBodyFragment(shared));
      shared.transact(() => {
        heading.setAttribute('level', 2 as never);
      }, 'a-collaborator');
      await new Promise((resolve) => {
        setTimeout(resolve, 40);
      });
    });

    expect(tickedIds(screen.getByTestId(`${SLOT}-menu`))).toEqual(['heading-2']);
  });

  it('follows the selection', async () => {
    const editor = openSharedBody('<h1>a heading</h1><p>a paragraph</p>');
    mountDocumentEditor(editor);
    await selectBlock(editor, 'a heading');
    const menu = await hoverOpenSlot(SLOT);
    expect(tickedIds(menu)).toEqual(['heading-1']);

    act(() => {
      selectBlockText(editor, 'a paragraph');
    });

    await waitFor(() => {
      expect(tickedIds(screen.getByTestId(`${SLOT}-menu`))).toEqual(['paragraph']);
    });
  });
});

describe('the tick', () => {
  it('marks the one exclusive row the selection is, alongside Quote', async () => {
    // Quote is a prop on the block rather than a container, so it is set here
    // rather than written as markup: there is no `blockquote` node to parse
    // into.
    const editor = openSharedBody('<h1>the quick brown fox</h1>');
    quoteFirstBlock();
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
      expect(
        editor.prosemirrorState.doc.textContent,
      ).toBe('the quick brown fox');
    });
    const heading = editor.document as unknown as {
      type: string;
      props: Record<string, unknown>;
    }[];
    expect(heading[0]?.type).toBe('heading');
    expect(heading[0]?.props['level']).toBe(2);
    expect(bodyText(editor)).toBe('the quick brown fox');
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
