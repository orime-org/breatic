// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #904 验收 A8 · A8b: a run of quoted blocks reads as one quote (task #904).
 *
 * The half jsdom cannot reach. A quote is a prop on each block here, so the
 * rule down its side is drawn per block, and where each segment lands is a
 * question about laid out boxes — jsdom reports every rectangle as zero.
 *
 * The rule the user settled (2026-09-07) is three things: every segment sits
 * at the SAME x however deep its block is indented, each segment runs the
 * height of its own block's text without a break, and no segment reaches past
 * that text. Segments of neighbouring blocks may part; what carries the eye
 * down a run is that they share one vertical line, not that they touch.
 *
 * A8 measures those three. A8b measures the run's outer edges, which are
 * margins — there the run has to stand apart from what surrounds it.
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
  /** Where the block's own text starts and ends. */
  readonly textTop: number;
  readonly textBottom: number;
  /** Whether this block draws a rule at all. */
  readonly ruleDrawn: boolean;
  /** The rule's own box, in page coordinates. */
  readonly ruleX: number;
  /** The box's right edge, which the indentation offset must not move. */
  readonly boxRight: number;
  readonly ruleTop: number;
  readonly ruleHeight: number;
  readonly ruleWidth: number;
  readonly ruleColor: string;
  /** The box's corner radius: a rounded box bends the rule off the shared x. */
  readonly borderRadius: string;
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
      // The rule is the box's own border, so the box is where it lands: its
      // left edge is the rule's x and its height is the rule's height.
      const width = parseFloat(style.borderInlineStartWidth);
      // Where the block's own text is drawn. A code block puts it in
      // `pre > code`, every other type in `.bn-inline-content`; the `pre`
      // itself carries padding, so measuring that instead reports the rule
      // as reaching exactly to a text it actually reaches past.
      // What the block draws: its text, or for a code block the panel that
      // holds it — that panel IS the block as far as a reader is concerned,
      // and the rule runs beside it.
      const text = element.querySelector('.bn-inline-content, pre');
      const textRect = text?.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        textTop: textRect ? textRect.top : rect.top,
        textBottom: textRect ? textRect.bottom : rect.bottom,
        ruleDrawn: width > 0,
        ruleX: rect.left,
        boxRight: rect.right,
        ruleTop: rect.top,
        ruleHeight: rect.height,
        ruleWidth: width,
        ruleColor: style.borderInlineStartColor,
        borderRadius: style.borderRadius,
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
  // the take over the moment the click is — with the bar out of the way
  // first, since it sits over the selection the press before this one made.
  await p.keyboard.press('ArrowLeft');
  await expect(p.getByTestId('doc-bubble-block-type')).toBeHidden({
    timeout: 10_000,
  });
  await p.locator(`${EDITOR} .bn-block-content`).first().click({ clickCount: 3 });
  await p.keyboard.press(`${MOD}+Shift+B`);
  await expect(p.locator(QUOTED)).toHaveCount(3, { timeout: 10_000 });
}

/**
 * Puts the whole of one block in the selection and quotes it.
 * @param p - The page.
 * @param index - Which block, in document order.
 */
async function quoteBlockAt(p: Page, index: number): Promise<void> {
  // Collapse whatever is selected first. The bubble bar sits over the
  // selection it belongs to, and where the block above is near the top of the
  // body it takes the side below — measured, it covered the third block whole
  // and the click for it waited out the timeout.
  await p.keyboard.press('ArrowLeft');
  await expect(p.getByTestId('doc-bubble-block-type')).toBeHidden({
    timeout: 10_000,
  });
  await p
    .locator(`${EDITOR} .bn-block-content`)
    .nth(index)
    .click({ clickCount: 3 });
  await p.keyboard.press(`${MOD}+Shift+B`);
}

/** What a run's two outer edges measure, and the kind of block at each end. */
interface RunEdges {
  readonly opensOn: string | null;
  readonly endsOn: string | null;
  readonly above: number | null;
  readonly below: number | null;
  /** How many groups deep the run's last block and the one below it sit. */
  readonly lastDepth: number;
  readonly belowDepth: number;
}

/**
 * Measures the gap above and below a run of quoted blocks.
 * @param p - The page.
 * @returns Both edges, with the content type of the block at each end.
 */
async function runEdges(p: Page): Promise<RunEdges> {
  return p.evaluate(
    ({ editor, quoted }) => {
      const all = [...document.querySelectorAll(`${editor} .bn-block-content`)];
      const marks = [...document.querySelectorAll(quoted)];
      const first = all.indexOf(marks[0] as Element);
      const last = all.indexOf(marks[marks.length - 1] as Element);
      const box = (element: Element | undefined): DOMRect | null =>
        element === undefined ? null : element.getBoundingClientRect();
      const above = box(all[first - 1]);
      const below = box(all[last + 1]);
      const kind = (element: Element | undefined): string | null =>
        element?.getAttribute('data-content-type') ?? null;
      const depth = (element: Element | undefined): number => {
        let n = 0;
        let at: Element | null = element ?? null;
        while (at !== null) {
          if (at.classList.contains('bn-block-group')) n += 1;
          at = at.parentElement;
        }
        return n;
      };
      return {
        lastDepth: depth(all[last]),
        belowDepth: depth(all[last + 1]),
        opensOn: kind(all[first]),
        endsOn: kind(all[last]),
        above: above === null ? null : box(all[first])!.top - above.bottom,
        below: below === null ? null : below.top - box(all[last])!.bottom,
      };
    },
    { editor: EDITOR, quoted: QUOTED },
  );
}

test.describe('a run of quoted blocks', () => {
  test('draws a segment down each of the three, on one line (A8)', async () => {
    await openFreshDocument(page);
    await writeQuotedRun(page);

    const boxes = await quoteBoxes(page);
    expect(boxes).toHaveLength(3);

    for (const box of boxes) {
      expect(box.ruleDrawn, 'each block draws the rule').toBe(true);
      expect(box.ruleWidth).toBe(2);
      expect(box.paddingLeft).toBeGreaterThan(0);
    }

    // One vertical line: every segment at the same x, whatever the block is.
    const xs = boxes.map((box) => box.ruleX);
    for (const x of xs) {
      expect(Math.abs(x - xs[0]!), `segments sit at ${xs.join(', ')}`).toBeLessThan(1);
    }

    // Nothing outside the block's own text, at either end.
    for (const [i, box] of boxes.entries()) {
      expect(box.ruleTop, `block ${i} draws above its text`).toBeGreaterThanOrEqual(
        box.textTop - 1,
      );
      expect(
        box.ruleTop + box.ruleHeight,
        `block ${i} draws below its text`,
      ).toBeLessThanOrEqual(box.textBottom + 1);
    }
  });

  test('draws one segment down each block, at one x whatever the indent (A8)', async () => {
    await openFreshDocument(page);
    // A quoted block at the top level and another indented under a list item:
    // the rule is what tells a reader they belong to one quote, and it can
    // only do that from one x.
    await page.keyboard.type('1. one');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('two');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.type('three');
    await quoteBlockAt(page, 1);
    await quoteBlockAt(page, 2);

    const boxes = await quoteBoxes(page);
    expect(boxes).toHaveLength(2);
    for (const box of boxes) {
      expect(box.ruleDrawn).toBe(true);
    }
    const [indented, top] = boxes as [QuoteBox, QuoteBox];
    expect(
      Math.abs(indented.ruleX - top.ruleX),
      `indented block draws at ${indented.ruleX}, top-level at ${top.ruleX}`,
    ).toBeLessThan(1);

    // Pulling the box back out must not cost it width: the line the reader
    // writes on ends where every other line ends.
    expect(
      Math.abs(indented.boxRight - top.boxRight),
      `indented block ends at ${indented.boxRight}, top-level at ${top.boxRight}`,
    ).toBeLessThan(1);

    // Each segment covers its own block's text without a break.
    for (const box of boxes) {
      expect(box.ruleHeight).toBeGreaterThan(
        (box.textBottom - box.textTop) * 0.9,
      );
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
    // The run's own margins stand it apart from what surrounds it, and they
    // are larger than the space between two blocks inside it. That inner
    // space is a margin too — outside the box, where the border cannot reach
    // it, which is what parts the segments and stops each at its own text.
    const outer = margins[0]!.top;
    expect(outer).toBeGreaterThan(8);
    expect(margins[margins.length - 1]!.bottom).toBeGreaterThan(8);
    expect(margins[1]!.top).toBeGreaterThan(0);
    expect(margins[1]!.top).toBeLessThan(outer);
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

    const edges = await runEdges(page);

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

    const edges = await runEdges(page);

    expect(edges.endsOn, 'the run ends on a heading').toBe('heading');
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

    const edges = await runEdges(page);

    expect(edges.opensOn, 'the run opens on a heading').toBe('heading');
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

    const seen = await runEdges(page);

    expect(seen.below, 'a block below the run').not.toBeNull();
    const measured = seen;
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
      measured.below as number,
      `${String(measured.below)}px below the run`,
    ).toBeGreaterThan(15.5);
    expect(
      measured.below as number,
      `${String(measured.below)}px below the run`,
    ).toBeLessThan(17.5);
  });

  test('holds all three rules when the run holds a code block (A8)', async () => {
    await openFreshDocument(page);
    await writeQuotedRun(page);
    // A code block is one of the nine types a quote coexists with (A7), and
    // the only one whose content element BlockNote gives a background, a
    // radius and a `pre` of its own.
    await page.locator(`${EDITOR} .bn-block-content`).nth(2).click();
    await page.keyboard.press(`${MOD}+Alt+c`);
    await expect(
      page.locator(`${QUOTED}[data-content-type="codeBlock"]`),
    ).toHaveCount(1, { timeout: 10_000 });

    const boxes = await quoteBoxes(page);
    expect(boxes).toHaveLength(3);

    const xs = boxes.map((box) => box.ruleX);
    for (const x of xs) {
      expect(Math.abs(x - xs[0]!), `segments sit at ${xs.join(', ')}`).toBeLessThan(1);
    }
    for (const [i, box] of boxes.entries()) {
      expect(box.ruleTop, `block ${i} draws above its own`).toBeGreaterThanOrEqual(
        box.textTop - 1,
      );
      expect(
        box.ruleTop + box.ruleHeight,
        `block ${i} draws below its own`,
      ).toBeLessThanOrEqual(box.textBottom + 1);
    }
    // A rounded box curves its border away at both ends, so the segment stops
    // being a line on the shared x and becomes a bracket. Measured before this
    // was set: the segment beside the panel ran y 506-541 against the panel's
    // 503-544, hooking out to x+3 at each end.
    for (const [i, box] of boxes.entries()) {
      expect(box.borderRadius, `block ${i} draws a straight rule`).toBe('0px');
    }
    // And the right edge, which the code block's own panel must not move.
    const rights = boxes.map((box) => box.boxRight);
    for (const right of rights) {
      expect(Math.abs(right - rights[0]!), `blocks end at ${rights.join(', ')}`).toBeLessThan(1);
    }
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
    // A heading takes its own space above it, and the segments part over that
    // space the way they do between two paragraphs. What has to survive the
    // taller block is the x they share and the text each one covers.
    const xs = boxes.map((box) => box.ruleX);
    for (const x of xs) {
      expect(
        Math.abs(x - xs[0]!),
        `segments sit at ${xs.join(', ')}`,
      ).toBeLessThan(1);
    }
    for (const [i, box] of boxes.entries()) {
      expect(box.ruleTop, `block ${i} draws above its text`).toBeGreaterThanOrEqual(
        box.textTop - 1,
      );
      expect(
        box.ruleTop + box.ruleHeight,
        `block ${i} draws below its text`,
      ).toBeLessThanOrEqual(box.textBottom + 1);
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
      expect(box.ruleColor, 'the rule is drawn in the border token').toBe(
        tokens.border,
      );
      expect(box.ruleWidth, 'the rule is 2px').toBe(2);
      // `1em`, which is the block's own size — writing the pixel here would
      // pin the body's font size in a case that is about the quote. Every
      // block in this run is at the top level; an indented one carries the
      // indentation it gives back on top of this.
      expect(box.paddingLeft, 'the text stands 1em clear of the rule').toBe(
        box.fontSize,
      );
    }
  });
});
