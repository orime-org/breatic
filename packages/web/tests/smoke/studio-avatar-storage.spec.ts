// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Studio avatar upload E2E (#174) — the one path whose bytes still travel
 * through our own server into the storage adapter.
 *
 * Everything else a user uploads goes to the ingest Worker, which writes R2
 * itself. An avatar does not: the route reads the body and hands it to
 * `getStorageAdapter().upload()`. Since R2 is the only provider, that call
 * needs live credentials and a reachable bucket, and nothing below a real
 * browser proves those are in place — a unit test doubles the adapter and an
 * integration test has no bucket to write into.
 *
 * What it pins: a picked PNG survives the crop dialog, reaches storage, and
 * comes back as a URL under the configured public base that the browser can
 * actually fetch.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite.
 */
import { test, expect, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

/** A 64x64 red PNG — square, so the crop dialog opens on a valid selection. */
const SQUARE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAT0lEQVR42u3QMQEAAAgDoC251a3g' +
    'LwQgOTmzUqlUKpVKpVKpVCqVSqVSqVQqlUqlUqlUKpVKpVKpVCqVSqVSqVQqlUqlUqlUKpVKpVLp' +
    'W1o9WQABEUvpvgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Sign a page in and leave it wherever the app lands after login.
 * @param target - A fresh page.
 * @throws {Error} When the sign-in never leaves the login route.
 */
async function signIn(target: Page): Promise<void> {
  await target.goto('/login');
  await target.locator('#login-email').fill(email as string);
  await target.locator('#login-password').fill(password as string);
  await target.locator('form button[type="submit"]').click();
  await target.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

test('an avatar reaches storage and comes back as a fetchable URL', async ({
  page,
}) => {
  await signIn(page);

  // `/studio` is a cross-studio landing page, so the slug comes from the
  // switcher's own endpoint. The account's personal studio is the one it
  // administers, which is what makes the controls live.
  const listed = await page.request.get('/api/v1/studios');
  expect(listed.status()).toBe(200);
  const studios = (
    (await listed.json()) as { data: { slug: string; type: string }[] }
  ).data;
  const personal = studios.find((s) => s.type === 'personal') ?? studios[0];
  expect(personal, 'the smoke account administers no studio').toBeDefined();

  await page.goto(`/studio/${personal!.slug}/settings`);

  const openUpload = page.getByTestId('avatar-upload-open');
  await expect(openUpload).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('avatar-file-input').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: SQUARE_PNG,
  });

  await expect(page.getByTestId('avatar-crop-dialog')).toBeVisible({
    timeout: 10_000,
  });

  // The response carries the URL the row now points at, which is what the
  // adapter built out of the storage key it just wrote.
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/avatar') && r.request().method() === 'POST',
      { timeout: 30_000 },
    ),
    page.getByTestId('avatar-crop-confirm').click(),
  ]);

  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { data: { avatarUrl: string } };
  const avatarUrl = body.data.avatarUrl;
  expect(avatarUrl).toMatch(/^https?:\/\//);
  expect(avatarUrl).toContain('/avatar/');

  // The dialog closes on a finished upload, which is the app's own signal that
  // the round trip succeeded rather than left an error on screen.
  await expect(page.getByTestId('avatar-crop-dialog')).toBeHidden({
    timeout: 15_000,
  });

  // Reading it back is the half that proves the bytes are really in the bucket
  // and served under the public base, not merely that a row was written.
  const fetched = await page.request.get(avatarUrl);
  expect(fetched.status(), `GET ${avatarUrl}`).toBe(200);
  expect((await fetched.body()).byteLength).toBeGreaterThan(0);
});
