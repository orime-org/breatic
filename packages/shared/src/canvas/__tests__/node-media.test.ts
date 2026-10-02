// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The six media fields a result puts on a node besides its content (#2184).
 *
 * Collab writes them when a result first lands and the canvas writes them when
 * a history row is restored; both go through this one function, so the same
 * result always leaves the node with the same fields.
 */

import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { writeNodeMedia } from '../node-media';

/**
 * A node's data map, attached to a document so writes behave as in the app.
 * @param seed - Fields the node already holds.
 * @returns The map.
 */
function nodeData(seed: Record<string, unknown> = {}): Y.Map<unknown> {
  const doc = new Y.Doc();
  const data = doc.getMap<unknown>('data');
  for (const [key, value] of Object.entries(seed)) data.set(key, value);
  return data;
}

const VIDEO = {
  coverUrl: 'https://cdn.example.com/cover.jpg',
  width: 1920,
  height: 1080,
  duration: 5.04,
  mimeType: 'video/mp4',
  size: 734_003,
};

describe('writeNodeMedia', () => {
  it('writes every field the result carries', () => {
    const data = nodeData();

    writeNodeMedia(data, VIDEO);

    expect(data.toJSON()).toEqual({
      coverUrl: 'https://cdn.example.com/cover.jpg',
      mediaWidth: 1920,
      mediaHeight: 1080,
      duration: 5.04,
      mimeType: 'video/mp4',
      size: 734_003,
    });
  });

  it('takes away a field the result has no value for', () => {
    const data = nodeData({ coverUrl: 'old.jpg', duration: 9, mediaWidth: 10 });

    writeNodeMedia(data, {
      coverUrl: null,
      width: 640,
      height: 480,
      duration: null,
      mimeType: 'image/png',
      size: 1024,
    });

    expect(data.toJSON()).toEqual({
      mediaWidth: 640,
      mediaHeight: 480,
      mimeType: 'image/png',
      size: 1024,
    });
  });

  it('leaves the fields it does not own alone', () => {
    const data = nodeData({ content: 'https://cdn.example.com/a.mp4', name: 'clip', width: 300 });

    writeNodeMedia(data, VIDEO);

    expect(data.get('content')).toBe('https://cdn.example.com/a.mp4');
    expect(data.get('name')).toBe('clip');
    expect(data.get('width')).toBe(300);
  });
});
