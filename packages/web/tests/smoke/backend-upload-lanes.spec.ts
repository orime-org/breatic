// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A generation's own output reaching R2 (#181, lane ③) — the half no unit test
 * reaches.
 *
 * An async provider answers with a link that expires, and the bytes behind it
 * are pulled by the ingest Worker where R2 already is. What no test below a
 * running stack can answer is whether that whole round trip holds: our worker
 * opens a grant, signs a ticket, hands the Worker the link, the Worker fetches
 * it and hashes what landed, our server files it, and the url the node ends up
 * pinning is the one the ledger holds — not the provider's, which stops
 * answering.
 *
 * The check is on the host of the url the node kept. A node still pointing at
 * the provider means the transfer never happened; a node pointing at our own
 * resource host means every step above ran.
 *
 * Needs a running dev stack (`pnpm dev`, which includes the ingest Worker), a
 * provider key for the model below, and a smoke account:
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

let context: BrowserContext;
let page: Page;
let projectId = '';
let spaceId = '';

/** A 1x1 PNG, small enough to be one part and to decode with no network. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Sign a page in and leave it wherever the app lands after login.
 * @param target - A fresh page.
 * @throws {Error} When the sign-in never leaves the login route.
 */
async function signIn(target: Page): Promise<void> {
  await target.goto('/login');
  await target.locator('#login-email').fill(email as string);
  await target.locator('#login-password').fill(password as string);
  await target.locator('form button[type="submit"]').click();
  await target.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

/**
 * Drop one file onto the canvas the way a user does.
 *
 * The drop is built in the page so the `DataTransfer` belongs to the same
 * realm the listener reads it in.
 * @param target - A page with a canvas Space open.
 * @param name - The file name to drop under.
 * @param type - The MIME type the browser would report.
 * @param bytes - The file's contents.
 */
async function dropFile(
  target: Page,
  name: string,
  type: string,
  bytes: Buffer,
): Promise<void> {
  await target.evaluate(
    async ([fileName, mime, encoded]: [string, string, string]) => {
      const binary = atob(encoded);
      const buffer = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
      const file = new File([buffer], fileName, { type: mime });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const pane = document.querySelector('.react-flow__pane');
      if (pane === null) throw new Error('no canvas pane to drop onto');
      const rect = pane.getBoundingClientRect();
      const at = {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        bubbles: true,
        cancelable: true,
      };
      pane.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer: transfer }));
      pane.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: transfer }));
    },
    [name, type, bytes.toString('base64')] as [string, string, string],
  );
}

/** Every image node's `src` currently on the canvas. */
async function imageSources(target: Page): Promise<string[]> {
  return target.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node img')].map(
      (img) => (img as HTMLImageElement).src,
    ),
  );
}

/** The id of the one image node on the canvas. */
async function soleImageNodeId(target: Page): Promise<string> {
  const id = await target.evaluate(() => {
    const node = document.querySelector('.react-flow__node');
    return node?.getAttribute('data-id') ?? null;
  });
  if (id === null) throw new Error('no node on the canvas to generate onto');
  return id;
}

test.beforeAll(async ({ browser }) => {
  // A hook keeps the config's budget until it raises its own, and seeding a
  // Space behind a sign-in outlasts 30s.
  test.setTimeout(120_000);
  context = await browser.newContext();
  page = await context.newPage();
  await signIn(page);

  // Reuse an existing Project: this spec is about what a generation does with
  // its output, and minting one per run burns the tier's allowance.
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });
  // The route is `/project/{slug}-{uuid}`: the slug is decorative and the
  // backend keys on the bare uuid (URL design §5.7).
  const routeParam = (await page.evaluate(() => window.location.pathname)).split('/')[2] ?? '';
  projectId = routeParam.slice(-36);
  spaceId = await createSpace(page, 'canvas', `lanes-${Date.now()}`);
});

test.afterAll(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await context.close();
});

test('a generated image lands on the node under our own url, not the provider’s', async () => {
  // The provider takes as long as it takes, and the transfer that follows is a
  // second network hop.
  test.setTimeout(300_000);

  await dropFile(page, `seed-${Date.now()}.png`, 'image/png', TINY_PNG);
  await expect
    .poll(async () => (await imageSources(page)).length, { timeout: 60_000 })
    .toBe(1);
  const nodeId = await soleImageNodeId(page);
  // Where our own stored objects are readable, taken from an upload that just
  // happened rather than from a name written down here -- the host is
  // deployment configuration, and a copy of it in this file would be a second
  // place for it to drift.
  const [seedSrc] = await imageSources(page);
  const ourOrigin = new URL(seedSrc as string).origin;

  // The endpoint the Generate panel posts to. Driving it from the page keeps
  // the session cookie and the origin the app itself uses.
  const accepted = await page.evaluate(
    async ([project, space, node]: [string, string, string]) => {
      const response = await fetch('/api/v1/canvas/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          task_type: 'image',
          model: 'nano-banana-2',
          params: { prompt: 'a single small red square on white', node_ids: [node] },
          node_ids: [node],
          project_id: project,
          space_id: space,
          target_node_id: node,
          mode: 'overwrite',
        }),
      });
      return { status: response.status, body: await response.text() };
    },
    [projectId, spaceId, nodeId] as [string, string, string],
  );
  expect(accepted.status, accepted.body).toBe(201);

  // What the node ends up holding. The provider's link is what the worker was
  // handed; an object on our own host is what it must have become, and a
  // different one from the seed since the generation replaced it.
  await expect
    .poll(
      async () => {
        const [src] = await imageSources(page);
        return src === undefined || src === seedSrc ? '' : new URL(src).origin;
      },
      { timeout: 240_000, intervals: [2_000] },
    )
    .toBe(ourOrigin);
});
