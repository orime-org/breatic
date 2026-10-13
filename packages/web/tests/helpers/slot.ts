// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Which pair of accounts a worker uses, and the `test` every spec imports.
 *
 * The suites run with several workers at once, and what one case does to an
 * account — its upload-ticket window, its interface language, the Spaces and
 * notifications in its Projects — reaches every other case signed in as the
 * same account. So each worker gets a pair of its own, as Playwright's
 * authentication guide lays out for "one account per parallel worker": the
 * pair is chosen by `parallelIndex`, which no two running workers share and
 * which a worker restarted after a failure keeps. Setup prepares one pair per
 * index before any case starts.
 *
 * The slot can only be read while a case, a hook or a fixture is running:
 * `test.info()` throws while a file is being loaded, and the runner process
 * that lists the cases has no slot at all. Nothing at a module's top level
 * may ask for one.
 */
import { test as base } from 'playwright/test';

import type { Account } from './project';

/**
 * The worker slot of the case that is running.
 * @returns Its `parallelIndex`.
 * @throws {Error} When called outside a running case, hook or fixture.
 */
export function slot(): number {
  return base.info().parallelIndex;
}

/**
 * Where one account's signed-in browser state is kept.
 * @param account - Which account of the pair.
 * @param at - Which worker slot; the running case's when omitted.
 * @returns The path, relative to the web package.
 */
export function stateFile(account: Account, at: number = slot()): string {
  return `playwright/.auth/${String(at)}-${account.toLowerCase()}.json`;
}

/**
 * Playwright's `test`, opening every page signed in as this slot's first
 * account. A spec that wants another state still says so with `test.use`.
 */
export const test = base.extend({
  // Overriding a fixture keeps its registration's `option` flag, so
  // `test.use({ storageState })` still replaces this one.
  // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern, and an empty one means it has none.
  storageState: async ({}, provide): Promise<void> => {
    await provide(stateFile('A'));
  },
});
