// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** One value per open Space, kept for as long as the Space's tab. */
export interface SpaceRegistry<T> {
  /**
   * The Space's value, created on first use.
   * @param spaceId - The Space.
   * @returns Its value; the same one until the Space is dropped.
   */
  of: (spaceId: string) => T;
  /**
   * Forget a Space's value, when its tab is closed.
   * @param spaceId - The Space.
   */
  drop: (spaceId: string) => void;
  /** Forget every value, when the project is left. */
  clear: () => void;
}

/**
 * A registry of one value per open Space: created on first use, dropped when
 * the tab is closed, all cleared when the project is left.
 * @param create - Builds a Space's value the first time it is asked for.
 * @returns The registry.
 */
export function createSpaceRegistry<T>(create: () => T): SpaceRegistry<T> {
  const values = new Map<string, T>();
  return {
    of: (spaceId) => {
      let value = values.get(spaceId);
      if (value === undefined) {
        value = create();
        values.set(spaceId, value);
      }
      return value;
    },
    drop: (spaceId) => {
      values.delete(spaceId);
    },
    clear: () => {
      values.clear();
    },
  };
}
