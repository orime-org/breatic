// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import type { PeerActivity } from '@web/spaces/canvas/node-activity';

/** Nobody doing anything, shared so the default never changes identity. */
const NO_ACTIVITY: PeerActivity = new Map();

/**
 * Who else is doing what to which node (inner#1303 §6.8), provided once by the
 * canvas. Read only by the empty-node placeholder, so a change re-renders the
 * empty nodes alone. Empty outside the canvas.
 */
export const PeerActivityContext: React.Context<PeerActivity> =
  React.createContext<PeerActivity>(NO_ACTIVITY);

/**
 * Whether the node being rendered has any tasks, provided by the node wrapper
 * (`flow-node-types`), which has its task counts. A node with tasks shows them,
 * not someone else's activity. False outside the canvas.
 */
export const NodeBusyContext: React.Context<boolean> = React.createContext<boolean>(false);
