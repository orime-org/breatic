// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { create } from 'zustand';

import { readUserPreferences, writeUserPreference, type UserPreferences } from '@web/lib/user-preferences-storage';

/** The editing user's Timeline switches. */
export interface TimelineEditPrefs { magnet: boolean; snap: boolean; linkage: boolean }

/** One copy of the switches for every open Timeline, loaded for one account at a time. */
interface TimelineEditPrefsState extends TimelineEditPrefs {
  /** The account the switches were read for; null before the first read. */
  owner: string | undefined | null;
  restore: (userId: string | undefined) => void;
  set: (patch: Partial<TimelineEditPrefs>) => void;
}

/**
 * Timeline switches shared by every open Timeline, read once per account and stored on change.
 * @returns The store hook.
 * @throws {never} Never.
 */
export const useTimelineEditPrefsStore = create<TimelineEditPrefsState>()((setState, get) => ({
  owner: null,
  magnet: true,
  snap: true,
  linkage: true,
  restore: (userId) => {
    const stored = readUserPreferences(userId);
    setState({ owner: userId, magnet: stored.timelineMagnet, snap: stored.timelineSnap, linkage: stored.timelineLinkage });
  },
  set: (patch) => {
    setState(patch);
    const stored: Partial<UserPreferences> = {};
    if (patch.magnet !== undefined) stored.timelineMagnet = patch.magnet;
    if (patch.snap !== undefined) stored.timelineSnap = patch.snap;
    if (patch.linkage !== undefined) stored.timelineLinkage = patch.linkage;
    writeUserPreference(get().owner ?? undefined, stored);
  },
}));
