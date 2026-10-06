// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';

import {
  readUserPreferences,
  writeUserPreference,
  type RailSection,
} from '@web/lib/user-preferences-storage';
import { useCurrentUserStore } from '@web/stores/current-user';

/**
 * Whether one Studio rail section is folded, remembered per account. Default
 * is expanded; when storage is unavailable the choice holds for the session.
 *
 * The Studio page sits behind `ProtectedRoute`, so the account is known on
 * the first render, and signing in as someone else goes through `/login` and
 * mounts the rail afresh.
 * @param section - The rail section.
 * @returns The current `collapsed` flag and a `toggle` to flip it.
 */
export function useRailCollapse(section: RailSection): {
  collapsed: boolean;
  toggle: () => void;
} {
  const userId = useCurrentUserStore((s) => s.user?.id);
  const [collapsed, setCollapsed] = React.useState<boolean>(
    () => readUserPreferences(userId).railCollapsed[section],
  );
  const toggle = React.useCallback((): void => {
    const next = !collapsed;
    setCollapsed(next);
    // Read at write time so a section toggled in another tab keeps its value.
    const stored = readUserPreferences(userId).railCollapsed;
    writeUserPreference(userId, { railCollapsed: { ...stored, [section]: next } });
  }, [collapsed, section, userId]);
  return { collapsed, toggle };
}
