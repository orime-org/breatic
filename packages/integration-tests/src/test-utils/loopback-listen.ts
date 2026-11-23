// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Setup file: a test server listens on 127.0.0.1, the address tests connect to
 * (#1478).
 *
 * A port listened on every address can also be held on 127.0.0.1 by another
 * local process (macOS hands such a port out to a port-0 listen), and that
 * process then takes the test's connections: the local ingest Workers answer a
 * WebSocket handshake with 404. A listen on a port without a host therefore
 * throws here. Unix socket paths and existing handles carry no port and pass.
 */

import net from "node:net";

const REFUSAL =
  "A test server must listen on 127.0.0.1 (pass the host or address option): " +
  "a port bound on every address can be held on 127.0.0.1 by another local process, " +
  "which then takes the test's connections (#1478).";

/**
 * Whether a `listen` call binds a port on every address.
 * @param args - The arguments `listen` was called with.
 * @returns True when a port is listened on without a host.
 */
function bindsEveryAddress(args: readonly unknown[]): boolean {
  const [first, second] = args;
  if (typeof first === "object" && first !== null) {
    if ("fd" in first || "_handle" in first) return false;
    const options = first as net.ListenOptions;
    return options.path === undefined && options.host === undefined;
  }
  // Node reads a string that is not a number as a unix socket path.
  if (typeof first === "string" && !/^\d+$/.test(first)) return false;
  return typeof second !== "string";
}

const listen = net.Server.prototype.listen;

net.Server.prototype.listen = function guardedListen(this: net.Server, ...args: unknown[]): net.Server {
  if (bindsEveryAddress(args)) throw new Error(REFUSAL);
  return (listen as (...a: unknown[]) => net.Server).apply(this, args);
} as typeof listen;
