// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Two people opening the same new document leave it with one block.
 *
 * This is the failure the seeded title replaced. When each client wrote its own
 * empty paragraph on open — which it had to, because the document model refuses
 * an empty document — two clients wrote two, and the merge kept both: a
 * brand-new document with a stray blank line nobody typed. The title removes
 * the reason to write anything, and this is what says so.
 *
 * Two real editors over two real documents, merged by exchanging updates the
 * way the server does. A single client cannot show this: the second paragraph
 * only exists after the merge, so the one-client checks in
 * `no-client-side-repair` and the shape they guard are not the same thing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import * as Y from 'yjs';
import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentExtensions } from '@web/spaces/document/document-extensions';

const editors: Editor[] = [];
const docs: Y.Doc[] = [];

afterEach(() => {
  editors.splice(0).forEach((e) => {
    e.destroy();
  });
  docs.splice(0).forEach((d) => {
    d.destroy();
  });
});

/**
 * One client: a document holding the server's seed, with an editor bound to it.
 * @param seed - The bytes the backend wrote when the Space was created.
 * @returns That client's document and editor.
 */
function client(seed: Uint8Array): { doc: Y.Doc; editor: Editor } {
  const doc = new Y.Doc();
  docs.push(doc);
  Y.applyUpdate(doc, seed);
  const editor = new Editor({
    extensions: buildDocumentExtensions({ fragment: documentBodyFragment(doc) }),
  });
  editors.push(editor);
  return { doc, editor };
}

/**
 * Exchange everything each side knows, as the server does.
 * @param a - One client's document.
 * @param b - The other's.
 */
function merge(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

describe('two clients on one new document', () => {
  it('still holds exactly the title after they merge', () => {
    const seed = encodeInitialSpaceContent('document', 'Storyboard v3');
    const one = client(seed);
    const two = client(seed);

    merge(one.doc, two.doc);

    [one, two].forEach(({ doc, editor }) => {
      const body = documentBodyFragment(doc);
      expect(body.length).toBe(1);
      expect((body.get(0) as Y.XmlElement).nodeName).toBe('title');
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.child(0).textContent).toBe('Storyboard v3');
    });
  });

  it('and still does after each of them has clicked into it', () => {
    // Opening is not the only moment a client used to write: any dispatch used
    // to be able to trigger the repair. A selection change is the smallest one
    // there is.
    const seed = encodeInitialSpaceContent('document', 'Storyboard v3');
    const one = client(seed);
    const two = client(seed);

    one.editor.commands.setTextSelection(1);
    two.editor.commands.setTextSelection(1);
    merge(one.doc, two.doc);
    one.editor.commands.setTextSelection(2);
    two.editor.commands.setTextSelection(2);

    expect(documentBodyFragment(one.doc).length).toBe(1);
    expect(documentBodyFragment(two.doc).length).toBe(1);
  });

  it('and one of them typing a title does not give the other a second block', () => {
    const seed = encodeInitialSpaceContent('document', '');
    const one = client(seed);
    const two = client(seed);

    one.editor.commands.insertContentAt(1, 'Mine');
    merge(one.doc, two.doc);

    expect(documentBodyFragment(two.doc).length).toBe(1);
    expect(two.editor.state.doc.child(0).textContent).toBe('Mine');
  });
});
