// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Several different toasts at once.
 *
 * Every toast is open: each one shows its text on a row of its own, centred,
 * with no two overlapping. Sonner shows at most three at a time; a fourth
 * hides the oldest.
 *
 * The toasts come from the app's own entry (`lib/toast.ts`), loaded through the
 * dev server — the part under test is how the Toaster lays them out.
 *
 *   pnpm --filter @breatic/web test:smoke -- toast-stack
 * */
import { expect, test, type Page } from 'playwright/test';

import type { toast as appToast } from '@web/lib/toast';

import { STATE_FILE } from '../helpers/project';

const MESSAGES = ['Transfer request sent.', 'Transfer request withdrawn.', 'A third, longer notice'];

interface ToastBox {
  text: string;
  front: boolean;
  top: number;
  bottom: number;
  centre: number;
  titleOpacity: number;
}

/**
 * Measure every toast on the page.
 * @param page - The page.
 * @returns One box per toast, newest first as sonner orders them.
 */
async function measure(page: Page): Promise<ToastBox[]> {
  return page.$$eval('[data-sonner-toast]', (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      const title = el.querySelector('[data-title]');
      return {
        text: el.textContent ?? '',
        front: (el as HTMLElement).dataset.front === 'true',
        top: r.top,
        bottom: r.bottom,
        centre: r.left + r.width / 2,
        titleOpacity: title ? Number(getComputedStyle(title.parentElement!).opacity) : 0,
      };
    }),
  );
}

test('every toast shows its text on its own row, centred', async ({ browser }) => {
  const context = await browser.newContext({ storageState: STATE_FILE.A, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.waitForSelector('section[aria-label^="Notifications"]', { state: 'attached' });

  await page.evaluate(async (messages) => {
    const { toast } = (await import(/* @vite-ignore */ '/lib/toast.ts')) as { toast: typeof appToast };
    for (const message of messages) toast.success(message);
  }, MESSAGES);
  await page.mouse.move(5, 895);
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(MESSAGES.length);
  await page.waitForTimeout(600);

  const toasts = (await measure(page)).sort((a, b) => a.top - b.top);
  expect(toasts.map((t) => t.text)).toEqual([...MESSAGES].reverse());
  for (const t of toasts) {
    expect(t.titleOpacity, `"${t.text}" shows no text`).toBe(1);
    expect(Math.abs(t.centre - 720)).toBeLessThanOrEqual(2);
  }
  for (let i = 1; i < toasts.length; i++) {
    expect(toasts[i].top, `"${toasts[i].text}" overlaps the toast above it`).toBeGreaterThanOrEqual(toasts[i - 1].bottom);
  }

  await context.close();
});
