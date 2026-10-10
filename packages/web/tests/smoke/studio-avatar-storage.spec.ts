// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Studio avatar upload E2E (#294) — the avatar is an ordinary asset.
 *
 * The picture goes the way every asset goes: a studio-scoped ticket, the
 * ingest Worker, a ledger row. `PUT /studio/:slug/avatar` then points the
 * studio at that row. Nothing below a real browser proves the bytes really
 * reach the bucket and come back under the public base.
 *
 * What it pins: a picked PNG survives the crop dialog, is uploaded with a
 * ticket that names the studio rather than a project, and comes back as a URL
 * the browser can actually fetch.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, type Page } from 'playwright/test';

import { hueOf, storedPicture, uniqueJpeg } from '../helpers/upload';


/** A 64x64 red PNG — square, so the crop dialog opens on a valid selection. */
const SQUARE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAT0lEQVR42u3QMQEAAAgDoC251a3g' +
    'LwQgOTmzUqlUKpVKpVKpVCqVSqVSqVQqlUqlUqlUKpVKpVKpVCqVSqVSqVQqlUqlUqlUKpVKpVLp' +
    'W1o9WQABEUvpvgAAAABJRU5ErkJggg==',
  'base64',
);

test('an avatar reaches storage and comes back as a fetchable URL @needs-storage', async ({
  page,
}) => {

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

  await expect(page.getByTestId('image-crop-dialog')).toBeVisible({
    timeout: 10_000,
  });

  // The response carries the URL the studio now points at, copied off the
  // ledger row the upload landed on.
  const [ticket, response] = await Promise.all([
    page.waitForRequest(
      (r) => r.url().includes('/assets/upload-ticket') && r.method() === 'POST',
    ),
    page.waitForResponse(
      (r) => r.url().includes('/avatar') && r.request().method() === 'PUT',
      { timeout: 60_000 },
    ),
    page.getByTestId('image-crop-confirm').click(),
  ]);

  const sent = ticket.postDataJSON() as Record<string, unknown>;
  expect(sent.studio_id).toBeDefined();
  expect(sent.project_id).toBeUndefined();
  expect(sent.purpose).toBe('studio_avatar');

  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { data: { avatarUrl: string } };
  const avatarUrl = body.data.avatarUrl;
  expect(avatarUrl).toMatch(/^https?:\/\//);

  // The dialog closes on a finished upload, which is the app's own signal that
  // the round trip succeeded rather than left an error on screen.
  await expect(page.getByTestId('image-crop-dialog')).toBeHidden({
    timeout: 15_000,
  });

  // Reading it back is the half that proves the bytes are really in the bucket
  // and served under the public base, not merely that a row was written.
  const fetched = await page.request.get(avatarUrl);
  expect(fetched.status(), `GET ${avatarUrl}`).toBe(200);
  expect((await fetched.body()).byteLength).toBeGreaterThan(0);
});

/**
 * Pick a picture as the personal studio's avatar and confirm the crop.
 * @param page - The page.
 * @param file - The picked file.
 * @returns The avatar URL the studio now points at.
 */
async function uploadAvatar(page: Page, file: { name: string; mimeType: string; buffer: Buffer }): Promise<string> {
  const listed = await page.request.get('/api/v1/studios');
  const studios = ((await listed.json()) as { data: { slug: string; type: string }[] }).data;
  const personal = studios.find((s) => s.type === 'personal') ?? studios[0];
  await page.goto(`/studio/${personal!.slug}/settings`);
  await expect(page.getByTestId('avatar-upload-open')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('avatar-file-input').setInputFiles(file);
  await expect(page.getByTestId('image-crop-dialog')).toBeVisible({ timeout: 10_000 });
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/avatar') && r.request().method() === 'PUT', { timeout: 60_000 }),
    page.getByTestId('image-crop-confirm').click(),
  ]);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { data: { avatarUrl: string } }).data.avatarUrl;
}

// A4 (inner#1367): a phone photo picked as an avatar is stored upright. Shown
// at its EXIF orientation the sample is red above blue; the square crop keeps
// both.
test('an avatar cut from a phone photo is stored upright @needs-storage', async ({ page }) => {
  const photo = uniqueJpeg(readFileSync(join(__dirname, '../fixtures/exif6-red-top.jpg')));
  const url = await uploadAvatar(page, { name: 'photo.jpg', mimeType: 'image/jpeg', buffer: photo });
  const stored = await storedPicture(page, url);
  expect([hueOf(stored.top), hueOf(stored.bottom)]).toEqual(['red', 'blue']);
});
