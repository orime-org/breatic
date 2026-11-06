// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import { GridHelper } from 'three';
import { applySceneGridTheme } from '@web/spaces/three-d/viewport/scene-grid-theme';

describe('applySceneGridTheme', () => {
  it('draws the grid in one translucent theme colour', () => {
    const grid = new GridHelper(10, 10);
    const version = grid.material.version;

    applySceneGridTheme(grid, 'rgb(100, 110, 120)');

    expect(grid.material.vertexColors).toBe(false);
    expect(grid.material.color.getStyle()).toBe('rgb(100,110,120)');
    expect(grid.material.opacity).toBe(0.2);
    expect(grid.material.transparent).toBe(true);
    expect(grid.material.version).toBeGreaterThan(version);
  });
});
