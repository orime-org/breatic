// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The order a multi-selection's clips join in (inner#1825 §6.5): columns left
 * to right, each top to bottom, a column holding the clips that sit within
 * half a node's width of its first one.
 */

import { describe, expect, it } from 'vitest';

import { joinOfSelection } from '@web/spaces/canvas/mini-tool/mini-tool-slot-pick';

/**
 * A selected audio node holding a clip.
 * @param id - Its id, and the stem of its file.
 * @param x - Where it sits across.
 * @param y - Where it sits down.
 * @returns The node.
 */
function clip(id: string, x: number, y: number): { id: string; type: string; position: { x: number; y: number }; selected: boolean; data: Record<string, unknown> } {
  return { id, type: 'audio', position: { x, y }, selected: true, data: { content: `https://cdn/${id}.mp3`, name: id } };
}

describe('joinOfSelection', () => {
  it('reads a column stacked a few pixels out of line top to bottom, before the next column', () => {
    const order = joinOfSelection([clip('low', 3, 400), clip('top', 0, 0), clip('mid', 6, 200), clip('right', 340, 0)])?.clips.map((one) => one.nodeId);
    expect(order).toEqual(['top', 'mid', 'low', 'right']);
  });

  it('starts a new column once a clip sits half a node\'s width or more to the right', () => {
    const order = joinOfSelection([clip('a', 0, 100), clip('b', 150, 0)])?.clips.map((one) => one.nodeId);
    expect(order).toEqual(['a', 'b']);
  });
});
