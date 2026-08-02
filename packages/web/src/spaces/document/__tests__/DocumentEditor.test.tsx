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
        hasEverSynced: true,
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

  it('adds undo and redo to the toolbar, and changes nothing else about it', () => {
    // This slice makes the document collaborative, and undo comes with that:
    // history lives in the shared undo manager, and a document people edit
    // together without an undo is not shippable. The formatting controls are
    // the editing feature set — a separate slice — and they are here exactly as
    // they were before.
    //
    // Asserted as the whole set rather than one membership check per button, so
    // a control quietly added or removed fails instead of slipping through the
    // gap between two positive assertions.
    render(<DocumentEditor editor={editor} history={history} />);
    const ids = Array.from(
      document.querySelectorAll('[data-testid^="doc-tool-"]'),
    ).map((el) => el.getAttribute('data-testid')?.replace('doc-tool-', ''));

    expect(ids.sort()).toEqual([
      'bold',
      'bullet-list',
      'italic',
      'ordered-list',
      'quote',
      'redo',
      'strike',
      'undo',
    ]);
  });

  describe('read-only (viewer)', () => {
    it('disables every control rather than hiding the toolbar', () => {
      // Every control, found by the same query the set assertion above uses —
      // a hard-coded list here would silently stop covering whatever gets added
      // next, and a viewer is exactly who must not reach a new control first.
      render(<DocumentEditor editor={editor} history={history} readOnly />);
      const controls = Array.from(
        document.querySelectorAll('[data-testid^="doc-tool-"]'),
      );
      expect(controls.length).toBeGreaterThan(0);
      for (const control of controls) {
        expect(control).toBeDisabled();
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
