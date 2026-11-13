// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1423 A13: an inline formula's box stays open while a collaborator
 * edits elsewhere.
 *
 * The box belongs to the formula's own node view, which a collaborator's edit
 * elsewhere only moves; what the user types in it reaches the collaborator.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import * as Y from 'yjs';

import { documentBodyFragment, encodeInitialSpaceContent } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
  document.body.innerHTML = '';
});

/**
 * A body mounted on a document.
 * @param doc - The shared document.
 * @returns The editor and its element.
 */
function mount(doc: Y.Doc): { editor: Editor; root: HTMLElement } {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(doc) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  return { editor, root };
}

/**
 * Two documents that pass every update to each other.
 * @returns The pair.
 */
function linked(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  Y.applyUpdate(a, encodeInitialSpaceContent('document'));
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'b') Y.applyUpdate(b, update, 'a');
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'a') Y.applyUpdate(a, update, 'b');
  });
  return [a, b];
}

/**
 * The inline formula's source.
 * @param editor - The editor.
 * @returns It.
 */
function source(editor: Editor): string {
  let text = '';
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (node.type.name === 'math') text = String(node.attrs['source']);
    return text === '';
  });
  return text;
}

describe('an open inline formula while a collaborator types elsewhere (A13)', () => {
  it.each([
    ['earlier in the same line', [{ type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a+b' } }, ' y'] }]],
    [
      'in the line above',
      [
        { type: 'paragraph', content: 'above' },
        { type: 'paragraph', content: ['x ', { type: 'math', props: { source: 'a+b' } }, ' y'] },
      ],
    ],
  ])('stays open when the collaborator types %s, and what the user types goes on into its source', async (_where, blocks) => {
    const [a, b] = linked();
    const user = mount(a);
    const peer = mount(b);
    user.editor.replaceBlocks(user.editor.document, blocks as never);
    const face = await vi.waitFor(() => {
      const found = user.root.querySelector<HTMLElement>('.katex');
      if (found === null) throw new Error('not drawn yet');
      return found;
    });
    fireEvent.mouseDown(face);
    const field = await vi.waitFor(() => {
      const found = user.root.querySelector<HTMLTextAreaElement>('[data-formula-box] textarea');
      if (found === null) throw new Error('not open yet');
      return found;
    });

    const peerView = peer.editor.prosemirrorView!;
    peerView.dispatch(peerView.state.tr.insertText('ZZZ', 3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.change(field, { target: { value: 'a+bc' } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(user.root.querySelector('[data-formula-box] textarea')).toBe(field);
    expect(source(user.editor)).toBe('a+bc');
    expect(source(peer.editor)).toBe('a+bc');
  });
});
