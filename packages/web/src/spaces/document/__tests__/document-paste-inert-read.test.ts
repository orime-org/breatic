// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A pasted copy's HTML is read in a document of its own, never in the page
 * (inner#1351 + inner#1390): HTML written into an element of a document with
 * a browsing context loads its images, so an `onerror` in a copy from another
 * page would run in ours.
 */

import { act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { TextSelection } from '@tiptap/pm/state';

import { open, pasteFormats, positionOf, settled, unmountAll } from './paste-harness';

afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

describe('a copy of the body pasted back', () => {
  it('writes none of its HTML into an element of the page', async () => {
    const { editor } = open([
      { type: 'bulletListItem', content: 'par', children: [{ type: 'bulletListItem', content: 'kid' }] },
      { type: 'paragraph', content: 'abcd' },
    ]);
    await act(async () => { await settled(); });
    const view = editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, positionOf(editor, 'par', 1), positionOf(editor, 'kid', 2))));
    const copy = view.serializeForClipboard(view.state.selection.content()).dom.innerHTML;
    const html = copy.replace('ki<', 'ki<img src="x:" onerror="window.__ran = 1"><');
    expect(html).not.toBe(copy);
    const setter = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!.set!;
    const written: string[] = [];
    vi.spyOn(Element.prototype, 'innerHTML', 'set').mockImplementation(function (this: Element, value: string) {
      if (this.ownerDocument === document && value.includes('onerror')) written.push(value);
      setter.call(this, value);
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, positionOf(editor, 'abcd', 2))));
    view.focus();
    pasteFormats(editor, { 'blocknote/html': html, 'text/html': html, 'text/plain': 'x' });
    await settled();
    expect(written).toEqual([]);
  });
});
