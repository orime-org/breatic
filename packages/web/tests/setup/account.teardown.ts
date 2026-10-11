// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Archives the Projects this run made.
 *
 * Every Space a case creates lives inside one of them, and the next run makes
 * Projects of its own, so these Spaces are never opened again. The pile-up
 * that used to follow is what one long-lived
 * Project used to accumulate: 826 Spaces on one measured account, each of
 * them loading, until the collab writable-connection ceiling started handing
 * new Spaces back as read-only and cases failed on a notice bar.
 *
 * Playwright runs this after the projects that depend on setup, so it fires
 * once the whole suite is finished rather than after each of them.
 */
import { readFileSync } from 'node:fs';

import { expect, request, test as teardown } from 'playwright/test';
import { archiveProjects, readProjects, STATE_FILE } from '../helpers/project';
import { REMOVALS_FILE } from '../helpers/space';

teardown('every project this run made was archived', async ({ baseURL }) => {
  const prepared = readProjects();
  const left: string[] = [];

  for (const account of ['A', 'B'] as const) {
    const ids = prepared[account];
    if (ids.length === 0) continue;
    const api = await request.newContext({
      baseURL,
      storageState: STATE_FILE[account],
    });
    left.push(...(await archiveProjects(api, ids)));
    await api.dispose();
  }
  // A Project left live counts against the studio's Project limit; the next
  // run's setup archives it, and fails there if it cannot either.
  expect(left, 'Projects this run could not archive').toEqual([]);
});

teardown('every Space this run made was removed', () => {
  // A removal that failed only warned, which leaves the exit code alone. The
  // Space it left behind holds a writable connection to its document for the
  // rest of the run, and the cases after it open read-only.
  const left = (() => {
    try {
      return readFileSync(REMOVALS_FILE, 'utf8').trim();
    } catch {
      return '';
    }
  })();
  expect(left, 'Spaces this run could not remove').toBe('');
});
