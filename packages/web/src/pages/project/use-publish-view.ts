// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import type { Awareness } from 'y-protocols/awareness';

import { readFollowField, type FollowFieldValue } from '@web/data/yjs/follow-presence';
import { useFollowStore } from '@web/stores/follow';

/** Whom this tab follows, as it goes out on the wire. */
type Following = FollowFieldValue<'following'>;

/**
 * Put `view` and `following` in this client's state, keeping the rest of it.
 * A removed state (the provider's pagehide) is left removed; the restore that
 * sets it back to `{}` is followed by a rewrite.
 * @param awareness - The project meta awareness.
 * @param view - The view, or null to withdraw it.
 * @param following - Whom this tab follows, or null.
 */
function writeFields(awareness: Awareness, view: FollowFieldValue<'view'> | null, following: Following | null): void {
  const state = awareness.getLocalState();
  if (state === null) return;
  awareness.setLocalState({ ...state, view, following });
}

/**
 * Write the current view and whom this tab follows; while the browser tab is
 * hidden the view is withdrawn and the following kept, as the user still
 * follows from it.
 * @param awareness - The project meta awareness.
 * @param spaceId - The Space in front, or null when no tab is open.
 * @param following - Whom this tab follows, or null.
 */
function publishView(awareness: Awareness, spaceId: string | null, following: Following | null): void {
  writeFields(
    awareness,
    document.visibilityState === 'hidden' ? null : { spaceId, at: Date.now(), focused: document.hasFocus() },
    following,
  );
}

/**
 * Publish `view`, the Space this browser tab has in front, and `following`,
 * whom this tab follows and since when, on the project's meta awareness so
 * members can follow this user and nobody follows a member who is following
 * someone (#920).
 *
 * Written on mount and whenever the Space in front or the followed member
 * changes, rewritten when the window gains or loses focus, `view` withdrawn
 * (the entry and `following` kept) while the browser tab is hidden and written
 * back when it shows again, both withdrawn on unmount, and written back after
 * something else wiped this client's state (a bfcache restore sets it to
 * `{}`). Every write is direct: a withdrawal must land, and a hidden tab gets
 * no animation frames (`packages/web/AGENTS.md#writes-that-must-land-skip-frame-scheduling`).
 * @param metaAwareness - The project meta document's awareness, or null before it is attached.
 * @param activeSpaceId - The Space in front, or null when no tab is open.
 */
export function usePublishView(metaAwareness: Awareness | null, activeSpaceId: string | null): void {
  const followedId = useFollowStore((s) => s.targetUserId);
  // Read by the listeners below, which outlive one value.
  const spaceIdRef = React.useRef(activeSpaceId);
  // Its `at` is when following this member started, so it holds still while the same member is followed.
  const followingRef = React.useRef<Following | null>(null);

  React.useEffect(() => {
    const awareness = metaAwareness;
    if (!awareness) return undefined;
    /** Rewrite the view for a focus or visibility change. */
    const publish = (): void => {
      publishView(awareness, spaceIdRef.current, followingRef.current);
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
      writeFields(awareness, null, null);
    };
  }, [metaAwareness]);

  React.useEffect(() => {
    spaceIdRef.current = activeSpaceId;
    const previous = followingRef.current;
    followingRef.current = followedId === null ? null
      : previous?.id === followedId ? previous : { id: followedId, at: Date.now() };
    if (metaAwareness) publishView(metaAwareness, activeSpaceId, followingRef.current);
  }, [metaAwareness, activeSpaceId, followedId]);
}
