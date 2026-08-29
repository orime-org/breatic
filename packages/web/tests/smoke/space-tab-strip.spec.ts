// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The tab strip's layout, measured in a browser.
 *
 * Everything here is geometry: how wide one tab may get, whether the strip
 * lies in one row and scrolls sideways, where the tabs sit inside the bar, and
 * where the scrollbar lands. jsdom computes none of it, so a unit test can
 * only look at class names — and class names are what read correct both times
 * this strip broke (#2015: a flex declared on the scroll viewport stopped at
 * Radix's `display:table` wrapper and laid the tabs out one per row, so the
 * strip never overflowed and neither the bar nor the arrows ever appeared;
 * then a percentage height under that same wrapper resolved to auto and parked
 * the tabs against the bar's top edge with the scrollbar in the gap below).
 */
import { expect, test, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

// Not serial, unlike the other smoke specs: those build state a later case
// depends on, so a failure early makes the rest meaningless. These five only
// read geometry off the same page and are independent, and serial mode would
// skip the remaining measurements the moment one of them went red — exactly
// when knowing which of the others also moved is what locates the cause.
test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

/** Wide enough for the chrome, narrow enough that the strip must scroll. */
const NARROW = { width: 700, height: 800 };

/** The bar the mock specifies, and the tab height inside it. */
const BAR_HEIGHT = 40;
const TAB_HEIGHT = 32;

/** The cap one tab may reach — SpaceTab's SPACE_TAB_MAX_WIDTH. */
const TAB_MAX_WIDTH = 160;

let page: Page;
const createdSpaceIds: string[] = [];

/**
 * Sign in and open the account's first project.
 * @param p - The page to drive.
 * @returns Nothing.
 * @throws {Error} When sign-in never reaches a project.
 */
async function openProject(p: Page): Promise<void> {
  await p.goto('/login');
  await p.locator('#login-email').fill(email as string);
  await p.locator('#login-password').fill(password as string);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 20_000 });
  await p.goto('/studio');
  const first = p.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.click();
  await p.waitForURL(/\/project\//, { timeout: 20_000 });
  await expect(p.locator('[role="tab"]').first()).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openProject(page);
  // A name long enough to push its own tab to the cap.
  createdSpaceIds.push(
    await createSpace(page, 'canvas', `strip-${Date.now()}-一个很长很长很长的名字`),
  );
  await page.setViewportSize(NARROW);
  await page.waitForTimeout(500);
});

test.afterAll(async () => {
  await page.setViewportSize({ width: 1440, height: 900 });
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page.close();
});

test('one tab never grows past its cap', async () => {
  const widths = await page.evaluate(() =>
    [...document.querySelectorAll('[role="tab"]')].map((t) =>
      Math.round(t.getBoundingClientRect().width),
    ),
  );
  expect(widths.length).toBeGreaterThan(0);
  expect(Math.max(...widths)).toBeLessThanOrEqual(TAB_MAX_WIDTH);
});

test('the tabs lie in one row and the strip scrolls sideways', async () => {
  const laid = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    const viewport = list?.closest('[data-radix-scroll-area-viewport]') ?? null;
    const tops = [...document.querySelectorAll('[role="tab"]')].map((t) =>
      Math.round(t.getBoundingClientRect().top),
    );
    return {
      rows: new Set(tops).size,
      overflows:
        viewport instanceof HTMLElement
          ? viewport.scrollWidth > viewport.clientWidth
          : null,
      clipped:
        viewport instanceof HTMLElement
          ? viewport.scrollHeight > viewport.clientHeight
          : null,
    };
  });
  expect(laid.rows).toBe(1);
  expect(laid.overflows).toBe(true);
  // A strip that wrapped would report content taller than the viewport.
  expect(laid.clipped).toBe(false);
});

test('the tabs sit centred in the bar', async () => {
  const boxes = await page.evaluate(() => {
    const bar = document.querySelector('[data-testid="space-tab-bar"]');
    const tab = document.querySelector('[role="tab"]');
    const b = bar?.getBoundingClientRect();
    const t = tab?.getBoundingClientRect();
    return b === undefined || t === undefined
      ? null
      : {
        above: Math.round(t.top - b.top),
        below: Math.round(b.bottom - t.bottom),
        barHeight: Math.round(b.height),
        tabHeight: Math.round(t.height),
      };
  });
  expect(boxes).not.toBeNull();
  expect(boxes?.barHeight).toBe(BAR_HEIGHT);
  expect(boxes?.tabHeight).toBe(TAB_HEIGHT);
  // Equal room above and below is the assertion; the bar carries a 1px bottom
  // border, so the lower half may come out one pixel larger.
  expect(Math.abs((boxes?.above ?? 0) - (boxes?.below ?? 0))).toBeLessThanOrEqual(1);
});

test('the scrollbar lies over the tabs, not in a strip of its own', async () => {
  const seen = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    const root = list?.closest('[data-scrollbars]') ?? null;
    const rail = root?.querySelector('[data-orientation="horizontal"]') ?? null;
    const tab = document.querySelector('[role="tab"]');
    const r = rail?.getBoundingClientRect();
    const t = tab?.getBoundingClientRect();
    return r === undefined || t === undefined
      ? null
      : {
        railTop: Math.round(r.top),
        railBottom: Math.round(r.bottom),
        tabTop: Math.round(t.top),
        tabBottom: Math.round(t.bottom),
      };
  });
  expect(seen).not.toBeNull();
  // The rail's band falls inside the tabs' band rather than below it.
  expect(seen?.railTop).toBeGreaterThanOrEqual(seen?.tabTop ?? 0);
  expect(seen?.railTop).toBeLessThan(seen?.tabBottom ?? 0);
  expect(seen?.railBottom).toBeLessThanOrEqual(seen?.tabBottom ?? 0);
});

test('the browser draws no scrollbar of its own on the strip', async () => {
  // Radix's viewport asks for this itself, so this case does not cover the
  // `@layer base` move that went in alongside — see the next one for that.
  // It is still worth holding: a native bar on this strip is what started
  // #2015, and it would come back the moment the viewport stopped asking.
  const painted = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    const viewport = list?.closest('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) return null;
    return getComputedStyle(viewport).scrollbarWidth;
  });
  expect(painted).toBe('none');
});

test('the global scrollbar fallback ships inside a cascade layer', async () => {
  // Unlayered rules beat every layered one and specificity only compares
  // within a layer, so while this `*` rule sat outside all layers it beat the
  // Tailwind utilities — which live in `@layer utilities` — and an element
  // asking for `[scrollbar-width:none]` still computed `thin`. Nothing in
  // `src/` asks for that utility today, so the browser shows no difference
  // and no measurement can catch a regression; what the sheet says is the
  // only observable there is, and this reads it off the page rather than off
  // the source file.
  const layer = await page.evaluate(() => {
    for (const sheet of [...document.styleSheets]) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet, not ours
      }
      const walk = (list: CSSRuleList, within: string | null): string | null => {
        for (const rule of [...list]) {
          if (
            rule instanceof CSSStyleRule
            && rule.selectorText === '*'
            && rule.style.getPropertyValue('scrollbar-width') !== ''
          ) {
            return within ?? 'unlayered';
          }
          if ('cssRules' in rule) {
            const name = rule.constructor.name === 'CSSLayerBlockRule'
              ? (rule as CSSRule & { name: string }).name
              : within;
            const found = walk((rule as CSSGroupingRule).cssRules, name);
            if (found !== null) return found;
          }
        }
        return null;
      };
      const found = walk(rules, null);
      if (found !== null) return found;
    }
    return null;
  });
  expect(layer).toBe('base');
});
