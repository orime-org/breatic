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
  await page.getByTestId('chat-composer-textarea').focus();
  await page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    document
      .querySelector('[data-testid="chat-composer-textarea"]')
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
  await expect(page.getByTestId('chat-composer-textarea')).toHaveText('');
});

test('nodes from another canvas are attached as one piece named after the group', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify(ELSEWHERE));

  await expect(page.getByTestId('chat-composer-chips')).toContainText('Shot list');
});

test('@ lists the attachment just above the @, and the pick goes out as a reference', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));
  await expect(page.getByTestId('chat-composer-chips')).toContainText('Neon street');

  const box = page.getByTestId('chat-composer-textarea');
  await box.pressSequentially('what is in @');
  const option = page.locator('[data-testid^="reference-mention-option-"]').first();
  await expect(option).toBeVisible();
  await expect(option).toContainText('Neon street');

  // Above the `@`, its left edge on the `@`'s, with a gap between.
  const at = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="chat-composer-textarea"]');
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
});

test('removing the attachment takes its block out of the words', async ({ page }) => {
  await pasteText(page, MARKER + JSON.stringify([PICTURE]));
  const box = page.getByTestId('chat-composer-textarea');
  await box.pressSequentially('look at @');
  await expect(page.locator('[data-testid^="reference-mention-option-"]').first()).toBeVisible();
  await box.press('Enter');
  await expect(page.getByTestId('chat-reference')).toBeVisible();

  await page.getByTestId('chat-composer-chips').getByRole('button').click();

  await expect(page.getByTestId('chat-reference')).toHaveCount(0);
  await expect(box).toHaveText(/^look at/);
});
