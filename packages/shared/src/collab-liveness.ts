// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The collab connection's liveness rhythm, which both ends size against.
 *
 * collab's transport (crossws) pings every connection once per
 * {@link COLLAB_PING_INTERVAL_MS}; it has no setting for this, and collab's
 * `connection_ping_interval_ms` declares the same value. Each pong makes
 * collab write the user's presence, so the browser hears from collab at least
 * once per period even while a long chunked upload holds back its own
 * awareness renewals (inner#1585).
 */

/** How often collab's transport pings every connection, in milliseconds. */
export const COLLAB_PING_INTERVAL_MS = 30_000;
