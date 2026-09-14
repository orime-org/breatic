// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Annotations end to end (#1881) — the halves jsdom cannot answer.
 *
 * Three of them. A custom CSS cursor fails silently in three separate ways and
 * jsdom computes no cursor at all, so A17 has only ever been read as text.
 * Placement runs through xyflow's own pane coordinates, which jsdom has none
 * of. And A12 is two live connections converging on one collab server, which
 * is not a thing one document can be made to do.
 *
 * Two pages in ONE context, one account. What A12 asks is whether what one
 * client writes reaches another, and presence on the wire keys on the
 * connection rather than the person — a second tab of the same account is a
 * second client in every way this measures, and costs no second sign-in
 * against a rate limit the whole suite shares. The halves that DO depend on
 * who wrote a line — A6's missing Edit on somebody else's note, A11's name —
 * are answered by the unit tests, which can hand the component any author.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite.
 */
import { test, expect, type BrowserContext, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

// `author` writes, `peer` reads it back over the collab server.
let context: BrowserContext;
let author: Page;
let peer: Page;
let projectId = '';
let spaceId = '';

// A canvas that has just mounted is still syncing, and an update crosses the
// dev collab server before the other side draws it. Every wait below is a
// poll, so this is a ceiling and not a sleep.
const SETTLE_MS = 15_000;

/**
 * Sign a page in and leave it wherever the app lands after login.
 * @param page - A fresh page.
 * @throws {Error} When the sign-in never leaves the login route.
 */
async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

/**
 * Bring a page into the run's Space and wait for the canvas to be live.
 * @param page - A signed-in page.
 * @throws {Error} When the canvas never appears.
 */
async function openTheSpace(page: Page): Promise<void> {
  await page.goto(`/project/${projectId}`);
  const tab = page.getByTestId(`space-tab-name-${spaceId}`);
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await tab.click();
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  author = await context.newPage();
  await signIn(author);

  // Reuse an existing Project: this spec is about annotations, and minting one
  // per run burns the tier's projects-per-studio allowance.
  await author.goto('/studio');
  const firstProject = author.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await author.waitForURL(/\/project\//, { timeout: 15_000 });
  projectId = (/([0-9a-f-]{36})$/.exec(author.url()) ?? [])[1] as string;

  spaceId = await createSpace(author, 'canvas', `annotation-e2e ${Date.now()}`);
  await expect(author.locator('.react-flow')).toBeVisible({ timeout: 20_000 });

  peer = await context.newPage();
  await openTheSpace(peer);
});

test.afterAll(async () => {
  await peer?.close();
  if (spaceId !== '' && author !== undefined) {
    await deleteSpace(author, spaceId);
  }
  await context?.close();
});

// Two live collab connections and a Space to hold them outlast the suite-wide
// 30s budget before a single assertion runs.
test.setTimeout(90_000);

test('the armed tool says so on the button and under the pointer', async () => {
  const comment = author.getByTestId('tool-comment');
  await expect(comment).toHaveAttribute('aria-pressed', 'false');

  await comment.click();
  await expect(comment).toHaveAttribute('aria-pressed', 'true');

  // A17. The three ways a custom cursor fails — an SVG with no intrinsic
  // size, an image over 32x32, a rule with no keyword to fall back on — all
  // leave the pointer as it was with nothing in the console, so the only
  // answer that means anything comes from a browser that resolved the rule.
  const pane = author.locator('.react-flow__pane');
  await expect
    .poll(
      () =>
        pane.evaluate((el) => getComputedStyle(el).cursor),
      { timeout: SETTLE_MS },
    )
    .toContain('url(');

  // The tool is spent on the click that says where, and the button goes dark
  // with it (A16's second half).
  await author.keyboard.press('Escape');
  await expect(comment).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(() => pane.evaluate((el) => getComputedStyle(el).cursor))
    .not.toContain('url(');
});

test('a note dropped on one canvas turns up on the other', async () => {
  await author.getByTestId('tool-comment').click();

  const pane = author.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  await author.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.4);

  // A1: the box opens focused where the click landed, and Enter keeps it.
  const composer = author.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await author.keyboard.type('the shot needs to be slower');
  await author.keyboard.press('Enter');
  await expect(composer).toHaveCount(0);

  await expect(author.getByTestId('annotation-node').first()).toContainText(
    'the shot needs to be slower',
    { timeout: SETTLE_MS },
  );

  // A12: the other client's canvas follows.
  await expect(peer.getByTestId('annotation-node').first()).toContainText(
    'the shot needs to be slower',
    { timeout: SETTLE_MS },
  );
});

test('a reply written on one canvas turns up on the other', async () => {
  // A3 + A19: the row is one full-width box until something is typed, and the
  // two buttons appear under it.
  const replyBox = peer.getByTestId('annotation-node-reply-input');
  await expect(replyBox).toBeVisible({ timeout: SETTLE_MS });
  await expect(peer.getByTestId('annotation-node-reply-post')).toHaveCount(0);

  await replyBox.click();
  await peer.keyboard.type('agreed, and wider');
  await expect(peer.getByTestId('annotation-node-reply-cancel')).toBeVisible();
  await peer.getByTestId('annotation-node-reply-post').click();

  await expect(peer.getByTestId('annotation-node-replies')).toContainText(
    'agreed, and wider',
    { timeout: SETTLE_MS },
  );
  await expect(author.getByTestId('annotation-node-replies')).toContainText(
    'agreed, and wider',
    { timeout: SETTLE_MS },
  );
});

test('a rewrite reaches the other canvas, and it says it was edited', async () => {
  // A4. The menu belongs to the author of the line, and this account wrote
  // the note, so it is here on both pages; the rewrite is done on the page
  // that placed it.
  await author.getByTestId('annotation-node-body-menu').click();
  await author.getByTestId('annotation-node-body-edit').click();

  const editing = author.getByTestId('annotation-node-body-input');
  await expect(editing).toBeVisible({ timeout: SETTLE_MS });
  await editing.fill('the shot needs to be slower and wider');
  await author.getByTestId('annotation-node-body-save').click();

  await expect(peer.getByTestId('annotation-node-body')).toContainText(
    'slower and wider',
    { timeout: SETTLE_MS },
  );
  await expect(peer.getByTestId('annotation-node-body-edited')).toBeVisible({
    timeout: SETTLE_MS,
  });
});

test('the keyboard reaches the reply buttons, and a rewrite keeps its own', async () => {
  // F: Cancel and Post sit after the box in the tab order. Which element a Tab
  // lands on is the browser's own sequential navigation order, and jsdom has
  // none — the unit test can only say the reply survived the blur.
  const replyBox = author.getByTestId('annotation-node-reply-input');
  await replyBox.click();
  await author.keyboard.type('one more thing');

  await author.keyboard.press('Tab');
  await expect(author.getByTestId('annotation-node-reply-cancel')).toBeFocused();
  await expect(replyBox).toHaveValue('one more thing');

  await author.keyboard.press('Tab');
  await expect(author.getByTestId('annotation-node-reply-post')).toBeFocused();

  // A18: the cancel drops it, and nothing reaches the other canvas.
  await author.keyboard.press('Shift+Tab');
  await expect(author.getByTestId('annotation-node-reply-cancel')).toBeFocused();
  await author.keyboard.press('Enter');
  await expect(replyBox).toHaveValue('');
  await expect(peer.getByTestId('annotation-node-replies')).not.toContainText(
    'one more thing',
  );

  // G: the rewrite box's buttons sit under the scroller that caps the words,
  // so a note long enough to fill the cap still shows them. Measured, because
  // "outside that element" is what the unit test can see and "on the screen
  // where the reader is" is what this is for.
  await author.getByTestId('annotation-node-body-menu').click();
  await author.getByTestId('annotation-node-body-edit').click();
  await author
    .getByTestId('annotation-node-body-input')
    .fill('a long note. '.repeat(80));

  const scroller = author.getByTestId('annotation-node-body-scroller');
  const save = author.getByTestId('annotation-node-body-save');
  await expect(save).toBeVisible();
  const [scrollerBox, saveBox] = await Promise.all([
    scroller.boundingBox(),
    save.boundingBox(),
  ]);
  if (scrollerBox === null || saveBox === null) {
    throw new Error('the rewrite box or its scroller has no box');
  }
  expect(saveBox.y).toBeGreaterThanOrEqual(scrollerBox.y + scrollerBox.height);

  await author.getByTestId('annotation-node-body-cancel').click();
});

test('a wire is board too: the armed tool lands a note on an edge', async () => {
  // xyflow routes a click on a wire to its own handler, not to the pane's, so
  // the pointer said "you can drop here" everywhere the wires run while the
  // click did nothing. jsdom renders no edges to click.
  await author.evaluate(
    async ([pid, sid]: [string, string]) => {
      // Vite serves each module under a versioned URL; importing the bare path
      // would evaluate a SECOND copy whose caches are empty.
      const live = (re: RegExp): string =>
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n)) ?? '';
      const canvas = await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      );
      for (const [id, x] of [
        ['wire-a', 200],
        ['wire-b', 900],
      ] as [string, number][]) {
        canvas.addNode(pid, sid, {
          id,
          type: 'text',
          position: { x, y: 700 },
          data: {
            name: id,
            createdAt: Date.now(),
            createdBy: 'edge-e2e',
            locked: false,
            state: 'idle',
            attachments: [],
            content: id,
          },
        });
      }
      canvas.addEdge(pid, sid, {
        id: 'wire-e',
        source: 'wire-a',
        target: 'wire-b',
      });
    },
    [projectId, spaceId] as [string, string],
  );

  // The wire is an SVG group with no layout box of its own, so aim at the
  // middle of the path it draws.
  const wire = author.locator('.react-flow__edge-path').first();
  await expect
    .poll(() => wire.count(), { timeout: SETTLE_MS })
    .toBeGreaterThan(0);
  const box = await wire.boundingBox();
  if (box === null) throw new Error('the wire draws nothing');
  const before = await author.getByTestId('annotation-node').count();

  await author.getByTestId('tool-comment').click();
  await author.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const composer = author.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await author.keyboard.type('this wire is wrong');
  await author.keyboard.press('Enter');
  await expect(author.getByTestId('annotation-node')).toHaveCount(before + 1, {
    timeout: SETTLE_MS,
  });
});

test('a marquee selection is board too, not a dead rectangle', async () => {
  // xyflow lays `.react-flow__nodesselection-rect` over the selected nodes and
  // the gaps between them, at `pointer-events: all` above the viewport, and it
  // has no click handler of its own — no `onSelectionClick` exists to give it
  // one. Measured before this: the pointer went from the comment bubble to a
  // grab hand and the click did nothing at all, with the tool still armed.
  // The two nodes the edge case seeded are already on the board.
  const a = await author.locator('[data-id="wire-a"]').boundingBox();
  const b = await author.locator('[data-id="wire-b"]').boundingBox();
  if (a === null || b === null) throw new Error('the seeded nodes are gone');

  await author.mouse.move(a.x - 60, a.y - 60);
  await author.mouse.down();
  await author.mouse.move(b.x + b.width + 60, b.y + b.height + 60, {
    steps: 12,
  });
  await author.mouse.up();
  const rect = author.locator('.react-flow__nodesselection-rect');
  await expect(rect).toHaveCount(1, { timeout: SETTLE_MS });
  const box = await rect.boundingBox();
  if (box === null) throw new Error('the selection draws nothing');

  const before = await author.getByTestId('annotation-node').count();
  await author.getByTestId('tool-comment').click();
  // The gap between the two cards: pane underneath, selection rectangle on top.
  await author.mouse.click(
    a.x + a.width + (b.x - (a.x + a.width)) / 2,
    box.y + box.height / 2,
  );

  const composer = author.getByTestId('annotation-composer-input');
  await expect(composer).toBeVisible({ timeout: SETTLE_MS });
  await author.keyboard.type('these two need work');
  await author.keyboard.press('Enter');
  await expect(author.getByTestId('annotation-node')).toHaveCount(before + 1, {
    timeout: SETTLE_MS,
  });
});
