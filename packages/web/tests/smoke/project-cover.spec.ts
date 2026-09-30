// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project cover upload E2E (#21) — the owner's card menu, the 16:9 crop, the
 * asset upload and the pointer, against the running stack.
 *
 * What it pins: a project with no cover shows the default one; the owner's ⋯
 * menu uploads a picked image as the cover through the ordinary asset upload
 * (`POST /assets/upload-ticket`, then `PUT /projects/:id/cover`); the card and
 * the Recent page both show the stored picture, which the browser can fetch;
 * uploading another one replaces it.
 *
 * Needs a running dev stack (`pnpm dev`) and the smoke accounts:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { deflateSync } from 'node:zlib';
import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject, smokeProjectId } from '../helpers/project';

/**
 * A solid-colour PNG, built here so each run can use bytes of its own.
 * @param width - Pixel width.
 * @param height - Pixel height.
 * @param rgb - The colour.
 * @returns The PNG file.
 */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3)]);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The slug of the studio a project lives in.
 * @param page - Any page on the signed-in session.
 * @param projectId - The project.
 * @returns The studio's slug.
 */
async function studioSlugOf(page: Page, projectId: string): Promise<string> {
  const project = await page.request.get(`/api/v1/projects/${projectId}`);
  expect(project.status()).toBe(200);
  const { studioId } = ((await project.json()) as { data: { studioId: string } }).data;
  const listed = await page.request.get('/api/v1/studios');
  const studios = ((await listed.json()) as { data: { id: string; slug: string }[] }).data;
  const studio = studios.find((s) => s.id === studioId);
  expect(studio, 'the project\'s studio is not listed for this account').toBeDefined();
  return studio!.slug;
}

/**
 * Upload one picture through the card menu and return the URL the project now
 * points at.
 * @param page - The studio page, showing the project's card.
 * @param projectId - The project.
 * @param picture - The image to pick.
 * @returns The cover URL from the server's answer.
 */
async function uploadCover(page: Page, projectId: string, picture: Buffer): Promise<string> {
  const card = page.getByTestId(`project-card-${projectId}`);
  await card.hover();
  await card.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Upload cover' }).click();
  await card.getByTestId('project-cover-input').setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: picture,
  });
  await expect(page.getByTestId('image-crop-dialog')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('image-crop-selection')).toBeVisible();

  const ticket = page.waitForRequest(
    (r) => r.url().includes('/assets/upload-ticket') && r.method() === 'POST',
  );
  const pointed = page.waitForResponse(
    (r) => r.url().includes(`/projects/${projectId}/cover`) && r.request().method() === 'PUT',
    { timeout: 60_000 },
  );
  await page.getByTestId('image-crop-confirm').click();

  const sent = (await ticket).postDataJSON() as Record<string, unknown>;
  expect(sent.project_id).toBe(projectId);
  expect(sent.purpose).toBe('project_cover');
  expect(sent.content_type).toBe('image/jpeg');

  const answer = await pointed;
  expect(answer.status(), await answer.text()).toBe(200);
  await expect(page.getByTestId('image-crop-dialog')).toBeHidden({ timeout: 15_000 });
  return ((await answer.json()) as { data: { thumbnailUrl: string } }).data.thumbnailUrl;
}

test('the owner uploads and replaces a project cover @needs-storage', async ({ page }) => {
  const projectId = smokeProjectId('A', 1);
  // Opening it puts it on the Recent page, which shows the cover too.
  const opened = page.waitForResponse(
    (r) => r.url().includes(`/projects/${projectId}/opened`) && r.request().method() === 'POST',
  );
  await openSmokeProject(page, 'A', 1);
  expect((await opened).ok()).toBe(true);
  const slug = await studioSlugOf(page, projectId);

  await page.goto(`/studio/${slug}`);
  const card = page.getByTestId(`project-card-${projectId}`);
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Colours differ per run so the second upload is never a dedup of the first.
  const seed = Date.now() % 200;
  const first = await uploadCover(page, projectId, solidPng(640, 480, [seed, 90, 160]));
  await expect(card.locator('img')).toHaveAttribute('src', first);
  expect((await page.request.get(first)).status(), `GET ${first}`).toBe(200);

  const second = await uploadCover(page, projectId, solidPng(480, 640, [30, seed, 60]));
  expect(second).not.toBe(first);
  await expect(card.locator('img')).toHaveAttribute('src', second);

  await page.goto('/studio');
  const recent = page.locator(`a[href$="-${projectId}"]`).first();
  await expect(recent.locator('img')).toHaveAttribute('src', second, { timeout: 15_000 });
});
