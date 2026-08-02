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

  it('keeps the formatting buttons on screen', () => {
    // They do nothing yet — this slice delivers the collaborative surface and
    // formatting arrives whole in the next one. Keeping them visible is what
    // lets that slice change behaviour rather than layout, so their presence is
    // the deliberate part and belongs under a test.
    render(<DocumentEditor editor={editor} history={history} />);
    for (const id of ['bold', 'italic', 'strike']) {
      expect(screen.getByTestId(`doc-tool-${id}`)).toBeInTheDocument();
    }
  });

  it('offers no control for a block type this slice does not register', () => {
    // Headings, lists and quotes are not in the schema at all here, so a button
    // for one would dispatch a command that does not exist. They arrive with
    // the marks, the block types and the body stylesheet, together.
    render(<DocumentEditor editor={editor} history={history} />);
    for (const id of ['bullet-list', 'ordered-list', 'quote', 'heading']) {
      expect(screen.queryByTestId(`doc-tool-${id}`)).toBeNull();
    }
  });

  it('changes nothing when a formatting button is clicked', async () => {
    // The product decision is that these buttons stay visible and simply do
    // not work yet — not that they go grey, which already means "you do not
    // have permission" and is what a viewer sees.
    //
    // This is the assertion that stops a half-connected button from shipping:
    // wire one of them to `toggleBold()` and it throws, because the marks are
    // switched off and StarterKit's commands go with them.
    act(() => {
      editor.commands.setContent('<p>some text</p>');
    });
    await waitFor(() => expect(textOf(fragment)).toContain('some text'));
    const before = markupOf(fragment);

    render(<DocumentEditor editor={editor} history={history} />);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      for (const id of ['bold', 'italic', 'strike']) {
        screen.getByTestId(`doc-tool-${id}`).click();
      }
    });

    expect(markupOf(fragment)).toBe(before);
  });

  describe('read-only (viewer)', () => {
    it('disables every control rather than hiding the toolbar', () => {
      // Undo and redo MUST be disabled: they are real commands, and a toolbar
      // command is a programmatic dispatch that `setEditable(false)` does not
      // stop — it would write into the shared document, the server would refuse
      // it silently, and this viewer would be left looking at a private fork.
      //
      // The formatting buttons run nothing either way; they are disabled so a
      // viewer's toolbar reads as uniformly unavailable, which is the truth
      // about their role.
      render(<DocumentEditor editor={editor} history={history} readOnly />);
      for (const id of ['undo', 'redo', 'bold', 'italic', 'strike']) {
        expect(screen.getByTestId(`doc-tool-${id}`)).toBeDisabled();
      }
    });
  });
});
