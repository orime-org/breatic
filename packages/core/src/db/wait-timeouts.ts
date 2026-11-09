// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reports each wait that ran out of time (#1435, #1047): a query or
 * transaction that waited `queue_timeout` for a pooled connection, or a
 * connection attempt that took `connect_timeout`. A reserve that times out is
 * not reported, as postgres.js publishes nothing for it; production code does
 * not reserve. postgres.js publishes them on
 * Node diagnostics channels; this module turns them into one report per wait,
 * with the state of the main and Yjs pools, for the service entry to log.
 *
 * Reading a report: `connections` 0 with `opening` above 0 means the database
 * does not answer; `connections` equal to `max` with `idle` 0 means every
 * connection is busy (leased by a transaction, its pipeline full, or running a
 * query while a transaction waits for a quiet one), and `leased` says how many
 * of them a transaction holds. `waiting` leaves out the query that timed out,
 * which leaves the queue before it is rejected. With equal limits a request may
 * fail with QUEUE_TIMEOUT while the database is unreachable, because its queue
 * timer starts before the connection attempt it causes, so the pool state, not
 * the code, tells the two apart. A wait on a pool other than these two, such
 * as the connection postgres.js keeps for `listen`, is reported too, with the
 * main and Yjs pools' state; a report in which both look idle is one of those.
 */

import { tracingChannel, type TracingChannelSubscribers } from "node:diagnostics_channel";
import { poolStates, type PoolState } from "@core/db/client.js";

/** One wait that ran out of time. */
export interface DatabaseWaitTimeout {
  /** `QUEUE_TIMEOUT` (no connection became free) or `CONNECT_TIMEOUT` (opening one took too long). */
  readonly code: "QUEUE_TIMEOUT" | "CONNECT_TIMEOUT";
  /** The database the pool connects to. */
  readonly database: string | undefined;
  /** The main and Yjs pools when it happened; null for a pool not built yet. */
  readonly pools: { main: PoolState | null; yjs: PoolState | null };
}

/** What postgres.js puts on its query, transaction and connect channels. */
interface ChannelContext {
  error?: { code?: unknown };
  database?: string;
  connection?: number | null;
}

/**
 * Subscribe to every wait that runs out of time, in this process.
 *
 * A queue timeout is taken from the query channel, and from the transaction
 * channel only when the transaction itself got no connection: a transaction
 * whose body hit the limit has a connection and its query was already reported.
 * A connect timeout is taken from the connect channel, once per attempt; the
 * same code on the query channel belongs to requests rejected because that
 * attempt failed.
 * @param listener - Called once per wait that ran out of time.
 * @returns A function that stops the subscription.
 */
export function onDatabaseWaitTimeout(listener: (event: DatabaseWaitTimeout) => void): () => void {
  /**
   * Hand one wait that ran out of time to the listener, with the pools' state.
   * @param code - Which wait ran out.
   * @param ctx - The channel context it was published with.
   */
  const report = (code: DatabaseWaitTimeout["code"], ctx: ChannelContext): void => {
    listener({ code, database: ctx.database, pools: poolStates() });
  };
  const subscriptions: [string, Partial<TracingChannelSubscribers<ChannelContext>>][] = [
    ["postgres:query", { error: (ctx) => ctx.error?.code === "QUEUE_TIMEOUT" && report("QUEUE_TIMEOUT", ctx) }],
    [
      "postgres:transaction",
      { error: (ctx) => ctx.error?.code === "QUEUE_TIMEOUT" && ctx.connection == null && report("QUEUE_TIMEOUT", ctx) },
    ],
    ["postgres:connect", { error: (ctx) => ctx.error?.code === "CONNECT_TIMEOUT" && report("CONNECT_TIMEOUT", ctx) }],
  ];
  for (const [name, handlers] of subscriptions) tracingChannel<unknown, ChannelContext>(name).subscribe(handlers as TracingChannelSubscribers<ChannelContext>);
  return () => {
    for (const [name, handlers] of subscriptions) tracingChannel<unknown, ChannelContext>(name).unsubscribe(handlers as TracingChannelSubscribers<ChannelContext>);
  };
}
