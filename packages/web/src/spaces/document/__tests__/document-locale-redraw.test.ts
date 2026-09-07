// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A18 的语言那半: the hint follows a language switch.
 *
 * Decorations are recomputed only when something dispatches to the editor, and
 * switching the app language dispatches nothing — it is not an edit. Without a
 * redraw the hint keeps whatever language was active when it was last drawn,
 * until the user clicks into the body or types.
 *
 * The canvas prompt editor does not need this: it takes its placeholder as a
 * prop and is rebuilt when the prop changes. This editor cannot be rebuilt —
 * `document-editor-cache` exists so that the editor, its undo stack and its
 * selection survive a Space-tab switch — so the language has to reach inside a
 * living editor.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment, getLocale, setLocale } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentPlaceholderExtension } from '@web/spaces/document/document-placeholders-blocknote';
import { documentLocaleRedrawExtension } from '@web/spaces/document/document-locale-redraw';

const HINT_ATTRIBUTE = 'data-block-placeholder';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];

/**
 * Opens an editor showing the hint, with the redraw registered.
 * @returns The element it rendered into.
 */
function open(): {
  root: HTMLElement;
  editor: ReturnType<typeof buildDocumentEditor>;
  } {
  const doc = new Y.Doc();
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [
      documentPlaceholderExtension(),
      documentLocaleRedrawExtension(),
    ],
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph' }] as never);
  return { root, editor };
}

/** The hint text currently painted. */
function hint(root: HTMLElement): string {
  return (
    root.querySelector(`[${HINT_ATTRIBUTE}]`)?.getAttribute(HINT_ATTRIBUTE) ??
    ''
  );
}

describe('the hint on a living editor', () => {
  let original: ReturnType<typeof getLocale>;

  beforeEach(() => {
    original = getLocale();
  });

  afterEach(() => {
    setLocale(original);
    mounted.splice(0).forEach((editor) => {
      editor.unmount();
    });
  });

  it('changes language without the user touching the document', () => {
    setLocale('en');
    const { root } = open();
    const english = hint(root);
    expect(english).not.toBe('');

    setLocale('ja');

    expect(hint(root)).not.toBe(english);
    expect(hint(root)).not.toBe('');
  });

  it('stops listening once the editor is gone', () => {
    // A listener that outlives its view is a listener the locale bus keeps
    // calling, holding a torn-down editor alive and dispatching into it. It
    // does not throw, so the only way to see it is to watch the view.
    setLocale('en');
    const { editor } = open();
    const view = editor.prosemirrorView!;
    const dispatch = vi.spyOn(view, 'dispatch');

    mounted.splice(0).forEach((open_) => {
      open_.unmount();
    });
    dispatch.mockClear();

    setLocale('ja');

    expect(dispatch).not.toHaveBeenCalled();
  });
});
