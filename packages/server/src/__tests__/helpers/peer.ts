// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The connection a request arrived on, for `app.request()` in tests.
 *
 * Rate limits on pre-auth routes read the connection's peer address through
 * `getConnInfo`, which reads `c.env.incoming.socket.remoteAddress`. An
 * in-process `app.request()` has no socket, so a test hands one in as the
 * third argument.
 */

/** The bindings `@hono/node-server` gives a handler, reduced to the peer. */
export interface PeerBindings {
  incoming: { socket: { remoteAddress: string } };
}

/**
 * Bindings for a request from the given peer.
 * @param remoteAddress - The peer address.
 * @returns The bindings to pass as `app.request(path, init, bindings)`.
 */
export function peer(remoteAddress: string): PeerBindings {
  return { incoming: { socket: { remoteAddress } } };
}

/** A request from this machine: local dev through the Vite proxy. Not counted. */
export const LOOPBACK_PEER = peer("127.0.0.1");

/** A request that came through our nginx, which sets `x-real-ip`. */
export const PROXY_PEER = peer("172.18.0.4");

/** Anything with Hono's `request`. */
interface Requestable {
  request: (input: string | Request | URL, init?: RequestInit, env?: unknown) => Response | Promise<Response>;
}

/**
 * The same app, with every `request()` arriving from the given peer.
 * @param app - The app.
 * @param bindings - The peer; this machine when absent.
 * @returns A view of the app whose `request` passes the bindings.
 */
export function withPeer<T extends Requestable>(app: T, bindings: PeerBindings = LOOPBACK_PEER): T {
  return new Proxy(app, {
    get(target, prop, receiver) {
      if (prop === "request") {
        return (input: string | Request | URL, init?: RequestInit) => target.request(input, init, bindings);
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
