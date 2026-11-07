// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The heading outline beside the document body, end to end (inner#1149).
 *
 * What jsdom cannot show: where a jump really leaves each level of heading,
 * the highlight following a real scroll, the hover text of a heading cut
 * short, the outline staying put while the body scrolls and scrolling on its
 * own, the body width with the outline shut at two Space widths, and the
 * outline floating over the body, above the block handles, in a narrow Space.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace, DOCUMENT_EDITOR as EDITOR, VISIBLE_SPACE } from '../helpers/space';

let page: Page;

const createdSpaceIds: string[] = [];

test.beforeEach(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
});

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
  await page?.close();
});

const OUTLINE = `${VISIBLE_SPACE} [data-testid="doc-outline"]`;
const VIEWPORT = `${VISIBLE_SPACE} .doc-body-scroller [data-radix-scroll-area-viewport]`;
const WORDS = 'Words that fill the line and make the document long enough to scroll through with the outline beside it. ';
const LONG = 'A heading long enough that the outline column cuts it short and shows the rest on hover';

/**
 * Opens a fresh Document Space and pastes Markdown into it, as a user would.
 * @param p - The page.
 * @param markdown - The document.
 */
async function openWith(p: Page, markdown: string): Promise<void> {
  await openSmokeProject(p);
  createdSpaceIds.push(await createSpace(p, 'document', `outline-${Date.now()}`));
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await p.evaluate(({ selector, text }) => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', text);
    document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, { selector: EDITOR, text: markdown });
  await expect(p.locator(`${OUTLINE} [data-testid="doc-outline-row"]`).first()).toBeVisible({ timeout: 10_000 });
}

/**
 * A section: a heading and paragraphs under it.
 * @param marks - `#`, `##` or `###`.
 * @param title - The heading's words.
 * @param paragraphs - How many paragraphs follow.
 * @returns The Markdown.
 */
function section(marks: string, title: string, paragraphs = 6): string {
  return `${marks} ${title}\n\n${Array.from({ length: paragraphs }, () => WORDS.repeat(3)).join('\n\n')}\n\n`;
}

/**
 * A document with all three levels, a long heading and two short sections at
 * the end. Enough follows "Two" for a jump to reach the landing; the end of the
 * document stops a jump short only for the last sections.
 */
const DOCUMENT =
  section('#', 'One') + section('##', 'One one') + section('###', 'One one one') + section('##', LONG) +
  section('#', 'Two') + section('##', 'Two one') + section('###', 'Two one one') +
  section('##', 'Tail a', 1) + section('##', 'Tail b', 1);

/**
 * The outline row showing these words.
 * @param p - The page.
 * @param text - The heading's words.
 * @returns The row's jump button.
 */
function row(p: Page, text: string): ReturnType<Page['locator']> {
  return p.locator(`${OUTLINE} [data-testid="doc-outline-row"]`, { hasText: text }).first();
}

/**
 * The words of the highlighted outline row.
 * @param p - The page.
 * @returns Its words, or null when none is highlighted.
 */
async function highlighted(p: Page): Promise<string | null> {
  return p.evaluate((outline) => {
    const item = [...document.querySelectorAll(`${outline} [data-outline-item]`)].find((i) => i.className.includes('bg-accent-strong'));
    return item?.querySelector('[data-testid="doc-outline-row"]')?.textContent ?? null;
  }, OUTLINE);
}

/**
 * How far below the top of the body a heading's own line sits.
 * @param p - The page.
 * @param text - The heading's words.
 * @returns The distance in px.
 */
async function lineBelowTop(p: Page, text: string): Promise<number> {
  return p.evaluate(({ editor, viewport, words }) => {
    const line = [...document.querySelectorAll(`${editor} .bn-block-content[data-content-type="heading"]`)].find((h) => h.textContent === words)!;
    return line.getBoundingClientRect().top - document.querySelector(viewport)!.getBoundingClientRect().top;
  }, { editor: EDITOR, viewport: VIEWPORT, words: text });
}

/**
 * The width of the body's text column.
 * @param p - The page.
 * @returns Its width in px.
 */
async function textWidth(p: Page): Promise<number> {
  return p.evaluate(() => Math.round(document.querySelector('[data-space-outlet]:not([style*="display: none"]) [data-testid="document-editor-content"]')!.getBoundingClientRect().width));
}

/**
 * The visible Space's width; the Agent column takes 320px and a 1px handle left of it.
 * @param p - The page.
 * @returns Its width in px.
 */
async function spaceWidth(p: Page): Promise<number> {
  return p.evaluate((space) => Math.round(document.querySelector(space)!.getBoundingClientRect().width), VISIBLE_SPACE);
}

/**
 * Whether any account in this browser has stored the outline as shut.
 * @param p - The page.
 * @returns True when one has.
 */
async function storedShut(p: Page): Promise<boolean> {
  return p.evaluate(() => {
    const record = JSON.parse(window.localStorage.getItem('breatic.userPreferences') ?? '{}') as Record<string, { documentOutlineVisible?: boolean }>;
    return Object.values(record).some((entry) => entry.documentOutlineVisible === false);
  });
}

/**
 * The heading the reading line has reached, worked out from the page itself.
 * @param p - The page.
 * @returns Its words.
 */
async function headingAtReadingLine(p: Page): Promise<string | null> {
  return p.evaluate(({ editor, viewport }) => {
    const top = document.querySelector(viewport)!.getBoundingClientRect().top;
    let current: string | null = null;
    for (const h of document.querySelectorAll(`${editor} .bn-block-content[data-content-type="heading"]`)) {
      if (h.getBoundingClientRect().top <= top + 24) current = h.textContent;
    }
    return current;
  }, { editor: EDITOR, viewport: VIEWPORT });
}

test('a jump leaves each level of heading 16px under the top and the caret at its start', async () => {
  await openWith(page, DOCUMENT);
  for (const title of ['One one one', 'Two', 'One one']) {
    await row(page, title).click();
    await expect.poll(() => lineBelowTop(page, title)).toBeGreaterThanOrEqual(14);
    expect(await lineBelowTop(page, title)).toBeLessThanOrEqual(18);
    expect(await highlighted(page)).toBe(title);
  }
  await page.keyboard.type('Z');
  await expect(row(page, 'ZOne one')).toBeVisible();
});

test('a row reads from its left edge, indented by level, and only the one being read is medium weight', async () => {
  await openWith(page, DOCUMENT);
  await row(page, 'Two').click();
  const rows = await page.evaluate((outline) => [...document.querySelectorAll(`${outline} [data-testid="doc-outline-row"]`)].map((r) => {
    const words = r.lastElementChild!.getBoundingClientRect();
    return { text: r.textContent, gap: Math.round(words.left - r.getBoundingClientRect().left), left: Math.round(words.left), weight: getComputedStyle(r).fontWeight };
  }), OUTLINE);
  const of = (text: string): (typeof rows)[number] => rows.find((r) => r.text === text)!;
  for (const r of rows) expect(r.gap).toBeLessThanOrEqual(8);
  expect(of('One one').left - of('One').left).toBe(12);
  expect(of('One one one').left - of('One one').left).toBe(12);
  expect(of('Two').weight).toBe('500');
  expect(of('One').weight).toBe('400');
});

test('the highlight follows the scroll, and a short last section keeps the one clicked', async () => {
  await openWith(page, DOCUMENT);
  await page.evaluate((viewport) => {
    const vp = document.querySelector(viewport)!;
    vp.scrollTo({ top: 0, behavior: 'instant' });
  }, VIEWPORT);
  await expect.poll(() => highlighted(page)).toBe('One');

  await row(page, 'Tail a').click();
  await expect.poll(() => highlighted(page)).toBe('Tail a');

  await page.mouse.move(900, 500);
  await page.mouse.wheel(0, -600);
  await expect.poll(() => highlighted(page)).not.toBe('Tail a');

  await page.evaluate((viewport) => {
    const vp = document.querySelector(viewport)!;
    vp.scrollTo({ top: vp.scrollHeight, behavior: 'instant' });
  }, VIEWPORT);
  await expect.poll(() => highlighted(page)).toBe('Tail b');
});

test('the highlight stays right when the comment panel opens and rewraps the text', async () => {
  await openWith(page, DOCUMENT);
  await page.evaluate((viewport) => document.querySelector(viewport)!.scrollTo({ top: 2600, behavior: 'instant' }), VIEWPORT);
  await expect.poll(() => highlighted(page)).toBe(await headingAtReadingLine(page));
  await page.locator(`${VISIBLE_SPACE} [data-testid="doc-doc-menu-trigger"]`).click();
  await page.getByTestId('doc-doc-menu-comments').click();
  await expect(page.getByTestId('doc-comment-rail')).toBeVisible();
  const expected = await headingAtReadingLine(page);
  await expect.poll(() => highlighted(page)).toBe(expected);
});

test('a heading cut short shows its whole text on hover', async () => {
  await openWith(page, DOCUMENT);
  await row(page, 'A heading long enough').hover();
  await expect(page.getByRole('tooltip')).toHaveText(LONG);
  // Moved over in steps, as a mouse does: the tooltip leaves once the pointer
  // is clear of the way between its row and itself.
  const two = (await row(page, 'Two').boundingBox())!;
  await page.mouse.move(two.x + 20, two.y + two.height / 2, { steps: 8 });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('the outline stays put while the body scrolls and scrolls on its own when long', async () => {
  const many = Array.from({ length: 40 }, (_, i) => section('##', `Section ${String(i + 1)}`, 1)).join('');
  await openWith(page, many);
  const list = page.locator(`${OUTLINE} [data-radix-scroll-area-viewport]`);
  const before = (await page.locator(OUTLINE).boundingBox())!;
  await page.evaluate((viewport) => document.querySelector(viewport)!.scrollTo({ top: 2000, behavior: 'instant' }), VIEWPORT);
  expect((await page.locator(OUTLINE).boundingBox())!.y).toBe(before.y);
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await page.evaluate((viewport) => {
    const vp = document.querySelector(viewport)!;
    vp.scrollTo({ top: vp.scrollHeight, behavior: 'instant' });
  }, VIEWPORT);
  await expect.poll(() => highlighted(page)).toBe('Section 40');
  await expect(row(page, 'Section 40')).toBeInViewport();
});

test('shutting the outline keeps the text at 768px in a wide Space and widens it in a narrower one', async () => {
  await openWith(page, DOCUMENT);
  // The Agent column open at 320px: 1680 leaves the Space 1359px, past the 1136px that keeps 768.
  expect(await spaceWidth(page)).toBe(1359);
  const toggle = page.locator(`${VISIBLE_SPACE} [data-testid="doc-outline-toggle"]`);
  expect(await textWidth(page)).toBe(768);
  await toggle.click();
  await expect(page.locator(`${OUTLINE}`)).toHaveCount(0);
  expect(await textWidth(page)).toBe(768);
  await toggle.click();

  await page.setViewportSize({ width: 1280, height: 950 });
  await expect.poll(() => textWidth(page)).toBeLessThan(768);
  const open = await textWidth(page);
  await toggle.click();
  await expect.poll(() => textWidth(page)).toBeGreaterThan(open);
});

test('a narrow Space floats the outline over the body, above the block handles, and tucks it after a jump', async () => {
  await openWith(page, DOCUMENT);
  await page.setViewportSize({ width: 960, height: 950 });
  // The Agent column open at 320px leaves the Space 639px: too narrow to tile.
  await expect.poll(() => spaceWidth(page)).toBe(639);
  const column = page.locator(`${VISIBLE_SPACE} [data-testid="doc-outline-column"]`);
  await expect(column).toHaveAttribute('data-layout', 'floating');
  // Floating, the text keeps the width it has with the outline shut.
  const floatingWidth = await textWidth(page);
  const toggle = page.locator(`${VISIBLE_SPACE} [data-testid="doc-outline-toggle"]`);
  await toggle.click();
  expect(await textWidth(page)).toBe(floatingWidth);
  await toggle.click();

  // Over the outline near the body's edge, where the body's block handles are drawn.
  const target = row(page, 'Two');
  const box = (await target.boundingBox())!;
  const x = box.x + box.width - 20;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  expect(await page.evaluate(({ px, py }) => document.elementFromPoint(px, py)?.closest('[data-testid="doc-outline-row"]')?.textContent ?? null, { px: x, py: y })).toBe('Two');

  await page.mouse.click(x, y);
  await expect.poll(() => lineBelowTop(page, 'Two')).toBeLessThanOrEqual(18);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.locator(OUTLINE)).toHaveCount(0);
  const heading = await page.evaluate((editor) => {
    const line = [...document.querySelectorAll(`${editor} .bn-block-content[data-content-type="heading"]`)].find((h) => h.textContent === 'Two')!;
    const r = line.getBoundingClientRect();
    return document.elementFromPoint(r.left + 4, r.top + r.height / 2)?.closest('[data-testid="doc-outline-column"]') === null;
  }, EDITOR);
  expect(heading).toBe(true);

  await page.locator(`${VISIBLE_SPACE} [data-testid="doc-outline-toggle"]`).click();
  await expect(page.locator(`${OUTLINE} [data-testid="doc-outline-row"]`).first()).toBeVisible();

  await page.setViewportSize({ width: 1680, height: 950 });
  await expect(column).toHaveAttribute('data-layout', 'tiled');
  await expect(row(page, 'Two')).toBeVisible();
  expect(await storedShut(page)).toBe(false);
});
