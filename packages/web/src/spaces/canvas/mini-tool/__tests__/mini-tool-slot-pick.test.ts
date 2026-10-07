// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';

import {
  activeMiniToolSlot,
  miniToolSlotCandidate,
  miniToolSlotValue,
} from '@web/spaces/canvas/mini-tool/mini-tool-slot-pick';

const DRAFT = { toolId: 'video.edit', sourceContent: 'v.mp4', prompt: '', params: {}, slots: {}, sourceSize: null };

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
  it('copies the address, the cover and the length', () => {
    expect(
      miniToolSlotValue({ type: 'video', data: { content: 'v.mp4', coverUrl: 'c.jpg', duration: 4 } }),
    ).toEqual({ url: 'v.mp4', cover: 'c.jpg', duration: 4 });
    expect(miniToolSlotValue({ type: 'image', data: { content: 'i.png' } })).toEqual({ url: 'i.png' });
  });
});
