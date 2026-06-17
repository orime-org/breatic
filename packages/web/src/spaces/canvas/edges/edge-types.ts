// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import type { EdgeTypes } from '@xyflow/react';

import { ScissorsEdge } from '@web/spaces/canvas/edges/ScissorsEdge';

/**
 * ReactFlow edge-type registry. Every canvas edge renders through
 * {@link ScissorsEdge} (a bezier line plus a select-to-delete scissors
 * affordance); `toFlowEdge` tags each edge `type: 'scissors'`.
 */
export const EDGE_TYPES: EdgeTypes = {
  scissors: ScissorsEdge,
};
