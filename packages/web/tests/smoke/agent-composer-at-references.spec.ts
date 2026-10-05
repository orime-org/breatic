// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `@` in the chat box, in a real browser: canvas text pasted in becomes an
 * attachment, `@` opens a list of the attachments just above the `@`, picking
 * one puts a block in the words, the message goes out with the reference, the
 * sent message shows the block, and removing the attachment removes its block.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';

test.use({ storageState: STATE_FILE.A, viewport: { width: 1500, height: 900 } });

const MARKER = '__breatic_canvas_nodes__:';

/** A picture as the copy button in a reply writes it. */
const PICTURE = {
  type: 'image',
  position: { x: 0, y: 0 },
  name: 'Neon street',
  content: 'https://img.example.com/neon-street.jpg',
  external: true,
};

/** Two nodes from some other canvas, a group and its member. */
const ELSEWHERE = [
  { type: 'group', position: { x: 0, y: 0 }, name: 'Shot list', id: 'g-elsewhere' },
  { type: 'text', position: { x: 10, y: 10 }, content: 'Opening shot', id: 't-elsewhere', parentId: 'g-elsewhere' },
];

/**
 * Paste text into the box the way the browser does: one paste event.
 * @param page - The page.
 * @param text - What the clipboard carries.
 */
async function pasteText(page: Page, text: string): Promise<void> {
  await page.getByTestId('chat-composer-box').focus();
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    document
      .querySelector('[data-testid="chat-composer-box"]')
      ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

test.beforeEach(async ({ page }) => {
  await openSmokeProject(page);
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
});

test('a pasted picture is attached rather than pasted as text', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));

  await expect(page.getByTestId('chat-composer-chips')).toContainText('Neon street');
  await expect(page.getByTestId('chat-composer-box')).toHaveText('');
});

test('nodes from another canvas are attached as one piece named after the group', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify(ELSEWHERE));

  await expect(page.getByTestId('chat-composer-chips')).toContainText('Shot list');
});

test('@ lists the attachment just above the @, and the pick goes out as a reference', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));
  await expect(page.getByTestId('chat-composer-chips')).toContainText('Neon street');

  const box = page.getByTestId('chat-composer-box');
  await box.pressSequentially('what is in @');
  const option = page.locator('[data-testid^="reference-mention-option-"]').first();
  await expect(option).toBeVisible();
  await expect(option).toContainText('Neon street');

  // Above the `@`, its left edge on the `@`'s, with a gap between.
  const at = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="chat-composer-box"]');
    const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const i = node.data.lastIndexOf('@');
      if (i >= 0) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const r = range.getBoundingClientRect();
        return { left: r.left, top: r.top };
      }
    }
    return null;
  });
  const list = await option.evaluate((el) => {
    const pop = el.closest('[style*="position: absolute"]') as HTMLElement | null;
    const r = (pop ?? el).getBoundingClientRect();
    return { left: r.left, bottom: r.bottom };
  });
  expect(at).not.toBeNull();
  expect(Math.abs(list.left - (at?.left ?? 0))).toBeLessThanOrEqual(1);
  expect((at?.top ?? 0) - list.bottom).toBeGreaterThanOrEqual(4);

  await box.press('Enter');
  await expect(page.getByTestId('chat-reference')).toHaveText('Neon street');
  await expect(option).toBeHidden();

  const sent = page.waitForRequest((req) => req.url().includes('/chat/message') && req.method() === 'POST');
  await box.press('End');
  await box.pressSequentially('?');
  await box.press('Enter');
  const body = (await sent).postDataJSON() as { message: string; attached_chips: { id: string }[] };
  const id = body.attached_chips[0]?.id ?? '';
  expect(body.message).toContain(`@[attachment:${id}]`);

  await expect(page.getByTestId('message-reference')).toHaveText('Neon street', { timeout: 20_000 });
  // The server's first word takes the words and the attachment together.
  await expect(page.getByTestId('chat-composer-chips')).toHaveCount(0);
  await expect(box).toHaveText('');

  // Selecting the sent words and copying them gives the attachment's name.
  await page.getByTestId('message-reference').evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el.closest('.whitespace-pre-wrap') ?? el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await page.keyboard.press('ControlOrMeta+C');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('what is in Neon street ?');
});

test('a long name in a sent message ends in an ellipsis inside its block', async ({ page }) => {
  const long = { ...PICTURE, name: 'A much longer attachment name for truncation checks' };
  await pasteText(page, MARKER + JSON.stringify([long]));
  await expect(page.getByTestId('chat-composer-chips')).toContainText('A much longer');
  const box = page.getByTestId('chat-composer-box');
  await box.pressSequentially('see @');
  await expect(page.locator('[data-testid^="reference-mention-option-"]').first()).toBeVisible();
  await box.press('Enter');
  await box.press('Enter');

  const block = page.getByTestId('message-reference');
  await expect(block).toHaveText(long.name, { timeout: 20_000 });
  const look = await block.evaluate((el) => ({
    overflow: getComputedStyle(el).textOverflow,
    cut: el.scrollWidth > el.clientWidth,
  }));
  expect(look).toEqual({ overflow: 'ellipsis', cut: true });
});

for (const theme of ['light', 'dark'] as const) {
  test(`a block in the box and in the sent message has the colour of the attachment chip (${theme})`, async ({ page }) => {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await pasteText(page, MARKER + JSON.stringify([PICTURE]));
    await expect(page.getByTestId('chat-composer-chips')).toContainText('Neon street');
    const box = page.getByTestId('chat-composer-box');
    await box.pressSequentially('see @');
    await expect(page.locator('[data-testid^="reference-mention-option-"]').first()).toBeVisible();
    await box.press('Enter');

    const fill = (testId: string): Promise<string> =>
      page.getByTestId(testId).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    const chip = await page
      .locator('[data-testid^="chat-chip-"]')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await fill('chat-reference')).toBe(chip);

    await box.press('Enter');
    await expect(page.getByTestId('message-reference')).toBeVisible({ timeout: 20_000 });
    expect(await fill('message-reference')).toBe(chip);
  });
}

test('text pasted after an @ that names no attachment opens no list', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));
  await expect(page.getByTestId('chat-composer-chips')).toContainText('Neon street');
  await pasteText(page, '第三方的@撒发的多少是收到');
  await page.getByTestId('chat-composer-box').pressSequentially('多少');

  await expect(page.getByTestId('chat-composer-box')).toHaveText('第三方的@撒发的多少是收到多少');
  await expect(page.getByTestId('reference-mention-empty')).toBeHidden();
  await expect(page.locator('[data-testid^="reference-mention-option-"]')).toHaveCount(0);
});

test('the full-width at sign a CJK input method types opens the list too', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));
  const box = page.getByTestId('chat-composer-box');
  await box.pressSequentially('写真の＠');
  await expect(page.locator('[data-testid^="reference-mention-option-"]').first()).toContainText('Neon street');
  await box.press('Enter');

  await expect(page.getByTestId('chat-reference')).toHaveText('Neon street');
  await expect(box).toHaveText(/^写真の/);
});

test('Shift+Tab out of an open @ list hides it and leaves the focused control uncovered', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));
  const box = page.getByTestId('chat-composer-box');
  await box.pressSequentially('look at @');
  const option = page.locator('[data-testid^="reference-mention-option-"]').first();
  await expect(option).toBeVisible();

  await box.press('Shift+Tab');

  await expect(option).toBeHidden();
  const uncovered = await page.evaluate(() => {
    const focused = document.activeElement as HTMLElement | null;
    if (focused === null || focused === document.body) return null;
    const r = focused.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (top === focused || focused.contains(top));
  });
  expect(uncovered).toBe(true);
});

test('keys typed while a new conversation opens land in the box', async ({ page }) => {
  const box = page.getByTestId('chat-composer-box');
  await page.getByTestId('new-conversation').click();
  await box.focus();
  await expect(box).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });

  await page.keyboard.type('still here');

  await expect(box).toHaveText('still here');
});

test('a new conversation opens on its own empty draft, not the words left in the last one', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));
  const box = page.getByTestId('chat-composer-box');
  await box.pressSequentially('look at @');
  await expect(page.locator('[data-testid^="reference-mention-option-"]').first()).toBeVisible();
  await box.press('Enter');
  await box.pressSequentially(' here');
  await expect(page.getByTestId('chat-reference')).toBeVisible();

  await page.getByTestId('new-conversation').click();

  await expect(box).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
  await expect(box).toHaveText('');
  await expect(page.getByTestId('chat-composer-chips')).toHaveCount(0);
});

test('removing the attachment takes its block out of the words', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));
  const box = page.getByTestId('chat-composer-box');
  await box.pressSequentially('look at @');
  await expect(page.locator('[data-testid^="reference-mention-option-"]').first()).toBeVisible();
  await box.press('Enter');
  await expect(page.getByTestId('chat-reference')).toBeVisible();

  await page.getByTestId('chat-composer-chips').getByRole('button').click();

  await expect(page.getByTestId('chat-reference')).toHaveCount(0);
  await expect(box).toHaveText(/^look at/);
});
