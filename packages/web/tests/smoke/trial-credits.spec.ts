// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Trial credits, as a new account meets them (task #267).
 *
 * Its own account, registered here rather than taken from the shared ones:
 * the grant happens once, when a personal studio is first created, so an
 * account that already has one cannot exercise it. The registration and the
 * studio go through the real endpoints; everything asserted after that is
 * read off the running app in a browser.
 *
 * Three things a holder of these credits sees, in the order they meet them:
 *
 *   1. The account menu prints what the account holds, which is the first
 *      place the credits appear and the reason they are granted: a new
 *      account can generate something without paying first.
 *
 *   2. The acquisition history names where they came from, in the cell a
 *      price fills for a purchase.
 *
 *   3. The assignment screen offers no picker for them and says where they
 *      may go, because every option it could offer would be refused.
 */

import { expect, request, test } from 'playwright/test';

/** Credentials nobody else will hold. */
function freshCredentials(): { email: string; password: string } {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return { email: `trial-${stamp}@example.test`, password: 'Sm0ke-Trial-Pw!' };
}

test.describe('a new account and its trial credits', () => {
  test('sees them in the menu, in its history, and on the assign screen @needs-payments', async ({
    page,
    baseURL,
  }) => {
    const { hostname } = new URL(baseURL!);
    expect(
      ['localhost', '127.0.0.1', '[::1]'].includes(hostname),
      'this case registers an account, so it runs against the local stack only',
    ).toBe(true);

    // Registration and the studio through the real endpoints. A 429 here is
    // the ten-an-hour ceiling in config/rate-limits.yaml, not a defect.
    const api = await request.newContext({ baseURL });
    const made = freshCredentials();
    const registered = await api.post('/api/v1/auth/register', { data: made });
    expect(
      registered.ok(),
      `register answered ${registered.status()}: ${(await registered.text()).slice(0, 200)}`,
    ).toBe(true);

    const slug = `trialer${Math.floor(Date.now() / 1000)}`;
    const studio = await api.post('/api/v1/auth/setup-studio', { data: { slug } });
    expect(
      studio.ok(),
      `setup-studio answered ${studio.status()}: ${(await studio.text()).slice(0, 200)}`,
    ).toBe(true);

    // What the account holds, straight from the endpoint the panel reads. If
    // the deployment charges nobody there is nothing to grant and nothing
    // below has anything to look at, so it is said here rather than failing
    // three assertions later with no reason.
    const overview = await api.get('/api/v1/credits/overview');
    expect(overview.ok()).toBe(true);
    const held = (await overview.json()) as {
      data: { billing: boolean; assignedCredits: number };
    };
    expect(
      held.data.billing,
      'this stack has payments off, so no trial credits are granted and this case has nothing to read',
    ).toBe(true);
    const granted = held.data.assignedCredits;
    expect(granted).toBeGreaterThan(0);

    // Into the browser as that account.
    await page.context().addCookies(await api.storageState().then((s) => s.cookies));
    await page.goto('/');
    const avatar = page.getByRole('button', { name: /Account|账号/ });
    await expect(avatar).toBeVisible({ timeout: 30_000 });

    // The menu prints the figure beside the entry, so a person checking what
    // they hold never has to open the overlay.
    await avatar.click();
    const menu = page.getByTestId('account-menu');
    await expect(menu).toContainText(String(granted));

    // The acquisition history: one row, naming where the credits came from.
    await menu.getByRole('menuitem', { name: /Credits|积分/ }).click();
    await page.getByRole('tab', { name: /Credit history|获取记录/ }).click();

    const historyRow = page.getByTestId('purchase-row').first();
    await expect(historyRow).toBeVisible({ timeout: 15_000 });
    await expect(historyRow).toContainText(/Trial credits|体验积分/);
    await expect(historyRow).not.toContainText('$');

    // The assignment screen: no picker, and a line saying where they may go.
    await page.getByRole('tab', { name: /Assign|指定/ }).click();
    const pinned = page.getByTestId('assign-pinned').first();
    await expect(pinned).toBeVisible({ timeout: 15_000 });
    await expect(pinned).toContainText(/personal Studio|个人 Studio/);
    await expect(page.getByRole('combobox')).toHaveCount(0);

    await api.dispose();
  });
});
