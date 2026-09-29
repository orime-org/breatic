// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Commenting, end to end (task #18).
 *
 * The half jsdom cannot reach. Every rectangle it reports is zero, so the
 * cards have no size or place there; colours are resolved by the browser and
 * by nobody in a test environment; and which handler a press reaches depends
 * on a real click travelling the plugin chain.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import {
  openFreshDocument,
  scrollBodyTo,
  selectFirstParagraph,
  selectParagraph,
} from '../helpers/bubble-bar';
import { createSpace, deleteSpace } from '../helpers/space';

// `bubble-bar` registers the afterEach that removes what `openFreshDocument`
// made, and it removes it off the fixture's page — so this file uses that one.
test.use({ viewport: { width: 1680, height: 950 } });

const EDITOR = '[data-testid="document-space"] .ProseMirror';

/** A line long enough that quoting it would run off the screen. */
const LONG_LINE =
  'The membership decides how much room you get and how many people can ' +
  'work alongside you, while the credits decide how much you can make with ' +
  'it, and the two are bought separately for that reason.';

/**
 * Opens a fresh Document Space holding one long line, with it all selected.
 * @param p - The page.
 */
async function openWithALongSelection(p: Page): Promise<void> {
  await openFreshDocument(p);
  await p.keyboard.type(LONG_LINE);
  await selectFirstParagraph(p);
}

/**
 * Comments on one paragraph, through the bubble bar.
 * @param p - The page.
 * @param index - Which paragraph, counting from zero.
 * @param body - What the comment says.
 */
async function commentOnParagraph(
  p: Page,
  index: number,
  body: string,
): Promise<void> {
  await selectParagraph(p, index);
  await p.getByTestId('doc-bubble-tool-comment').click();
  await p.getByTestId('doc-comment-draft-input').fill(body);
  await p.getByTestId('doc-comment-draft-save').click();
  await expect(p.getByTestId('doc-comment-draft-card')).toHaveCount(0);
  // Writing one opens the panel, because that is where the card is (A1).
  // The cases below start from a comment that exists and a panel the reader
  // has not opened, so it is closed again here.
  await p.getByTestId('doc-comment-rail-close').click();
  await expect(p.getByTestId('doc-comment-rail')).toHaveCount(0);
}

/**
 * Selects a character range in one paragraph.
 * @param p - The page.
 * @param from - Where the range starts.
 * @param to - Where it ends.
 * @param paragraph - Which paragraph, counting from zero.
 */
async function selectChars(
  p: Page,
  from: number,
  to: number,
  paragraph = 0,
): Promise<void> {
  await p.evaluate(
    ({ sel, at, index }) => {
      const para = document.querySelectorAll(`${sel} p`)[index]!;
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let seen = 0;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      let node = walker.nextNode() as Text | null;
      while (node !== null) {
        const len = node.data.length;
        if (startNode === null && seen + len >= at.from) {
          startNode = node;
          startOffset = at.from - seen;
        }
        if (endNode === null && seen + len >= at.to) {
          endNode = node;
          endOffset = at.to - seen;
        }
        seen += len;
        node = walker.nextNode() as Text | null;
      }
      const range = document.createRange();
      range.setStart(startNode!, startOffset);
      range.setEnd(endNode!, endOffset);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { sel: EDITOR, at: { from, to }, index: paragraph },
  );
  await p.waitForTimeout(250);
}

/** How many bubble bars are on screen. */
async function barCount(p: Page): Promise<number> {
  return p.getByTestId('doc-selection-bubble-bar').count();
}

test.describe('the card a comment is written in', () => {
  test('sits in the panel column, whatever the selection holds', async ({
    page,
  }) => {
    // A28: it is a card, so it is where the cards are. What it was aimed at
    // does not move it and does not stretch it.
    await openWithALongSelection(page);

    await page.getByTestId('doc-bubble-tool-comment').click();

    const card = page.getByTestId('doc-comment-draft-card');
    await expect(card).toBeVisible();
    const shape = (await card.boundingBox())!;
    const column = (await page
      .getByTestId('doc-comment-rail-column')
      .boundingBox())!;
    expect(shape.x).toBeGreaterThanOrEqual(column.x);
    expect(shape.x + shape.width).toBeLessThanOrEqual(
      column.x + column.width + 1,
    );
  });

  test('puts the caret after what was written when the entry is pressed again', async ({
    page,
  }) => {
    // Pressing the entry is asking to go on writing: the words written so far
    // stay, and the caret waits after them.
    await openFreshDocument(page);
    await page.keyboard.type('alpha bravo charlie');
    await expect(page.locator(`${EDITOR} p`).first()).toHaveText('alpha bravo charlie');
    await selectChars(page, 0, 5);
    await page.getByTestId('doc-bubble-tool-comment').click();
    const box = page.getByTestId('doc-comment-draft-input');
    await expect(box).toBeFocused();
    await page.keyboard.type('Please check');

    await selectChars(page, 12, 19);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(box).toBeFocused();
    await page.keyboard.type(' this');

    await expect(box).toHaveValue('Please check this');
  });

  test('sits level with the words it was aimed at', async ({ page }) => {
    // A28 again, the half that makes it a card of the same kind: a reader
    // looks across from the words to the card about them.
    await openFreshDocument(page);
    await page.keyboard.type('one\n');
    await page.keyboard.type('two\n');
    await page.keyboard.type('three carrying the comment');
    await selectParagraph(page, 2);

    await page.getByTestId('doc-bubble-tool-comment').click();

    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();
    const words = (await page
      .locator(`${EDITOR} p`)
      .nth(2)
      .boundingBox())!;
    const card = (await page
      .getByTestId('doc-comment-draft-card')
      .boundingBox())!;
    expect(Math.abs(card.y - words.y)).toBeLessThan(40);
  });

  test('leaves the body where the reader scrolled it when the entry is pressed', async ({
    page,
  }) => {
    // The box takes the focus as the card arrives, before the card is set
    // level with its words; the body must not be scrolled to where the card
    // was a moment earlier.
    await openFreshDocument(page);
    for (let i = 0; i < 60; i += 1) {
      await page.keyboard.type(`line ${String(i)} with some words`);
      await page.keyboard.press('Enter');
    }
    await scrollBodyTo(page, 1800);
    const scroller = page
      .locator('.doc-body-scroller [data-radix-scroll-area-viewport]')
      .first();
    const scrolled = await scroller.evaluate((node) => node.scrollTop);
    expect(scrolled).toBeGreaterThan(1000);
    const card = page.getByTestId('doc-comment-draft-card');

    for (const [index, words] of [[45, 'first'], [50, 'moved']] as const) {
      const arriving = (await card.count()) === 0;
      await selectParagraph(page, index);
      await page.getByTestId('doc-bubble-tool-comment').click();
      await expect(page.getByTestId('doc-comment-draft-input')).toBeFocused();
      // A card that is not there yet arrives beside its words: its place in
      // the frames that follow the press is the place it keeps. One that is
      // there already moves to the new words.
      const frames = await card.evaluate(async (node) => {
        const tops: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          tops.push(Math.round(node.getBoundingClientRect().top));
          await new Promise((settle) => requestAnimationFrame(settle));
        }
        return tops;
      });
      if (arriving) expect(new Set(frames).size, frames.join(',')).toBe(1);
      await page.keyboard.type(words);

      expect(await scroller.evaluate((node) => node.scrollTop)).toBe(scrolled);
      const line = (await page.locator(`${EDITOR} p`).nth(index).boundingBox())!;
      const box = (await card.boundingBox())!;
      expect(Math.abs(box.y - line.y)).toBeLessThan(40);
    }
  });

  test('lets an empty one go on a press on blank panel space', async ({
    page,
  }) => {
    // A30 again. Blank space is outside the card, and pressing there is the
    // reader going somewhere else.
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();

    const column = (await page
      .getByTestId('doc-comment-rail-column')
      .boundingBox())!;
    await page.mouse.click(
      column.x + column.width / 2,
      column.y + column.height - 40,
    );

    await expect(page.getByTestId('doc-comment-draft-card')).toHaveCount(0);
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    const painted = await page.evaluate(
      (selector) =>
        document.querySelectorAll(`${selector} .doc-comment-draft-mark`).length,
      EDITOR,
    );
    expect(painted).toBe(0);
  });

  test('keeps an empty one on a press on its own padding', async ({ page }) => {
    // The press takes the focus off the box without the reader leaving: the
    // card's edge is still the card.
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    const card = page.getByTestId('doc-comment-draft-card');
    await expect(card).toBeVisible();

    const box = (await card.boundingBox())!;
    await page.mouse.click(box.x + 4, box.y + 4);

    await expect(card).toBeVisible();
  });

  test('stays open when it is asked for from the block handle', async ({
    page,
  }) => {
    // A2. The menu hands the focus back to the body as it closes, which is
    // not the reader pressing anywhere.
    await openFreshDocument(page);
    await page.keyboard.type('a block to comment on');
    const row = (await page
      .locator(`${EDITOR} .bn-block-content`)
      .first()
      .boundingBox())!;
    await page.mouse.move(row.x + 40, row.y + row.height / 2);
    await expect(page.getByTestId('doc-block-handle')).toBeVisible();
    await page.getByTestId('doc-block-handle').click();

    await page.getByTestId('doc-block-row-comment').click();

    const card = page.getByTestId('doc-comment-draft-card');
    await expect(card).toBeVisible();
    // Long enough for the menu to have closed and the focus to have moved.
    await page.waitForTimeout(500);
    await expect(card).toBeVisible();
    await page.getByTestId('doc-comment-draft-input').fill('from the handle');
    await page.getByTestId('doc-comment-draft-save').click();
    await expect(page.locator(`${EDITOR} .bn-thread-mark`)).not.toHaveCount(0);
  });

  test('keeps what was written in it across a Space tab switch', async ({
    page,
  }) => {
    // The panel is remounted by the switch and the editor is not; the words
    // are the reader's until they send or clear them.
    await openWithALongSelection(page);
    const home = await page
      .locator('[role="tab"][aria-selected="true"]')
      .getAttribute('data-testid');
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('half a thought');

    const away = await createSpace(page, 'document', `away-${Date.now()}`);
    try {
      await expect(page.getByTestId('doc-comment-draft-card')).toHaveCount(0);
      await page.getByTestId(home!).click();

      await expect(page.getByTestId('doc-comment-draft-input')).toHaveValue(
        'half a thought',
      );
    } finally {
      await deleteSpace(page, away);
    }
  });

  test('keeps its words and its place while a peer writes elsewhere', async ({
    page,
  }) => {
    // A peer's edit arrives through Yjs as one replacement of the whole body;
    // the draft has to come out of it still aimed at the same words.
    await openFreshDocument(page);
    await page.keyboard.type('one\n');
    await page.keyboard.type('two carrying the comment');
    const home = (await page
      .locator('[role="tab"][aria-selected="true"]')
      .getAttribute('data-testid'))!;
    await selectParagraph(page, 1);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('half a thought');

    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1680, height: 950 });
      await peer.goto(page.url());
      await peer.getByTestId(home).click();
      const body = peer.locator(`${EDITOR} p`).first();
      await expect(body).toHaveText('one', { timeout: 20_000 });
      await body.click();
      await peer.keyboard.press('End');
      await peer.keyboard.type(' more');

      // Contains, not equals: the peer's caret label is drawn inside the line.
      await expect(page.locator(`${EDITOR} p`).first()).toContainText(
        'one more',
      );
      await expect(page.getByTestId('doc-comment-draft-dropped')).toHaveCount(0);
      await expect(page.getByTestId('doc-comment-draft-input')).toHaveValue(
        'half a thought',
      );
      await expect(
        page.locator(`${EDITOR} .doc-comment-draft-mark`),
      ).toHaveText('two carrying the comment');
    } finally {
      await peer.close();
    }
  });

  test('keeps its words while a peer moves another line across them', async ({
    page,
  }) => {
    // The peer's editor rewrites the lines between where the moved line left
    // and where it lands; the draft's words are still there word for word.
    await openFreshDocument(page);
    await page.keyboard.type('one\n');
    await page.keyboard.type('two carrying the comment\n');
    await page.keyboard.type('three');
    const home = (await page
      .locator('[role="tab"][aria-selected="true"]')
      .getAttribute('data-testid'))!;
    await selectParagraph(page, 1);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('half a thought');

    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1680, height: 950 });
      await peer.goto(page.url());
      await peer.getByTestId(home).click();
      const last = peer.locator(`${EDITOR} p`).nth(2);
      await expect(last).toHaveText('three', { timeout: 20_000 });
      await last.click();
      await peer.keyboard.press('ControlOrMeta+Shift+ArrowUp');

      await expect(page.locator(`${EDITOR} p`).nth(1)).toContainText('three');
      await expect(page.getByTestId('doc-comment-draft-dropped')).toHaveCount(0);
      await expect(page.getByTestId('doc-comment-draft-input')).toHaveValue(
        'half a thought',
      );
      await expect(
        page.locator(`${EDITOR} .doc-comment-draft-mark`),
      ).toHaveText('two carrying the comment');
    } finally {
      await peer.close();
    }
  });

  test('keeps its words while a peer presses Enter at the start of their line', async ({
    page,
  }) => {
    // The split leaves the line's id on the empty line above, and the words
    // go on in a row with a new id.
    await openFreshDocument(page);
    await page.keyboard.type('one\n');
    await page.keyboard.type('two carrying three');
    // A selection set while the last keystrokes are still being taken in is
    // overwritten by the caret they leave; start once the line has landed.
    await expect(page.locator(`${EDITOR} p`).nth(1)).toHaveText(
      'two carrying three',
    );
    const home = (await page
      .locator('[role="tab"][aria-selected="true"]')
      .getAttribute('data-testid'))!;
    await page.evaluate((sel) => {
      const second = document.querySelectorAll(`${sel} p`)[1]!;
      const range = document.createRange();
      range.setStart(second.firstChild!, 4);
      range.setEnd(second.firstChild!, 12);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, EDITOR);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('half a thought');

    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1680, height: 950 });
      await peer.goto(page.url());
      await peer.getByTestId(home).click();
      const line = peer.locator(`${EDITOR} p`).nth(1);
      await expect(line).toContainText('two carrying three', { timeout: 20_000 });
      await line.click({ position: { x: 1, y: 8 } });
      await peer.keyboard.press('Enter');

      // Contains, not equals: the peer's caret label is drawn inside the line.
      const rows = page.locator(`${EDITOR} p`);
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toHaveText('one');
      await expect(rows.nth(1)).toHaveText('');
      await expect(rows.nth(2)).toContainText('two carrying three');
      await expect(page.getByTestId('doc-comment-draft-dropped')).toHaveCount(0);
      await expect(
        page.locator(`${EDITOR} .doc-comment-draft-mark`),
      ).toHaveText('carrying');
    } finally {
      await peer.close();
    }
  });

  test('keeps showing a peer\'s edits after the peer turns its line into a heading', async ({
    page,
  }) => {
    // Turning the line into a heading deletes its old element, and Yjs
    // collects its letters when that change ends; the peer's next edit is
    // the one that has to arrive.
    await openFreshDocument(page);
    await page.keyboard.type('one\n');
    await page.keyboard.type('alpha bravo charlie');
    await expect(page.locator(`${EDITOR} p`).nth(1)).toHaveText(
      'alpha bravo charlie',
    );
    const home = (await page
      .locator('[role="tab"][aria-selected="true"]')
      .getAttribute('data-testid'))!;
    await page.evaluate((sel) => {
      const second = document.querySelectorAll(`${sel} p`)[1]!;
      const range = document.createRange();
      range.setStart(second.firstChild!, 6);
      range.setEnd(second.firstChild!, 11);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, EDITOR);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('half a thought');

    const peer = await page.context().newPage();
    try {
      await peer.setViewportSize({ width: 1680, height: 950 });
      await peer.goto(page.url());
      await peer.getByTestId(home).click();
      const line = peer.locator(`${EDITOR} p`).nth(1);
      await expect(line).toContainText('alpha bravo charlie', { timeout: 20_000 });
      await line.click({ position: { x: 1, y: 8 } });
      await peer.keyboard.type('## ');
      await expect(page.locator(`${EDITOR} h2`)).toContainText('alpha bravo charlie');

      const first = peer.locator(`${EDITOR} p`).first();
      await first.click();
      await peer.keyboard.press('End');
      await peer.keyboard.type('ZZ');

      await expect(page.locator(`${EDITOR} p`).first()).toContainText('oneZZ');
      await expect(page.getByTestId('doc-comment-draft-dropped')).toHaveCount(0);
      await expect(
        page.locator(`${EDITOR} .doc-comment-draft-mark`),
      ).toHaveText('bravo');
    } finally {
      await peer.close();
    }
  });

  test('keeps both ends on their lines when the reader moves its last line', async ({
    page,
  }) => {
    // A move takes the line out and puts it back; each end follows its own
    // line, and the line moved past now lies between them.
    await openFreshDocument(page);
    await page.keyboard.type('alpha bravo\n');
    await page.keyboard.type('charlie delta\n');
    await page.keyboard.type('echo');
    await page.evaluate((sel) => {
      const [first, second] = document.querySelectorAll(`${sel} p`);
      const range = document.createRange();
      range.setStart(first!.firstChild!, 6);
      range.setEnd(second!.firstChild!, 7);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, EDITOR);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('half a thought');

    // Back in the body the editor puts its old selection back, which runs
    // over both lines; collapsing it leaves the caret in the last line only.
    await page.locator(`${EDITOR} p`).nth(1).click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');

    await expect(page.locator(`${EDITOR} p`)).toHaveText([
      'alpha bravo',
      'echo',
      'charlie delta',
    ]);
    await expect(page.getByTestId('doc-comment-draft-dropped')).toHaveCount(0);
    await expect(page.getByTestId('doc-comment-draft-input')).toHaveValue(
      'half a thought',
    );
    await expect
      .poll(() =>
        page
          .locator(`${EDITOR} .doc-comment-draft-mark`)
          .evaluateAll((marks) => marks.map((mark) => mark.textContent).join('|')),
      )
      .toBe('bravo|echo|charlie');
  });

  test('leaves no card being read once it is saved', async ({ page }) => {
    // user 2026-09-24: saving is the comment being finished.
    await openFreshDocument(page);
    await page.keyboard.type('one line carrying a comment\n');
    await page.keyboard.type('another line for the new one');
    await commentOnParagraph(page, 0, 'already here');
    await selectParagraph(page, 1);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('the new one');

    await page.getByTestId('doc-comment-draft-save').click();

    await expect(page.getByTestId('doc-comment-draft-card')).toHaveCount(0);
    await expect(page.getByTestId('doc-comment-card')).toHaveCount(2);
    await expect(
      page.locator('[data-testid="doc-comment-card"][data-selected="true"]'),
    ).toHaveCount(0);
    await expect(
      page.locator(`${EDITOR} .doc-comment-mark-reading`),
    ).toHaveCount(0);
  });

  test('leaves the same space above the box as below it', async ({
    page,
  }) => {
    // Before anything is typed the card holds the box and nothing else, so
    // the box sits in the middle of it.
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();

    const card = (await page
      .getByTestId('doc-comment-draft-card')
      .boundingBox())!;
    const box = (await page
      .getByTestId('doc-comment-draft-scroller')
      .boundingBox())!;
    const above = box.y - card.y;
    const below = card.y + card.height - (box.y + box.height);
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
  });

  test('carries a pair of buttons only once there are words', async ({
    page,
  }) => {
    // A29. Neither Resolve nor Delete: there is no thread to settle or to
    // throw away until this is sent.
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();

    await expect(page.getByTestId('doc-comment-draft-save')).toHaveCount(0);
    await expect(page.getByTestId('doc-comment-draft-cancel')).toHaveCount(0);

    await page.getByTestId('doc-comment-draft-input').fill('worth saying');

    await expect(page.getByTestId('doc-comment-draft-save')).toBeVisible();
    await expect(page.getByTestId('doc-comment-draft-cancel')).toBeVisible();
    await expect(page.getByTestId('doc-comment-resolve')).toHaveCount(0);
    await expect(page.getByTestId('doc-comment-delete')).toHaveCount(0);
  });

  test('lets an empty one go on a press elsewhere, and keeps the panel', async ({
    page,
  }) => {
    // A30: they changed their mind. The panel stays because opening it was
    // their own doing, and the words go back to being unselected.
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();

    await page.locator(`${EDITOR} p`).first().click();

    await expect(page.getByTestId('doc-comment-draft-card')).toHaveCount(0);
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    const painted = await page.evaluate(
      (selector) =>
        document.querySelectorAll(`${selector} .doc-comment-draft-mark`).length,
      EDITOR,
    );
    expect(painted).toBe(0);
  });

  test('paints the words it is about in the colours of a comment', async ({
    page,
  }) => {
    // user 2026-09-24: the deep colour of a comment being read while the
    // draft is the card being read, the plain comment wash once another card
    // is — never the colour of a selection.
    await openFreshDocument(page);
    await page.keyboard.type('one line carrying a comment\n');
    await page.keyboard.type('another line for the draft');
    await commentOnParagraph(page, 0, 'already here');
    await selectParagraph(page, 1);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();

    const colours = (): Promise<{
      draft: string;
      deep: string;
      plain: string;
      selectionPaint: number;
    }> =>
      page.evaluate((selector) => {
        const probe = (value: string): string => {
          const el = document.createElement('span');
          el.style.backgroundColor = value;
          document.body.append(el);
          const colour = getComputedStyle(el).backgroundColor;
          el.remove();
          return colour;
        };
        const draft = document.querySelector(
          `${selector} .doc-comment-draft-mark`,
        )!;
        return {
          draft: getComputedStyle(draft).backgroundColor,
          deep: probe('var(--color-comment-mark-active)'),
          plain: probe('var(--color-comment-mark)'),
          selectionPaint: document.querySelectorAll(
            `${selector} [data-show-selection="true"]`,
          ).length,
        };
      }, EDITOR);

    const reading = await colours();
    expect(reading.draft).toBe(reading.deep);
    expect(reading.selectionPaint).toBe(0);
    await expect(page.getByTestId('doc-comment-draft-card')).toHaveAttribute(
      'data-selected',
      'true',
    );

    await page.getByTestId('doc-comment-draft-input').fill('half a thought');
    // The draft being read keeps its words' line, which puts the first line's
    // card under the header; the panel's own scroll brings it back (§9.6.1).
    const rail = (await page
      .getByTestId('doc-comment-rail-column')
      .boundingBox())!;
    await page.mouse.move(rail.x + rail.width / 2, rail.y + 300);
    for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -100);
    await page.getByTestId('doc-comment-card').click();
    await expect(page.getByTestId('doc-comment-card')).toHaveAttribute(
      'data-selected',
      'true',
    );
    // Reading the card moves it up and the draft card slides in under the
    // pointer, and resting on a card deepens its words (A24).
    await page.mouse.move(rail.x - 200, rail.y + 300);
    const aside = await colours();
    expect(aside.draft).toBe(aside.plain);
    await expect(page.getByTestId('doc-comment-draft-card')).toHaveAttribute(
      'data-selected',
      'false',
    );

    await page.getByTestId('doc-comment-draft-card').hover();
    const rested = await colours();
    expect(rested.draft).toBe(rested.deep);
    await page.mouse.move(rail.x - 200, rail.y + 300);

    await page.getByTestId('doc-comment-draft-card').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toHaveAttribute(
      'data-selected',
      'true',
    );
    await expect(page.getByTestId('doc-comment-card')).toHaveAttribute(
      'data-selected',
      'false',
    );
    const back = await colours();
    expect(back.draft).toBe(back.deep);
  });
});

test.describe('what the bubble bar does once an overlay closes', () => {
  test('stays away once the comment box is left by Escape', async ({ page }) => {
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    expect(await barCount(page)).toBe(0);
  });

  test('stays away once a comment has been posted', async ({ page }) => {
    // The round the reader started by selecting those words ends when they
    // post. Measured on the link panel, which ends one the same way: nothing
    // stands back up after Escape or after an address is confirmed.
    await openWithALongSelection(page);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();

    await page.getByTestId('doc-comment-draft-input').fill('a thought');
    await page.getByTestId('doc-comment-draft-save').click();
    await page.waitForTimeout(500);

    expect(await barCount(page)).toBe(0);
  });
});

test.describe('the panel, read across from the body', () => {
  test('opens itself and marks the card a press in the body names', async ({
    page,
  }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await commentOnParagraph(page, 0, 'about this line');

    await page.locator(`${EDITOR} .bn-thread-mark`).first().click();

    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await expect(
      page.locator('[data-testid="doc-comment-card"][data-selected="true"]'),
    ).toHaveCount(1);
  });

  test('opens again on a second press after the panel was closed', async ({
    page,
  }) => {
    // Closing the panel ends the reading, so the next press on that
    // highlight is a fresh one and A6 holds for it too.
    await openFreshDocument(page);
    // One line that does not wrap, so a press at the middle of the highlight
    // lands on its words rather than between two of its rows.
    await page.keyboard.type('a short line carrying one comment');
    await commentOnParagraph(page, 0, 'about this line');
    await page.locator(`${EDITOR} .bn-thread-mark`).first().click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    // The reader's hand crosses the body to the panel's close button and comes
    // back; three clicks in a row carry none of that, and the first of them is
    // still settling when the second lands.
    await page.waitForTimeout(150);
    await page.getByTestId('doc-comment-rail-close').click();
    await expect(page.getByTestId('doc-comment-rail')).toHaveCount(0);
    // The body column takes the panel's width back and the text reflows; the
    // press below is aimed at where the highlight ends up, not where it was.
    await page.waitForTimeout(400);

    await page.locator(`${EDITOR} .bn-thread-mark`).first().click();

    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
  });

  test('sits each card level with the words it is about', async ({ page }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.type(`filler line ${i}`);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type(LONG_LINE);

    // Neither is at the very top of the body: a card up there is held off
    // the panel's header, which the case below is about.
    await commentOnParagraph(page, 1, 'the first one');
    await commentOnParagraph(page, 13, 'the last one');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await page.waitForTimeout(400);

    const marks = page.locator(`${EDITOR} .bn-thread-mark`);
    const cards = page.getByTestId('doc-comment-card');
    const firstMark = await marks.first().boundingBox();
    const lastMark = await marks.last().boundingBox();
    const firstCard = await cards.first().boundingBox();
    const lastCard = await cards.last().boundingBox();

    // Top edges level. Nothing crowds these two — they are pages apart — so
    // each keeps its anchor, and the only slack is the card's own border.
    expect(Math.abs(firstCard!.y - firstMark!.y)).toBeLessThan(4);
    expect(Math.abs(lastCard!.y - lastMark!.y)).toBeLessThan(4);
    // And far enough apart that the gap between them is the uncommented text.
    expect(lastCard!.y - firstCard!.y).toBeGreaterThan(200);
  });

  test('holds a card off the panel header rather than over it', async ({
    page,
  }) => {
    // The first line of the body sits above the header's lower edge, so the
    // card for a comment on it would cover the filter and the close button
    // (user 2026-09-22).
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await commentOnParagraph(page, 0, 'right at the top');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await page.waitForTimeout(400);

    const header = await page
      .getByTestId('doc-comment-rail-header')
      .boundingBox();
    const card = await page.getByTestId('doc-comment-card').boundingBox();

    const clearance = card!.y - (header!.y + header!.height);
    expect(clearance).toBeGreaterThanOrEqual(3.5);
    expect(clearance).toBeLessThan(6);
  });

  test('holds its header still while the cards scroll past', async ({
    page,
  }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`filler line ${i}`);
    }
    await commentOnParagraph(page, 0, 'up at the top');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await page.waitForTimeout(400);
    const header = page.getByTestId('doc-comment-rail-header');
    const before = (await header.boundingBox())!;
    const card = (await page.getByTestId('doc-comment-card').boundingBox())!;

    await page.mouse.move(400, 500);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);

    const after = (await header.boundingBox())!;
    expect(after.y).toBe(before.y);
    // The card moved, so the header stayed put while the column went past.
    expect(
      card.y - (await page.getByTestId('doc-comment-card').boundingBox())!.y,
    ).toBeGreaterThan(100);
    // Opaque, so what passes beneath it does not show through.
    const painted = await header.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(painted).not.toContain('rgba(0, 0, 0, 0)');
  });

  test('carries the cards along when the body scrolls', async ({ page }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.type(`filler line ${i}`);
    }
    await commentOnParagraph(page, 0, 'up at the top');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    await page.waitForTimeout(400);
    const before = await page.getByTestId('doc-comment-card').boundingBox();

    await page.mouse.move(400, 500);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(400);

    const after = await page.getByTestId('doc-comment-card').boundingBox();
    expect(before!.y - after!.y).toBeGreaterThan(100);
  });

  test('deepens the words while the pointer rests on their card', async ({
    page,
  }) => {
    // A comment that exists and a panel the reader opens, with nothing being
    // read.
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await commentOnParagraph(page, 0, 'about this line');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
    // Off every card first: the menu row the panel was opened from leaves the
    // pointer where a card then appears, and a card under the pointer is
    // exactly what this draws.
    await page.mouse.move(60, 60);
    const deepened = page.locator(`${EDITOR} .doc-comment-mark-reading`);
    await expect(deepened).toHaveCount(0);

    await page.getByTestId('doc-comment-card').hover();

    await expect(deepened.first()).toBeVisible();
  });
});

test.describe('the box a reply is written in', () => {
  /**
   * Opens a Space with one commented line and the thread being read.
   * @param p - The page.
   */
  async function openThread(p: Page): Promise<void> {
    await openFreshDocument(p);
    await p.keyboard.type(LONG_LINE);
    await commentOnParagraph(p, 0, 'worth answering');
    await p.getByTestId('doc-doc-menu-trigger').click();
    await p.getByTestId('doc-doc-menu-comments').click();
    await p.getByTestId('doc-comment-card').click();
    await expect(p.getByTestId('doc-comment-reply-input')).toBeVisible();
  }

  test('sends the reply on Enter and leaves the box empty', async ({
    page,
  }) => {
    await openThread(page);

    await page.getByTestId('doc-comment-reply-input').click();
    await page.keyboard.type('answered from the keyboard');
    await page.keyboard.press('Enter');

    await expect(
      page.getByTestId('doc-comment-card').getByText('answered from the keyboard'),
    ).toBeVisible();
    await expect(page.getByTestId('doc-comment-reply-input')).toHaveValue('');
  });

  test('grows with the words and stops at four lines', async ({ page }) => {
    await openThread(page);
    const viewport = page.locator(
      '[data-testid="doc-comment-reply-scroller"] [data-radix-scroll-area-viewport]',
    );
    const oneLine = (await viewport.boundingBox())!.height;

    await page.getByTestId('doc-comment-reply-input').click();
    // Shift+Enter is the line inside a reply; Enter would send it.
    for (const words of ['one', 'two', 'three']) {
      await page.keyboard.type(words);
      await page.keyboard.press('Shift+Enter');
    }
    const threeLines = (await viewport.boundingBox())!.height;
    for (const words of ['four', 'five', 'six']) {
      await page.keyboard.type(words);
      await page.keyboard.press('Shift+Enter');
    }

    expect(threeLines).toBeGreaterThan(oneLine);
    // Four lines of `text-sm` plus the field's own padding, and what is
    // written past that scrolls.
    const capped = await viewport.evaluate((el) => ({
      client: el.clientHeight,
      content: el.scrollHeight,
    }));
    expect(capped.client).toBeLessThanOrEqual(88);
    expect(capped.content).toBeGreaterThan(capped.client);
  });

  test('takes the focus with one pixel of border, the way every field does', async ({
    page,
  }) => {
    await openThread(page);
    const scroller = page.getByTestId('doc-comment-reply-scroller');
    const resting = await scroller.evaluate((el) => {
      const style = getComputedStyle(el);
      return { width: style.borderTopWidth, colour: style.borderTopColor };
    });

    await page.getByTestId('doc-comment-reply-input').click();
    // The border colour is transitioned, so the first frame after the click
    // still reads as resting.
    await page.waitForTimeout(300);

    const focused = await scroller.evaluate((el) => {
      const style = getComputedStyle(el);
      const probe = document.createElement('div');
      probe.style.borderColor = 'var(--color-active-border)';
      el.appendChild(probe);
      const wanted = getComputedStyle(probe).borderTopColor;
      probe.remove();
      return {
        width: style.borderTopWidth,
        colour: style.borderTopColor,
        outline: getComputedStyle(el.querySelector('textarea')!).outlineStyle,
        wanted,
      };
    });

    expect(resting.width).toBe('1px');
    expect(focused.width).toBe('1px');
    expect(focused.colour).not.toBe(resting.colour);
    expect(focused.colour).toBe(focused.wanted);
    expect(focused.outline).toBe('none');
  });
});

test.describe('a card whose words were deleted', () => {
  test('sits below the cards that still have words', async ({ page }) => {
    await openFreshDocument(page);
    await page.keyboard.type('the line that will lose its comment');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.type(`filler line ${i}`);
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type('a later line that keeps its comment');
    await commentOnParagraph(page, 0, 'this one loses its words');
    await commentOnParagraph(page, 9, 'this one keeps them');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await page.waitForTimeout(400);

    await selectParagraph(page, 0);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(700);

    const cards = await page
      .getByTestId('doc-comment-card')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          top: node.getBoundingClientRect().top,
          orphaned:
            node.querySelector('[data-testid="doc-comment-card-orphaned"]') !==
            null,
        })),
      );
    const withWords = cards.filter((c) => !c.orphaned);
    const adrift = cards.filter((c) => c.orphaned);
    expect(withWords).toHaveLength(1);
    expect(adrift).toHaveLength(1);
    expect(adrift[0]!.top).toBeGreaterThan(withWords[0]!.top);
  });
});

test.describe('a row moved from the keyboard', () => {
  test('keeps its comment on its words', async ({ page }) => {
    await openFreshDocument(page);
    await page.keyboard.type('the line that moves with its comment');
    await page.keyboard.press('Enter');
    await page.keyboard.type('the line it moves past');
    await commentOnParagraph(page, 0, 'this stays on the moved line');

    await page.locator(`${EDITOR} p`).first().click();
    await page.keyboard.press('ControlOrMeta+Shift+ArrowDown');

    const paragraphs = page.locator(`${EDITOR} p`);
    await expect(paragraphs.nth(1)).toHaveText(
      'the line that moves with its comment',
    );
    await expect(paragraphs.nth(1).locator('.bn-thread-mark')).toHaveCount(1);
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await expect(page.getByTestId('doc-comment-card')).toHaveCount(1);
    await expect(page.getByTestId('doc-comment-card-orphaned')).toHaveCount(0);
  });
});

test.describe('a reply box that grows', () => {
  test('pushes the card below it down instead of covering it', async ({
    page,
  }) => {
    await openFreshDocument(page);
    await page.keyboard.type('the first commented line');
    await page.keyboard.press('Enter');
    await page.keyboard.type('a second line right below it');
    await commentOnParagraph(page, 0, 'the one being answered');
    await commentOnParagraph(page, 1, 'the one below');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await page.waitForTimeout(400);
    await page.getByTestId('doc-comment-card').first().click();
    await page.waitForTimeout(400);

    await page.getByTestId('doc-comment-reply-input').click();
    for (const words of ['one', 'two', 'three', 'four']) {
      await page.keyboard.type(words);
      await page.keyboard.press('Shift+Enter');
    }
    await page.waitForTimeout(600);

    const boxes = await page
      .getByTestId('doc-comment-card')
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = n.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom };
        }),
      );
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.bottom).toBeLessThanOrEqual(boxes[1]!.top);
  });
});

test.describe('what a settled thread offers', () => {
  test('stands Reopen and Delete at the two edges, as Resolve and Delete do', async ({
    page,
  }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await commentOnParagraph(page, 0, 'settled');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await page.getByTestId('doc-comment-card').click();

    const card = page.getByTestId('doc-comment-card');
    const unsettled = {
      card: (await card.boundingBox())!,
      left: (await page.getByTestId('doc-comment-resolve').boundingBox())!,
      right: (await page.getByTestId('doc-comment-delete').boundingBox())!,
    };

    await page.getByTestId('doc-comment-resolve').click();
    await page.getByTestId('doc-comment-rail-filter-all').click();
    await page.getByTestId('doc-comment-card').click();
    const settled = {
      card: (await card.boundingBox())!,
      left: (await page.getByTestId('doc-comment-reopen').boundingBox())!,
      right: (await page.getByTestId('doc-comment-delete').boundingBox())!,
    };

    for (const row of [unsettled, settled]) {
      expect(row.left.x - row.card.x).toBeLessThan(16);
      expect(row.card.x + row.card.width - (row.right.x + row.right.width))
        .toBeLessThan(16);
    }
    expect(Math.abs(settled.left.x - unsettled.left.x)).toBeLessThan(1);
  });
});

test.describe('a thread nobody is reading', () => {
  test('cuts each comment short and says what it is holding back', async ({
    page,
  }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await page.keyboard.press('Enter');
    await page.keyboard.type('nothing is said about this line');
    await commentOnParagraph(page, 0, 'worth answering');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await page.getByTestId('doc-comment-card').click();
    for (const words of [LONG_LINE, 'the third', 'the fourth']) {
      await page.getByTestId('doc-comment-reply-input').click();
      await page.keyboard.type(words);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('doc-comment-reply-input')).toHaveValue('');
    }
    // A press on words nobody commented on closes the thread, which is what
    // folds the card.
    await page.getByText('nothing is said about this line').click();
    await page.waitForTimeout(300);

    const entries = page.getByTestId('doc-comment-entry');
    await expect(entries).toHaveCount(2);
    await expect(page.getByTestId('doc-comment-folded-count')).toBeVisible();

    // The long reply is one of the two held back, so what is on screen is the
    // first comment and the last — each cut to three lines at most.
    const tallest = await entries.evaluateAll((nodes) =>
      Math.max(
        ...nodes.map((node) => {
          const body = node.lastElementChild!;
          const line = parseFloat(getComputedStyle(body).lineHeight);
          return body.getBoundingClientRect().height / line;
        }),
      ),
    );
    expect(tallest).toBeLessThanOrEqual(3.1);
  });

  test('shows every comment in full once it is opened', async ({ page }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await commentOnParagraph(page, 0, 'worth answering');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await page.getByTestId('doc-comment-card').click();
    for (const words of ['the second', 'the third', 'the fourth']) {
      await page.getByTestId('doc-comment-reply-input').click();
      await page.keyboard.type(words);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('doc-comment-reply-input')).toHaveValue('');
    }

    await expect(page.getByTestId('doc-comment-entry')).toHaveCount(4);
    await expect(page.getByTestId('doc-comment-folded-count')).toHaveCount(0);
  });
});

test.describe('what the pointer says over the body', () => {
  test('offers the caret on words whose comment is settled', async ({
    page,
  }) => {
    // A settled thread keeps its mark and loses its paint, so those words
    // read as prose — and a press on them does nothing, because the hit test
    // asks the same `orphan` the paint does. The pointer has to agree.
    await openFreshDocument(page);
    await page.keyboard.type('plain words nobody said anything about');
    await page.keyboard.press('Enter');
    await page.keyboard.type('words that carry a settled comment');
    await commentOnParagraph(page, 1, 'done with this');
    await page.getByTestId('doc-doc-menu-trigger').click();
    await page.getByTestId('doc-doc-menu-comments').click();
    await page.getByTestId('doc-comment-card').click();
    await page.getByTestId('doc-comment-resolve').click();
    await page.waitForTimeout(400);

    const settled = page.locator(`${EDITOR} .bn-thread-mark[data-orphan='true']`);
    await expect(settled).toHaveCount(1);
    expect(await settled.evaluate((el) => getComputedStyle(el).cursor)).toBe(
      'auto',
    );
    // Resolving is only reachable on the thread being read, so the deeper
    // paint is on those words at the moment of the press. It goes with the
    // paint underneath it — measured, because reading the code the other way
    // round is what three adversaries did.
    await expect(
      page.locator(`${EDITOR} .doc-comment-mark-reading`),
    ).toHaveCount(0);
  });

  test('offers the pointer on words a reader can still open', async ({
    page,
  }) => {
    await openFreshDocument(page);
    await page.keyboard.type(LONG_LINE);
    await commentOnParagraph(page, 0, 'still open');

    const live = page.locator(
      `${EDITOR} .bn-thread-mark:not([data-orphan='true'])`,
    );
    await expect(live.first()).toBeVisible();
    expect(
      await live.first().evaluate((el) => getComputedStyle(el).cursor),
    ).toBe('pointer');
  });
});

test.describe('a comment split around words that are not its own', () => {
  test('leaves the words between its runs the colour of plain prose', async ({
    page,
  }) => {
    // The library draws one decoration over a thread's merged range — first
    // start to last end — and colours it through a descendant selector on the
    // mark. Anything carrying a mark in the gap satisfies that selector, a
    // settled thread's mark included, so words belonging to no live comment
    // are painted the moment one is opened.
    await openFreshDocument(page);
    await page.keyboard.type('SETTLED ALPHABETA tail');

    await selectParagraph(page, 0);
    await selectChars(page, 0, 7);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('to be resolved');
    await page.getByTestId('doc-comment-draft-save').click();
    await page.locator(`${EDITOR} [data-bn-thread-id]`).first().click();
    await page.getByTestId('doc-comment-resolve').first().click();
    await expect(
      page.locator(`${EDITOR} [data-bn-thread-id][data-orphan="true"]`),
    ).toHaveCount(1);

    await selectChars(page, 8, 17);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('the live one');
    await page.getByTestId('doc-comment-draft-save').click();
    await page.waitForTimeout(400);

    // Drag the settled words into the middle of the live run, which is what
    // splits one thread around words it never covered.
    const at = await page.evaluate((sel) => {
      const para = document.querySelector(`${sel} p`)!;
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node !== null) {
        nodes.push(node);
        node = walker.nextNode() as Text | null;
      }
      const settled = nodes.find((n) => n.data.includes('SETTLED'))!;
      const live = nodes.find((n) => n.data.includes('ALPHABETA'))!;
      const source = document.createRange();
      source.setStart(settled, settled.data.indexOf('SETTLED'));
      source.setEnd(settled, settled.data.indexOf('SETTLED') + 7);
      const landing = document.createRange();
      const mid = live.data.indexOf('ALPHABETA') + 5;
      landing.setStart(live, mid);
      landing.setEnd(live, mid);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(source);
      const from = source.getBoundingClientRect();
      const to = landing.getBoundingClientRect();
      return {
        from: { x: from.x + from.width / 2, y: from.y + from.height / 2 },
        to: { x: to.x, y: to.y + to.height / 2 },
      };
    }, EDITOR);

    await page.evaluate(
      ({ sel, drag }) => {
        const body = document.querySelector(sel)!;
        const data = new DataTransfer();
        const send = (type: string, x: number, y: number): void => {
          body.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
              clientX: x,
              clientY: y,
            }),
          );
        };
        send('dragstart', drag.from.x, drag.from.y);
        send('dragover', drag.to.x, drag.to.y);
        send('drop', drag.to.x, drag.to.y);
        send('dragend', drag.to.x, drag.to.y);
      },
      { sel: EDITOR, drag: at },
    );
    await page.waitForTimeout(600);

    await page
      .locator(`${EDITOR} [data-bn-thread-id]:not([data-orphan="true"])`)
      .first()
      .click();
    await page.waitForTimeout(400);

    const between = await page.evaluate((sel) => {
      const body = document.querySelector(sel)!;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode() as Text | null;
      while (node !== null) {
        if (node.data === 'SETTLED') {
          return getComputedStyle(node.parentElement!).backgroundColor;
        }
        node = walker.nextNode() as Text | null;
      }
      return null;
    }, EDITOR);

    expect(between).toBe('rgba(0, 0, 0, 0)');
  });

  test('gives rows dragged as a copy ids of their own', async ({ page }) => {
    // BlockNote renews ids only when the drop reports `effectAllowed ===
    // "copy"`, and ProseMirror sets `"copyMove"` on every drag it starts, so
    // copied rows used to share their source's ids.
    await openFreshDocument(page);
    await page.keyboard.type('alpha\n');
    await page.keyboard.type('bravo\n');
    await page.keyboard.type('charlie');
    await expect(page.locator(`${EDITOR} p`).nth(2)).toHaveText('charlie');

    const at = await page.evaluate((sel) => {
      const [first, second, third] = document.querySelectorAll(`${sel} p`);
      const source = document.createRange();
      source.setStart(first!.firstChild!, 0);
      source.setEnd(second!.firstChild!, 5);
      const landing = document.createRange();
      landing.setStart(third!.firstChild!, 7);
      landing.setEnd(third!.firstChild!, 7);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(source);
      const from = first!.getBoundingClientRect();
      const to = landing.getBoundingClientRect();
      return {
        from: { x: from.x + 10, y: from.y + from.height / 2 },
        to: { x: to.x, y: to.y + to.height / 2 },
      };
    }, EDITOR);

    await page.evaluate(
      ({ sel, drag }) => {
        const body = document.querySelector(sel)!;
        const data = new DataTransfer();
        const copy = navigator.platform.startsWith('Mac')
          ? { altKey: true }
          : { ctrlKey: true };
        const send = (type: string, x: number, y: number): void => {
          body.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: data,
              clientX: x,
              clientY: y,
              ...(type === 'drop' ? copy : {}),
            }),
          );
        };
        send('dragstart', drag.from.x, drag.from.y);
        send('dragover', drag.to.x, drag.to.y);
        send('drop', drag.to.x, drag.to.y);
        send('dragend', drag.to.x, drag.to.y);
      },
      { sel: EDITOR, drag: at },
    );

    await expect(page.locator(`${EDITOR} p`)).toHaveText([
      'alpha',
      'bravo',
      'charliealpha',
      'bravo',
    ]);
    const ids = await page
      .locator(`${EDITOR} .bn-block-outer[data-id]`)
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-id')));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

test.describe('a column crowded with comments', () => {
  /** The line the comments crowd, below enough lines to be clear of the header. */
  const LINE = 6;

  /** What that line says; its first eight letters each carry a comment. */
  const CROWDED_LINE = 'abcdefgh and more words after them';

  /**
   * Puts one comment on each of the first eight characters of one line.
   * @param p - The page.
   */
  async function crowdOneLine(p: Page): Promise<void> {
    await openFreshDocument(p);
    for (let i = 0; i < LINE; i += 1) await p.keyboard.type(`line ${String(i)}\n`);
    await p.keyboard.type(CROWDED_LINE);
    // A selection set while the last keystrokes are still being taken in is
    // overwritten by the caret they leave; start once the line has landed.
    await expect(p.locator(`${EDITOR} p`).nth(LINE)).toHaveText(CROWDED_LINE);
    for (let i = 0; i < 8; i += 1) {
      await selectChars(p, i, i + 1, LINE);
      await expect(p.getByTestId('doc-bubble-tool-comment')).toBeVisible();
      await p.getByTestId('doc-bubble-tool-comment').click();
      await p.getByTestId('doc-comment-draft-input').fill(`note ${String(i)}`);
      await p.getByTestId('doc-comment-draft-save').click();
      await expect(p.getByTestId('doc-comment-draft-card')).toHaveCount(0);
    }
  }

  /**
   * Where each card sits on screen, by what it says.
   * @param p - The page.
   * @returns The top of each card.
   */
  async function cardTops(p: Page): Promise<Record<string, number>> {
    return p.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('[data-testid="doc-comment-card"]')].map(
          (card) => [
            /note \d/.exec(card.textContent ?? '')?.[0] ?? '',
            card.getBoundingClientRect().top,
          ],
        ),
      ),
    );
  }

  /**
   * Opens the card for one of the notes by pressing its words.
   * @param p - The page.
   * @param index - Which note.
   */
  async function readNote(p: Page, index: number): Promise<void> {
    await p.locator(`${EDITOR} [data-bn-thread-id]`).nth(index).click();
    await expect(
      p.getByTestId('doc-comment-card').filter({ hasText: `note ${String(index)}` }),
    ).toHaveAttribute('data-selected', 'true');
    // The cards move by transition.
    await p.waitForTimeout(400);
  }

  test('keeps the card being read level with its words', async ({ page }) => {
    // user 2026-09-24: a card is read across from its words, however many
    // other cards want the same place.
    await crowdOneLine(page);
    await readNote(page, 5);

    const line = (await page.locator(`${EDITOR} p`).nth(LINE).boundingBox())!;
    const tops = await cardTops(page);
    expect(Math.abs(tops['note 5']! - line.y)).toBeLessThan(12);
  });

  test('lifts the column over the cards hidden above before the body moves', async ({
    page,
  }) => {
    await crowdOneLine(page);
    await readNote(page, 5);
    const header = (await page
      .getByTestId('doc-comment-rail-header')
      .boundingBox())!;
    const edge = header.y + header.height;
    const before = await cardTops(page);
    expect(before['note 0']!).toBeLessThan(edge);
    const bodyTop = (await page.locator(`${EDITOR} p`).first().boundingBox())!.y;

    const rail = (await page.getByTestId('doc-comment-rail-column').boundingBox())!;
    await page.mouse.move(rail.x + rail.width / 2, edge + 200);
    for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, -100);
    await page.waitForTimeout(300);

    const after = await cardTops(page);
    // Every card is back below the header, and the body has not moved.
    expect(after['note 0']!).toBeGreaterThanOrEqual(edge - 1);
    expect((await page.locator(`${EDITOR} p`).first().boundingBox())!.y).toBe(
      bodyTop,
    );

    // The other way, the column goes back first.
    for (let i = 0; i < 20; i += 1) await page.mouse.wheel(0, 100);
    await page.waitForTimeout(300);
    const back = await cardTops(page);
    expect(Math.abs(back['note 5']! - before['note 5']!)).toBeLessThan(2);
  });

  test('brings each card the keyboard reaches into view below the header', async ({
    page,
  }) => {
    // Tab walks the column top first, so its first stops are the cards the
    // one being read pushed up under the header.
    await crowdOneLine(page);
    await readNote(page, 5);
    await page.getByTestId('doc-comment-rail-close').focus();
    const header = (await page
      .getByTestId('doc-comment-rail-header')
      .boundingBox())!;
    const edge = header.y + header.height;

    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(250);
      const top = await page.evaluate(
        () => (document.activeElement as HTMLElement).getBoundingClientRect().top,
      );
      expect(top).toBeGreaterThanOrEqual(edge - 1);
    }
  });

  test('leaves the column alone on a Ctrl+wheel, which is the page zooming', async ({
    page,
  }) => {
    await crowdOneLine(page);
    await readNote(page, 5);
    const before = await cardTops(page);
    const rail = (await page.getByTestId('doc-comment-rail-column').boundingBox())!;
    await page.mouse.move(rail.x + rail.width / 2, rail.y + 300);

    await page.keyboard.down('Control');
    for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    await page.waitForTimeout(300);

    expect(await cardTops(page)).toEqual(before);
  });

  test('keeps the card being read in place when Tab reaches a card scrolled away', async ({
    page,
  }) => {
    // A card out of sight because the body was scrolled is not one the card
    // being read pushed up: the browser brings it into view, and the column
    // stays as it is.
    await openFreshDocument(page);
    await page.keyboard.type('top words here\n');
    for (let i = 0; i < 30; i += 1) await page.keyboard.type(`filler ${String(i)}\n`);
    await page.keyboard.type(CROWDED_LINE);
    const crowded = page.locator(`${EDITOR} p`).nth(31);
    await expect(crowded).toHaveText(CROWDED_LINE);
    await selectChars(page, 0, 3, 0);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('far top');
    await page.getByTestId('doc-comment-draft-save').click();
    for (let i = 0; i < 6; i += 1) {
      await selectChars(page, i, i + 1, 31);
      await page.getByTestId('doc-bubble-tool-comment').click();
      await page.getByTestId('doc-comment-draft-input').fill(`note ${String(i)}`);
      await page.getByTestId('doc-comment-draft-save').click();
      await expect(page.getByTestId('doc-comment-draft-card')).toHaveCount(0);
    }
    await crowded.scrollIntoViewIfNeeded();
    // The seventh highlight: the far one comes first.
    await page.locator(`${EDITOR} [data-bn-thread-id]`).nth(6).click();
    await expect(
      page.getByTestId('doc-comment-card').filter({ hasText: 'note 5' }),
    ).toHaveAttribute('data-selected', 'true');
    await page.waitForTimeout(400);
    const offset = async (): Promise<number> =>
      (await cardTops(page))['note 5']! - (await crowded.boundingBox())!.y;
    const before = await offset();

    await page.getByTestId('doc-comment-rail-close').focus();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(400);

    expect(
      await page.evaluate(() => document.activeElement?.textContent ?? ''),
    ).toContain('far top');
    expect(Math.abs((await offset()) - before)).toBeLessThan(2);
  });

  test('keeps the control the keyboard reaches inside a card below the header', async ({
    page,
  }) => {
    // The margin every card keeps is kept by what is inside it too: a reply's
    // delete button under the header is brought out from under it.
    await openFreshDocument(page);
    for (let i = 0; i < 12; i += 1) await page.keyboard.type(`line ${String(i)}\n`);
    await page.keyboard.type('the commented line');
    for (let i = 0; i < 40; i += 1) await page.keyboard.type(`\nafter ${String(i)}`);
    await expect(page.locator(`${EDITOR} p`).nth(12)).toHaveText('the commented line');
    await selectChars(page, 0, 3, 12);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('first');
    await page.getByTestId('doc-comment-draft-save').click();
    await page.locator(`${EDITOR} [data-bn-thread-id]`).first().click();
    for (let i = 0; i < 4; i += 1) {
      await page.getByTestId('doc-comment-reply-input').fill(`reply ${String(i)}`);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('doc-comment-reply-input')).toHaveValue('');
    }
    const header = (await page.getByTestId('doc-comment-rail-header').boundingBox())!;
    const edge = header.y + header.height;
    const reply = page.getByTestId('doc-comment-reply-input');
    // The body scrolled until the reply box sits just below the header, with
    // the replies above it out of sight under it.
    const box = (await reply.boundingBox())!;
    await page.mouse.move(box.x - 400, box.y);
    await page.mouse.wheel(0, box.y - edge - 10);
    await page.waitForTimeout(300);
    await reply.focus();

    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Shift+Tab');
      await page.waitForTimeout(250);
      const top = await page.evaluate(
        () => (document.activeElement as HTMLElement).getBoundingClientRect().top,
      );
      expect(top).toBeGreaterThanOrEqual(edge - 1);
    }
  });

  test('walks the keyboard down the column through the card being written', async ({
    page,
  }) => {
    await crowdOneLine(page);
    await selectChars(page, 0, 4, 2);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await expect(page.getByTestId('doc-comment-draft-card')).toBeVisible();
    await page.waitForTimeout(400);

    await page.getByTestId('doc-comment-rail-close').focus();
    await page.keyboard.press('Tab');

    expect(
      await page.evaluate(
        () =>
          document
            .querySelector('[data-testid="doc-comment-draft-card"]')
            ?.contains(document.activeElement) ?? false,
      ),
    ).toBe(true);
  });

  test('brings a draft card Tab reaches from under the header into view', async ({
    page,
  }) => {
    // The browser brings the element Tab reaches into view before any focus
    // event runs, scrolling the body when the card is above it; the card then
    // becomes the one being read and sits level with its words.
    await openFreshDocument(page);
    for (let i = 0; i < 30; i += 1) await page.keyboard.type(`filler ${String(i)}\n`);
    await page.keyboard.type('draft line here\n');
    await page.keyboard.type(CROWDED_LINE);
    for (let i = 0; i < 30; i += 1) await page.keyboard.type(`\nafter ${String(i)}`);
    const crowded = page.locator(`${EDITOR} p`).nth(31);
    await expect(crowded).toHaveText(CROWDED_LINE);
    for (let i = 0; i < 5; i += 1) {
      await selectChars(page, i, i + 1, 31);
      await page.getByTestId('doc-bubble-tool-comment').click();
      await page.getByTestId('doc-comment-draft-input').fill(`note ${String(i)}`);
      await page.getByTestId('doc-comment-draft-save').click();
      await expect(page.getByTestId('doc-comment-draft-card')).toHaveCount(0);
    }
    await selectChars(page, 0, 5, 30);
    await page.getByTestId('doc-bubble-tool-comment').click();
    await page.getByTestId('doc-comment-draft-input').fill('my words');
    await page.locator(`${EDITOR} [data-bn-thread-id]`).nth(4).click();
    await page.waitForTimeout(500);
    // The body scrolled until the crowded line sits near the top, so the
    // cards above the one being read are pushed up under the header.
    const line = (await crowded.boundingBox())!;
    await page.mouse.move(line.x + 50, line.y);
    await page.mouse.wheel(0, line.y - 250);
    await page.waitForTimeout(500);
    const header = (await page.getByTestId('doc-comment-rail-header').boundingBox())!;
    const edge = header.y + header.height;
    expect(
      (await page.getByTestId('doc-comment-draft-card').boundingBox())!.y,
    ).toBeLessThan(edge);

    await page.getByTestId('doc-comment-rail-close').focus();
    await page.keyboard.press('Tab');
    await page.waitForTimeout(600);

    expect(
      await page.evaluate(
        () =>
          document
            .querySelector('[data-testid="doc-comment-draft-card"]')
            ?.contains(document.activeElement) ?? false,
      ),
    ).toBe(true);
    const draftLine = (await page.locator(`${EDITOR} p`).nth(30).boundingBox())!.y;
    const draftTop = (await page.getByTestId('doc-comment-draft-card').boundingBox())!.y;
    expect(Math.abs(draftTop - draftLine)).toBeLessThan(12);
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement).getBoundingClientRect().top,
    );
    expect(focused).toBeGreaterThanOrEqual(edge - 1);
  });

  test('starts the column over when another card is read', async ({ page }) => {
    await crowdOneLine(page);
    await readNote(page, 5);
    const header = (await page
      .getByTestId('doc-comment-rail-header')
      .boundingBox())!;
    const rail = (await page.getByTestId('doc-comment-rail-column').boundingBox())!;
    await page.mouse.move(rail.x + rail.width / 2, header.y + header.height + 200);
    for (let i = 0; i < 5; i += 1) await page.mouse.wheel(0, -100);

    await readNote(page, 6);

    const line = (await page.locator(`${EDITOR} p`).nth(LINE).boundingBox())!;
    const tops = await cardTops(page);
    expect(Math.abs(tops['note 6']! - line.y)).toBeLessThan(12);
  });
});
