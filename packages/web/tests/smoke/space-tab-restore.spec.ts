// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a visit leaves behind for the next one, measured in a browser (#2165).
 *
 * Every question here needs an engine that actually reloads: whether the strip
 * comes back, and whether the camera comes back — on a Space the reader
 * aimed, on one they only looked at, and across a project the Back button
 * returns to. jsdom has no reload and no viewport, and the storage this reads
 * is written by a browser that rendered.
 *
 * Runs serial on one page, because each case is "what the one before it left".
 */
import { expect, test, type Page } from 'playwright/test';

import { signIn, signOut } from './helpers/session';
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

/** A 1x1 PNG, enough for a node the framing has to fit. */
const DOT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Write one image node into the open Space's Yjs document.
 *
 * Through the module the page already loaded, the way the canvas specs do it:
 * the client writes canvas nodes directly, so there is no endpoint to call.
 * @param p - A page with the Space open.
 * @param projectId - The project the Space belongs to.
 * @param spaceId - The Space to write into.
 * @param at - Where to put the node, in canvas coordinates.
 * @throws {Error} When the canvas module is not among the loaded resources.
 */
async function seedImageNode(
  p: Page,
  projectId: string,
  spaceId: string,
  at: { x: number; y: number },
): Promise<void> {
  await p.evaluate(
    async ([pid, sid, x, y, png]: [string, string, number, number, string]) => {
      const loaded = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /data\/yjs\/canvas-space\.ts/.test(n));
      if (loaded === undefined) throw new Error('the canvas module is not loaded');
      const canvas = (await import(/* @vite-ignore */ loaded)) as {
        addNode: (p: string, s: string, node: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id: `restore-camera-${x}-${y}`,
        type: 'image',
        position: { x, y },
        data: {
          name: 'restore-camera',
          createdAt: Date.now(),
          createdBy: 'restore-camera',
          locked: false,
          state: 'idle',
          attachments: [],
          content: png,
        },
      });
    },
    [projectId, spaceId, at.x, at.y, DOT_PNG] as [string, string, number, number, string],
  );
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

test('keeps the camera of a Space the reader only looked at', async () => {
  // Zoom and centre are two numbers, and whatever set them is what the reader
  // last saw — the framing this canvas does on a Space it has nothing stored
  // for included. Leaving stores them, so the next visit opens on that view.
  //
  // The switch is the point: the camera is written when the canvas unmounts,
  // and that is the path this walks.
  //
  // The Space needs something in it: framing an empty canvas moves nothing, so
  // there the reader's view is the identity whether it is stored or not, and
  // the case would pass on a canvas that stored the wrong thing.
  const ids = await stripIds(page);
  const looked = ids[2] as string;
  const elsewhere = ids[0] as string;
  const projectId = (projectUrl.split('/project/')[1] ?? '').slice(-36);
  await page.locator(`[data-testid="space-tab-${looked}"]`).click();
  await expect.poll(() => activeId(page)).toBe(looked);
  await seedImageNode(page, projectId, looked, { x: 2400, y: 1800 });
  await expect(page.locator('.react-flow__node')).toHaveCount(1, {
    timeout: 20_000,
  });
  // The framing waits for the node to measure, so wait for the camera to
  // settle away from the identity rather than for a fixed time.
  await expect
    .poll(() => camera(page).then((c) => c.x !== 0 || c.y !== 0), {
      timeout: 20_000,
    })
    .toBe(true);
  const onScreen = await camera(page);

  await page.locator(`[data-testid="space-tab-${elsewhere}"]`).click();
  await expect.poll(() => activeId(page)).toBe(elsewhere);
  await expect.poll(() => storedViewport(page, looked)).not.toBeNull();
  const kept = (await storedViewport(page, looked)) as {
    x: number;
    y: number;
    zoom: number;
  };
  expect({
    x: Math.round(kept.x),
    y: Math.round(kept.y),
    zoom: Number(kept.zoom.toFixed(3)),
  }).toEqual(onScreen);

  await page.locator(`[data-testid="space-tab-${looked}"]`).click();
  await expect.poll(() => activeId(page)).toBe(looked);
  expect(await camera(page)).toEqual(onScreen);
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

  await signOut(page, email as string);
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
  // Two accounts on two projects would also be two keys under a record keyed
  // by project alone, so say which level each id sits at. The route is
  // `/project/{slug}-{uuid}` and the record is keyed on the bare uuid.
  const mineProject = (projectUrl.split('/project/')[1] ?? '').slice(-36);
  const record = (await stored(page)) as Record<string, Record<string, unknown>>;
  expect(Object.keys(record)).not.toContain(mineProject);
  expect(Object.values(record).some((p) => mineProject in p)).toBe(true);

  await signOut(page, emailB as string);
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

test('opens on a Space again after the last one on the strip was deleted', async () => {
  // Deleting a Space drops its tab, and that is not the reader choosing an
  // empty strip. The record is left naming the deleted Space, so the next
  // visit filters it out and lands on the newest Space the way a first visit
  // does — rather than opening onto an empty tab bar for good.
  await page.goto(projectUrl);
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
  const doomed = await createSpace(page, 'canvas', `restore-deleted-${Date.now()}`);
  for (const id of await stripIds(page)) {
    if (id === doomed) continue;
    await page.locator(`[data-testid="space-tab-${id}"]`).hover();
    await page.locator(`[data-testid="space-tab-close-${id}"]`).click();
    await expect.poll(() => stripIds(page)).not.toContain(id);
  }
  expect(await stripIds(page)).toEqual([doomed]);

  await deleteSpace(page, doomed);
  await expect.poll(() => stripIds(page), { timeout: 20_000 }).toEqual([]);
  // The record was left alone, so it still names the Space that is gone.
  expect(JSON.stringify(await stored(page))).toContain(doomed);

  await page.goto(projectUrl);
  await expect(page.locator('.react-flow__pane').first()).toBeVisible({
    timeout: 20_000,
  });
  const back = await stripIds(page);
  expect(back).toHaveLength(1);
  expect(back).not.toContain(doomed);
});

test('keeps each project on its own strip when the browser goes back to it', async () => {
  // The browser's Back button can move the route straight from one project to
  // another without a document load. Everything on this page belongs to the
  // project in the address, so the page's identity has to be the project's.
  await page.goto('/studio');
  // Wait for the list: reading it while the page is still loading answers
  // "this account has no projects", which is the same shape as the truth.
  await expect(page.locator('a[href^="/project/"]').first()).toBeVisible({
    timeout: 20_000,
  });
  const hrefs = await page
    .locator('a[href^="/project/"]')
    .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href') ?? ''))]);
  if (hrefs.length < 2) {
    // Leave the page where the teardown expects it before standing down.
    await page.goto(projectUrl);
    await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
    test.skip(true, 'this account has only one project');
  }
  const [first, second] = hrefs as [string, string];

  // Every step from here is a client-side push, so the history entries share
  // one document and going back is a popstate rather than a fresh load.
  await page.locator(`a[href="${first}"]`).first().click();
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => stripIds(page), { timeout: 20_000 }).not.toHaveLength(0);
  const firstStrip = await stripIds(page);

  await page.locator('a[href="/studio"]').first().click();
  await expect(page.locator(`a[href="${second}"]`).first()).toBeVisible({ timeout: 20_000 });
  await page.locator(`a[href="${second}"]`).first().click();
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => stripIds(page), { timeout: 20_000 }).not.toHaveLength(0);
  const secondStrip = await stripIds(page);

  await page.evaluate(() => window.history.go(-2));
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => stripIds(page), { timeout: 20_000 }).toEqual(firstStrip);
  // And the record still says the same thing for both.
  const firstId = first.slice(-36);
  const record = (await stored(page)) as Record<string, Record<string, {
    tabs: Array<{ spaceId: string }>;
  }>>;
  const slot = Object.values(record).map((p) => p[firstId]).find(Boolean);
  expect(slot?.tabs.map((t) => t.spaceId)).toEqual(firstStrip);
  for (const id of secondStrip) expect(firstStrip).not.toContain(id);

  await page.goto(projectUrl);
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
});
