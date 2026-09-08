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

import { TextSelection } from '@tiptap/pm/state';

import { getLocale, setLocale, t } from '@breatic/shared';

import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

/** The five the product ships. */
const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko'] as const;

/**
 * Opens a document editor on the page, in one language.
 * @param locale - Which language to open in.
 * @param name - The document's name, unique per case so the cache is not shared.
 * @returns The handle and the element it was mounted into.
 */
async function openOn(
  locale: (typeof LOCALES)[number],
  name: string,
): Promise<{ handle: DocumentEditorHandle; container: HTMLElement }> {
  setLocale(locale);
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const rendered = renderHook(() =>
    useDocumentEditor({ doc, name, caretProvider: { awareness } }),
  );
  await waitFor(() => expect(rendered.result.current).not.toBeNull());
  const handle = rendered.result.current!;
  const container = document.createElement('div');
  document.body.appendChild(container);
  adoptDocumentEditor(handle, container);
  return { handle, container };
}


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

  it('reads in each of the five languages', async () => {
    const { container } = await openOn('en', 'project-p/document-five');
    const placeholder = (): string =>
      container
        .querySelector('[data-block-placeholder]')
        ?.getAttribute('data-block-placeholder') ?? '';

    const seen = new Map<string, string>();
    for (const locale of LOCALES) {
      act(() => setLocale(locale));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const text = placeholder();
      expect(text, `${locale} draws a placeholder`).not.toBe('');
      // The dictionary this locale supplies, not merely "something else than
      // the last one": five locales each showing a different wrong string
      // would satisfy an inequality.
      expect(text, `${locale} draws its own`).toBe(
        t('spaces.document.placeholder'),
      );
      seen.set(locale, text);
    }
    // And five distinct strings, which is what says the switch reached the
    // decoration each time rather than once.
    expect(new Set(seen.values()).size).toBe(LOCALES.length);
  });

  it('keeps the editor, its undo stack and its selection across a switch', async () => {
    // What the language switch must not cost (user 2026-09-02): rebuilding
    // the editor throws away the undo stack, the selection and the IME
    // composition state, and the reader is mid-sentence when they switch.
    const { handle, container } = await openOn('en', 'project-p/document-keep');
    const editorBefore = handle.editor;

    handle.editor.replaceBlocks(handle.editor.document, [
      { type: 'paragraph', content: 'something worth keeping' },
    ] as never);
    const view = handle.editor.prosemirrorView!;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 3, 7)),
    );
    const depthBefore = handle.undoManager.undoStack.length;
    const selectionBefore = {
      from: view.state.selection.from,
      to: view.state.selection.to,
    };
    expect(depthBefore).toBeGreaterThan(0);

    act(() => setLocale('ja'));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(handle.editor, 'the same editor instance').toBe(editorBefore);
    expect(handle.undoManager.undoStack).toHaveLength(depthBefore);
    const after = handle.editor.prosemirrorView!.state.selection;
    expect({ from: after.from, to: after.to }).toEqual(selectionBefore);
    expect(container.textContent).toContain('something worth keeping');
  });
});
