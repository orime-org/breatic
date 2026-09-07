// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
 * Y.Doc does not hold — undo stack, selection, in-flight input-method
 * composition — would be lost with a component-owned editor.
 *
 * The editor is mounted here, unlike in the hook's own contract: the
 * collaboration binding is built by the sync plugin's VIEW, so an unmounted
 * editor is bound to nothing and every case below would measure a private
 * document. Mounting is what `DocumentEditor` does with what the hook returns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { TextSelection } from '@tiptap/pm/state';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  _resetDocumentEditorCacheForTests,
  adoptDocumentEditor,
  evictDocumentEditor,
  type DocumentEditorHandle,
} from '@web/spaces/document/document-editor-cache';
import {
  documentBodyFragment,
  encodeInitialSpaceContent,
} from '@breatic/shared';
import { viewOf } from '@web/spaces/document/document-editor-view';
import { useDocumentEditor } from '@web/spaces/document/use-document-editor';

/** A block, as `replaceBlocks` takes it. */
type Block = { type: string; content?: string };

/** Reads a fragment's plain text, markup stripped. */
function textOf(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((node) => node.toString().replace(/<[^>]*>/g, ''))
    .join('');
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

/**
 * Appends one paragraph block to a peer's copy of the body.
 *
 * Written at the Yjs layer because a peer is a client this test does not run:
 * what arrives over the wire is nodes, and the container plus the three
 * attributes below are what a block IS in this schema — a bare paragraph
 * pushed into the group would be a shape no client produces.
 */
function appendPeerBlock(peer: Y.Doc, text: string): void {
  const group = documentBodyFragment(peer).get(0) as Y.XmlElement;
  const container = new Y.XmlElement('blockContainer');
  container.setAttribute('id', `peer-${text.replace(/\W+/g, '-')}`);
  const paragraph = new Y.XmlElement('paragraph');
  paragraph.setAttribute('backgroundColor', 'default');
  paragraph.setAttribute('textColor', 'default');
  paragraph.setAttribute('textAlignment', 'left');
  paragraph.insert(0, [new Y.XmlText(text)]);
  container.insert(0, [paragraph]);
  group.push([container]);
}

describe('useDocumentEditor', () => {
  let doc: Y.Doc;
  let awareness: Awareness;
  const containers: HTMLElement[] = [];
  const NAME = 'project-p/document-s';

  beforeEach(() => {
    doc = new Y.Doc();
    // The shape a document has when it reaches a client: the backend seeds one
    // empty paragraph when the Space is created. An empty fragment is not a
    // safe resting state under this schema — `@breatic/shared`'s
    // `document-body` carries the two merges that measured it.
    Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
    awareness = new Awareness(doc);
  });
  afterEach(() => {
    _resetDocumentEditorCacheForTests();
    containers.splice(0).forEach((element) => {
      element.remove();
    });
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

  /**
   * Puts an editor on the page, the way the body does — a fresh container
   * each time, because a Space-tab switch builds a new one.
   */
  function show(handle: DocumentEditorHandle): void {
    const root = document.createElement('div');
    document.body.appendChild(root);
    containers.push(root);
    adoptDocumentEditor(handle, root);
  }

  /** Mounts and waits for the editor to exist, returning it on the page. */
  async function mountEditor(name = NAME): Promise<{
    rendered: ReturnType<typeof renderHook>;
    handle: DocumentEditorHandle;
    editor: DocumentEditorHandle['editor'];
  }> {
    const rendered = mount(name);
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    const handle = rendered.result.current as DocumentEditorHandle;
    show(handle);
    return { rendered, handle, editor: handle.editor };
  }

  /** Replaces the whole body with the given blocks. */
  function write(
    editor: DocumentEditorHandle['editor'],
    ...blocks: Block[]
  ): void {
    act(() => {
      editor.replaceBlocks(editor.document, blocks as never);
    });
  }

  /** The text this client currently renders. */
  function shown(editor: DocumentEditorHandle['editor']): string {
    return editor.prosemirrorState.doc.textContent;
  }

  /** How many blocks the body holds. */
  function blockCount(editor: DocumentEditorHandle['editor']): number {
    return editor.document.length;
  }

  /**
   * Where the body's first character sits.
   *
   * Derived rather than written as a number: every block is wrapped in a group
   * and a container here, so a literal would say nothing about what it points
   * at and would need re-deriving on the next structural change.
   */
  function textStart(editor: DocumentEditorHandle['editor']): number {
    let at = -1;
    editor.prosemirrorState.doc.descendants((node, pos) => {
      if (at >= 0) return false;
      if (!node.isText) return true;
      at = pos;
      return false;
    });
    return at;
  }

  describe('Yjs binding', () => {
    it('binds the editor to the document body fragment', async () => {
      const { editor } = await mountEditor();
      write(editor, { type: 'paragraph', content: 'hello' });
      expect(textOf(documentBodyFragment(doc))).toContain('hello');
    });

    it('reflects a remote peer edit in the local editor', async () => {
      const { editor } = await mountEditor();

      const peer = new Y.Doc();
      syncAsRemote(peer, doc);
      peer.transact(() => {
        appendPeerBlock(peer, 'from the other side');
      }, 'peer-origin');

      act(() => {
        syncAsRemote(doc, peer);
      });

      await waitFor(() =>
        expect(shown(editor)).toContain('from the other side'),
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
      // Opening a document is not an edit. Measured: the seed leaves nothing
      // for this client to fill in, so mounting adds no stack entry.
      const { handle } = await mountEditor();
      expect(handle.undoManager.undoStack).toHaveLength(0);
    });

    it('rolls back this client’s own edit', async () => {
      const { editor, handle } = await mountEditor();
      write(editor, { type: 'paragraph', content: 'mine' });
      await waitFor(() =>
        expect(textOf(documentBodyFragment(doc))).toContain('mine'),
      );

      act(() => {
        handle.undoManager.undo();
      });

      expect(textOf(documentBodyFragment(doc))).not.toContain('mine');
    });

    it('does not take a peer’s words out of the paragraph it shares with mine', async () => {
      // The case the "peer adds their own paragraph" test below cannot see:
      // when two people write into the SAME block, undoing my insert takes the
      // whole block unless the delete filter stops it. Measured before the
      // filter was in place: the block came back empty, the peer's text gone,
      // the deletion synced to everyone and absent from their undo stack.
      const fragment = documentBodyFragment(doc);
      const { editor, handle } = await mountEditor();

      write(editor, { type: 'paragraph', content: 'mine' });
      await waitFor(() => expect(textOf(fragment)).toContain('mine'));

      const peer = new Y.Doc();
      syncAsRemote(peer, doc);
      peer.transact(() => {
        const group = documentBodyFragment(peer).get(0) as Y.XmlElement;
        const container = group.get(0) as Y.XmlElement;
        const block = container.get(0) as Y.XmlElement;
        (block.get(0) as Y.XmlText).insert(4, ' and theirs');
      }, 'peer-origin');
      act(() => {
        syncAsRemote(doc, peer);
      });
      await waitFor(() => expect(textOf(fragment)).toContain('and theirs'));

      act(() => {
        handle.undoManager.undo();
      });

      expect(textOf(fragment)).toContain('and theirs');
      peer.destroy();
    });

    it('does NOT roll back a peer’s edit — that is the whole point', async () => {
      const fragment = documentBodyFragment(doc);
      const { editor, handle } = await mountEditor();

      // Write something local first, so there IS an entry on the stack —
      // otherwise undo is a no-op and the test passes for the wrong reason.
      write(editor, { type: 'paragraph', content: 'mine' });
      await waitFor(() => expect(textOf(fragment)).toContain('mine'));
      handle.undoManager.stopCapturing();

      const peer = new Y.Doc();
      syncAsRemote(peer, doc);
      peer.transact(() => {
        appendPeerBlock(peer, 'theirs');
      }, 'peer-origin');
      act(() => {
        syncAsRemote(doc, peer);
      });
      await waitFor(() => expect(textOf(fragment)).toContain('theirs'));

      act(() => {
        handle.undoManager.undo();
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
      const { editor, handle } = await mountEditor();

      write(editor, { type: 'paragraph', content: 'what the user wrote' });
      await waitFor(() => expect(handle.undoManager.undoStack).toHaveLength(1));
      handle.undoManager.stopCapturing();

      act(() => {
        const view = viewOf(editor)!;
        view.dispatch(
          view.state.tr
            .insertText(
              ' and what a machine appended',
              view.state.doc.content.size - 2,
            )
            .setMeta('addToHistory', false),
        );
      });
      expect(shown(editor)).toContain('what a machine appended');

      // The machine's write is in the document but not on the stack.
      expect(handle.undoManager.undoStack).toHaveLength(1);
      act(() => {
        handle.undoManager.undo();
      });
      expect(shown(editor)).not.toContain('what the user wrote');
    });

    it.each([
      ['a paragraph', [{ type: 'paragraph', content: 'the only sentence' }]],
      [
        'a bullet list',
        [
          { type: 'bulletListItem', content: 'bread' },
          { type: 'bulletListItem', content: 'eggs' },
        ],
      ],
      ['a heading', [{ type: 'heading', content: 'Title' }]],
      ['a code block', [{ type: 'codeBlock', content: 'const a = 1' }]],
      ['a checklist', [{ type: 'checkListItem', content: 'buy milk' }]],
    ])(
      'can redo after undoing away %s — the whole document',
      async (_what, blocks) => {
        // Undoing everything the user wrote has to leave a document this build
        // can represent, or the two disagree and the next dispatch reconciles
        // them as a fresh local edit — which clears the redo stack and makes
        // the undone text unrecoverable. What it leaves here is the seed's one
        // empty paragraph, which is exactly what the document opened as.
        //
        // Every block type is covered because an earlier attempt — refusing to
        // delete the document's last child — only held when that child was a
        // paragraph.
        const { editor, handle } = await mountEditor();

        write(editor, ...(blocks as Block[]));
        const written = shown(editor);
        expect(written).not.toBe('');

        act(() => {
          handle.undoManager.undo();
        });
        // Back to what the document opened as: one empty block, no text.
        expect(shown(editor)).toBe('');
        expect(blockCount(editor)).toBe(1);

        // Anything at all happening in the editor, before the user hits redo.
        act(() => {
          const view = viewOf(editor)!;
          view.dispatch(view.state.tr);
        });

        act(() => {
          handle.undoManager.redo();
        });
        expect(shown(editor)).toBe(written);
      },
    );

    it('leaves the document as it opened — nothing invented in its place', async () => {
      // Undoing several blocks takes all of them, and puts nothing of its own
      // back. The resting state is the seed's single empty paragraph; a client
      // that filled in anything else here would be writing to the shared
      // document by pressing Cmd+Z.
      const { editor, handle } = await mountEditor();
      write(
        editor,
        { type: 'paragraph', content: 'first' },
        { type: 'paragraph', content: 'second' },
        { type: 'paragraph', content: 'third' },
      );
      await waitFor(() =>
        expect(textOf(documentBodyFragment(doc))).toContain('third'),
      );

      act(() => {
        handle.undoManager.undo();
      });

      expect(shown(editor)).toBe('');
      expect(blockCount(editor)).toBe(1);
    });

    it('puts the selection back where the undone edit started', async () => {
      // Undo has to restore the selection, not just the text. Upstream hands
      // the stored selection over too late — after the restore transaction has
      // already run — so `documentUndoSelectionPlugin` steps in ahead of it.
      // That plugin recognises an undo by comparing the transaction's origin
      // against the manager it reads out of the y-undo plugin's state, which
      // makes the two having the SAME IDENTITY a requirement of the wiring.
      // Anything that hands the plugin a stand-in switches the fix off
      // silently: text still comes back, selections quietly stop doing so.
      const { editor, handle } = await mountEditor();

      write(editor, { type: 'paragraph', content: 'alpha beta gamma' });
      // Close the capture window so the deletion is its own stack entry.
      handle.undoManager.stopCapturing();

      const view = viewOf(editor)!;
      const start = textStart(editor);
      const deleted = { from: start + 6, to: start + 10 };
      // Selecting and deleting are two dispatches, as they are for a user.
      // The selection from before the edit is read off the state the DELETING
      // transaction starts from, so folding the two together would record the
      // caret from before the drag instead.
      act(() => {
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, deleted.from, deleted.to),
          ),
        );
      });
      act(() => {
        view.dispatch(view.state.tr.deleteSelection());
      });
      handle.undoManager.stopCapturing();
      expect(shown(editor)).toBe('alpha  gamma');

      // Click elsewhere first — otherwise the caret is already where it would
      // end up and the assertion proves nothing.
      act(() => {
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, start, start),
          ),
        );
      });

      act(() => {
        handle.undoManager.undo();
      });

      expect(shown(editor)).toBe('alpha beta gamma');
      const { from, to } = viewOf(editor)!.state.selection;
      expect({ from, to }).toEqual(deleted);
    });
  });

  describe('lifetime — the editor outlives the component', () => {
    it('hands back the same editor after a Space tab switch', async () => {
      const { rendered, handle, editor } = await mountEditor();
      write(editor, { type: 'paragraph', content: 'written before the switch' });
      await waitFor(() =>
        expect(handle.undoManager.undoStack.length).toBeGreaterThan(0),
      );

      // Switching Space tabs remounts the body — SpaceOutlet is keyed on the id.
      rendered.unmount();
      const { editor: second, handle: again } = await mountEditor();

      // Not merely equivalent — the SAME instance, which is what carries the
      // selection and undo stack across.
      expect(second).toBe(editor);
      expect(viewOf(second)).not.toBeNull();
      expect(again.undoManager.undoStack.length).toBeGreaterThan(0);

      act(() => {
        again.undoManager.undo();
      });
      expect(textOf(documentBodyFragment(doc))).not.toContain(
        'written before the switch',
      );
    });

    it('still records edits made after coming back', async () => {
      // A surviving editor that stopped capturing would look fine — old stack
      // intact, undo still "available" — while quietly dropping everything
      // typed from then on.
      const { rendered, handle, editor } = await mountEditor();
      write(editor, { type: 'paragraph', content: 'before switch' });
      await waitFor(() => expect(handle.undoManager.undoStack).toHaveLength(1));
      rendered.unmount();

      // Close the capture window, the way a pause in typing does; otherwise
      // yjs coalesces the two edits into one entry and the assertion below
      // would be measuring the merge rather than whether capture still works.
      handle.undoManager.stopCapturing();

      const { editor: second } = await mountEditor();
      write(second, { type: 'paragraph', content: 'after switch' });

      await waitFor(() => expect(handle.undoManager.undoStack).toHaveLength(2));
      act(() => {
        handle.undoManager.undo();
      });
      const text = textOf(documentBodyFragment(doc));
      expect(text).not.toContain('after switch');
      expect(text).toContain('before switch');
    });

    it('starts over once the tab is closed', async () => {
      // Closing a tab is the one action that DOES discard this state — the
      // Space reopens clean rather than resuming a session the user ended.
      const { rendered, handle, editor } = await mountEditor();
      write(editor, { type: 'paragraph', content: 'typed before closing' });
      await waitFor(() =>
        expect(handle.undoManager.undoStack.length).toBeGreaterThan(0),
      );
      rendered.unmount();

      evictDocumentEditor(NAME);

      const { editor: reopened, handle: fresh } = await mountEditor();
      expect(reopened).not.toBe(editor);
      // Eviction is `unmount()`, which tears the editor's view down; the one
      // that comes back has a live view of its own.
      expect(viewOf(editor)).toBeNull();
      expect(fresh.undoManager.undoStack).toHaveLength(0);
      // The text is in the Y.Doc, so it comes back; only the history went.
      expect(shown(reopened)).toContain('typed before closing');
    });

    it('keeps documents apart', async () => {
      const { editor: first } = await mountEditor('project-p/document-one');
      const { editor: second } = await mountEditor('project-p/document-two');
      expect(second).not.toBe(first);
    });
  });
});
