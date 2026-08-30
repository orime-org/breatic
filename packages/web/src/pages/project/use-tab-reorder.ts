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
 * The reply says whether the server changed anything, which is what decides
 * how the pending view ends. It changed something: a broadcast is on its way,
 * so hold the view until the stored order really moves, otherwise the bar
 * flashes back to where it was and forward again. It changed nothing: no
 * broadcast is coming and holding on would strand the view for good.
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
  /** The stored order this layer is waiting to see move. */
  const awaited = React.useRef<ReadonlyArray<string> | null>(null);

  const sendRef = React.useRef(send);
  sendRef.current = send;

  const clear = React.useCallback((): void => {
    queue.current = [];
    inFlight.current = false;
    awaited.current = null;
    pendingRef.current = null;
    setPending(null);
  }, []);

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
        // Nothing left to send. A server that wrote will broadcast, so keep
        // the view until that lands; one that wrote nothing never will.
        if (orderChanged) return;
        clear();
      })
      .catch(() => {
        // The caller surfaced the failure. Everything shown optimistically
        // goes back to what the document says — including moves queued
        // behind this one, which were computed on top of it.
        clear();
      });
  }, [clear]);

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
      awaited.current = openTabIds;
      pump();
    },
    [openTabIds, pump],
  );

  // The broadcast this layer was waiting for: the stored order really moved.
  React.useEffect(() => {
    if (pending === null) return;
    const waitingFor = awaited.current;
    if (waitingFor === null) return;
    if (sameIds(openTabIds, waitingFor)) return;
    clear();
  }, [openTabIds, pending, clear]);

  return { order: pending ?? openTabIds, reorder };
}
