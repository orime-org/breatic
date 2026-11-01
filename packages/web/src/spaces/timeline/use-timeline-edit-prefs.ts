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

// Switches set in this page whose storage write did not stick, per account; storage answers every other read.
const unsaved = new Map<string, TimelineEditPrefs>();
// The last snapshot per account, returned again while its values are unchanged.
const snapshots = new Map<string, TimelineEditPrefs>();
const listeners = new Set<() => void>();

/**
 * Listen for switch changes made by any Timeline.
 * @param listener - Called after a change.
 * @returns Stops listening.
 * @throws {never} Never.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * One account's current switches, as the same object while they are unchanged.
 * @param userId - The signed-in account, if any.
 * @returns Its switches.
 * @throws {never} Never.
 */
function snapshotOf(userId: string | undefined): TimelineEditPrefs {
  const key = userId ?? '';
  const read = unsaved.get(key) ?? readPrefs(userId);
  const known = snapshots.get(key);
  if (known !== undefined && known.magnet === read.magnet && known.snap === read.snap && known.linkage === read.linkage) return known;
  snapshots.set(key, read);
  return read;
}

/**
 * The signed-in account's main-track magnet, auto snap and linkage switches, stored per account.
 * @returns The switches and a setter that stores a change for this account.
 * @throws {never} Never.
 */
export function useTimelineEditPrefs(): TimelineEditPrefs & { set: (patch: Partial<TimelineEditPrefs>) => void } {
  const userId = useCurrentUserStore((state) => state.user?.id);
  const getSnapshot = React.useCallback(() => snapshotOf(userId), [userId]);
  // A Timeline hidden by Activity re-reads the snapshot when it is shown again.
  const prefs = React.useSyncExternalStore(subscribe, getSnapshot);
  const set = React.useCallback((patch: Partial<TimelineEditPrefs>): void => {
    const key = userId ?? '';
    const next = { ...snapshotOf(userId), ...patch };
    const stored: Partial<UserPreferences> = {};
    if (patch.magnet !== undefined) stored.timelineMagnet = patch.magnet;
    if (patch.snap !== undefined) stored.timelineSnap = patch.snap;
    if (patch.linkage !== undefined) stored.timelineLinkage = patch.linkage;
    writeUserPreference(userId, stored);
    unsaved.delete(key);
    const read = readPrefs(userId);
    if (read.magnet !== next.magnet || read.snap !== next.snap || read.linkage !== next.linkage) unsaved.set(key, next);
    for (const listener of listeners) listener();
  }, [userId]);
  return React.useMemo(() => ({ ...prefs, set }), [prefs, set]);
}
