// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the canvas does once a proposed flow is on it (#263).
 *
 * This answers two questions -- what is selected, and whether a panel opens --
 * and a test can hold both without a canvas around it. The camera follows the
 * flow in `CanvasSpace` (`frameProposal`, inner#1443).
 */

import type { CanvasProposal, GenerationNodeType } from '@breatic/shared';

import type { PlacedProposal } from '@web/spaces/canvas/use-node-creation';

/** What the canvas should put the reader's attention on. */
export interface Focus {
  /** The node ids to select. Empty when nothing should be. */
  select: string[];
  /** The generation panel to open, when exactly one node generates. */
  panel?: { nodeId: string; type: GenerationNodeType };
}

/**
 * What to select, and whether to open a panel, once a flow is placed.
 *
 * One thing that generates: select it and open its panel, since reading the
 * prompt that was just written -- marks and all -- is why the marks are in it.
 *
 * Two or more: select the group and open nothing. A panel is up to 600px wide
 * and hangs under the node it belongs to, so opening one covers the others.
 * The card already says what each node needs; they open the one they want.
 *
 * Anything else selects nothing. A flow with nothing that generates is turned
 * away before it reaches a card, so what is left here is a payload that took
 * some other route in, and pointing the reader at a guess is worse than
 * leaving their selection alone.
 * @param proposal - What was proposed.
 * @param placed - What placing it left on the canvas.
 * @returns What to select and what to open.
 * @throws {never} Never.
 */
export function whatToFocus(proposal: CanvasProposal, placed: Pick<PlacedProposal, 'nodeIds' | 'groupId'>): Focus {
  const generates = proposal.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.role === 'generate');
  const only = generates.length === 1 ? generates[0] : undefined;
  if (only) {
    const nodeId = placed.nodeIds[only.index];
    const { type } = only.node;
    if (nodeId && type !== 'text') return { select: [nodeId], panel: { nodeId, type } };
  }
  if (generates.length > 1 && placed.groupId !== undefined) {
    return { select: [placed.groupId] };
  }
  return { select: [] };
}
