// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Central registry of every browser-persisted (localStorage and
 * sessionStorage) key.
 *
 * One project-wide rule, enforced by the `breatic/storage-key-prefix` ESLint
 * rule and, for the inline script in index.html that cannot import this file,
 * by the storage-key-prefix-html check: every
 * persisted key carries the `breatic.` prefix, so the app's keys never
 * collide with another tenant on the same origin, a browser extension, or a
 * future sibling app. Add new keys HERE and reference `STORAGE_KEYS.*` at the
 * callsite — never hardcode a bare key string in a component or store.
 *
 * Values are stored plain: a string as itself, a boolean or number as JSON.
 * What belongs to one account lives in one key keyed by account id.
 *
 * One known exception lives outside this module by necessity: the pre-React
 * inline script in `src/index.html` reads `breatic.theme` directly to set the
 * theme before the module graph loads (it runs before `index.tsx` and so
 * cannot `import` this file). If you ever change the `theme` key value,
 * update that inline `<script>` too.
 */

/** The prefix every persisted key must carry. */
export const STORAGE_PREFIX = 'breatic.';

/**
 * Every browser-persisted (localStorage and sessionStorage) key the web app
 * uses, in one place. Values are written out in full (rather than composed
 * from STORAGE_PREFIX) so they read identically to what appears in the
 * browser's storage inspector; the prefix invariant is verified by the unit
 * test, not the type system.
 */
export const STORAGE_KEYS = {
  /** Explicit locale choice — i18n bootstrap resolution chain step 1. */
  locale: 'breatic.locale',
  /** `dark` / `light` / `system`. Read by the inline script in `src/index.html`. */
  theme: 'breatic.theme',
  /**
   * Per account, then per project: the Space tab strip, each tab's camera, and
   * whether the Agent panel is open. See `project-tabs-storage`.
   */
  projectTabs: 'breatic.projectTabs',
  /**
   * Per account: the Agent column width, the Studio rail sections, the canvas
   * minimap and snap. See `user-preferences-storage`.
   */
  userPreferences: 'breatic.userPreferences',
  /**
   * Whether this browser has ever held a session. Read before `/auth/me`
   * answers, to decide whether a page behind the auth gate is worth fetching
   * early; never a permission check, and wrong in either direction only costs
   * one chunk.
   */
  sessionSeen: 'breatic.sessionSeen',
  /** sessionStorage: app versions this tab chose to defer. See `use-app-update`. */
  deferredAppVersions: 'breatic.deferredAppVersions',
} as const;

/** Union of every valid persisted key value. */
export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

/**
 * Keys earlier versions wrote that nothing reads any more. Their values are
 * not carried over; `removeRetiredStorageKeys` deletes them so the browser
 * holds only the keys above.
 */
export const RETIRED_STORAGE_KEYS: readonly string[] = [
  'breatic.preferences',
  'breatic.agentColumnWidth',
  'breatic.personalStudios',
  'breatic.myStudios',
  'breatic.joinedStudios',
];

/**
 * Delete every retired key from localStorage. Runs once at startup; a browser
 * that refuses storage access has nothing to delete.
 */
export function removeRetiredStorageKeys(): void {
  try {
    for (const key of RETIRED_STORAGE_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Private mode and blocked site data throw on access.
  }
}
