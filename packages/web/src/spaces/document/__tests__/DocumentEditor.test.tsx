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

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import {
  getDocumentUndoManager,
  _resetDocumentUndoCacheForTests,
} from '@web/spaces/document/document-undo';
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

describe('DocumentEditor', () => {
  const NAME = 'project-p/document-chrome';
  let doc: Y.Doc;
  let fragment: Y.XmlFragment;
  let editor: Editor;
  let history: DocumentHistoryState;

  beforeEach(async () => {
    doc = new Y.Doc();
    fragment = documentBodyFragment(doc);
    const undoManager = getDocumentUndoManager(doc, NAME);
    const { result } = renderHook(() => ({
      editor: useDocumentEditor({ fragment, undoManager }),
      history: useDocumentHistory(undoManager),
    }));
    await waitFor(() => expect(result.current.editor).not.toBeNull());
    editor = result.current.editor as Editor;
    history = result.current.history;
  });
  afterEach(() => {
    _resetDocumentUndoCacheForTests();
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
    for (const id of [
      'bold',
      'italic',
      'strike',
      'bullet-list',
      'ordered-list',
      'quote',
    ]) {
      expect(screen.getByTestId(`doc-tool-${id}`)).toBeInTheDocument();
    }
  });

  describe('read-only (viewer)', () => {
    it('disables every control rather than hiding the toolbar', () => {
      render(<DocumentEditor editor={editor} history={history} readOnly />);
      for (const id of [
        'undo',
        'redo',
        'bold',
        'italic',
        'strike',
        'bullet-list',
        'ordered-list',
        'quote',
      ]) {
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
