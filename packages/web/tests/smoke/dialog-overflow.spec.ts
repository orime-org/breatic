/**
 * #166 — a modal taller than the viewport has to be reachable.
 *
 * These facts are layout, so they are measured in a real browser: jsdom has
 * no layout engine and reports every box as zero. The jsdom side of this
 * change pins the class names and the nesting; everything below is what those
 * actually produce on screen.
 *
 * Scrolling is driven with real keys and a real wheel. #156 records an overlay
 * whose scroll region answered `scrollTop` assignment while ignoring the wheel
 * and the keyboard, so setting `scrollTop` from a script would pass on a
 * dialog nobody could actually scroll.
 *
 * The gallery at /dev/primitives is the surface: it renders the two
 * primitives through the real component tree and needs no session.
 */
import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright/test';

/** Viewport equivalent to 1280x720 at 200% zoom, where #166 was reported. */
const ZOOMED = { width: 640, height: 320 };
/** An ordinary desktop viewport, where only row count makes a dialog tall. */
const DESKTOP = { width: 1280, height: 720 };

/**
 * Open one of the gallery's dialogs and hand back its content element.
 *
 * @param page The page under test.
 * @param name The `data-testid` stem shared by a trigger and its content.
 * @returns The opened content element.
 * @throws {Error} When the dialog does not open.
 */
async function openDialog(page: Page, name: string): Promise<Locator> {
  await page.goto('/dev/primitives');
  await page.getByTestId(`${name}-trigger`).click();
  const content = page.getByTestId(name);
  await expect(content).toBeVisible();
  // The dialog enters at 95% scale over 200ms. A box read mid-animation is
  // the animation's box, not the layout's — it reported a top edge of 58px
  // where the settled one is 16.
  await content.evaluate((node) =>
    Promise.all(node.getAnimations().map((a) => a.finished)),
  );
  return content;
}

/**
 * Press PageDown until the scroller has nothing left to give.
 *
 * Scrolling is smooth, so the offset trails the keystrokes: reading straight
 * after the last press catches it mid-flight. This waits for it to settle
 * rather than for a fixed delay.
 *
 * @param page The page under test.
 * @param content The opened dialog content.
 * @throws {Error} When the scroller never reaches its end.
 */
async function scrollToEnd(page: Page, content: Locator): Promise<void> {
  const { maxScroll } = await readScroller(content);
  const presses = Math.ceil(maxScroll / 100) + 2;
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press('PageDown');
  }
  await expect
    .poll(async () => {
      const at = await readScroller(content);
      return at.maxScroll - at.scrollTop;
    })
    .toBeLessThanOrEqual(1);
}

/**
 * Read the element the overlay actually scrolls.
 *
 * @param content The opened dialog content.
 * @returns The scroll offset, the furthest it can go, and the rail's box.
 * @throws {Error} When the content is not inside a scroll-area viewport.
 */
async function readScroller(content: Locator): Promise<{
  scrollTop: number;
  maxScroll: number;
}> {
  return content.evaluate((node) => {
    const viewport = node.closest('[data-radix-scroll-area-viewport]');
    if (!(viewport instanceof HTMLElement)) {
      throw new Error('content is not inside a scroll-area viewport');
    }
    return {
      scrollTop: viewport.scrollTop,
      maxScroll: viewport.scrollHeight - viewport.clientHeight,
    };
  });
}

test.describe('a dialog taller than the viewport', () => {
  test('scrolls with the keyboard until its bottom edge is on screen', async ({
    page,
  }) => {
    await page.setViewportSize(ZOOMED);
    const content = await openDialog(page, 'dialog-long');

    const before = await readScroller(content);
    expect(before.scrollTop).toBe(0);
    expect(before.maxScroll).toBeGreaterThan(0);

    // Real keys, not scrollTop assignment — see the note at the top.
    await scrollToEnd(page, content);

    const after = await readScroller(content);
    expect(after.scrollTop).toBeGreaterThan(0);

    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    // The last row of the dialog is now inside the viewport, which is the
    // whole point: before this change it sat below the fold with nothing
    // able to scroll it there.
    expect(box!.y + box!.height).toBeLessThanOrEqual(ZOOMED.height);
  });

  test('scrolls with the wheel as well', async ({ page }) => {
    await page.setViewportSize(ZOOMED);
    const content = await openDialog(page, 'dialog-long');

    await page.mouse.move(ZOOMED.width / 2, ZOOMED.height / 2);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(async () => (await readScroller(content)).scrollTop)
      .toBeGreaterThan(0);
  });

  test('starts at its top edge, inside the gutter', async ({ page }) => {
    await page.setViewportSize(ZOOMED);
    const content = await openDialog(page, 'dialog-long');

    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    // 16px of gutter, the padding the header and footer already use.
    expect(box!.y).toBeCloseTo(16, 0);
  });

  test('draws our scrollbar, not the browser default', async ({ page }) => {
    await page.setViewportSize(ZOOMED);
    const content = await openDialog(page, 'dialog-long');

    const scroller = await content.evaluate((node) => {
      const viewport = node.closest('[data-radix-scroll-area-viewport]');
      const root = viewport?.closest('[data-scrollbars]');
      // `data-scrollable` is ours; Radix stamps nothing on the rail.
      const rail = root?.querySelector('[data-scrollable]');
      return {
        axes: root?.getAttribute('data-scrollbars') ?? null,
        hasRail: rail !== null && rail !== undefined,
        nativeHidden:
          viewport instanceof HTMLElement
            ? getComputedStyle(viewport).scrollbarWidth
            : null,
      };
    });

    expect(scroller.axes).toBe('vertical');
    expect(scroller.hasRail).toBe(true);
    expect(scroller.nativeHidden).toBe('none');
  });

  test('keeps the focus inside itself', async ({ page }) => {
    await page.setViewportSize(ZOOMED);
    const content = await openDialog(page, 'dialog-long');

    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await content.evaluate(
        (node) => node.contains(document.activeElement),
      );
      expect(inside).toBe(true);
    }
  });

  test('still closes on Escape and on a click outside it', async ({ page }) => {
    await page.setViewportSize(ZOOMED);
    const content = await openDialog(page, 'dialog-long');

    await page.keyboard.press('Escape');
    await expect(content).toBeHidden();

    await page.getByTestId('dialog-long-trigger').click();
    await expect(content).toBeVisible();
    // Left edge of the screen: inside the overlay, outside the dialog.
    await page.mouse.click(6, ZOOMED.height / 2);
    await expect(content).toBeHidden();
  });

  test('survives a middle click on the scrollbar rail', async ({ page }) => {
    await page.setViewportSize(ZOOMED);
    const content = await openDialog(page, 'dialog-long');

    // The gallery has scrollers of its own, so the rail is found from the
    // dialog outwards rather than by a page-wide selector.
    const box = await content.evaluate((node) => {
      const root = node
        .closest('[data-radix-scroll-area-viewport]')
        ?.closest('[data-scrollbars]');
      const rail = root?.querySelector('[data-scrollable]');
      return rail ? rail.getBoundingClientRect().toJSON() : null;
    });
    expect(box).not.toBeNull();

    // A middle click is a pointer press outside the content, which is what
    // dismisses a dialog — but the rail belongs to the dialog's own scroller,
    // so pressing it must not throw away what the reader was filling in.
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, {
      button: 'middle',
    });
    await expect(content).toBeVisible();
  });
});

test.describe('a dialog that fits', () => {
  test('is centred on both axes', async ({ page }) => {
    await page.setViewportSize(ZOOMED);
    const content = await openDialog(page, 'dialog-short');

    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width / 2).toBeCloseTo(ZOOMED.width / 2, 0);
    expect(box!.y + box!.height / 2).toBeCloseTo(ZOOMED.height / 2, 0);
  });
});

test.describe('an alert dialog', () => {
  test('scrolls the same way when the viewport is short', async ({ page }) => {
    // 160px of height puts even a two-button confirmation out of reach —
    // the shape #166 was reported as, at a deeper zoom.
    await page.setViewportSize({ width: 640, height: 160 });
    const content = await openDialog(page, 'alert-dialog');

    const before = await readScroller(content);
    expect(before.maxScroll).toBeGreaterThan(0);

    await scrollToEnd(page, content);

    const box = await content.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(160);
  });
});

/**
 * The two dialogs that cap their own height.
 *
 * `MembershipPanel` and `CreditsOverlay` pin a height off the viewport and
 * scroll inside themselves, so the overlay's scroller has nothing to do for
 * them and never engages. What is checked here is that this change left them
 * that way — whether their own inner scroll regions answer the wheel is
 * #156's question, not this one's.
 *
 * Needs a running dev server and the smoke account:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
test.describe('a dialog that caps its own height', () => {
  const email = process.env.SMOKE_EMAIL;
  const password = process.env.SMOKE_PASSWORD;

  test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

  /** The session this group signs in for, once — logging in is rate limited. */
  let session: Awaited<ReturnType<BrowserContext['cookies']>> = [];

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    if (!email || !password) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await page.locator('#login-email').fill(email);
    await page.locator('#login-password').fill(password);
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
    session = await context.cookies();
    await context.close();
  });

  /**
   * Open the account menu on the studio page of a signed-in session.
   *
   * @param page The page under test.
   * @returns The opened menu.
   * @throws {Error} When the menu does not open.
   */
  async function openAccountMenu(page: Page): Promise<Locator> {
    await page.context().addCookies(session);
    await page.setViewportSize(ZOOMED);
    await page.goto('/studio');
    await page.getByRole('button', { name: 'Account' }).click();
    const menu = page.getByTestId('account-menu');
    await expect(menu).toBeVisible({ timeout: 10_000 });
    return menu;
  }

  test('leaves the overlay scroller idle, and stays on screen', async ({
    page,
  }) => {
    const menu = await openAccountMenu(page);
    await menu.getByRole('menuitem', { name: 'Membership' }).click();

    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible();
    await panel.evaluate((node) =>
      Promise.all(node.getAnimations().map((a) => a.finished)),
    );

    const at = await readScroller(panel);
    // The panel never outgrows the overlay, so there is nothing to scroll
    // out there — its own region inside does that job.
    expect(at.maxScroll).toBe(0);

    const box = await panel.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(ZOOMED.height);
  });
});

test.describe('an ordinary desktop viewport', () => {
  test('reaches a dialog made tall by how many rows it holds', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    const content = await openDialog(page, 'dialog-long');

    const box = await content.boundingBox();
    // No zoom here: 40 rows are enough on their own.
    expect(box!.height).toBeGreaterThan(DESKTOP.height);

    await scrollToEnd(page, content);
    const scrolled = await content.boundingBox();
    expect(scrolled!.y + scrolled!.height).toBeLessThanOrEqual(DESKTOP.height);
  });
});
