// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The editor chrome: toolbar + body. The editor and its history come from the
 * container, so these tests drive real ones through the real user path — no
 * test-only hooks into the component.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  render,
  renderHook,
  screen,
  waitFor,
  act,
} from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import * as Y from 'yjs';

import { Awareness } from 'y-protocols/awareness';

import { resolvePaletteHex, userPaletteHue } from '@web/lib/user-color';
import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@web/spaces/document/document-yjs';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';
import {
  useDocumentHistory,
  type DocumentHistoryState,
} from '@web/spaces/document/use-document-history';

/** Reads a fragment's plain text, paragraphs joined by a newline. */
function textOf(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((node) => node.toString().replace(/<[^>]*>/g, ''))
    .join('\n');
}

/** Reads a fragment with its markup, so marks are visible. */
function markupOf(fragment: Y.XmlFragment): string {
  return fragment.toArray().map((n) => n.toString()).join('');
}

const HUE = userPaletteHue('test-user');
const CARET_USER = { name: 'Tester', color: resolvePaletteHex(HUE), hue: HUE };

describe('DocumentEditor', () => {
  const NAME = 'project-p/document-chrome';
  let doc: Y.Doc;
  let awareness: Awareness;
  let fragment: Y.XmlFragment;
  let editor: Editor;
  let history: DocumentHistoryState;

  beforeEach(async () => {
    doc = new Y.Doc();
    awareness = new Awareness(doc);
    fragment = documentBodyFragment(doc);
    const caretProvider = { awareness };
    const { result } = renderHook(() => {
      const handle = useDocumentEditor({
        doc,
        name: NAME,
        caretProvider,
        caretUser: CARET_USER,
      });
      return { handle, history: useDocumentHistory(handle?.undoManager ?? null) };
    });
    await waitFor(() => expect(result.current.handle).not.toBeNull());
    editor = result.current.handle!.editor;
    history = result.current.history;
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  it('renders the toolbar and the editor body', () => {
    render(<DocumentEditor editor={editor} history={history} />);
    expect(screen.getByTestId('document-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('document-editor-content')).toBeInTheDocument();
  });

  it('disables undo and redo while there is nothing on the stack', () => {
    render(<DocumentEditor editor={editor} history={history} />);
    expect(screen.getByTestId('doc-tool-undo')).toBeDisabled();
    expect(screen.getByTestId('doc-tool-redo')).toBeDisabled();
  });

  it('keeps the formatting toggles', () => {
    render(<DocumentEditor editor={editor} history={history} />);
    for (const id of ['bold', 'italic', 'strike']) {
      expect(screen.getByTestId(`doc-tool-${id}`)).toBeInTheDocument();
    }
  });

  it('offers no control the stylesheet cannot render yet', () => {
    // Tailwind's preflight flattens `h1`–`h6` to inherited size and weight and
    // strips `list-style` from `ol`/`ul`, so these buttons would alter the
    // document while the screen stayed identical — a control that lies about
    // having done something. They belong with the body stylesheet that makes
    // them visible. Marks are unaffected: preflight leaves `strong`, `em` and
    // `s` alone, which is why the toggles above ship now.
    render(<DocumentEditor editor={editor} history={history} />);
    for (const id of ['bullet-list', 'ordered-list', 'quote', 'heading']) {
      expect(screen.queryByTestId(`doc-tool-${id}`)).toBeNull();
    }
  });

  describe('read-only (viewer)', () => {
    it('disables every control rather than hiding the toolbar', () => {
      render(<DocumentEditor editor={editor} history={history} readOnly />);
      for (const id of ['undo', 'redo', 'bold', 'italic', 'strike']) {
        expect(screen.getByTestId(`doc-tool-${id}`)).toBeDisabled();
      }
    });

    it('does not let a viewer change the shared document from the toolbar', async () => {
      act(() => {
        editor.commands.setContent('<p>viewer text</p>');
      });
      await waitFor(() => expect(textOf(fragment)).toContain('viewer text'));
      const before = markupOf(fragment);

      render(<DocumentEditor editor={editor} history={history} readOnly />);
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 7 });
        screen.getByTestId('doc-tool-bold').click();
      });

      // Making the body non-editable only stops typing; a toolbar command is a
      // programmatic dispatch and would go straight through it, writing into
      // the shared document that the server will then refuse — leaving this
      // viewer looking at a private fork.
      expect(markupOf(fragment)).toBe(before);
    });
  });
});
