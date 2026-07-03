// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import {
  GROUP_BACKGROUND_OPTIONS,
  groupBackgroundStyle,
  normalizeGroupBackground,
} from '@web/spaces/canvas/group-background';
import { NODE_TYPE_PALETTE } from '@web/spaces/canvas/node-type-palette';

/** The minimap fill for kinds outside the ratified palette mapping. */
const NEUTRAL_FILL = 'var(--color-muted)';

/**
 * The palette tint tokens a group may legally store (post-normalization).
 * SVG punishes garbage harder than HTML: an unknown name inside `var()`
 * drops the fill declaration and the rect paints BLACK, while the main
 * canvas renders the same corrupt value as a benign transparent — so the
 * minimap validates against the ratified option set instead of trusting
 * the stored string (adversarial finding, 2026-07-03).
 */
const KNOWN_GROUP_TINTS: ReadonlySet<string> = new Set(
  GROUP_BACKGROUND_OPTIONS.flatMap((o) => (o.value ? [o.value] : [])),
);

/**
 * The MiniMap fill color for a canvas node — the node's palette identity by
 * type (#1549 ratified mapping), a tinted group's own background tint (legacy
 * stored names normalize), or the neutral fill for untinted groups and the
 * reserved kinds (`3d` / `web`) that have no creation entry today.
 * @param node - The ReactFlow node.
 * @param node.type - The node kind (the `FLOW_NODE_TYPES` key).
 * @param node.data - The node view; group views carry their stored tint in
 * `data.backgroundColor`.
 * @returns A CSS color string (`var(...)` into the palette or neutral fill).
 */
export function minimapNodeColor(node: {
  type?: string;
  data?: Record<string, unknown>;
}): string {
  if (node.type === 'group') {
    const stored = node.data?.backgroundColor;
    const token = normalizeGroupBackground(
      typeof stored === 'string' ? stored : undefined,
    );
    if (!token || !KNOWN_GROUP_TINTS.has(token)) return NEUTRAL_FILL;
    return groupBackgroundStyle(token) ?? NEUTRAL_FILL;
  }
  const token = node.type ? NODE_TYPE_PALETTE[node.type] : undefined;
  return token ? `var(${token})` : NEUTRAL_FILL;
}
