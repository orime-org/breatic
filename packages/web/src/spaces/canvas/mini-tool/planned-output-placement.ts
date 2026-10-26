// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { MiniToolOutput } from '@breatic/shared/mini-tools';
import type { OutputSize, PlacedOutput } from '@web/spaces/canvas/mini-tool/output-placement';

/**
 * Places the complete internally planned output list in its original order.
 * @param _outputs - Complete descriptors, independent from public recipes.
 * @param _sizes - Known per-output pixel sizes.
 * @param _sourceName - The original source's name.
 * @throws {Error} Until planned placement is implemented.
 */
export function plannedOutputPlacementOf(_outputs: readonly MiniToolOutput[], _sizes: readonly (OutputSize | undefined)[], _sourceName: string | undefined): PlacedOutput[] {
  throw new Error('Planned output placement is not implemented');
}
