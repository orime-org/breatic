// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The document editor's Yjs binding, its undo semantics, and its lifetime.
 *
 * Undo in a collaborative document is per-client: it must roll back what THIS
 * user did and leave everyone else's edits alone. Getting that wrong is worse
 * than having no undo at all — one person pressing Cmd+Z would silently delete
 * a paragraph someone else is still writing.
 *
 * The lifetime tests exist because the editor deliberately outlives the
 * component that renders it. A Space tab switch remounts the body, and what the
 * Y.Doc does not hold — undo stack, selection, in-flight IME composition —
 * would be lost with a component-owned editor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  _resetDocumentEditorCacheForTests,
  evictDocumentEditor,
} from '@web/spaces/document/document-editor-cache';
import {
  documentBodyFragment,
  encodeInitialSpaceContent,
} from '@breatic/shared';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

/** Reads a fragment's plain text, paragraphs joined by a newline. */
function textOf(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((node) => node.toString().replace(/<[^>]*>/g, ''))
    .join('\n');
}

/**
 * Applies `source`'s state to `target` tagged with a REMOTE origin — the shape
 * a peer's edit arrives in. The origin is what keeps it out of the local undo
 * stack, so tests must not skip it.
 */
function syncAsRemote(target: Y.Doc, source: Y.Doc): void {
  Y.applyUpdate(
    target,
    Y.encodeStateAsUpdate(source, Y.encodeStateVector(target)),
    'remote-peer',
  );
}

describe('useDocumentEditor', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  const NAME = 'project-p/document-s';

  beforeEach(() => {
    doc = new Y.Doc();
    // The shape a document has when it reaches a client: the backend wrote its
    // body when the Space was created, so it already holds one paragraph. This
    // hook no longer seeds anything, and a test that started from a body with
    // nothing in it would be exercising a state production never produces.
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    awareness = new Awareness(doc);
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    awareness.destroy();
    doc.destroy();
  });

  /** Mounts the hook with the caret wiring the editor needs to be built. */
  function mount(name = NAME): ReturnType<typeof renderHook> {
    return renderHook(() =>
      useDocumentEditor({
        doc,
        name,
        caretProvider: { awareness },
      }),
    );
  }

  /** Mounts and waits for the editor to exist, returning it. */
  async function mountEditor(name = NAME): Promise<{
    rendered: ReturnType<typeof renderHook>;
    editor: NonNullable<ReturnType<typeof useDocumentEditor>>['editor'];
  }> {
    const rendered = mount(name);
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    const handle = rendered.result.current as NonNullable<
      ReturnType<typeof useDocumentEditor>
    >;
    return { rendered, editor: handle.editor };
  }

  describe('Yjs binding', () => {
    it('binds the editor to the document body fragment', async () => {
      const { editor } = await mountEditor();
      act(() => {
        editor.commands.setContent('<p>hello</p>');
      });
      expect(textOf(documentBodyFragment(doc))).toContain('hello');
    });

    it('reflects a remote peer edit in the local editor', async () => {
      const { editor } = await mountEditor();

      const peer = new Y.Doc();
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('from the other side')]);
      peer.getXmlFragment('content').push([para]);

      act(() => syncAsRemote(doc, peer));

      await waitFor(() =>
        expect(editor.getText()).toContain('from the other side'),
      );
      peer.destroy();
    });

    it('stays absent until the caret wiring exists', () => {
      // Both the provider and the identity are baked in at construction, and
      // construction happens once — so an editor built without them would have
      // no carets for the rest of its life.
      const { result } = renderHook(() =>
        useDocumentEditor({
          doc,
          name: NAME,
          caretProvider: null,
        }),
      );
      expect(result.current).toBeNull();
    });
  });

  describe('undo is per-client', () => {
    it('starts with nothing to undo', async () => {
      const { editor } = await mountEditor();
      expect(editor.can().undo()).toBe(false);
    });

    it('rolls back this client’s own edit', async () => {
      const { editor } = await mountEditor();
      act(() => {
        editor.commands.setContent('<p>mine</p>');
      });
      await waitFor(() =>
        expect(textOf(documentBodyFragment(doc))).toContain('mine'),
      );

      act(() => {
        editor.commands.undo();
      });

      expect(textOf(documentBodyFragment(doc))).not.toContain('mine');
    });

    it('does not take a peer’s words out of the paragraph it shares with mine', async () => {
      // The case the "peer adds their own paragraph" test below cannot see:
      // when two people write into the SAME paragraph, undoing my insert takes
      // the whole paragraph unless the delete filter stops it. Measured before
      // the filter was in place: the paragraph came back empty, the peer's text
      // gone, the deletion synced to everyone and absent from their undo stack.
      const fragment = documentBodyFragment(doc);
      const { editor } = await mountEditor();

      act(() => {
        editor.commands.setContent('<p>mine</p>');
      });
      await waitFor(() => expect(textOf(fragment)).toContain('mine'));

      const peer = new Y.Doc();
      syncAsRemote(peer, doc);
      peer.transact(() => {
        const paragraph = peer.getXmlFragment('content').get(0) as Y.XmlElement;
        (paragraph.get(0) as Y.XmlText).insert(4, ' and theirs');
      }, 'peer-origin');
      act(() => syncAsRemote(doc, peer));
      await waitFor(() => expect(textOf(fragment)).toContain('and theirs'));

      act(() => {
        editor.commands.undo();
      });

      expect(textOf(fragment)).toContain('and theirs');
      peer.destroy();
    });

    it('does NOT roll back a peer’s edit — that is the whole point', async () => {
      const fragment = documentBodyFragment(doc);
      const { editor } = await mountEditor();

      // Write something local first, so there IS an entry on the stack —
      // otherwise undo is a no-op and the test passes for the wrong reason.
      act(() => {
        editor.commands.setContent('<p>mine</p>');
      });
      await waitFor(() => expect(textOf(fragment)).toContain('mine'));

      const peer = new Y.Doc();
      syncAsRemote(peer, doc);
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('theirs')]);
      peer.getXmlFragment('content').push([para]);
      act(() => syncAsRemote(doc, peer));
      await waitFor(() => expect(textOf(fragment)).toContain('theirs'));

      act(() => {
        editor.commands.undo();
      });

      expect(textOf(fragment)).not.toContain('mine');
      expect(textOf(fragment)).toContain('theirs');
      peer.destroy();
    });

    it('keeps machine-driven edits off the stack', async () => {
      // Not everything that writes to the document is the user typing. A
      // migration, a cascade after a node disappears, a normalisation pass —
      // these mark themselves `addToHistory: false`, and honouring that marker
      // is the whole job of the manager's `captureTransaction`. Without it the
      // user's next undo takes back something they never did.
      const { rendered, editor } = await mountEditor();
      const handle = rendered.result.current as NonNullable<
        ReturnType<typeof useDocumentEditor>
      >;

      act(() => {
        editor.commands.setContent('<p>what the user wrote</p>');
      });
      await waitFor(() => expect(handle.undoManager.undoStack.length).toBe(1));
      handle.undoManager.stopCapturing();

      act(() => {
        editor.view.dispatch(
          editor.view.state.tr
            .insertText(' and what a machine appended', editor.state.doc.content.size - 1)
            .setMeta('addToHistory', false),
        );
      });
      expect(editor.getText()).toContain('what a machine appended');

      // The machine's write is in the document but not on the stack.
      expect(handle.undoManager.undoStack.length).toBe(1);
      act(() => {
        editor.commands.undo();
      });
      expect(editor.getText()).not.toContain('what the user wrote');
    });

    it.each([
      ['a paragraph', '<p>the only sentence</p>'],
      ['a bullet list', '<ul><li><p>bread</p></li><li><p>eggs</p></li></ul>'],
      ['a blockquote', '<blockquote><p>quoted</p></blockquote>'],
      ['a heading', '<h1>Title</h1>'],
      ['a code block', '<pre><code>const a = 1</code></pre>'],
    ])('can redo after undoing away %s — the whole document', async (_what, html) => {
      // ProseMirror's schema requires the document to hold at least one block,
      // so its idea of "empty" is one empty paragraph. Yjs's is nothing at all.
      // Undoing the last of a document used to leave those two disagreeing, and
      // the next dispatch of any kind — a click, a window focus, the remount a
      // tab switch causes — reconciled them by writing a paragraph back. That
      // write carries the dispatch's own `addToHistory` marker, which an
      // ordinary click does not set, so yjs read it as a fresh local edit and
      // cleared the redo stack: the text was unrecoverable and Redo went dead.
      //
      // Seeding the body makes the two agree from the start, so there is
      // nothing to reconcile. Every block type is covered because an earlier
      // attempt — refusing to delete the body's last child — only held when
      // that child was a paragraph: an empty blockquote or list violates the
      // schema and the binding deletes it anyway, and an empty heading is
      // legal but still leaves ProseMirror a paragraph to write back.
      const { editor } = await mountEditor();

      act(() => {
        editor.commands.setContent(html);
      });
      const written = editor.getText();
      expect(written.length).toBeGreaterThan(0);

      act(() => {
        editor.commands.undo();
      });
      expect(editor.getText().trim()).toBe('');

      // Anything at all happening in the editor, before the user hits redo.
      act(() => {
        editor.view.dispatch(editor.view.state.tr);
      });

      act(() => {
        editor.commands.redo();
      });
      expect(editor.getText()).toBe(written);
    });

    it('can redo after undoing away the last of the document', async () => {
      // Undoing the only paragraph used to empty the Y fragment outright.
      // ProseMirror's schema requires at least one block, so its document kept
      // an empty paragraph the fragment no longer had — and the next dispatch
      // of any kind (a click, a window focus, a remount) synced that paragraph
      // back as a fresh local edit on a tracked origin. yjs clears the redo
      // stack for any tracked non-undoing transaction, so the undone text
      // became unrecoverable and the redo button went dead. Measured before
      // the fix: undo 0 / redo 1 became undo 1 / redo 0 with nothing to redo.
      const { editor } = await mountEditor();

      act(() => {
        editor.commands.setContent('<p>the only sentence</p>');
      });
      await waitFor(() =>
        expect(textOf(documentBodyFragment(doc))).toContain('the only sentence'),
      );

      act(() => {
        editor.commands.undo();
      });
      expect(editor.getText()).toBe('');

      // Anything at all happening in the editor, before the user hits redo.
      act(() => {
        editor.view.dispatch(editor.view.state.tr);
      });

      act(() => {
        editor.commands.redo();
      });
      expect(editor.getText()).toBe('the only sentence');
    });

    it('leaves a single empty block behind rather than nothing', async () => {
      // The other half of the fix: what undo leaves in Yjs has to be something
      // ProseMirror can represent, or the two disagree and the next dispatch
      // reconciles them as a user edit. One empty paragraph is exactly what an
      // empty ProseMirror document is, so the two now agree and no write-back
      // happens. Undoing several paragraphs still collapses to one.
      const { editor } = await mountEditor();
      act(() => {
        editor.commands.setContent('<p>first</p><p>second</p><p>third</p>');
      });
      await waitFor(() =>
        expect(textOf(documentBodyFragment(doc))).toContain('third'),
      );

      act(() => {
        editor.commands.undo();
      });

      const fragment = documentBodyFragment(doc);
      expect(fragment.length).toBe(1);
      expect(fragment.toArray().map(String).join('')).toBe(
        '<paragraph></paragraph>',
      );
      expect(editor.getText()).toBe('');
    });

    it('puts the selection back where the undone edit started', async () => {
      // Undo has to restore the selection, not just the text. Upstream hands
      // the stored selection over too late — after the restore transaction has
      // already run — so `CollabUndoSelection` steps in ahead of it. That
      // extension recognises an undo by comparing the transaction's origin
      // against the manager it reads out of the y-undo plugin's state, which
      // makes the two having the SAME IDENTITY a requirement of the wiring.
      // Anything that hands the plugin a stand-in switches the fix off
      // silently: text still comes back, selections quietly stop doing so.
      const { rendered, editor } = await mountEditor();
      const handle = rendered.result.current as NonNullable<
        ReturnType<typeof useDocumentEditor>
      >;

      act(() => {
        editor.commands.setContent('<p>alpha beta gamma</p>');
      });
      // Close the capture window so the deletion is its own stack entry.
      handle.undoManager.stopCapturing();

      act(() => {
        editor.commands.setTextSelection({ from: 7, to: 11 });
        editor.commands.deleteSelection();
      });
      handle.undoManager.stopCapturing();
      expect(editor.getText()).toBe('alpha  gamma');

      // Click elsewhere first — otherwise the caret is already where it would
      // end up and the assertion proves nothing.
      act(() => {
        editor.commands.setTextSelection({ from: 1, to: 1 });
      });

      act(() => {
        editor.commands.undo();
      });

      expect(editor.getText()).toBe('alpha beta gamma');
      const { from, to } = editor.view.state.selection;
      expect({ from, to }).toEqual({ from: 7, to: 11 });
    });
  });

  describe('lifetime — the editor outlives the component', () => {
    it('hands back the same editor after a Space tab switch', async () => {
      const { rendered, editor } = await mountEditor();
      act(() => {
        editor.commands.setContent('<p>written before the switch</p>');
      });
      await waitFor(() => expect(editor.can().undo()).toBe(true));

      // Switching Space tabs remounts the body — SpaceOutlet is keyed on the id.
      rendered.unmount();
      const { editor: second } = await mountEditor();

      // Not merely equivalent — the SAME instance, which is what carries the
      // selection and undo stack across.
      expect(second).toBe(editor);
      expect(second.isDestroyed).toBe(false);
      expect(second.can().undo()).toBe(true);

      act(() => {
        second.commands.undo();
      });
      expect(textOf(documentBodyFragment(doc))).not.toContain(
        'written before the switch',
      );
    });

    it('still records edits made after coming back', async () => {
      // A surviving editor that stopped capturing would look fine — old stack
      // intact, undo still "available" — while quietly dropping everything
      // typed from then on.
      const { rendered, editor } = await mountEditor();
      const handle = rendered.result.current as NonNullable<
        ReturnType<typeof useDocumentEditor>
      >;
      act(() => {
        editor.commands.setContent('<p>before switch</p>');
      });
      await waitFor(() => expect(handle.undoManager.undoStack.length).toBe(1));
      rendered.unmount();

      // Close the capture window, the way a pause in typing does; otherwise
      // yjs coalesces the two edits into one entry and the assertion below
      // would be measuring the merge rather than whether capture still works.
      handle.undoManager.stopCapturing();

      const { editor: second } = await mountEditor();
      act(() => {
        second.commands.setContent('<p>after switch</p>');
      });

      await waitFor(() =>
        expect(handle.undoManager.undoStack.length).toBe(2),
      );
      act(() => {
        second.commands.undo();
      });
      const text = textOf(documentBodyFragment(doc));
      expect(text).not.toContain('after switch');
      expect(text).toContain('before switch');
    });

    it('starts over once the tab is closed', async () => {
      // Closing a tab is the one action that DOES discard this state — the
      // Space reopens clean rather than resuming a session the user ended.
      const { rendered, editor } = await mountEditor();
      act(() => {
        editor.commands.setContent('<p>typed before closing</p>');
      });
      await waitFor(() => expect(editor.can().undo()).toBe(true));
      rendered.unmount();

      evictDocumentEditor(NAME);

      const { editor: reopened } = await mountEditor();
      expect(reopened).not.toBe(editor);
      expect(editor.isDestroyed).toBe(true);
      expect(reopened.can().undo()).toBe(false);
      // The text is in the Y.Doc, so it comes back; only the history went.
      expect(reopened.getText()).toContain('typed before closing');
    });

    it('keeps documents apart', async () => {
      const { editor: first } = await mountEditor('project-p/document-one');
      const { editor: second } = await mountEditor('project-p/document-two');
      expect(second).not.toBe(first);
    });
  });
});
