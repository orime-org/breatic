// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Removes the Projects this run made.
 *
 * Every Space a case creates lives inside one of them, so removing the
 * Project removes the pile-up too. That pile-up is what one long-lived
 * Project used to accumulate: 826 Spaces on one measured account, each of
 * them loading, until the collab writable-connection ceiling started handing
 * new Spaces back as read-only and cases failed on a notice bar.
 *
 * Playwright runs this after the projects that depend on setup, so it fires
 * once the whole suite is finished rather than after each of them.
 */
import { request, test as teardown } from 'playwright/test';
import { readProjects, STATE_FILE } from '../helpers/project';

teardown('remove the projects this run made', async ({ baseURL }) => {
  const prepared = readProjects();

  for (const account of ['A', 'B'] as const) {
    const ids = prepared[account];
    if (ids.length === 0) continue;
    const api = await request.newContext({
      baseURL,
      storageState: STATE_FILE[account],
    });
    for (const id of ids) {
      const gone = await api.delete(`/api/v1/projects/${id}`);
      if (!gone.ok()) {
        // Saying so beats failing: the run's verdict is already decided, and
        // a leftover Project is swept by the next run's setup. Silence is
        // what would let the sweep quietly stop working.
        console.warn(
          `[teardown] project ${id} was not removed (${gone.status()})`,
        );
      }
    }
    await api.dispose();
  }
});
