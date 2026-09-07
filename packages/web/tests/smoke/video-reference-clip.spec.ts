// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The reference clip on the reference-to-video panel, end to end (#1928).
 *
 * What no jsdom test reaches: the slot appears on a real toolbar under a mode
 * a real menu switched to, the pick lands on a real canvas node through the
 * canvas's own click routing, and the submit is built from a prompt the
 * collaborative editor serialized rather than a string a test handed it.
 *
 * The submit is intercepted rather than let through. What is under test is the
 * request this client builds — that the clip reaches `video` and the mentioned
 * image reaches `images`; whether the vendor then follows the clip's motion is
 * read off two real generations by eye, not asserted here.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite.
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

test.describe.configure({ mode: 'serial' });

// Taller than Desktop Chrome's 720. This panel is the tallest of the three —
// a reference rail, a prompt editor and a slot row — and it hangs BELOW its
// node, so at 720 the mode menu opens past the window bottom and no click can
// reach it. Canvas popovers here are deliberately clipped rather than flipped
// (`avoidCollisions={false}`, so following the canvas cannot fight a flip),
// which makes the window size the thing to change.
test.use({ viewport: { width: 1440, height: 1080 } });

let page: Page;
let projectId = '';
let spaceId = '';
const seededIds: string[] = [];

/** A one-pixel PNG: enough for the canvas to call an image node filled. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

/** A tiny mp4 header: enough for the canvas to call a video node filled. */
const CLIP = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28y';

/**
 * Sign in and leave the page wherever the app lands.
 * @param p - A fresh page.
 */
async function signIn(p: Page): Promise<void> {
  await p.goto('/login');
  await p.locator('#login-email').fill(email as string);
  await p.locator('#login-password').fill(password as string);
  await p.locator('form button[type="submit"]').click();
  await p.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
}

/**
 * Write one node into the open Space's document.
 *
 * Seeded rather than uploaded: what this file exercises is the panel, and the
 * canvas's candidate rule reads a node's TYPE and whether it holds an asset
 * (`CanvasSpace.tsx`), not how the asset got there.
 * @param p - A page with the Space open.
 * @param nodeId - The id to give the node, a UUID (the task schema requires one).
 * @param kind - The node type to write.
 * @param content - The asset URL the node holds, if any.
 * @param atX - Where to put it.
 * @param atY - How far up to put it: the panel hangs BELOW its node and this
 *   suite's window is 720 tall, so the target sits above the origin.
 */
async function seedNode(
  p: Page,
  nodeId: string,
  kind: 'image' | 'video',
  content?: string,
  atX = 0,
  atY = 0,
): Promise<void> {
  await expect(p.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  seededIds.push(nodeId);
  const seen = await p.evaluate(
    async ([pid, sid, id, type, asset, left, top]: [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
    ]) => {
      // Vite serves each module under a versioned URL; importing the bare path
      // would evaluate a SECOND copy whose caches are empty.
      const live = (re: RegExp): string => {
        const found = performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n));
        if (found === undefined) throw new Error(`no module matches ${re.source}`);
        return found;
      };
      const canvas = (await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      )) as {
        addNode: (p: string, s: string, n: unknown) => void;
        readCanvasGraph: (p: string, s: string) => { nodes: { id: string }[] };
      };
      canvas.addNode(pid, sid, {
        id,
        type,
        position: { x: left, y: top },
        data: {
          name: `${type}-e2e`,
          createdAt: Date.now(),
          createdBy: 'clip-e2e',
          locked: false,
          state: 'idle',
          attachments: [],
          ...(asset ? { content: asset, status: 'ready' } : {}),
        },
      });
      return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);
    },
    [projectId, spaceId, nodeId, kind, content ?? '', atX, atY] as [
      string,
      string,
      string,
      string,
      string,
      number,
      number,
    ],
  );
  if (!seen.includes(nodeId)) {
    throw new Error(`${nodeId} never reached the document; saw [${seen.join(', ')}]`);
  }
}

/**
 * Wire one node's output into another's input, the way a drag does.
 * @param p - A page with the Space open.
 * @param source - The node the edge leaves.
 * @param target - The node it enters.
 */
async function wire(p: Page, source: string, target: string): Promise<void> {
  const written = await p.evaluate(
    async ([pid, sid, from, to]: [string, string, string, string]) => {
      const found = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /data\/yjs\/canvas-space\.ts/.test(n));
      if (found === undefined) throw new Error('canvas-space module not loaded');
      const canvas = (await import(/* @vite-ignore */ found)) as {
        addEdge: (p: string, s: string, e: unknown) => boolean;
      };
      return canvas.addEdge(pid, sid, {
        id: `${from}->${to}`,
        source: from,
        target: to,
      });
    },
    [projectId, spaceId, source, target] as [string, string, string, string],
  );
  // It refuses silently (#1989), and a refused edge leaves the mention popup
  // with nothing to offer — a failure that would surface three steps later as
  // a missing option rather than here.
  if (!written) throw new Error(`edge ${source} -> ${target} was refused`);
}

/**
 * Where flow coordinate 0 sits on screen right now.
 *
 * The canvas mounts only what the viewport intersects, and this project's
 * viewport is wherever the last session left it — a fixed coordinate would
 * seed a node the canvas never renders, which surfaces as "node not found"
 * three steps later. Reading the live transform lets the cases below say
 * where on SCREEN they want a node and let the flow coordinate follow.
 * @param p - A page with the canvas open.
 * @returns The viewport's translation in px, and the pane's size.
 */
async function viewportOrigin(
  p: Page,
): Promise<{ tx: number; ty: number; width: number; height: number }> {
  await expect(p.locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  return p.evaluate(() => {
    const vp = document.querySelector('.react-flow__viewport');
    const pane = document.querySelector('.react-flow');
    if (!(vp instanceof HTMLElement) || !(pane instanceof HTMLElement)) {
      throw new Error('canvas not mounted');
    }
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
    return { tx: m.e, ty: m.f, width: pane.clientWidth, height: pane.clientHeight };
  });
}

/**
 * Open the Generate panel on a node the way a person does: right-click, then
 * the menu item.
 * @param p - A page with the Space open.
 * @param nodeId - The node to open it on.
 */
async function openGenerate(p: Page, nodeId: string): Promise<void> {
  const node = p.locator(`.react-flow__node[data-id="${nodeId}"]`);
  await expect(node).toBeVisible({ timeout: 15_000 });
  await node.click({ button: 'right' });
  await p.getByTestId('node-menu-generate').click();
  await expect(p.getByTestId('generate-video-execute')).toBeVisible({
    timeout: 15_000,
  });
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signIn(page);
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 20_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\/[^/]+/, { timeout: 15_000 });
  // The URL segment is the project's SLUG, which ends in its id. Splitting on
  // `/project/` yields the slug, and a Yjs document named after that is a
  // second, empty one — writes into it land nowhere the canvas reads.
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] ?? '';
  if (!projectId) throw new Error(`no project id in ${page.url()}`);
  spaceId = await createSpace(page, 'canvas', `clip-e2e-${Date.now()}`);
});

test.afterEach(async () => {
  if (seededIds.length === 0) return;
  const ids = seededIds.splice(0);
  await page.evaluate(
    async ([pid, sid, list]: [string, string, string[]]) => {
      const found = performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .find((n) => /data\/yjs\/canvas-space\.ts/.test(n));
      if (found === undefined) return;
      const canvas = (await import(/* @vite-ignore */ found)) as {
        removeNode: (p: string, s: string, n: string) => void;
      };
      for (const id of list) canvas.removeNode(pid, sid, id);
    },
    [projectId, spaceId, ids] as [string, string, string[]],
  );
});

test.afterAll(async () => {
  if (spaceId) await deleteSpace(page, spaceId);
  await page.close();
});

// One node, one panel, one session — the steps of a single use, and the state
// each leaves is what the next one reads.
test('picks a clip into the slot and sends it as the mode\'s motion guidance', async () => {
  test.setTimeout(120_000);
  const targetId = crypto.randomUUID();
  const clipId = crypto.randomUUID();
  const imageId = crypto.randomUUID();
  // Placed by SCREEN position, converted through the live viewport: a fixed
  // flow coordinate would land wherever this project's viewport happens to be
  // and the canvas would never mount the node (measured: the transform this
  // account carries puts flow 0 at screen 1035, so a node at -60 sits off the
  // right edge). The row sits near the top so the panel, which hangs BELOW its
  // node, has the rest of the pane to itself.
  const { tx, ty } = await viewportOrigin(page);
  const at = (screenX: number): number => Math.round(screenX - tx);
  const row = Math.round(60 - ty);
  await seedNode(page, imageId, 'image', PIXEL, at(40), row);
  await seedNode(page, clipId, 'video', CLIP, at(340), row);
  await seedNode(page, targetId, 'video', undefined, at(620), row);
  await wire(page, imageId, targetId);

  await openGenerate(page, targetId);
  await page.getByTestId('generate-video-mode-trigger').click();
  await page.getByTestId('generate-video-mode-ref').click();

  // The slot is this mode's, and none of the five image slots come with it:
  // the images arrive through the rail.
  const slot = page.getByTestId('generate-video-tool-reference-video');
  await expect(slot).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('generate-video-tool-first-frame')).toHaveCount(0);
  await expect(page.getByTestId('generate-video-tool-driving-video')).toHaveCount(0);

  await slot.click();
  await page.locator(`.react-flow__node[data-id="${clipId}"]`).click();
  // The clear badge, not a thumbnail: a seeded clip carries no poster, so the
  // toolbar covers the button with the video icon. The badge is what says the
  // slot is holding something whatever the pick looks like.
  await expect(
    page.getByTestId('generate-video-reference-video-clear'),
  ).toBeVisible({ timeout: 10_000 });

  // The clip's own audio: offered only now that a clip is picked.
  await page.getByTestId('generate-video-params-trigger').click();
  await expect(
    page.getByTestId('generate-video-keep-original-sound-toggle'),
  ).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');

  await page.getByTestId('generate-prompt-editor').click();
  await page.keyboard.type('follow the motion in ');
  // The `@` mention is what makes a connected image a model input (#1927), so
  // the request below carries an `images` list only because of this.
  await page.keyboard.type('@');
  await page.getByTestId(`reference-mention-option-${imageId}`).click();

  // Intercepted: what this case is about is the request this client builds.
  // Letting it through would spend a real generation to learn nothing more.
  let body: Record<string, unknown> | undefined;
  await page.route('**/canvas/tasks', async (route) => {
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: crypto.randomUUID(), status: 'queued' } }),
    });
  });

  await expect(page.getByTestId('generate-video-execute')).toBeEnabled();
  await page.getByTestId('generate-video-execute').click();
  await expect.poll(() => body, { timeout: 20_000 }).toBeDefined();

  const params = (body as { params: Record<string, unknown> }).params;
  expect(params.video).toBe(CLIP);
  expect(params.images).toEqual([PIXEL]);
  expect(params.keep_original_sound).toBe(true);
});
