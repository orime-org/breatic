// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A8 · A8b: a run of quoted blocks reads as one quote (task #904).
 *
 * The half jsdom cannot reach. A quote is a prop on each block here, so the
 * rule down its side is drawn per block, and whether a run reads as ONE quote
 * comes down to whether those segments meet — which is a question about laid
 * out boxes, and jsdom reports every rectangle as zero.
 *
 * What makes them meet is where the space between two quoted blocks goes: the
 * rule is drawn on the box's border, so a gap held as margin breaks it and the
 * same gap held as padding does not. A8 measures the seams. A8b measures the
 * run's outer edges, which are margins — there the run has to stand apart from
 * what surrounds it.
 *
 * Wants dev running and a smoke account:
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

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

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

/** Which project this run works in; without one, the top of the studio page. */
const projectUrl = process.env.SMOKE_PROJECT_URL;

const EDITOR = '[data-testid="document-space"] .ProseMirror';
const QUOTED = `${EDITOR} [data-quoted="true"]`;

/** The Cmd key on macOS, Ctrl everywhere else. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * Opens a freshly made Document Space with the caret in the body.
 * @param p - The page.
 */
async function openFreshDocument(p: Page): Promise<void> {
  if (projectUrl === undefined) {
    await p.goto('/studio');
    const firstProject = p.locator('a[href^="/project/"]').first();
    await expect(firstProject).toBeVisible({ timeout: 15_000 });
    await firstProject.click();
  } else {
    await p.goto(projectUrl);
  }
  await p.waitForURL(/\/project\//, { timeout: 15_000 });

  createdSpaceIds.push(await createSpace(p, 'document', `quote-${Date.now()}`));

  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await expect(p.getByTestId('new-space-button')).toBeFocused();
  await editor.click();
  await expect(editor).toBeFocused();
}

/** One block's box and the four declarations the quote puts on it. */
interface QuoteBox {
  readonly top: number;
  readonly bottom: number;
  readonly borderWidth: number;
  readonly borderColor: string;
  readonly paddingLeft: number;
  readonly color: string;
  readonly first: boolean;
  readonly last: boolean;
}

/**
 * Measures every quoted block on the page.
 * @param p - The page.
 * @returns One entry per quoted block, in document order.
 */
async function quoteBoxes(p: Page): Promise<QuoteBox[]> {
  return p.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        borderWidth: parseFloat(style.borderInlineStartWidth),
        borderColor: style.borderInlineStartColor,
        paddingLeft: parseFloat(style.paddingInlineStart),
        color: style.color,
        first: element.hasAttribute('data-quoted-first'),
        last: element.hasAttribute('data-quoted-last'),
      };
    });
  }, QUOTED);
}

/**
 * Writes three lines and turns the whole document into one quote.
 *
 * Taking everything is what makes the selection reliable: a run needs at least
 * two blocks for there to be a seam to measure, and reaching an exact middle
 * range depends on where the caret was left by the typing.
 * @param p - The page.
 */
async function writeQuotedRun(p: Page): Promise<void> {
  // A plain block above the run, so the run's first block is not also the
  // document's — the first block of a document carries no space above it,
  // and the run's own top margin is what this measures.
  await p.keyboard.type('a plain line');
  await p.keyboard.press('Enter');
  await p.keyboard.type('quoted one');
  await p.keyboard.press('Enter');
  await p.keyboard.type('quoted two');
  await p.keyboard.press('Enter');
  await p.keyboard.type('quoted three');

  // Two presses of `Mod-a`: the first takes the block, the second the document.
  await p.keyboard.press(`${MOD}+a`);
  await p.keyboard.press(`${MOD}+a`);
  await p.keyboard.press(`${MOD}+Shift+B`);
  await expect(p.locator(QUOTED)).toHaveCount(4, { timeout: 10_000 });

  // And the top one back out, leaving three. Taking it by triple click keeps
  // the take over the moment the click is.
  await p.locator(`${EDITOR} .bn-block-content`).first().click({ clickCount: 3 });
  await p.keyboard.press(`${MOD}+Shift+B`);
  await expect(p.locator(QUOTED)).toHaveCount(3, { timeout: 10_000 });
}

test.describe('a run of quoted blocks', () => {
  test('draws one unbroken rule down all three (A8)', async () => {
    await openFreshDocument(page);
    await writeQuotedRun(page);

    const boxes = await quoteBoxes(page);
    expect(boxes).toHaveLength(3);

    for (const box of boxes) {
      expect(box.borderWidth, 'each block draws the rule').toBe(2);
      expect(box.paddingLeft).toBeGreaterThan(0);
    }

    // The seam between two blocks: the rule is continuous when one box ends
    // exactly where the next begins. Sub-pixel layout makes an exact equality
    // the wrong assertion; a gap a reader could see is a whole pixel.
    for (let i = 1; i < boxes.length; i += 1) {
      const gap = boxes[i]!.top - boxes[i - 1]!.bottom;
      expect(
        Math.abs(gap),
        `blocks ${i - 1} and ${i} leave a ${gap}px gap in the rule`,
      ).toBeLessThan(1);
    }
  });

  test('marks its two ends and no block between them (A8b)', async () => {
    await openFreshDocument(page);
    await writeQuotedRun(page);

    const boxes = await quoteBoxes(page);
    expect(boxes.map((box) => box.first)).toEqual([true, false, false]);
    expect(boxes.map((box) => box.last)).toEqual([false, false, true]);
  });

  test('carries its outer margins on the two blocks at its ends (A8b)', async () => {
    await openFreshDocument(page);
    await writeQuotedRun(page);

    const margins = await page.evaluate((sel) => {
      const quoted = [...document.querySelectorAll(sel)];
      return quoted.map((element) => {
        const style = getComputedStyle(element);
        return {
          top: parseFloat(style.marginTop),
          bottom: parseFloat(style.marginBottom),
        };
      });
    }, QUOTED);

    expect(margins).toHaveLength(3);
    // The run's own margins, on the blocks at its ends and nowhere else —
    // which is what keeps the seams inside it at zero while the run as a
    // whole stands apart from what surrounds it.
    expect(margins[0]!.top).toBeGreaterThan(8);
    expect(margins[margins.length - 1]!.bottom).toBeGreaterThan(8);
    expect(margins[1]!.top).toBe(0);
    expect(margins[1]!.bottom).toBe(0);
  });
});
