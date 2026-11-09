// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A 3D model generated end to end on the real model (inner#1691): text to 3D,
 * one picture, and two views chosen from the Project, each run from the 3D
 * Space's generation dialog to a model placed in the scene.
 *
 * Every run is the cheapest the dialog offers: texture and PBR off (geometry
 * only), standard geometry, no add-ons. What is under test is the path, not
 * the mesh.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';
import { dataOf } from '../helpers/api';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { uniquePicture } from '../helpers/upload';
import { roomForUploads } from '../helpers/upload-budget';

const FIXTURES = join(__dirname, '..', 'fixtures');
const created: string[] = [];
const PLACE_TIMEOUT = 5 * 60_000;
// The real model takes minutes (catalog generation_time 240 s) before the row is done, then placing takes up to PLACE_TIMEOUT.
const CASE_TIMEOUT = 12 * 60_000 + PLACE_TIMEOUT;

test.afterEach(async ({ page }) => {
  for (const id of created.splice(0)) {
    // A placed model of tens of megabytes keeps the headless page busy for
    // seconds per action; closing its tab first frees the page for the drawer.
    const tab = page.getByTestId(`space-tab-${id}`);
    await tab.hover().then(() => page.getByTestId(`space-tab-close-${id}`).click())
      .then(() => expect(tab).toHaveCount(0, { timeout: 60_000 }))
      .catch((err: unknown) => console.warn(`[smoke] could not close Space tab ${id}:`, err));
    await deleteSpace(page, id);
  }
});

/**
 * Open a new 3D Space and its generation dialog.
 * @param page - The Project page.
 * @returns The dialog.
 */
async function openDialog(page: Page): Promise<Locator> {
  await visibleSpace(page).getByRole('button', { name: 'AI generation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI generation', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * The credits the dialog's estimate shows.
 * @param dialog - The dialog.
 * @returns The number in the estimate.
 */
async function shownCredits(dialog: Locator): Promise<number> {
  const credit = dialog.getByTestId('scene-generate-credit');
  await expect(credit).toHaveText(/\d/);
  return Number((await credit.innerText()).replace(/[^\d.]/g, ''));
}

/**
 * Switch the dialog to Image to 3D from its footer pill; the list opens above it, outside the dialog.
 * @param page - The Project page.
 * @param dialog - The generation dialog.
 */
async function imageTo3D(page: Page, dialog: Locator): Promise<void> {
  await dialog.getByTestId('scene-generate-mode').click();
  await page.getByTestId('scene-generate-mode-i23d').click();
  await expect(dialog.getByTestId('scene-generate-mode')).toHaveText('Image to 3D');
}

/**
 * Turn texture off the only way the dialog lets it: PBR first, which holds texture on.
 * @param dialog - The dialog.
 * @returns The credits shown before and after.
 */
async function geometryOnly(dialog: Locator): Promise<{ textured: number; geometry: number }> {
  const textured = await shownCredits(dialog);
  const pbr = dialog.getByRole('switch', { name: 'PBR', exact: true });
  const texture = dialog.getByRole('switch', { name: 'Texture', exact: true });
  await pbr.click();
  await expect(pbr).toHaveAttribute('aria-checked', 'false');
  await texture.click();
  await expect(texture).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByText('Texture quality', { exact: true })).toHaveCount(0);
  await expect.poll(() => shownCredits(dialog)).toBeLessThan(textured);
  return { textured, geometry: await shownCredits(dialog) };
}

/**
 * Press Generate and follow the run's row until its model is placed in the scene.
 * @param page - The Project page.
 * @param dialog - The filled dialog.
 * @param spaceId - The 3D Space.
 * @returns The run's ids, for the report.
 */
async function generateAndPlace(page: Page, dialog: Locator, spaceId: string): Promise<{ task_id: string; row_id: string }> {
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/three-d/${spaceId}/generations`)
    && response.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  const run = await dataOf<{ task_id: string; row_id: string; status: string }>(await answer, 'submit a 3D generation');
  expect(run.status).toBe('pending');
  await expect(dialog).toBeHidden();
  const row = visibleSpace(page).getByTestId(`scene-task-${run.row_id}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('Generating');
  await expect(row).toBeFocused();
  // The model runs for minutes; the row is the only thing that says when it ends.
  await expect.poll(async () => (await row.innerText()).includes('Done') || (await row.innerText()).includes('Failed'), { timeout: test.info().timeout }).toBe(true);
  await expect(row).toContainText('Done');
  await row.getByRole('button', { name: 'Place in scene', exact: true }).click();
  // Placing downloads and reads the whole model first; a generated one is
  // tens of megabytes, which an uncached dev bucket serves in about a minute.
  await expect.poll(async () => JSON.parse(await visibleSpace(page).getByTestId('three-d-viewport').getAttribute('data-objects') ?? '[]').length,
    { timeout: PLACE_TIMEOUT }).toBe(1);
  await expect(page.getByText('The model couldn’t be placed in the scene.', { exact: true })).toHaveCount(0);
  await test.info().attach('scene-generation-run', { body: JSON.stringify(run), contentType: 'application/json' });
  return run;
}

/**
 * Put pictures into the Project through the dialog's own view upload, then
 * leave the dialog; the next blank opening starts empty.
 * @param page - The Project page.
 * @param names - One file name per view, front first.
 */
async function seedProjectImages(page: Page, names: string[]): Promise<void> {
  const dialog = await openDialog(page);
  await imageTo3D(page, dialog);
  await roomForUploads(names.length);
  for (const [index, name] of names.entries()) {
    const chooser = page.waitForEvent('filechooser');
    await dialog.getByTestId(`scene-generate-view-${String(index)}-add`).click();
    await page.getByTestId('scene-generate-view-upload').click();
    await (await chooser).setFiles({ name, mimeType: 'image/jpeg', buffer: uniquePicture(readFileSync(join(FIXTURES, index === 0 ? 'object.jpg' : 'pet.jpg'))) });
    await expect(dialog.getByTestId(`scene-generate-view-${String(index)}`).locator('img')).toBeVisible({ timeout: 60_000 });
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Fill one view slot from the Project picker.
 * @param page - The Project page.
 * @param dialog - The dialog.
 * @param index - The view.
 * @param name - The picture's file name.
 */
async function chooseFromProject(page: Page, dialog: Locator, index: number, name: string): Promise<void> {
  await dialog.getByTestId(`scene-generate-view-${String(index)}-add`).click();
  await page.getByTestId('scene-generate-view-pick-project').click();
  const item = page.locator('[data-testid^="scene-image-picker-item-"]').filter({ hasText: name });
  await item.click();
  await expect(item).toHaveCount(0);
  await expect(dialog.getByTestId(`scene-generate-view-${String(index)}`).locator('img')).toBeVisible();
}

test('text to 3D runs from the dialog to a model placed in the scene @needs-model @needs-storage @needs-ingest', async ({ page }) => {
  test.setTimeout(CASE_TIMEOUT);
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `scene-generate-text-${crypto.randomUUID()}`);
  created.push(id);
  const dialog = await openDialog(page);
  await dialog.getByLabel('Prompt', { exact: true }).fill('A small wooden stool');
  const credits = await geometryOnly(dialog);
  expect(credits.geometry).toBeGreaterThan(0);
  await test.info().attach('scene-generation-credits', { body: JSON.stringify(credits), contentType: 'application/json' });
  await generateAndPlace(page, dialog, id);
});

test('one picture chosen from the Project runs to a model placed in the scene @needs-model @needs-storage @needs-ingest', async ({ page }) => {
  test.setTimeout(CASE_TIMEOUT);
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `scene-generate-image-${crypto.randomUUID()}`);
  created.push(id);
  const front = `front-${crypto.randomUUID()}.jpg`;
  await seedProjectImages(page, [front]);
  const dialog = await openDialog(page);
  await imageTo3D(page, dialog);
  await expect(dialog.getByTestId('scene-generate-view-0').locator('img')).toHaveCount(0);
  await chooseFromProject(page, dialog, 0, front);
  const credits = await geometryOnly(dialog);
  expect(credits.geometry).toBeGreaterThan(0);
  await test.info().attach('scene-generation-credits', { body: JSON.stringify(credits), contentType: 'application/json' });
  await generateAndPlace(page, dialog, id);
});

test('front and left views chosen from the Project run to a model placed in the scene @needs-model @needs-storage @needs-ingest', async ({ page }) => {
  test.setTimeout(CASE_TIMEOUT);
  await openSmokeProject(page);
  const id = await createSpace(page, '3d', `scene-generate-views-${crypto.randomUUID()}`);
  created.push(id);
  const views = [`front-${crypto.randomUUID()}.jpg`, `left-${crypto.randomUUID()}.jpg`];
  await seedProjectImages(page, views);
  const dialog = await openDialog(page);
  await imageTo3D(page, dialog);
  await chooseFromProject(page, dialog, 0, views[0]);
  await chooseFromProject(page, dialog, 1, views[1]);
  const credits = await geometryOnly(dialog);
  expect(credits.geometry).toBeGreaterThan(0);
  await test.info().attach('scene-generation-credits', { body: JSON.stringify(credits), contentType: 'application/json' });
  await generateAndPlace(page, dialog, id);
});
