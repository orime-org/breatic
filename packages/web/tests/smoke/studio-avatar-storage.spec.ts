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
import { test, expect } from 'playwright/test';


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
