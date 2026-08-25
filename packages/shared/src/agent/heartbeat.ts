// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many beats in a row may go missing before the agent chat stream is
 * called dead.
 *
 * A turn that is thinking looks exactly like a turn that is dead -- an open
 * socket with nothing on it -- and a connection that dies without closing
 * produces no error and no close either, so the only thing that tells them
 * apart is a beat that was supposed to arrive and did not.
 *
 * How *often* they arrive is not here: it is one number in
 * `config/agent.yaml`, which the server beats on and the browser asks for at
 * `GET /chat/stream-config`. This one is not configurable, and the two live
 * apart for that reason.
 */

/**
 * Three.
 *
 * One missed beat is ordinary -- a scheduler that ran late, a garbage
 * collection -- and acting on it would abandon turns that are fine; three in
 * a row is not something a working connection produces. Two would kill turns
 * the server's own collector merely paused, which is why this is written in
 * code rather than offered as a dial: the only thing an operator could tune
 * it to is a higher rate of killing turns that were working.
 */
export const SSE_HEARTBEAT_MISSES_ALLOWED = 3;
