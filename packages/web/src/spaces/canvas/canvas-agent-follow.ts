// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type { FlowRect, PaneSize } from '@web/features/follow/follow-geometry';

/** The margin kept around an agent's nodes, as a share of their size on each side. */
const MARGIN = 0.1;

/**
 * The canvas area to show while following an external agent (#1488 design
 * 19.3): the box around the nodes it works on with a margin, never closer
 * than full size, centred on those nodes.
 * @param bounds - The box around the nodes, in canvas coordinates.
 * @param pane - The pane the area is fitted into.
 * @returns The area.
 */
export function agentFollowRect(bounds: FlowRect, pane: PaneSize): FlowRect {
  const width = Math.max(bounds.width * (1 + 2 * MARGIN), pane.width);
  const height = Math.max(bounds.height * (1 + 2 * MARGIN), pane.height);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}
