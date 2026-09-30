// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The divider end to end (task #124, A1–A13).
 *
 * What jsdom cannot show: the band's colour and the line's colour as the two
 * themes compute them, a real click and real arrows onto a node with no text,
 * an input method driven through the browser's own composition path, the
 * gap cursor the browser draws, and a second tab seeing the line arrive.
 *
 * Wants dev running:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { openSmokeProject } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

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

const EDITOR = '[data-testid="document-space"] .ProseMirror';
const DIVIDER = `${EDITOR} [data-content-type="divider"]`;

/**
 * Open a freshly made Document Space with the caret in the body.
 * @param p - The page.
 * @returns The new Space's id.
 */
async function openFreshDocument(p: Page): Promise<string> {
  await openSmokeProject(p);
  const id = await createSpace(p, 'document', `divider-${Date.now()}`);
  createdSpaceIds.push(id);
  const editor = p.locator(EDITOR);
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.click();
  await expect(editor).toBeFocused();
  return id;
}

/**
 * Every row as `type:text`, in order.
 * @param p - The page.
 * @returns One entry per row.
 */
async function rows(p: Page): Promise<string[]> {
  return p.evaluate((selector) => {
    const root = document.querySelector(selector);
    return [...(root?.querySelectorAll('.bn-block-content') ?? [])].map((row) => {
      const type = row.getAttribute('data-content-type') ?? '?';
      return `${type}:${row.textContent ?? ''}`;
    });
  }, EDITOR);
}

/**
 * Type `Above`, a divider by `---`, then `Below`: three rows.
 * @param p - The page.
 */
async function sandwich(p: Page): Promise<void> {
  await p.keyboard.type('Above');
  await p.keyboard.press('Enter');
  await p.keyboard.type('---');
  await p.keyboard.type('Below');
  await expect.poll(() => rows(p)).toEqual([
    'paragraph:Above',
    'divider:',
    'paragraph:Below',
  ]);
}

/**
 * What a CSS custom property resolves to as a colour on this page.
 * @param p - The page.
 * @param token - The property, `--color-*`.
 * @returns The computed colour.
 */
async function tokenColour(p: Page, token: string): Promise<string> {
  return p.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(${name})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, token);
}

/**
 * The divider row's own background and whether it carries the band class.
 * @param p - The page.
 * @returns The two readings.
 */
async function band(p: Page): Promise<{ painted: boolean; background: string }> {
  return p.evaluate((selector) => {
    const el = document.querySelector(selector);
    return {
      painted: el?.classList.contains('doc-in-selection') ?? false,
      background: el === null ? '' : getComputedStyle(el).backgroundColor,
    };
  }, DIVIDER);
}

/**
 * Switch the theme through the toggle.
 * @param p - The page.
 * @param option - Which option.
 */
async function theme(p: Page, option: 'dark' | 'system'): Promise<void> {
  await p.getByTestId('theme-toggle').click();
  await expect(p.getByTestId('theme-popover')).toBeVisible();
  await p.getByTestId(`theme-option-${option}`).click();
  await expect(p.getByTestId('theme-popover')).toHaveCount(0);
}

/** Yjs's own capture timeout, which the document's undo manager keeps. */
const UNDO_CAPTURE_MS = 500;

/**
 * Walk the caret back to the head of the line it is on. Arrows rather than
 * Home: on macOS Home scrolls the page and leaves the caret where it was.
 *
 * The browser moves its own caret for an arrow and ProseMirror reads it back
 * on `selectionchange`, which fires later. A script pressing the next key in
 * the same instant runs ahead of that read — measured, a Backspace pressed
 * straight after five arrows acted on a caret that had not arrived yet
 * (probe round 4) — so each step waits until the editor's caret has moved.
 * @param p - The page.
 * @param characters - How many characters stand before the caret.
 */
async function caretBack(p: Page, characters: number): Promise<void> {
  for (let i = 0; i < characters; i += 1) {
    const before = await caretAt(p);
    await p.keyboard.press('ArrowLeft');
    await expect.poll(() => caretAt(p)).toBe(before - 1);
  }
}

/**
 * Where the editor's own caret is.
 * @param p - The page.
 * @returns Its position in the document.
 */
async function caretAt(p: Page): Promise<number> {
  return p.evaluate(
    (selector) =>
      (document.querySelector(selector) as unknown as {
        editor: { state: { selection: { head: number } } };
      }).editor.state.selection.head,
    EDITOR,
  );
}

/**
 * Put the pointer over the nth row so the handle appears beside it.
 * @param p - The page.
 * @param index - Which row, from the top.
 * @throws {Error} When that row has no box.
 */
async function hoverRow(p: Page, index: number): Promise<void> {
  const row = p.locator(`${EDITOR} .bn-block-content`).nth(index);
  const box = await row.boundingBox();
  if (box === null) throw new Error(`row ${index} has no box`);
  await p.mouse.move(box.x + 40, box.y + box.height / 2);
}

test('--- at the head of a line puts a divider above it and leaves the words below (A1)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('three words');
  await caretBack(page, 'three words'.length);
  await page.keyboard.type('---');
  await page.keyboard.type('X');

  await expect.poll(() => rows(page)).toEqual(['divider:', 'paragraph:Xthree words']);
});

test('the handle menu puts a divider and an empty line under the row (A2)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('pressed');

  await hoverRow(page, 0);
  await page.getByTestId('doc-block-handle').click();
  await page.getByTestId('doc-block-row-insertBelow').hover();
  await page.getByTestId('doc-block-insert-divider').click();
  await page.keyboard.type('next');

  await expect.poll(() => rows(page)).toEqual([
    'paragraph:pressed',
    'divider:',
    'paragraph:next',
  ]);
});

for (const mode of ['light', 'dark'] as const) {
  test(`a clicked divider and a select-all both paint the band, and the line takes the border colour (A3 · A6 · A9, ${mode})`, async () => {
    await openFreshDocument(page);
    await sandwich(page);
    if (mode === 'dark') await theme(page, 'dark');
    try {
      const selection = await tokenColour(page, '--color-selection');
      const border = await tokenColour(page, '--color-border');

      const line = await page.evaluate(
        (selector) => getComputedStyle(document.querySelector(`${selector} hr`)!).borderTopColor,
        DIVIDER,
      );
      expect(line).toBe(border);

      await page.locator(`${DIVIDER} hr`).click();
      await expect.poll(() => band(page)).toEqual({ painted: true, background: selection });

      await page.locator(EDITOR).getByText('Below').click();
      await expect.poll(async () => (await band(page)).painted).toBe(false);

      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.press('ControlOrMeta+a');
      await expect.poll(() => band(page)).toEqual({ painted: true, background: selection });

      await page.getByTestId('theme-toggle').focus();
      await expect.poll(async () => (await band(page)).painted).toBe(false);
    } finally {
      if (mode === 'dark') await theme(page, 'system');
    }
  });
}

test('a selected divider goes with Backspace and comes back with undo (A4)', async () => {
  await openFreshDocument(page);
  await sandwich(page);

  // Yjs folds edits closer together than its capture timeout (500ms, the
  // library default this Space keeps) into one undo step. A reader does not
  // type a document and delete from it inside half a second; a script does.
  await page.waitForTimeout(UNDO_CAPTURE_MS + 100);
  await page.locator(`${DIVIDER} hr`).click();
  await page.keyboard.press('Backspace');
  await expect.poll(() => rows(page)).toEqual(['paragraph:Above', 'paragraph:Below']);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => rows(page)).toEqual([
    'paragraph:Above',
    'divider:',
    'paragraph:Below',
  ]);
});

test('typing on a selected divider does nothing, Enter opens a line under it (A5)', async () => {
  await openFreshDocument(page);
  await sandwich(page);

  await page.locator(`${DIVIDER} hr`).click();
  await page.keyboard.type('x');
  expect(await rows(page)).toEqual(['paragraph:Above', 'divider:', 'paragraph:Below']);
  expect((await band(page)).painted).toBe(true);

  await page.keyboard.press('Enter');
  await page.keyboard.type('y');
  await expect.poll(() => rows(page)).toEqual([
    'paragraph:Above',
    'divider:',
    'paragraph:y',
    'paragraph:Below',
  ]);
});

test('an input method on a selected divider writes nothing, during or after (A5)', async () => {
  await openFreshDocument(page);
  await sandwich(page);
  await page.locator(`${DIVIDER} hr`).click();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: 'ni',
    selectionStart: 2,
    selectionEnd: 2,
  });
  expect(await rows(page)).toEqual(['paragraph:Above', 'divider:', 'paragraph:Below']);

  await cdp.send('Input.insertText', { text: '你' });
  await page.waitForTimeout(100);

  expect(await rows(page)).toEqual(['paragraph:Above', 'divider:', 'paragraph:Below']);
  expect((await band(page)).painted).toBe(true);
  await cdp.detach();
});

test('Backspace at the head of the line below takes the divider in one press (A7)', async () => {
  await openFreshDocument(page);
  await sandwich(page);

  await caretBack(page, 'Below'.length);
  await page.keyboard.press('Backspace');

  await expect.poll(() => rows(page)).toEqual(['paragraph:Above', 'paragraph:Below']);
});

test('the handle menu on a divider offers what reaches it, and Quote quotes it (A8 · A10)', async () => {
  await openFreshDocument(page);
  await sandwich(page);
  await page.locator(EDITOR).getByText('Below').click();

  await hoverRow(page, 1);
  await page.getByTestId('doc-block-handle').click();
  for (const id of ['align', 'color', 'comment']) {
    await expect(page.getByTestId(`doc-block-row-${id}`)).toHaveAttribute('aria-disabled', 'true');
  }
  await page.getByTestId('doc-block-row-blockType').hover();
  await expect(page.getByTestId('doc-block-type-heading-1')).toHaveAttribute('aria-disabled', 'true');
  await page.getByTestId('doc-block-type-quote').click();

  await expect(page.locator(DIVIDER)).toHaveAttribute('data-quoted-run', /.*/);
});

test('quoting across a divider draws one unbroken rule (A10)', async () => {
  await openFreshDocument(page);
  await sandwich(page);

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+Shift+b');

  const quoted = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll(`${selector} .bn-block-content`)].map((row) =>
        row.hasAttribute('data-quoted-run'),
      ),
    EDITOR,
  );
  expect(quoted).toEqual([true, true, true]);
});

test('the gap cursor above a leading divider shows in dark, and takes typing (A11)', async () => {
  await openFreshDocument(page);
  await page.keyboard.type('---');
  await page.keyboard.type('Below');
  await caretBack(page, 'Below'.length);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');

  await theme(page, 'dark');
  try {
    const foreground = await tokenColour(page, '--color-foreground');
    const caret = await page.evaluate((selector) => {
      const gap = document.querySelector(`${selector} .ProseMirror-gapcursor`);
      return gap === null ? null : getComputedStyle(gap, '::after').borderTopColor;
    }, EDITOR);
    expect(caret).toBe(foreground);
  } finally {
    await theme(page, 'system');
  }

  await page.locator(EDITOR).focus();
  await page.keyboard.type('z');
  await expect.poll(() => rows(page)).toEqual(['paragraph:z', 'divider:', 'paragraph:Below']);
});

test('a second tab sees the divider arrive (A12)', async ({ browser }) => {
  await openFreshDocument(page);
  const other = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  try {
    await other.goto(page.url());
    await expect(other.locator(EDITOR)).toBeVisible({ timeout: 15_000 });

    await page.keyboard.type('---');

    await expect(other.locator(DIVIDER)).toHaveCount(1, { timeout: 10_000 });
  } finally {
    await other.close();
  }
});

test('copy and paste carries the divider (A13)', async () => {
  await openFreshDocument(page);
  await sandwich(page);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+a');

  // The body's own copy and paste handlers, handed one clipboard between
  // them: the path is the editor's serialiser and parser, which is what A13
  // is about, without the OS clipboard a headless browser does not share.
  await page.evaluate((selector) => {
    const data = new DataTransfer();
    document
      .querySelector(selector)!
      .dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    (window as unknown as { __clip: DataTransfer }).__clip = data;
  }, EDITOR);
  await page.locator(EDITOR).getByText('Below').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.evaluate((selector) => {
    const data = (window as unknown as { __clip: DataTransfer }).__clip;
    document
      .querySelector(selector)!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, EDITOR);

  await expect.poll(async () => (await rows(page)).filter((r) => r === 'divider:').length).toBe(2);
});
