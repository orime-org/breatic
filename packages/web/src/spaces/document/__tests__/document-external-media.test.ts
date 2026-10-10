// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * inner#1127 A18: media in pasted content is kept only when its address is one
 * of ours. Anything else is left out with the words around it pasted as they
 * are, and the reader is told how many were left out.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

const OURS = 'https://cdn.example/';

/**
 * Opens an editor holding one empty line, focused on it.
 * @param prefix - What our addresses start with, or null while unknown.
 * @param onLeftOut - Told how many media a paste left out.
 * @returns The editor.
 */
function open(prefix: string | null, onLeftOut = vi.fn()): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    media: { assetUrlPrefix: () => prefix, onLeftOut },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, [{ type: 'paragraph' }] as never);
  editor.setTextCursorPosition((editor.document[0] as { id: string }).id, 'start');
  return editor;
}

/**
 * The document's block types.
 * @param editor - The editor.
 * @returns One per top-level block.
 */
function types(editor: Editor): string[] {
  return (editor.document as { type: string }[]).map((b) => b.type);
}

/**
 * The document's text.
 * @param editor - The editor.
 * @returns All the words in it.
 */
function text(editor: Editor): string {
  return editor.prosemirrorView!.state.doc.textContent;
}

describe('media in pasted HTML (A18)', () => {
  it('leaves an outside image out, keeps the words, and says one was left out', () => {
    const onLeftOut = vi.fn();
    const editor = open(OURS, onLeftOut);

    editor.pasteHTML('<p>before</p><img src="https://elsewhere.example/a.png"><p>after</p>');

    expect(types(editor)).not.toContain('image');
    expect(text(editor)).toContain('before');
    expect(text(editor)).toContain('after');
    expect(onLeftOut).toHaveBeenCalledWith(1);
  });

  it('counts every medium it leaves out', () => {
    const onLeftOut = vi.fn();
    const editor = open(OURS, onLeftOut);

    editor.pasteHTML(
      '<p>x</p><img src="https://a.example/1.png"><video src="https://a.example/2.mp4"></video><audio src="https://a.example/3.mp3"></audio>',
    );

    expect(onLeftOut).toHaveBeenCalledWith(3);
  });

  it('keeps media whose address is one of ours', () => {
    const onLeftOut = vi.fn();
    const editor = open(OURS, onLeftOut);

    editor.pasteHTML(`<p>x</p><img src="${OURS}image/2026-10-07/a.png">`);

    expect(types(editor)).toContain('image');
    expect(onLeftOut).not.toHaveBeenCalled();
  });

  it('leaves every medium out while our addresses are not yet known', () => {
    const onLeftOut = vi.fn();
    const editor = open(null, onLeftOut);

    editor.pasteHTML(`<p>x</p><img src="${OURS}image/2026-10-07/a.png">`);

    expect(types(editor)).not.toContain('image');
    expect(onLeftOut).toHaveBeenCalledWith(1);
  });

  it('leaves the image of a Markdown paste out', () => {
    const onLeftOut = vi.fn();
    const editor = open(OURS, onLeftOut);

    editor.pasteMarkdown('words\n\n![alt](https://elsewhere.example/a.png)');

    expect(types(editor)).not.toContain('image');
    expect(text(editor)).toContain('words');
    expect(onLeftOut).toHaveBeenCalledWith(1);
  });

  it('takes out an outside medium nested as a row\'s only child, and the row stays', async () => {
    const onLeftOut = vi.fn();
    const source = open(OURS);
    source.replaceBlocks(source.document, [
      {
        type: 'paragraph',
        content: 'parent',
        children: [{ type: 'image', props: { url: 'https://elsewhere.example/a.png' } }],
      },
    ] as never);
    const html = await source.blocksToFullHTML(source.document);
    const editor = open(OURS, onLeftOut);

    editor.pasteHTML(html, true);

    expect(types(editor)).not.toContain('image');
    expect(text(editor)).toContain('parent');
    expect(JSON.stringify(editor.document)).not.toContain('elsewhere');
    // No empty child row is left where the image was.
    expect((editor.document[0] as { children: unknown[] }).children).toEqual([]);
    expect(onLeftOut).toHaveBeenCalledWith(1);
  });

  it('keeps the rows nested under an outside medium, in its place', async () => {
    const onLeftOut = vi.fn();
    const source = open(OURS);
    source.replaceBlocks(source.document, [
      { type: 'paragraph', content: 'above' },
      {
        type: 'image',
        props: { url: 'https://elsewhere.example/a.png' },
        children: [{ type: 'paragraph', content: 'caption notes' }],
      },
      { type: 'paragraph', content: 'below' },
    ] as never);
    const html = await source.blocksToFullHTML(source.document);
    const editor = open(OURS, onLeftOut);

    editor.pasteHTML(html, true);

    expect(types(editor)).not.toContain('image');
    expect(text(editor)).toContain('caption notes');
    expect(text(editor).indexOf('above')).toBeLessThan(text(editor).indexOf('caption notes'));
    expect(text(editor).indexOf('caption notes')).toBeLessThan(text(editor).indexOf('below'));
    expect(onLeftOut).toHaveBeenCalledWith(1);
  });

  it('says nothing about a paste with no media in it', () => {
    const onLeftOut = vi.fn();
    const editor = open(OURS, onLeftOut);

    editor.pasteHTML('<p>just words</p>');

    expect(onLeftOut).not.toHaveBeenCalled();
  });
});
