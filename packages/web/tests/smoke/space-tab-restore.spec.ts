// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a visit leaves behind for the next one, measured in a browser (#2165).
 *
 * Every question here needs an engine that actually reloads: whether the strip
 * comes back, whether the camera comes back, and whether the automatic frame
 * still happens on a Space nobody has aimed. jsdom has no reload and no
 * viewport, and the storage this reads is written by a browser that rendered.
 *
 * Runs serial on one page, because each case is "what the one before it left".
 */
import { expect, test, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;
// A second account, for the one case that can only be asked by changing who is
// signed in. The rest of the suite runs on one account, so this pair is its
// own opt-in rather than a suite-wide requirement; `tasks/test_account` lists
// the local dev accounts to point it at.
const emailB = process.env.SMOKE_EMAIL_B;
const passwordB = process.env.SMOKE_PASSWORD_B;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');
test.describe.configure({ mode: 'serial' });

let page: Page;
let projectUrl = '';
/** The Spaces this file created, cleaned up at the end. */
const mine: string[] = [];

/** The Space ids on the strip, left to right. */
async function stripIds(p: Page): Promise<string[]> {
  return p.evaluate(() =>
    // `role="tab"` is what separates the tab buttons from the strip itself
    // and from each tab's inner name element, which share the prefix.
    [...document.querySelectorAll('[role="tab"][data-testid^="space-tab-"]')]
      .map((el) => (el.getAttribute('data-testid') ?? '').replace('space-tab-', '')),
  );
}

/** Which tab is the active one, or null when the strip is empty. */
async function activeId(p: Page): Promise<string | null> {
  return p.evaluate(() => {
    const el = document.querySelector(
      '[role="tab"][data-testid^="space-tab-"][aria-selected="true"]',
    );
    return el?.getAttribute('data-testid')?.replace('space-tab-', '') ?? null;
  });
}

/** The canvas camera as the library holds it. */
async function camera(p: Page): Promise<{ x: number; y: number; zoom: number }> {
  return p.evaluate(() => {
    const el = document.querySelector('.react-flow__viewport') as HTMLElement | null;
    const m = new DOMMatrixReadOnly(el ? getComputedStyle(el).transform : '');
    return { x: Math.round(m.e), y: Math.round(m.f), zoom: Number(m.a.toFixed(3)) };
  });
}

/**
 * The camera the browser is holding for one Space, or null. Found by the
 * Space's own id rather than by position, so it does not assume which account
 * or project sits first in the record.
 */
async function storedViewport(p: Page, spaceId: string): Promise<unknown> {
  return p.evaluate((id) => {
    const raw = window.localStorage.getItem('breatic.projectTabs');
    if (raw === null) return null;
    type Slot = { tabs?: Array<{ spaceId: string; viewport: unknown }> };
    for (const forUser of Object.values(JSON.parse(raw) as Record<string, unknown>)) {
      for (const slot of Object.values((forUser ?? {}) as Record<string, Slot>)) {
        const tab = (slot?.tabs ?? []).find((t) => t.spaceId === id);
        if (tab !== undefined) return tab.viewport;
      }
    }
    return null;
  }, spaceId);
}

/** What the browser is holding for this account and project. */
async function stored(p: Page): Promise<unknown> {
  return p.evaluate(() => {
    const raw = window.localStorage.getItem('breatic.projectTabs');
    return raw === null ? null : JSON.parse(raw);
  });
}

/** Sign in as one account, from wherever the page is. */
async function signIn(p: Page, who: string, secret: string): Promise<void> {
  await p.goto('/login');
  await expect(p.locator('#login-email')).toBeVisible({ timeout: 20_000 });
  await p.locator('#login-email').fill(who);
  await p.locator('#login-password').fill(secret);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 20_000 });
}

/** Sign out the way a person does, through the account menu. */
async function signOut(p: Page): Promise<void> {
  await p.goto('/studio');
  await p.getByRole('button', { name: 'Account' }).click();
  const menu = p.locator('[data-testid="account-menu"]');
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await menu.getByRole('menuitem', { name: /sign out|登出|退出|로그아웃|ログアウト/i }).click();
  await p.waitForURL(/\/login/, { timeout: 20_000 });
}

/** Open this account's first project and answer with its address. */
async function openFirstProject(p: Page): Promise<string> {
  await p.goto('/studio');
  const first = p.locator('a[href^="/project/"]').first();
  await expect(first).toBeVisible({ timeout: 20_000 });
  await first.click();
  await p.waitForURL(/\/project\//, { timeout: 20_000 });
  return p.url();
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => {
    // A stale dependency build shows up here and nowhere else, and it reads as
    // a timeout further down if it is not surfaced.
    console.error('[pageerror]', e.message);
  });
  await signIn(page, email as string, password as string);
  projectUrl = await openFirstProject(page);
  // Start from a browser that has not been here, so the first case is about
  // the landing rule rather than about whatever an earlier run left.
  await page.evaluate(() => window.localStorage.removeItem('breatic.projectTabs'));
});

test.afterAll(async () => {
  for (const id of mine) await deleteSpace(page, id);
});

test('lands on one Space and remembers it', async () => {
  await page.goto(projectUrl);
  await expect(page.locator('.react-flow__pane').first()).toBeVisible({
    timeout: 20_000,
  });
  const ids = await stripIds(page);
  expect(ids).toHaveLength(1);
  // The landing is stored straight away, so a reload has something to open on.
  await expect.poll(() => stored(page)).not.toBeNull();
});

test('brings three tabs and the one that was showing back through a reload', async () => {
  const a = await createSpace(page, 'canvas', 'Restore A');
  const b = await createSpace(page, 'canvas', 'Restore B');
  mine.push(a, b);
  await expect.poll(() => stripIds(page)).toHaveLength(3);
  const before = await stripIds(page);
  // Show the middle one, so the reload has a choice to get wrong.
  await page.locator(`[data-testid="space-tab-${before[1]}"]`).click();
  await expect.poll(() => activeId(page)).toBe(before[1]);

  await page.reload();
  await expect(page.locator('.react-flow__pane').first()).toBeVisible({
    timeout: 20_000,
  });
  expect(await stripIds(page)).toEqual(before);
  expect(await activeId(page)).toBe(before[1]);
});

test('stores no camera for a Space the reader only clicked in', async () => {
  // Reaching into the canvas is not aiming the camera. A click selects, drags
  // a node, opens a menu — it leaves the view exactly where the automatic
  // framing put it, and that frame is nobody's choice. Storing it would turn
  // `fitView` off for this Space for good, so a node added outside that frame
  // later would open off screen.
  //
  // The switch at the end is the whole point: the camera is also written when
  // the canvas unmounts, and that is the path this walks.
  const ids = await stripIds(page);
  const fresh = ids[2] as string;
  const elsewhere = ids[0] as string;
  await page.locator(`[data-testid="space-tab-${fresh}"]`).click();
  await expect.poll(() => activeId(page)).toBe(fresh);
  expect(await storedViewport(page, fresh)).toBeNull();

  const pane = page.locator('.react-flow__pane').first();
  const box = await pane.boundingBox();
  if (box === null) throw new Error('the canvas pane has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(300);

  await page.locator(`[data-testid="space-tab-${elsewhere}"]`).click();
  await expect.poll(() => activeId(page)).toBe(elsewhere);
  await page.waitForTimeout(600);
  expect(await storedViewport(page, fresh)).toBeNull();

  await page.locator(`[data-testid="space-tab-${fresh}"]`).click();
  await expect.poll(() => activeId(page)).toBe(fresh);
});

test('comes back to the camera the user aimed, across a switch and a reload', async () => {
  const ids = await stripIds(page);
  const [first, second] = ids as [string, string];
  await page.locator(`[data-testid="space-tab-${first}"]`).click();
  await expect.poll(() => activeId(page)).toBe(first);

  // Aim it: a real wheel gesture over the pane, which is how the user pans.
  const pane = page.locator('.react-flow__pane').first();
  await pane.hover();
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(400);
  const aimed = await camera(page);

  await page.locator(`[data-testid="space-tab-${second}"]`).click();
  await expect.poll(() => activeId(page)).toBe(second);
  await page.locator(`[data-testid="space-tab-${first}"]`).click();
  await expect.poll(() => activeId(page)).toBe(first);
  expect(await camera(page)).toEqual(aimed);

  await page.reload();
  await expect(page.locator('.react-flow__pane').first()).toBeVisible({
    timeout: 20_000,
  });
  expect(await activeId(page)).toBe(first);
  expect(await camera(page)).toEqual(aimed);
});

test('remembers a camera aimed from the minimap, which carries no pointer event', async () => {
  // The minimap ships on and is `pannable zoomable`, so it is one of the ways
  // a person aims a Space. It drives the camera through the library, so the
  // move arrives with no DOM event — the same shape as the automatic framing.
  const ids = await stripIds(page);
  const target = ids[ids.length - 1] as string;
  await page.locator(`[data-testid="space-tab-${target}"]`).click();
  await expect.poll(() => activeId(page)).toBe(target);

  const map = page.locator('.react-flow__minimap');
  await expect(map).toBeVisible();
  const box = await map.boundingBox();
  if (!box) throw new Error('the minimap has no box');
  const framed = await camera(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 25, {
    steps: 10,
  });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const aimed = await camera(page);
  expect(aimed).not.toEqual(framed);
  await expect.poll(() => storedViewport(page, target)).not.toBeNull();

  // And it is still there after a switch away and back.
  const other = ids.find((id) => id !== target) as string;
  await page.locator(`[data-testid="space-tab-${other}"]`).click();
  await expect.poll(() => activeId(page)).toBe(other);
  await page.locator(`[data-testid="space-tab-${target}"]`).click();
  await expect.poll(() => activeId(page)).toBe(target);
  expect(await camera(page)).toEqual(aimed);
});

test('keeps a closed tab closed, and an emptied strip empty', async () => {
  const ids = await stripIds(page);
  const doomed = ids[ids.length - 1] as string;
  // The × is 0 wide and transparent until the tab is hovered, which is how a
  // user reaches it.
  await page.locator(`[data-testid="space-tab-${doomed}"]`).hover();
  await page.locator(`[data-testid="space-tab-close-${doomed}"]`).click();
  await expect.poll(() => stripIds(page)).not.toContain(doomed);

  await page.reload();
  // Wait for the strip the reload restored, by its length. "Does not contain
  // the closed one" is also true of the empty strip a page still loading
  // shows, so polling on that walks on before the tabs are there.
  await expect
    .poll(() => stripIds(page), { timeout: 20_000 })
    .toHaveLength(ids.length - 1);
  expect(await stripIds(page)).not.toContain(doomed);

  // Close what is left, one at a time, and the strip stays empty over a reload
  // rather than opening the newest Space again.
  for (const id of await stripIds(page)) {
    await page.locator(`[data-testid="space-tab-${id}"]`).hover();
    await page.locator(`[data-testid="space-tab-close-${id}"]`).click();
    await expect.poll(() => stripIds(page)).not.toContain(id);
  }
  expect(await stripIds(page)).toEqual([]);
  await page.reload();
  await expect(page.locator('[data-testid="no-active-space"]')).toBeVisible({
    timeout: 20_000,
  });
  expect(await stripIds(page)).toEqual([]);
});

test('keeps one account’s strip out of the next account’s hands', async () => {
  test.skip(
    !emailB || !passwordB,
    'SMOKE_EMAIL_B / SMOKE_PASSWORD_B not set — this case needs a second account',
  );
  // One browser, two accounts. The record is addressed by account, and the
  // only way to see that on the real path is to change who is signed in:
  // reading a key nobody ever wrote is true of any record.
  //
  // The second account walks its OWN project, not this one. Measured: opening
  // a project it is not a member of answers "Your session is invalid" with an
  // empty strip, so a shared project would ask a membership question instead
  // of this one.
  await page.goto(projectUrl);
  // The case before this one emptied the strip, so there is no canvas to wait
  // for — the project shell is what says the page has arrived.
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
  const created = await createSpace(page, 'canvas', `restore-boundary-${Date.now()}`);
  mine.push(created);
  const strip = await stripIds(page);
  expect(strip).toContain(created);
  // The strip is painted before it is stored, so wait for the write rather
  // than snapshotting a record the new tab has not reached yet.
  await expect
    .poll(() => stored(page).then((r) => JSON.stringify(r).includes(created)))
    .toBe(true);
  const asLeft = await stored(page);

  await signOut(page);
  await signIn(page, emailB as string, passwordB as string);
  await openFirstProject(page);
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
  // The record now names two accounts rather than one slot written over, and
  // none of the first account's tabs are on this strip.
  await expect
    .poll(() => stored(page).then((r) => Object.keys(r as Record<string, unknown>)), {
      timeout: 20_000,
    })
    .toHaveLength(2);
  const theirs = await stripIds(page);
  for (const id of strip) expect(theirs).not.toContain(id);

  await signOut(page);
  await signIn(page, email as string, password as string);
  await page.goto(projectUrl);
  await expect.poll(() => stripIds(page), { timeout: 20_000 }).toEqual(strip);
  // Untouched, not merely restored: the other account's visit added a key and
  // changed nothing under this one.
  const back = (await stored(page)) as Record<string, unknown>;
  const left = asLeft as Record<string, unknown>;
  for (const [user, projects] of Object.entries(left)) {
    expect(back[user]).toEqual(projects);
  }
});
