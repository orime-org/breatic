// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Where the link panel and the link toolbar are drawn, and what they carry.
 *
 * The panel hangs inside the body's scroller against the link or selection it
 * acts on, so every reading here is a distance between two rectangles — which
 * only a real browser has.
 *
 * Needs dev running and a smoke account:
 *   pnpm --filter @breatic/web test:visual
 */
import { test, expect } from 'playwright/test';

import {
  openFreshDocument,
  scrollBodyTo,
  selectFirstParagraph,
  selectParagraph,
  typeLongBody,
} from '../helpers/bubble-bar';
import {
  HOVER_CLOSE_DELAY_MS,
  HOVER_OPEN_DELAY_MS,
  bodyView,
  collapseAfterLinking,
  drawnSelectionBox,
  expectPanelMeetsTargetInColumn,
  linkTheSelection,
  openViewOverFirstLink,
  panelAgainst,
  panelBox,
  parkPointer,
  restOnLink,
  settlePanelUnder,
} from '../helpers/link-panel';
import { STATE_FILE } from '../helpers/project';

test('link: an address with a space in the host leaves confirm dimmed', async ({ page }) => {
  // Only a real browser answers this. The check rests on the URL parser, and
  // the two runtimes treat `https://hello world` in opposite ways: Node's
  // throws (that is the one jsdom runs), a browser's accepts it and encodes
  // the space into the host as `hello%20world` — measured in Chromium. So the
  // unit case of the same name is green for a reason other than what happens
  // in front of a user.
  await openFreshDocument(page);
  await page.keyboard.type('link me');
  await selectFirstParagraph(page);

  await page.getByTestId('doc-bubble-tool-link').click();
  const input = page.getByTestId('doc-link-input');
  const confirm = page.getByTestId('doc-link-confirm');
  await expect(input).toBeVisible({ timeout: 5_000 });

  // Light it once first. Without this line the assertion below is green even
  // against an implementation whose button never lights at all.
  await input.fill('a.example');
  await expect(confirm).toBeEnabled();

  await input.fill('hello world');
  await expect(confirm).toBeDisabled();

  // The press has to state a reason, which is the whole point of the button
  // carrying `aria-disabled`. Clicked at window coordinates, which is the path
  // where the browser runs a real hit-test — `confirm.click()` first waits for
  // the element to become enabled, and enabled is the one thing it never is.
  const box = await confirm.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByTestId('doc-link-invalid')).toBeVisible({ timeout: 5_000 });
  await expect(input).toHaveAttribute('aria-invalid', 'true');

  // The red edge the demo's fourth state draws, which `Input` gives the field
  // from that attribute. Compared against the message's own colour rather than
  // a literal, since both come from `--color-status-error-foreground` and the
  // two themes give it different values. Polled: the field carries
  // `transition-colors`, and on the frame the message appears it is still part
  // way there — measured mid-transition at a grey nowhere near the settled red.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const edge = getComputedStyle(
          document.querySelector('[data-testid="doc-link-input"]')!,
        ).borderTopColor;
        const message = getComputedStyle(
          document.querySelector('[data-testid="doc-link-invalid"]')!,
        ).color;
        return `${edge} | ${message}`;
      }),
    )
    .toMatch(/^(rgba?\([^)]+\)) \| \1$/);
});

test('link: the panel sits against the link it acts on', async ({ page }) => {
  // Nothing has ever measured where this panel lands. The unit suite cannot:
  // every rectangle in jsdom is zero. Measured before this assertion existed,
  // the panel was drawn at the top-left corner of the window while its link sat
  // 616px to the right — its reference was a button the bubble-menu plugin had
  // already taken out of the document, so every rectangle it offered was zero.
  await openFreshDocument(page);
  await page.keyboard.type('one two three four five six seven eight');
  await selectFirstParagraph(page);

  await linkTheSelection(page, 'a.example/anchored');
  await openViewOverFirstLink(page);

  // `placement: 'bottom-start'` puts the two left edges on top of each other,
  // 8px apart — the same edge the toolbar over this link stands on, so the two
  // faces of one control never slide sideways. A reference holding a degenerate
  // rectangle lands the panel hundreds of pixels away, which is what these
  // numbers read.
  const link = await page.evaluate(() => {
    const r = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom };
  });
  expect(Math.abs((await settlePanelUnder(page, link)).leftOffset)).toBeLessThan(2);
});

test('link: the panel travels with its link when the body scrolls', async ({ page }) => {
  // The panel is placed in the scrolled content's own coordinates, so the
  // scroll carries it along with the line it sits under. Measured against an
  // earlier build that placed it against the window: the link moved 260px and
  // the panel moved 7. Measured again with `shift` allowed to work vertically:
  // the link left the visible area and the panel stayed pinned to its top edge,
  // 142px away from the text it belongs to.
  await openFreshDocument(page);
  await typeLongBody(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await selectParagraph(page, 0);

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('doc-link-input').fill('a.example/scrolls');
  await page.getByTestId('doc-link-confirm').click();

  // Dragging over the link is the shape that opens `view`. A `Mod-a` here
  // would not: this paragraph holds nothing but the link, so the first tier is
  // already satisfied and the press promotes straight to the document tier,
  // where the bar carries no link button.
  await openViewOverFirstLink(page);
  await page.waitForTimeout(400);

  const gap = () =>
    page.evaluate(() => {
      const panel = document
        .querySelector('[data-testid="doc-link-popover"]')!
        .getBoundingClientRect();
      const link = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
      return { gapBelow: panel.top - link.bottom, linkTop: link.top };
    });

  const before = await gap();
  await scrollBodyTo(page, 200);
  const after = await gap();

  // The link really did move under the panel.
  expect(before.linkTop - after.linkTop).toBeGreaterThan(150);
  // And the panel kept its place against it.
  expect(Math.abs(after.gapBelow - before.gapBelow)).toBeLessThan(3);
});

test('link: scrolling the target away clips the panel and keeps the draft', async ({ page }) => {
  // The reason the panel hangs inside the scroller. Being clipped by an
  // ancestor's overflow is not the same as being hidden: `visibility: hidden`
  // makes the browser take focus away, and an address half typed into a field
  // that has lost focus is lost silently. Measured in Chromium: a clipped
  // field keeps focus and keeps its value, and the caret carries on where it
  // was when the reader scrolls back.
  await openFreshDocument(page);
  await typeLongBody(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await selectParagraph(page, 0);

  await page.getByTestId('doc-bubble-tool-link').click();
  const input = page.getByTestId('doc-link-input');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await page.keyboard.type('a.example/half');
  await expect(input).toBeFocused();

  const placement = () =>
    page.evaluate(() => {
      const panel = document
        .querySelector('[data-testid="doc-link-popover"]')!
        .getBoundingClientRect();
      const view = document
        .querySelector('[data-testid="document-space"] .ProseMirror')!
        .closest('[data-radix-scroll-area-viewport]')!
        .getBoundingClientRect();
      // Where the panel's own centre lands answers the question the rectangle
      // cannot: a box above the body's box is equally true of a panel plainly
      // visible over the tab strip, and being clipped rather than merely
      // elsewhere is the whole reason it is portalled into the scroller.
      const centre = document.elementFromPoint(
        Math.round(panel.left + panel.width / 2),
        Math.round(panel.top + panel.height / 2),
      );
      const el = document.querySelector('[data-testid="doc-link-popover"]')!;
      return {
        aboveTheBody: panel.bottom < view.top,
        insideTheBody: panel.top >= view.top && panel.bottom <= view.bottom,
        reachableAtItsCentre: centre !== null && el.contains(centre),
      };
    });

  const onOpen = await placement();
  expect(onOpen.insideTheBody).toBe(true);
  expect(onOpen.reachableAtItsCentre).toBe(true);

  await scrollBodyTo(page, 400);
  const scrolledAway = await placement();
  expect(scrolledAway.aboveTheBody).toBe(true);
  // Clipped, so nothing of it is at its own centre any more.
  expect(scrolledAway.reachableAtItsCentre).toBe(false);
  // Out of sight, and still holding everything the reader put into it.
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('a.example/half');

  // Typing carries on into the field nobody can see, rather than into the body.
  await page.keyboard.type('-more');
  await expect(input).toHaveValue('a.example/half-more');

  await scrollBodyTo(page, 0);
  expect((await placement()).insideTheBody).toBe(true);
  await expect(input).toHaveValue('a.example/half-more');
});

test('link: the bar steps aside for the panel and stays away after it', async ({ page }) => {
  // Two rules in one pass, because they are one pass for the reader: the bar
  // goes as the panel opens, and it does not come back when the panel closes,
  // because closing drops the selection. Held rather than caught mid-flight —
  // the bar has a 250ms debounce on selection changes, so a bar that is merely
  // recomputing is also briefly absent.
  await openFreshDocument(page);
  await page.keyboard.type('a line to link');
  await selectFirstParagraph(page);

  const bar = page.getByTestId('doc-selection-bubble-bar');
  const panel = page.getByTestId('doc-link-popover');

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(panel).toBeVisible({ timeout: 5_000 });
  await expect(bar).toBeHidden({ timeout: 5_000 });

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden({ timeout: 5_000 });
  await page.waitForTimeout(400);
  await expect(bar).toBeHidden();
  expect(
    await page.evaluate(() => {
      const selection = window.getSelection();
      return selection === null || selection.isCollapsed;
    }),
  ).toBe(true);
});

test('link: the panel is never drawn anywhere but against its target', async ({ page }) => {
  // floating-ui computes a position asynchronously, so the first paint puts
  // the panel at its own origin — measured at viewport top 80, left 320, while
  // the link sat at 616. What this pins is that no such frame is ever visible:
  // every frame carrying opacity is already beside the target.
  await openFreshDocument(page);
  await page.keyboard.type('a line to link');
  await selectFirstParagraph(page);

  await page.evaluate(() => {
    (window as unknown as { __frames: unknown[] }).__frames = [];
    const frames = (window as unknown as { __frames: unknown[] }).__frames;
    const observer = new MutationObserver(() => {
      const el = document.querySelector('[data-testid="doc-link-popover"]');
      if (!el) return;
      const box = el.getBoundingClientRect();
      frames.push({
        top: Math.round(box.top),
        left: Math.round(box.left),
        opacity: Number(getComputedStyle(el).opacity),
      });
      if (frames.length > 8) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  });

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeFocused({ timeout: 5_000 });
  await page.waitForTimeout(400);

  const measured = await page.evaluate(() => {
    const frames = (window as unknown as {
      __frames: { top: number; left: number; opacity: number }[];
    }).__frames;
    const line = document
      .querySelector('[data-testid="document-space"] .ProseMirror p')!
      .getBoundingClientRect();
    return { frames, lineBottom: Math.round(line.bottom) };
  });

  expect(measured.frames.length).toBeGreaterThan(1);
  // The library's origin was among them, and it was transparent when it was.
  expect(measured.frames[0]!.opacity).toBe(0);
  measured.frames
    .filter((frame) => frame.opacity > 0)
    .forEach((frame) => {
      expect(Math.abs(frame.top - measured.lineBottom)).toBeLessThan(20);
    });
});

test('link: opening lands in the field, closing hands the caret back', async ({ page }) => {
  // §8 puts this row in a browser: jsdom's focus handling is unreliable there.
  // Opening in `create` rests on `FloatingFocusManager`'s mount autofocus — the
  // panel has no focus call of its own for that state — and the bar
  // preventDefaults its own mousedown, so focus is still in the body at the
  // moment the panel opens. A failed autofocus would put the address the user
  // types into the document instead of the field. Closing hands focus back to
  // whatever held it before, which is the body.
  await openFreshDocument(page);
  await page.keyboard.type('focus me');
  await selectFirstParagraph(page);

  await page.getByTestId('doc-bubble-tool-link').click();
  const input = page.getByTestId('doc-link-input');
  await expect(input).toBeVisible({ timeout: 5_000 });
  await expect(input).toBeFocused();

  // Typing without clicking the field first: the characters have to arrive in
  // the panel, and the body has to be left as it was.
  await page.keyboard.type('a.example');
  await expect(input).toHaveValue('a.example');
  const bodyText = await page.evaluate(
    () =>
      document.querySelector('[data-testid="document-space"] .ProseMirror')
        ?.textContent ?? '',
  );
  expect(bodyText).toBe('focus me');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });
  await expect(
    page.locator('[data-testid="document-space"] .ProseMirror'),
  ).toBeFocused();
});

test('link: the toolbar comes up over the link the caret is in', async ({ page }) => {
  // Acceptance A6. The caret route — which is also where the reader is left
  // once a press has opened the address in the other tab.
  await openFreshDocument(page);
  await page.keyboard.type('reach this link');
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/caret');
  await collapseAfterLinking(page);

  // Walked in from the body's start rather than back from its end: confirming
  // an address leaves the caret at the start of the paragraph, and the first
  // character boundary of a link is not inside it as far as
  // `getLinkAtSelection` is concerned.
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  );
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('ArrowRight');
  }

  await expect(page.getByTestId('doc-link-toolbar')).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/caret',
  );

  // Pressing edit has to leave the toolbar standing. The toolbar stands aside
  // for a selection that holds text, so anything the press did to the document
  // selection would take it off the screen instead of showing the field — and
  // a press inside a live editor is exactly where a stray selection comes
  // from.
  await page.getByTestId('doc-link-edit').click();
  await expect(page.getByTestId('doc-link-toolbar')).toBeVisible();
  await expect(page.getByTestId('doc-link-input')).toHaveValue(
    'https://a.example/caret',
  );
  // Acceptance C4: and the link it acts on is drawn as selected.
  await expect(
    page
      .locator('[data-testid="document-space"] [data-show-selection]')
      .first(),
  ).toHaveText('reach this link');
});

test('link: a link in the body says it can be pressed', async ({ page }) => {
  // The press opens the address, so the pointer has to say the press does
  // something other than put the caret down. Inside an editable surface the
  // caret is the default, and it reads the same over a link as over the prose.
  await openFreshDocument(page);
  await page.keyboard.type('point at this link');
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/pointer');
  await collapseAfterLinking(page);

  await expect(
    page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector('[data-testid="document-space"] .ProseMirror a')!,
        ).cursor,
    ),
  ).resolves.toBe('pointer');
});

test('link: with no link under it the panel sits against the selected text', async ({ page }) => {
  // The other half of "the panel sits against what it acts on": in `create`
  // there is no link to measure, and the target is the selection itself.
  await openFreshDocument(page);
  await page.keyboard.type('nothing linked here yet');
  await selectFirstParagraph(page);

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });

  const selected = await drawnSelectionBox(page);
  expect(Math.abs((await settlePanelUnder(page, selected)).leftOffset)).toBeLessThan(2);
});

test('link: a target that wraps gets the panel under its last line', async ({ page }) => {
  // `inline()` reads the target's per-line rectangles. For a bottom placement it
  // takes the last of them, so a link running over two lines is met under the
  // line it ends on rather than under a box drawn around both (§4.1.2).
  //
  // The width is pinned because where the sentence breaks decides how long its
  // last line is, and a short last line near the column's left edge has the
  // panel held in by `shift` instead of centred. Run after a test that left the
  // window narrow, the centre came out 26px off.
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type(
    'this sentence is deliberately long enough that the body column has to break it over more than one line before it ends',
  );
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/wrapped');
  await openViewOverFirstLink(page);

  const lines = await page.evaluate(() => {
    const rects = [...document.querySelector('.ProseMirror a')!.getClientRects()];
    const last = rects[rects.length - 1]!;
    const first = rects[0]!;
    return {
      count: rects.length,
      first: { left: first.left, right: first.right, bottom: first.bottom },
      last: { left: last.left, right: last.right, bottom: last.bottom },
    };
  });

  // Without this the test would pass on a link that never wrapped.
  expect(lines.count).toBeGreaterThan(1);

  const placed = await settlePanelUnder(page, lines.last);
  const view = await bodyView(page);
  const panelWidth = await page.evaluate(
    () =>
      document.querySelector('[data-testid="doc-link-popover"]')!.getBoundingClientRect()
        .width,
  );
  // The premise of the next line: at this width the panel fits inside the
  // column when its left edge sits on the line's, so `shift` has nothing to do.
  expect(lines.last.left + panelWidth).toBeLessThan(view.right);
  expect(Math.abs(placed.leftOffset)).toBeLessThan(2);
  // And it is the last line specifically: the first one sits a line higher.
  expect((await panelAgainst(page, lines.first)).gapBelow).toBeGreaterThan(20);
});

test('link: a target at the bottom edge keeps the panel inside the body column', async ({ page }) => {
  // `shift`'s boundary is the body's visible area, so a panel that would hang
  // off the side of the column is pushed back into it (§4.1.2).
  //
  // The link is the tail of its line rather than the whole of it. A link that
  // covers a line is centred on the column, and a panel centred there stays
  // inside it whatever `shift` does — measured, dropping `shift` altogether
  // left every assertion here green.
  // Narrow enough that the panel cannot fit beside the line's end. The panel
  // has a maximum width of its own, so widening it is not a way to reach the
  // boundary — the visible area has to come down to meet it. Measured with
  // `shift` removed: the panel ran to 865 with the area ending at 760; with it
  // back, 760 exactly. At 1680 both readings are inside the area and the case
  // says nothing.
  await page.setViewportSize({ width: 760, height: 950 });
  await openFreshDocument(page);
  await typeLongBody(page);
  await scrollBodyTo(page, 0);
  await selectParagraph(page, 2);
  await page.keyboard.press('ArrowRight');
  for (let step = 0; step < 6; step += 1) {
    await page.keyboard.press('Shift+ArrowLeft');
  }
  await linkTheSelection(page, 'a.example/edge');
  await openViewOverFirstLink(page);

  // Bring that link down to the bottom edge, leaving part of the line showing.
  const view = await bodyView(page);
  const scroll = await page.evaluate(
    ([viewBottom]) => {
      const el = document.querySelector(
        '.doc-body-scroller [data-radix-scroll-area-viewport]',
      )!;
      const link = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
      return el.scrollTop + link.top - (viewBottom! - 10);
    },
    [view.bottom],
  );
  await scrollBodyTo(page, scroll);

  const placed = await page.evaluate(() => {
    const panel = document
      .querySelector('[data-testid="doc-link-popover"]')!
      .getBoundingClientRect();
    const link = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
    return {
      panelLeft: Math.round(panel.left),
      panelRight: Math.round(panel.right),
      linkLeft: Math.round(link.left),
      linkRight: Math.round(link.right),
      linkVisible: link.top >= 0,
    };
  });

  // The line really is at the edge rather than gone past it.
  expect(placed.linkVisible).toBe(true);
  expect(placed.panelLeft).toBeGreaterThanOrEqual(view.left);
  expect(placed.panelRight).toBeLessThanOrEqual(view.right);
  // Pushed, rather than fitting by luck. Every other case in this file has the
  // panel centred on its target; here it cannot be, and the distance is the
  // measurement that says `shift` did the work. Measured with `shift` removed:
  // the two centres were half a pixel apart and the panel ran to 865 past a
  // boundary ending at 760.
  const panelCentre = (placed.panelLeft + placed.panelRight) / 2;
  const linkCentre = (placed.linkLeft + placed.linkRight) / 2;
  expect(Math.abs(panelCentre - linkCentre)).toBeGreaterThan(20);
});

test('link: the panel still meets its target after the window changes width', async ({ page }) => {
  // A width change reflows the body, and `autoUpdate` watches for resize. The
  // link moves; the panel has to move with it.
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('resize around me');
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/resized');
  await openViewOverFirstLink(page);

  const linkBox = () =>
    page.evaluate(() => {
      const r = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
      return { left: r.left, right: r.right, bottom: r.bottom };
    });

  await settlePanelUnder(page, await linkBox());
  const wide = await linkBox();
  const panelWide = await panelBox(page);

  await page.setViewportSize({ width: 1100, height: 950 });
  await page.waitForTimeout(400);
  const narrow = await linkBox();
  const panelNarrow = await panelBox(page);

  // The reflow really did move the link, so the assertions below have something
  // to be wrong about.
  expect(Math.abs(narrow.left - wide.left)).toBeGreaterThan(50);
  // And the panel went with it. This is the assertion a reference holding a
  // rectangle it measured once would fail: the panel would sit where the link
  // used to be, and every check that reads only the vertical gap would still
  // pass, since a width change leaves a one-line paragraph at the same height.
  expect(Math.abs(panelNarrow.centre - panelWide.centre)).toBeGreaterThan(20);

  await expectPanelMeetsTargetInColumn(page, narrow);

  // The same event in `create`, which reaches the reference by a different
  // route: a Range over the selection rather than over a link (§5.3.1).
  await page.setViewportSize({ width: 1680, height: 950 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });
  await openFreshDocument(page);
  await page.keyboard.type('no link on this one');
  await selectFirstParagraph(page);

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });
  const beforeResize = await drawnSelectionBox(page);
  await settlePanelUnder(page, beforeResize);
  const panelCreateWide = await panelBox(page);

  await page.setViewportSize({ width: 1100, height: 950 });
  await page.waitForTimeout(400);
  const afterResize = await drawnSelectionBox(page);
  expect(Math.abs(afterResize.left - beforeResize.left)).toBeGreaterThan(50);
  expect(Math.abs((await panelBox(page)).centre - panelCreateWide.centre)).toBeGreaterThan(
    20,
  );
  await expectPanelMeetsTargetInColumn(page, afterResize);

  await page.setViewportSize({ width: 1680, height: 950 });
});

test('link: the panel keeps its place while a co-editor types', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('the paragraph a co-editor will grow');
  await page.keyboard.press('Enter');
  await page.keyboard.type('link me');
  await selectParagraph(page, 1);
  await linkTheSelection(page, 'a.example/coedited');
  await openViewOverFirstLink(page);

  const linkBox = () =>
    page.evaluate(() => {
      const r = document.querySelector('.ProseMirror a')!.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });
  const before = await linkBox();
  const settled = await settlePanelUnder(page, before);

  const projectUrl = page.url();
  const spaceTab = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid^="space-tab-"][aria-selected="true"]')!
        .getAttribute('data-testid')!,
  );

  const peer = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  try {
    const other = await peer.newPage();

    await other.goto(projectUrl);
    await other.getByTestId(spaceTab).click();
    const peerEditor = other.locator('[data-testid="document-space"] .ProseMirror');
    await expect(peerEditor).toBeVisible({ timeout: 15_000 });
    // The link A made has to have reached B before B edits around it.
    await expect(
      other.locator('[data-testid="document-space"] .ProseMirror a'),
    ).toBeVisible({ timeout: 15_000 });

    await other.locator('[data-testid="document-space"] .ProseMirror p').first().click();
    await other.keyboard.press('End');
    await other.keyboard.type(
      ' and here is a good deal more of it, enough that the paragraph has to take a second line and push everything below it down the page',
    );

    // The peer's text has to be in this document, and the line has to have
    // moved because of it rather than because a second reader arrived.
    await expect(
      page.locator('[data-testid="document-space"] .ProseMirror'),
    ).toContainText('push everything below it down the page', { timeout: 15_000 });
    await expect.poll(async () => (await linkBox()).top - before.top).toBeGreaterThan(20);
  } finally {
    await peer.close();
  }

  const after = await linkBox();
  const moved = await panelAgainst(page, after);
  expect(Math.abs(moved.gapBelow - settled.gapBelow)).toBeLessThan(1);
  expect(Math.abs(moved.leftOffset - settled.leftOffset)).toBeLessThan(2);
  // And the panel is the same one, still in view rather than reopened.
  await expect(page.getByTestId('doc-link-url')).toBeVisible();
});

test('link: the toolbar keeps its link while a co-editor styles it', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('plain linked');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowLeft');
  await linkTheSelection(page, 'a.example/styled');
  await collapseAfterLinking(page);
  // The caret sits in the link the confirm just wrote, which raises the
  // toolbar by the caret route. One line up takes it out and records nothing;
  // Escape would leave the caret where it is and write a dismissal, and a link
  // the reader dismissed with their caret inside it stays away from the hand.
  await page.keyboard.press('ArrowUp');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  const projectUrl = page.url();
  const spaceTab = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid^="space-tab-"][aria-selected="true"]')!
        .getAttribute('data-testid')!,
  );

  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/styled',
    { timeout: 5_000 },
  );
  const reach = async (): Promise<number> => {
    const bar = (await page.getByTestId('doc-link-toolbar').boundingBox())!;
    const link = (await page
      .locator('[data-testid="document-space"] .ProseMirror a')
      .first()
      .boundingBox())!;
    return link.y - (bar.y + bar.height);
  };
  const before = await reach();
  expect(before, 'the toolbar has to sit above its link to begin with')
    .toBeLessThan(20);

  const peer = await browser.newContext({
    viewport: { width: 1680, height: 950 },
  });
  try {
    const other = await peer.newPage();
    await other.goto(projectUrl);
    await other.getByTestId(spaceTab).click();
    await expect(
      other.locator('[data-testid="document-space"] .ProseMirror a'),
    ).toBeVisible({ timeout: 15_000 });

    // Reached from the plain text in front of it: pressing inside a link opens
    // the address, so there is no other way to take hold of part of one.
    await other
      .locator('[data-testid="document-space"] .ProseMirror p')
      .first()
      .click();
    // Presses that arrive before a click's focus lands are dropped, and the
    // selection is then empty when the style is asked for.
    await expect(
      other.locator('[data-testid="document-space"] .ProseMirror'),
    ).toBeFocused();
    await other.waitForTimeout(200);
    for (let i = 0; i < 9; i += 1) await other.keyboard.press('Shift+ArrowRight');
    await other.keyboard.press(
      process.platform === 'darwin' ? 'Meta+b' : 'Control+b',
    );

    await expect
      .poll(
        async () =>
          page.locator('[data-testid="document-space"] .ProseMirror strong').count(),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await peer.close();
  }

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/styled',
  );
  expect(Math.abs((await reach()) - before)).toBeLessThan(2);
});

test('link: the panel is built to the demo measurements', async ({ page }) => {
  // Every number here is measured off the demo's third section, which is the
  // spec for this panel: box 42 high, controls 28, the address line 21, and in
  // the refused state a 67-high box holding a 19-high message. `offsetHeight`
  // rather than a rectangle, so a transform mid-flight cannot read as a size.
  //
  // The box's own font size is left off: the demo sets 14 on it, every piece of
  // text in the panel carries its own size, and `--text-*` has no 14 rung.
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('measure me');
  await selectFirstParagraph(page);

  const sizes = () =>
    page.evaluate(() => {
      const el = (t: string) =>
        document.querySelector<HTMLElement>(`[data-testid="${t}"]`);
      const panel = el('doc-link-popover');
      return {
        panel: panel ? panel.offsetHeight : null,
        input: el('doc-link-input')?.offsetHeight ?? null,
        inputWidth: el('doc-link-input')?.offsetWidth ?? null,
        url: el('doc-link-url')?.offsetHeight ?? null,
        message: el('doc-link-invalid')?.offsetHeight ?? null,
        buttons: [...(panel?.querySelectorAll('button') ?? [])].map(
          (b) => (b as HTMLElement).offsetHeight,
        ),
      };
    });

  await page.getByTestId('doc-bubble-tool-link').click();
  await expect(page.getByTestId('doc-link-input')).toBeVisible({ timeout: 5_000 });
  const create = await sizes();
  expect(create).toMatchObject({
    panel: 42,
    input: 28,
    inputWidth: 250,
    buttons: [28],
  });

  await page.getByTestId('doc-link-input').fill('htp:/breatic');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-link-invalid')).toBeVisible({ timeout: 5_000 });
  expect(await sizes()).toMatchObject({ panel: 67, input: 28, message: 19 });

  await page.getByTestId('doc-link-input').fill('a.example/measured');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('doc-link-popover')).toBeHidden({ timeout: 5_000 });
  await openViewOverFirstLink(page);
  expect(await sizes()).toMatchObject({ panel: 42, url: 21, buttons: [28, 28] });
});

test('link: the pointer knows a link a style has split in two', async ({ page }) => {
  // BlockNote nests the link mark inside a style mark, so a style covering
  // part of a link draws it as sibling anchors — and none of them is the link.
  // The style goes on before the address, because pressing inside a link opens
  // it in a new tab now and there is no other way to reach part of one.
  await openFreshDocument(page);
  await page.keyboard.type('our ');
  const bold = process.platform === 'darwin' ? 'Meta+b' : 'Control+b';
  await page.keyboard.press(bold);
  await page.keyboard.type('docs');
  await page.keyboard.press(bold);
  await page.keyboard.type(' here');
  await page.keyboard.press('Enter');
  // Somewhere for the caret to rest that holds no link. The line above is
  // linked end to end, so it has no such place of its own, and a caret inside
  // a link is a standing reason for the toolbar.
  await page.keyboard.type('a plain line to rest on');
  await selectFirstParagraph(page);
  await linkTheSelection(page, 'a.example/split');
  await collapseAfterLinking(page);
  // The caret sits in the link the confirm just wrote, which raises the
  // toolbar by the caret route. One line down takes it out and records
  // nothing; one line up would not, because this link starts where its line
  // does. Escape would leave the caret where it is and write a dismissal, and
  // a link the reader dismissed with their caret inside it stays away from
  // the hand.
  await page.keyboard.press('ArrowDown');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
  const drawn = await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .count();
  expect(drawn, 'the style has to split the link for this to mean anything')
    .toBeGreaterThan(1);

  await restOnLink(page, drawn - 1);

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/split',
    { timeout: 5_000 },
  );
});

test('link: the toolbar opens against the link a co-editor just moved', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('a line with a target on it');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowLeft');
  await linkTheSelection(page, 'a.example/moved');
  await collapseAfterLinking(page);
  // The caret sits in the link the confirm just wrote, which raises the
  // toolbar by the caret route. One line up takes it out and records nothing;
  // Escape would leave the caret where it is and write a dismissal, and a link
  // the reader dismissed with their caret inside it stays away from the hand.
  await page.keyboard.press('ArrowUp');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  const projectUrl = page.url();
  const spaceTab = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid^="space-tab-"][aria-selected="true"]')!
        .getAttribute('data-testid')!,
  );

  const peer = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  try {
    const other = await peer.newPage();
    await other.goto(projectUrl);
    await other.getByTestId(spaceTab).click();
    const peerBody = other.locator('[data-testid="document-space"] .ProseMirror');
    await expect(peerBody).toContainText('a line with a', { timeout: 20_000 });
    await peerBody.locator('p').first().click();
    await other.keyboard.press(
      process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home',
    );

    const aim = await page.evaluate(() => {
      const rect = document
        .querySelector('[data-testid="document-space"] .ProseMirror a')!
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(20, 20);
    await page.waitForTimeout(400);
    // The pointer arrives, and the peer writes while the delay is running.
    await page.mouse.move(aim.x, aim.y, { steps: 20 });
    await other.keyboard.type('and thirty characters ahead of it', { delay: 1 });
    await expect(page.getByTestId('doc-link-toolbar')).toBeVisible({
      timeout: 8_000,
    });
    await page.waitForTimeout(600);

    const reach = await page.evaluate(() => {
      const bar = document
        .querySelector('[data-testid="doc-link-toolbar"]')!
        .getBoundingClientRect();
      const link = document
        .querySelector('[data-testid="document-space"] .ProseMirror a')!
        .getBoundingClientRect();
      return { sideways: Math.round(bar.left - link.left) };
    });

    expect(
      Math.abs(reach.sideways),
      `the toolbar is ${reach.sideways}px from the link it is about`,
    ).toBeLessThan(40);
  } finally {
    await peer.close();
  }
});

test('link: the trailing edge of a link that touches another one', async ({ page }) => {
  // Two links meeting share one insertion point, so a position alone cannot
  // say which of them the pointer is on. Measured before the fix: a pointer
  // one pixel inside the first link's right edge raised nothing, and a toolbar
  // already up over it went away 200ms later without the pointer leaving —
  // A1 and A5, on the seam.
  await openFreshDocument(page);
  await page.keyboard.type('foobar tail');
  await page.keyboard.press('Enter');
  // Somewhere for the caret to rest that holds no link: a caret inside one is
  // a standing reason for the toolbar of its own, and every measurement here
  // is about the pointer.
  await page.keyboard.type('a plain line to rest on');
  const mod = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
  // Each keyboard run starts by putting the caret in the line it is about and
  // waiting for the editor to hold the focus: presses that arrive before a
  // click's focus lands are dropped, and the two links then come out the wrong
  // length with a plain character left between them, which is another case.
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/foo');
  await collapseAfterLinking(page);
  // The caret sits in the link the confirm just wrote, which raises the
  // toolbar by the caret route. One line down takes it out and records
  // nothing; one line up would not, because this link starts where its line
  // does. Escape would leave the caret where it is and write a dismissal, and
  // a link the reader dismissed with their caret inside it stays away from
  // the hand.
  await page.keyboard.press('ArrowDown');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/bar');
  await collapseAfterLinking(page);
  // The caret sits in the link the confirm just wrote, which raises the
  // toolbar by the caret route. One line down takes it out and records
  // nothing; one line up would not, because this link starts where its line
  // does. Escape would leave the caret where it is and write a dismissal, and
  // a link the reader dismissed with their caret inside it stays away from
  // the hand.
  await page.keyboard.press('ArrowDown');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });
  expect(
    await page.locator('[data-testid="document-space"] .ProseMirror a').count(),
    'the two links have to be separate runs for this to mean anything',
  ).toBe(2);
  expect(
    await page.evaluate(() => {
      const at = (href: string) =>
        document.querySelector(
          `[data-testid="document-space"] .ProseMirror a[href="${href}"]`,
        )!.getClientRects()[0]!;
      return Math.round(at('https://a.example/bar').left - at('https://a.example/foo').right);
    }),
    'the two links have to touch for this to mean anything',
  ).toBe(0);

  const edge = await page.evaluate(() => {
    const rect = document
      .querySelector('[data-testid="document-space"] .ProseMirror a[href="https://a.example/foo"]')!
      .getClientRects()[0]!;
    return { x: rect.right - 1, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(20, 20);
  await page.waitForTimeout(400);
  await page.mouse.move(edge.x, edge.y, { steps: 25 });

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/foo',
    { timeout: 5_000 },
  );
});

test('link: the toolbar comes up while a co-editor is typing', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('a line the peer writes on');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a line with a target on it');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowLeft');
  await linkTheSelection(page, 'a.example/typed-at');
  await collapseAfterLinking(page);
  // The caret sits in the link the confirm just wrote, which raises the
  // toolbar by the caret route. One line up takes it out and records nothing;
  // Escape would leave the caret where it is and write a dismissal, and a link
  // the reader dismissed with their caret inside it stays away from the hand.
  await page.keyboard.press('ArrowUp');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  const projectUrl = page.url();
  const spaceTab = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid^="space-tab-"][aria-selected="true"]')!
        .getAttribute('data-testid')!,
  );

  const peer = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  try {
    const other = await peer.newPage();
    await other.goto(projectUrl);
    await other.getByTestId(spaceTab).click();
    const peerBody = other.locator('[data-testid="document-space"] .ProseMirror');
    await expect(peerBody).toContainText('a line with a target on it', {
      timeout: 20_000,
    });
    await peerBody.locator('p').first().click();
    await other.keyboard.press(
      process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home',
    );

    const aim = await page.evaluate(() => {
      const rect = document
        .querySelector('[data-testid="document-space"] .ProseMirror a')!
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(20, 20);
    await page.waitForTimeout(300);
    // The peer is already writing when the pointer arrives, so the countdown
    // runs through their keystrokes rather than finishing before the first.
    const typing = other.keyboard.type('0123456789012345678901234567890123456789', {
      delay: 60,
    });
    await page.waitForTimeout(150);
    await page.mouse.move(aim.x, aim.y, { steps: 20 });
    // A hand resting on a trackpad sends moves of its own, and each of them
    // asks again which link is under it.
    for (let i = 0; i < 30; i += 1) {
      await page.mouse.move(aim.x + (i % 2), aim.y);
      await page.waitForTimeout(50);
    }
    await typing;

    await expect(page.getByTestId('doc-link-url')).toHaveText(
      'https://a.example/typed-at',
      { timeout: 8_000 },
    );
  } finally {
    await peer.close();
  }
});

test('link: a dismissal holds while a co-editor writes ahead of the link', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1680, height: 950 });
  await openFreshDocument(page);
  await page.keyboard.type('a line with a target on it');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('Shift+ArrowLeft');
  await linkTheSelection(page, 'a.example/dismissed');
  await collapseAfterLinking(page);
  // The caret sits in the link the confirm just wrote, which raises the
  // toolbar by the caret route. One line up takes it out and records nothing;
  // Escape would leave the caret where it is and write a dismissal, and a link
  // the reader dismissed with their caret inside it stays away from the hand.
  await page.keyboard.press('ArrowUp');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  const projectUrl = page.url();
  const spaceTab = await page.evaluate(
    () =>
      document
        .querySelector('[data-testid^="space-tab-"][aria-selected="true"]')!
        .getAttribute('data-testid')!,
  );

  const peer = await browser.newContext({
    storageState: STATE_FILE.A,
    viewport: { width: 1680, height: 950 },
  });
  try {
    const other = await peer.newPage();
    await other.goto(projectUrl);
    await other.getByTestId(spaceTab).click();
    const peerBody = other.locator('[data-testid="document-space"] .ProseMirror');
    await expect(peerBody).toContainText('a line with a target on it', {
      timeout: 20_000,
    });
    await peerBody.locator('p').first().click();
    await other.keyboard.press(
      process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home',
    );

    await restOnLink(page, 0);
    await expect(page.getByTestId('doc-link-url')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
      timeout: 8_000,
    });

    await other.keyboard.type('PEER ', { delay: 1 });
    await page.waitForTimeout(700);
    const moved = await page.evaluate(() => {
      const rect = document
        .querySelector('[data-testid="document-space"] .ProseMirror a')!
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(moved.x + 1, moved.y);
    await page.waitForTimeout(HOVER_OPEN_DELAY_MS + 600);

    await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached();
  } finally {
    await peer.close();
  }
});

test('link: the toolbar stays when the caret leaves a link the pointer is on', async ({ page }) => {
  // A1 does not depend on where the caret is. The caret route and the pointer
  // route share one hold, and letting go of the caret's claim used to take the
  // toolbar off a link the pointer was still resting on — with no pointer move
  // left to bring it back.
  //
  // Its own document: the caret has to leave into a line that holds no link,
  // and re-pointing the toolbar at an intervening link would put the toolbar
  // itself over the resting pointer, which is a different case.
  await openFreshDocument(page);
  await page.keyboard.type('target here');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a plain line with nothing on it');
  await selectParagraph(page, 0);
  await linkTheSelection(page, 'a.example/stays');
  await collapseAfterLinking(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="document-space"] .ProseMirror p').nth(1).click();
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  await selectParagraph(page, 0);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/stays',
    { timeout: 8_000 },
  );
  const box = (await page
    .locator('[data-testid="document-space"] .ProseMirror a')
    .first()
    .boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 20,
  });
  await page.waitForTimeout(600);

  // The caret walks down to the line that holds no link. The pointer does not
  // move at all.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(HOVER_CLOSE_DELAY_MS + 600);

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/stays',
  );
});

test('link: two touching links each answer for themselves', async ({ page }) => {
  // Two links that touch are the one shape where the pointer crosses from one
  // to the next with no sample landing off either, so nothing else ends the
  // neighbour's toolbar. Measured before the fix: the toolbar stood over `bar`
  // for as long as the pointer rested on `foo`, and Remove would have stripped
  // `bar` — the link the reader was not pointing at.
  await openFreshDocument(page);
  await page.keyboard.type('foobar tail');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a plain line to rest on');
  const mod = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/foo');
  await collapseAfterLinking(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/bar');
  await collapseAfterLinking(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="document-space"] .ProseMirror p').nth(1).click();
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  const pair = await page.evaluate(() => {
    const at = (href: string) =>
      document
        .querySelector(`[data-testid="document-space"] .ProseMirror a[href="${href}"]`)!
        .getClientRects()[0]!;
    const one = at('https://a.example/foo');
    const other = at('https://a.example/bar');
    return {
      foo: { x: one.left + one.width / 2, y: one.top + one.height / 2 },
      bar: { x: other.left + other.width / 2, y: other.top + other.height / 2 },
    };
  });
  await page.mouse.move(pair.foo.x, pair.foo.y, { steps: 25 });
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/foo',
    { timeout: 5_000 },
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  await page.mouse.move(pair.bar.x, pair.bar.y, { steps: 10 });
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/bar',
    { timeout: 5_000 },
  );
  // Back onto `foo`, with the hand still moving the way a hand resting on a
  // trackpad does. The dismissal `foo` was given is spent — the pointer that
  // raised it went to `bar`, which is leaving — so the toolbar comes back, and
  // it comes back about `foo`. Measured before the fix: it stood over `bar`
  // for as long as the moving went on, because each sample cancelled the close
  // and started another.
  await page.mouse.move(pair.foo.x, pair.foo.y, { steps: 10 });
  for (let i = 0; i < 12; i += 1) {
    await page.mouse.move(pair.foo.x + (i % 2), pair.foo.y);
    await page.waitForTimeout(60);
  }

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/foo',
    { timeout: 5_000 },
  );
});

test('link: a keystroke inside the link the caret is in leaves the pointer its own', async ({ page }) => {
  // A1 and A5 against the caret route. The caret re-targets the toolbar when
  // it moves INTO a link, and a caret that has not left the link it was in has
  // entered nothing. Measured before the fix: one arrow key pulled the toolbar
  // off the link the pointer was resting on and onto the one holding the
  // caret, with the hand still — and Remove would then have stripped that one.
  await openFreshDocument(page);
  await page.keyboard.type('alphabet and betamax');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a plain line to rest on');
  const mod = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/alpha');
  await collapseAfterLinking(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 13; i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 7; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/beta');
  await collapseAfterLinking(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="document-space"] .ProseMirror p').nth(1).click();
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  // The caret into the first link, by keyboard.
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
  await page.mouse.move(20, 20);
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/alpha',
    { timeout: 8_000 },
  );

  // The pointer takes the hold to the other link on the same line.
  const beta = await page.evaluate(() => {
    const r = document
      .querySelector('[data-testid="document-space"] .ProseMirror a[href="https://a.example/beta"]')!
      .getClientRects()[0]!;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(beta.x, beta.y, { steps: 25 });
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/beta',
    { timeout: 8_000 },
  );

  // One arrow key, still inside the first link. The pointer does not move.
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(700);

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/beta',
  );

  // One character, typed into that same link. It joins the link, so the link
  // now covers one more character than it did — which is the same caret, in
  // the same link, at a different pair of numbers.
  await page.keyboard.type('X');
  await page.waitForTimeout(700);

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/beta',
  );
});

test('link: the toolbar stands while the reader writes under the hand', async ({ page }) => {
  // A5 against the pointer route. The toolbar over a link the hand is resting
  // on goes when the hand leaves, and a keystroke is not the hand leaving.
  // Measured before the fix: the first character typed took the toolbar away,
  // and nothing brought it back while the pointer stayed where it was.
  await openFreshDocument(page);
  await page.keyboard.type('a line holding one link');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a line the toolbar covers');
  await page.keyboard.press('Enter');
  // `parkPointer` puts the caret on the third line, which has to hold no link
  // of its own: a caret inside one raises the toolbar by the caret route, and
  // every measurement here is about the pointer.
  await page.keyboard.type('a plain line to rest on');
  const mod = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 7; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/stands');
  await collapseAfterLinking(page);
  await parkPointer(page);

  await restOnLink(page, 0);
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/stands',
    { timeout: 8_000 },
  );
  // The reader carries on writing, on the line their caret was parked on. The
  // hand has not moved.
  await page.keyboard.type('yz');
  await page.waitForTimeout(700);

  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/stands',
  );
});

test('link: a dismissal holds while the caret is parked in another link', async ({ page }) => {
  // A4. Escape takes the toolbar away without the hand moving, and what the
  // reader dismissed covers the link their caret is parked in as well —
  // otherwise the next character anyone types raises the toolbar over that
  // one, seconds after they asked for no toolbar.
  await openFreshDocument(page);
  await page.keyboard.type('alphabet and betamax');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a line the toolbar covers');
  await page.keyboard.press('Enter');
  // `parkPointer` puts the caret on the third line, which has to hold no link
  // of its own: the case is about a caret parked in one of the two above.
  await page.keyboard.type('a plain line to rest on');
  const mod = process.platform === 'darwin' ? 'Meta+ArrowLeft' : 'Home';
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/alpha');
  await collapseAfterLinking(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 13; i += 1) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 7; i += 1) await page.keyboard.press('Shift+ArrowRight');
  await linkTheSelection(page, 'a.example/beta');
  await collapseAfterLinking(page);
  await parkPointer(page);

  // The caret into the first link, the pointer onto the second.
  await page.locator('[data-testid="document-space"] .ProseMirror p').first().click();
  await expect(page.locator('[data-testid="document-space"] .ProseMirror')).toBeFocused();
  await page.waitForTimeout(200);
  await page.keyboard.press(mod);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
  await restOnLink(page, 1);
  await expect(page.getByTestId('doc-link-url')).toHaveText(
    'https://a.example/beta',
    { timeout: 8_000 },
  );

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('doc-link-toolbar')).not.toBeAttached({
    timeout: 8_000,
  });

  // One character. The hand has not moved, and the caret is where it was.
  // Escape takes the focus off the body (#993), so it goes back without a
  // click, which would move the caret out of the link this case is about.
  await page.locator('[data-testid="document-space"] .ProseMirror').evaluate((el) => {
    (el as HTMLElement).focus();
  });
  await page.keyboard.type('Q');
  // The character has to land: typing into a body that lost the focus would
  // leave the document unchanged, and the assertion below would then be the
  // one made two lines above it.
  await expect(
    page.locator('[data-testid="document-space"] .ProseMirror'),
  ).toContainText('Q', { timeout: 8_000 });
  await page.waitForTimeout(700);

  expect(await page.getByTestId('doc-link-toolbar').count()).toBe(0);
});
