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
// depends on, so a failure early makes the rest meaningless. Six of these ten
// only read geometry off the same page; the rename and caret cases type into
// the live field, the arrows case narrows the tabs, and the hit-test case
// moves the pointer. None of them leaves a name, a window size or a narrowed
// tab behind, and the two cases that read a strip an earlier one scrolled say
// so where they read it — so a red one still leaves the other measurements
// worth having, which serial mode would skip. Knowing which of the others
// also moved is what locates a cause.
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

/**
 * How many tabs must be on the strip before it is asked to overflow.
 *
 * The narrow window leaves the strip around 114px, so two capped tabs already
 * exceed it. Three is the same answer with room to spare, and it keeps the
 * run cheap: every Space created here is deleted again in `afterAll`.
 */
const TABS_WANTED = 3;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await openProject(page);
  // The strip has to overflow for most of what follows, and how many tabs the
  // account already carries is not this spec's to assume — a fresh account has
  // one. So it makes its own up to the number it needs, with names long enough
  // to push each tab to the cap.
  const already = await page.locator('[role="tab"]').count();
  for (let i = already; i < TABS_WANTED; i += 1) {
    createdSpaceIds.push(
      await createSpace(page, 'canvas', `strip-${Date.now()}-${i}-一个很长很长很长的名字`),
    );
  }
  // One is created unconditionally: the cap and the rename field are read off
  // a tab whose name is known to be too long, and an account's own tabs carry
  // whatever names they carry.
  if (createdSpaceIds.length === 0) {
    createdSpaceIds.push(
      await createSpace(page, 'canvas', `strip-${Date.now()}-一个很长很长很长的名字`),
    );
  }
  await page.setViewportSize(NARROW);
  await page.waitForTimeout(500);
  await expect(page.locator('[role="tab"]')).not.toHaveCount(0);
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

test('the rename field grows with what is typed, up to the same cap', async () => {
  const id = createdSpaceIds[0] as string;
  await page.getByTestId(`space-tab-name-${id}`).dblclick();
  const field = page.getByTestId(`space-tab-name-input-${id}`);
  await expect(field).toBeVisible({ timeout: 5_000 });

  /**
   * Put a name in the field and read what the field and its tab are worth.
   * @param name - What to type.
   * @returns The two widths and the field's own floor, in px.
   */
  const widthsFor = async (
    name: string,
  ): Promise<{ field: number; tab: number; floor: number }> => {
    await field.fill(name);
    await page.waitForTimeout(150);
    return field.evaluate((el) => {
      const tab = el.closest('[role="tab"]') as HTMLElement;
      return {
        field: Math.round(el.getBoundingClientRect().width),
        tab: Math.round(tab.getBoundingClientRect().width),
        // `auto` parses to NaN, which is the answer when no floor is declared.
        floor: parseFloat(getComputedStyle(el).minWidth) || 0,
      };
    });
  };

  const empty = await widthsFor('');
  // Long enough to clear the 2ch floor: two latin characters are narrower
  // than it, so a name that short is held at the floor and says nothing about
  // whether the field follows its content.
  const short = await widthsFor('abcdefgh');
  const long = await widthsFor('这是一个很长很长很长的名字');

  await page.keyboard.press('Escape');

  // Emptied, it still holds the room its floor declares rather than
  // collapsing. Asserting merely non-zero is satisfied by the browser's
  // one-pixel caret slot, which is what an emptied field is worth with no
  // floor at all — measured: 1px without the floor, 17px with it.
  expect(empty.floor).toBeGreaterThan(0);
  expect(empty.field).toBeGreaterThanOrEqual(Math.floor(empty.floor));
  // It follows the content — this is what a definite width silently defeats.
  expect(short.field).toBeGreaterThan(empty.field);
  expect(long.field).toBeGreaterThan(short.field);
  // And the tab it lives in still stops where every other tab stops.
  expect(long.tab).toBeLessThanOrEqual(TAB_MAX_WIDTH);
});

test('pressing the rail with any button leaves the caret where it was', async () => {
  // The ratified contract is that touching a scrollbar never moves focus,
  // collapses a selection or interrupts an IME composition, and it names no
  // button. Only a browser can check it: cancelling the pointerdown is what
  // keeps it, and jsdom runs no focus default action for pointerdown at all,
  // so a case there passes whatever the code does.
  const id = createdSpaceIds[0] as string;

  /**
   * Press the rail with one button and report what the focused field kept.
   * @param button - Which mouse button to press.
   * @returns The focused element's test id and its selection, after the press.
   */
  const pressRailWith = async (
    button: 'left' | 'right' | 'middle',
  ): Promise<{ active: string | null; selection: string | null }> => {
    await page.getByTestId(`space-tab-name-${id}`).dblclick();
    await expect(page.getByTestId(`space-tab-name-input-${id}`)).toBeVisible({
      timeout: 5_000,
    });
    await page.evaluate((tab) => {
      const el = document.querySelector(`[data-testid="space-tab-name-input-${tab}"]`);
      if (el instanceof HTMLInputElement) {
        el.focus();
        el.setSelectionRange(1, 3);
      }
    }, id);
    const at = await page.evaluate(() => {
      const list = document.querySelector('[role="tablist"]');
      const bar = list?.closest('[data-testid="space-tab-bar"]') ?? null;
      const rail = bar?.querySelector('[data-orientation="horizontal"]') ?? null;
      if (!(rail instanceof HTMLElement)) return null;
      const b = rail.getBoundingClientRect();
      return { x: Math.round(b.left + b.width * 0.6), y: Math.round((b.top + b.bottom) / 2) };
    });
    if (!at) throw new Error('no horizontal rail on the strip');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ button });
    await page.mouse.up({ button });
    await page.waitForTimeout(150);
    const kept = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        active: el ? el.getAttribute('data-testid') : null,
        selection:
          el instanceof HTMLInputElement ? `${el.selectionStart}-${el.selectionEnd}` : null,
      };
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    return kept;
  };

  const held = { active: `space-tab-name-input-${id}`, selection: '1-3' };
  expect(await pressRailWith('left')).toEqual(held);
  expect(await pressRailWith('right')).toEqual(held);
  expect(await pressRailWith('middle')).toEqual(held);
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

test('the scrollbar and the arrows agree after the content width changes', async () => {
  // Renaming a Space changes how wide the row of tabs is while the box it
  // scrolls in stays exactly as it was — and a resize observer watching only
  // that box never hears about it. Driving the row's width directly is the
  // same signal a rename sends, without depending on a name long enough to
  // cross the boundary. Both indicators answer the same question, so they
  // must not be able to answer it differently.
  /**
   * Reads what the rail and the arrows each believe about the strip.
   * @returns The rail's own verdict and whether the right arrow is live.
   */
  const verdicts = (): Promise<{
    railScrollable: string | null;
    rightLive: boolean;
    viewportWidth: number;
  }> =>
    page.evaluate(() => {
      const list = document.querySelector('[role="tablist"]');
      const bar = list?.closest('[data-testid="space-tab-bar"]') ?? null;
      const rail = bar?.querySelector('[data-orientation="horizontal"]') ?? null;
      const viewport = list?.closest('[data-radix-scroll-area-viewport]') ?? null;
      const right = document.querySelector('[data-testid="tabs-scroll-right"]');
      return {
        railScrollable: rail ? rail.getAttribute('data-scrollable') : null,
        rightLive: right instanceof HTMLButtonElement ? !right.disabled : false,
        // The box the strip scrolls in. Holding it still is what makes the
        // content observer the only thing that can notice: let it change and
        // the plain observer on the box itself re-measures, and the rail comes
        // out right for a reason this case is not about.
        viewportWidth: viewport instanceof HTMLElement ? Math.round(viewport.clientWidth) : -1,
      };
    });

  // Start from the left edge: an earlier case leaves the strip scrolled, and
  // the right arrow is disabled at the right end for reasons of its own.
  await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    const viewport = list?.closest('[data-radix-scroll-area-viewport]') ?? null;
    if (viewport instanceof HTMLElement) viewport.scrollLeft = 0;
  });
  await page.waitForTimeout(500);
  const before = await verdicts();
  expect(before).toMatchObject({ railScrollable: 'true', rightLive: true });

  // Narrow the tabs themselves, which is what shorter names do. Clipping the
  // row instead would leave every tab laid out where it was, and the boundary
  // check reads tab rects. One 10px tab fits the 114px strip whatever the
  // account happens to carry, so the verdict flips for any tab count.
  await page.evaluate((frozen) => {
    const style = document.createElement('style');
    style.id = 'narrow-tabs-probe';
    style.textContent =
      '[role="tab"]:not(:first-child){display:none !important}' +
      '[role="tab"]{max-width:10px !important;padding:0 !important}' +
      // Holding the scroller's own box still: the arrows hide once the strip
      // stops overflowing, which hands their width to a flex-1 scroller and
      // resizes it — and a resize is something the plain observer already
      // notices, so the content observer would never be the reason.
      `[data-testid="space-tab-bar"] > [data-radix-scroll-area-root],
       [data-testid="space-tab-bar"] > div:has(> [data-radix-scroll-area-viewport])
       {width:${frozen}px !important;flex:none !important}`;
    document.head.appendChild(style);
  }, before.viewportWidth);
  await page.waitForTimeout(500);
  const shrunk = await verdicts();

  await page.evaluate(() => {
    document.getElementById('narrow-tabs-probe')?.remove();
  });
  await page.waitForTimeout(500);
  const restored = await verdicts();

  expect(shrunk).toMatchObject({ railScrollable: 'false', rightLive: false });
  expect(restored).toMatchObject({ railScrollable: 'true', rightLive: true });
  // Both verdicts flipped while the box they read stayed the size it was.
  expect(shrunk.viewportWidth).toBe(before.viewportWidth);
  expect(restored.viewportWidth).toBe(before.viewportWidth);
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

/** Reads the rail, the first tab and the bar in one go. */
const railAndTab = (): Promise<{
  railTop: number;
  railBottom: number;
  thumbBottom: number;
  tabTop: number;
  tabBottom: number;
  barContentBottom: number;
} | null> =>
  page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    const root = list?.closest('[data-scrollbars]') ?? null;
    const rail = root?.querySelector('[data-orientation="horizontal"]') ?? null;
    const thumb = rail?.firstElementChild ?? null;
    const bar = document.querySelector('[data-testid="space-tab-bar"]');
    const tab = document.querySelector('[role="tab"]');
    if (!rail || !thumb || !bar || !tab) return null;
    const r = rail.getBoundingClientRect();
    const th = thumb.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    const t = tab.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(bar).borderBottomWidth) || 0;
    return {
      railTop: Math.round(r.top),
      railBottom: Math.round(r.bottom),
      thumbBottom: Math.round(th.bottom),
      tabTop: Math.round(t.top),
      tabBottom: Math.round(t.bottom),
      barContentBottom: Math.round(b.bottom - border),
    };
  });

test('the scrollbar sits on the bar’s bottom edge and over the tabs', async () => {
  const seen = await railAndTab();
  expect(seen).not.toBeNull();
  // Flush with the edge, the way every other scroller in the app has its rail
  // flush with the side it belongs to. The thumb keeps the rail's own 1px of
  // padding and nothing more.
  expect(seen?.railBottom).toBe(seen?.barContentBottom);
  expect((seen?.barContentBottom ?? 0) - (seen?.thumbBottom ?? 0)).toBeLessThanOrEqual(1);
  // And it lies over the tabs rather than in a reserved strip beneath them.
  expect(seen?.railTop).toBeLessThan(seen?.tabBottom ?? 0);
});

test('the rail lets clicks through to the tabs until the pointer is in the strip', async () => {
  /**
   * Ask the page what a click on the first tab's lowest band would reach.
   *
   * The point is worked out inside the page so that the coordinates the browser
   * hit-tests with are the same ones it laid the tab out at.
   * @returns Which of the rail, a tab, or something else is on top.
   */
  const topmostOnTabBottom = (): Promise<string> =>
    page.evaluate(() => {
      // Sample at the scroller's own midpoint. A tab is wider than the strip
      // is at this window size, so no tab lies wholly inside it, and earlier
      // cases leave the strip scrolled — the first tab in the DOM is then off
      // to the left at a negative x, where hit testing has nothing to return.
      // Every tab shares the row's top and bottom, so any of them gives the y.
      const list = document.querySelector('[role="tablist"]');
      const vp = list?.closest('[data-radix-scroll-area-viewport]');
      const tab = document.querySelector('[role="tab"]');
      if (!(vp instanceof HTMLElement) || !tab) return 'no scroller';
      const v = vp.getBoundingClientRect();
      const b = tab.getBoundingClientRect();
      const el = document.elementFromPoint(v.x + v.width / 2, b.bottom - 2);
      if (!el) return 'none';
      if (el.closest('[data-orientation="horizontal"]')) return 'rail';
      if (el.closest('[role="tab"]')) return 'tab';
      return el.tagName.toLowerCase();
    });

  /** The rail's own account of whether it is showing and taking events. */
  const railState = (): Promise<{ revealed: string; pointerEvents: string; opacity: string }> =>
    page.evaluate(() => {
      const list = document.querySelector('[role="tablist"]');
      const root = list?.closest('[data-scrollbars]');
      const rail = root?.querySelector('[data-orientation="horizontal"]');
      if (!(rail instanceof HTMLElement)) {
        return { revealed: 'no rail', pointerEvents: '', opacity: '' };
      }
      return {
        revealed: rail.dataset.revealed ?? '',
        pointerEvents: getComputedStyle(rail).pointerEvents,
        // The half the stamp does not carry: a rail that answers the pointer
        // while painting nothing swallows clicks with nothing drawn to explain
        // it, which is the failure the gate exists to prevent.
        opacity: getComputedStyle(rail).opacity,
      };
    });

  // The scroller's own box, not the row's: the row is thousands of pixels
  // wide and, once the strip has been scrolled, starts at a negative x — a
  // pointer aimed there lands outside the window and enters nothing.
  const strip = await page.evaluate(() => {
    const list = document.querySelector('[role="tablist"]');
    const vp = list?.closest('[data-radix-scroll-area-viewport]');
    if (!(vp instanceof HTMLElement)) return null;
    const b = vp.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y };
  });
  expect(strip).not.toBeNull();
  const x = strip?.x ?? 0;

  // Pointer parked well away from the strip: the whole tab answers to a click,
  // including the band the hidden rail covers.
  await page.mouse.move(x, (strip?.y ?? 0) + 300);
  // Polled rather than slept: the rail also idles out on its own after the
  // last scroll (Radix holds `data-state` visible for its hide delay, then the
  // opacity transition runs), and an earlier case leaves the strip scrolled —
  // so what this has to wait for is two independent timers plus a round trip,
  // which is not a number worth guessing.
  await expect
    .poll(railState, { timeout: 5_000 })
    .toEqual({ revealed: 'false', pointerEvents: 'none', opacity: '0' });
  expect(await topmostOnTabBottom()).toBe('tab');

  // Pointer inside the strip: the rail is showing, and it takes its own band
  // again — the same trade every overlay scrollbar makes once it is visible.
  await page.mouse.move(x, (strip?.y ?? 0) + 8);
  await page.waitForTimeout(600);
  expect(await railState()).toEqual({
    revealed: 'true',
    pointerEvents: 'auto',
    opacity: '1',
  });
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
