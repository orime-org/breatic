// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { test, expect } from 'playwright/test';
import { openSmokeProject } from '../helpers/project';

for (const entry of ['studio', 'project'] as const) {
  test(`${entry} brand opens the home page in a new tab`, async ({ page }) => {
    if (entry === 'project') await openSmokeProject(page);
    else await page.goto('/studio');
    const brand = page.getByTestId('top-bar-logo').locator('..');
    await expect(brand).toHaveAttribute('href', '/');
    const originalUrl = page.url();
    const home = new URL('/', originalUrl).href;
    // Dev serves the application only. Stand in for the separately built Home
    // Page at the hosting boundary; a client-router Link never requests it.
    await page.context().route(home, (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Breatic home</title><h1>Breatic home</h1>',
    }));
    const newTab = page.waitForEvent('popup');
    await brand.click();
    const homePage = await newTab;
    await expect(homePage).toHaveURL(home);
    await expect(homePage.getByRole('heading', { name: 'Breatic home' })).toBeVisible();
    await expect(page).toHaveURL(originalUrl);
    await expect(brand).toBeVisible();
    await homePage.close();
  });
}
