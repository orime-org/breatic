// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pasting into the chat composer, in a real browser.
 *
 * A pasted file goes where a picked one goes: it lands in the tray, uploads,
 * and a file the attach button would turn away is turned away with the same
 * notice. A plain-text paste still goes into the box.
 */
import { expect, test, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';

test.use({ storageState: STATE_FILE.A, viewport: { width: 1500, height: 900 } });

/** A 1×1 PNG. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Paste into the composer the way the browser does: one paste event carrying
 * a clipboard.
 * @param page - The page.
 * @param clip - What the clipboard carries.
 * @param clip.file - A file, as name, type and base64 bytes.
 * @param clip.text - Plain text.
 */
async function pasteInto(
  page: Page,
  clip: { file?: { name: string; type: string; base64: string }; text?: string },
): Promise<void> {
  await page.getByTestId('chat-composer-box').focus();
  await page.evaluate((c) => {
    const data = new DataTransfer();
    if (c.file) {
      const bytes = Uint8Array.from(atob(c.file.base64), (ch) => ch.charCodeAt(0));
      data.items.add(new File([bytes], c.file.name, { type: c.file.type }));
    }
    if (c.text !== undefined) data.setData('text/plain', c.text);
    const box = document.querySelector('[data-testid="chat-composer-box"]');
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    if (box && box.dispatchEvent(event) && c.text !== undefined) {
      // Nothing kept the browser from inserting it, so insert it as it would.
      document.execCommand('insertText', false, c.text);
    }
  }, clip);
}

test.beforeEach(async ({ page }) => {
  await openSmokeProject(page);
  await page.getByTestId('new-conversation').click();
  await expect(page.getByTestId('message-bubble')).toHaveCount(0, { timeout: 20_000 });
});

test('a pasted picture lands in the tray, as a picked one does @needs-storage', async ({ page }) => {
  await pasteInto(page, { file: { name: 'pasted.png', type: 'image/png', base64: PNG_BASE64 }, text: 'pasted.png' });

  await expect(page.getByTestId('chat-composer-chips')).toContainText('pasted.png', { timeout: 20_000 });
  await expect(page.getByTestId('chat-composer-box')).toHaveText('');
});

test('a pasted file the attach button refuses is refused with the same notice', async ({ page }) => {
  await pasteInto(page, { file: { name: 'archive.zip', type: 'application/zip', base64: 'UEsDBA==' } });

  await expect(page.getByTestId('chat-composer-attach-notice')).toBeVisible();
  await expect(page.getByTestId('chat-composer-chips')).toHaveCount(0);
});

test('a plain-text paste still goes into the box', async ({ page }) => {
  await pasteInto(page, { text: 'hello from the clipboard' });

  await expect(page.getByTestId('chat-composer-box')).toHaveText('hello from the clipboard');
});
