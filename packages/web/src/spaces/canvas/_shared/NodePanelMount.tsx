// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NodeToolbar, Position } from '@xyflow/react';
import * as React from 'react';

interface NodePanelMountProps {
  /** The node the panel hangs under. */
  nodeId: string;
  children: React.ReactNode;
}

/**
 * Hangs a panel under its node. The generation panels and the mini-tool panel
 * all mount through here, so their distance from the node is set in one place
 * (inner#888 §7.6).
 * @param root0 - Component props.
 * @param root0.nodeId - The node the panel hangs under.
 * @param root0.children - The panel.
 * @returns The toolbar holding the panel below the node.
 */
export function NodePanelMount({ nodeId, children }: NodePanelMountProps): React.JSX.Element {
  return (
    <NodeToolbar nodeId={nodeId} isVisible position={Position.Bottom}>
      {children}
    </NodeToolbar>
  );
}
