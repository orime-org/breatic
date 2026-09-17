// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How far the canvas zooms, in one place.
 *
 * The canvas hands these to ReactFlow, the fit framing floors itself at the
 * same bottom, and the stored camera is checked against them before it is
 * handed back — three readers who have to agree, because a stored zoom the
 * canvas would refuse leaves the reader on an empty screen with nothing on it
 * saying why.
 */

/** 10%, the furthest out the canvas goes. */
export const CANVAS_MIN_ZOOM = 0.1;

/** 800%, the closest in the canvas goes. */
export const CANVAS_MAX_ZOOM = 8;
