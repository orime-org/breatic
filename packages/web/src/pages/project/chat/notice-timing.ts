// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How long one line about something going wrong stays on screen.
 *
 * It goes away on its own because it is an event, not a state: the reader was
 * told, and a reader who was looking elsewhere is not owed it later. Four
 * seconds, which is a second longer than a toast gets: `App.tsx` sets the
 * Toaster to three, shorter than the library's own four, because a toast
 * hovers over what the reader is working on. This line does not hover over
 * anything -- it sits in the list or above the composer it is about -- so it
 * can afford the library's original figure.
 *
 * Shared so the three places that show such a line agree: the line above the
 * composer, the one drawn against a row of the conversation list (or against
 * the list itself), and the one at the foot of that list.
 */
export const NOTICE_LINGERS_MS = 4000;
