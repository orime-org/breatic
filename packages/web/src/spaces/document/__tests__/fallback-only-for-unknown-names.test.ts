// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 S1 · S2 · S3, from the other side: what must NOT become a stand-in.
 *
 * The patched binding asks one question — is this NAME in the schema — and
 * everything else it leaves to the untouched error handler. `blocknote-
 * fallback-roundtrip` walks what happens when the answer is no. These two say
 * what happens when it is yes, and they are the cases that go wrong if the
 * question is ever widened:
 *
 * - Construction fails for reasons that have nothing to do with vocabulary.
 *   Two clients on the SAME build, each deleting a different block, merge into
 *   a `blockGroup` with no children, which the schema rejects. Answering that
 *   with a stand-in would show two fully up-to-date people "unsupported
 *   content" and stop them editing, for a document neither has lost anything
 *   from.
 * - A mark that may overlap itself is stored under a key with a hash appended,
 *   so the name in the Yjs document is not the name in the schema. Looking the
 *   raw key up would find nothing and wrap every one of them.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Mark } from '@tiptap/core';
import { createExtension } from '@blocknote/core';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { documentFallbackExtension } from '@web/spaces/document/document-unsupported-blocknote';

const mounted: ReturnType<typeof buildDocumentEditor>[] = [];
const roots: HTMLElement[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  roots.splice(0).forEach((root) => {
    root.remove();
  });
});

/**
 * Opens a client on a document, with the stand-ins registered.
 * @param doc - The Y.Doc this client holds.
 * @param extra - Extensions beyond the fallbacks.
 * @returns The editor, mounted.
 */
function open(
  doc: Y.Doc,
  extra: readonly unknown[] = [],
): ReturnType<typeof buildDocumentEditor> {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(doc),
    extensions: [documentFallbackExtension(), ...extra] as never,
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  editor.mount(root);
  mounted.push(editor);
  return editor;
}

/** Every node type this client shows, in document order. */
function typeNames(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  const out: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    out.push(node.type.name);
    return true;
  });
  return out;
}

/** Every mark name on every text node this client shows. */
function markNames(editor: ReturnType<typeof buildDocumentEditor>): string[] {
  const out: string[] = [];
  editor.prosemirrorState.doc.descendants((node) => {
    if (node.isText) {
      out.push(...node.marks.map((mark) => mark.type.name));
    }
    return true;
  });
  return out;
}

/**
 * A mark that may sit on the same text as another of its own kind.
 *
 * `blocknoteIgnore` keeps it out of `nodeToBlock`'s style lookup, the way the
 * real stand-in mark does; without it every block read back raises.
 */
const Anno = Mark.create({
  name: 'anno',
  excludes: '',
  addAttributes: () => ({ id: { default: null } }),
  renderHTML: () => ['span', { 'data-anno': '' }, 0],

  /**
   * Declares this mark absent from the style schema.
   * @param extension - The extension being asked.
   * @returns The spec addition, for this mark only.
   */
  extendMarkSchema(extension) {
    return extension.name === this.name ? { blocknoteIgnore: true } : {};
  },
});

/** The extension that registers it. */
const annoExtension = createExtension(
  () => ({ key: 'annoForTest', tiptapExtensions: [Anno] }) as never,
);

describe('what stays out of a stand-in', () => {
  it('a shape two same-version clients merged into, which repairs instead', () => {
    const seedDoc = new Y.Doc();
    const seed = open(seedDoc);
    seed.replaceBlocks(seed.document, [
      { type: 'paragraph', content: 'one' },
      { type: 'paragraph', content: 'two' },
    ] as never);
    const update = Y.encodeStateAsUpdate(seedDoc);

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    Y.applyUpdate(docA, update);
    Y.applyUpdate(docB, update);
    const clientA = open(docA);
    const clientB = open(docB);

    // Each takes a different one of the two, so between them they take both.
    clientA.removeBlocks([clientA.document[0]!] as never);
    clientB.removeBlocks([clientB.document[1]!] as never);

    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // The `blockGroup` the merge produced holds nothing, which its content
    // rule forbids. Both clients repair it to the one empty block the schema
    // requires, and neither shows a stand-in for a name both of them know.
    expect(typeNames(clientA)).toEqual([
      'blockGroup',
      'blockContainer',
      'paragraph',
    ]);
    expect(typeNames(clientB)).toEqual(typeNames(clientA));
  });

  it('an overlapping mark both builds know, stored under a hashed key', () => {
    const doc = new Y.Doc();
    const author = open(doc, [annoExtension()]);
    author.replaceBlocks(author.document, [
      { type: 'paragraph', content: 'hello' },
    ] as never);
    const view = author.prosemirrorView!;
    view.dispatch(
      view.state.tr.addMark(3, 6, view.state.schema.marks['anno']!.create({ id: 'c1' })),
    );

    // The key in the shared document is not the mark's name: an overlapping
    // mark gets a hash appended so two of them can sit on one span.
    expect(documentBodyFragment(doc).toString()).toContain('anno--');

    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    const receiver = open(other, [annoExtension()]);

    expect(markNames(receiver)).toEqual(['anno']);
  });
});
