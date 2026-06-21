// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * The ReactFlow node id of the node currently being rendered, provided by the
 * node wrapper (`flow-node-types`) — the only layer that knows it. Descendants
 * (the name header's inline rename) read it to tell whether a canvas-level
 * command targets *this* node: the right-click menu's "Rename" posts a node id
 * to the canvas store's `pendingRename` mailbox, and the matching node picks it
 * up. `null` outside the canvas (isolated component tests render the frame with
 * no provider), where the rename watch simply no-ops — same defaulting pattern
 * as {@link NodeScaleContext}.
 */
export const NodeIdContext: React.Context<string | null> =
  React.createContext<string | null>(null);
