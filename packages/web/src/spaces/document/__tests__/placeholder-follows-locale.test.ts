// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The document's placeholder must follow a language switch.
 *
 * It is a decoration on the document's first block carrying
 * `data-block-placeholder`, recomputed only when something dispatches to the
 * editor — and switching the
 * app language dispatches nothing, it is not an edit. Without a redraw it
 * would keep whatever language was active when it was last drawn, until the
 * user clicks into the document or types.
 *
 * The canvas prompt editor does not have this problem because it takes its
 * placeholder as a prop and is rebuilt when that prop changes. This editor
 * cannot be rebuilt: the whole point of `document-editor-cache` is that the
 * editor, its undo stack and its selection survive, so the fix has to reach
 * inside a living editor rather than replace it.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { getLocale, setLocale } from '@breatic/shared';

import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';


describe('the document placeholder', () => {
  let original: ReturnType<typeof getLocale>;
  beforeEach(() => {
    original = getLocale();
  });
  afterEach(() => {
    setLocale(original);
    _resetDocumentEditorCacheForTests();
  });

  it('changes language without the user touching the document', async () => {
    setLocale('en');
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const rendered = renderHook(() =>
      useDocumentEditor({
        doc,
        name: 'project-p/document-locale',
        caretProvider: { awareness },
      }),
    );
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    const handle = rendered.result.current!;
    // On the page, because the placeholder is drawn by a plugin view and a
    // plugin view is what mounting builds.
    const container = document.createElement('div');
    document.body.appendChild(container);
    adoptDocumentEditor(handle, container);

    /** What the placeholder the first block carries currently reads. */
    const bodyPlaceholder = (): string =>
      container
        .querySelector('[data-block-placeholder]')
        ?.getAttribute('data-block-placeholder') ?? '';

    const englishBody = bodyPlaceholder();
    expect(englishBody).not.toBe('');

    act(() => setLocale('ja'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(bodyPlaceholder()).not.toBe(englishBody);
  });
});
