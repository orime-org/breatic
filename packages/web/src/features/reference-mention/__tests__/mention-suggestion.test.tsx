// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

// The `@` list both the chat box and the generate panel open: which keys it
// takes, and where it sits.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { type Editor, Node } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { EditorContent, useEditor } from '@tiptap/react';
import { Suggestion } from '@tiptap/suggestion';
import * as React from 'react';

const placements = vi.hoisted(() => [] as string[]);
vi.mock('@floating-ui/dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@floating-ui/dom')>();
  return {
    ...actual,
    computePosition: (ref: unknown, el: HTMLElement, opts: { placement: string }) => {
      placements.push(opts.placement);
      return actual.computePosition(ref as never, el, opts as never);
    },
  };
});

import {
  MENTION_SOURCE_ID_ATTR,
  REFERENCE_MENTION_NODE,
} from '@web/features/reference-mention/mention-node';
import { makeMentionSuggestion } from '@web/features/reference-mention/mention-suggestion';
import { createLocalUserInputTracker } from '@web/features/reference-mention/reference-mention-local-input';

interface Row {
  id: string;
  name: string;
}

const ROWS: Row[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
];

beforeEach(() => {
  placements.length = 0;
});

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * An editor whose chip node opens the shared `@` list over {@link ROWS}.
 * @param placement - Where the list sits against the `@`.
 * @returns The editor.
 */
async function makeEditor(placement: 'top-start' | 'bottom-start' = 'top-start'): Promise<Editor> {
  const suggestion = makeMentionSuggestion<Row>({
    resolveList: (query) => {
      const items = ROWS.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()));
      return { items, emptyLabel: 'Nothing to pick' };
    },
    content: (row) => ({ type: REFERENCE_MENTION_NODE, attrs: { [MENTION_SOURCE_ID_ATTR]: row.id } }),
    itemKey: (row) => row.id,
    renderItem: (row) => <span>{row.name}</span>,
    placement,
  });
  const Chip = Node.create({
    name: REFERENCE_MENTION_NODE,
    group: 'inline',
    inline: true,
    atom: true,
    addAttributes() {
      return { [MENTION_SOURCE_ID_ATTR]: { default: null } };
    },
    renderHTML() {
      return ['span', { 'data-reference-mention': '' }];
    },
    addProseMirrorPlugins() {
      return [Suggestion<Row>({ editor: this.editor, ...suggestion }), createLocalUserInputTracker()];
    },
  });
  let mounted: Editor | null = null;
  /**
   * Mounts the editor under EditorContent, which is what renders the list.
   * @returns The editor's content.
   */
  function Host(): React.JSX.Element {
    const e = useEditor({ extensions: [Document, Paragraph, Text, Chip], immediatelyRender: true });
    mounted = e;
    return <EditorContent editor={e} />;
  }
  render(<Host />);
  return waitFor(() => {
    if (mounted === null) throw new Error('editor not mounted');
    return mounted;
  });
}

/**
 * Types into the editor the way a keystroke does.
 * @param e - The editor.
 * @param text - What to type.
 */
function type(e: Editor, text: string): void {
  act(() => {
    e.view.dispatch(e.state.tr.insertText(text));
  });
}

/**
 * Presses a key in the editor.
 * @param e - The editor.
 * @param key - The key.
 */
function press(e: Editor, key: string): void {
  act(() => {
    e.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

/**
 * Waits until the list has rendered its rows or its empty sentence.
 * @returns Resolves once it is on screen.
 */
function listShown(): Promise<unknown> {
  return waitFor(() => {
    expect(
      document.querySelector('[data-testid^="reference-mention-option-"], [data-testid="reference-mention-empty"]'),
    ).not.toBeNull();
  });
}

/**
 * The ids of the chips in the document, in order.
 * @param e - The editor.
 * @returns The ids.
 */
function chips(e: Editor): string[] {
  const ids: string[] = [];
  e.state.doc.descendants((n) => {
    if (n.type.name === REFERENCE_MENTION_NODE) ids.push(n.attrs[MENTION_SOURCE_ID_ATTR] as string);
  });
  return ids;
}

describe('the shared @ list', () => {
  it('lists the rows when @ is typed', async () => {
    const e = await makeEditor();
    type(e, '@');
    await listShown();

    expect(document.querySelector('[data-testid="reference-mention-option-a"]')?.textContent).toBe('Alpha');
    expect(document.querySelector('[data-testid="reference-mention-option-b"]')).not.toBeNull();
  });

  it('inserts the highlighted row on Tab', async () => {
    const e = await makeEditor();
    type(e, '@');
    await listShown();
    press(e, 'ArrowDown');
    press(e, 'Tab');

    expect(chips(e)).toEqual(['b']);
    expect(e.state.doc.textContent).not.toContain('@');
  });

  it('only closes the list when Enter finds nothing to pick', async () => {
    const e = await makeEditor();
    type(e, '@zz');
    await listShown();
    press(e, 'Enter');

    expect(document.querySelector('[data-testid="reference-mention-empty"]')).toBeNull();
    expect(e.state.doc.childCount).toBe(1);
    expect(e.state.doc.textContent).toBe('@zz');
  });

  it('leaves Enter to the editor once the list was closed by a click elsewhere', async () => {
    const e = await makeEditor();
    type(e, '@');
    await listShown();
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    press(e, 'Enter');

    expect(chips(e)).toEqual([]);
  });

  it('opens on the full-width at sign a CJK input method types, and filters after it', async () => {
    const e = await makeEditor();
    type(e, '写真の＠be');
    await listShown();

    expect(document.querySelector('[data-testid="reference-mention-option-b"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="reference-mention-option-a"]')).toBeNull();
    press(e, 'Enter');
    expect(chips(e)).toEqual(['b']);
    expect(e.state.doc.textContent).toBe('写真の');
  });

  it('follows the nearer of the two at signs', async () => {
    const e = await makeEditor();
    type(e, '＠x then @al');
    await listShown();

    expect(document.querySelector('[data-testid="reference-mention-option-a"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="reference-mention-option-b"]')).toBeNull();
  });

  it('closes on Esc, keeps what was typed, and leaves the next Enter to the editor', async () => {
    const e = await makeEditor();
    type(e, '@al');
    await listShown();
    press(e, 'Escape');

    await waitFor(() => expect(document.querySelector('[data-testid^="reference-mention-option-"]')).toBeNull());
    expect(e.state.doc.textContent).toBe('@al');
    press(e, 'Enter');
    expect(chips(e)).toEqual([]);
  });

  it('inserts the row that is clicked', async () => {
    const e = await makeEditor();
    type(e, '@');
    await listShown();
    act(() => {
      (document.querySelector('[data-testid="reference-mention-option-b"]') as HTMLElement).click();
    });

    expect(chips(e)).toEqual(['b']);
  });

  it('lets Shift+Tab through without picking or ending the @', async () => {
    const e = await makeEditor();
    type(e, '@');
    await listShown();
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    act(() => {
      e.view.dom.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(chips(e)).toEqual([]);
  });

  it('hides the list when the keyboard moves focus to another control, and leaves Enter to the editor', async () => {
    const e = await makeEditor();
    const other = document.body.appendChild(document.createElement('button'));
    act(() => e.view.focus());
    type(e, '@');
    await listShown();
    expect(document.activeElement).toBe(e.view.dom);

    act(() => other.focus());

    const pop = document.querySelector<HTMLElement>('[data-testid="reference-mention-option-a"]')?.closest<HTMLElement>('body > div');
    expect(pop?.style.display).toBe('none');
    act(() => e.commands.focus());
    press(e, 'Enter');
    expect(chips(e)).toEqual([]);
  });

  it('keeps the list when focus moves onto one of its own rows', async () => {
    const e = await makeEditor();
    act(() => e.commands.focus());
    type(e, '@');
    await listShown();
    const row = document.querySelector<HTMLElement>('[data-testid="reference-mention-option-b"]');

    act(() => row?.focus());
    act(() => row?.click());

    expect(chips(e)).toEqual(['b']);
  });

  it('keeps the list when the window loses focus with nothing else taking it', async () => {
    const e = await makeEditor();
    act(() => e.commands.focus());
    type(e, '@');
    await listShown();

    act(() => {
      e.view.dom.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    });

    const pop = document.querySelector<HTMLElement>('[data-testid="reference-mention-option-a"]')?.closest<HTMLElement>('body > div');
    expect(pop?.style.display).toBe('');
  });

  it('neither shows nor picks while the editor is read-only', async () => {
    const e = await makeEditor();
    act(() => e.commands.focus());
    type(e, '@');
    await listShown();
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      e.setEditable(false);
    });

    // A click back on the caret dispatches nothing, so the plugin still holds
    // the `@` as active until the next transaction.
    e.view.posAtCoords = (() => ({ pos: e.state.selection.from, inside: -1 })) as typeof e.view.posAtCoords;
    act(() => {
      e.view.dom.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const row = document.querySelector<HTMLElement>('[data-testid="reference-mention-option-a"]');
    expect(row?.closest<HTMLElement>('body > div')?.style.display).toBe('none');
    act(() => row?.click());
    press(e, 'Enter');
    expect(chips(e)).toEqual([]);
  });

  it('sits where the caller places it', async () => {
    const e = await makeEditor('top-start');
    type(e, '@');

    return vi.waitFor(() => expect(placements).toContain('top-start'));
  });
});
