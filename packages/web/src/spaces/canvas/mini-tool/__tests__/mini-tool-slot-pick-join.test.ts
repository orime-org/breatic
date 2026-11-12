// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Picking clips for the join tool from the canvas (inner#1825 §6.5): the list
 * is keyed by node, so a node already in it is turned away while another node
 * holding the same file is not, and the panel's host can be picked back once
 * the user removed it. Judged the way the canvas judges a click and paints the
 * candidates: the open tool's slot, what it holds, and the candidate rule.
 */

import { describe, it, expect } from 'vitest';
import type { MiniToolSlotValue } from '@breatic/shared/mini-tools';

import {
  activeMiniToolSlot,
  heldSlotUrls,
  miniToolSlotCandidate,
  miniToolSlotValue,
} from '@web/spaces/canvas/mini-tool/mini-tool-slot-pick';
import type { MiniToolDraft } from '@web/stores/canvas-session';

/**
 * A join draft opened on `host` holding these clips, in order.
 * @param clips - The list, first clip included.
 * @returns The draft.
 */
function joinDraft(clips: readonly MiniToolSlotValue[]): MiniToolDraft {
  return {
    toolId: 'video.join',
    sourceContent: 'https://cdn/h.mp4',
    prompt: '',
    params: { crossfade: 0 },
    slots: { clips },
    sourceSize: null,
    drawing: null,
    expand: null,
    mark: null,
    exporting: false,
  };
}

/**
 * Whether a click on this node adds it to the list, as the canvas decides it.
 * @param draft - The open draft.
 * @param node - The clicked node.
 * @param node.id - Its id.
 * @param node.content - What it holds.
 * @returns True for a candidate.
 */
function canPick(draft: MiniToolDraft, node: { id: string; content: string }): boolean {
  const slot = activeMiniToolSlot({ nodeId: 'h', purpose: 'miniToolSlot', slotKey: 'clips' }, draft);
  if (slot === undefined) throw new Error('the join tool declares no clips slot');
  return miniToolSlotCandidate({ id: node.id, type: 'video', data: { content: node.content } }, 'h', slot, heldSlotUrls(draft, slot));
}

const HOST = { url: 'https://cdn/h.mp4', nodeId: 'h', name: 'H' } as MiniToolSlotValue;
const B = { url: 'https://cdn/b.mp4', nodeId: 'b', name: 'B' } as MiniToolSlotValue;

describe('join clip candidates (inner#1825 §6.5)', () => {
  it('turns away a node already in the list and takes another node holding the same file', () => {
    const draft = joinDraft([HOST, B]);
    expect(canPick(draft, { id: 'b', content: 'https://cdn/b.mp4' })).toBe(false);
    expect(canPick(draft, { id: 'b-copy', content: 'https://cdn/b.mp4' })).toBe(true);
  });

  it('takes the panel’s host back once it was removed from the list, and not while it is in it', () => {
    expect(canPick(joinDraft([HOST, B]), { id: 'h', content: 'https://cdn/h.mp4' })).toBe(false);
    expect(canPick(joinDraft([B]), { id: 'h', content: 'https://cdn/h.mp4' })).toBe(true);
  });
});

describe('what a pick copies off the clicked node', () => {
  it('carries the node’s id and name beside its address, cover and length', () => {
    expect(
      miniToolSlotValue({ id: 'b', type: 'video', data: { content: 'https://cdn/b.mp4', coverUrl: 'https://cdn/b.jpg', duration: 4, name: 'B' } } as Parameters<typeof miniToolSlotValue>[0]),
    ).toEqual({ url: 'https://cdn/b.mp4', cover: 'https://cdn/b.jpg', duration: 4, nodeId: 'b', name: 'B' });
  });
});
