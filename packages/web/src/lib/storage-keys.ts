// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Central registry of every browser-persisted (localStorage) key.
 *
 * One project-wide rule, enforced by `lint:storage-key-prefix`: every
 * persisted key carries the `breatic.` prefix, so the app's keys never
 * collide with another tenant on the same origin, a browser extension, or a
 * future sibling app. Add new keys HERE and reference `STORAGE_KEYS.*` at the
 * callsite — never hardcode a bare key string in a component or store.
 *
 * One known exception lives outside this module by necessity: the pre-React
 * inline script in `src/index.html` reads `breatic.preferences` directly to
 * set the theme before the module graph loads (it runs before `index.tsx`
 * and so cannot `import` this file). If you ever change the `preferences`
 * key value, update that inline `<script>` too.
 */

/** The prefix every persisted key must carry (enforced by lint:storage-key-prefix). */
export const STORAGE_PREFIX = 'breatic.';

/**
 * Every localStorage key the web app uses, in one place. Values are written
 * out in full (rather than composed from STORAGE_PREFIX) so they read
 * identically to what appears in the browser's storage inspector; the prefix
 * invariant is verified by the unit test, not the type system.
 */
export const STORAGE_KEYS = {
  /** Explicit locale choice — i18n bootstrap resolution chain step 1. */
  locale: 'breatic.locale',
  /** Zustand-persisted user preferences (theme). Mirrored in `src/index.html`. */
  preferences: 'breatic.preferences',
  /** Rail "My studios" section collapsed flag (Discord-style expand / collapse). */
  railMyStudios: 'breatic.myStudios',
  /** Rail "Joined studios" section collapsed flag. */
  railJoinedStudios: 'breatic.joinedStudios',
} as const;

/** Union of every valid persisted key value. */
export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
