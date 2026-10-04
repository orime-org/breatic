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

  it('sits where the caller places it', async () => {
    const e = await makeEditor('top-start');
    type(e, '@');

    return vi.waitFor(() => expect(placements).toContain('top-start'));
  });
});
