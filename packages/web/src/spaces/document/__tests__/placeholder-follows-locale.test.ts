// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document's placeholder must follow a language switch.
 *
 * It is an attribute on the editor element carrying `data-body-placeholder`,
 * recomputed only when something dispatches to the editor — and switching the
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

import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
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
    const editor = rendered.result.current!.editor;

    /** What the placeholder attribute currently reads. */
    const bodyPlaceholder = (): string =>
      editor.view.dom.getAttribute('data-body-placeholder') ?? '';

    const englishBody = bodyPlaceholder();
    expect(englishBody).not.toBe('');

    act(() => setLocale('ja'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(bodyPlaceholder()).not.toBe(englishBody);
  });
});
