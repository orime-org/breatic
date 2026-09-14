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
 * The gallery at /dev/primitives is the surface: it renders the primitives
 * through the real component tree and needs no session.
 */
import { test, expect, type Page, type Locator } from 'playwright/test';

/** Viewport equivalent to 1280x720 at 200% zoom, where #166 was reported. */
const ZOOMED = { width: 640, height: 320 };
/** An ordinary desktop viewport, where only row count makes a dialog tall. */
const DESKTOP = { width: 1280, height: 720 };

test.use({ viewport: ZOOMED });

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
  await settle(content);
  return content;
}

/**
 * Wait for an element's own animations to finish.
 *
 * @param element The element.
 * @throws {Error} When an animation never finishes.
 */
async function settle(element: Locator): Promise<void> {
  await element.evaluate((node) =>
    Promise.all(node.getAnimations().map((a) => a.finished)),
  );
}

/**
 * Read the element the overlay actually scrolls.
 *
 * @param content The opened dialog content.
 * @returns Its scroll offset and the furthest it can go.
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

/**
 * Measure the overlay's own scrollbar rail.
 *
 * `:scope >` is what makes it the overlay's: the Root renders its viewport
 * first and its rails after, so a plain descendant query returns the rail of
 * any scroller the dialog has inside it.
 *
 * @param content The opened dialog content.
 * @returns The rail's box on screen.
 * @throws {Error} When the overlay has no rail.
 */
async function railBox(
  content: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await content.evaluate((node) => {
    const root = node
      .closest('[data-radix-scroll-area-viewport]')
      ?.closest('[data-scrollbars]');
    const rail = root?.querySelector(':scope > [data-scrollable]');
    return rail ? rail.getBoundingClientRect().toJSON() : null;
  });
  if (!box) throw new Error('the overlay has no rail');
  return box;
}

/**
 * Assert the dialog is still open once a dismissal would have played out.
 *
 * A dismissed dialog stays mounted for the 200ms of its exit animation, so
 * reading visibility straight after the gesture passes either way.
 *
 * @param page The page under test.
 * @param content The opened dialog content.
 * @throws {Error} When the dialog closed.
 */
async function expectStillOpen(page: Page, content: Locator): Promise<void> {
  await page.waitForTimeout(400);
  await expect(content).toBeVisible();
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

test.describe('a dialog taller than the viewport', () => {
  test('scrolls with the keyboard until its bottom edge is on screen', async ({
    page,
  }) => {
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
    const content = await openDialog(page, 'dialog-long');

    await page.mouse.move(ZOOMED.width / 2, ZOOMED.height / 2);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(async () => (await readScroller(content)).scrollTop)
      .toBeGreaterThan(0);
  });

  test('starts at its top edge, inside the gutter', async ({ page }) => {
    const content = await openDialog(page, 'dialog-long');

    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeCloseTo(16, 0);
  });

  test('draws our scrollbar, not the browser default', async ({ page }) => {
    const content = await openDialog(page, 'dialog-long');

    const scroller = await content.evaluate((node) => {
      const viewport = node.closest('[data-radix-scroll-area-viewport]');
      const root = viewport?.closest('[data-scrollbars]');
      // `data-scrollable` is ours; Radix stamps nothing on the rail. Its
      // value is what says the axis is live — the rail is force-mounted, so
      // the attribute is there either way.
      const rail = root?.querySelector(':scope > [data-scrollable]');
      return {
        axes: root?.getAttribute('data-scrollbars') ?? null,
        railLive: rail?.getAttribute('data-scrollable') ?? null,
        nativeHidden:
          viewport instanceof HTMLElement
            ? getComputedStyle(viewport).scrollbarWidth
            : null,
      };
    });

    expect(scroller.axes).toBe('vertical');
    expect(scroller.railLive).toBe('true');
    expect(scroller.nativeHidden).toBe('none');
  });

  test('keeps the focus inside itself', async ({ page }) => {
    const content = await openDialog(page, 'dialog-long');

    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await content.evaluate((node) =>
        node.contains(document.activeElement),
      );
      expect(inside).toBe(true);
    }
  });

  test('still closes on Escape and on a click outside it', async ({ page }) => {
    const content = await openDialog(page, 'dialog-long');

    await page.keyboard.press('Escape');
    await expect(content).toBeHidden();

    await page.getByTestId('dialog-long-trigger').click();
    await expect(content).toBeVisible();
    // Left edge of the screen: inside the overlay, outside the dialog.
    await page.mouse.click(6, ZOOMED.height / 2);
    await expect(content).toBeHidden();
  });

  test('survives any button pressed on the scrollbar rail', async ({ page }) => {
    const content = await openDialog(page, 'dialog-long');
    const box = await railBox(content);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Dragging the thumb is what a reader does with a bar, and it is a press
    // outside the content for as long as it lasts.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 60);
    await page.mouse.up();
    await expectStillOpen(page, content);
    expect((await readScroller(content)).scrollTop).toBeGreaterThan(0);

    // A press of any other button is a press outside the content too, and the
    // rail is the dialog's own — pressing it must not throw away what the
    // reader was filling in.
    for (const button of ['middle', 'right'] as const) {
      await page.mouse.click(cx, cy, { button });
      await expectStillOpen(page, content);
    }
  });
});

test.describe('a dialog that fits', () => {
  test('is centred on both axes', async ({ page }) => {
    const content = await openDialog(page, 'dialog-short');

    const box = await content.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width / 2).toBeCloseTo(ZOOMED.width / 2, 0);
    expect(box!.y + box!.height / 2).toBeCloseTo(ZOOMED.height / 2, 0);
  });
});

test.describe('a dialog that caps its own height', () => {
  test('scrolls inside itself, and leaves the overlay scroller idle', async ({
    page,
  }) => {
    const content = await openDialog(page, 'dialog-capped');

    // The outer scroller has nothing to do: the dialog fits by its own doing.
    expect((await readScroller(content)).maxScroll).toBe(0);
    const box = await content.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(ZOOMED.height);

    // Its own region does the work, and answers the wheel.
    const region = page.getByTestId('dialog-capped-region');
    const inner = await region.evaluate((node) => {
      const vp = node.querySelector('[data-radix-scroll-area-viewport]');
      return {
        maxScroll: vp.scrollHeight - vp.clientHeight,
        scrollTop: vp.scrollTop,
      };
    });
    expect(inner.maxScroll).toBeGreaterThan(0);
    expect(inner.scrollTop).toBe(0);

    await page.mouse.move(ZOOMED.width / 2, ZOOMED.height / 2);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() =>
        region.evaluate(
          (node) =>
            node.querySelector('[data-radix-scroll-area-viewport]').scrollTop,
        ),
      )
      .toBeGreaterThan(0);
  });
});

test.describe('an alert dialog', () => {
  // 160px of height puts even a two-button confirmation out of reach — the
  // shape #166 was reported as, at a deeper zoom.
  test.use({ viewport: { width: 640, height: 160 } });

  test('scrolls the same way when the viewport is short', async ({ page }) => {
    const content = await openDialog(page, 'alert-dialog');

    const before = await readScroller(content);
    expect(before.maxScroll).toBeGreaterThan(0);

    await scrollToEnd(page, content);

    const box = await content.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(160);
  });
});

test.describe('an ordinary desktop viewport', () => {
  test.use({ viewport: DESKTOP });

  test('reaches a dialog made tall by how many rows it holds', async ({
    page,
  }) => {
    const content = await openDialog(page, 'dialog-long');

    const box = await content.boundingBox();
    // No zoom here: 40 rows are enough on their own.
    expect(box!.height).toBeGreaterThan(DESKTOP.height);

    await scrollToEnd(page, content);
    const scrolled = await content.boundingBox();
    expect(scrolled!.y + scrolled!.height).toBeLessThanOrEqual(DESKTOP.height);
  });
});
