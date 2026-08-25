// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import type { ActiveNodeSources } from '@web/spaces/canvas/active-node-ids';
import { deriveActiveNodeIds, sameIdList } from '@web/spaces/canvas/active-node-ids';

/** The awareness field this hook owns. */
const FIELD = 'activeNodeIds';

/** What the publisher needs to keep `activeNodeIds` truthful. */
export interface PublishActiveNodesInput {
  /** This space's awareness, or null before the document is attached. */
  awareness: Awareness | null;
  /** The three local sources of the holding. */
  sources: ActiveNodeSources;
  /** Whether the document's connection is currently synced. */
  connected: boolean;
}

/**
 * Read back what this client last got into the awareness state.
 * @param awareness - The awareness to read.
 * @returns The published ids, or null when the field is empty or absent.
 */
function readPublished(awareness: Awareness): readonly string[] | null {
  const state = awareness.getLocalState() as Record<string, unknown> | null;
  const value = state?.[FIELD];
  return Array.isArray(value) ? (value as string[]) : null;
}

/**
 * Publish which nodes this client holds into the `activeNodeIds` awareness
 * field — the single writer of that field.
 *
 * Writes are batched into an animation frame: during a rubber-band drag the
 * holding genuinely changes on every pointer move, which de-duplication cannot
 * damp because each value really is new.
 *
 * The de-duplication compares against the value read back out of awareness
 * rather than a local copy, so a state removed from the outside reads as a
 * difference and gets re-sent. Two moments need a nudge because the sources do
 * not move across them at all. A bfcache round trip needs one write: the
 * provider drops the local state on the way in and restores an empty one, and
 * that emptiness is itself the difference. A reconnect needs the write to skip
 * de-duplication entirely: the state survived the close intact, so nothing
 * differs locally, while the peers dropped it — and neither side's clock
 * advanced while the socket was closed, so a re-send carrying the old clock
 * would be discarded as already seen.
 * @param input - The awareness, the sources, and the connection state.
 */
export function usePublishActiveNodes(input: PublishActiveNodesInput): void {
  const { awareness, sources, connected } = input;
  const { selectedIds, pickSession, focusTargetId } = sources;

  // Read inside the frame callback instead of closing over the value, so a
  // frame scheduled just before a change still publishes the latest holding.
  const latest = React.useRef(sources);
  latest.current = sources;

  // `force` skips the de-duplication for one write; it is a ref rather than
  // state so setting it never schedules a render of its own.
  const force = React.useRef(false);
  const frame = React.useRef<number | null>(null);

  const publish = React.useCallback((): void => {
    if (!awareness) return;
    frame.current = null;
    const next = deriveActiveNodeIds(latest.current);
    const skip = !force.current && sameIdList(readPublished(awareness), next);
    force.current = false;
    if (skip) return;
    awareness.setLocalStateField(FIELD, next);
  }, [awareness]);

  const schedule = React.useCallback((): void => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(publish);
  }, [publish]);

  React.useEffect(() => {
    if (!awareness) return undefined;
    schedule();
    return (): void => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [awareness, schedule, selectedIds, pickSession, focusTargetId]);

  // Reconnect. `connected` starts true on a healthy mount, so this also covers
  // the first publish being scheduled before the document finished syncing.
  React.useEffect(() => {
    if (!awareness || !connected) return;
    force.current = true;
    schedule();
  }, [awareness, connected, schedule]);

  // bfcache restore.
  React.useEffect(() => {
    if (!awareness) return undefined;
    /**
     * Re-send the holding after a restore from the bfcache.
     * @param event - The pageshow event; only a restore carries `persisted`.
     */
    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      schedule();
    };
    window.addEventListener('pageshow', onPageShow);
    return (): void => window.removeEventListener('pageshow', onPageShow);
  }, [awareness, schedule]);

  // Withdraw. Leaving the space must take the holding with it, and this runs
  // after the frame above was cancelled, so it is the last word.
  React.useEffect(() => {
    if (!awareness) return undefined;
    return (): void => {
      awareness.setLocalStateField(FIELD, null);
    };
  }, [awareness]);
}
