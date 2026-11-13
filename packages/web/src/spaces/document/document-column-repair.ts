// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The local repair that keeps column groups meaningful (inner#1314 design
 * §5.2).
 */

import { PluginKey } from '@tiptap/pm/state';

/**
 * Meta on the take-away half of a two-step move: the emptied column is
 * deleted, and the group is not dissolved until the put-down half has run.
 */
export const COLUMN_TAKE_AWAY = new PluginKey('doc-column-take-away');
