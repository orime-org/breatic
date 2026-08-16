// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How long one line about something going wrong stays on screen.
 *
 * It goes away on its own because it is an event, not a state: the reader was
 * told, and a reader who was looking elsewhere is not owed it later. Four
 * seconds is what every other one-off message in this app lasts -- the toast
 * library's own default, which the rest of the product uses unchanged.
 *
 * Shared so the two places that show such a line agree: the line above the
 * composer, and the one at the foot of the conversation list.
 */
export const NOTICE_LINGERS_MS = 4000;
