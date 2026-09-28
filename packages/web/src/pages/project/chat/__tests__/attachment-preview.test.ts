// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, expect, it } from 'vitest';

import type { ChatAttachedChip } from '@breatic/shared';
import { PREVIEW_ROWS, previewOf } from '@web/pages/project/chat/attachment-preview';

const file = (type: ChatAttachedChip['type'], snapshot: Record<string, unknown>): ChatAttachedChip => ({
  id: `f-${type}`,
  type,
  name: `x.${type}`,
  data_snapshot: snapshot,
});

const node = (id: string, type: string, data: Record<string, unknown> = {}) => ({
  id,
  type,
  position: { x: 0, y: 0 },
  data: { kind: type, name: id, ...data },
});

const canvas = (nodes: ReturnType<typeof node>[]): ChatAttachedChip => ({
  id: 'c',
  type: 'canvas',
  name: '',
  data_snapshot: { nodes, edges: [] },
});

describe('previewOf', () => {
  it('previews an uploaded image, video and audio by their address', () => {
    expect(previewOf(file('image', { url: 'https://a/i.png' }))).toEqual({ kind: 'image', src: 'https://a/i.png' });
    expect(previewOf(file('video', { url: 'https://a/v.mp4' }))).toEqual({ kind: 'video', src: 'https://a/v.mp4' });
    expect(previewOf(file('audio', { url: 'https://a/a.mp3' }))).toEqual({ kind: 'audio', src: 'https://a/a.mp3' });
  });

  it('previews an uploaded document by its words', () => {
    expect(previewOf(file('text', { text: 'hello' }))).toEqual({ kind: 'text', text: 'hello' });
  });

  it('has nothing to preview before a file has an address or words', () => {
    expect(previewOf(undefined)).toBeNull();
    expect(previewOf(file('image', {}))).toBeNull();
    expect(previewOf(file('text', { text: '' }))).toBeNull();
  });

  it('previews one media or text node the way its kind previews', () => {
    expect(previewOf(canvas([node('a', 'image', { content: 'https://a/i.png' })]))).toEqual({
      kind: 'image',
      src: 'https://a/i.png',
    });
    expect(previewOf(canvas([node('v', 'video', { content: 'https://a/v.mp4', coverUrl: 'https://a/c.jpg' })]))).toEqual({
      kind: 'video',
      src: 'https://a/v.mp4',
      poster: 'https://a/c.jpg',
    });
    expect(previewOf(canvas([node('m', 'audio', { content: 'https://a/a.mp3' })]))).toEqual({
      kind: 'audio',
      src: 'https://a/a.mp3',
    });
    expect(previewOf(canvas([node('t', 'text', { content: 'script' })]))).toEqual({ kind: 'text', text: 'script' });
  });

  it('lists several nodes as rows with a thumbnail where one exists', () => {
    const preview = previewOf(
      canvas([
        node('g', 'group'),
        node('a', 'image', { content: 'https://a/i.png' }),
        node('v', 'video', { content: 'https://a/v.mp4', coverUrl: 'https://a/c.jpg' }),
        node('t', 'text', { content: 'script' }),
      ]),
    );
    expect(preview).toEqual({
      kind: 'nodes',
      rows: [
        { id: 'g', kind: 'group', name: 'g' },
        { id: 'a', kind: 'image', name: 'a', thumbnail: 'https://a/i.png' },
        { id: 'v', kind: 'video', name: 'v', thumbnail: 'https://a/c.jpg' },
        { id: 't', kind: 'text', name: 't' },
      ],
      more: 0,
    });
  });

  it('lists a single node of another kind as one row', () => {
    expect(previewOf(canvas([node('w', 'web')]))).toEqual({
      kind: 'nodes',
      rows: [{ id: 'w', kind: 'web', name: 'w' }],
      more: 0,
    });
  });

  it('lists at most the row limit and counts the rest', () => {
    const many = Array.from({ length: PREVIEW_ROWS + 3 }, (_, i) => node(`n${i}`, 'text'));
    const preview = previewOf(canvas(many));
    expect(preview?.kind).toBe('nodes');
    if (preview?.kind !== 'nodes') return;
    expect(preview.rows.map((r) => r.id)).toEqual(many.slice(0, PREVIEW_ROWS).map((n) => n.id));
    expect(preview.more).toBe(3);
  });

  it('names an unnamed node by its kind', () => {
    const unnamed = { ...node('a', 'image'), data: { kind: 'image', name: '' } };
    const preview = previewOf(canvas([unnamed, node('b', 'text')]));
    expect(preview?.kind === 'nodes' && preview.rows[0]?.name).toBe('image');
  });

  it('lists nodes a stored message carries without their data', () => {
    const chip: ChatAttachedChip = {
      id: 'c',
      type: 'canvas',
      name: '',
      data_snapshot: { nodes: [{ id: 'a' }, { id: 'b' }, null, 'x'], edges: [] },
    };
    expect(previewOf(chip)).toEqual({
      kind: 'nodes',
      rows: [
        { id: 'a', kind: '', name: '' },
        { id: 'b', kind: '', name: '' },
      ],
      more: 0,
    });
  });
});
