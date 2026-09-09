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
  /** Whether this block opens its run, which is what holds the rule back. */
  readonly opensTheRun: boolean;
  /** What the segment declares for `top`, as the browser resolved it. */
  readonly declaredTop: string;
}

/**
 * Measures every quoted block on the page.
 * @param p - The page.
 * @returns One entry per quoted block, in document order.
 */
async function quoteBoxes(p: Page): Promise<QuoteBox[]> {
  // BlockNote gives `.bn-block-content` `transition: font-size 0.2s`
  // (`Block.css:19`), and every space in the body is an `em`. Measured mid
  // transition, a block's 0.85em read 12.4259px against the 12.75px it settles
  // at — every distance here is off by whatever fraction of the animation had
  // run.
  await p.waitForFunction(
    (sel) =>
      document
        .getAnimations()
        .filter((animation) =>
          (animation.effect as KeyframeEffect | null)?.target?.closest(sel),
        )
        .every((animation) => animation.playState !== 'running'),
    QUOTED,
    { timeout: 5_000 },
  );
  return p.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((element) => {
      const style = getComputedStyle(element);
      // The rule is a pseudo-element on the content element: a quote runs
      // beside the words, and a block's outer space is not content. It reaches
      // up over its own block's top margin so a run reads as one line, which
      // is why its box is not the block's.
      const ruleStyle = getComputedStyle(element, '::before');
      const rect = element.getBoundingClientRect();
      const width = parseFloat(ruleStyle.width);
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
        ruleDrawn: width > 0 && parseFloat(ruleStyle.height) > 1,
        ruleX: rect.left + parseFloat(ruleStyle.insetInlineStart),
        boxRight: rect.right,
        ruleTop: rect.top + parseFloat(ruleStyle.top),
        ruleHeight: parseFloat(ruleStyle.height),
        ruleWidth: width,
        ruleColor: ruleStyle.backgroundColor,
        opensTheRun: element.hasAttribute('data-quoted-run-first'),
        declaredTop: ruleStyle.top,
        borderRadius: ruleStyle.borderRadius,
        paddingLeft: parseFloat(style.paddingInlineStart),
        fontSize: parseFloat(style.fontSize),
        color: style.color,
      };
    });
  }, QUOTED);
}

/**
 * Waits until the caret sits in the block at this index, and says so.
 *
 * A block-type chord acts on the block the caret is in, and moving the caret
 * there is a step of its own: measured, a chord pressed straight after the
 * click that should have moved it made a code block of the FIRST block, which
 * is not quoted, so the count of quoted code blocks came back 0 with nothing
 * saying why.
 * @param p - The page.
 * @param index - Which block, counting from the top of the document.
 */
async function expectCaretIn(p: Page, index: number): Promise<void> {
  await expect
    .poll(
      () =>
        p.evaluate((sel) => {
          const blocks = [
            ...document.querySelectorAll(`${sel} .bn-block-content`),
          ];
          const anchor = document.getSelection()?.anchorNode ?? null;
          const holder =
            anchor === null
              ? null
              : (anchor.nodeType === 1
                ? anchor
                : anchor.parentElement
              )?.closest('.bn-block-content');
          return holder === null || holder === undefined
            ? -1
            : blocks.indexOf(holder);
        }, EDITOR),
      { timeout: 10_000 },
    )
    .toBe(index);
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
  /**
   * Whether the middle block is the one carrying the quote.
   *
   * Without it a case can quote a different block and still read every gap
   * around this one as unchanged — which is exactly what happens: clicking a
   * block lands in the blank right of its words and leaves the caret where it
   * was, so the press quotes whatever block the caret was already in.
   */
  readonly middleQuoted: boolean;
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
      // The WORDS, not the block: a quote clears its rule with padding, which
      // sits inside the block's box and cannot move that box's own edge.
      left: (
        all[1]!.querySelector('.bn-inline-content') ?? all[1]!
      ).getBoundingClientRect().left,
      middleQuoted: all[1]!.getAttribute('data-quoted') === 'true',
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

    // The run OPENS beside its own words: what stands above the first block is
    // page rather than quote, and a rule reaching into it stood 100.78px tall
    // beside a heading whose words are 31.19px (user 2026-09-08).
    expect(
      boxes.map((box) => box.opensTheRun),
      'only the first block opens the run',
    ).toEqual([true, false, false]);
    expect(
      boxes[0]!.ruleTop,
      `the run opens beside its own words — ${JSON.stringify(
        boxes.map((box) => ({
          opens: box.opensTheRun,
          declaredTop: box.declaredTop,
          blockTop: box.top,
          textTop: box.textTop,
        })),
      )}`,
    ).toBeGreaterThanOrEqual(boxes[0]!.textTop - 1);

    // And it CLOSES beside its own words: nothing is drawn under the last
    // block either.
    const last = boxes[boxes.length - 1]!;
    expect(
      last.ruleTop + last.ruleHeight,
      'the run closes beside its own words',
    ).toBeLessThanOrEqual(last.textBottom + 1);

    // In between, each segment reaches up to where the one above it ended, so
    // the run reads as one rule (user 2026-09-01: a quote must read as continuous top to bottom).
    for (let i = 1; i < boxes.length; i += 1) {
      const above = boxes[i - 1]!;
      expect(
        Math.abs(boxes[i]!.ruleTop - (above.ruleTop + above.ruleHeight)),
        `segment ${i} meets the one above it`,
      ).toBeLessThan(0.5);
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

    // Triple click: a single one lands in the blank right of the words and
    // leaves the caret where it was, so the press quoted the block written
    // last rather than this one.
    await page
      .locator(`${EDITOR} .bn-block-content`)
      .nth(1)
      .click({ clickCount: 3 });
    await page.keyboard.press(`${MOD}+Shift+B`);
    await expect(page.locator(QUOTED)).toHaveCount(1, { timeout: 10_000 });

    const after = await middleGaps(page);
    expect(after.middleQuoted, 'the middle block is the quoted one').toBe(true);

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

    await page
      .locator(`${EDITOR} .bn-block-content`)
      .nth(1)
      .click({ clickCount: 3 });
    await page.keyboard.press(`${MOD}+Shift+B`);
    await expect(page.locator(QUOTED)).toHaveCount(1, { timeout: 10_000 });

    const after = await middleGaps(page);
    expect(after.middleQuoted, 'the middle row is the quoted one').toBe(true);

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
    //
    // The chord goes to the block the caret is in, so the selection
    // `writeQuotedRun` ends on has to be gone before it lands — the bubble bar
    // sits over that selection, and a keystroke that reaches the bar leaves
    // the caret where it was. Measured: the chord then made a code block of
    // the FIRST block, which is not quoted, and the count came back 0.
    //
    // Walked down by key, the way the heading case below reaches its block. A
    // click puts the caret there just as well, and then draws the bar over the
    // block it just took: measured across three runs, the chord went missing
    // on one of them and the count came back 0 again.
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('doc-selection-bubble-bar')).toBeHidden({
      timeout: 10_000,
    });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expectCaretIn(page, 2);
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
    expect(
      boxes[0]!.ruleTop,
      'the run opens beside its own words',
    ).toBeGreaterThanOrEqual(boxes[0]!.textTop - 1);
    const closing = boxes[boxes.length - 1]!;
    expect(
      closing.ruleTop + closing.ruleHeight,
      'the run closes beside its own words',
    ).toBeLessThanOrEqual(closing.textBottom + 1);
    for (let i = 1; i < boxes.length; i += 1) {
      const above = boxes[i - 1]!;
      expect(
        Math.abs(boxes[i]!.ruleTop - (above.ruleTop + above.ruleHeight)),
        `segment ${i} meets the one above it, code block included`,
      ).toBeLessThan(0.5);
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
    await expectCaretIn(page, 1);
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
    expect(
      boxes[0]!.ruleTop,
      'the run opens beside its own words',
    ).toBeGreaterThanOrEqual(boxes[0]!.textTop - 1);
    const closing = boxes[boxes.length - 1]!;
    expect(
      closing.ruleTop + closing.ruleHeight,
      'the run closes beside its own words',
    ).toBeLessThanOrEqual(closing.textBottom + 1);
    // A heading asks for 45.6px above it, and INSIDE a run that space is part
    // of the quote — the rule crosses it. What must stay bare is the space
    // above the run's first block, which the two assertions above hold.
    for (let i = 1; i < boxes.length; i += 1) {
      const above = boxes[i - 1]!;
      expect(
        Math.abs(boxes[i]!.ruleTop - (above.ruleTop + above.ruleHeight)),
        `segment ${i} meets the one above it across the heading's space`,
      ).toBeLessThan(0.5);
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
      // The rule takes the colour its words take. Against `--color-border` it
      // measured 1.26:1 in light and 1.39:1 in dark — the faintest mark on the
      // page, while everything A8b asks of it is about where it lands.
      expect(box.ruleColor, 'the rule takes the muted colour').toBe(
        tokens.muted,
      );
      expect(box.ruleWidth, 'the rule is 2px').toBe(2);
      // `1em`, which is the block's own size — writing the pixel here would
      // pin the body's font size in a case that is about the quote. Every
      // block in this run is at the top level; an indented one carries the
      // indentation it gives back on top of this.
      // Measured from the rule's far edge. The rule is a pseudo-element and
      // takes no space of its own, so the padding carries its 2px as well as
      // the gap: 17px of padding beside a 15px body.
      expect(
        box.paddingLeft - box.ruleWidth,
        'the text stands 1em clear of the rule',
      ).toBe(box.fontSize);
    }
  });
});
