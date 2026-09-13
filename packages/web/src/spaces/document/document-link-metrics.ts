// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two measurements the link faces share.
 *
 * Here rather than in either face: both faces use both, and the panel and the
 * toolbar each render both faces, so a value kept next to one of them would be
 * read from three other places.
 */

/**
 * The height the demo draws the panel's input and buttons at, which is the
 * `--btn-inline` rung.
 *
 * Its own value rather than the bar's `BUBBLE_CONTROL_HEIGHT`: the demo gives
 * the two their heights separately, and they answer to different things — this
 * one to the form controls it holds, the bar's to the toolbar buttons on it.
 * They read the same rung today; either can move without the other.
 */
export const LINK_CONTROL_HEIGHT = 'h-[var(--btn-inline)]';

/**
 * The line height the demo's page gives its text, which decides how tall the
 * address line and the message under a refused address come out.
 */
export const LINK_TEXT_LEADING = 'leading-[1.6]';
