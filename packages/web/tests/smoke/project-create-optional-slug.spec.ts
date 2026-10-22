// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A Project created with only a name (inner#1463).
 *
 * The Slug is optional: it follows the name as the reader types, and the
 * Project is created with that slug and opened at `/project/{slug}-{uuid}`. The
 * server still requires a slug, so this is the one place that shows the
 * generated value satisfies it end to end.
 *
 * The name starts with "Smoke run", so its slug starts with the prefix setup
 * archives when a run is interrupted before this case archives it itself.
 *
 *   pnpm --filter @breatic/web test:smoke project-create-optional-slug
 */
import { expect } from 'playwright/test';
import { test } from '../helpers/slot';

import { dataOf } from '../helpers/api';
import { MADE_BY_SMOKE } from '../helpers/project';

test('a new Project needs only a name: the Slug follows it and the Project opens at that address', async ({
  page,
}) => {
  const studios = await dataOf<{ slug: string; type: string }[]>(
    await page.request.get('/api/v1/studios'),
    'list studios',
  );
  const personal = studios.find((studio) => studio.type === 'personal');
  if (personal === undefined) throw new Error('the smoke account has no personal studio');

  const stamp = Date.now();
  const name = `Smoke run optional slug ${stamp}`;
  const slug = `${MADE_BY_SMOKE}-optional-slug-${stamp}`;
  let projectId: string | null = null;
  try {
    await page.goto(`/studio/${personal.slug}/projects`);
    await page.getByTestId('container-toolbar').getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByTestId('new-project-dialog');
    await expect(dialog).toBeVisible();

    await page.locator('#new-project-name').fill(name);
    await expect(page.locator('#new-project-slug')).toHaveValue(slug);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    await page.waitForURL(new RegExp(`/project/${slug}-[0-9a-f-]{36}`));
    projectId = /-([0-9a-f-]{36})(?:[/?#]|$)/.exec(page.url())?.[1] ?? null;
    expect(projectId, 'no project id in the address').not.toBeNull();
  } finally {
    if (projectId !== null) {
      const archived = await page.request.post(`/api/v1/projects/${projectId}/archive`);
      expect(archived.ok(), `archive ${projectId}`).toBe(true);
    }
  }
});
