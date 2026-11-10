// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import { MAX_NODE_NAME_LEN } from '@breatic/shared';

import { batchLayoutAt } from '@web/spaces/canvas/drop-layout';
import { documentMediaPaste, documentMediaPayload } from '@web/spaces/canvas/document-media-paste';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';
import { centerToTopLeft } from '@web/spaces/canvas/node-factory';

const HOST = 'https://resource-dev.breatic.cc';
const IMAGE = `${HOST}/image/2026-11-09/1794210905555_00437bfa-c5ba-4459-b2cc-29b7ce08db28.png`;
const VIDEO = `${HOST}/video/2026-11-09/1794220319994_ebf3bd7f-0e1c-4e0e-af7a-6e5934da03bf.webm`;
const AUDIO = `${HOST}/audio/2026-11-09/1794220296714_8e3f3c68-422d-48c3-b7e9-b92d1e3e93b7.wav`;

/** What the body writes for a picture with no caption (probe, inner#1537 §3). */
const img = (name = 'probe.png'): string => `<img src="${IMAGE}" alt="${name}" data-name="${name}" data-url="${IMAGE}">`;
const video = `<video src="${VIDEO}" data-name="probe.webm" data-url="${VIDEO}"></video>`;
const audio = `<audio src="${AUDIO}" data-name="probe.wav" data-url="${AUDIO}"></audio>`;

/** A block with a caption: BlockNote moves the block's data attributes onto the figure. */
function figure(media: string, url: string, name: string, caption: string): string {
  return `<figure data-name="${name}" data-url="${url}" data-caption="${caption}">${media}<figcaption>${caption}</figcaption></figure>`;
}

describe('documentMediaPaste', () => {
  it('reads one picture from the body as one picture named after its file', () => {
    expect(documentMediaPaste(img())).toEqual({ media: [{ type: 'image', url: IMAGE, name: 'probe.png' }], notPasted: 0 });
  });

  it('reads a video and a sound in the order they came', () => {
    expect(documentMediaPaste(`${video}${audio}${img()}`)?.media).toEqual([
      { type: 'video', url: VIDEO, name: 'probe.webm' },
      { type: 'audio', url: AUDIO, name: 'probe.wav' },
      { type: 'image', url: IMAGE, name: 'probe.png' },
    ]);
  });

  it.each([
    ['image', `<img src="${IMAGE}" alt="">`, IMAGE],
    ['video', `<video src="${VIDEO}"></video>`, VIDEO],
    ['audio', `<audio src="${AUDIO}"></audio>`, AUDIO],
  ])('names a captioned %s after its caption, read off the figure', (type, media, url) => {
    expect(documentMediaPaste(figure(media, url, 'file.bin', 'Opening shot'))?.media).toEqual([
      { type, url, name: 'Opening shot' },
    ]);
  });

  // A node name is at most MAX_NODE_NAME_LEN, as every other way of naming one keeps it.
  it('trims the name and keeps it within the node name limit', () => {
    const long = 'Screenshot 2026-11-09 at 10.15.32.png';
    expect(documentMediaPaste(img(long))?.media[0]?.name).toBe(long.slice(0, MAX_NODE_NAME_LEN));
    expect(documentMediaPaste(figure(`<img src="${IMAGE}" alt="">`, IMAGE, 'f.png', '  Opening shot  '))?.media[0]?.name).toBe('Opening shot');
  });

  it('falls back to the alt text, then to no name', () => {
    expect(documentMediaPaste(`<img src="${IMAGE}" alt="kept">`)?.media[0]?.name).toBe('kept');
    expect(documentMediaPaste(`<video src="${VIDEO}"></video>`)?.media[0]?.name).toBe('');
  });

  it.each([
    ['an empty paragraph', '<p>￼</p>'],
    ['an empty heading', '<h2>￼</h2>'],
    ['an empty list item', '<ul><li><p>￼</p></li></ul>'],
    ['an empty check item', '<ul><li data-checked="false"><input type="checkbox"><p>￼</p></li></ul>'],
    ['an empty code block', '<pre><code></code></pre>'],
    ['a comment and white space', '<!-- x -->\n  '],
  ])('ignores %s the selection took in at either end', (_label, edge) => {
    expect(documentMediaPaste(`${edge}${img()}${video}${edge}`)?.media).toHaveLength(2);
  });

  it.each([
    ['words', `<p>Words before</p>${img()}`],
    ['a heading with words', `<h2>Shots</h2>${img()}`],
    ['a picture from elsewhere', '<img src="https://example.com/a.png" alt="a">'],
    ['a list with words', `<ul><li><p>one</p></li></ul>${video}`],
    ['a stored picture next to one from elsewhere', `${img()}<img src="https://example.com/a.png" alt="">`],
    ['a figure holding more than a medium and its caption', `<figure><img src="${IMAGE}"><figcaption>c</figcaption><p>x</p></figure>`],
  ])('leaves a copy holding %s to the text paste', (_label, html) => {
    expect(documentMediaPaste(html)).toBeNull();
  });

  it('leaves a copy with no media at all to the text paste', () => {
    expect(documentMediaPaste('<p>￼</p>')).toBeNull();
    expect(documentMediaPaste('')).toBeNull();
  });

  it('counts a block still uploading as not pasted', () => {
    const pending = '<p data-upload-pending="">clip.mp4 is still uploading</p>';
    expect(documentMediaPaste(`${img()}${pending}`)).toEqual({
      media: [{ type: 'image', url: IMAGE, name: 'probe.png' }],
      notPasted: 1,
    });
    expect(documentMediaPaste(pending)).toEqual({ media: [], notPasted: 1 });
  });
});

describe('documentMediaPayload', () => {
  const centre = { x: 500, y: 400 };

  it('makes one medium one original node centred on the point', () => {
    const payload = documentMediaPayload([{ type: 'image', url: IMAGE, name: 'probe.png' }], centre, '#abc');
    expect(payload.nodes).toEqual([
      {
        id: 'm0',
        type: 'image',
        position: centerToTopLeft(centre, EMPTY_NODE_SIZE),
        data: { name: 'probe.png', content: IMAGE },
        original: true,
      },
    ]);
    expect(payload.picked).toEqual(['m0']);
    expect(payload.source).toBeUndefined();
  });

  it('leaves the name out when there is none', () => {
    const payload = documentMediaPayload([{ type: 'video', url: VIDEO, name: '' }], centre, '#abc');
    expect(payload.nodes[0]?.data).toEqual({ content: VIDEO });
  });

  it('puts two or more media in a group named after how many there are, laid out like a batch of files', () => {
    const media = [
      { type: 'image', url: IMAGE, name: 'one.png' },
      { type: 'video', url: VIDEO, name: 'two.webm' },
    ] as const;
    const payload = documentMediaPayload(media, centre, '#abc');
    // Laid out by the one function a batch of files is laid out by.
    const { tops, frame: framed } = batchLayoutAt(centre, 2);
    const frame = framed!;
    const [group, ...members] = payload.nodes;
    expect(group).toEqual({
      id: 'g',
      type: 'group',
      position: { x: frame.x, y: frame.y },
      width: frame.width,
      height: frame.height,
      data: { name: '2 files', width: frame.width, height: frame.height, backgroundColor: '#abc' },
      original: true,
    });
    expect(members.map((m) => [m.type, m.parentId, m.position, m.data.name, m.original])).toEqual([
      ['image', 'g', tops[0], 'one.png', true],
      ['video', 'g', tops[1], 'two.webm', true],
    ]);
    expect(payload.picked).toEqual(['g']);
  });
});
