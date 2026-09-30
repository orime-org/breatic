// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { randomUUID } from 'node:crypto';
import { test, expect } from 'playwright/test';
import { smokeProjectUrl } from '../helpers/project';

for (const resource of ['studio', 'project', 'invalid-project'] as const) {
  test(`${resource} lookup shows 404 at the requested address`, async ({ page }) => {
    const id = resource === 'invalid-project' ? 'not-a-uuid' : randomUUID();
    const kind = resource === 'studio' ? 'studio' : 'project';
    const path = `/${kind}/${id}/ignored/nested`;
    const errors: string[] = [];
    const sockets: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => sockets.push(socket.url()));
    const response = page.waitForResponse(response =>
      response.url().includes(`/api/v1/${kind === 'studio' ? 'studio' : 'projects'}/${id}`));
    await page.goto(path);
    expect((await response).status()).toBe(404);
    await expect(page.getByTestId('not-found-page')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByTestId('top-bar')).toHaveCount(0);
    expect(errors).toEqual([]);
    // Vite's development HMR socket is allowed; the editor must not dial collab.
    expect(sockets.filter(url => new URL(url).pathname.startsWith('/ws'))).toEqual([]);
  });
}

test('existing project opens with additional path segments', async ({ page }) => {
  const path = `${smokeProjectUrl()}/ignored/nested`;
  await page.goto(path);
  await expect(page.getByTestId('top-bar')).toBeVisible();
  await expect(page.getByTestId('not-found-page')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
});

test('existing studio opens with additional path segments', async ({ page }) => {
  const me = await page.request.get('/api/v1/auth/me');
  expect(me.ok()).toBe(true);
  const { data } = await me.json() as { data: { personalStudio: { slug: string } } };
  const path = `/studio/${data.personalStudio.slug}/ignored/nested`;
  await page.goto(path);
  await expect(page.getByRole('link', { name: /^Projects(?: \d+)?$/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('not-found-page')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
});

test('unknown application route stays on its localized 404', async ({ page }) => {
  await page.goto('/missing-top-level');
  await expect(page.getByTestId('not-found-page')).toBeVisible();
  await expect(page).toHaveURL(/\/missing-top-level$/);
  await expect(page.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/');
});
