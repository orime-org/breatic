// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import { readUserPreferences, writeUserPreference, type UserPreferences } from '@web/lib/user-preferences-storage';
import { useCurrentUserStore } from '@web/stores';

/** The editing user's Timeline switches. */
export interface TimelineEditPrefs { magnet: boolean; snap: boolean; linkage: boolean }

/**
 * Read one account's Timeline switches.
 * @param userId - The signed-in account, if any.
 * @returns Its switches, each defaulting to on.
 * @throws {never} Never.
 */
function readPrefs(userId: string | undefined): TimelineEditPrefs {
  const stored = readUserPreferences(userId);
  return { magnet: stored.timelineMagnet, snap: stored.timelineSnap, linkage: stored.timelineLinkage };
}

// Every mounted Timeline hears a change any of them makes, so open tabs show the same switches.
const listeners = new Set<(owner: string | undefined, patch: Partial<TimelineEditPrefs>) => void>();

/**
 * The signed-in account's main-track magnet, auto snap and linkage switches, stored per account.
 * @returns The switches and a setter that stores a change for this account.
 * @throws {never} Never.
 */
export function useTimelineEditPrefs(): TimelineEditPrefs & { set: (patch: Partial<TimelineEditPrefs>) => void } {
  const userId = useCurrentUserStore((state) => state.user?.id);
  const [held, setHeld] = React.useState(() => ({ userId, prefs: readPrefs(userId) }));
  const current = held.userId === userId ? held : { userId, prefs: readPrefs(userId) };
  if (current !== held) setHeld(current);
  const latest = React.useRef(current);
  latest.current = current;
  React.useEffect(() => {
    /**
     * Apply a change made by any Timeline for this account.
     * @param owner - The account that changed its switches.
     * @param patch - The changed switches.
     * @throws {never} Never.
     */
    const hear = (owner: string | undefined, patch: Partial<TimelineEditPrefs>): void => {
      setHeld((previous) => previous.userId === owner ? { userId: owner, prefs: { ...previous.prefs, ...patch } } : previous);
    };
    listeners.add(hear);
    return () => { listeners.delete(hear); };
  }, []);
  const set = React.useCallback((patch: Partial<TimelineEditPrefs>): void => {
    const owner = latest.current.userId;
    const stored: Partial<UserPreferences> = {};
    if (patch.magnet !== undefined) stored.timelineMagnet = patch.magnet;
    if (patch.snap !== undefined) stored.timelineSnap = patch.snap;
    if (patch.linkage !== undefined) stored.timelineLinkage = patch.linkage;
    writeUserPreference(owner, stored);
    for (const listener of listeners) listener(owner, patch);
  }, []);
  return React.useMemo(() => ({ ...current.prefs, set }), [current.prefs, set]);
}
