// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press, one execution, and the waiting survives closing what was pressed
 * (inner#1490).
 *
 * Seven buttons send a request the server runs once per `Idempotency-Key`.
 * Each press is held outside the panel, dialog or column it was made in, so a
 * reader who closes that and opens it again finds the button still waiting,
 * and pressing it again sends nothing. What no jsdom test reaches is the real
 * panel unmounting and mounting again around a request still on the wire.
 *
 * Every request under test is intercepted and held, so nothing is generated,
 * created or charged. The canvas ones are answered once the case has read what
 * it came for. The two checkouts are answered with a same-origin page standing
 * in for Stripe, which the case leaves with the browser's Back button. The new
 * project and the new conversation are left unanswered: a project's answer
 * moves the page into the new project, a conversation's would put one the
 * server never made into the Agent column, and a held request never reaches
 * the server.
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { randomUUID } from 'node:crypto';

import { expect, type Locator, type Page, type Route } from 'playwright/test';
import { test } from '../helpers/slot';

import { openTool, seedNode } from '../helpers/mini-tool';
import { openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';

// The Generate panel hangs below its node; a taller window keeps it reachable.
test.use({ viewport: { width: 1440, height: 1000 } });

/** A picture the browser draws with no network, for a node that shows one. */
const PICTURE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#2980b9"/></svg>',
)}`;

/**
 * How long a second press gets to send a request. A press that is not held
 * sends on the click itself, so this is well past the time it needs.
 */
const SECOND_PRESS_MS = 1_000;

/** POST requests to one path, held unanswered. */
interface HeldPosts {
  /** How many reached the route. */
  count: () => number;
  /** The `Idempotency-Key` each one carried, in order. */
  keys: string[];
  /** Answer every held request with 200 and `{ data }`. */
  answer: (data: unknown) => Promise<void>;
}

/**
 * Hold every POST to one path; any other method goes on to the server.
 * @param page - The page that will send them.
 * @param path - The request path, as `/api/v1/…`.
 * @returns The held requests.
 */
async function holdPosts(page: Page, path: string): Promise<HeldPosts> {
  const held: Route[] = [];
  const keys: string[] = [];
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      keys.push(route.request().headers()['idempotency-key'] ?? '');
      held.push(route);
    },
  );
  return {
    count: () => held.length,
    keys,
    answer: async (data) => {
      for (const route of held) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data }),
        });
      }
    },
  };
}

/**
 * Wait for the first press's request and check it carries a key.
 * @param held - The held requests.
 */
async function sentOnce(held: HeldPosts): Promise<void> {
  await expect.poll(held.count, { timeout: 20_000 }).toBe(1);
  expect(held.keys[0], 'the press carries an Idempotency-Key').toMatch(/\S/);
}

/**
 * The control, opened again, still waits, and pressing it sends nothing.
 *
 * Forced: a waiting control reads as disabled, and the point is that a press
 * which does reach it is swallowed.
 * @param page - The page.
 * @param control - The control pressed the first time.
 * @param held - The held requests.
 */
async function secondPressSendsNothing(
  page: Page,
  control: Locator,
  held: HeldPosts,
): Promise<void> {
  await expect(control).toHaveAttribute('aria-busy', 'true');
  await control.click({ force: true });
  await page.waitForTimeout(SECOND_PRESS_MS);
  expect(held.count()).toBe(1);
}

/** Where a checkout's answer sends the browser in place of Stripe. */
const STRIPE_STAND_IN = '/stripe-checkout-stand-in';

/**
 * Answer the held checkout, let the browser leave for the page standing in
 * for Stripe, and come back with the browser's Back button (A5, A7).
 *
 * The page comes back by loading again: Chromium under Playwright keeps no
 * page in the back-forward cache (it reports
 * `BackForwardCacheDisabledForDelegate`). A page restored from that cache is
 * pinned by the `pageshow` case in `stores/__tests__/run-once.test.ts`.
 * @param page - The page.
 * @param held - The held checkout requests.
 */
async function backFromStripe(page: Page, held: HeldPosts): Promise<void> {
  await page.route(
    (url) => url.pathname === STRIPE_STAND_IN,
    (route) => route.fulfill({ contentType: 'text/html', body: '<p>Checkout</p>' }),
  );
  const left = page.url();
  await held.answer({ url: STRIPE_STAND_IN });
  await page.waitForURL((url) => url.pathname === STRIPE_STAND_IN);
  await page.goBack();
  await page.waitForURL(left);
}

/** The canvas Space this case made, removed when it ends. */
let made: { page: Page; spaceId: string } | null = null;

test.afterEach(async () => {
  if (made !== null) await deleteSpace(made.page, made.spaceId);
  made = null;
});

/**
 * Open the smoke Project on a fresh canvas Space with one image node in it.
 * @param page - The page.
 * @param content - What the node shows; empty when omitted.
 * @returns The node's id.
 */
async function canvasWithImage(page: Page, content?: string): Promise<string> {
  await openSmokeProject(page);
  const spaceId = await createSpace(page, 'canvas', `run-once-${Date.now()}`);
  made = { page, spaceId };
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  const nodeId = randomUUID();
  await seedNode(
    page,
    { projectId: smokeProjectId(), spaceId },
    nodeId,
    'image',
    0,
    content === undefined ? {} : { content },
  );
  return nodeId;
}

/**
 * Right-click a node, which opens its menu.
 * @param page - The page.
 * @param nodeId - The node.
 */
async function openNodeMenu(page: Page, nodeId: string): Promise<void> {
  await visibleSpace(page)
    .locator(`.react-flow__node[data-id="${nodeId}"]`)
    .click({ button: 'right', position: { x: 4, y: 4 } });
}

/**
 * Open the Generate panel on a node from its menu.
 * @param page - The page.
 * @param nodeId - The node.
 */
async function openGenerate(page: Page, nodeId: string): Promise<void> {
  await openNodeMenu(page, nodeId);
  await page.getByTestId('node-menu-generate').click();
  await expect(visibleSpace(page).getByTestId('generate-prompt-editor')).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Open one of the account menu's panels.
 * @param page - A studio page.
 * @param entry - The menu row's name.
 */
async function openAccountPanel(page: Page, entry: 'Membership' | 'Credits'): Promise<void> {
  await page.getByRole('button', { name: 'Account' }).click();
  await page.getByTestId('account-menu').getByRole('menuitem', { name: entry }).click();
}

test('a Generate press keeps waiting after the panel closes and is sent once', async ({ page }) => {
  const nodeId = await canvasWithImage(page);
  const held = await holdPosts(page, '/api/v1/canvas/tasks');
  await openGenerate(page, nodeId);
  await visibleSpace(page).getByTestId('generate-prompt-editor').locator('.ProseMirror').click();
  await page.keyboard.type('a lighthouse at dusk');
  const execute = page.getByTestId('generate-execute');
  await expect(execute).toBeEnabled();
  await execute.click();
  await sentOnce(held);

  // The panel belongs to its node's selection: clicking the empty canvas closes it.
  await visibleSpace(page).locator('.react-flow__pane').click({ position: { x: 30, y: 30 } });
  await expect(visibleSpace(page).getByTestId('generate-prompt-editor')).toHaveCount(0);
  await openGenerate(page, nodeId);

  await secondPressSendsNothing(page, execute, held);
  await held.answer({ id: randomUUID(), status: 'queued' });
});

test('an Understand press waits on the menu item and builds one node', async ({ page }) => {
  const nodeId = await canvasWithImage(page, PICTURE);
  const held = await holdPosts(page, '/api/v1/canvas/understand');
  const nodes = visibleSpace(page).locator('.react-flow__node');
  await openNodeMenu(page, nodeId);
  await page.getByTestId('node-menu-understand').click();
  await sentOnce(held);
  // The press builds its text node before it sends.
  await expect(nodes).toHaveCount(2);

  // Choosing the item closed the menu; opened again, the item still waits.
  await openNodeMenu(page, nodeId);
  const item = page.getByTestId('node-menu-understand');
  await expect(item).toHaveAttribute('data-disabled', '');
  await secondPressSendsNothing(page, item, held);
  await expect(nodes).toHaveCount(2);
  await page.keyboard.press('Escape');
  await held.answer({ id: randomUUID(), status: 'queued' });
});

test('a mini-tool Run keeps waiting after its panel closes and builds once', async ({ page }) => {
  const nodeId = await canvasWithImage(page, PICTURE);
  const held = await holdPosts(page, '/api/v1/mini-tools');
  const nodes = visibleSpace(page).locator('.react-flow__node');
  await openTool(page, nodeId, 'image.upscale');
  const run = page.getByTestId('mini-tool-run');
  await expect(run).toBeEnabled({ timeout: 15_000 });
  await run.click();
  await sentOnce(held);
  await expect(nodes).toHaveCount(2);

  // The built result node is selected, which closes the panel by itself.
  await expect(page.getByTestId('mini-tool-panel-title')).toHaveCount(0);
  await openTool(page, nodeId, 'image.upscale');

  await secondPressSendsNothing(page, run, held);
  await expect(nodes).toHaveCount(2);
  await held.answer({ task_id: randomUUID(), status: 'pending' });
});

test('a new-conversation press keeps waiting after the Agent column is hidden', async ({ page }) => {
  await openSmokeProject(page);
  const held = await holdPosts(page, '/api/v1/chat/conversations');
  const column = page.getByTestId('agent-column');
  await expect(column).toBeVisible({ timeout: 20_000 });
  // eslint-disable-next-line no-restricted-syntax -- the answer is held on purpose, and startNewConversation waits for it.
  const newConversation = page.getByTestId('new-conversation');
  await newConversation.click();
  await sentOnce(held);

  await page.getByTestId('agent-toggle').click();
  await expect(column).toHaveCount(0);
  await page.getByTestId('agent-toggle').click();
  await expect(column).toBeVisible();

  await secondPressSendsNothing(page, newConversation, held);
});

/** The team Studio the new-project case picks; made once and kept, since a Studio cannot be deleted. */
const TEAM_STUDIO_NAME = 'Run once smoke';

/**
 * This account's team Studio for the new-project case, made the first time.
 * @param page - A signed-in page.
 * @returns Its name, as the dialog's Studio picker lists it.
 */
async function teamStudio(page: Page): Promise<string> {
  const listed = await page.request.get('/api/v1/studios');
  expect(listed.ok()).toBe(true);
  const { data } = (await listed.json()) as { data: { name: string; type: string }[] };
  if (!data.some((studio) => studio.type === 'team' && studio.name === TEAM_STUDIO_NAME)) {
    const made = await page.request.post('/api/v1/studios', {
      data: { name: TEAM_STUDIO_NAME, slug: `run-once-smoke-${Date.now().toString(36)}` },
    });
    expect(made.ok(), await made.text()).toBe(true);
  }
  return TEAM_STUDIO_NAME;
}

test('a project create in a team Studio keeps Create waiting when the dialog is opened from the other entry', async ({
  page,
}) => {
  const team = await teamStudio(page);
  const listed = await page.request.get('/api/v1/studios');
  const { data } = (await listed.json()) as { data: { slug: string; type: string }[] };
  const personal = data.find((studio) => studio.type === 'personal');
  if (personal === undefined) throw new Error('the smoke account has no personal studio');
  await page.goto(`/studio/${personal.slug}/projects`);
  const held = await holdPosts(page, '/api/v1/projects');

  const dialog = page.getByTestId('new-project-dialog');
  const create = dialog.getByRole('button', { name: 'Create', exact: true });
  await page.getByTestId('container-toolbar').getByRole('button', { name: 'New project' }).click();
  await expect(dialog).toBeVisible();
  await page.locator('#new-project-studio').click();
  await page.getByRole('option', { name: team, exact: true }).click();
  await page.locator('#new-project-name').fill('Run once');
  await page.locator('#new-project-slug').fill(`run-once-${Date.now()}`);
  await expect(create).toBeEnabled();
  await create.click();
  await sentOnce(held);

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The rail's entry opens a dialog of its own, on the default Studio.
  await page.getByTestId('rail-create-project').click();
  await expect(dialog).toBeVisible();

  await secondPressSendsNothing(page, create, held);
});

test('a membership checkout keeps its choice waiting after the panel closes @needs-payments', async ({
  page,
}) => {
  // `config/membership.yaml` gives every account on a local deployment the
  // self-hosted tier, which offers no plans; the panel is told the account is
  // on the free tier so it draws the cards this press is made on.
  await page.route('**/api/v1/account/membership', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data: Record<string, unknown> };
    await route.fulfill({ response, json: { ...body, data: { ...body.data, tier: 'base' } } });
  });
  await page.goto('/studio');
  const held = await holdPosts(page, '/api/v1/account/subscription/checkout');
  await openAccountPanel(page, 'Membership');
  const choose = page.getByTestId('membership-choose-pro');
  await expect(choose).toBeVisible({ timeout: 20_000 });
  await choose.click();
  await sentOnce(held);

  await page.keyboard.press('Escape');
  await expect(choose).toHaveCount(0);
  await openAccountPanel(page, 'Membership');
  await expect(choose).toBeVisible({ timeout: 20_000 });

  await secondPressSendsNothing(page, choose, held);

  await backFromStripe(page, held);
  await openAccountPanel(page, 'Membership');
  await expect(choose).toBeEnabled({ timeout: 20_000 });
  await expect(choose).not.toHaveAttribute('aria-busy', 'true');
});

test('a credits checkout keeps its pack waiting and holds every other pack @needs-payments', async ({
  page,
}) => {
  await page.goto('/studio');
  const held = await holdPosts(page, '/api/v1/payment/checkout');
  await openAccountPanel(page, 'Credits');
  await page.getByRole('tab', { name: 'Buy credits' }).click();
  const packs = page.getByTestId('credit-pack');
  await expect(packs.nth(1)).toBeVisible({ timeout: 20_000 });
  const pay = page.getByTestId('confirm-pay');

  await packs.nth(0).getByRole('button', { name: 'Buy' }).click();
  await page.getByTestId('confirm-consent').click();
  await pay.click();
  await sentOnce(held);

  await page.keyboard.press('Escape');
  await expect(pay).toHaveCount(0);
  await packs.nth(0).getByRole('button', { name: 'Buy' }).click();
  await secondPressSendsNothing(page, pay, held);

  // Another pack's Pay holds without saying it is the one waiting.
  await page.keyboard.press('Escape');
  await expect(pay).toHaveCount(0);
  await packs.nth(1).getByRole('button', { name: 'Buy' }).click();
  await expect(pay).toBeDisabled();
  await expect(pay).not.toHaveAttribute('aria-busy', 'true');

  await backFromStripe(page, held);
  await openAccountPanel(page, 'Credits');
  await page.getByRole('tab', { name: 'Buy credits' }).click();
  await packs.nth(0).getByRole('button', { name: 'Buy' }).click();
  await page.getByTestId('confirm-consent').click();
  await expect(pay).toBeEnabled();
  await expect(pay).not.toHaveAttribute('aria-busy', 'true');
});
