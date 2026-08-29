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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, act, waitFor, fireEvent } from '@testing-library/react';
import { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';
import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

import { mountDocumentEditor, hoverOpenSlot } from './bubble-bar-harness';

const editors: Editor[] = [];
let doc: Y.Doc;

beforeEach(() => {
  doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
});

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
  doc.destroy();
  vi.restoreAllMocks();
});

const SLOT = 'doc-bubble-block-type';

/**
 * A real editor holding the given body, bound to a real Y.Doc.
 * @param bodyHtml - The body's HTML.
 * @returns The editor.
 */
function open(bodyHtml: string): Editor {
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  if (bodyHtml) editor.commands.setContent(bodyHtml);
  return editor;
}

/**
 * Select the whole body, with the editor really holding the focus.
 * @param editor - The editor.
 */
async function selectAll(editor: Editor): Promise<void> {
  const { doc: pmDoc } = editor.state;
  let first: number | null = null;
  let last = 1;
  pmDoc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (first === null) first = pos + 1;
    last = pos + node.nodeSize - 1;
    return false;
  });
  act(() => {
    editor.view.dom.focus();
    editor.commands.setTextSelection({ from: first ?? 1, to: last });
  });
  await waitFor(() => {
    expect(
      document.querySelectorAll('[data-testid^="doc-bubble-tool-"]').length,
    ).toBeGreaterThan(0);
  });
}

/**
 * Open the block type slot's menu.
 * @returns The opened menu element.
 */
async function openMenu(): Promise<HTMLElement> {
  return hoverOpenSlot(SLOT);
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
    const editor = open('<p>the quick brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await openMenu();

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

  it('keeps the task list row greyed and pressable by no one else', async () => {
    const editor = open('<p>the quick brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await openMenu();

    const disabled = rowIds(menu).filter((id) =>
      menu.querySelector(`[data-testid="${SLOT}-item-${id}"]`)
        ?.getAttribute('aria-disabled') === 'true');
    expect(disabled).toEqual(['task-list']);
  });

  it('carries no row fill and no data-active', async () => {
    const editor = open('<h1>the quick brown fox</h1>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await openMenu();

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
    const editor = open('<blockquote><h1>the quick brown fox</h1></blockquote>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await openMenu();
    expect(tickedIds(menu).sort()).toEqual(['heading-1', 'quote']);
  });

  it('marks nothing in the exclusive group over a mixed selection', async () => {
    const editor = open('<h1>the quick</h1><p>brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await openMenu();
    expect(tickedIds(menu)).toEqual([]);
  });

  it('sits after the shortcut in the row', async () => {
    const editor = open('<h1>the quick brown fox</h1>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await openMenu();

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
    const editor = open('<blockquote><h1>the quick brown fox</h1></blockquote>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    expect(screen.getByTestId(SLOT).getAttribute('data-block-type')).toBe('heading-1');
  });

  it('answers for the anchor over a mixed selection while no row is ticked', async () => {
    const editor = open('<h1>the quick</h1><p>brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    expect(screen.getByTestId(SLOT).getAttribute('data-block-type')).toBe('heading-1');
    const menu = await openMenu();
    expect(tickedIds(menu)).toEqual([]);
  });
});

describe('pressing a row', () => {
  it('changes the document and writes nothing to the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const editor = open('<p>the quick brown fox</p>');
    mountDocumentEditor(editor);
    await selectAll(editor);
    const menu = await openMenu();

    act(() => {
      fireEvent.click(menu.querySelector(`[data-testid="${SLOT}-item-heading-2"]`) as Element);
    });
    await waitFor(() => {
      expect(editor.getHTML()).toBe('<h2>the quick brown fox</h2>');
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
