// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Focus crop preset row E2E (#1991) — the half no jsdom test can reach.
 *
 * The unit suite drives the row through synthetic events, where nothing does
 * hit-testing and a marquee never really covers the layer beneath it. Three
 * claims only a browser can settle:
 *
 *   - clicking a preset with no marquee draws one that really fills the
 *     material box, measured off live layout rather than inline style;
 *   - the handle shape tracks whether a ratio is locked, read through
 *     getComputedStyle so a class rename cannot pass silently;
 *   - the bar hugs its content in each locale, which is a layout fact:
 *     `max-content` has no meaning in jsdom.
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

// Desktop-web is the only supported platform; below ~1280px the studio
// sidebar collapses to icons whose buttons lose their accessible names.
test.use({ viewport: { width: 1680, height: 950 } });

/**
 * Signs in and opens a Project that already holds an image node, then starts
 * a focus pick on it and enters the crop state.
 * @param page - The Playwright page.
 * @returns Nothing; the page is left in the crop state.
 */
async function openCropOverlay(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });

  // Reuse an existing Project: this spec is about the crop overlay, and
  // minting one per run burns the tier's projects-per-studio allowance.
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });

  // The pick has to START from some node's generate panel.
  const imageNode = page.locator('.react-flow__node:has([data-testid=image-node-img])');
  await expect(imageNode.first()).toBeVisible({ timeout: 20_000 });

  const hostNodeId =
    (await imageNode.first().getAttribute('data-id')) ?? '';
  await imageNode.first().locator('[data-testid=image-node]').click({ button: 'right' });
  await page.getByRole('menuitem').first().click(); // 生成 / Generate
  await page.getByTestId('generate-tool-focus').click();

  // Both media kinds are crop sources, and the generate panel floats over the
  // canvas covering whichever nodes sit beneath it — so the target is chosen
  // by asking the browser what is actually on top at each candidate's centre.
  // Picking by index lands on a covered node, where the click waits on
  // actionability until the test times out. Audio carries the same testid as
  // video and is not croppable, so candidates are narrowed by videoWidth.
  // Polls rather than reads once: a node's <img>/<video> reports its intrinsic
  // size only after it decodes, and right after the panel opens they all still
  // read zero. Whichever source decodes first and is not covered gets tagged.
  await page.waitForFunction((hostId: string) => {
    const candidates: Element[] = [];
    for (const node of document.querySelectorAll('.react-flow__node')) {
      // The node whose panel started the pick is not a candidate.
      if (node.getAttribute('data-id') === hostId) continue;
      // An EMPTY image node carries `image-node` too, with placeholder text
      // where the picture would be; only a decoded <img> is a crop source.
      const img = node.querySelector('[data-testid=image-node-img]');
      if (img instanceof HTMLImageElement && img.naturalWidth > 0) candidates.push(img);
      // Audio shares this testid and is not croppable — videoWidth narrows it.
      const media = node.querySelector('[data-testid=media-element]');
      if (media instanceof HTMLVideoElement && media.videoWidth > 0) candidates.push(media);
    }
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (top !== null && el.contains(top)) {
        // Tag it so Playwright can address exactly this element.
        el.setAttribute('data-crop-target', 'yes');
        return true;
      }
    }
    return false;
  }, hostNodeId, { timeout: 20_000 });
  await page.locator('[data-crop-target=yes]').click();

  await expect(page.getByTestId('focus-crop-controls')).toBeVisible({ timeout: 10_000 });
}

test('clicking a preset with no marquee draws one, and Original fills the material', async ({
  page,
}) => {
  await openCropOverlay(page);

  // Nothing drawn yet.
  await expect(page.getByTestId('focus-crop-rect')).toHaveCount(0);

  await page.getByTestId('focus-ratio-original').click();

  const rect = page.getByTestId('focus-crop-rect');
  await expect(rect).toBeVisible();
  await expect(page.getByTestId('focus-ratio-original')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Original's ratio IS the material's, so both axes fill. Measured off live
  // layout: the marquee's box has to match the capture layer's, not merely
  // carry the right inline style.
  const fills = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="focus-crop-layer"]');
    const marquee = document.querySelector('[data-testid="focus-crop-rect"]');
    if (!layer || !marquee) return null;
    const l = layer.getBoundingClientRect();
    const m = marquee.getBoundingClientRect();
    return {
      dw: Math.abs(l.width - m.width),
      dh: Math.abs(l.height - m.height),
      dx: Math.abs(l.x - m.x),
      dy: Math.abs(l.y - m.y),
    };
  });
  expect(fills).not.toBeNull();
  // One pixel of slack for the border the marquee draws on itself.
  expect(fills!.dw).toBeLessThanOrEqual(2);
  expect(fills!.dh).toBeLessThanOrEqual(2);
  expect(fills!.dx).toBeLessThanOrEqual(2);
  expect(fills!.dy).toBeLessThanOrEqual(2);
});

test('handle shape says whether the ratio is locked', async ({ page }) => {
  await openCropOverlay(page);

  await page.getByTestId('focus-ratio-1:1').click();
  await expect(page.getByTestId('focus-crop-rect')).toBeVisible();

  /**
   * The corner radius every handle currently renders with.
   * @returns One entry per handle, deduplicated.
   */
  const handleRadii = async (): Promise<string[]> =>
    page.evaluate(() => {
      const ids = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      const radii = ids.map((id) => {
        const el = document.querySelector(`[data-testid="focus-crop-handle-${id}"]`);
        return el ? getComputedStyle(el).borderRadius : 'missing';
      });
      return [...new Set(radii)];
    });

  // Locked: round, and all eight agree.
  const locked = await handleRadii();
  expect(locked).toHaveLength(1);
  expect(locked[0]).not.toBe('0px');

  // Unlight it: the marquee stays, the handles go square.
  await page.getByTestId('focus-ratio-1:1').click();
  await expect(page.getByTestId('focus-crop-rect')).toBeVisible();
  await expect(page.getByTestId('focus-ratio-1:1')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const free = await handleRadii();
  expect(free).toEqual(['0px']);
});

test('the controls bar hugs its content in every locale', async ({ page }) => {
  await openCropOverlay(page);

  /**
   * Leftover width inside the bar, to the right of its last item.
   * @returns The gap in px, plus the row's height so wrapping is visible.
   */
  const measureBar = async (): Promise<{ gap: number; rowHeight: number }> =>
    page.evaluate(() => {
      const bar = document.querySelector('[data-testid="focus-crop-controls"]')!;
      const row = bar.querySelector('[data-testid^="focus-ratio-"]')!.parentElement!;
      const last = row.lastElementChild!;
      const b = bar.getBoundingClientRect();
      const cs = getComputedStyle(bar);
      const padRight = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
      return {
        gap: Math.round(b.right - padRight - last.getBoundingClientRect().right),
        rowHeight: Math.round(row.getBoundingClientRect().height),
      };
    });

  const first = await measureBar();
  expect(first.gap).toBeLessThanOrEqual(1);

  // Every locale, one at a time: the bar is allowed to be a different width in
  // each, and is not allowed to leave a gap or wrap in any of them.
  const singleRow = first.rowHeight;
  for (const label of ['English', '简体中文', '繁體中文', '日本語', '한국어']) {
    await page.locator('header button[aria-haspopup="dialog"]').nth(1).click();
    await page.getByRole('dialog').getByRole('button', { name: label }).click();
    await expect(page.getByTestId('focus-crop-controls')).toBeVisible();
    const m = await measureBar();
    expect(m.gap, `${label} leaves a gap`).toBeLessThanOrEqual(1);
    expect(m.rowHeight, `${label} wraps`).toBe(singleRow);
  }
});
