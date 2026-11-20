// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { EMPTY_NODE_SIZE } from '@web/spaces/canvas/group-geometry';
import { plannedOutputPlacementOf } from '../planned-output-placement';

describe('F11 complete internal planned output placement', () => {
  it('keeps one output in the original column layout', () => {
    const descriptor = { modality: 'video', namePrefix: 'CLIP' } as const;
    expect(plannedOutputPlacementOf([descriptor], [], 'ORIGINAL')).toEqual([{ output: descriptor, name: 'CLIP-ORIGINAL', x: 0, y: 0, width: EMPTY_NODE_SIZE.width, height: EMPTY_NODE_SIZE.height }]);
  });

  it('places every internal descriptor in supplied order without legacy outputsOf or an implicit Group', () => {
    // These are layout descriptors, not unapproved public recipes for another tool.
    const outputs = [{ modality: 'image', namePrefix: 'FRAME' }, { modality: 'video', namePrefix: 'CLIP' }, { modality: 'image', namePrefix: 'FRAME' }] as const;
    const placed = plannedOutputPlacementOf(outputs, [], 'ORIGINAL');
    expect(placed.map(({ output, x, y, width, height }) => ({ output, x, y, width, height }))).toEqual(outputs.map((output, index) => ({ output, x: 0, y: index * NODE_STEP.y, width: EMPTY_NODE_SIZE.width, height: EMPTY_NODE_SIZE.height })));
    expect(placed).toHaveLength(3);
  });

  it('does not invent an output for an empty complete list', () => {
    expect(plannedOutputPlacementOf([], [], 'ORIGINAL')).toEqual([]);
  });
});
