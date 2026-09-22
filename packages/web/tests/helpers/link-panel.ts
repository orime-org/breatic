// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Links in a document body: writing one, the panel that acts on it, and the
 * toolbar a resting pointer raises over it.
 *
 * Builds on `bubble-bar`, whose hooks open the Space each case works in and
 * take it away again.
 */
import { expect, type Page } from 'playwright/test';

import { openFreshDocument, selectParagraph } from './bubble-bar';

/**
 * The two hover delays, the same numbers the toolbar counts with
 * (`spaces/document/link-toolbar-timing.ts`). Declared here rather than
 * imported: these specs run under playwright's own config and reach nothing
 * under `src`.
 */
export const HOVER_OPEN_DELAY_MS = 300;
export const HOVER_CLOSE_DELAY_MS = 200;

/** The four addresses `linkedDocument` writes, read back by the cases. */
export const HOVERED = 'https://a.example/hovered';
export const WRAPPED = 'https://a.example/wrapped';
export const ONE_CHAR = 'https://a.example/one';
export const FAR = 'https://a.example/far';

/** Put a link on whatever is selected, through the panel the user would use. */
export async function linkTheSelection(page: Page, url: string): Promise<void> {
  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('doc-link-input').fill(url);
  await page.getByTestId('doc-link-confirm').click();
}

/**
 * Collapse the selection an address confirm leaves behind, to the end of it.
 *
 * Confirming an address closes the panel and hands focus back to the body, and
 * the hand-back is a frame behind the close. A keypress sent before it lands
 * goes nowhere and leaves the selection — and the bar — as they were; the next
 * one then collapses to the *start* instead, which is outside the link as far
 * as the toolbar is concerned.
 * @param page - The page.
 */
export async function collapseAfterLinking(page: Page): Promise<void> {
  await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });
  await expect(
    page.locator('[data-testid="document-space"] .ProseMirror'),
  ).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('doc-selection-bubble-bar')).not.toBeAttached({
    timeout: 5_000,
  });
}

/**
 * Reach the `view` state over the body's first link, the way a reader does.
 *
 * The link's text is dragged over rather than pressed: a press opens the
 * address in a new tab now, and the caret it leaves behind is collapsed, which
 * is not a selection the bar shows up for. The drag runs along the link's own
 * first line — the bar hangs over the middle of a link that runs to two lines
 * and swallows a pointer aimed at the element's box.
 * @param page - The page.
 */
export async function openViewOverFirstLink(page: Page): Promise<void> {
  if (await page.getByTestId('doc-selection-bubble-bar').isVisible()) {
    await collapseAfterLinking(page);
  }

  const line = await page.evaluate(() => {
    const first = document.querySelector('.ProseMirror a')!.getClientRects()[0]!;
    return {
      left: Math.round(first.left) + 2,
      right: Math.round(first.right) - 2,
      y: Math.round(first.top + first.height / 2),
    };
  });
  await page.mouse.move(line.left, line.y);
  await page.mouse.down();
  await page.mouse.move(line.right, line.y, { steps: 4 });
  await page.mouse.up();

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-url')).toBeVisible({ timeout: 5_000 });
}

/** The panel against a rectangle: how far its centre is off, and the gap above it. */
export async function panelAgainst(
  page: Page,
  rect: { left: number; right: number; bottom: number },
): Promise<{ leftOffset: number; gapBelow: number }> {
  return page.evaluate((target) => {
    const panel = document
      .querySelector('[data-testid="doc-link-popover"]')!
      .getBoundingClientRect();
    return {
      leftOffset: panel.left - target.left,
      gapBelow: panel.top - target.bottom,
    };
  }, rect);
}

/**
 * Wait until the panel is placed 8px under `rect`, and report where it landed.
 *
 * The panel counts as visible from the frame it mounts on and is placed on a
 * later one, so the gap is polled rather than read once. It is allowed a pixel
 * either side of the 8 `offset(8)` asks for: floating-ui snaps its translate to
 * whole device pixels (`roundByDPR` in `@floating-ui/react-dom`), and a target
 * whose bottom edge falls on a half pixel — a wrapped line does, measured at
 * 154.5 — comes out 8.5.
 */
export async function settlePanelUnder(
  page: Page,
  rect: { left: number; right: number; bottom: number },
): Promise<{ leftOffset: number; gapBelow: number }> {
  await expect
    .poll(async () => Math.abs((await panelAgainst(page, rect)).gapBelow - 8))
    .toBeLessThanOrEqual(1);
  return panelAgainst(page, rect);
}

/**
 * The panel is under `rect`, against it, and inside the body column.
 *
 * Two placements are right, and which one depends on the width: the left edges
 * meet, or — when a target sits far enough along the line that a panel aligned
 * to it would run past the column — `shift` pulls it back to the column's right
 * edge. Anywhere else is wrong, and asserting only "inside the column" would
 * pass for a panel that had lost its target entirely.
 */
export async function expectPanelMeetsTargetInColumn(
  page: Page,
  rect: { left: number; right: number; bottom: number },
): Promise<void> {
  await settlePanelUnder(page, rect);
  const view = await bodyView(page);
  const panel = await panelBox(page);
  expect(panel.left).toBeGreaterThanOrEqual(view.left);
  expect(panel.right).toBeLessThanOrEqual(view.right);
  if (rect.left + panel.width > view.right) {
    expect(Math.abs(panel.right - view.right)).toBeLessThan(2);
  } else {
    expect(Math.abs(panel.left - rect.left)).toBeLessThan(2);
  }
}

/**
 * The box of the selected TEXT, read off the mark that is drawn over it.
 *
 * The DOM selection is emptied the moment the panel takes the focus, so the
 * mark is the only thing left that says where the selection was. The mark is
 * taller than the text: it carries vertical padding so the band covers the
 * leading, and this body sets that padding from its own line height. Both link
 * controls are measured against the text, which is why the padding comes back
 * off here — a decoration painted on a link moves neither of them.
 * @param page - The page.
 * @returns The text's left, right and bottom.
 */
export async function drawnSelectionBox(
  page: Page,
): Promise<{ left: number; right: number; bottom: number }> {
  return page.evaluate(() => {
    const mark = document.querySelector('[data-show-selection]')!;
    const r = mark.getBoundingClientRect();
    const padded = parseFloat(getComputedStyle(mark).paddingBottom);
    return { left: r.left, right: r.right, bottom: r.bottom - padded };
  });
}

/** Where the panel is, and how wide. */
export async function panelBox(
  page: Page,
): Promise<{ left: number; right: number; width: number; centre: number }> {
  return page.evaluate(() => {
    const r = document
      .querySelector('[data-testid="doc-link-popover"]')!
      .getBoundingClientRect();
    return { left: r.left, right: r.right, width: r.width, centre: (r.left + r.right) / 2 };
  });
}

/** The body's visible area. */
export async function bodyView(
  page: Page,
): Promise<{ left: number; right: number; top: number; bottom: number }> {
  return page.evaluate(() => {
    const r = document
      .querySelector('[data-testid="document-space"] .ProseMirror')!
      .closest('[data-radix-scroll-area-viewport]')!
      .getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

/**
 * Rest the pointer inside one of the body's links, the way a reader does.
 *
 * Moved twice: a pointer already sitting still inside a link sends no events
 * at all, and the open countdown starts on a move that lands on one. Arriving
 * from outside is what produces that move.
 * @param page - The page.
 * @param index - Which link, from the start of the body.
 */
export async function restOnLink(page: Page, index: number): Promise<void> {
  // Travelled in steps, which is what a hand sends: a run of move samples
  // along the path, several of them inside the link. A single-step move
  // delivers one event for the whole journey — measured both ways in
  // `engineering/demo/2026-09-14-hover-open-without-motion.probe.spec.ts`.
  const box = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .nth(index)
    .boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(20, 20);
  await page.waitForTimeout(600);
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.move(x, y, { steps: 25 });
    await page.waitForTimeout(400);
    if ((await page.getByTestId('doc-link-toolbar').count()) > 0) return;
    await page.mouse.move(20, 20);
    await page.waitForTimeout(400);
  }
}

/**
 * The address the body's first link carries as the document stands.
 * @param p - The page.
 * @returns The address.
 */
export async function firstLinkHref(p: Page): Promise<string> {
  return p.evaluate(
    () =>
      document
        .querySelector('[data-testid="document-space"] .ProseMirror a')
        ?.getAttribute('href') ?? '',
  );
}

/**
 * Park the pointer AND the caret clear of every link, then wait for the
 * toolbar to go.
 *
 * The close delay has to elapse as well: it is counted from the moment the
 * pointer leaves, and a case that moves back onto a link inside that window is
 * measuring a toolbar that never went away.
 *
 * The caret matters just as much: a caret inside a link raises the toolbar by
 * itself, with no delay to wait out and nothing the pointer can do about it —
 * every case here would then be measuring the caret route. The third line
 * carries no link, which is what it is for.
 * @param page - The page.
 */
export async function parkPointer(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page
    .locator('[data-testid="document-space"] .ProseMirror p')
    .nth(2)
    .click();
  // Collapse whatever that click produced. Two parks in a row press the same
  // point, and a second press inside the system's double-click interval is
  // counted as one multi-click, which selects the line rather than putting a
  // caret in it — measured: with the presses ~500ms apart the third paragraph
  // came back selected, with 300ms more between them it did not. An arrow key
  // collapses either outcome, and the click landed mid-paragraph so the caret
  // stays off the link on the line below.
  await page.keyboard.press('ArrowRight');
  await page.mouse.move(20, 20);
  // An empty selection as well: the toolbar stands aside for one that holds
  // text, both of its routes, so a selection still standing means no toolbar
  // can come up at all.
  await expect(page.getByTestId('doc-selection-bubble-bar')).not.toBeAttached({
    timeout: 8_000,
  });
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
  await page.waitForTimeout(400);
}

/**
 * A body of five paragraphs carrying four links, with the caret parked on the
 * line that holds none.
 *
 * The lines answer for the shapes a pointer meets: one plain link, one a
 * single character long, one far enough down that a toolbar over the first
 * cannot stand on it, and one long enough to wrap so the leading between its
 * two lines is a place a pointer can rest.
 * @param page - The page to build it in.
 */
export async function linkedDocument(page: Page): Promise<void> {
  await openFreshDocument(page);
  await page.keyboard.type('hover this');
  await page.keyboard.press('Enter');
  await page.keyboard.type('A');
  await page.keyboard.press('Enter');
  await page.keyboard.type('and a line the caret can rest on');
  await page.keyboard.press('Enter');
  await page.keyboard.type('far target');
  await page.keyboard.press('Enter');
  await page.keyboard.type(
    'a link long enough that the body column has to break it across two '
    + 'lines so the leading between them is a place a pointer can rest',
  );

  await selectParagraph(page, 0);
  await linkTheSelection(page, HOVERED);
  await collapseAfterLinking(page);
  // Confirming leaves the caret in the link it just wrote, so the toolbar is
  // up over it — correctly, by the caret route — and it covers the line
  // below. Escape takes it away before the next line is reached for.
  await parkPointer(page);

  await selectParagraph(page, 1);
  await linkTheSelection(page, ONE_CHAR);
  await collapseAfterLinking(page);
  await parkPointer(page);

  await selectParagraph(page, 3);
  await linkTheSelection(page, FAR);
  await collapseAfterLinking(page);
  await parkPointer(page);

  await selectParagraph(page, 4);
  await linkTheSelection(page, WRAPPED);
  await collapseAfterLinking(page);
  await parkPointer(page);

  // A link the caret is in outranks one the pointer is over, so the caret
  // ends on the line that holds no link — otherwise every case would measure
  // the caret route.
  await selectParagraph(page, 2);
  await page.keyboard.press('ArrowRight');
  await parkPointer(page);
}
