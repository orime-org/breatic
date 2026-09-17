// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Handing the backend an address instead of bytes, end to end (#207).
 *
 * Everything below this runs against doubles: the integration tests answer the
 * Worker call themselves, so what they never touch is the two hops in the
 * middle — the job leaving the route through Redis into a worker process, and
 * that process reaching the real ingest Worker, which fetches the address at
 * the edge and writes R2.
 *
 * What a person sees at the end is the node's task list, so that is what these
 * read: one address that can be stored and one that cannot, each followed to
 * the state its row lands in.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite.
 */
import { test, expect, type BrowserContext, type Page } from 'playwright/test';

import { signIn } from './helpers/session';
import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let page: Page;
let spaceId = '';
let projectId = '';

/**
 * An address that serves an uploadable kind, and one that does not.
 *
 * Both are served by the W3C, which answers over https and states a type; the
 * second is an ordinary web page, which is what a person pasting the wrong
 * link ends up handing us.
 */
const STORABLE = 'https://www.w3.org/Icons/w3c_home.png';
const NOT_STORABLE = 'https://www.w3.org/';

/** A 1x1 PNG, which is here only to put a node on the canvas to count on. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Drop a one-pixel image on the canvas, so there is a node to read tasks on.
 * @param target - A page with a canvas Space open.
 * @returns The id of the node the drop made.
 */
async function dropANode(target: Page): Promise<string> {
  const before = await target.locator('.react-flow__node').count();
  await target.evaluate(async (encoded: string) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'dot.png', { type: 'image/png' });
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
  }, TINY_PNG);

  await expect
    .poll(async () => target.locator('.react-flow__node').count(), {
      timeout: 30_000,
    })
    .toBeGreaterThan(before);
  const ids = await target.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')].map((n) =>
      n.getAttribute('data-id'),
    ),
  );
  const id = ids.at(-1);
  if (id === null || id === undefined) throw new Error('the new node has no id');
  return id;
}

/**
 * Submit one address the way a caller will, from inside the signed-in page.
 * @param target - The signed-in page.
 * @param url - The address to hand over.
 * @param nodeId - The node the result belongs to.
 * @returns The route's status and body.
 */
async function submit(
  target: Page,
  url: string,
  nodeId: string,
): Promise<{ status: number; body: string; sent: Record<string, string> }> {
  return target.evaluate(
    async ([address, node, project, space]: string[]) => {
      const res = await fetch('/api/v1/canvas/ingest-url', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: address,
          project_id: project,
          space_id: space,
          node_id: node,
        }),
      });
      return {
        status: res.status,
        body: await res.text(),
        sent: { url: address, project, space, node },
      };
    },
    [url, nodeId, projectId, spaceId],
  );
}

/**
 * How many rows this node's list shows in `status`.
 *
 * The cell lives on the node; the list it opens is an xyflow `NodeToolbar`,
 * which renders into the flow's own portal rather than inside the node, so the
 * rows are counted page-wide. Only one list is open at a time.
 * @param target - The page with the canvas open.
 * @param nodeId - The node whose list to read.
 * @param status - Which of the four states to open.
 * @returns How many rows that state holds, and zero while it holds none.
 */
async function rowsIn(
  target: Page,
  nodeId: string,
  status: 'running' | 'done' | 'failed',
): Promise<number> {
  const cell = target.locator(
    `.react-flow__node[data-id="${nodeId}"] [data-testid="task-count-${status}"]`,
  );
  if ((await cell.count()) === 0) return 0;
  if ((await cell.getAttribute('aria-pressed')) !== 'true') await cell.click();
  return target.locator('[data-testid="node-task-row"]').count();
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  context = await browser.newContext();
  page = await context.newPage();
  await signIn(page, email as string, password as string);

  // Reuse an existing Project: this spec is about one endpoint, and minting
  // one per run burns the tier's projects-per-studio allowance.
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });
  // The route param is `<slug>-<uuid>`, and what the API reads is the uuid —
  // the same rule `projectUuidFromRouteParam` applies for the app itself.
  const param = new URL(page.url()).pathname.split('/')[2] ?? '';
  projectId =
    param.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )?.[0] ?? param;
  spaceId = await createSpace(page, 'canvas', `ingest-url-${Date.now()}`);
  // Creating a Space does not open it, and this project already holds other
  // canvases: dropping without this would put the node on whichever tab was
  // selected, while the submission names the Space that was just made.
  await page.getByTestId(`space-tab-name-${spaceId}`).click();
  await expect(page.locator('.react-flow__pane')).toBeVisible({
    timeout: 15_000,
  });
});

test.afterAll(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  await context.close();
});

test('an address that can be stored reaches the node as a finished task', async () => {
  test.setTimeout(120_000);
  const nodeId = await dropANode(page);

  const answer = await submit(page, STORABLE, nodeId);
  // The body is the message, so a refusal says what it refused over.
  expect(answer.status, `${answer.body} for ${JSON.stringify(answer.sent)}`).toBe(201);

  // The drop's own upload is the first row here; the submitted address is the
  // second, and it only gets there by way of Redis, the worker process and the
  // Worker at the edge.
  await expect
    .poll(async () => rowsIn(page, nodeId, 'done'), { timeout: 90_000 })
    .toBe(2);
});

test('an address that cannot be stored reaches it as a failed one', async () => {
  test.setTimeout(120_000);
  const nodeId = await dropANode(page);

  const answer = await submit(page, NOT_STORABLE, nodeId);
  // Taken, because nothing about a web page is visible from the address: what
  // it serves is only knowable once somebody has asked it.
  expect(answer.status, `${answer.body} for ${JSON.stringify(answer.sent)}`).toBe(201);

  await expect
    .poll(async () => rowsIn(page, nodeId, 'failed'), { timeout: 90_000 })
    .toBe(1);

  // The wording, not just the count. The token the edge named travels through
  // the task row to a sentence in the reader's language, and the same token now
  // arrives from a dropped file too (#240) — so the sentence can no longer
  // speak of an address. It names what an image node does take, which is what
  // leaves the reader somewhere to go.
  await expect(page.locator('[data-testid="node-task-row"]')).toContainText(
    'Not a supported format. Images take PNG / JPG / WebP.',
  );
});
