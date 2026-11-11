// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Mouse use leaves no focus ring; the keyboard still shows it (#1452).
 *
 * A Radix menu closed with the mouse hands focus back to its trigger by
 * script, and a press on a video's seek bar focuses the thumb by script; the
 * browser counts both as visible focus. The ring now also needs the keyboard
 * to be the last input (`data-input-modality` on <html>).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Locator, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR, visibleSpace } from '../helpers/space';

/** An upload goes to the real ingest Worker and back. */
const UPLOAD_TIMEOUT = 60_000;

/**
 * Whether an element draws a ring: an outline, or a box-shadow with spread and
 * a visible colour (Tailwind's `ring-*`).
 * @param target - The element.
 * @returns True when a ring is drawn.
 */
async function hasRing(target: Locator): Promise<boolean> {
  return target.evaluate((el) => {
    const style = getComputedStyle(el);
    if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) return true;
    const shadows = style.boxShadow === 'none' ? [] : style.boxShadow.split(/,(?![^(]*\))/);
    return shadows.some((shadow) => {
      const colour = shadow.match(/rgba?\([^)]*\)/)?.[0] ?? '';
      const alpha = colour.startsWith('rgba') ? parseFloat(colour.split(',')[3] ?? '1') : 1;
      const lengths = shadow.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+px/g) ?? [];
      return alpha > 0 && parseFloat(lengths[3] ?? '0') > 0;
    });
  });
}

/**
 * Opens the studio page and waits for the account button.
 * @param page - The page.
 * @returns The account button.
 */
async function openStudio(page: Page): Promise<Locator> {
  const listed = (await (await page.request.get('/api/v1/studios')).json()) as { data: { slug: string; type: string }[] };
  const personal = listed.data.find((studio) => studio.type === 'personal')!;
  await page.goto(`/studio/${personal.slug}/projects`);
  const account = page.getByRole('button', { name: 'Account', exact: true });
  await expect(account).toBeVisible({ timeout: 15_000 });
  return account;
}

test.describe('focus rings follow the input', () => {
  test('the account button is a 32px circle, and mouse open and close leaves it without a ring', async ({ page }) => {
    const account = await openStudio(page);
    const box = (await account.boundingBox())!;
    expect([Math.round(box.width), Math.round(box.height)]).toEqual([32, 32]);
    expect(await account.evaluate((el) => getComputedStyle(el).borderRadius)).not.toBe('0px');
    const avatar = (await account.locator(':scope > *').first().boundingBox())!;
    expect([Math.round(avatar.width), Math.round(avatar.height)]).toEqual([32, 32]);

    await account.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.mouse.click(5, 600);
    await expect(page.getByRole('menu')).toBeHidden();
    // Radix handed focus back by script, which the browser counts as visible.
    await expect(account).toBeFocused();
    expect(await account.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    expect(await hasRing(account)).toBe(false);
  });

  test('Escape and Tab still show the ring', async ({ page }) => {
    const account = await openStudio(page);
    await account.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(account).toBeFocused();
    expect(await hasRing(account)).toBe(true);

    await page.mouse.click(5, 600);
    expect(await hasRing(account)).toBe(false);
    await account.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(account).toBeFocused();
    expect(await hasRing(account)).toBe(true);
  });

  test('a project card shows the keyboard ring on the card', async ({ page }) => {
    await openStudio(page);
    await page.getByRole('button', { name: 'Grid view' }).click();
    const card = page.locator('[data-testid^="project-card-"]').first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const target = card.locator(':scope > :first-child');
    await target.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(target).toBeFocused();
    expect(await hasRing(card)).toBe(true);
  });

  test('a list row whose menu was opened and closed with the mouse keeps no highlight', async ({ page }) => {
    await openStudio(page);
    await page.getByRole('button', { name: 'List view' }).click();
    // The view is remembered; a fresh load leaves no earlier mouse focus, so the
    // menu is the user's first press, as when they arrive on the page.
    await page.reload();
    const rows = page.locator('[data-testid^="project-row-"]');
    await expect(rows.nth(1)).toBeVisible({ timeout: 15_000 });
    const row = rows.nth(0);
    const untouched = rows.nth(1);
    await row.hover();
    const more = row.getByRole('button', { name: 'More actions' });
    await more.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.mouse.click(5, 600);
    await expect(page.getByRole('menu')).toBeHidden();
    await expect(more).toBeFocused();
    expect(await more.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    const fill = (locator: Locator): Promise<string> =>
      locator.locator('td').first().evaluate((td) => getComputedStyle(td).backgroundColor);
    expect(await fill(row)).toBe(await fill(untouched));
  });

  test('a mouse press on the Language button leaves no ring', async ({ page }) => {
    await openStudio(page);
    const language = page.locator('button[aria-label^="Language"]').first();
    await language.click();
    await page.mouse.click(5, 600);
    await language.focus();
    expect(await hasRing(language)).toBe(false);
  });

  test('a text field clicked with the mouse shows its active border and no ring', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto('/login');
    const email = page.locator('input[type="email"]').first();
    await expect(email).toBeVisible({ timeout: 15_000 });
    const border = (): Promise<string> => email.evaluate((el) => getComputedStyle(el).borderTopColor);
    const active = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.borderColor = 'var(--color-active-border)';
      document.body.append(probe);
      const value = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return value;
    });
    await email.click();
    await expect(email).toBeFocused();
    // The border colour eases in (`transition-colors`).
    await expect.poll(border).toBe(active);
    expect(await hasRing(email)).toBe(false);
    await context.close();
  });

  test('the chat composer turns active only when the text takes the focus', async ({ page }) => {
    await openSmokeProject(page);
    const composer = page.getByTestId('chat-composer');
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const border = (): Promise<string> => composer.evaluate((el) => getComputedStyle(el).borderTopColor);
    const resting = await border();
    await page.getByTestId('chat-model-picker').click();
    await expect(page.getByTestId('chat-model-menu')).toBeVisible();
    // The model already chosen: the menu closes and nothing is saved on the shared account.
    await page.locator('[data-testid^="chat-model-option-"][aria-pressed="true"]').click();
    await expect(page.getByTestId('chat-model-menu')).toBeHidden();
    await expect(page.getByTestId('chat-model-picker')).toBeFocused();
    // The border colour eases (`transition-colors`); give it time to move if it would.
    await page.waitForTimeout(300);
    expect(await border()).toBe(resting);
    await page.getByTestId('chat-composer-box').click();
    await expect.poll(border).not.toBe(resting);
  });

  test.describe('a video in a Document', () => {
    const made: string[] = [];
    test.afterEach(async ({ page }) => {
      while (made.length > 0) await deleteSpace(page, made.pop() as string);
    });

    test('a mouse press on the seek bar leaves the thumb without a ring', async ({ page }) => {
      await openSmokeProject(page);
      made.push(await createSpace(page, 'document', `focus-ring-${Date.now()}`));
      const editor = page.locator(DOCUMENT_EDITOR);
      await expect(editor).toBeVisible({ timeout: 15_000 });
      await editor.click();
      await page.locator(`${DOCUMENT_EDITOR} .bn-block-content`).first().hover();
      await visibleSpace(page).getByTestId('doc-block-plus').click();
      const chooser = page.waitForEvent('filechooser');
      await page.getByTestId('doc-block-insert-video').click();
      await (await chooser).setFiles({
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        buffer: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')),
      });
      const video = page.locator(`${DOCUMENT_EDITOR} [data-content-type="video"]`);
      await expect(video.locator('video')).toBeVisible({ timeout: UPLOAD_TIMEOUT });

      // The user reached the player with the keyboard, then took the mouse:
      // the thumb's scripted focus follows a keyboard-visible focus, which the
      // browser keeps visible.
      const play = video.getByTestId('play-toggle');
      await play.focus();
      await page.keyboard.press('ArrowRight');
      await expect(play).toBeFocused();
      expect(await play.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
      const seek = video.getByTestId('seek');
      const bar = (await seek.boundingBox())!;
      await page.mouse.click(bar.x + bar.width * 0.4, bar.y + bar.height / 2);
      const thumb = seek.locator('[role="slider"]');
      await expect(thumb).toBeFocused();
      expect(await thumb.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
      expect(await hasRing(thumb)).toBe(false);
    });
  });
});
