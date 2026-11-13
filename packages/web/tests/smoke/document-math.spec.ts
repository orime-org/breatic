// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Formulas in the document body end to end (inner#1423).
 *
 * What jsdom cannot show: the source box opening with the real caret in it,
 * real typing of `$$x$$` with a real Cmd/Ctrl+Z after it, the arrow keys
 * walking into and out of a source the browser lays out, the box drawn in a
 * table cell, a copy and a paste through the browser's own events, a drag
 * that ends on a rendered formula, a second page seeing an edit arrive, the
 * snapshot comparison drawing both versions of a formula, and the box's
 * corners and surface as the two themes compute them.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { pressAndSettle, selectInBody } from '../helpers/editor-keys';
import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR, VISIBLE_SPACE, visibleSpace } from '../helpers/space';

let page: Page;

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
});

/** The formula whose box is open. */
const OPEN = `${EDITOR} .bn-preview-with-source-popup[data-open="true"]`;

/** The open formula's source box. */
const POPUP = `${OPEN} .doc-math-popup`;

/**
 * Open a freshly made Document Space with the caret in the body.
 * @param p - The page.
 * @returns The new Space's id.
 */
async function openFreshDocument(p: Page): Promise<string> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `math-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return id;
}

/**
 * Every row as `type:text`, a formula inside a line written `[math:source]`
 * and a formula block as `mathBlock:source`, read off the editor's document.
 * @param p - The page.
 * @returns One entry per row.
 */
async function lines(p: Page): Promise<string[]> {
  return p.evaluate((selector) => {
    type PMNode = {
      type: { name: string };
      isText: boolean;
      isTextblock: boolean;
      text?: string;
      textContent: string;
      forEach: (fn: (child: PMNode) => void) => void;
      descendants: (fn: (node: PMNode) => boolean | void) => void;
    };
    const view = document.querySelector(selector) as unknown as { editor?: { state: { doc: PMNode } } } | null;
    // A page still opening has no editor yet; an empty answer lets a poll wait for it.
    if (view?.editor === undefined) return [];
    const doc = view.editor.state.doc;
    const out: string[] = [];
    doc.descendants((node) => {
      if (!node.isTextblock) return true;
      if (node.type.name === 'mathBlock') {
        out.push(`mathBlock:${node.textContent}`);
        return false;
      }
      let text = '';
      node.forEach((child) => {
        text += child.type.name === 'math' ? `[math:${child.textContent}]` : child.isText ? child.text ?? '' : '';
      });
      out.push(`${node.type.name}:${text}`);
      return false;
    });
    return out;
  }, EDITOR);
}

/**
 * Picks the formula entry off the plus of the first (empty) line.
 * @param p - The page.
 */
async function insertFromPlus(p: Page): Promise<void> {
  await p.locator(`${EDITOR} .bn-block-content`).first().hover();
  await visibleSpace(p).getByTestId('doc-block-plus').click();
  await p.getByTestId('doc-block-insert-formula').click();
  await expect(p.locator(OPEN)).toHaveCount(1);
}

/**
 * Whether the browser's caret is inside the open formula's source.
 * @param p - The page.
 * @returns The answer.
 */
async function caretInSource(p: Page): Promise<boolean> {
  return p.evaluate((popup) => {
    const anchor = window.getSelection()?.anchorNode ?? null;
    const source = document.querySelector(`${popup} code`);
    return anchor !== null && source !== null && source.contains(anchor);
  }, POPUP);
}

/**
 * Sends HTML and its text fallback through the browser's paste event.
 * @param p - The page holding the focused editor.
 * @param data - The clipboard's formats.
 */
async function paste(p: Page, data: Record<string, string>): Promise<void> {
  await p.evaluate(({ selector, data }) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(data)) transfer.setData(type, value);
    document.querySelector(selector)!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, { selector: EDITOR, data });
}

/**
 * Copies the selection through the browser's copy event and hands back what
 * the editor wrote.
 * @param p - The page.
 * @returns Every format written.
 */
async function copy(p: Page): Promise<Record<string, string>> {
  return p.evaluate((selector) => {
    const transfer = new DataTransfer();
    document.querySelector(selector)!.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
    return Object.fromEntries(transfer.types.map((type) => [type, transfer.getData(type)]));
  }, EDITOR);
}

/**
 * Selects the whole of the first paragraph's text.
 * @param p - The page.
 */
async function selectFirstParagraph(p: Page): Promise<void> {
  await selectInBody(p, () => p.evaluate((selector) => {
    const paragraph = document.querySelector(`${selector} p`)!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, EDITOR));
}

/**
 * Puts the caret at the end of the first line. `End` only scrolls on macOS.
 * @param p - The page.
 */
async function caretAtEndOfFirstLine(p: Page): Promise<void> {
  await selectInBody(p, () => p.evaluate((selector) => {
    const paragraph = document.querySelector(`${selector} p`)!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, EDITOR));
}

test('a formula block from the plus menu: the box opens with the caret in it, Enter confirms, KaTeX draws it', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  expect(await caretInSource(page)).toBe(true);

  await page.keyboard.type('\\frac{a}{b}');
  await expect(page.locator(`${EDITOR} .katex-display`)).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(page.locator(OPEN)).toHaveCount(0);
  expect((await lines(page))[0]).toBe('mathBlock:\\frac{a}{b}');
  await expect(page.locator(`${EDITOR} .katex-display .mfrac`)).toBeVisible();
});

test('a formula block in a table cell opens its box on screen', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('above');
  await page.locator(`${EDITOR} .bn-block-content`).first().hover();
  await visibleSpace(page).getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-table').hover();
  await page.getByTestId('doc-table-size-2-2').click();
  await expect(page.locator(`${EDITOR} table`)).toHaveCount(1);

  const cell = page.locator(`${EDITOR} table td .bn-block-content`).first();
  await cell.hover();
  await visibleSpace(page).getByTestId(/^doc-block-(table-)?handle$|^doc-block-plus$/).first().click();
  const plus = page.getByTestId('doc-block-insert-formula');
  if (!(await plus.isVisible())) await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-formula').click();
  await expect(page.locator(OPEN)).toHaveCount(1);
  await page.keyboard.type('x^2');
  await expect(page.locator(`${EDITOR} table .katex-display`)).toBeVisible();

  const box = await page.locator(POPUP).boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  await page.keyboard.press('Enter');
  await expect(page.locator(OPEN)).toHaveCount(0);
});

test('typing $$x^2$$ makes an inline formula; undo gives the words back and typing on keeps them', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('area $$x^2$$');
  await expect.poll(() => lines(page)).toEqual(['paragraph:area [math:x^2]']);
  await expect(page.locator(`${EDITOR} p .katex`)).toBeVisible();

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => lines(page)).toEqual(['paragraph:area $$x^2$$']);

  await page.keyboard.type(' more');
  await expect.poll(() => lines(page)).toEqual(['paragraph:area $$x^2$$ more']);
});

test('the arrow keys walk into an inline source and out again, and Backspace after it steps in', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('a $$xy$$');
  await expect.poll(() => lines(page)).toEqual(['paragraph:a [math:xy]']);
  await expect(page.locator(OPEN)).toHaveCount(0);

  await pressAndSettle(page, 'ArrowLeft');
  await expect(page.locator(OPEN)).toHaveCount(1);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
  await expect(page.locator(OPEN)).toHaveCount(0);

  await caretAtEndOfFirstLine(page);
  await expect(page.locator(OPEN)).toHaveCount(0);
  await pressAndSettle(page, 'Backspace');
  await expect(page.locator(OPEN)).toHaveCount(1);
  expect(await lines(page)).toEqual(['paragraph:a [math:xy]']);
});

for (const how of ['Escape', 'a click outside', 'the confirm button'] as const) {
  test(`the box closes on ${how}`, async () => {
    await openFreshDocument(page);
    await insertFromPlus(page);
    await page.keyboard.type('y');
    if (how === 'Escape') await page.keyboard.press('Escape');
    else if (how === 'a click outside') await page.mouse.click(5, 5);
    else await page.locator(POPUP).getByRole('button', { name: 'OK', exact: true }).click();
    await expect(page.locator(OPEN)).toHaveCount(0);
    // The formula in the body is the live preview: every way out keeps what
    // was typed (design §6.3).
    expect((await lines(page))[0]).toBe('mathBlock:y');
  });
}

test('an empty formula shows its placeholder, and one that does not parse shows the error face once closed', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.press('Escape');
  await expect(page.locator(`${EDITOR} .doc-math`).first()).toContainText('Add a formula');

  await page.locator(`${EDITOR} .doc-math .bn-preview-container`).first().click();
  await expect(page.locator(OPEN)).toHaveCount(1);
  await page.keyboard.type('\\frac{a}{b');
  await expect(page.locator(POPUP)).toContainText('expected \'}\'');
  await page.keyboard.press('Enter');
  await expect(page.locator(OPEN)).toHaveCount(0);
  await expect(page.locator(`${EDITOR} .doc-math`).first()).toContainText('Formula has an error');
});

test('a symbol deleted in an inline formula and Escape keep the deletion, with the error face', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('a $$\\frac{a}{b}$$', { delay: 30 });
  await expect.poll(() => lines(page)).toEqual(['paragraph:a [math:\\frac{a}{b}]']);

  await page.locator(`${EDITOR} p .katex`).first().click();
  await expect(page.locator(OPEN)).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(page.locator(POPUP)).toContainText('expected \'}\'');
  await page.keyboard.press('Escape');

  await expect(page.locator(OPEN)).toHaveCount(0);
  expect(await lines(page)).toEqual(['paragraph:a [math:\\frac{a}{b]']);
  await expect(page.locator(`${EDITOR} .doc-math`).first()).toContainText('Formula has an error');
});

test('a symbol deleted in a formula block and Escape keep the deletion, with the error face', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('\\frac{a}{b}');
  await page.keyboard.press('Enter');
  await expect(page.locator(OPEN)).toHaveCount(0);

  await page.locator(`${EDITOR} .doc-math .bn-preview-container`).first().click();
  await expect(page.locator(OPEN)).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(page.locator(POPUP)).toContainText('expected \'}\'');
  await page.keyboard.press('Escape');

  await expect(page.locator(OPEN)).toHaveCount(0);
  expect((await lines(page))[0]).toBe('mathBlock:\\frac{a}{b');
  await expect(page.locator(`${EDITOR} .doc-math`).first()).toContainText('Formula has an error');
});

test('a formula block emptied with Backspace still takes what is typed next', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');
  await expect(page.locator(OPEN)).toHaveCount(0);

  await page.locator(`${EDITOR} .doc-math .bn-preview-container`).first().click();
  await expect(page.locator(OPEN)).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('yz');
  await page.keyboard.press('Enter');

  await expect(page.locator(OPEN)).toHaveCount(0);
  expect((await lines(page))[0]).toBe('mathBlock:yz');
});

test('a line holding a formula copies as $$source$$ and pastes back as a formula', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('a $$x^2$$ b');
  await expect.poll(() => lines(page)).toEqual(['paragraph:a [math:x^2] b']);

  await selectFirstParagraph(page);
  const written = await copy(page);
  expect(written['text/plain']).toContain('$$x^2$$');

  await caretAtEndOfFirstLine(page);
  await page.keyboard.press('Enter');
  await paste(page, written);
  await expect.poll(() => lines(page)).toEqual(['paragraph:a [math:x^2] b', 'paragraph:a [math:x^2] b']);
});

test('a reply copied from the chat pastes as a heading, a list and its formula', async () => {
  await openFreshDocument(page);
  await paste(page, {
    'text/html': '<h2>Title</h2><ul><li>one</li></ul><p>Mass is <span data-math="E=mc^2">$$E=mc^2$$</span>.</p>',
    'text/plain': '## Title\n\n- one\n\nMass is $$E=mc^2$$.',
  });
  await expect.poll(() => lines(page)).toEqual(
    expect.arrayContaining(['heading:Title', 'bulletListItem:one', 'paragraph:Mass is [math:E=mc^2].']),
  );
});

test('a drag that ends on a rendered formula copies its source', async () => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openFreshDocument(page);
  await page.keyboard.type('start $$x^2$$');
  await expect.poll(() => lines(page)).toEqual(['paragraph:start [math:x^2]']);

  const start = await page.locator(`${EDITOR} p`).first().boundingBox();
  const formula = await page.locator(`${EDITOR} p .katex`).first().boundingBox();
  await page.mouse.move(start!.x + 1, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(formula!.x + formula!.width / 2, formula!.y + formula!.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('$$x^2$$');
});

test('two pages on one Space see each other change a formula', async ({ browser }) => {
  await openFreshDocument(page);
  const home = (await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-testid'))!;
  await insertFromPlus(page);
  await page.keyboard.type('a');
  await page.keyboard.press('Enter');

  const second = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  const peer = await second.newPage();
  try {
    await peer.goto(page.url());
    await peer.getByTestId(home).click();
    await expect.poll(() => lines(peer), { timeout: 20_000 }).toContain('mathBlock:a');

    await peer.locator(`${EDITOR} .doc-math .bn-preview-container`).first().click();
    await expect(peer.locator(OPEN)).toHaveCount(1);
    await peer.keyboard.type('b');
    await expect.poll(() => lines(page), { timeout: 20_000 }).toContain('mathBlock:ab');
  } finally {
    await second.close();
  }
});

test('the snapshot comparison draws a changed formula before and after', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('a+b');
  await page.keyboard.press('Enter');

  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-save-snapshot').click();
  await page.getByTestId('doc-snapshot-name-input').fill('Before');
  await page.getByTestId('doc-snapshot-name-submit').click();
  await expect(page.getByTestId('doc-snapshot-name-dialog')).toHaveCount(0, { timeout: 15_000 });

  await page.locator(`${EDITOR} .doc-math .bn-preview-container`).first().click();
  await expect(page.locator(OPEN)).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await page.keyboard.type('c');
  await page.keyboard.press('Enter');
  await expect.poll(() => lines(page)).toContain('mathBlock:a+c');

  await page.getByTestId('doc-doc-menu-trigger').click();
  await page.getByTestId('doc-doc-menu-restore-snapshot').click();
  await expect(page.getByTestId('doc-version-panel')).toBeVisible({ timeout: 15_000 });
  const row = page.locator('[data-testid^="doc-version-row-"]:not([data-testid="doc-version-row-current"])').first();
  await expect(row).toContainText('Before', { timeout: 15_000 });
  await row.click();
  await page.getByTestId('doc-version-compare-current').click();
  const preview = page.getByTestId('doc-version-preview-body');
  await expect(preview.locator('.doc-version-delete .katex')).toHaveCount(1, { timeout: 15_000 });
  await expect(preview.locator('.doc-version-insert .katex')).toHaveCount(1);
  await page.getByTestId('doc-version-close').click();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the box takes the overlay corner and surface tokens (${theme})`, async () => {
    await openFreshDocument(page);
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await insertFromPlus(page);
    const measured = await page.evaluate((popup) => {
      const element = document.querySelector(popup)!;
      const probe = document.createElement('div');
      probe.style.borderRadius = 'var(--radius-overlay)';
      probe.style.backgroundColor = 'var(--color-popover)';
      document.body.appendChild(probe);
      const want = getComputedStyle(probe);
      const got = getComputedStyle(element);
      const result = {
        radius: [got.borderTopLeftRadius, want.borderTopLeftRadius],
        surface: [got.backgroundColor, want.backgroundColor],
      };
      probe.remove();
      return result;
    }, POPUP);
    expect(measured.radius[0]).toBe(measured.radius[1]);
    expect(measured.surface[0]).toBe(measured.surface[1]);
    await expect(page.locator(VISIBLE_SPACE).locator('.doc-math-popup button', { hasText: 'OK' })).toBeVisible();
  });
}

test('clicking a formula puts the caret at the end of its source', async () => {
  await openFreshDocument(page);
  await insertFromPlus(page);
  await page.keyboard.type('pq');
  // Enter closes the box and keeps the source.
  await page.keyboard.press('Enter');
  await page.locator(`${EDITOR} .doc-math .bn-preview-container`).first().click();
  await expect(page.locator(OPEN)).toHaveCount(1);
  await page.keyboard.type('r');
  expect((await lines(page))[0]).toBe('mathBlock:pqr');
});
