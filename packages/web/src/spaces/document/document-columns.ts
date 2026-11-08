// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type * as React from 'react';

/** The heading outline's width when it is open (inner#1149). */
export const OUTLINE_WIDTH = 240;

/** The comment panel's width beside the body. */
export const COMMENT_PANEL_WIDTH = 288;

/** The whole-document entry, and the heading outline's icon that mirrors it. */
const ENTRY_SIZE = 32;

/** From the entry to the viewport edge, and from the outline's icon to the Space's left edge. */
const ENTRY_INSET = 16;

/** From the entry to the padding box on its left. */
const ENTRY_CLEARANCE = 8;

/**
 * The body's right gutter, where the whole-document entry stands: the button,
 * the gap it keeps from the padding box on its left and the gap it keeps from
 * the viewport edge on its right. It is also the shut outline column's width.
 */
export const BODY_GUTTER_END = ENTRY_SIZE + ENTRY_INSET + ENTRY_CLEARANCE;

/**
 * The entry's sizes as CSS variables, set on the row that holds the outline
 * and the scroller so both read the same numbers.
 *
 * The entry sits in the gutter with a negative margin that cancels its own
 * width plus the clearance (`DocumentMenuEntry`), which is everything from the
 * padding box's right edge to its own; so padding-box-right to button is the
 * clearance, and button to viewport edge is the inset. The page is capped at
 * `max-w-3xl` and centres inside the padding box, so what it leaves the button
 * is the clearance at the narrow end and more once it stops filling the box.
 * The left gutter is sized by the strips it holds (`BODY_GUTTER_START`).
 */
export const BODY_ROW_VARS = {
  '--doc-entry-size': `${String(ENTRY_SIZE)}px`,
  '--doc-entry-inset': `${String(ENTRY_INSET)}px`,
  '--doc-entry-clearance': `${String(ENTRY_CLEARANCE)}px`,
  '--doc-body-gutter': `${String(BODY_GUTTER_END)}px`,
} as React.CSSProperties;
