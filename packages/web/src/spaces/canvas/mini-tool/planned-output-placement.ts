// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { MiniToolOutput } from '@breatic/shared/mini-tools';
import { placeMiniToolOutput, type OutputSize, type PlacedOutput } from '@web/spaces/canvas/mini-tool/output-placement';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';

/**
 * Places the complete internally planned output list in its original order.
 * @param outputs - Complete descriptors, independent from public recipes.
 * @param sizes - Known per-output pixel sizes.
 * @param sourceName - The original source's name.
 * @returns Every output's placement in the existing column layout.
 * @throws {never} Never.
 */
export function plannedOutputPlacementOf(outputs: readonly MiniToolOutput[], sizes: readonly (OutputSize | undefined)[], sourceName: string | undefined): PlacedOutput[] {
  return outputs.map((output, index) => placeMiniToolOutput(output, outputs.length > 1 ? `${index + 1}-` : '', sourceName, 0, index * NODE_STEP.y, sizes[index]));
}
