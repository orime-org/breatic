// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Handing a picture, a video or an audio block to the Agent, and telling the
 * Agent which blocks carry comments it cannot write back (inner#1316 §5.4,
 * §5.5).
 *
 * The media goes over as itself: a media attachment the way a file the user
 * uploads into the chat goes, with the block's full name and caption in its
 * snapshot. The handle menu hands over the whole row, so rows nested under
 * the media follow as text. A rewrite of a block whose media carries a
 * comment loses the comment's place, which `lossy` says.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentBodyFragment } from '@breatic/shared';

import { buildDocumentEditor } from '@web/spaces/document/build-document-editor';
import { readTopBlocks } from '@web/spaces/document/document-blocks-read';
import { mediaItem, mediaRowItems } from '@web/spaces/document/document-to-agent';

type Editor = ReturnType<typeof buildDocumentEditor>;

const mounted: Editor[] = [];

afterEach(() => {
  mounted.splice(0).forEach((editor) => {
    editor.unmount();
  });
});

/**
 * Mounts an editor over a body.
 * @param blocks - The body.
 * @returns The editor.
 */
function open(blocks: unknown[]): Editor {
  const editor = buildDocumentEditor({ fragment: documentBodyFragment(new Y.Doc()), extensions: [] });
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  mounted.push(editor);
  editor.replaceBlocks(editor.document, blocks as never);
  return editor;
}

const LONG = 'Screenshot 2026-11-10 at 14.32.11 (2) final cut.png';

describe('mediaItem', () => {
  it('hands a picture over as a picture, with its address, name and caption', () => {
    const editor = open([{ id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png', caption: 'dawn' } }]);

    expect(mediaItem(editor as never, 'pic')).toEqual({
      id: 'document-media-pic',
      name: 'a.png',
      type: 'image',
      status: 'ready',
      chip: {
        id: 'document-media-pic',
        type: 'image',
        name: 'a.png',
        data_snapshot: { url: 'https://cdn.test/a.png', name: 'a.png', caption: 'dawn' },
      },
    });
  });

  it('names a nameless video by its caption and leaves the empty name out of the snapshot', () => {
    const editor = open([{ id: 'v', type: 'video', props: { url: 'https://cdn.test/v.mp4', name: '', caption: 'ride' } }]);

    const item = mediaItem(editor as never, 'v');

    expect(item.name).toBe('ride');
    expect(item.chip).toEqual({ id: 'document-media-v', type: 'video', name: 'ride', data_snapshot: { url: 'https://cdn.test/v.mp4', caption: 'ride' } });
  });

  it('names an audio block with neither name nor caption by its kind', () => {
    const editor = open([{ id: 's', type: 'audio', props: { url: 'https://cdn.test/s.mp3', name: '', caption: '' } }]);

    const item = mediaItem(editor as never, 's');

    expect(item.name).toBe('Audio');
    expect(item.chip?.data_snapshot).toEqual({ url: 'https://cdn.test/s.mp3' });
  });

  it('cuts a long name for the tray and keeps the whole name for the Agent', () => {
    const editor = open([{ id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: LONG, caption: '' } }]);

    const item = mediaItem(editor as never, 'pic');

    expect(item.name).toBe(LONG.slice(0, 40));
    expect(item.chip?.data_snapshot).toEqual({ url: 'https://cdn.test/a.png', name: LONG });
  });

  it('names a nameless picture by the start of a long caption and keeps the whole caption for the Agent', () => {
    const caption = `${LONG} — the bakery at the corner, seen from across the road at dawn`;
    const editor = open([{ id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: '', caption } }]);

    const item = mediaItem(editor as never, 'pic');

    expect(item.name).toBe(caption.slice(0, 40));
    expect(item.chip?.data_snapshot).toEqual({ url: 'https://cdn.test/a.png', caption });
  });
});

describe('mediaRowItems', () => {
  it('hands the media alone when nothing is nested under it', () => {
    const editor = open([{ id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } }]);

    expect(mediaRowItems(editor as never, 'pic').map((item) => item.id)).toEqual(['document-media-pic']);
  });

  it('hands the rows nested under the media as text after it', () => {
    const editor = open([
      {
        id: 'v',
        type: 'video',
        props: { url: 'https://cdn.test/v.mp4', name: 'ride.mp4' },
        children: [{ id: 'n', type: 'paragraph', content: 'Shot 2: slow down at the corner.' }],
      },
    ]);

    const items = mediaRowItems(editor as never, 'v');

    expect(items.map((item) => item.id)).toEqual(['document-media-v', 'document-block-v']);
    expect(items[1]).toMatchObject({
      type: 'text',
      name: 'Shot 2: slow down at the corner.',
      chip: { type: 'text', data_snapshot: { text: 'Shot 2: slow down at the corner.' } },
    });
  });
});

describe('readTopBlocks and comments on media', () => {
  it('marks a block lossy when its audio carries a comment, and leaves others alone', () => {
    const editor = open([
      { id: 's', type: 'audio', props: { url: 'https://cdn.test/s.mp3', name: 'sea.mp3' } },
      { id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } },
    ]);

    const blocks = readTopBlocks(editor as never, new Set(['s']));

    expect(blocks.map((block) => [block.id, block.lossy])).toEqual([['s', true], ['pic', false]]);
  });

  it('marks a top-level block lossy when the commented media sits nested under it', () => {
    const editor = open([
      {
        id: 'top',
        type: 'paragraph',
        content: 'Shot 1',
        children: [{ id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' } }],
      },
    ]);

    expect(readTopBlocks(editor as never, new Set(['pic']))[0]!.lossy).toBe(true);
    expect(readTopBlocks(editor as never, new Set())[0]!.lossy).toBe(false);
  });
});

describe('a name cut where an emoji stands', () => {
  it('keeps the emoji whole when it straddles the cut, so the name stays storable text', () => {
    const name = `${'x'.repeat(39)}😀 and the rest`;
    const editor = open([{ id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name, caption: '' } }]);

    const item = mediaItem(editor as never, 'pic');

    expect(item.name).toBe(`${'x'.repeat(39)}😀`);
    expect(item.name.isWellFormed()).toBe(true);
  });
});

describe('a media row whose nested rows hold nothing', () => {
  it('hands the media alone, with no empty text after it', () => {
    const editor = open([
      { id: 'pic', type: 'image', props: { url: 'https://cdn.test/a.png', name: 'a.png' }, children: [{ id: 'e', type: 'paragraph', content: '' }] },
    ]);

    expect(mediaRowItems(editor as never, 'pic').map((item) => item.id)).toEqual(['document-media-pic']);
  });
});
