// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { isUnanswered } from '@web/data/yjs/space-rpc-client';
import {
  changesNothing,
  landedCount,
  nextUnsent,
  retire,
  rollbackFrom,
  withMoves,
  type OwedMove,
} from '@web/pages/project/pending-moves';

/** What the tab bar renders, and how a drag tells this layer about itself. */
export interface TabReorderResult {
  /** The order to render: the stored one with the owed moves laid over it. */
  order: ReadonlyArray<string>;
  /**
   * Called when a drag lands. Shows the move at once and sends it.
   * @param spaceId - The tab that moved.
   * @param beforeSpaceId - The tab it landed in front of, null for the end.
   */
  reorder: (spaceId: string, beforeSpaceId: string | null) => void;
}

/**
 * Show a tab move the moment the user lets go, and stop showing it once the
 * document says the same thing.
 *
 * What is held is the run of moves the document has not accounted for, not a
 * copy of the order. Everything else about the tab list — a Space a
 * collaborator deleted, a tab this account opened on another machine — reaches
 * the strip the moment it arrives, with the owed moves laid back over it. A
 * move stops being owed when applying it to the arriving order changes
 * nothing, which is the same question whatever else came with it.
 *
 * Requests go out one at a time. Collab dispatches stateless messages without
 * awaiting, so two reorders in flight together finish in no fixed order, and
 * relative moves do not commute — the pair could land as an order the user
 * never asked for, persisted.
 * @param openTabIds - The order as stored, straight from the meta doc.
 * @param send - Sends one move; resolves with whether the server wrote, and
 *   rejects when the request found no answer.
 * @returns What to render, and the callback a landed drag calls.
 */
export function useTabReorder(
  openTabIds: ReadonlyArray<string>,
  send: (spaceId: string, beforeSpaceId: string | null) => Promise<boolean>,
): TabReorderResult {
  const [owed, setOwed] = React.useState<ReadonlyArray<OwedMove>>([]);
  /**
   * What `owed` holds, readable without going through a stale closure. A
   * second drag lands on top of the first one's result, and a reply has to
   * see the run as it stands right now.
   */
  const owedRef = React.useRef<ReadonlyArray<OwedMove>>([]);
  /**
   * The moves that have gone out. One stays here until it stops being owed,
   * so the pump never sends the same move twice while it waits for its
   * broadcast.
   */
  const sent = React.useRef<ReadonlySet<number>>(new Set());
  /** Whether the wire is busy. Requests go out one at a time. */
  const inFlight = React.useRef(false);
  const lastId = React.useRef(0);

  const sendRef = React.useRef(send);
  sendRef.current = send;

  const order = React.useMemo(
    () => withMoves(openTabIds, owed),
    [openTabIds, owed],
  );
  const orderRef = React.useRef(order);
  orderRef.current = order;

  const commit = React.useCallback((next: ReadonlyArray<OwedMove>): void => {
    owedRef.current = next;
    sent.current = new Set(
      [...sent.current].filter((id) => next.some((m) => m.id === id)),
    );
    setOwed(next);
  }, []);

  const pump = React.useCallback((): void => {
    if (inFlight.current) return;
    const next = nextUnsent(owedRef.current, sent.current);
    if (!next) return;
    sent.current = new Set(sent.current).add(next.id);
    inFlight.current = true;
    void sendRef
      .current(next.spaceId, next.beforeSpaceId)
      .then((wrote) => {
        if (!wrote) {
          // The server wrote nothing, so no arrival will ever account for
          // this one. It stops being owed here or never.
          commit(retire(owedRef.current, next.id));
        }
      })
      .catch((err: unknown) => {
        if (isUnanswered(err)) {
          // The request went out and drew no answer, so the server may have
          // written this move. Rolling back would undo something that
          // happened, and the strip keeps what the user let go of. Whether
          // the server took it stays open: nothing the client can wait for
          // settles that, and the strip and the document being out of step
          // is what reloading the page resolves.
          return;
        }
        // The server said no. This move goes back, and so do the ones behind
        // it — each was computed on top of the one before.
        commit(rollbackFrom(owedRef.current, next.id));
      })
      .finally(() => {
        // Both endings free the wire and look for the next move, so neither
        // can be the one that forgot to.
        inFlight.current = false;
        pump();
      });
  }, [commit]);

  const reorder = React.useCallback(
    (spaceId: string, beforeSpaceId: string | null): void => {
      const base = orderRef.current;
      // The tab landed where it already was. Sending it would ask collab to
      // do nothing and, when collab is unreachable, raise a failure for an
      // action that needed nothing from it.
      if (changesNothing(base, { id: 0, spaceId, beforeSpaceId })) return;
      lastId.current += 1;
      commit([
        ...owedRef.current,
        { id: lastId.current, spaceId, beforeSpaceId },
      ]);
      pump();
    },
    [commit, pump],
  );

  // Every arriving document state settles what it can. Presence heartbeats
  // rerun this projection without changing the order, and they cost nothing:
  // a move the order already shows was dropped on the arrival that made it so.
  React.useEffect(() => {
    const landed = landedCount(openTabIds, owedRef.current);
    if (landed === 0) return;
    commit(owedRef.current.slice(landed));
  }, [openTabIds, commit]);

  return { order, reorder };
}
