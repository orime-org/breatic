// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useCurrentUserStore } from '@web/stores';
import { useTimelineEditPrefsStore, type TimelineEditPrefs } from '@web/stores/timeline-edit-prefs';

/**
 * The signed-in account's main-track magnet, auto snap and linkage switches, stored per account.
 * @returns The switches and a setter that stores a change for this account.
 * @throws {never} Never.
 */
export function useTimelineEditPrefs(): TimelineEditPrefs & { set: (patch: Partial<TimelineEditPrefs>) => void } {
  const userId = useCurrentUserStore((state) => state.user?.id);
  const prefs = useTimelineEditPrefsStore(useShallow((state) => ({ magnet: state.magnet, snap: state.snap, linkage: state.linkage, set: state.set })));
  // Load this account's switches before paint whenever the store holds another account's.
  React.useLayoutEffect(() => {
    const store = useTimelineEditPrefsStore.getState();
    if (store.owner !== userId) store.restore(userId);
  }, [userId]);
  return prefs;
}
