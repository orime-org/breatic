// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Media in pasted or dropped content (inner#1351 + inner#1390 design §5.4,
 * which replaces inner#1127 A18): an outside medium becomes a pending block
 * whose upload fetches it into storage, so the outside address never reaches
 * the shared document; one of ours stays as it is; one that cannot be
 * fetched (`http:` and the like) is left out and counted.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { ownMediaOnly } from '@web/spaces/document/document-external-media';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

const OURS = 'https://cdn.example/';

/** Where the body hands pasted media. */
interface Sink {
  onLeftOut: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

/**
 * Opens an editor holding one empty line, focused on it.
 * @param prefix - What our addresses start with, or null while unknown.
 * @param sink - Told how many media a paste left out, and handed each upload.
 * @returns The editor.
 */
function open(prefix: string | null, sink: Sink = { onLeftOut: vi.fn(), start: vi.fn() }): Editor {
  const editor = buildDocumentEditor({
    fragment: documentBodyFragment(new Y.Doc()),
    media: { assetUrlPrefix: () => prefix, onLeftOut: sink.onLeftOut, start: sink.start },
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

/**
 * A fresh sink.
 * @returns It.
 */
function sink(): Sink {
  return { onLeftOut: vi.fn(), start: vi.fn() };
}

/** A media block as the document holds it. */
interface Medium {
  type: string;
  url: string;
  uploadId: string;
  caption: string;
}

/**
 * Every media block in the document, nested ones included.
 * @param editor - The editor.
 * @returns Their props.
 */
function media(editor: Editor): Medium[] {
  const out: Medium[] = [];
  editor.prosemirrorView!.state.doc.descendants((node) => {
    if (['image', 'video', 'audio'].includes(node.type.name)) {
      out.push({ type: node.type.name, url: node.attrs['url'], uploadId: node.attrs['uploadId'], caption: node.attrs['caption'] });
    }
    return true;
  });
  return out;
}


/**
 * Lets a paste or a drop finish: what lands after the event, and the uploads
 * that start once it is done.
 */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('an outside medium in pasted HTML', () => {
  it('becomes a pending block in its place, with the words around it, and its upload starts from its address', async () => {
    const s = sink();
    const editor = open(OURS, s);

    editor.pasteHTML('<p>before</p><img src="https://elsewhere.example/a.png"><p>after</p>');
    await settled();

    expect(types(editor)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(text(editor)).toContain('before');
    expect(text(editor)).toContain('after');
    const [image] = media(editor);
    expect(image).toMatchObject({ url: '' });
    expect(image!.uploadId).not.toBe('');
    expect(s.start).toHaveBeenCalledExactlyOnceWith(image!.uploadId, { kind: 'address', url: 'https://elsewhere.example/a.png' });
    expect(s.onLeftOut).not.toHaveBeenCalled();
  });

  it('never reaches the shared document by its outside address', async () => {
    const editor = open(OURS);
    editor.pasteHTML('<p>x</p><img src="https://elsewhere.example/a.png">');
    await settled();
    expect(JSON.stringify(editor.document)).not.toContain('elsewhere');
  });

  it('turns every image, video and audio into a pending block of its kind', async () => {
    const s = sink();
    const editor = open(OURS, s);

    editor.pasteHTML(
      '<p>x</p><img src="https://a.example/1.png"><video src="https://a.example/2.mp4"></video><audio src="https://a.example/3.mp3"></audio>',
    );
    await settled();

    expect(media(editor).map((m) => m.type)).toEqual(['image', 'video', 'audio']);
    expect(s.start).toHaveBeenCalledTimes(3);
  });

  it('carries the caption of its figure', async () => {
    const editor = open(OURS);
    editor.pasteHTML('<figure><img src="https://a.example/1.png"><figcaption>Seen here</figcaption></figure>');
    await settled();
    expect(media(editor)[0]).toMatchObject({ caption: 'Seen here', url: '' });
  });

  it('in a Markdown paste becomes a pending block too', async () => {
    const s = sink();
    const editor = open(OURS, s);

    editor.pasteMarkdown('words\n\n![alt](https://elsewhere.example/a.png)');
    await settled();

    expect(media(editor)).toHaveLength(1);
    expect(text(editor)).toContain('words');
    expect(s.start).toHaveBeenCalledOnce();
  });

  it('nested as a row\'s child stays nested, pending', async () => {
    const source = open(OURS);
    source.replaceBlocks(source.document, [
      {
        type: 'paragraph',
        content: 'parent',
        children: [{ type: 'image', props: { url: 'https://elsewhere.example/a.png' } }],
      },
    ] as never);
    const html = await source.blocksToFullHTML(source.document);
    const editor = open(OURS);

    editor.pasteHTML(html, true);
    await settled();

    expect((editor.document[0] as { children: { type: string }[] }).children.map((c) => c.type)).toEqual(['image']);
    expect(JSON.stringify(editor.document)).not.toContain('elsewhere');
  });
});

describe('media that stay as they are', () => {
  it('a medium whose address is one of ours', async () => {
    const s = sink();
    const editor = open(OURS, s);

    editor.pasteHTML(`<p>x</p><img src="${OURS}image/2026-10-07/a.png">`);
    await settled();

    expect(media(editor)).toEqual([{ type: 'image', url: `${OURS}image/2026-10-07/a.png`, uploadId: '', caption: '' }]);
    expect(s.start).not.toHaveBeenCalled();
  });

  it('a pending block copied from a body keeps its upload id and starts nothing', async () => {
    const source = open(OURS);
    source.replaceBlocks(source.document, [{ type: 'image', props: { url: '', uploadId: 'u1', caption: 'Hero' } }] as never);
    const html = await source.blocksToFullHTML(source.document);
    const s = sink();
    const editor = open(OURS, s);

    editor.pasteHTML(html, true);
    await settled();

    expect(media(editor)).toEqual([{ type: 'image', url: '', uploadId: 'u1', caption: 'Hero' }]);
    expect(s.start).not.toHaveBeenCalled();
  });
});

describe('while our addresses are not known yet', () => {
  it('every medium with an address becomes pending, ours included, to be sorted once the prefix is in', async () => {
    const s = sink();
    const editor = open(null, s);

    editor.pasteHTML(`<p>x</p><img src="${OURS}image/2026-10-07/a.png">`);
    await settled();

    expect(media(editor)[0]).toMatchObject({ url: '' });
    expect(s.start).toHaveBeenCalledWith(expect.any(String), { kind: 'address', url: `${OURS}image/2026-10-07/a.png` });
  });
});

describe('a row dragged within the body', () => {
  it('is left as it is, even while our addresses are not known yet', async () => {
    const s = sink();
    const editor = open(null, s);
    editor.replaceBlocks(editor.document, [{ type: 'image', props: { url: `${OURS}image/2026-10-07/a.png` } }] as never);
    const view = editor.prosemirrorView!;
    const slice = view.state.doc.slice(1, view.state.doc.content.size - 1);
    view.dragging = { slice, move: true } as never;

    let out = slice;
    view.someProp('transformPasted', (transform) => {
      out = transform(out, view, false);
    });

    expect(out.content.eq(slice.content)).toBe(true);
    expect(s.start).not.toHaveBeenCalled();
  });
});

describe('a medium that cannot be fetched', () => {
  it('is left out and counted, and the words stay', async () => {
    const s = sink();
    const editor = open(OURS, s);

    editor.pasteHTML('<p>before</p><img src="http://elsewhere.example/a.png"><p>after</p>');
    await settled();

    expect(types(editor)).not.toContain('image');
    expect(text(editor)).toContain('before');
    expect(text(editor)).toContain('after');
    expect(s.onLeftOut).toHaveBeenCalledWith(1);
    expect(s.start).not.toHaveBeenCalled();
  });

  it('leaves the rows nested under it in its place', async () => {
    const source = open(OURS);
    source.replaceBlocks(source.document, [
      { type: 'paragraph', content: 'above' },
      {
        type: 'image',
        props: { url: 'http://elsewhere.example/a.png' },
        children: [{ type: 'paragraph', content: 'caption notes' }],
      },
      { type: 'paragraph', content: 'below' },
    ] as never);
    const html = await source.blocksToFullHTML(source.document);
    const s = sink();
    const editor = open(OURS, s);

    editor.pasteHTML(html, true);
    await settled();

    expect(types(editor)).not.toContain('image');
    expect(text(editor).indexOf('above')).toBeLessThan(text(editor).indexOf('caption notes'));
    expect(text(editor).indexOf('caption notes')).toBeLessThan(text(editor).indexOf('below'));
    expect(s.onLeftOut).toHaveBeenCalledWith(1);
  });
});

describe('a paste with no media in it', () => {
  it('says nothing and starts nothing', async () => {
    const s = sink();
    const editor = open(OURS, s);

    editor.pasteHTML('<p>just words</p>');
    await settled();

    expect(s.onLeftOut).not.toHaveBeenCalled();
    expect(s.start).not.toHaveBeenCalled();
  });
});

describe('blocks written from an Agent proposal (inner#1509 review round 3)', () => {
  it('keep media at our addresses, leave others out, and keep the rows nested under one left out', () => {
    const blocks = [
      { type: 'image', props: { url: `${OURS}a.png` } },
      { type: 'image', props: { url: 'https://elsewhere.example/b.png' } },
      { type: 'paragraph', content: 'Words.' },
      { type: 'video', props: { url: 'https://elsewhere.example/c.mp4' }, children: [{ type: 'paragraph', content: 'Under it.' }] },
      { type: 'bulletListItem', content: 'Item', children: [{ type: 'audio', props: { url: 'https://elsewhere.example/d.mp3' } }] },
    ];

    const got = ownMediaOnly(blocks, OURS);

    expect(got.count).toBe(3);
    expect(got.blocks.map((b) => b.type)).toEqual(['image', 'paragraph', 'paragraph', 'bulletListItem']);
    expect(got.blocks[3]?.children).toEqual([]);
  });

  it('leaves every medium out while our address is not known', () => {
    expect(ownMediaOnly([{ type: 'image', props: { url: `${OURS}a.png` } }], null)).toEqual({ blocks: [], count: 1 });
  });
});
