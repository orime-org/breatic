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

import { DocumentEditor } from '@web/spaces/document/DocumentEditor';
import { _resetDocumentEditorCacheForTests } from '@web/spaces/document/document-editor-cache';
import { documentBodyFragment } from '@breatic/shared';
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
    // together without an undo is not shippable. The formatting controls
    // belong to the editing feature set — a separate slice — so WHAT they do
    // is untouched; three things about HOW changed, and `DocumentToolbar`
    // lists them (disabled for a viewer, subscribed state, translated labels).
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
  describe('with the caret in the title', () => {
    // The title accepts no formatting at all, so a bold button that stays lit
    // and does nothing is worse than no button: the user presses it, nothing
    // happens, and there is no way to tell whether they missed or the feature
    // is broken.
    const FORMAT_TOOLS = [
      'bold',
      'italic',
      'strike',
      'bullet-list',
      'ordered-list',
      'quote',
    ];

    /**
     * Put the caret in the title, then in the body's first block.
     * @returns Nothing; it moves the caret.
     */
    function giveTheBodyABlock(): void {
      act(() => {
        editor.commands.setContent(
          '<h1 class="doc-title">Storyboard v3</h1><p>written</p>',
        );
      });
    }

    it('every formatting button is disabled', () => {
      giveTheBodyABlock();
      act(() => {
        editor.commands.setTextSelection(2);
      });
      render(<DocumentEditor editor={editor} history={history} />);
      FORMAT_TOOLS.forEach((id) => {
        expect(screen.getByTestId(`doc-tool-${id}`)).toBeDisabled();
      });
    });

    it('and they come back the moment the caret leaves it', () => {
      giveTheBodyABlock();
      act(() => {
        editor.commands.setTextSelection(2);
      });
      render(<DocumentEditor editor={editor} history={history} />);
      expect(screen.getByTestId('doc-tool-bold')).toBeDisabled();

      act(() => {
        editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
      });
      expect(screen.getByTestId('doc-tool-bold')).not.toBeDisabled();
    });

    it('leaves undo and redo alone — they work in the title too', () => {
      // Asserted as "the caret makes no difference" rather than "undo is
      // enabled": whether there is anything to undo comes from the history
      // state, and pinning that here would test the fixture instead of the
      // rule. What must hold is that moving the caret into the title changes
      // nothing about these two.
      giveTheBodyABlock();
      render(<DocumentEditor editor={editor} history={history} />);

      act(() => {
        editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 1);
      });
      const inBody = ['undo', 'redo'].map((id) =>
        (screen.getByTestId(`doc-tool-${id}`) as HTMLButtonElement).disabled,
      );

      act(() => {
        editor.commands.setTextSelection(2);
      });
      const inTitle = ['undo', 'redo'].map((id) =>
        (screen.getByTestId(`doc-tool-${id}`) as HTMLButtonElement).disabled,
      );

      expect(inTitle).toEqual(inBody);
      // And the formatting buttons DID change, so the comparison above is not
      // passing because nothing re-rendered.
      expect(screen.getByTestId('doc-tool-bold')).toBeDisabled();
    });
  });
});
