// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Canvas gesture sync E2E (#2010) — the half no jsdom test can reach.
 *
 * The unit tests drive one side of the wire each: what a gesture publishes,
 * what a reader collects, what the merge stage draws. What none of them can
 * answer is whether a mouse held down in one browser moves a node in another,
 * which is the whole of what was asked for. That needs two live connections to
 * one collab server plus a real pointer, which is what this file sets up.
 *
 * Two pages in ONE context, not two accounts: the gesture field keys on the
 * connection, so a second tab is a peer in every way that matters here.
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

// `mover` drags and `watcher` reads what it sees.
let context: BrowserContext;
let mover: Page;
let watcher: Page;
let projectId = '';
let spaceId = '';

// A ceiling for a round trip through the collab server, not a sleep: every
// wait below polls.
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
 * Reach the live canvas modules inside a page.
 *
 * Vite serves each module under a versioned URL; importing the bare path would
 * evaluate a SECOND copy whose caches are empty. The body is handed `canvas`
 * (the space's own writes) and `manager` (the document behind them).
 * @param page - A page with the Space open.
 * @param body - What to do with the modules, given the project and space ids.
 * @param arg - One extra value to hand the body.
 * @returns Whatever the body returns.
 */
async function withCanvasModule<T, A>(
  page: Page,
  body: string,
  arg: A,
): Promise<T> {
  return page.evaluate(
    async ([pid, sid, source, extra]: [string, string, string, unknown]) => {
      const live = (re: RegExp): string => {
        const found = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n));
        if (found === undefined) {
          throw new Error(`no loaded module matches ${re.source}`);
        }
        return found;
      };
      const canvas = await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      );
      const manager = await import(
        /* @vite-ignore */ live(/data\/yjs\/manager\.ts/)
      );
      const run = new Function(
        'canvas',
        'manager',
        'pid',
        'sid',
        'extra',
        source,
      ) as (c: unknown, m: unknown, p: string, s: string, e: unknown) => unknown;
      return run(canvas, manager, pid, sid, extra) as unknown;
    },
    [projectId, spaceId, body, arg] as [string, string, string, unknown],
  ) as Promise<T>;
}

/**
 * Write one image node into the open Space's Yjs document.
 * @param page - A page with the Space open.
 * @param nodeId - The id to give the node.
 * @param at - Where to put it, in canvas coordinates.
 */
async function seedImageNode(
  page: Page,
  nodeId: string,
  at: { x: number; y: number },
): Promise<void> {
  await withCanvasModule(
    page,
    `canvas.addNode(pid, sid, {
      id: extra.id,
      type: 'image',
      position: { x: extra.x, y: extra.y },
      data: {
        name: 'gesture-e2e',
        createdAt: Date.now(),
        createdBy: 'gesture-e2e',
        locked: false,
        state: 'idle',
        attachments: [],
        content: extra.png,
      },
    });`,
    { id: nodeId, x: at.x, y: at.y, png: SOLID_PNG },
  );
  const stored = await documentPosition(page, nodeId);
  if (stored === null) throw new Error(`${nodeId} never reached the document`);
}

/** Where every case seeds its node: inside the viewport `fitView` settled on. */
const SEED_AT = { x: 200, y: 200 };

/**
 * Write a Group holding one image node into the open Space's document.
 * @param page - A page with the Space open.
 * @param groupId - The id to give the Group.
 * @param memberId - The id to give its member.
 */
async function seedGroupWithMember(
  page: Page,
  groupId: string,
  memberId: string,
): Promise<void> {
  await withCanvasModule(
    page,
    `const base = {
      createdAt: Date.now(),
      createdBy: 'gesture-e2e',
      locked: false,
      state: 'idle',
      attachments: [],
    };
    canvas.addNode(pid, sid, {
      id: extra.memberId,
      type: 'image',
      position: { x: extra.x + 24, y: extra.y + 24 },
      data: { ...base, name: 'gesture-e2e-member', content: extra.png },
    });
    canvas.createGroup(
      pid,
      sid,
      {
        id: extra.groupId,
        type: 'group',
        position: { x: extra.x, y: extra.y },
        data: { ...base, name: 'gesture-e2e-group', width: 420, height: 320 },
      },
      [{ id: extra.memberId, position: { x: 24, y: 24 } }],
    );`,
    { groupId, memberId, x: SEED_AT.x, y: SEED_AT.y, png: SOLID_PNG },
  );
}

/**
 * Take a node back out of the document.
 * @param page - A page with the Space open.
 * @param nodeId - The node to remove.
 */
async function removeNode(page: Page, nodeId: string): Promise<void> {
  await withCanvasModule(page, 'canvas.removeNode(pid, sid, extra);', nodeId);
}

/**
 * What the document says a node's position is.
 * @param page - A page with the Space open.
 * @param nodeId - The node to read.
 * @returns Its stored position, or null when the document has no such node.
 */
async function documentPosition(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number } | null> {
  return withCanvasModule<{ x: number; y: number } | null, string>(
    page,
    `const found = canvas.readCanvasGraph(pid, sid).nodes.find((n) => n.id === extra);
     return found ? { x: found.position.x, y: found.position.y } : null;`,
    nodeId,
  );
}

/**
 * Where a page is drawing a node right now, in screen coordinates.
 * @param page - The page to read.
 * @param nodeId - The node to find.
 * @returns Its top-left on screen, or null when it is not rendered.
 */
async function drawnAt(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number } | null> {
  const box = await page
    .locator(`.react-flow__node[data-id="${nodeId}"]`)
    .boundingBox();
  return box === null ? null : { x: box.x, y: box.y };
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

/**
 * Drag a node with a real pointer, sampling the watcher as it goes.
 *
 * The samples are what the acceptance asks about: a collaborator has to see
 * the movement itself, not only its result, so at least one of them has to
 * land strictly between the start and the end.
 * @param nodeId - The node to drag.
 * @param by - How far to move it, in screen pixels.
 * @returns Where the watcher drew the node at each sample.
 */
async function dragAndSample(
  nodeId: string,
  by: { dx: number; dy: number },
): Promise<Array<{ x: number; y: number }>> {
  const from = await drawnAt(mover, nodeId);
  if (from === null) throw new Error(`${nodeId} is not on the mover's canvas`);
  const grabX = from.x + 40;
  const grabY = from.y + 40;

  await mover.mouse.move(grabX, grabY);
  await mover.mouse.down();

  const samples: Array<{ x: number; y: number }> = [];
  const STEPS = 8;
  for (let step = 1; step <= STEPS; step += 1) {
    await mover.mouse.move(
      grabX + (by.dx * step) / STEPS,
      grabY + (by.dy * step) / STEPS,
    );
    // Give the publish rate limit (33ms) a window to send, and the watcher one
    // to paint what arrived.
    await mover.waitForTimeout(90);
    const seen = await drawnAt(watcher, nodeId);
    if (seen !== null) samples.push(seen);
  }
  await mover.mouse.up();
  return samples;
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1680, height: 950 } });
  mover = await context.newPage();
  await signIn(mover);

  // Reuse an existing Project: this spec is about gestures, and minting one per
  // run burns the tier's projects-per-studio allowance.
  await mover.goto('/studio');
  const firstProject = mover.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await mover.waitForURL(/\/project\//, { timeout: 15_000 });
  projectId = (/([0-9a-f-]{36})$/.exec(mover.url()) ?? [])[1] as string;

  spaceId = await createSpace(mover, 'canvas', `gesture-e2e-${Date.now()}`);
  await expect(mover.locator('.react-flow')).toBeVisible({ timeout: 20_000 });

  watcher = await context.newPage();
  await openTheSpace(watcher);
});

test.afterAll(async () => {
  await watcher?.close();
  if (spaceId !== '' && mover !== undefined) {
    await deleteSpace(mover, spaceId);
  }
  await context?.close();
});

// Seeding a Space and two live collab connections outlasts the suite-wide 30s
// budget before a single assertion runs.
test.setTimeout(120_000);

test('a drag in progress moves the node on the other connection', async () => {
  const nodeId = `drag-one-${Date.now()}`;
  await seedImageNode(mover, nodeId, SEED_AT);
  await expect(
    watcher.locator(`.react-flow__node[data-id="${nodeId}"]`),
  ).toBeVisible({ timeout: SETTLE_MS });

  const before = await drawnAt(watcher, nodeId);
  const samples = await dragAndSample(nodeId, { dx: 240, dy: 160 });
  const after = await drawnAt(watcher, nodeId);

  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  // Acceptance 1: the watcher saw the movement itself, not just its result.
  const midway = samples.filter(
    (s) =>
      s.x > (before as { x: number }).x + 20 &&
      s.x < (after as { x: number }).x - 20,
  );
  expect(midway.length).toBeGreaterThan(0);
  await removeNode(mover, nodeId);
});

test('both sides agree once the drag ends, with no second jump', async () => {
  const nodeId = `drag-settle-${Date.now()}`;
  await seedImageNode(mover, nodeId, SEED_AT);
  await expect(
    watcher.locator(`.react-flow__node[data-id="${nodeId}"]`),
  ).toBeVisible({ timeout: SETTLE_MS });

  await dragAndSample(nodeId, { dx: 200, dy: 0 });

  // Acceptance 5: what the watcher draws right after the release is where it
  // stays. A handover that let the document write land before the final
  // awareness value would show up as a move between these two reads.
  const justAfter = await drawnAt(watcher, nodeId);
  await watcher.waitForTimeout(SETTLE_MS);
  const later = await drawnAt(watcher, nodeId);
  expect(later).toEqual(justAfter);

  // And the document carries the same place both are drawing.
  const stored = await documentPosition(watcher, nodeId);
  const onMover = await drawnAt(mover, nodeId);
  expect(stored).not.toBeNull();
  expect(later?.x).toBeCloseTo(onMover?.x ?? -1, 0);
  await removeNode(mover, nodeId);
});

test('the document takes one write for the whole gesture', async () => {
  const nodeId = `drag-writes-${Date.now()}`;
  await seedImageNode(mover, nodeId, SEED_AT);
  await expect(
    watcher.locator(`.react-flow__node[data-id="${nodeId}"]`),
  ).toBeVisible({ timeout: SETTLE_MS });

  // Acceptance 9: count the document's own position events for this node
  // across the drag. Byte growth cannot tell one write from ten.
  await withCanvasModule(
    watcher,
    `const doc = manager.getDoc(manager.docName.canvasSpace(pid, sid));
     window.__gestureWrites = 0;
     window.__gestureObserver = (events) => {
       for (const e of events) {
         if (e.path.length === 1 && e.path[0] === extra) window.__gestureWrites += 1;
       }
     };
     doc.getMap('nodesMap').observeDeep(window.__gestureObserver);`,
    nodeId,
  );

  await dragAndSample(nodeId, { dx: 180, dy: 60 });
  await watcher.waitForTimeout(SETTLE_MS);

  const writes = await watcher.evaluate(
    () => (window as unknown as { __gestureWrites: number }).__gestureWrites,
  );
  expect(writes).toBe(1);
  await removeNode(mover, nodeId);
});

test('a remote write during a drag leaves both sides where they are', async () => {
  const dragged = `drag-hold-${Date.now()}`;
  const other = `drag-other-${Date.now()}`;
  await seedImageNode(mover, dragged, SEED_AT);
  await seedImageNode(mover, other, { x: SEED_AT.x + 360, y: SEED_AT.y });
  await expect(
    watcher.locator(`.react-flow__node[data-id="${dragged}"]`),
  ).toBeVisible({ timeout: SETTLE_MS });

  const from = await drawnAt(mover, dragged);
  if (from === null) throw new Error('the node is not on the canvas');
  await mover.mouse.move(from.x + 40, from.y + 40);
  await mover.mouse.down();
  await mover.mouse.move(from.x + 140, from.y + 40);
  await mover.waitForTimeout(120);

  const moverMid = await drawnAt(mover, dragged);
  const watcherMid = await drawnAt(watcher, dragged);

  // The watcher writes an unrelated node mid-gesture: the same shape as a
  // generation landing, which needs nobody at the keyboard.
  await withCanvasModule(
    watcher,
    'canvas.setNodeName(pid, sid, extra, \'renamed-mid-gesture\');',
    other,
  );
  await mover.waitForTimeout(SETTLE_MS / 2);

  // Acceptance 6 and 7: neither side's dragged node moved because of it.
  expect(await drawnAt(mover, dragged)).toEqual(moverMid);
  expect(await drawnAt(watcher, dragged)).toEqual(watcherMid);

  await mover.mouse.up();
  await removeNode(mover, dragged);
  await removeNode(mover, other);
});

test('a marquee drag moves the whole batch on the other connection', async () => {
  const left = `marquee-left-${Date.now()}`;
  const right = `marquee-right-${Date.now()}`;
  await seedImageNode(mover, left, SEED_AT);
  await seedImageNode(mover, right, { x: SEED_AT.x + 360, y: SEED_AT.y });
  for (const id of [left, right]) {
    await expect(
      watcher.locator(`.react-flow__node[data-id="${id}"]`),
    ).toBeVisible({ timeout: SETTLE_MS });
  }

  // Rubber-band over both, starting on empty canvas above and left of them.
  const leftBox = await drawnAt(mover, left);
  const rightBox = await drawnAt(mover, right);
  if (leftBox === null || rightBox === null) throw new Error('nodes missing');
  await mover.mouse.move(leftBox.x - 60, leftBox.y - 60);
  await mover.mouse.down();
  await mover.mouse.move(rightBox.x + 360, rightBox.y + 300, { steps: 10 });
  await mover.mouse.up();
  await expect(
    mover.locator(`.react-flow__node[data-id="${left}"]`),
  ).toHaveClass(/selected/, { timeout: SETTLE_MS });
  await expect(
    mover.locator(`.react-flow__node[data-id="${right}"]`),
  ).toHaveClass(/selected/, { timeout: SETTLE_MS });

  const beforeLeft = await drawnAt(watcher, left);
  const beforeRight = await drawnAt(watcher, right);
  if (beforeLeft === null || beforeRight === null) throw new Error('nodes missing');
  const gap = beforeRight.x - beforeLeft.x;

  // Drag by the left one; the selection carries the right one with it.
  const samplesRight: Array<{ x: number; y: number }> = [];
  await mover.mouse.move(leftBox.x + 40, leftBox.y + 40);
  await mover.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await mover.mouse.move(leftBox.x + 40 + step * 30, leftBox.y + 40);
    await mover.waitForTimeout(90);
    const seen = await drawnAt(watcher, right);
    if (seen !== null) samplesRight.push(seen);
  }
  await mover.mouse.up();

  // Acceptance 2: the watcher saw the second node move too, and the two kept
  // the distance they started with.
  const movedRight = samplesRight.filter((s) => s.x > beforeRight.x + 20);
  expect(movedRight.length).toBeGreaterThan(0);

  await mover.waitForTimeout(SETTLE_MS / 2);
  const afterLeft = await drawnAt(watcher, left);
  const afterRight = await drawnAt(watcher, right);
  expect((afterRight?.x ?? 0) - (afterLeft?.x ?? 0)).toBeCloseTo(gap, 0);

  await removeNode(mover, left);
  await removeNode(mover, right);
});

test('dragging a Group carries its member on the other connection', async () => {
  const groupId = `group-drag-${Date.now()}`;
  const memberId = `group-member-${Date.now()}`;
  await seedGroupWithMember(mover, groupId, memberId);
  await expect(
    watcher.locator(`.react-flow__node[data-id="${memberId}"]`),
  ).toBeVisible({ timeout: SETTLE_MS });

  const groupBox = await drawnAt(mover, groupId);
  const beforeMember = await drawnAt(watcher, memberId);
  if (groupBox === null || beforeMember === null) throw new Error('group missing');

  // Grab the Group by its header strip, above where the member sits.
  const samples: Array<{ x: number; y: number }> = [];
  await mover.mouse.move(groupBox.x + 200, groupBox.y + 8);
  await mover.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await mover.mouse.move(groupBox.x + 200 + step * 30, groupBox.y + 8);
    await mover.waitForTimeout(90);
    const seen = await drawnAt(watcher, memberId);
    if (seen !== null) samples.push(seen);
  }
  await mover.mouse.up();

  // Acceptance 3: the member travelled with the Group, live.
  expect(samples.filter((s) => s.x > beforeMember.x + 20).length).toBeGreaterThan(0);

  await removeNode(mover, memberId);
  await removeNode(mover, groupId);
});

test('resizing a Group moves its frame while its member stays put', async () => {
  const groupId = `group-resize-${Date.now()}`;
  const memberId = `resize-member-${Date.now()}`;
  await seedGroupWithMember(mover, groupId, memberId);
  await expect(
    watcher.locator(`.react-flow__node[data-id="${memberId}"]`),
  ).toBeVisible({ timeout: SETTLE_MS });

  // The resize chrome only renders on a selected, unlocked Group.
  await mover.locator(`.react-flow__node[data-id="${groupId}"]`).click({
    position: { x: 200, y: 8 },
  });
  const control = mover
    .locator(`.react-flow__node[data-id="${groupId}"] .react-flow__resize-control.right`)
    .first();
  await expect(control).toBeVisible({ timeout: SETTLE_MS });

  const groupBefore = await watcher
    .locator(`.react-flow__node[data-id="${groupId}"]`)
    .boundingBox();
  const memberBefore = await drawnAt(watcher, memberId);
  const handle = await control.boundingBox();
  if (groupBefore === null || memberBefore === null || handle === null) {
    throw new Error('resize chrome missing');
  }

  const widths: number[] = [];
  await mover.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await mover.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await mover.mouse.move(
      handle.x + handle.width / 2 + step * 30,
      handle.y + handle.height / 2,
    );
    await mover.waitForTimeout(90);
    const box = await watcher
      .locator(`.react-flow__node[data-id="${groupId}"]`)
      .boundingBox();
    if (box !== null) widths.push(box.width);
  }
  await mover.mouse.up();

  // Acceptance 4: the frame grew live on the watcher, and the member did not
  // drift while it did.
  expect(widths.filter((w) => w > groupBefore.width + 20).length).toBeGreaterThan(0);
  const memberAfter = await drawnAt(watcher, memberId);
  expect(memberAfter?.x).toBeCloseTo(memberBefore.x, 0);
  expect(memberAfter?.y).toBeCloseTo(memberBefore.y, 0);

  await removeNode(mover, memberId);
  await removeNode(mover, groupId);
});

test('one undo puts the whole gesture back', async () => {
  const nodeId = `undo-${Date.now()}`;
  await seedImageNode(mover, nodeId, SEED_AT);
  await expect(
    watcher.locator(`.react-flow__node[data-id="${nodeId}"]`),
  ).toBeVisible({ timeout: SETTLE_MS });
  const started = await documentPosition(mover, nodeId);

  await dragAndSample(nodeId, { dx: 220, dy: 120 });
  await mover.waitForTimeout(SETTLE_MS / 2);
  const moved = await documentPosition(mover, nodeId);
  expect(moved).not.toEqual(started);

  // Acceptance 8: the intermediate geometry never entered the document, so the
  // gesture is one entry in the undo stack.
  await mover.locator('.react-flow').click({ position: { x: 700, y: 60 } });
  await mover.keyboard.press('ControlOrMeta+z');
  await expect
    .poll(async () => documentPosition(mover, nodeId), { timeout: SETTLE_MS })
    .toEqual(started);

  await removeNode(mover, nodeId);
});

test('a Group grows once, at the end of the drag that fills it', async () => {
  const groupId = `grow-group-${Date.now()}`;
  const memberId = `grow-member-${Date.now()}`;
  const incomingId = `grow-incoming-${Date.now()}`;
  await seedGroupWithMember(mover, groupId, memberId);
  await seedImageNode(mover, incomingId, { x: SEED_AT.x + 620, y: SEED_AT.y });
  await expect(
    watcher.locator(`.react-flow__node[data-id="${incomingId}"]`),
  ).toBeVisible({ timeout: SETTLE_MS });

  // Count what the document hears about the Group across the whole gesture.
  await withCanvasModule(
    watcher,
    `const doc = manager.getDoc(manager.docName.canvasSpace(pid, sid));
     window.__groupWrites = 0;
     window.__groupObserver = (events) => {
       for (const e of events) {
         if (e.path.length === 1 && e.path[0] === extra) window.__groupWrites += 1;
       }
     };
     doc.getMap('nodesMap').observeDeep(window.__groupObserver);`,
    groupId,
  );

  // Drag the loose node into the Group.
  const from = await drawnAt(mover, incomingId);
  const target = await drawnAt(mover, groupId);
  if (from === null || target === null) throw new Error('nodes missing');
  await mover.mouse.move(from.x + 40, from.y + 40);
  await mover.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await mover.mouse.move(
      from.x + 40 + ((target.x + 200 - (from.x + 40)) * step) / 6,
      from.y + 40 + ((target.y + 200 - (from.y + 40)) * step) / 6,
    );
    await mover.waitForTimeout(90);
  }
  await mover.mouse.up();
  await mover.waitForTimeout(SETTLE_MS);

  // The count only means something once the node really landed inside.
  const parentId = await withCanvasModule<string | null, string>(
    watcher,
    `const found = canvas.readCanvasGraph(pid, sid).nodes.find((n) => n.id === extra);
     return found ? found.parentId ?? null : null;`,
    incomingId,
  );
  expect(parentId).toBe(groupId);

  // Acceptance 11: the Group's own geometry moved at the release, and only
  // there — a mid-gesture expansion would show up as several writes.
  const writes = await watcher.evaluate(
    () => (window as unknown as { __groupWrites: number }).__groupWrites,
  );
  expect(writes).toBeLessThanOrEqual(1);

  await removeNode(mover, incomingId);
  await removeNode(mover, memberId);
  await removeNode(mover, groupId);
});
