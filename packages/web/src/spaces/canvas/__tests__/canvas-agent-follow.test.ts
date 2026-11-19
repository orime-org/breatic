// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { followViewport } from '@web/features/follow/follow-geometry';
import { agentFollowRect } from '@web/spaces/canvas/canvas-agent-follow';

const pane = { width: 1000, height: 600 };

describe('agentFollowRect (#1488 design 19.3)', () => {
  it('shows a small focus at full size, centred', () => {
    const rect = agentFollowRect({ x: 100, y: 100, width: 288, height: 200 }, pane);
    expect(rect).toEqual({ x: 100 + 144 - 500, y: 100 + 100 - 300, width: 1000, height: 600 });
    expect(followViewport(rect, pane).zoom).toBeCloseTo(1);
  });

  it('fits a large focus whole, with a margin around it', () => {
    const rect = agentFollowRect({ x: 0, y: 0, width: 4000, height: 1000 }, pane);
    expect(rect.width).toBeCloseTo(4800);
    expect(rect.x + rect.width / 2).toBeCloseTo(2000);
    expect(followViewport(rect, pane).zoom).toBeLessThan(1);
  });
});
