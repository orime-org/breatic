// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';

import { NODE_TYPE_PALETTE } from '@web/spaces/canvas/node-type-palette';

describe('NODE_TYPE_PALETTE — MiniMap node-type identity colors (#1549, consumed by #1548)', () => {
  it('maps every colorable node type to a palette identity token (user-ratified 2026-07-03: all colors fixed to the 7-color palette; annotation = orange slot, audio = pink)', () => {
    expect(NODE_TYPE_PALETTE).toEqual({
      text: '--color-palette-blue',
      image: '--color-palette-green',
      audio: '--color-palette-pink',
      video: '--color-palette-violet',
      annotation: '--color-palette-orange',
    });
  });

  it('reserves red (too alarm-like) and teal for future node types', () => {
    const used = Object.values(NODE_TYPE_PALETTE);
    expect(used).not.toContain('--color-palette-red');
    expect(used).not.toContain('--color-palette-teal');
  });
});
