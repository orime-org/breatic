// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { readFollowField, type FollowFieldValue } from '@web/data/yjs/follow-presence';

/**
 * Put one value in this client's `view`, keeping the rest of its state. A
 * removed state (the provider's pagehide) is left removed; the restore that
 * sets it back to `{}` is followed by a rewrite.
 * @param awareness - The project meta awareness.
 * @param view - The view, or null to withdraw it.
 */
function writeView(awareness: Awareness, view: FollowFieldValue<'view'> | null): void {
  const state = awareness.getLocalState();
  if (state === null) return;
  awareness.setLocalState({ ...state, view });
}

/**
 * Write the current view, or withdraw it while the browser tab is hidden.
 * @param awareness - The project meta awareness.
 * @param spaceId - The Space in front, or null when no tab is open.
 */
function publishView(awareness: Awareness, spaceId: string | null): void {
  writeView(
    awareness,
    document.visibilityState === 'hidden' ? null : { spaceId, at: Date.now(), focused: document.hasFocus() },
  );
}

/**
 * Publish `view`, the Space this browser tab has in front, on the project's
 * meta awareness so members can follow this user (#920).
 *
 * Written on mount and whenever the Space in front changes, rewritten when the
 * window gains or loses focus, withdrawn (`view: null`, the entry kept) while
 * the browser tab is hidden and written back when it shows again, and written
 * back after something else wiped this client's state (a bfcache restore sets
 * it to `{}`). Every write is direct: a withdrawal must land, and a hidden tab
 * gets no animation frames (`packages/web/AGENTS.md#writes-that-must-land-skip-frame-scheduling`).
 * @param metaAwareness - The project meta document's awareness, or null before it is attached.
 * @param activeSpaceId - The Space in front, or null when no tab is open.
 */
export function usePublishView(metaAwareness: Awareness | null, activeSpaceId: string | null): void {
  // Read by the listeners below, which outlive one value.
  const spaceIdRef = React.useRef(activeSpaceId);

  React.useEffect(() => {
    const awareness = metaAwareness;
    if (!awareness) return undefined;
    /** Rewrite the view for a focus or visibility change. */
    const publish = (): void => {
      publishView(awareness, spaceIdRef.current);
    };
    /**
     * Write the view back when this client's state lost it from outside.
     * @param changes - The awareness change.
     * @param changes.added - Clients that appeared.
     * @param changes.updated - Clients whose state changed.
     */
    const onChange = ({ added, updated }: { added: number[]; updated: number[] }): void => {
      const self = awareness.clientID;
      if (!added.includes(self) && !updated.includes(self)) return;
      if (document.visibilityState === 'hidden') return;
      const state = awareness.getLocalState();
      if (state !== null && readFollowField(state, 'view') === null) publish();
    };
    window.addEventListener('focus', publish);
    window.addEventListener('blur', publish);
    document.addEventListener('visibilitychange', publish);
    awareness.on('change', onChange);
    return () => {
      window.removeEventListener('focus', publish);
      window.removeEventListener('blur', publish);
      document.removeEventListener('visibilitychange', publish);
      awareness.off('change', onChange);
      writeView(awareness, null);
    };
  }, [metaAwareness]);

  React.useEffect(() => {
    spaceIdRef.current = activeSpaceId;
    if (metaAwareness) publishView(metaAwareness, activeSpaceId);
  }, [metaAwareness, activeSpaceId]);
}
