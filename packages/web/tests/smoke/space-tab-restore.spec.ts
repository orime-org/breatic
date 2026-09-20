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
 * Each case opens a browser that has not been here and builds the strip it
 * asks about; the openings and the readings are in
 * `tests/helpers/tab-restore`.
 *
 * Two accounts, because one case asks what one account's record does to the
 * other's and that can only be asked by changing who is signed in:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { expect, test, type Locator, type Page } from 'playwright/test';

import { credentialsFor } from '../helpers/credentials';
import { openSmokeProject, smokeProjectUrl } from '../helpers/project';
import { signIn, signOut } from '../helpers/session';
import { createSpace, deleteSpace } from '../helpers/space';
import {
  VIEWPORT,
  activeId,
  addSpaces,
  camera,
  openFreshProject,
  projectIdOf,
  seedImageNode,
  stored,
  storedViewport,
  stripIds,
} from '../helpers/tab-restore';

test('lands on one Space and remembers it', async ({ page }) => {
  await openFreshProject(page);

  expect(await stripIds(page)).toHaveLength(1);
  // The landing is stored straight away, so a reload has something to open on.
  await expect.poll(() => stored(page)).not.toBeNull();
});

test('brings three tabs and the one that was showing back through a reload', async ({ page }) => {
  await openFreshProject(page);
  await addSpaces(page, 2);
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

test('keeps the camera of a Space the reader only looked at', async ({ page }) => {
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
  const projectUrl = await openFreshProject(page);
  const [looked] = await addSpaces(page, 1);
  const elsewhere = (await stripIds(page)).find((id) => id !== looked) as string;
  await page.locator(`[data-testid="space-tab-${looked}"]`).click();
  await expect.poll(() => activeId(page)).toBe(looked as string);
  await seedImageNode(page, projectIdOf(projectUrl), looked as string, { x: 2400, y: 1800 });
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
  await expect.poll(() => storedViewport(page, looked as string)).not.toBeNull();
  const kept = (await storedViewport(page, looked as string)) as {
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
  await expect.poll(() => activeId(page)).toBe(looked as string);
  expect(await camera(page)).toEqual(onScreen);
});

test('frames a Space it has no camera for', async ({ page }) => {
  // A5: a Space this account has never opened has no camera to keep, so the
  // canvas frames its content, the way it did before any of this was stored.
  // A Space with a node in it and its camera forgotten is in the state a Space
  // nobody has opened is in.
  const projectUrl = await openFreshProject(page);
  const [target] = await addSpaces(page, 1);
  await page.locator(`[data-testid="space-tab-${target}"]`).click();
  await expect.poll(() => activeId(page)).toBe(target as string);
  await seedImageNode(page, projectIdOf(projectUrl), target as string, { x: 2400, y: 1800 });
  await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 20_000 });

  await page.evaluate((id) => {
    const raw = window.localStorage.getItem('breatic.projectTabs');
    if (raw === null) return;
    type Slot = { tabs?: Array<{ spaceId: string; viewport: unknown }> };
    const record = JSON.parse(raw) as Record<string, Record<string, Slot>>;
    for (const forUser of Object.values(record)) {
      for (const slot of Object.values(forUser)) {
        for (const tab of slot.tabs ?? []) {
          if (tab.spaceId === id) tab.viewport = null;
        }
      }
    }
    window.localStorage.setItem('breatic.projectTabs', JSON.stringify(record));
  }, target);
  expect(await storedViewport(page, target as string)).toBeNull();

  await page.reload();
  await expect(page.locator('.react-flow__pane').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.locator(`[data-testid="space-tab-${target}"]`).click();
  await expect.poll(() => activeId(page)).toBe(target as string);
  // The framing moved the camera off the identity, and the node it framed is
  // on the screen.
  await expect
    .poll(() => camera(page).then((c) => c.x !== 0 || c.y !== 0), {
      timeout: 20_000,
    })
    .toBe(true);
  const node = page.locator('.react-flow__node').first();
  await expect(node).toBeInViewport({ timeout: 20_000 });
});

test('comes back to the camera the user aimed, across a switch and a reload', async ({ page }) => {
  await openFreshProject(page);
  await addSpaces(page, 1);
  const [first, second] = (await stripIds(page)) as [string, string];
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

test('remembers a camera aimed from the minimap, which carries no pointer event', async ({
  page,
}) => {
  // The minimap ships on and is `pannable zoomable`, so it is one of the ways
  // a person aims a Space. It drives the camera through the library, so the
  // move arrives with no DOM event — the same shape as the automatic framing.
  const projectUrl = await openFreshProject(page);
  const [target] = await addSpaces(page, 1);
  const other = (await stripIds(page)).find((id) => id !== target) as string;
  await page.locator(`[data-testid="space-tab-${target}"]`).click();
  await expect.poll(() => activeId(page)).toBe(target as string);
  // A node to aim at: dragging the minimap of an empty canvas moves nothing.
  await seedImageNode(page, projectIdOf(projectUrl), target as string, { x: 2400, y: 1800 });
  await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 20_000 });

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

  // And it is still there after a switch away and back.
  await page.locator(`[data-testid="space-tab-${other}"]`).click();
  await expect.poll(() => activeId(page)).toBe(other);
  await page.locator(`[data-testid="space-tab-${target}"]`).click();
  await expect.poll(() => activeId(page)).toBe(target as string);
  expect(await camera(page)).toEqual(aimed);
});

test('keeps a closed tab closed, and an emptied strip empty', async ({ page }) => {
  await openFreshProject(page);
  await addSpaces(page, 2);
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

test('keeps one account’s strip out of the next account’s hands', async ({ browser }) => {
  // One browser, two accounts. The record is addressed by account, and the
  // only way to see that on the real path is to change who is signed in:
  // reading a key nobody ever wrote is true of any record.
  //
  // The second account walks its OWN project, not this one. Measured: opening
  // a project it is not a member of answers "Your session is invalid" with an
  // empty strip, so a shared project would ask a membership question instead
  // of this one.
  //
  // This case signs the first account in for itself rather than opening on
  // the session setup stored. Signing out invalidates the session the cookie
  // names (`POST /auth/logout` invalidates the current one), and the stored
  // cookie names the one every other case opens with — measured: the two
  // cases after this one then found a project page with no canvas on it.
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const first = credentialsFor('A');
  await signIn(page, first.email, first.password);
  const projectUrl = await openFreshProject(page);
  // Made and removed here rather than through `addSpaces`: the shared hook
  // removes Spaces with the page the fixture hands it, and this case works in
  // a context of its own that hook never sees.
  const created = await createSpace(page, 'canvas', `restore-boundary-${Date.now()}`);
  await expect.poll(() => stripIds(page), { timeout: 20_000 }).toContain(created);
  const strip = await stripIds(page);
  expect(strip).toContain(created);
  // The strip is painted before it is stored, so wait for the write rather
  // than snapshotting a record the new tab has not reached yet.
  await expect
    .poll(() => stored(page).then((r) => JSON.stringify(r).includes(created as string)))
    .toBe(true);
  const asLeft = await stored(page);

  const second = credentialsFor('B');
  await signOut(page);
  await signIn(page, second.email, second.password);
  await openSmokeProject(page, 'B');
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
  // by project alone, so say which level each id sits at.
  const mineProject = projectIdOf(projectUrl);
  const record = (await stored(page)) as Record<string, Record<string, unknown>>;
  expect(Object.keys(record)).not.toContain(mineProject);
  expect(Object.values(record).some((p) => mineProject in p)).toBe(true);

  await signOut(page);
  await signIn(page, first.email, first.password);
  await page.goto(projectUrl);
  await expect.poll(() => stripIds(page), { timeout: 20_000 }).toEqual(strip);
  // Untouched, not merely restored: the other account's visit added a key and
  // changed nothing under this one.
  const back = (await stored(page)) as Record<string, unknown>;
  const left = asLeft as Record<string, unknown>;
  for (const [user, projects] of Object.entries(left)) {
    expect(back[user]).toEqual(projects);
  }
  await deleteSpace(page, created);
  await context.close();
});

test('opens on a Space again after the last one on the strip was deleted', async ({ page }) => {
  // Deleting a Space drops its tab, and that is not the reader choosing an
  // empty strip. The record is left naming the deleted Space, so the next
  // visit filters it out and lands on the newest Space the way a first visit
  // does — rather than opening onto an empty tab bar for good.
  const projectUrl = await openFreshProject(page);
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

/**
 * The studio's link to one Project.
 *
 * The route is `/project/{slug}-{uuid}` and the addresses setup records are
 * the bare uuid, which `page.goto` accepts and an `href` match does not.
 * @param page - A page showing the studio.
 * @param projectUrl - The address setup recorded.
 * @returns The anchor.
 */
function linkTo(page: Page, projectUrl: string): Locator {
  return page.locator(`a[href$="${projectUrl.slice(-36)}"]`).first();
}

test('keeps each project on its own strip when the browser goes back to it', async ({ page }) => {
  // The browser's Back button can move the route straight from one project to
  // another without a document load. Everything on this page belongs to the
  // project in the address, so the page's identity has to be the project's.
  await openFreshProject(page);
  const [first, second] = [smokeProjectUrl('A', 0), smokeProjectUrl('A', 1)];

  // The studio lists projects under "Recent", so a project this browser has
  // never opened carries no link to click — measured: with only the first one
  // visited, the studio drew one project link and the second was absent.
  await page.goto(second);
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });

  // From the studio, where the projects are listed. A project page carries no
  // link to a project — measured: its only links are Home and Back to Studio,
  // both to `/studio`.
  //
  // Every step from here is a client-side push, so the history entries share
  // one document and going back is a popstate rather than a fresh load.
  await page.goto('/studio');
  await linkTo(page, first).click();
  await expect(page.getByTestId('new-space-button')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => stripIds(page), { timeout: 20_000 }).not.toHaveLength(0);
  const firstStrip = await stripIds(page);

  await page.locator('a[href="/studio"]').first().click();
  await expect(linkTo(page, second)).toBeVisible({ timeout: 20_000 });
  await linkTo(page, second).click();
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
});
