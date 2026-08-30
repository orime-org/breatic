// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { applyTabMove } from '@breatic/shared';

/** What the tab bar renders, and how a drag tells this layer about itself. */
export interface TabReorderResult {
  /** The order to render: the stored one, or the pending one laid over it. */
  order: ReadonlyArray<string>;
  /**
   * Called when a drag lands. Shows the move at once and sends it.
   * @param spaceId - The tab that moved.
   * @param beforeSpaceId - The tab it landed in front of, null for the end.
   */
  reorder: (spaceId: string, beforeSpaceId: string | null) => void;
}

/** One move waiting for its turn on the wire. */
interface QueuedMove {
  spaceId: string;
  beforeSpaceId: string | null;
}

/**
 * Whether two id lists hold the same ids in the same places.
 * @param a - One list.
 * @param b - The other.
 * @returns True when they are indistinguishable to a reader.
 */
function sameIds(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Show a tab move the moment the user lets go, and let go of that view once
 * the document has caught up.
 *
 * Requests go out one at a time. Collab dispatches stateless messages without
 * awaiting, so two reorders in flight together finish in no fixed order, and
 * relative moves do not commute — the pair could land as an order the user
 * never asked for, persisted.
 *
 * The view is let go of when the document shows the same order it does, and
 * only once nothing is queued and nothing is on the wire. Comparing the two
 * orders rather than counting arrivals is what makes a broadcast that reaches
 * the client ahead of its own reply — which is the ordinary case, since collab
 * broadcasts inside the transaction and answers afterwards — cost nothing.
 * A reply saying the server wrote nothing ends the view outright: no broadcast
 * is coming, and holding on would strand it for good.
 * @param openTabIds - The order as stored, straight from the meta doc.
 * @param send - Sends one move; resolves with whether the server wrote, and
 *   rejects when the request found no answer.
 * @returns What to render, and the callback a landed drag calls.
 */
export function useTabReorder(
  openTabIds: ReadonlyArray<string>,
  send: (spaceId: string, beforeSpaceId: string | null) => Promise<boolean>,
): TabReorderResult {
  const [pending, setPending] = React.useState<ReadonlyArray<string> | null>(
    null,
  );
  /**
   * What `pending` holds, readable without going through a stale closure.
   * A second drag lands on top of the first one's result, so the callback
   * has to see the layer as it stands right now.
   */
  const pendingRef = React.useRef<ReadonlyArray<string> | null>(null);
  /** Moves not yet sent. The one on the wire is not in here. */
  const queue = React.useRef<QueuedMove[]>([]);
  const inFlight = React.useRef(false);
  /** The stored order as it stands right now, readable from a reply. */
  const stored = React.useRef<ReadonlyArray<string>>(openTabIds);

  const sendRef = React.useRef(send);
  sendRef.current = send;

  const clear = React.useCallback((): void => {
    queue.current = [];
    inFlight.current = false;
    pendingRef.current = null;
    setPending(null);
  }, []);

  /**
   * Let go of the view once the document shows what it shows.
   *
   * Two things leave a move unaccounted for: one is still travelling, or one
   * has been written and its broadcast has not arrived. Anything queued is
   * covered by the first — a move leaves the queue and takes the wire in the
   * same breath, so a non-empty queue always means something is in flight.
   * Dropping the layer early snaps the strip back to an order the user has
   * already moved on from, and takes the queued moves with it.
   * @param now - The stored order to compare the layer against.
   */
  const settleIfConfirmed = React.useCallback(
    (now: ReadonlyArray<string>): void => {
      if (inFlight.current) return;
      const layer = pendingRef.current;
      if (layer !== null && !sameIds(now, layer)) return;
      clear();
    },
    [clear],
  );

  const pump = React.useCallback((): void => {
    if (inFlight.current) return;
    const next = queue.current.shift();
    if (!next) return;
    inFlight.current = true;
    void sendRef
      .current(next.spaceId, next.beforeSpaceId)
      .then((orderChanged) => {
        inFlight.current = false;
        if (queue.current.length > 0) {
          pump();
          return;
        }
        // A server that wrote nothing broadcasts nothing, so there is no
        // arrival to wait for and the document is already what it will be.
        if (!orderChanged) {
          clear();
          return;
        }
        settleIfConfirmed(stored.current);
      })
      .catch(() => {
        // The caller surfaced the failure. Everything shown optimistically
        // goes back to what the document says — including moves queued
        // behind this one, which were computed on top of it.
        clear();
      });
  }, [clear, settleIfConfirmed]);

  const reorder = React.useCallback(
    (spaceId: string, beforeSpaceId: string | null): void => {
      const base = pendingRef.current ?? openTabIds;
      const next = applyTabMove(base, spaceId, beforeSpaceId);
      // The tab landed where it already was. Sending it would ask collab to
      // do nothing and, when collab is unreachable, raise a failure for an
      // action that needed nothing from it.
      if (sameIds(next, base)) return;
      pendingRef.current = next;
      setPending(next);
      queue.current.push({ spaceId, beforeSpaceId });
      pump();
    },
    [openTabIds, pump],
  );

  // Every arriving document state is a chance for the layer to be done with.
  // Presence heartbeats rerun this projection without changing a thing, and
  // they cost nothing here: an order that already matched was let go of on the
  // arrival that made it match.
  React.useEffect(() => {
    stored.current = openTabIds;
    if (pending === null) return;
    settleIfConfirmed(openTabIds);
  }, [openTabIds, pending, settleIfConfirmed]);

  return { order: pending ?? openTabIds, reorder };
}
