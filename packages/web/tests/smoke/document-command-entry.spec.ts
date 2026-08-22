// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * End-to-end coverage for the whole-document command entry (task #129).
 *
 * Only what jsdom cannot answer lives here: where the button actually lands,
 * how much it occupies at rest, where the menu draws once open, how it sits
 * against the page and the bubble bar, and whether a wheel over it scrolls the
 * body. Which two commands it opens onto, and how their not-open-yet state
 * looks, are pinned in `document-menu-entry.test.tsx`.
 *
 * Needs the dev server and a smoke account:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

// One login for the whole file: the rate limit is five a minute. Same reason
// as `selection-bubble-bar.spec.ts`.
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.close();
});

/** Opens a freshly created Document Space. */
async function openFreshDocument(p: Page): Promise<void> {
  await p.goto('/studio');
  const firstProject = p.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await p.waitForURL(/\/project\//, { timeout: 15_000 });

  await p.getByTestId('new-space-button').click();
  await p.getByTestId('new-space-type-document').click();
  await p.getByTestId('new-space-name').fill(`doc-menu-${Date.now()}`);
  await p.getByTestId('new-space-submit').click();

  const editor = p.locator('[data-testid="document-space"] .ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15_000 });
}

test('the entry sticks inside the scroller, not beside it', async () => {
  // It has to be inside for the wheel to reach the body, and stuck to the top
  // so it keeps its corner while the text scrolls under it. Anything added as
  // a direct child of the shell turns the first assertion red, whatever it is
  // called; portalled layers are not children and do not count.
  await openFreshDocument(page);
  const layout = await page.evaluate(() => {
    const scroller = document.querySelector('.doc-body-scroller')!;
    const viewport = scroller.querySelector('[data-radix-scroll-area-viewport]')!;
    const trigger = document.querySelector(
      '[data-testid="doc-doc-menu-trigger"]',
    )!;
    const layer = trigger.parentElement!;
    return {
      shellChildren: scroller.parentElement!.children.length,
      insideViewport: viewport.contains(trigger),
      aheadOfPage: viewport.firstElementChild!.contains(trigger),
      position: getComputedStyle(layer).position,
    };
  });

  expect(layout.shellChildren).toBe(1);
  expect(layout.insideViewport).toBe(true);
  expect(layout.aheadOfPage).toBe(true);
  expect(layout.position).toBe('sticky');
});

test('rests as a single 32×32 button in the top right corner', async () => {
  await openFreshDocument(page);
  const trigger = page.getByTestId('doc-doc-menu-trigger');
  await expect(trigger).toBeVisible({ timeout: 10_000 });

  const geometry = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="doc-doc-menu-trigger"]')!;
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    )!;
    const tb = t.getBoundingClientRect();
    const vb = viewport.getBoundingClientRect();
    return {
      width: Math.round(tb.width),
      height: Math.round(tb.height),
      // Measured against the viewport rather than the window: the body area
      // moves with whatever chrome is open.
      insetRight: Math.round(vb.right - tb.right),
      insetTop: Math.round(tb.top - vb.top),
      // Hitting itself is what says those pixels were really painted.
      hitsItself: !!document
        .elementFromPoint(tb.left + tb.width / 2, tb.top + tb.height / 2)
        ?.closest('[data-testid="doc-doc-menu-trigger"]'),
    };
  });

  // The three numbers come from `--doc-entry-size` and `--doc-entry-inset`
  // (`index.css`), which also size the gutter the button stands in. Asserted
  // exactly: a range wide enough to swallow a changed token proves nothing.
  expect(geometry.width).toBe(32);
  expect(geometry.height).toBe(32);
  expect(geometry.insetRight).toBe(16);
  expect(geometry.insetTop).toBe(20);
  expect(geometry.hitsItself).toBe(true);
});

test('opens a menu below the trigger, uncropped', async () => {
  await openFreshDocument(page);
  const trigger = page.getByTestId('doc-doc-menu-trigger');
  await expect(trigger).toBeVisible({ timeout: 10_000 });

  // Nothing on screen before it opens — the other half of a constant
  // resting footprint.
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toHaveCount(0);

  await trigger.click();
  const item = page.getByTestId('doc-doc-menu-save-snapshot');
  await expect(item).toBeVisible({ timeout: 5_000 });

  const placement = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="doc-doc-menu-trigger"]')!;
    const i = document.querySelector(
      '[data-testid="doc-doc-menu-save-snapshot"]',
    )!;
    const tb = t.getBoundingClientRect();
    const ib = i.getBoundingClientRect();
    return {
      below: ib.top >= tb.bottom - 1,
      insideWindow:
        ib.left >= 0 &&
        ib.top >= 0 &&
        ib.right <= window.innerWidth &&
        ib.bottom <= window.innerHeight,
      hitsItself: !!document
        .elementFromPoint(ib.left + ib.width / 2, ib.top + ib.height / 2)
        ?.closest('[data-testid="doc-doc-menu-save-snapshot"]'),
    };
  });

  expect(placement.below).toBe(true);
  expect(placement.insideWindow).toBe(true);
  expect(placement.hitsItself).toBe(true);
});

test('clicking a not-open-yet item leaves menu and document alone', async () => {
  await openFreshDocument(page);
  await page.getByTestId('doc-doc-menu-trigger').click();
  const item = page.getByTestId('doc-doc-menu-save-snapshot');
  await expect(item).toBeVisible({ timeout: 5_000 });

  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  const before = await editor.innerHTML();
  // `force` skips playwright's own actionability check, which treats
  // `aria-disabled` as unclickable. Browsers do not read that attribute: a real
  // click dispatches, and `onSelect`'s preventDefault is what stops it. Without
  // force this waits for an "enabled" that never comes, and what gets measured
  // is the framework's guard rather than the product's behaviour.
  await item.click({ force: true });

  // preventDefault inside `onSelect`: the menu stays put, the document is
  // untouched.
  await expect(item).toBeVisible();
  expect(await editor.innerHTML()).toBe(before);
});

test('clicking the body both dismisses the menu and lands the caret', async () => {
  // Someone with the menu open who wants to go back to writing clicks the body
  // once. A modal menu puts `pointer-events: none` on the body, so that click
  // only dismisses and focus returns to the trigger — two clicks to write again
  // (measured).
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  await page.keyboard.type('first sentence.');

  const trigger = page.getByTestId('doc-doc-menu-trigger');
  const box = (await trigger.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toBeVisible({
    timeout: 5_000,
  });

  const eb = (await editor.boundingBox())!;
  await page.mouse.click(eb.x + 200, eb.y + 30);
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toHaveCount(0);

  await page.keyboard.type('second sentence.');
  await expect(editor).toContainText('second sentence.', { timeout: 5_000 });
});

test('a second click on the trigger closes the menu', async () => {
  // The shape user asked for on 2026-08-22: click the small button and the
  // commands appear, click again and they go. Driven at real coordinates,
  // because with the menu open playwright reads the trigger as covered.
  await openFreshDocument(page);
  const trigger = page.getByTestId('doc-doc-menu-trigger');
  const box = (await trigger.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.mouse.click(cx, cy);
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toBeVisible({
    timeout: 5_000,
  });

  await page.mouse.click(cx, cy);
  await expect(page.getByTestId('doc-doc-menu-save-snapshot')).toHaveCount(0);
});

test('the page clears the entry, down to the width where it used to not', async () => {
  // The page is centred inside the viewport's padding; the entry stands in the
  // right half of that padding. Below a certain content width the page grows
  // into it and a click at the end of the first line opens the menu instead
  // (measured 2026-08-22 with the old 24px gutter: 1000 / 1060 / 1100 / 1140
  // all did this). Two things per width: the rectangles miss each other, and
  // the end of the first line really is the page.
  //
  // The widths below are window widths, and what decides the outcome is the
  // content area — narrower than the window by whatever chrome is open. The
  // assertion after the loop keeps this test honest: unless one of the runs
  // lands under the threshold where a too-narrow gutter would overlap, the
  // whole loop passes with the bug present.
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  await page.keyboard.type(
    'A deliberately long paragraph, long enough that it wraps several times and ' +
      'every line but the last one ends flush against the right edge of the ' +
      'page, which is what makes it useful for measuring whether the entry ' +
      'covers any of it.',
  );

  const contentWidths: number[] = [];
  for (const width of [1000, 1140, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);

    const shot = await page.evaluate(() => {
      const pm = document.querySelector(
        '[data-testid="document-space"] .ProseMirror',
      )!;
      const trigger = document.querySelector(
        '[data-testid="doc-doc-menu-trigger"]',
      )!;
      const page_ = pm.getBoundingClientRect();
      const t = trigger.getBoundingClientRect();

      // The last character on the first visual line
      const text = pm.querySelector('p')!.firstChild as Text;
      const topOf = (i: number): number => {
        const r = document.createRange();
        r.setStart(text, i);
        r.setEnd(text, i + 1);
        return Math.round(r.getBoundingClientRect().top);
      };
      const firstTop = topOf(0);
      let last = 0;
      for (let i = 0; i < text.length; i += 1) {
        if (topOf(i) !== firstTop) break;
        last = i;
      }
      const r = document.createRange();
      r.setStart(text, last);
      r.setEnd(text, last + 1);
      const tail = r.getBoundingClientRect();

      const hit = document.elementFromPoint(
        (tail.left + tail.right) / 2,
        (tail.top + tail.bottom) / 2,
      );
      const viewport = document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      )!;
      return {
        overlaps: page_.right > t.left && page_.top < t.bottom,
        hitTestId: hit?.closest('[data-testid]')?.getAttribute('data-testid'),
        contentWidth: viewport.getBoundingClientRect().width,
      };
    });

    expect(shot.overlaps, `window ${width}: the page runs under the entry`).toBe(
      false,
    );
    expect(
      shot.hitTestId,
      `window ${width}: the end of the first line is not the page`,
    ).toBe('document-editor-content');
    contentWidths.push(shot.contentWidth);
  }

  // Overlap happens when the content area is narrower than the page plus both
  // gutters — that is the only region where this test can tell a right gutter
  // from a wrong one.
  const threshold = await page.evaluate(() => {
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    )!;
    const page_ = document.querySelector(
      '[data-testid="document-editor-content"]',
    )!;
    const gutter = parseFloat(getComputedStyle(viewport).paddingLeft);
    const maxPage = parseFloat(getComputedStyle(page_).maxWidth);
    return maxPage + 2 * gutter;
  });
  expect(
    Math.min(...contentWidths),
    `every width tested was wide enough to pass with any gutter (threshold ${threshold})`,
  ).toBeLessThan(threshold);

  await page.setViewportSize({ width: 1680, height: 950 });
});

test('the bubble bar paints above the entry where they overlap', async () => {
  // Both are positioned siblings in the same isolated container, and the bar
  // follows the selection horizontally — far enough to reach that corner (at
  // 1440 the two came within 1px, measured 2026-08-22). Real overlap only
  // happens along a narrow band, so the bar is moved onto the entry here. What
  // this pins is which one paints on top, not how they came to overlap.
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  await page.keyboard.type('some text to select');

  await page.evaluate(() => {
    const pm = document.querySelector(
      '[data-testid="document-space"] .ProseMirror',
    )!;
    const text = pm.querySelector('p')!.firstChild as Text;
    const sel = window.getSelection()!;
    const r = document.createRange();
    r.setStart(text, 1);
    r.setEnd(text, 5);
    sel.removeAllRanges();
    sel.addRange(r);
    pm.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible({
    timeout: 5_000,
  });

  const hit = await page.evaluate(() => {
    const trigger = document.querySelector(
      '[data-testid="doc-doc-menu-trigger"]',
    )!;
    const bar = document.querySelector(
      '[data-testid="doc-selection-bubble-bar"]',
    ) as HTMLElement;
    const t = trigger.getBoundingClientRect();
    const origin = bar.parentElement!.getBoundingClientRect();
    bar.style.left = `${t.left - origin.left}px`;
    bar.style.top = `${t.top - origin.top}px`;
    const el = document.elementFromPoint(t.left + 16, t.top + 16);
    return el?.closest('[data-testid]')?.getAttribute('data-testid');
  });

  expect(hit).toMatch(/^doc-bubble-tool-/);
});

test('a wheel over the entry scrolls the body', async () => {
  // The entry sits inside the scroller, so this is the browser's own scroll
  // chain rather than anything we wired. Driven through the real pointer:
  // dispatching the event at the element would skip hit-testing, which is the
  // half that decides whether a wheel there reaches the body at all.
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${i} — long enough to scroll`);
    await page.keyboard.press('Enter');
  }

  const readTop = (): Promise<number> =>
    page.evaluate(
      () =>
        (
          document.querySelector(
            '.doc-body-scroller [data-radix-scroll-area-viewport]',
          ) as HTMLElement
        ).scrollTop,
    );
  await page.evaluate(() => {
    (
      document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      ) as HTMLElement
    ).scrollTop = 0;
  });

  const box = (await page.getByTestId('doc-doc-menu-trigger').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await readTop();
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);

  expect(await readTop()).toBeGreaterThan(before);
});

test('Escape closes the menu', async () => {
  await openFreshDocument(page);
  await page.getByTestId('doc-doc-menu-trigger').click();
  const item = page.getByTestId('doc-doc-menu-save-snapshot');
  await expect(item).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press('Escape');
  await expect(item).toHaveCount(0);
});
