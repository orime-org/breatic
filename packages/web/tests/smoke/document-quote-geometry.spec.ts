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
      // The rule is the content element's own border: a quote runs beside the
      // words, and a block's outer space is not content. The wrapper's box
      // holds that outer space, because `.bn-block` is a flex container and
      // does not collapse a child's margins away.
      const ruleStyle = style;
      const rect = element.getBoundingClientRect();
      const width = parseFloat(ruleStyle.borderInlineStartWidth);
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
        ruleColor: ruleStyle.borderInlineStartColor,
        borderRadius: ruleStyle.borderRadius,
        paddingLeft: parseFloat(ruleStyle.paddingInlineStart),
        fontSize: parseFloat(style.fontSize),
        color: style.color,
        first:
          element.closest('.bn-block-outer')?.hasAttribute('data-quoted-run-first') ??
          false,
        last:
          element.closest('.bn-block-outer')?.hasAttribute('data-quoted-run-last') ??
          false,
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

/** What the middle block of three has around it. */
interface MiddleGaps {
  /** The gap to the block above, in page pixels. */
  readonly above: number;
  /** The gap to the block below. */
  readonly below: number;
  /** Where its words start, which quoting is allowed to move. */
  readonly left: number;
  /** How tall the block's own content box is. */
  readonly height: number;
  /** The wrapper's outer box, which is what carries the run's own spacing. */
  readonly wrapperTop: number;
  /** Where that wrapper ends. */
  readonly wrapperBottom: number;
}

/**
 * Measures the second of three blocks against its neighbours.
 *
 * Read off the content elements, which is where a reader's words are: the
 * wrapper's box carries the rule and the padding that clears it, and neither
 * of those is what "how far apart are these two lines" means.
 * @param p - The page.
 * @returns The gaps above and below it, and where its text begins.
 * @throws {Error} When the document does not hold three blocks.
 */
async function middleGaps(p: Page): Promise<MiddleGaps> {
  return p.evaluate((sel) => {
    const all = [...document.querySelectorAll(`${sel} .bn-block-content`)];
    if (all.length !== 3) {
      throw new Error(`expected three blocks, found ${String(all.length)}`);
    }
    const [first, middle, last] = all.map((el) => el.getBoundingClientRect());
    const wrapper = all[1]!.closest('.bn-block-outer')!.getBoundingClientRect();
    return {
      above: middle!.top - first!.bottom,
      below: last!.top - middle!.bottom,
      left: middle!.left,
      height: middle!.height,
      wrapperTop: wrapper.top,
      wrapperBottom: wrapper.bottom,
    };
  }, EDITOR);
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

    // Beside the words and nothing else: a block's own outer space is not
    // content, and a rule reaching into it stood 100.78px tall beside a
    // heading whose words are 31.19px (user 2026-09-08).
    for (const [i, box] of boxes.entries()) {
      expect(box.ruleTop, `segment ${i} starts at its own words`).toBeGreaterThanOrEqual(
        box.textTop - 1,
      );
      expect(
        box.ruleTop + box.ruleHeight,
        `segment ${i} ends at its own words`,
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

  test('leaves the space above and below exactly as it was (A8c)', async () => {
    // Quoting a paragraph changes nothing in the vertical: the distance to the
    // line above it and to the line below it is what it was before (user
    // 2026-09-08). What changes is horizontal — a rule appears on the left and
    // the words move right to clear it.
    await openFreshDocument(page);
    await page.keyboard.type('a line above');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the one to quote');
    await page.keyboard.press('Enter');
    await page.keyboard.type('a line below');

    const before = await middleGaps(page);

    await page.locator(`${EDITOR} .bn-block-content`).nth(1).click();
    await page.keyboard.press(`${MOD}+Shift+B`);
    await expect(page.locator(QUOTED)).toHaveCount(1, { timeout: 10_000 });

    const after = await middleGaps(page);

    const report =
      `above ${String(before.above)}->${String(after.above)} ` +
      `below ${String(before.below)}->${String(after.below)} ` +
      `height ${String(before.height)}->${String(after.height)} ` +
      `wrapper ${String(before.wrapperTop)}..${String(before.wrapperBottom)}` +
      ` -> ${String(after.wrapperTop)}..${String(after.wrapperBottom)}`;
    expect(Math.abs(after.above - before.above), report).toBeLessThan(1);
    expect(Math.abs(after.below - before.below), report).toBeLessThan(1);
    expect(Math.abs(after.height - before.height), report).toBeLessThan(1);
    // The horizontal move is what quoting is allowed to do, and it did happen.
    expect(after.left, 'the words moved right to clear the rule').toBeGreaterThan(
      before.left,
    );
  });

  test('leaves a list item where it was in the vertical (A8c)', async () => {
    // The shape that shows it: rows of a list sit 4px apart, far less than the
    // space between paragraphs, so a margin the run adds at its ends has
    // nothing to collapse into and the row visibly moves.
    await openFreshDocument(page);
    await page.keyboard.type('first row');
    await page.keyboard.press(`${MOD}+Shift+7`);
    await page.keyboard.press('Enter');
    await page.keyboard.type('the one to quote');
    await page.keyboard.press('Enter');
    await page.keyboard.type('third row');
    await expect(
      page.locator(`${EDITOR} [data-content-type="numberedListItem"]`),
    ).toHaveCount(3, { timeout: 10_000 });

    const before = await middleGaps(page);

    await page.locator(`${EDITOR} .bn-block-content`).nth(1).click();
    await page.keyboard.press(`${MOD}+Shift+B`);
    await expect(page.locator(QUOTED)).toHaveCount(1, { timeout: 10_000 });

    const after = await middleGaps(page);

    expect(
      Math.abs(after.above - before.above),
      `above: ${String(before.above)}px unquoted, ${String(after.above)}px quoted`,
    ).toBeLessThan(1);
    expect(
      Math.abs(after.below - before.below),
      `below: ${String(before.below)}px unquoted, ${String(after.below)}px quoted`,
    ).toBeLessThan(1);
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
