// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';

import {
  activeMiniToolSlot,
  miniToolSlotCandidate,
  miniToolSlotValue,
} from '@web/spaces/canvas/mini-tool/mini-tool-slot-pick';

const DRAFT = {
  toolId: 'video.edit',
  sourceContent: 'v.mp4',
  prompt: '',
  params: {},
  slots: {},
  sourceSize: null,
  drawing: null,
  expand: null,
  mark: null,
  exporting: false,
};

describe('activeMiniToolSlot', () => {
  it('reads the slot a mini-tool pick fills off the open tool', () => {
    const slot = activeMiniToolSlot({ nodeId: 'n', purpose: 'miniToolSlot', slotKey: 'images' }, DRAFT);
    expect(slot).toMatchObject({ key: 'images', accepts: 'image', many: true });
  });

  it('answers nothing for another purpose or a closed panel', () => {
    expect(activeMiniToolSlot({ nodeId: 'n', purpose: 'reference' }, DRAFT)).toBeUndefined();
    expect(activeMiniToolSlot({ nodeId: 'n', purpose: 'miniToolSlot', slotKey: 'images' }, null)).toBeUndefined();
  });
});

describe('miniToolSlotCandidate', () => {
  const slot = { key: 'images', param: 'reference_images', accepts: 'image', many: true, bannerKey: '' } as const;
  const node = (id: string, type: string, content?: string) => ({ id, type, data: { content } });

  it('takes a node of the accepted kind that holds something', () => {
    expect(miniToolSlotCandidate(node('a', 'image', 'a.png'), 'host', slot, new Set())).toBe(true);
  });

  it('turns away the host, another kind, an empty node and one already held', () => {
    expect(miniToolSlotCandidate(node('host', 'image', 'h.png'), 'host', slot, new Set())).toBe(false);
    expect(miniToolSlotCandidate(node('a', 'audio', 'a.mp3'), 'host', slot, new Set())).toBe(false);
    expect(miniToolSlotCandidate(node('a', 'image'), 'host', slot, new Set())).toBe(false);
    expect(miniToolSlotCandidate(node('a', 'image', 'a.png'), 'host', slot, new Set(['a.png']))).toBe(false);
  });
});

describe('miniToolSlotValue', () => {
  // §7.3: the pick is a snapshot of the node at that moment, cover and length included.
  // The node it was picked from travels with it, so two nodes holding the same address stay apart (inner#1306 #14).
  it('copies the address, the cover, the length and the clicked node', () => {
    expect(
      miniToolSlotValue({ id: 'v', type: 'video', data: { content: 'v.mp4', coverUrl: 'c.jpg', duration: 4 } }),
    ).toEqual({ url: 'v.mp4', cover: 'c.jpg', duration: 4, nodeId: 'v' });
    expect(miniToolSlotValue({ id: 'i', type: 'image', data: { content: 'i.png' } })).toEqual({ url: 'i.png', nodeId: 'i' });
  });
});

describe('video tool independent copied-input slots', () => {
  it('accepts audio for a stable dialogue identity and ends after one selection', () => {
    expect(activeMiniToolSlot({ nodeId: 'n', purpose: 'miniToolSlot', slotKey: 'dialogue:pair-2' }, { ...DRAFT, toolId: 'video.lip-sync' })).toEqual({ key: 'dialogue:pair-2', param: 'audio', accepts: 'audio', many: false, bannerKey: 'canvas.miniTool.videoUI.pickAudio' });
  });
  it('accepts a single video click for the transitions asset rail', () => {
    expect(activeMiniToolSlot({ nodeId: 'n', purpose: 'miniToolSlot', slotKey: 'timeline' }, { ...DRAFT, toolId: 'video.transitions' })).toEqual({ key: 'timeline', param: 'video', accepts: 'video', many: false, bannerKey: 'canvas.miniTool.videoUI.pickVideo' });
  });
  it('does not reinterpret a dialogue key outside the lip sync tool', () => {
    expect(activeMiniToolSlot({ nodeId: 'n', purpose: 'miniToolSlot', slotKey: 'dialogue:pair-2' }, DRAFT)).toBeUndefined();
  });
});
