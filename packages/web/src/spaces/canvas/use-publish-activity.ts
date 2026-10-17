// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { useSpaceConnection } from '@web/data/yjs/space-connection';
import { activityFromMarks, sameActivityList, type NodeActivity } from '@web/spaces/canvas/node-activity';
import { useUploadMarksStore } from '@web/stores/upload-marks';

/** What the activity publisher needs. */
export interface PublishActivityInput {
  /** This Space's awareness, or null before the document is attached. */
  awareness: Awareness | null;
  /** This Space, whose waiting operations are published. */
  spaceId: string;
  /** Whether this document has finished syncing with the server. */
  synced: boolean;
}

/**
 * The activity this client has for a Space, read from the marks store.
 * @param spaceId - The Space.
 * @returns The waiting nodes, or null when there are none.
 * @throws {never} Never.
 */
function currentActivity(spaceId: string): readonly NodeActivity[] | null {
  const list = activityFromMarks(useUploadMarksStore.getState().marks[spaceId]);
  return list.length === 0 ? null : list;
}

/**
 * Write the activity into awareness, keeping every other field.
 * @param awareness - The awareness.
 * @param activity - The list, or null for none.
 */
function writeActivity(awareness: Awareness, activity: readonly NodeActivity[] | null): void {
  const state = awareness.getLocalState();
  if (state === null) return;
  awareness.setLocalState({ ...state, activity });
}

/**
 * Publish this client's waiting operations on a Space as `activity`
 * (inner#1303 §6.8), the one writer of that field. Mounted with the Space's
 * tab: an operation runs on while the reader looks at another Space, so its
 * line stays on the peers' screens until it is answered or fails or the tab
 * closes. When the page goes, Hocuspocus drops the removal the provider sends
 * on `pagehide`; peers lose the line at once when the server registered this
 * client on that connection, otherwise within the 30 seconds awareness keeps
 * a silent peer.
 *
 * Written in the same task a mark starts or ends: the changes one task makes
 * (a press beginning a mark per tile, a batch answering them) are gathered
 * into one write by a microtask, which runs without animation frames.
 * @param input - The awareness, the Space and the sync state.
 */
export function usePublishActivity(input: PublishActivityInput): void {
  const { awareness, spaceId, synced } = input;

  React.useEffect(() => {
    if (!awareness) return undefined;
    /** Write the activity when it differs from what is published. */
    const publish = (): void => {
      const next = currentActivity(spaceId);
      const state = awareness.getLocalState() as { activity?: unknown } | null;
      const prev = Array.isArray(state?.activity) ? (state.activity as NodeActivity[]) : null;
      if (!sameActivityList(prev, next)) writeActivity(awareness, next);
    };
    let queued = false;
    let live = true;
    const unsubscribe = useUploadMarksStore.subscribe(() => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (live) publish();
      });
    });
    return () => {
      live = false;
      unsubscribe();
      writeActivity(awareness, null);
    };
  }, [awareness, spaceId]);

  // Written on mount and on every reconnect, even though nothing local
  // changed: the peers dropped this state while the socket was closed.
  React.useEffect(() => {
    if (!awareness || !synced) return;
    writeActivity(awareness, currentActivity(spaceId));
  }, [awareness, synced, spaceId]);

  // A restore from the bfcache comes back with the local state emptied.
  React.useEffect(() => {
    if (!awareness) return undefined;
    /**
     * Re-send the activity after a restore from the bfcache.
     * @param event - The pageshow event; `persisted` is true only on a restore.
     */
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) writeActivity(awareness, currentActivity(spaceId));
    };
    window.addEventListener('pageshow', onPageShow);
    return (): void => window.removeEventListener('pageshow', onPageShow);
  }, [awareness, spaceId]);
}

/**
 * The activity publisher for a canvas Space's tab, reading the tab's connection.
 * @param root0 - Props.
 * @param root0.spaceId - The Space.
 * @returns Nothing on screen.
 */
export function CanvasActivityPublisher({ spaceId }: { spaceId: string }): null {
  const { provider, synced } = useSpaceConnection();
  usePublishActivity({ awareness: provider?.awareness ?? null, spaceId, synced });
  return null;
}
