// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

/** Nobody, shared so every unheld node reads the same empty array. */
export const NOBODY: readonly string[] = [];

/**
 * Who is holding the node currently being rendered, provided by the node
 * wrapper (`flow-node-types`) — the layer that has `props.data`. It joins the
 * two channels a hold can arrive on, the live one (awareness) and the one
 * recorded in the document (whoever started a running generation), and names
 * each person once whichever of them say so.
 *
 * It travels as a context rather than a prop because the frame below takes a
 * fixed set of named parameters and the six modality components build their
 * calls literally: a prop would mean six files each writing "I received it, I
 * pass it on", and every one of those lines is optional in a way nothing
 * catches. The roster context above it (#1882) was moved for the same reason.
 *
 * Empty outside the canvas, where an isolated component test renders a frame
 * with no provider and simply draws no tags.
 */
export const NodeOccupantsContext: React.Context<readonly string[]> =
  React.createContext<readonly string[]>(NOBODY);
