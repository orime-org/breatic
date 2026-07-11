// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Drag-to-blank "create + connect" (batch-2 item 3): dragging a wire from a
 * node's OUTPUT stub and releasing over blank canvas offers a menu of node
 * types to create at the release point, pre-wired to the dragged source.
 * The pure resolvers here decide WHEN the menu opens and WHAT it offers, so
 * the policy is unit-testable without driving xyflow's d3 drag (which
 * synthetic events cannot reach — see web-frontend-traps).
 */

import { canConnect } from '@web/spaces/canvas/lib/connection-rules';
import {
  CREATABLE_NODE_TYPES,
  type CreatableNodeType,
} from '@web/spaces/canvas/node-factory';

/**
 * The creatable modalities whose INPUT accepts `sourceKind` (connection rules
 * §9.1), in library order. These are the only rows the create-menu may offer —
 * anything else would be rejected the moment the edge is written.
 * @param sourceKind - The dragged source node's modality.
 * @returns The offerable creatable types (possibly empty).
 */
export function connectableCreatableTypes(
  sourceKind: string,
): CreatableNodeType[] {
  return CREATABLE_NODE_TYPES.filter((type) => canConnect(sourceKind, type));
}

/**
 * Classifies the element under a connection-drag release as "visually blank
 * canvas". The caller resolves that element via `document.elementFromPoint`
 * at the RELEASE coordinates — never `event.target`, which lies twice
 * (adversarial round-1): a touchend's target is the element the touch
 * STARTED on (the source handle), and mouse releases land on invisible hit
 * layers the user cannot see (a 20px edge interaction stroke, the
 * post-marquee NodesSelection rect). Blank = inside the pane, not on a node,
 * not on the floating panel (NodeToolbar portal). Invisible overlays inside
 * the pane deliberately count as blank — they LOOK blank.
 * @param el - The element under the release point (null = nothing hit).
 * @returns Whether the release lands on visually blank canvas.
 */
export function isBlankCanvasRelease(el: Element | null): boolean {
  if (el === null || el.closest('.react-flow__pane') === null) return false;
  return (
    el.closest('.react-flow__node, .react-flow__node-toolbar') === null
  );
}

/** What the create-menu needs to open: the source to wire from + its rows. */
export interface ConnectCreateIntent {
  /** The dragged source node id (the new node wires source → new). */
  sourceId: string;
  /** The dragged source node's modality. */
  sourceKind: string;
  /** The offerable creatable types (non-empty by construction). */
  types: CreatableNodeType[];
}

/**
 * Decides whether a finished connection drag should open the create-menu:
 * only an OUTPUT-stub drag (references flow downstream; an input-stub drag
 * asks for an upstream, which is what the @ picker / pick mode are for),
 * released over the BLANK pane (a node body / chrome release is a normal
 * cancel), by an editor (viewers cannot create), with at least one
 * rule-compatible creatable type to offer.
 * @param input - The reconstructed drag-release.
 * @param input.fromNodeId - The drag's source node id, or null.
 * @param input.fromNodeKind - The drag's source node modality, if known.
 * @param input.fromHandleType - Which stub started the drag.
 * @param input.toNodeId - The node the drag ended on, or null for none.
 * @param input.releasedOnPane - Whether the release landed on the blank pane.
 * @param input.readOnly - Whether the canvas is read-only.
 * @returns The menu intent, or null when the release is a normal cancel.
 */
export function resolveConnectCreateIntent(input: {
  fromNodeId: string | null;
  fromNodeKind: string | undefined;
  fromHandleType: string | null;
  toNodeId: string | null;
  releasedOnPane: boolean;
  readOnly: boolean;
}): ConnectCreateIntent | null {
  const { fromNodeId, fromNodeKind, fromHandleType, toNodeId } = input;
  if (input.readOnly || !input.releasedOnPane) return null;
  if (!fromNodeId || fromHandleType !== 'source' || toNodeId !== null) {
    return null;
  }
  const types = connectableCreatableTypes(fromNodeKind ?? '');
  if (types.length === 0) return null;
  return { sourceId: fromNodeId, sourceKind: fromNodeKind ?? '', types };
}
