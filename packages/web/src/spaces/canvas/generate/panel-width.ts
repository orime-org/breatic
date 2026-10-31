// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How wide the image, video and audio generate panels are on screen, at most
 * (inner#1345). Placing a template reads it to keep the guide text node clear
 * of the panel that opens under the anchor.
 */
export const GENERATE_PANEL_WIDTH_PX = 600;

/** The panels' width style: the width above, or 92% of a narrower window. */
export const GENERATE_PANEL_WIDTH_STYLE = { width: GENERATE_PANEL_WIDTH_PX, maxWidth: '92vw' } as const;
