// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, expect, it } from 'vitest';

import { SELECTION_ADD_PREVIEW_Z } from '@web/spaces/canvas/viewport-layers';

// The selection plus's preview wires live in the viewport portal, which sits
// after `.react-flow__nodes` in the DOM and shares the viewport's stacking
// context with the nodes; without a negative z they would paint over every
// node at z 0 (inner#2216 design 4.5).
describe('SELECTION_ADD_PREVIEW_Z', () => {
  it('sits below every node and edge', () => {
    expect(typeof SELECTION_ADD_PREVIEW_Z).toBe('number');
    expect(SELECTION_ADD_PREVIEW_Z).toBeLessThan(0);
  });
});
