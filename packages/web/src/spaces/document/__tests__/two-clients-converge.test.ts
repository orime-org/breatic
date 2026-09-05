// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A22: two people writing into one document end up with the same one.
 *
 * Yjs guarantees the two Y.Docs converge. What these cases are about is the
 * layer above it: each client REBUILDS its ProseMirror document from the
 * merged Yjs state, and a client that fills in a gap of its own while doing
 * that broadcasts the fill-in as an edit. Two clients each inventing something
 * is how one document becomes two top-level groups, and the next client to
 * connect deletes one of them and broadcasts that deletion as its own.
 *
 * So the assertions are on what each client SHOWS, not only on the bytes:
 * agreeing Y.Docs with disagreeing editors is exactly the failure this is for.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { NodeSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { clearDocument } from '@web/spaces/document/document-select-all-guard';
import {
  createDocumentUndo,
} from '@web/spaces/document/document-undo-blocknote';

const live: ReturnType<typeof buildDocumentEditor>[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  live.splice(0).forEach((editor) => {
    editor.unmount();
  });
  containers.splice(0).forEach((element) => {
    element.remove();
  });
});

/**
 * One person's client, opened on their own copy of the document.
 *
 * With the undo manager the cache builds, because undo across a merge is one
 * of the things below and BlockNote's own would be a different manager with a
 * different delete filter.
 */
function open(doc: Y.Doc): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [createDocumentUndo(doc).extension],
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  editor.mount(container);
  live.push(editor);
  return editor;
}

/** Exchanges everything each side is missing, both ways. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/** A fresh document as the backend seeds it. */
function seeded(): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, encodeInitialSpaceContent('document'));
  return doc;
}

/**
 * The second person's copy, as a client that just connected receives it.
 *
 * Seeding a second Y.Doc instead would not be the same document: the two seeds
 * carry identical content under different client ids, so merging them makes
 * one document out of two independent creations — a state no pair of real
 * clients can reach, since the backend seeds once and both sides load that.
 * @param doc - The document already on the server.
 * @returns A second client's copy of it.
 */
function copyOf(doc: Y.Doc): Y.Doc {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  return other;
}

/** What this client renders, one entry per block. */
function shown(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  return (editor.document as { id: string }[]).map((block) => {
    let text = '';
    editor.prosemirrorState.doc.descendants((node) => {
      if (node.type.name === 'blockContainer' && node.attrs['id'] === block.id) {
        text = node.textContent;
        return false;
      }
      return true;
    });
    return text;
  });
}

describe('two people on one document', () => {
  it('each writing their own block ends with both blocks on both sides', () => {
    const docA = seeded();
    const docB = copyOf(docA);
    sync(docA, docB);
    const a = open(docA);
    const b = open(docB);

    a.replaceBlocks(a.document, [{ type: 'paragraph', content: 'from A' }] as never);
    b.replaceBlocks(b.document, [{ type: 'paragraph', content: 'from B' }] as never);
    sync(docA, docB);

    expect(shown(a)).toEqual(shown(b));
    expect(shown(a).join('|')).toContain('from A');
    expect(shown(a).join('|')).toContain('from B');
  });

  it('both clearing it at once ends on one empty block, still writable', () => {
    const docA = seeded();
    const docB = copyOf(docA);
    const a = open(docA);
    a.replaceBlocks(a.document, [
      { type: 'paragraph', content: 'one' },
      { type: 'paragraph', content: 'two' },
    ] as never);
    sync(docA, docB);
    const b = open(docB);

    clearDocument(a as never);
    clearDocument(b as never);
    sync(docA, docB);

    expect(shown(a)).toEqual(shown(b));
    expect(shown(a).every((text) => text === '')).toBe(true);

    a.replaceBlocks(a.document, [{ type: 'paragraph', content: 'again' }] as never);
    sync(docA, docB);
    expect(shown(b)).toEqual(shown(a));
    expect(shown(b).join('|')).toContain('again');
  });

  it('undoing a clear that swallowed a peer’s writing leaves the two agreeing', () => {
    // The worst shape: A clears while B is writing, so A's deletion takes
    // text A never saw. Undo has to leave both sides on one document —
    // whatever it restores.
    const docA = seeded();
    const docB = copyOf(docA);
    const a = open(docA);
    a.replaceBlocks(a.document, [{ type: 'paragraph', content: 'shared' }] as never);
    sync(docA, docB);
    const b = open(docB);

    b.replaceBlocks(b.document, [
      { type: 'paragraph', content: 'shared' },
      { type: 'paragraph', content: 'typed by B' },
    ] as never);
    clearDocument(a as never);
    sync(docA, docB);

    a.undo();
    sync(docA, docB);

    expect(shown(a)).toEqual(shown(b));
  });

  it('a peer deleting the block you had selected leaves you writing, not raising', () => {
    // The selection kinds restore along different paths. This is the one a
    // click on a whole block produces: the position it is rebuilt from has to
    // still hold a selectable node, and the peer who just deleted that block
    // has left neither the node nor, past the end of the shorter document,
    // the position.
    const docA = seeded();
    const docB = copyOf(docA);
    const a = open(docA);
    a.replaceBlocks(a.document, [
      { type: 'paragraph', content: 'first' },
      { type: 'paragraph', content: 'second' },
    ] as never);
    sync(docA, docB);
    const b = open(docB);

    a.transact((tr) => {
      let at = -1;
      tr.doc.descendants((node, pos) => {
        if (node.type.name === 'blockContainer' && node.textContent === 'second') {
          at = pos;
        }
        return at === -1;
      });
      tr.setSelection(NodeSelection.create(tr.doc, at));
    });

    b.replaceBlocks(b.document, [
      { type: 'paragraph', content: 'first' },
    ] as never);
    sync(docA, docB);

    expect(shown(a)).toEqual(shown(b));
    expect(shown(a).join('|')).toContain('first');

    a.replaceBlocks(a.document, [{ type: 'paragraph', content: 'still here' }] as never);
    sync(docA, docB);
    expect(shown(b).join('|')).toContain('still here');
  });
});
