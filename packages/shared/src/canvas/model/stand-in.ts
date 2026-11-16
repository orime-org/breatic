// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A param that stands in for another (#2156, design §16.2).
 *
 * Gemini reads its script either in one voice or as a dialogue between named
 * speakers, and ignores the voice once speakers are given. Its yaml says so
 * with `replaces` on `speakers`; the panel offers the two as a switch, and
 * only the side the user is on goes to the upstream.
 *
 * Which side that is lives in the model's own param record under
 * `STAND_IN_ON`, so leaving the dialogue keeps the speakers the user
 * wrote (the approved demo: switching back to a single voice keeps them, and
 * they are simply not sent).
 */

export { isStandInOn, speakersShort, standInOf, STAND_IN_ON, wireParams, withStandInOn, type StandIn } from '@shared/canvas/dialogue.js';
