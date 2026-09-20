// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The two things a reader gets done through the selection bubble bar.
 *
 * Pressing Bold then Italic really changes the document, and pressing a link
 * written through the panel really opens the address in another tab — each
 * crossing the bar's controls and the editor document rather than measuring
 * the bar itself.
 *
 * Needs dev running and a smoke account:
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect } from 'playwright/test';

import { openFreshDocument, selectFirstParagraph } from '../helpers/bubble-bar';
import { collapseAfterLinking, linkTheSelection } from '../helpers/link-panel';

test('在真浏览器里按浮出条上的按钮，文档真的变了', async ({ page }) => {
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  const html = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-testid="document-space"] .ProseMirror')
          ?.innerHTML ?? '',
    );

  // 单测里的点击走的是 jsdom 的 `.click()`，它不移动焦点；真机点击会先把焦点
  // 从正文拿走，而浮出条的显示恰恰依赖编辑器的焦点状态。这条走的就是那条路。
  expect(await html()).not.toContain('<strong>');
  await page.getByTestId('doc-bubble-tool-bold').click();
  await expect.poll(html).toContain('<strong>');

  // 按完之后条还在、选区还在，可以接着按第二个命令。
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();
  await page.getByTestId('doc-bubble-tool-italic').click();
  await expect.poll(html).toContain('<em>');
});

test('link: pressing a link in the body opens it in a new tab', async ({ page }) => {
  // Acceptance B1 and B2. The address opens elsewhere and this page is left
  // exactly as it was — same URL, same body.
  await openFreshDocument(page);
  await page.keyboard.type('press this link');
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/reached');
  await collapseAfterLinking(page);

  const before = page.url();
  const bodyBefore = await page.evaluate(
    () =>
      document.querySelector('[data-testid="document-space"] .ProseMirror')
        ?.textContent ?? '',
  );

  // The address is read from what the browser was asked to open, not from the
  // tab that opens: `a.example` resolves nowhere, so the new tab settles on
  // `chrome-error://chromewebdata/`. A domain that did resolve would reach out
  // of this machine.
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    const real = window.open.bind(window);
    window.open = (...args: Parameters<typeof window.open>) => {
      w.__opened.push(String(args[0]));
      return real(...args);
    };
  });

  // Pressed near the link's start rather than at its middle. ProseMirror reads
  // a press within 500ms and 10px of the previous one as a double click
  // (`prosemirror-view`'s `isNear`, `dx*dx + dy*dy < 100`), which selects a
  // word and never reaches the handler that opens the address — and the middle
  // of this link is one pixel from where `selectFirstParagraph` just pressed.
  // A reader who takes half a second between the two never meets this; a test
  // that runs both in 143ms does.
  const [opened] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 10_000 }),
    page
      .locator('[data-testid="document-space"] .ProseMirror a')
      .first()
      .click({ position: { x: 6, y: 8 } }),
  ]);

  await expect(
    page.evaluate(
      () => (window as unknown as { __opened: string[] }).__opened,
    ),
  ).resolves.toEqual(['https://a.example/reached']);
  expect(page.url()).toBe(before);
  await expect(
    page.evaluate(
      () =>
        document.querySelector('[data-testid="document-space"] .ProseMirror')
          ?.textContent ?? '',
    ),
  ).resolves.toBe(bodyBefore);
  await opened.close();
});
