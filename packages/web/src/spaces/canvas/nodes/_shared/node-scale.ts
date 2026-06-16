// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';

/**
 * Canvas-zoom counter-scale for a node's floating name header. ReactFlow
 * scales a whole node by the canvas `zoom`; the header anchor scales by
 * `1 / zoom` against that so the name + icon stay a constant screen size at
 * any zoom level. Provided by the ReactFlow node wrapper (the only layer with
 * the store); defaults to `1` (no scaling) outside the canvas — e.g. isolated
 * component tests render the frame with no provider.
 */
export const NodeScaleContext: React.Context<number> = React.createContext(1);
