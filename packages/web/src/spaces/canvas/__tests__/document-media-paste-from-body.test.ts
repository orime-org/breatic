// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * What the body really writes for a copy, read by the canvas (inner#1537
 * §5.1): the outside HTML comes from the document editor itself, so a change
 * to how the body exports media shows up here.
 */

import { TextSelection } from '@tiptap/pm/state';
import { selectedFragmentToHTML } from '@blocknote/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { documentMediaPaste } from '@web/spaces/canvas/document-media-paste';
import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

const IMAGE = 'https://resource-dev.breatic.cc/image/2026-11-09/1794210905555_00437bfa-c5ba-4459-b2cc-29b7ce08db28.png';
const VIDEO = 'https://resource-dev.breatic.cc/video/2026-11-09/1794220319994_ebf3bd7f-0e1c-4e0e-af7a-6e5934da03bf.webm';

/**
 * Opens a body holding these blocks.
 * @param blocks - The blocks.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()) });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

/**
 * The outside HTML of a selection from the end of the first block's text to
 * the start of the last block's text, the way a drag across media selects.
 * @param editor - The editor.
 * @returns The HTML a copy writes.
 */
function copyBetweenEnds(editor: Editor): string {
  const view = editor.prosemirrorView!;
  const { doc } = view.state;
  const texts: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) texts.push(pos);
  });
  const first = doc.resolve(texts[0]! + 1);
  const last = texts.at(-1)! + 1;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, first.end(), last)));
  return selectedFragmentToHTML(view, editor).externalHTML;
}

describe('the body copied onto the canvas', () => {
  it('reads two media between a heading and a paragraph as two media', () => {
    const editor = open([
      { type: 'heading', props: { level: 2 }, content: 'Shots' },
      { type: 'image', props: { url: IMAGE, name: 'probe.png' } },
      { type: 'video', props: { url: VIDEO, name: 'probe.webm' } },
      { type: 'paragraph', content: 'After' },
    ]);
    expect(documentMediaPaste(copyBetweenEnds(editor))?.media).toEqual([
      { type: 'image', url: IMAGE, name: 'probe.png' },
      { type: 'video', url: VIDEO, name: 'probe.webm' },
    ]);
  });

  it('names a captioned picture after its caption', () => {
    const editor = open([
      { type: 'paragraph', content: '' },
      { type: 'image', props: { url: IMAGE, name: 'probe.png', caption: 'Opening shot' } },
      { type: 'paragraph', content: '' },
    ]);
    expect(documentMediaPaste(copyBetweenEnds(editor))?.media).toEqual([
      { type: 'image', url: IMAGE, name: 'Opening shot' },
    ]);
  });

  it('leaves words copied with a picture to the text paste', () => {
    const editor = open([
      { type: 'paragraph', content: 'Words' },
      { type: 'image', props: { url: IMAGE, name: 'probe.png' } },
      { type: 'paragraph', content: 'More' },
    ]);
    const view = editor.prosemirrorView!;
    const { doc } = view.state;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)));
    expect(documentMediaPaste(selectedFragmentToHTML(view, editor).externalHTML)).toBeNull();
  });
});
