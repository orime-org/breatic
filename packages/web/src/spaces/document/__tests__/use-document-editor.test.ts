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
  seedEmptyBody,
} from '@web/spaces/document/document-yjs';
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

const CARET_USER = { id: 'u' };

describe('useDocumentEditor', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  const NAME = 'project-p/document-s';

  beforeEach(() => {
    doc = new Y.Doc();
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
        caretUser: CARET_USER,
        hasEverSynced: true,
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

    it('waits for the content to arrive before seeding the body', async () => {
      // A body can be empty for two very different reasons: the document is
      // genuinely new, or it simply has not loaded yet. Seeding the second one
      // adds a paragraph the server's real content then merges in behind,
      // leaving a stray blank line at the top of everyone's document. Measured,
      // not theorised — which is why the seed is gated rather than run on mount.
      const rendered = renderHook(() =>
        useDocumentEditor({
          doc,
          name: NAME,
          caretProvider: { awareness },
          caretUser: CARET_USER,
          hasEverSynced: false,
        }),
      );
      await waitFor(() => expect(rendered.result.current).not.toBeNull());
      expect(documentBodyFragment(doc).length).toBe(0);

      // The server's content lands, and only then does the gate open.
      const peer = new Y.Doc();
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [new Y.XmlText('content that already existed')]);
      peer.getXmlFragment('content').push([para]);
      act(() => syncAsRemote(doc, peer));

      rendered.rerender();
      const fragment = documentBodyFragment(doc);
      expect(fragment.length).toBe(1);
      expect(textOf(fragment)).toBe('content that already existed');
      peer.destroy();
    });

    it('seeds when the content arrives, not only when it was already there', async () => {
      // THE production path for seeding, and the only one: seeding applies to a
      // document nobody has opened before, and the first client to open one
      // necessarily mounts before its content has arrived. So the flag turns
      // true UNDERNEATH a mounted hook; it is never true at mount on the path
      // that matters. (Later opens do mount with it already true — the latch is
      // kept with the document in the provider registry — but by then the body
      // has a paragraph and seeding is a no-op.)
      //
      // Every other seeding case here starts at `hasEverSynced: true`, which
      // means dropping the flag from the effect's dependencies leaves them all
      // green while new documents silently stop being seeded — and an unseeded
      // document is the redo-stack-destroying data loss this whole mechanism
      // exists to prevent.
      const rendered = renderHook(
        ({ hasEverSynced }: { hasEverSynced: boolean }) =>
          useDocumentEditor({
            doc,
            name: NAME,
            caretProvider: { awareness },
            caretUser: CARET_USER,
            hasEverSynced,
          }),
        { initialProps: { hasEverSynced: false } },
      );
      await waitFor(() => expect(rendered.result.current).not.toBeNull());
      expect(documentBodyFragment(doc).length).toBe(0);

      // The socket syncs and reports an empty document — it really is new.
      act(() => rendered.rerender({ hasEverSynced: true }));

      const fragment = documentBodyFragment(doc);
      expect(fragment.length).toBe(1);
      expect(textOf(fragment)).toBe('');
    });

    it('seeds when a viewer is promoted, not only when they arrived writable', async () => {
      // The same trap on the other gate: every other read-only case starts at
      // `editable: true`, so dropping `editable` from the dependencies would
      // leave a promoted viewer on an unseeded document for the rest of the
      // session.
      const rendered = renderHook(
        ({ editable }: { editable: boolean }) =>
          useDocumentEditor({
            doc,
            name: NAME,
            caretProvider: { awareness },
            caretUser: CARET_USER,
            hasEverSynced: true,
            editable,
          }),
        { initialProps: { editable: false } },
      );
      await waitFor(() => expect(rendered.result.current).not.toBeNull());
      expect(documentBodyFragment(doc).length).toBe(0);

      act(() => rendered.rerender({ editable: true }));

      expect(documentBodyFragment(doc).length).toBe(1);
    });

    it('does not seed from a read-only client', async () => {
      // A viewer has no business writing to the shared document, and the
      // server agrees: hocuspocus drops updates from a read-only connection.
      // The write is therefore not merely impolite, it is one-sided — this
      // client ends up a paragraph ahead of everyone else for the rest of the
      // session, which is the stray-blank-line symptom the seed exists to
      // prevent, arriving through the door the sync gate does not watch.
      const rendered = renderHook(() =>
        useDocumentEditor({
          doc,
          name: NAME,
          caretProvider: { awareness },
          caretUser: CARET_USER,
          hasEverSynced: true,
          editable: false,
        }),
      );
      await waitFor(() => expect(rendered.result.current).not.toBeNull());
      expect(documentBodyFragment(doc).length).toBe(0);
    });

    it('seeds once and leaves an existing body alone', async () => {
      const { editor } = await mountEditor();
      const fragment = documentBodyFragment(doc);
      expect(fragment.length).toBe(1);

      act(() => {
        editor.commands.setContent('<p>first</p><p>second</p>');
      });
      const before = fragment.length;
      // Re-running the seed must not append to a body that already has content.
      seedEmptyBody(doc);
      expect(fragment.length).toBe(before);
    });

    it('does not put the seeded paragraph on the undo stack', async () => {
      // The seed is not something the user did, so undo must never take it
      // back — doing so would empty the body and reopen the very hole seeding
      // exists to close.
      const { rendered, editor } = await mountEditor();
      const handle = rendered.result.current as NonNullable<
        ReturnType<typeof useDocumentEditor>
      >;
      expect(handle.undoManager.undoStack.length).toBe(0);
      expect(editor.can().undo()).toBe(false);
      expect(documentBodyFragment(doc).length).toBe(1);
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
          caretUser: CARET_USER,
          hasEverSynced: true,
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
