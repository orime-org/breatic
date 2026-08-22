// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * End-to-end coverage for the whole-document command entry (task #129).
 *
 * Geometry, hit testing and sticky behaviour are what this file is for: where
 * the button actually lands, how much it occupies at rest, where the menu
 * draws once open, how it sits against the page and the bubble bar, and
 * whether a wheel over it scrolls the body. The DOM structure those rest on is
 * asserted in `DocumentEditor.test.tsx` and re-read here as a precondition,
 * since a measurement of the wrong element would otherwise look like a
 * measurement. Which two commands the menu opens onto, and how their
 * not-open-yet state looks, are pinned in `document-menu-entry.test.tsx`.
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
  await waitForSettledEntry(p);
}

/**
 * Waits until a click at the centre of the entry reaches the entry.
 *
 * A visible editor is not a ready one. On 2026-08-22 a click at the centre of
 * the entry's own rectangle was seen landing on nothing while the rectangle
 * itself already read correctly; why has not been established. Every
 * `page.mouse.click` below depends on that, which is why this waits here
 * rather than in each of them. The geometry can still be moving after it
 * returns — the tests that measure retry on their own.
 */
async function waitForSettledEntry(p: Page): Promise<void> {
  const trigger = p.getByTestId('doc-doc-menu-trigger');
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await expect(async () => {
    const settled = await p.evaluate(() => {
      const t = document.querySelector('[data-testid="doc-doc-menu-trigger"]');
      if (!t) return false;
      const b = t.getBoundingClientRect();
      const hit = document.elementFromPoint(
        b.left + b.width / 2,
        b.top + b.height / 2,
      );
      return !!hit?.closest('[data-testid="doc-doc-menu-trigger"]');
    });
    expect(settled).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test('the entry sticks inside the scroller, not beside it', async () => {
  // It has to be inside for the wheel to reach the body, and stuck to the top
  // so it keeps its corner while the text scrolls under it. Anything added as
  // a direct child of the shell turns the first assertion red, whatever it is
  // called. Two things do not: portalled layers, which are not children, and
  // the bubble bar, which the editor appends to this same shell but only while
  // a selection exists — there is none here.
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
      // Compared directly rather than inferred from being in the first child:
      // the entry has to precede the page for the text to scroll under it.
      beforeThePage:
        !!(
          trigger.compareDocumentPosition(
            document.querySelector('[data-testid="document-editor-content"]')!,
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
      position: getComputedStyle(layer).position,
    };
  });

  expect(layout.shellChildren).toBe(1);
  expect(layout.insideViewport).toBe(true);
  expect(layout.beforeThePage).toBe(true);
  expect(layout.position).toBe('sticky');

  // Declaring `sticky` is not the same as sticking: an `overflow` on any
  // ancestor turns it off while `getComputedStyle` still reports `sticky`
  // (verified 2026-08-22 by adding one — the button scrolled away and the
  // string never changed). So scroll and measure again.
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.type(`line ${i} — long enough to scroll`);
    await page.keyboard.press('Enter');
  }
  const stuck = await page.evaluate(async () => {
    const viewport = document.querySelector(
      '.doc-body-scroller [data-radix-scroll-area-viewport]',
    ) as HTMLElement;
    viewport.scrollTop = 500;
    void viewport.offsetHeight;
    await new Promise((r) => requestAnimationFrame(r));
    const trigger = document.querySelector(
      '[data-testid="doc-doc-menu-trigger"]',
    )!;
    const t = trigger.getBoundingClientRect();
    const v = viewport.getBoundingClientRect();
    return {
      scrolled: viewport.scrollTop,
      insetTop: Math.round(t.top - v.top),
      hitsItself: !!document
        .elementFromPoint(t.left + t.width / 2, t.top + t.height / 2)
        ?.closest('[data-testid="doc-doc-menu-trigger"]'),
    };
  });

  expect(stuck.scrolled).toBeGreaterThan(0);
  expect(stuck.insetTop).toBe(20);
  expect(stuck.hitsItself).toBe(true);
});

test('rests as a single 32×32 button in the top right corner', async () => {
  await openFreshDocument(page);
  const trigger = page.getByTestId('doc-doc-menu-trigger');
  await expect(trigger).toBeVisible({ timeout: 10_000 });

  // Retried rather than measured once: on 2026-08-22 this was seen failing at
  // 1.0s into the run and passing at 2.4s. Why the geometry was still moving
  // that late was never established, so the moment is retried. The numbers
  // stay exact.
  await expect(async () => {
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
      };
    });

    // Size and inset come from `--doc-entry-size` / `--doc-entry-inset`
    // (`index.css`); the 20 is `top-5` on the layer itself, which is the one
    // number those variables do not carry. Asserted exactly: a range wide
    // enough to swallow a changed token proves nothing.
    expect(geometry.width).toBe(32);
    expect(geometry.height).toBe(32);
    expect(geometry.insetRight).toBe(16);
    expect(geometry.insetTop).toBe(20);
  }).toPass({ timeout: 5_000 });
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

test('keeps a fixed gap between the page and the entry', async () => {
  // 8px is what the confirmed demo draws between the page and the button
  // (`2026-08-21-editor-command-surface.html`: body padding 56, button 32 at
  // right 16). It is asserted as that literal rather than read back from
  // `--doc-entry-clearance`, because reading it back moves the expectation
  // along with the value and the assertion holds for any number at all.
  //
  // Measured rather than derived from the rectangles missing each other: the
  // negative margin pins the button to the viewport's right edge, so the two
  // rectangles miss each other whatever the gutter is — including a gutter
  // narrow enough for the page to run underneath the button.
  await openFreshDocument(page);
  const editor = page.locator('[data-testid="document-space"] .ProseMirror');
  await editor.click();
  await page.keyboard.type(
    'A deliberately long paragraph, long enough that it wraps several times ' +
      'and every line but the last ends flush against the right edge of the ' +
      'page, which is what makes it useful for measuring the gap.',
  );

  const shoot = async (width: number): Promise<{
    gap: number;
    pageWidth: number;
  }> => {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    return page.evaluate(() => {
      const page_ = document.querySelector(
        '[data-testid="document-editor-content"]',
      )!;
      const trigger = document.querySelector(
        '[data-testid="doc-doc-menu-trigger"]',
      )!;
      const pb = page_.getBoundingClientRect();
      return {
        gap: Math.round(trigger.getBoundingClientRect().left - pb.right),
        pageWidth: Math.round(pb.width),
      };
    });
  };

  // Two runs, and the two of them say different things. Narrow: the page fills
  // the gutters, so the gap it leaves is the clearance itself. Wide: the page
  // hits its `max-w-3xl` cap and centres, which leaves more — asserted as
  // "more" rather than as a number, because that number falls out of how wide
  // the surrounding chrome happens to be.
  const narrow = await shoot(1000);
  expect(narrow.pageWidth).toBeLessThan(768);
  expect(narrow.gap).toBe(8);

  const wide = await shoot(1440);
  expect(wide.pageWidth).toBe(768);
  expect(wide.gap).toBeGreaterThan(8);

  await page.setViewportSize({ width: 1680, height: 950 });
});

test('the bubble bar paints above the entry where they overlap', async () => {
  // They do overlap in normal use: the bar stops at the top of the visible
  // body rather than flipping away from the entry, so once the page is
  // scrolled past it the bar covers the entry outright (measured 2026-08-22,
  // 1440 wide: the whole 32px of it). How far it reaches sideways depends on
  // which column the selection starts in. Both z values are compared inside
  // the editor's `isolate` shell and nowhere else. The bar is moved onto the
  // entry here rather than scrolled into place: what this pins is which one
  // paints on top, not how they came to overlap.
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
