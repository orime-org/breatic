// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { GridHelper } from 'three';

/**
 * Draw a ground grid in the theme's muted foreground at the scene's grid strength.
 * THREE.Color drops CSS alpha, so the translucency lives on the material instead.
 * @param grid - The grid whose single line material is restyled.
 * @param mutedForeground - The resolved `--color-muted-foreground` value.
 * @throws {never} Never directly.
 */
export function applySceneGridTheme(grid: GridHelper, mutedForeground: string): void {
  grid.material.vertexColors = false;
  grid.material.color.setStyle(mutedForeground);
  grid.material.opacity = 0.2;
  grid.material.transparent = true;
  grid.material.needsUpdate = true;
}
