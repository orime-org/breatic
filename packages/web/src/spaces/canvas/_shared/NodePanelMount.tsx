// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

interface NodePanelMountProps {
  /** The node the panel hangs under. */
  nodeId: string;
  /** How far, in screen pixels, something drawn on the node reaches below it; the panel hangs under that. */
  drop?: number;
  children: React.ReactNode;
}

/** xyflow's own gap between a node and its toolbar, in screen pixels. */
const TOOLBAR_GAP_PX = 10;

/**
 * Hangs a panel under its node. The generation panels and the mini-tool panel
 * all mount through here, so their distance from the node is set in one place
 * (inner#888 §7.6).
 * @param root0 - Component props.
 * @param root0.nodeId - The node the panel hangs under.
 * @param root0.drop - How far something on the node reaches below it, in screen pixels.
 * @param root0.children - The panel.
 * @returns The toolbar holding the panel below the node.
 */
export function NodePanelMount({ nodeId, drop = 0, children }: NodePanelMountProps): React.JSX.Element {
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom} offset={TOOLBAR_GAP_PX + drop}>
      {children}
    </NodeToolbar>
  );
}
