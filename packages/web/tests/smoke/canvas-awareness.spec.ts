// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas presence E2E (#2004) — the half no jsdom test can reach.
 *
 * Every unit test in this slice drives one side of the wire: a fake awareness
 * in, a table or a list of tags out. What none of them can answer is whether
 * the two sides are joined — whether what one browser publishes is what
 * another browser draws. That needs two live connections to one collab
 * server, which is what this file sets up.
 *
 * Two pages in ONE context, not two accounts. Presence keys on the connection,
 * not the person (`collectNodeOccupants` skips its own client id and no other),
 * so a second tab of the same account is a peer in every way that matters here
 * and costs no second sign-in against a rate limit the whole suite shares.
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

// `watcher` publishes and `viewer` reads it back. Both are the same account,
// so whatever `viewer` draws carries the account's own name and hue.
let context: BrowserContext;
let watcher: Page;
let viewer: Page;
let projectId = '';
let spaceId = '';

// The dev collab server holds an awareness update for up to a frame on each
// side plus the round trip, and a canvas that has just mounted is still
// syncing its document. Every wait below is a poll, so this is a ceiling and
// not a sleep.
const SETTLE_MS = 4_000;

/** A 320x240 solid PNG, inline so it decodes with no network. */
const SOLID_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAACD0lEQVR42u3TQQkAAAgEwUtnCJMY3w7+hIFJsLCpHuCpSAAGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGAysAhgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBhYBTAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMHC3pCIzOUa0Hy8AAAAASUVORK5CYII=';

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
 * Write one image node into the open Space's Yjs document.
 *
 * The document is the layer under every UI route to the same end state, and
 * the canvas routes (node menu, context menu, empty-state panel) all live in
 * overlays that track the viewport transform — none of them hold still long
 * enough to be called actionable. What this file measures is unaffected by
 * how the node got there. Same approach as `focus-crop-presets.spec.ts`.
 * @param page - A page with the Space open.
 * @param nodeId - The id to give the node.
 * @param at - Where to put it, in canvas coordinates.
 */
async function seedImageNode(
  page: Page,
  nodeId: string,
  at: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    async ([pid, sid, id, png, x, y]: [string, string, string, string, number, number]) => {
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
      canvas.addNode(pid, sid, {
        id,
        type: 'image',
        position: { x, y },
        data: {
          name: 'presence-e2e',
          createdAt: Date.now(),
          createdBy: 'presence-e2e',
          locked: false,
          state: 'idle',
          attachments: [],
          content: png,
        },
      });
    },
    [projectId, spaceId, nodeId, SOLID_PNG, at.x, at.y] as [
      string,
      string,
      string,
      string,
      number,
      number,
    ],
  );
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
  watcher = await context.newPage();
  await signIn(watcher);

  // Reuse an existing Project: this spec is about presence, and minting one
  // per run burns the tier's projects-per-studio allowance.
  await watcher.goto('/studio');
  const firstProject = watcher.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await watcher.waitForURL(/\/project\//, { timeout: 15_000 });
  projectId = (/([0-9a-f-]{36})$/.exec(watcher.url()) ?? [])[1] as string;

  spaceId = await createSpace(watcher, 'canvas', `presence-e2e-${Date.now()}`);
  await expect(watcher.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  await seedImageNode(watcher, `presence-e2e-node-${Date.now()}`, { x: 120, y: 120 });
  await expect(watcher.locator('.react-flow__node').first()).toBeVisible({
    timeout: 20_000,
  });

  // The second connection joins the same Space, sharing the context's cookies.
  viewer = await context.newPage();
  await openTheSpace(viewer);
});

test.afterAll(async () => {
  await viewer?.close();
  if (spaceId !== '' && watcher !== undefined) {
    await deleteSpace(watcher, spaceId);
  }
  await context?.close();
});

// Seeding a Space and two live collab connections outlasts the suite-wide 30s
// budget before a single assertion runs.
test.setTimeout(90_000);

test('a selection on one connection tags the node on the other', async () => {
  const node = watcher.locator('.react-flow__node').first();
  await node.locator('[data-testid=image-node]').click();
  await expect(node).toHaveClass(/selected/, { timeout: SETTLE_MS });

  const tags = viewer.getByTestId('node-occupant-tags');
  await expect(tags).toBeVisible({ timeout: SETTLE_MS });
  // The tag carries a name, not a bare coloured chip: colour is never the only
  // signal (WCAG 1.4.1), and the roster names this account.
  await expect(tags).not.toHaveText('', { timeout: SETTLE_MS });

  // The node's own border is untouched by the tag: presence must not paint
  // over state. Selection is the watcher's local flag, so the viewer's copy of
  // the node is the unselected one it has always been.
  await expect(viewer.locator('.react-flow__node').first()).not.toHaveClass(
    /selected/,
  );
});

test('the tag matches the values the demo wrote down', async () => {
  // The demo the design was signed off against
  // (2026-08-25-awareness-edge-and-cursor.html) fixes these. Class names are
  // not the check: a token can move, a rule can be overridden, and a value
  // written in the source can still fail to render — so each one is read back
  // off the live canvas.
  const tag = viewer.getByTestId('node-occupant-tags').locator('span').first();
  await expect(tag).toBeVisible({ timeout: SETTLE_MS });

  const measured = await tag.evaluate((el) => {
    const s = getComputedStyle(el);
    const row = getComputedStyle(el.parentElement as HTMLElement);
    return {
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      padding: `${s.paddingTop} ${s.paddingRight}`,
      radius: s.borderTopLeftRadius,
      maxWidth: s.maxWidth,
      rowGap: row.columnGap,
      rowPaddingBottom: row.paddingBottom,
    };
  });
  expect(measured).toEqual({
    fontSize: '11px',
    fontWeight: '600',
    // 0.1rem 0.3rem, the demo's own units.
    padding: '1.6px 4.8px',
    radius: '2px',
    maxWidth: '112px',
    rowGap: '4px',
    rowPaddingBottom: '4px',
  });
});

test('dropping the selection takes the tag away', async () => {
  // Click the empty pane, which is how a person drops a selection.
  await watcher.locator('.react-flow__pane').click({ position: { x: 900, y: 700 } });
  await expect(watcher.locator('.react-flow__node').first()).not.toHaveClass(
    /selected/,
    { timeout: SETTLE_MS },
  );

  await expect(viewer.getByTestId('node-occupant-tags')).toHaveCount(0, {
    timeout: SETTLE_MS,
  });
});

test('a pointer moving on one connection draws an arrow on the other', async () => {
  const pane = watcher.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  await watcher.mouse.move(box.x + 400, box.y + 300);
  await watcher.mouse.move(box.x + 420, box.y + 320);

  // The layer itself is an anchor: everything inside it is absolutely
  // positioned, so its own box is 0x0 and only what it holds can be seen.
  const cursors = viewer.getByTestId('canvas-cursors');
  await expect(cursors).toHaveCount(1, { timeout: SETTLE_MS });
  const arrow = cursors.locator('svg').first();
  await expect(arrow).toBeVisible({ timeout: SETTLE_MS });

  // The arrow has a real size — a 0x0 SVG is visible to a locator and invisible
  // to a person, which is exactly how the design demo first went wrong.
  const drawn = await arrow.boundingBox();
  expect(drawn?.width ?? 0).toBeGreaterThan(8);
  expect(drawn?.height ?? 0).toBeGreaterThan(8);

  // The name rides below and to the right of the tip, filled with the same hue
  // as the arrow, and its text colour is the theme-aware one.
  const label = cursors.locator('span').first();
  const geometry = await label.evaluate((el) => {
    const svg = el.parentElement?.querySelector('svg');
    const tip = svg?.getBoundingClientRect();
    const own = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const arrowFill = svg === null || svg === undefined ? '' : getComputedStyle(svg).fill;
    return {
      belowTheTip: own.top >= (tip?.top ?? 0),
      rightOfTheTip: own.left >= (tip?.left ?? 0),
      background: style.backgroundColor,
      colour: style.color,
      arrowFill,
    };
  });
  expect(geometry.belowTheTip).toBe(true);
  expect(geometry.rightOfTheTip).toBe(true);
  expect(geometry.background).toBe(geometry.arrowFill);
  expect(geometry.colour).not.toBe(geometry.background);

  // The rest of what the demo wrote down for the name block, read back off the
  // canvas rather than trusted to the class names.
  const style = await label.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      offset: `${s.top} ${s.left}`,
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
      lineHeight: s.lineHeight,
      padding: `${s.paddingTop} ${s.paddingRight}`,
      radius: s.borderTopLeftRadius,
      maxWidth: s.maxWidth,
    };
  });
  expect(style).toEqual({
    offset: '24px 15px',
    fontSize: '12px',
    fontWeight: '600',
    lineHeight: '16px',
    padding: '3px 8px',
    radius: '6px',
    maxWidth: '132px',
  });

  // The arrow is the demo's exact 16x21, so the tip really sits at the pointer.
  expect(await arrow.evaluate((el) => el.getAttribute('viewBox'))).toBe('0 0 16 21');
  expect(Math.round(drawn?.width ?? 0)).toBe(16);
  expect(Math.round(drawn?.height ?? 0)).toBe(21);
});

test('a pointer leaving the canvas takes the arrow away', async () => {
  // Walk the mouse off the canvas and onto the chrome beside it, which is what
  // a person does when they go back to the agent panel. `pointerleave` fires
  // on the canvas container, and only a real move produces it — a synthetic
  // event would have to name that container itself, and naming the wrong
  // element leaves a case that passes while testing nothing.
  const box = await watcher.getByTestId('canvas-space').boundingBox();
  if (box === null) throw new Error('the canvas has no box');
  await watcher.mouse.move(box.x + 200, box.y + 200);
  await watcher.mouse.move(box.x - 40, box.y + 200, { steps: 6 });

  await expect(viewer.getByTestId('canvas-cursors')).toHaveCount(0, {
    timeout: SETTLE_MS,
  });
});
