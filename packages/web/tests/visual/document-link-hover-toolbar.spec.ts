// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The link toolbar a resting pointer raises (A1 to A5, D2).
 *
 * Driven by a real pointer over real link rectangles, which is what jsdom
 * cannot give: the open countdown starts on a move that lands inside a link,
 * and the hit test is geometry.
 *
 * Each case builds its own body. The cases used to share one, where three of
 * them rewrote an address the ones after them read back.
 *
 * Needs dev running and a smoke account:
 *   pnpm --filter @breatic/web test:visual
 */
import { test, expect } from 'playwright/test';

import {
  FAR,
  HOVERED,
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS,
  ONE_CHAR,
  firstLinkHref,
  linkedDocument,
  parkPointer,
  restOnLink,
} from '../helpers/link-panel';

test.beforeEach(async ({ page }) => {
  test.setTimeout(240_000);
  await linkedDocument(page);
});

test('comes up once the pointer rests on a link', async ({ page }) => {
  // Acceptance A1, the reader's own words: "鼠标放在上面，延迟一下就把工具条
  // 显示出来". What only a real pointer reaches is the geometry — the
  // coordinates resolved to a position, and the rectangle hit test. The
  // delay itself is the toolbar's own timer, and jsdom pins it.
  await restOnLink(page, 0);

  await expect(page.getByTestId('doc-link-toolbar')).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByTestId('doc-link-url')).toHaveText(HOVERED);
  await expect(page.getByTestId('doc-link-edit')).toBeVisible();
  await expect(page.getByTestId('doc-link-remove')).toBeVisible();
});

test('waits before it shows', async ({ page }) => {
  // The other half of A1: without the delay the toolbar flashes up under a
  // pointer that was only crossing the link on its way somewhere else.
  //
  // The landing is inline rather than through `restOnLink`, because the
  // reading has to be taken from the moment the pointer arrives — and that
  // helper returns only once the toolbar IS up. What is read is the address
  // shown, not the element: the popover leaves a closing snapshot on screen
  // for the length of its own fade.
  const box = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .first()
    .boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  let shown = false;
  for (let i = 0; i < 4 && !shown; i += 1) {
    await page.mouse.move(20, 20);
    await page.waitForTimeout(600);
    await page.mouse.move(x, y);
    await page.waitForTimeout(40);

    expect(await page.getByTestId('doc-link-url').count()).toBe(0);
    shown = await page
      .getByTestId('doc-link-url')
      .waitFor({ timeout: 2_000 })
      .then(
        () => true,
        () => false,
      );
  }
  expect(shown).toBe(true);
});

test('survives the trip from the link to itself', async ({ page }) => {
  // Acceptance A2, and WCAG 2.2 SC 1.4.13 Hoverable: what appears on hover
  // has to be reachable with the same pointer.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-edit')).toBeVisible({
    timeout: 5_000,
  });

  const box = (await page.getByTestId('doc-link-toolbar').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);

  await expect(page.getByTestId('doc-link-edit')).toBeVisible();
});

test('stays while the pointer rests on the link', async ({ page }) => {
  // Acceptance A5, and WCAG 2.2 SC 1.4.13 Persistent: it does not time out
  // from under a reader who is still reading it.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });

  await page.waitForTimeout(2_500);

  await expect(page.getByTestId('doc-link-url')).toBeVisible();
});

test('goes once the pointer leaves both', async ({ page }) => {
  // Acceptance A3.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });

  await page.mouse.move(20, 20);

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('goes on Escape without the pointer moving', async ({ page }) => {
  // Acceptance A4, and WCAG 2.2 SC 1.4.13 Dismissable.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });

  await page.keyboard.press('Escape');

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('goes after it was taken from under the pointer once already', async ({ page }) => {
  // What says the pointer is on the toolbar is set by an enter and cleared
  // by a leave, and a leave cannot arrive for an element that is gone:
  // Escape takes the toolbar out from under the pointer without one. A
  // record left standing there refuses every close for the rest of the
  // session, and only the second trip shows it — the first one closes fine.
  await restOnLink(page, 0);
  const box = (await page.getByTestId('doc-link-toolbar').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('doc-link-edit')).toBeVisible({
    timeout: 5_000,
  });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });
  await page.mouse.move(20, 20);

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('stays away while the pointer rests where no link is drawn', async ({ page }) => {
  // What the hit test is for. `posAtCoords` answers with the position
  // NEAREST the coordinates, not the one under them, so on its own it hands
  // back a link for a pointer that is only beside one — and the toolbar
  // would come up over a link the reader is not pointing at.
  const body = (await page
    .locator('[data-testid="document-space"] .ProseMirror')
    .boundingBox())!;
  const first = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .nth(0)
    .boundingBox())!;
  const second = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .nth(1)
    .boundingBox())!;
  // The wrapping link is drawn as one box per line; the leading is between
  // them. Read rather than assumed: a build that stopped wrapping it would
  // leave this case measuring nothing.
  const lines = await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .last()
    .evaluate((el) =>
      [...el.getClientRects()].map((r) => ({ top: r.top, bottom: r.bottom, left: r.left })));
  expect(lines.length, 'the long link has to wrap for this to mean anything')
    .toBeGreaterThan(1);
  // Inside one link there is no gap to rest in: what the hit test reads is a
  // DOM Range's rectangles, and those cover the whole line box rather than
  // the text box, so the leading between two lines of one link belongs to
  // it. Recorded rather than assumed — a build where they stopped touching
  // would put a hole in the middle of a wrapped link.
  expect(
    lines[1]!.top - lines[0]!.bottom,
    'two lines of one link leave no gap between them',
  ).toBeLessThanOrEqual(0.5);
  const blockGap = second.y - (first.y + first.height);
  expect(blockGap, 'two blocks have to be apart for this to mean anything')
    .toBeGreaterThan(2);

  const spots: [string, number, number][] = [
    [
      'the gap between two blocks',
      first.x + 8,
      first.y + first.height + blockGap / 2,
    ],
    [
      'the margin past the end of a line',
      body.x + body.width - 6,
      first.y + first.height / 2,
    ],
    ['the editor own padding above the first block', body.x + body.width / 2, body.y + 2],
  ];

  for (const [what, x, y] of spots) {
    await page.mouse.move(20, 20);
    await page.waitForTimeout(400);
    await page.mouse.move(x, y, { steps: 10 });
    await page.waitForTimeout(600);
    expect(await page.getByTestId('doc-link-toolbar').count(), what).toBe(0);
  }
});

test('survives a diagonal trip to either corner of itself', async ({ page }) => {
  // The travel `safePolygon` used to cover. The link and the toolbar are 8px
  // apart, and a pointer crossing that gap leaves the body — so the close is
  // armed and has to still be running when the toolbar is reached. Both
  // corners, because the diagonal to the far one is the longer crossing.
  for (const corner of ['left', 'right'] as const) {
    await parkPointer(page);
    await restOnLink(page, 0);
    const bar = (await page.getByTestId('doc-link-toolbar').boundingBox())!;
    const x = corner === 'left' ? bar.x + 4 : bar.x + bar.width - 4;

    await page.mouse.move(x, bar.y + bar.height / 2, { steps: 12 });
    await page.waitForTimeout(600);

    expect(
      await page.getByTestId('doc-link-edit').count(),
      `the trip to the ${corner} corner`,
    ).toBe(1);
  }
});

test('goes when the pointer leaves the toolbar itself', async ({ page }) => {
  // The third place a close is armed from. Leaving the toolbar is not
  // leaving the link, and neither event on its own means the pointer is on
  // nothing — what the delay lands on is what decides.
  await restOnLink(page, 0);
  const bar = (await page.getByTestId('doc-link-toolbar').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await expect(page.getByTestId('doc-link-edit')).toBeVisible({
    timeout: 5_000,
  });

  await page.mouse.move(bar.x + bar.width / 2, bar.y - 80);

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('comes up over a link one character long', async ({ page }) => {
  // A1 for the narrowest link there is. BlockNote probes one character into
  // the anchor, which on a one-character link is its end boundary, and the
  // link mark is `inclusive: false` — so the marks at that position dropped
  // it and neither route reached such a link at all.
  await restOnLink(page, 1);

  await expect(page.getByTestId('doc-link-url')).toHaveText(ONE_CHAR, {
    timeout: 5_000,
  });
});

test('opens the field over a link one character long', async ({ page }) => {
  // D1 for the narrowest link there is. Such a run is nothing but its two
  // boundaries, and the link mark is `inclusive: false` — every way of
  // asking the marks at a position answered with nothing, so pressing edit
  // took the whole toolbar off the screen.
  await restOnLink(page, 1);
  await expect(page.getByTestId('doc-link-url')).toHaveText(ONE_CHAR, {
    timeout: 5_000,
  });

  await page.getByTestId('doc-link-edit').click();

  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByTestId('doc-link-input')).toHaveValue(ONE_CHAR);
});

test('takes the whole toolbar away on Escape out of the field', async ({ page }) => {
  // D2b. Escape reaching our code at all is the browser-only part of this:
  // floating-ui's own dismiss
  // hears the key first, in the capture phase, and calls
  // `event.stopPropagation()` unless it is told the key may bubble
  // (`floating-ui.react.mjs:2628-2629`, `bubbles` defaulting to false), so
  // the toolbar's own listener never saw it — and floating-ui's dismissal
  // itself is dropped while the position is frozen. Escape did nothing at
  // all. jsdom drives neither, which is why only a real browser says so.
  await restOnLink(page, 0);
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });

  await page.keyboard.press('Escape');

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('goes on a press outside while it shows the address', async ({ page }) => {
  // `click-outside` × `read`. The press lands where no link is, so nothing
  // raises the toolbar again either.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });

  await page.getByTestId('top-bar').click({ position: { x: 4, y: 4 } });

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('stands aside the moment the selection holds text', async ({ page }) => {
  // `hover-entry-yields` × `read`. The selection is made from the keyboard
  // so the pointer never leaves the link: what takes the toolbar away is
  // the yield, not a hover-leave. Two floating controls over one piece of
  // text is what the yield exists to prevent.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });

  await page.keyboard.press('Shift+ArrowRight');

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
  await expect(page.getByTestId('doc-selection-bubble-bar')).toBeAttached();
});

test('keeps its target while the pointer sweeps another link', async ({ page }) => {
  // `hover-dwell` × `form`. A pointer crossing the body while the field is
  // open would otherwise move the toolbar to whatever it passes over —
  // taking the address being typed with it.
  await restOnLink(page, 0);
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });

  // The field's contents are its own state and would survive the target
  // moving underneath it. Where the toolbar is drawn would not: it is
  // measured from the held link, so its box is what says the target held.
  const before = (await page.getByTestId('doc-link-toolbar').boundingBox())!;

  // `hover` rather than a bare pointer move: it refuses to act on an
  // element something else is covering, so a toolbar drawn over the link
  // this case sweeps says so instead of passing for the wrong reason.
  await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .nth(2)
    .hover();
  await page.waitForTimeout(800);

  const after = (await page.getByTestId('doc-link-toolbar').boundingBox())!;
  expect(Math.round(after.y)).toBe(Math.round(before.y));
  expect(Math.round(after.x)).toBe(Math.round(before.x));
});

test('opens the address and goes when its link is pressed', async ({ page }) => {
  // `click-link` × `read`. Both halves, and they have to happen in that
  // order: the press is an outside press now — no element stands for the
  // link for the inside check to name — so the toolbar goes on `pointerdown`
  // while the `click` behind it still reaches the handler that opens the
  // address. The toolbar staying away afterwards is the second half: the
  // press leaves the caret inside the link, which is a standing reason to
  // raise it again.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });

  const [opened] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 10_000 }),
    page
      .locator('[data-testid="document-space"] .ProseMirror a')
      .first()
      .click({ position: { x: 6, y: 8 } }),
  ]);
  // A page opening is the whole reading taken here. `a.example` resolves
  // nowhere, so the tab settles on `chrome-error://chromewebdata/`, and
  // which address was asked for is pinned by `link: pressing a link in the
  // body opens it in a new tab` in tests/smoke, which spies on `window.open`.
  await opened.close();

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('comes back when the pointer leaves the link and returns to it', async ({ page }) => {
  // The other half of the press: what was dismissed is one link, and
  // reaching it again is a fresh ask. Nothing happens while the pointer sits
  // still on the link it just pressed, which is what the reader wants of a
  // press — the toolbar does not spring back over the tab they opened.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });
  const [opened] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 10_000 }),
    page
      .locator('[data-testid="document-space"] .ProseMirror a')
      .first()
      .click({ position: { x: 6, y: 8 } }),
  ]);
  await opened.close();
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  await restOnLink(page, 0);

  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });
});

test('takes the field away when its link is pressed', async ({ page }) => {
  // `click-link` × `form`. A press in the body is a press outside whichever
  // face is showing, and an address half typed goes with it — the same as
  // pressing anywhere else outside. The address still opens.
  await restOnLink(page, 0);
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });

  const [opened] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 10_000 }),
    page
      .locator('[data-testid="document-space"] .ProseMirror a')
      .first()
      .click({ position: { x: 6, y: 8 } }),
  ]);
  // A page opening is the whole reading taken here. `a.example` resolves
  // nowhere, so the tab settles on `chrome-error://chromewebdata/`, and
  // which address was asked for is pinned by `link: pressing a link in the
  // body opens it in a new tab` in tests/smoke, which spies on `window.open`.
  await opened.close();

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('goes on Escape when the pointer left while the field was up', async ({ page }) => {
  // The hand is off the link by the time the key is reached for, which is
  // the case D2b was written from. Only a real pointer says so: while the
  // field is up the library's listeners answer to the field, so the leave
  // has to be remembered rather than asked for afterwards.
  await restOnLink(page, 0);
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });
  const plain = (await page
    .locator('[data-testid="document-space"] .ProseMirror p')
    .nth(2)
    .boundingBox())!;
  await page.mouse.move(plain.x + plain.width / 2, plain.y + plain.height / 2);
  await page.waitForTimeout(1_200);
  // The field is still there: the pointer leaving does not take it. What
  // Escape does to it is the subject, so this has to hold first.
  await expect(page.getByTestId('doc-link-input')).toBeVisible();

  await page.keyboard.press('Escape');

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('puts the open field away on a press outside', async ({ page }) => {
  // `click-outside` × `form`. Not a step back to the address: the press has
  // taken the pointer off the link the toolbar hangs from, and a toolbar
  // left over a link nobody points at has nothing to close it.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-edit')).toBeVisible({
    timeout: 5_000,
  });
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible();

  // The top bar: outside the editable surface, so the press changes no
  // selection and nothing but the toolbar's own listener can answer it.
  await page.getByTestId('top-bar').click({ position: { x: 4, y: 4 } });

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('goes on Enter with the pointer parked away', async ({ page }) => {
  // D2 by the keyboard. The hand is off the screen as far as this reader is
  // concerned, which is the case the reporter had in mind: standing the
  // toolbar back up to report the write would be talking to nobody.
  await restOnLink(page, 0);
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });
  const bar = (await page.getByTestId('doc-link-toolbar').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y - 120);
  await page.waitForTimeout(600);
  await page.getByTestId('doc-link-input').fill('a.example/by-keyboard');

  await page.keyboard.press('Enter');

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
  expect(await firstLinkHref(page)).toBe('https://a.example/by-keyboard');
});

test('goes on Escape with the pointer back on the toolbar', async ({ page }) => {
  // D2b holds wherever the hand is. The reader answering the field ends the
  // round, and a hand that wandered off and came back does not keep it.
  await restOnLink(page, 0);
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });
  const bar = (await page.getByTestId('doc-link-toolbar').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y - 120);
  await page.waitForTimeout(600);
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.waitForTimeout(200);

  await page.keyboard.press('Escape');

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
});

test('keeps the open field when the pointer crosses the link on its way out', async ({ page }) => {
  // `hover-leave` × `form` again, by the route the library reports as
  // `safe-polygon` rather than `hover`: the toolbar sits 8px above the link,
  // so a pointer leaving downwards crosses the link itself.
  await restOnLink(page, 0);
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });
  await page.getByTestId('doc-link-input').fill('https://typed.example');

  const link = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .first()
    .boundingBox())!;
  await page.mouse.move(link.x + link.width / 2, link.y + link.height / 2);
  await page.mouse.move(20, 20);
  await page.waitForTimeout(1_500);

  await expect(page.getByTestId('doc-link-input')).toHaveValue(
    'https://typed.example',
  );
});

test('leaves the focus where the reader put it when Escape takes it away', async ({ page }) => {
  // The toolbar the pointer raised is not necessarily what the reader is
  // working in: the chat composer sits beside the body, and Escape is the
  // gesture for dismissing the toolbar. Taking the focus on the way out puts
  // the next keystrokes into the shared document.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });
  await page.getByTestId('chat-composer-textarea').focus();
  await page.waitForTimeout(200);

  await page.keyboard.press('Escape');

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
  await expect(page.getByTestId('chat-composer-textarea')).toBeFocused();
});

test('goes on a confirm, having written the address', async ({ page }) => {
  // D2 on the route the task exists for: the address lands on the link and
  // the round ends. Last in this group: it is the one case that changes the
  // document.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-edit')).toBeVisible({
    timeout: 5_000,
  });

  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible();
  await page.getByTestId('doc-link-input').fill('a.example/after');
  await page.getByTestId('doc-link-confirm').click();

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
  await expect(
    page.evaluate(
      () =>
        document
          .querySelector('[data-testid="document-space"] .ProseMirror a')
          ?.getAttribute('href') ?? '',
    ),
  ).resolves.toBe('https://a.example/after');
});

test('comes up with the pointer on the trailing edge of a link', async ({ page }) => {
  // A1 over the last half of a link's last glyph, which is still underlined
  // blue text. `posAtCoords` answers with an insertion point, so that half
  // resolves to the position AFTER the link; asked only ahead of it, the
  // answer is the character that follows the link. Measured before the fix:
  // one pixel inside the right edge raised nothing, and a glyph further in
  // raised it — every link's trailing edge flickered.
  const edge = await page.evaluate(() => {
    const rect = document
      .querySelectorAll('[data-testid="document-space"] .ProseMirror a')[0]!
      .getClientRects()[0]!;
    return { x: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(20, 20);
  await page.waitForTimeout(400);
  await page.mouse.move(edge.x, edge.y, { steps: 25 });

  // Whatever address the first link carries by now: the cases before this
  // one in the group write to it, and what this one is about is which link
  // the pointer lands on.
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    await firstLinkHref(page),
    { timeout: 5_000 },
  );
});

test('stays while the pointer slides to the trailing edge of its link', async ({ page }) => {
  // A5 on the same band: the toolbar going away under a pointer that has not
  // left the link is the one thing the close delay exists to prevent.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });
  const edge = await page.evaluate(() => {
    const rect = document
      .querySelectorAll('[data-testid="document-space"] .ProseMirror a')[0]!
      .getClientRects()[0]!;
    return { x: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(edge.x, edge.y, { steps: 8 });
  await page.waitForTimeout(HOVER_CLOSE_DELAY_MS + 400);

  await expect(page.getByTestId('doc-link-toolbar')).toBeVisible();
});

test('stays away when the pointer twitches after Escape', async ({ page }) => {
  // A4 again, with the pointer where the reader left it. A resting hand on a
  // trackpad emits moves of its own, and the dismissal is about a link
  // rather than about the pointer holding perfectly still: measured before
  // the fix, a one-pixel move put the toolbar straight back.
  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toBeVisible({
    timeout: 5_000,
  });
  const box = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .first()
    .boundingBox())!;
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
  await page.waitForTimeout(HOVER_OPEN_DELAY_MS + 500);

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached();
});

test('gives a second link a delay of its own', async ({ page }) => {
  // The delay is what keeps the toolbar off a link the reader is sweeping
  // across. A countdown left running from the link before it is spent on
  // this one: measured before the fix, 85ms on the first link and 40ms on
  // the second was enough to raise the second one's toolbar.
  const first = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .nth(0)
    .boundingBox())!;
  const second = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .nth(2)
    .boundingBox())!;
  await page.mouse.move(20, 20);
  await page.waitForTimeout(400);
  await page.mouse.move(
    first.x + first.width / 2,
    first.y + first.height / 2,
    { steps: 20 },
  );
  await page.waitForTimeout(HOVER_OPEN_DELAY_MS - 15);
  await page.mouse.move(
    second.x + second.width / 2,
    second.y + second.height / 2,
  );
  await page.waitForTimeout(40);

  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached();
});

test('keeps the link under the pointer after a flick across another', async ({ page }) => {
  // A countdown armed for the link the pointer brushed past has to end when
  // the pointer arrives somewhere else. Measured before the fix: a flick
  // onto the third link and straight back re-pointed the toolbar at the
  // third one while the pointer rested on the first, so pressing Remove
  // would have stripped a link the reader never pointed at.
  await restOnLink(page, 0);
  // Whatever address the first link carries by now: cases before this one
  // in the group write to it, and this one is about which link is held.
  const held = await firstLinkHref(page);
  await expect(page.getByTestId('doc-link-url')).toHaveText(held, {
    timeout: 5_000,
  });
  const here = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .nth(0)
    .boundingBox())!;
  const other = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .nth(2)
    .boundingBox())!;
  await page.mouse.move(other.x + other.width / 2, other.y + other.height / 2);
  await page.waitForTimeout(20);
  await page.mouse.move(here.x + here.width / 2, here.y + here.height / 2);
  await page.waitForTimeout(HOVER_OPEN_DELAY_MS + 500);

  await expect(page.getByTestId('doc-link-url')).toHaveText(held);
});

test('keeps the caret its link when the pointer lets go of another', async ({ page }) => {
  // A6 does not depend on the pointer. One hold with one route means a
  // pointer that took the toolbar to another link takes it away for good
  // when it leaves, while the caret is still sitting in the first one and
  // nothing asks again until the reader types.
  await page
    .locator('[data-testid="document-space"] .ProseMirror p')
    .nth(0)
    .click({ clickCount: 3 });
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.mouse.move(20, 20);
  const caretsLink = await firstLinkHref(page);
  await expect(page.getByTestId('doc-link-url')).toHaveText(caretsLink, {
    timeout: 8_000,
  });

  await restOnLink(page, 2);
  await expect(page.getByTestId('doc-link-url')).toHaveText(FAR, {
    timeout: 5_000,
  });
  await page.mouse.move(20, 20, { steps: 20 });
  await page.waitForTimeout(HOVER_CLOSE_DELAY_MS + 600);

  await expect(page.getByTestId('doc-link-url')).toHaveText(caretsLink);
});

test('comes back over a link whose address it just rewrote', async ({ page }) => {
  // Writing an address gives the run a different mark, and ProseMirror
  // throws away the element it was drawn as. A toolbar holding that element
  // pointed at nothing from then on: the reader moved off the link, came
  // back, and nothing came up. A position is what it holds, so this takes
  // the whole trip — write, leave, return. It runs last in this block
  // because it leaves the first link carrying an address of its own.
  await restOnLink(page, 0);
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({
    timeout: 5_000,
  });
  await page.getByTestId('doc-link-input').fill('a.example/rewritten');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  await parkPointer(page);
  await restOnLink(page, 0);

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/rewritten',
    { timeout: 5_000 },
  );
});
