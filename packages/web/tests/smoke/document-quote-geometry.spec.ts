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
  readonly fontSize: number;
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
        fontSize: parseFloat(style.fontSize),
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

  test('sits the same distance from what is above and below it (A8b)', async () => {
    await openFreshDocument(page);
    await writeQuotedRun(page);
    // A plain line below the run as well, so both edges have a neighbour.
    await page.locator(`${EDITOR} .bn-block-content`).last().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+Shift+B`);
    await page.keyboard.type('a plain line below');
    await expect(page.locator(QUOTED)).toHaveCount(3, { timeout: 10_000 });

    const edges = await page.evaluate(
      ({ editor, quoted }) => {
        const all = [...document.querySelectorAll(`${editor} .bn-block-content`)];
        const marks = [...document.querySelectorAll(quoted)];
        const firstQuoted = all.indexOf(marks[0] as Element);
        const lastQuoted = all.indexOf(marks[marks.length - 1] as Element);
        const box = (element: Element | undefined): DOMRect | null =>
          element === undefined ? null : element.getBoundingClientRect();
        const above = box(all[firstQuoted - 1]);
        const below = box(all[lastQuoted + 1]);
        return {
          above:
            above === null ? null : box(all[firstQuoted])!.top - above.bottom,
          below:
            below === null ? null : below.top - box(all[lastQuoted])!.bottom,
        };
      },
      { editor: EDITOR, quoted: QUOTED },
    );

    expect(edges.above, 'a line above the run').not.toBeNull();
    expect(edges.below, 'a line below the run').not.toBeNull();
    // Both edges are the run's own 1.1em and nothing else. The gap below used
    // to be that margin plus the next block's own, added rather than replaced,
    // and it grew again for any block with a bigger one — an h1 below the run
    // put 63px there against 17px above it.
    expect(
      Math.abs((edges.below as number) - (edges.above as number)),
      `above ${String(edges.above)}px, below ${String(edges.below)}px`,
    ).toBeLessThan(1);
  });

  test('keeps those edges when the run ends on a heading (A8b)', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('a plain line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('quoted one');
    await page.keyboard.press(`${MOD}+Shift+B`);
    await expect(page.locator(QUOTED)).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('a quoted heading');
    await page.keyboard.press(`${MOD}+Alt+1`);
    await expect(
      page.locator(`${QUOTED}[data-content-type="heading"]`),
    ).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+Shift+B`);
    await page.keyboard.type('a plain line below');
    await expect(page.locator(QUOTED)).toHaveCount(2, { timeout: 10_000 });

    const edges = await page.evaluate(
      ({ editor, quoted }) => {
        const all = [...document.querySelectorAll(`${editor} .bn-block-content`)];
        const marks = [...document.querySelectorAll(quoted)];
        const first = all.indexOf(marks[0] as Element);
        const last = all.indexOf(marks[marks.length - 1] as Element);
        const box = (element: Element | undefined): DOMRect | null =>
          element === undefined ? null : element.getBoundingClientRect();
        const above = box(all[first - 1]);
        const below = box(all[last + 1]);
        return {
          endsOnHeading:
            (all[last] as Element).getAttribute('data-content-type') === 'heading',
          above: above === null ? null : box(all[first])!.top - above.bottom,
          below: below === null ? null : below.top - box(all[last])!.bottom,
        };
      },
      { editor: EDITOR, quoted: QUOTED },
    );

    expect(edges.endsOnHeading, 'the run ends on a heading').toBe(true);
    // The run's outer edges belong to the run, not to whichever block happens
    // to sit at each end. Measured while they were set in `em`, which resolves
    // against the end block's own size: 16.5px above and 26.39px below, the
    // heading's 24px carrying the lower one.
    expect(
      Math.abs((edges.below as number) - (edges.above as number)),
      `above ${String(edges.above)}px, below ${String(edges.below)}px`,
    ).toBeLessThan(1);
  });

  test('keeps those edges when the run OPENS on a heading (A8b)', async () => {
    await openFreshDocument(page);
    await page.keyboard.type('a plain line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('a quoted heading');
    await page.keyboard.press(`${MOD}+Shift+B`);
    await expect(page.locator(QUOTED)).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press(`${MOD}+Alt+1`);
    await expect(
      page.locator(`${QUOTED}[data-content-type="heading"]`),
    ).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('quoted two');
    await expect(page.locator(QUOTED)).toHaveCount(2, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${MOD}+Shift+B`);
    await page.keyboard.type('a plain line below');
    await expect(page.locator(QUOTED)).toHaveCount(2, { timeout: 10_000 });

    const edges = await page.evaluate(
      ({ editor, quoted }) => {
        const all = [...document.querySelectorAll(`${editor} .bn-block-content`)];
        const marks = [...document.querySelectorAll(quoted)];
        const first = all.indexOf(marks[0] as Element);
        const last = all.indexOf(marks[marks.length - 1] as Element);
        const box = (element: Element | undefined): DOMRect | null =>
          element === undefined ? null : element.getBoundingClientRect();
        const above = box(all[first - 1]);
        const below = box(all[last + 1]);
        return {
          opensOnHeading:
            (all[first] as Element).getAttribute('data-content-type') ===
            'heading',
          above: above === null ? null : box(all[first])!.top - above.bottom,
          below: below === null ? null : below.top - box(all[last])!.bottom,
        };
      },
      { editor: EDITOR, quoted: QUOTED },
    );

    expect(edges.opensOnHeading, 'the run opens on a heading').toBe(true);
    // The other half of the pair the case above measures. Written in bare `em`
    // this edge resolved against the heading: 26.39px over the run against
    // 16.5px under it.
    expect(
      Math.abs((edges.below as number) - (edges.above as number)),
      `above ${String(edges.above)}px, below ${String(edges.below)}px`,
    ).toBeLessThan(1);
  });

  test('keeps those edges when the run ends inside an indent (A8b)', async () => {
    await openFreshDocument(page);
    // Built block by block: a select-all here swallows the document on the
    // next Enter. Quote goes on the first and is inherited down the run.
    await page.keyboard.type('- outer one');
    await page.keyboard.press(`${MOD}+Shift+B`);
    await expect(page.locator(QUOTED)).toHaveCount(1, { timeout: 10_000 });
    await page.keyboard.press('Enter');
    await page.keyboard.type('inner two');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await page.keyboard.type('inner three');
    await expect(page.locator(QUOTED)).toHaveCount(3, { timeout: 10_000 });
    // Out of the indent for the block below, so the run's last block and it
    // sit in different groups — which is where a sibling combinator gave up.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press(`${MOD}+Shift+B`);
    await page.keyboard.type('below the run');
    await expect(page.locator(QUOTED)).toHaveCount(3, { timeout: 10_000 });

    const seen = await page.evaluate(
      ({ editor, quoted }) => {
        const all = [...document.querySelectorAll(`${editor} .bn-block-content`)];
        const marks = [...document.querySelectorAll(quoted)];
        const last = all.indexOf(marks[marks.length - 1] as Element);
        const below = all[last + 1];
        /** How many groups deep an element sits. */
        const depth = (element: Element): number => {
          let n = 0;
          let at: Element | null = element;
          while (at !== null) {
            if (at.classList.contains('bn-block-group')) n += 1;
            at = at.parentElement;
          }
          return n;
        };
        if (below === undefined) return null;
        return {
          lastDepth: depth(all[last] as Element),
          belowDepth: depth(below),
          gap:
            below.getBoundingClientRect().top -
            (all[last] as Element).getBoundingClientRect().bottom,
        };
      },
      { editor: EDITOR, quoted: QUOTED },
    );

    expect(seen, 'a block below the run').not.toBeNull();
    const measured = seen as NonNullable<typeof seen>;
    // The shape first: without it this passes on a flat document, where the
    // two are siblings and a combinator would have reached across.
    expect(
      measured.lastDepth,
      'the run ends a level deeper than the block below',
    ).toBeGreaterThan(measured.belowDepth);
    // The run's own 1.1em and nothing added to it — 16.5px on this body size,
    // the same as the case above measures on both edges of a flat run.
    // Measured before the mark went on the block itself: 29.25px, that margin
    // plus the 12.75px this block kept.
    expect(
      measured.gap,
      `${String(measured.gap)}px below the run`,
    ).toBeGreaterThan(15.5);
    expect(
      measured.gap,
      `${String(measured.gap)}px below the run`,
    ).toBeLessThan(17.5);
  });

  test('draws the rule down a run that holds a heading (A8)', async () => {
    await openFreshDocument(page);
    await writeQuotedRun(page);
    // The middle block becomes a heading, which a quote can hold: `quoted` is
    // a prop on every block, and C9b covers a numbered heading inside one.
    //
    // The chord goes to the block the caret is in, so the run's own selection
    // has to be gone before it lands — collapsing it takes a frame, and the
    // bubble bar's own disappearance is what says that frame has passed.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('doc-selection-bubble-bar')).toBeHidden({
      timeout: 10_000,
    });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press(`${MOD}+Alt+1`);
    await expect(
      page.locator(`${QUOTED}[data-content-type="heading"]`),
    ).toHaveCount(1, { timeout: 10_000 });

    const boxes = await quoteBoxes(page);
    expect(boxes).toHaveLength(3);
    for (let i = 1; i < boxes.length; i += 1) {
      const gap = boxes[i]!.top - boxes[i - 1]!.bottom;
      expect(
        Math.abs(gap),
        `blocks ${i - 1} and ${i} leave a ${gap}px gap in the rule`,
      ).toBeLessThan(1);
    }
  });

  test('draws its text and its rule in our own values (A8b)', async () => {
    await openFreshDocument(page);
    await writeQuotedRun(page);

    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const paint = (value: string): string => {
        const probe = document.createElement('span');
        probe.style.color = value;
        document.body.appendChild(probe);
        const painted = getComputedStyle(probe).color;
        probe.remove();
        return painted;
      };
      return {
        muted: paint(style.getPropertyValue('--color-muted-foreground').trim()),
        border: paint(style.getPropertyValue('--color-border').trim()),
      };
    });

    const boxes = await quoteBoxes(page);
    for (const box of boxes) {
      // The six things A8b names, by value rather than by "more than zero":
      // the muted text is the only signal besides the rule that a block is
      // quoted, and an inequality passes on a unit slip.
      expect(box.color, 'the quote draws its text muted').toBe(tokens.muted);
      expect(box.borderColor, 'the rule is drawn in the border token').toBe(
        tokens.border,
      );
      expect(box.borderWidth, 'the rule is 2px').toBe(2);
      // `1em`, which is the block's own size — writing the pixel here would
      // pin the body's font size in a case that is about the quote.
      expect(box.paddingLeft, 'the text stands 1em clear of the rule').toBe(
        box.fontSize,
      );
    }
  });
});
