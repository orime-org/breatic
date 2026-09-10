// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a socket answering its ping proves, and everything that rides on it.
 *
 * There is more than one fact hanging off this one signal — a seat per
 * document the socket carries, and the presence record of whoever owns its
 * meta connection — and they are only ever refreshed together. Written as two
 * calls inside the callback passed to the per-socket table, one of them can go
 * missing without anything noticing: the module it belongs to keeps passing
 * its own tests, because those call it directly.
 *
 * That is not hypothetical. Presence went a whole change without being wired
 * to the pong while its expiry was cut to two ping periods, and every test in
 * the package stayed green.
 */

import type { PresencePolicy } from "@collab/hooks/presence-wiring.js";
import { refreshPresenceForSocket } from "@collab/hooks/presence-wiring.js";
import type { SocketConnection } from "@collab/hooks/presence-wiring.js";

/** What refreshing a socket's facts needs. */
export interface SocketLivenessDeps {
  /** Move every seat this socket holds forward. */
  refreshSeats: (socketId: string) => Promise<void>;
  /** Clock and presence threshold. */
  presencePolicy: PresencePolicy;
}

/**
 * Build the callback the per-socket table calls on every pong.
 * @param deps - See {@link SocketLivenessDeps}.
 * @returns The callback, taking the socket and what it carries.
 */
export function createPongHandler(
  deps: SocketLivenessDeps,
): (
  socketId: string,
  connections: ReadonlyMap<string, SocketConnection>,
) => void {
  const { refreshSeats, presencePolicy } = deps;
  return (socketId, connections): void => {
    void refreshSeats(socketId);
    refreshPresenceForSocket(connections, presencePolicy);
  };
}
