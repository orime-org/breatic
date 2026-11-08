// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The two things a user gets done through the selection bubble bar.
 *
 * Pressing Bold then Italic really changes the document, and pressing a link
 * written through the panel really opens the address in another tab — each
 * crossing the bar's controls and the editor document rather than measuring
 * the bar itself.
 *
 * Needs dev running and a smoke account:
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect } from 'playwright/test';

import { openFreshDocument, selectFirstParagraph, test } from '../helpers/bubble-bar';
import { collapseAfterLinking, linkTheSelection } from '../helpers/link-panel';
import { DOCUMENT_EDITOR, VISIBLE_SPACE } from '../helpers/space';

test('bold and italic: pressing the bar buttons in a real browser changes the document', async ({ page }) => {
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox');
  await selectFirstParagraph(page);
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();

  const html = () =>
    page.evaluate(
      (space: string) =>
        document.querySelector(`${space} [data-testid="document-space"] .ProseMirror`)
          ?.innerHTML ?? '', VISIBLE_SPACE
    );

  // A unit test clicks through jsdom's `.click()`, which does not move focus; a
  // real click first takes focus away from the body, and the bar's visibility
  // depends on the editor's focus state. This case walks that path.
  expect(await html()).not.toContain('<strong>');
  await page.getByTestId('doc-bubble-tool-bold').click();
  await expect.poll(html).toContain('<strong>');

  // After the press the bar and the selection are still there, so a second
  // command can follow.
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeVisible();
  await page.getByTestId('doc-bubble-tool-italic').click();
  await expect.poll(html).toContain('<em>');
});

test('a button without a menu shows its name on hover, greyed or not (#1184)', async ({ page }) => {
  await openFreshDocument(page);
  await page.keyboard.type('the quick brown fox');
  await selectFirstParagraph(page);
  const bold = page.getByTestId('doc-bubble-tool-bold');
  // The pointer travels onto the button the way a hand moves it, in several
  // moves: the tooltip opens on a pointer move over its button.
  const reach = async (): Promise<void> => {
    const box = (await bold.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  };

  await reach();
  await expect(page.getByRole('tooltip')).toHaveText('Bold');

  // Inline code takes no other mark, so bold greys out over it; a greyed
  // button that a browser sends no pointer events would never show its name.
  await page.getByTestId('doc-bubble-tool-code').click();
  await expect(bold).toHaveAttribute('aria-disabled', 'true');
  await page.mouse.move(0, 0, { steps: 8 });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await reach();
  await expect(page.getByRole('tooltip')).toHaveText('Bold');
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
    (space: string) =>
      document.querySelector(`${space} [data-testid="document-space"] .ProseMirror`)
        ?.textContent ?? '', VISIBLE_SPACE
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
  // A user who takes half a second between the two never meets this; a test
  // that runs both in 143ms does.
  const [opened] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 10_000 }),
    page
      .locator(`${DOCUMENT_EDITOR} a`)
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
      (space: string) =>
        document.querySelector(`${space} [data-testid="document-space"] .ProseMirror`)
          ?.textContent ?? '', VISIBLE_SPACE
    ),
  ).resolves.toBe(bodyBefore);
  await opened.close();
});
