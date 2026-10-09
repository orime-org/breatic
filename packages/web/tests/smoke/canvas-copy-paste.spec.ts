// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Copying, pasting and duplicating canvas nodes (inner#1349).
 *
 * A copy carries everything about a node's content: a picture keeps its
 * stored address, a text node keeps its words, an edge between two copied
 * nodes is copied too. The lock is an editing state and is left behind. Each
 * copy gets its own history row, the copies come out selected, and the same
 * copy pasted into the chat box becomes the card "Add to Agent" makes. A
 * picture on the system clipboard pastes from the right-click menu too.
 *
 * Needs a running dev stack (`pnpm dev`), a smoke account and storage:
 *
 *   pnpm --filter @breatic/web test:smoke
 */
import { test, expect, type Page } from 'playwright/test';

import { STATE_FILE, openSmokeProject } from '../helpers/project';
import { CANVAS_SPACE, liveModuleUrl } from '../helpers/live-module';
import { VISIBLE_SPACE, createSpace, deleteSpace, visibleSpace } from '../helpers/space';

test.use({ storageState: STATE_FILE.A, viewport: { width: 1500, height: 900 } });
let page: Page;
let projectId = '';
let spaceId = '';
/** The uploaded picture and the text node seeded beside it. */
let pictureId = '';
let TEXT_ID = '';

/** A node as the document holds it. */
interface DocNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { name?: string; content?: string; locked?: boolean };
}

/**
 * Runs code against the canvas module the page already loaded.
 * @param source - A function body given `canvas`, `pid`, `sid` and `extra`.
 * @param extra - One value handed to the body.
 * @returns What the body returns.
 */
async function onCanvas<T>(source: string, extra: unknown = null): Promise<T> {
  const url = await liveModuleUrl(page, CANVAS_SPACE);
  return page.evaluate(
    async ([at, pid, sid, body, arg]: [string, string, string, string, unknown]) => {
      const canvas = await import(/* @vite-ignore */ at);
      const run = new Function('canvas', 'pid', 'sid', 'extra', body) as (
        c: unknown,
        p: string,
        s: string,
        e: unknown,
      ) => unknown;
      return run(canvas, pid, sid, arg) as unknown;
    },
    [url, projectId, spaceId, source, extra] as [string, string, string, string, unknown],
  ) as Promise<T>;
}

/** Every node and edge in the document. */
async function graph(): Promise<{ nodes: DocNode[]; edges: { source: string; target: string }[] }> {
  return onCanvas(
    `const g = canvas.readCanvasGraph(pid, sid);
     return { nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, data: { name: n.data.name, content: n.data.content, locked: n.data.locked } })),
              edges: g.edges.map((e) => ({ source: e.source, target: e.target })) };`,
  );
}

/**
 * A text node's words.
 * @param id - The node.
 * @returns Its body as plain text.
 */
async function words(id: string): Promise<string> {
  return onCanvas('return canvas.getTextBody(pid, sid, extra)?.toString() ?? "";', id);
}

/**
 * How many history rows a node has.
 * @param id - The node.
 * @returns The total.
 */
async function historyTotal(id: string): Promise<number> {
  const answer = await page.request.get(`/api/v1/canvas/nodes/${id}/history`, {
    params: { project_id: projectId, limit: 10, offset: 0 },
  });
  expect(answer.ok()).toBe(true);
  return ((await answer.json()) as { data: { total: number } }).data.total;
}

/**
 * Click a node on its top edge, where no control sits.
 * @param id - The node.
 */
async function clickNode(id: string): Promise<void> {
  const box = await visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  if (box === null) throw new Error(`node ${id} is not on screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + 6);
}

/** Select the picture and the text node with one marquee drag around both. */
async function selectBoth(): Promise<void> {
  const boxes = await Promise.all(
    [pictureId, TEXT_ID].map((id) => visibleSpace(page).locator(`.react-flow__node[data-id="${id}"]`).boundingBox()),
  );
  const [a, b] = boxes;
  if (a === null || b === null || a === undefined || b === undefined) throw new Error('nodes are not on screen');
  await page.mouse.move(Math.min(a.x, b.x) - 40, Math.min(a.y, b.y) - 40);
  await page.mouse.down();
  await page.mouse.move(Math.max(a.x + a.width, b.x + b.width) + 40, Math.max(a.y + a.height, b.y + b.height) + 40, { steps: 10 });
  await page.mouse.up();
  await expect(visibleSpace(page).locator('.react-flow__nodesselection-rect')).toBeVisible();
}

/**
 * A fresh PNG, different on every run, as base64.
 * @returns The bytes.
 */
async function freshPng(): Promise<string> {
  return page.evaluate(async () => {
    const canvas = new OffscreenCanvas(64, 48);
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2d context');
    ctx.fillStyle = `rgb(${Math.floor(Math.random() * 255)}, 90, ${Math.floor(Math.random() * 255)})`;
    ctx.fillRect(0, 0, 64, 48);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  });
}

/** Ids of picture nodes whose content is a stored address. */
async function storedPictures(): Promise<string[]> {
  return (await graph()).nodes
    .filter((n) => n.type === 'image' && typeof n.data.content === 'string' && n.data.content.startsWith('http'))
    .map((n) => n.id);
}

// Each case opens its own Space holding an uploaded picture and, wired from
// it, a locked text node.
test.beforeEach(async ({ page: opened, context }) => {
  test.setTimeout(240_000);
  page = opened;
  TEXT_ID = `paste-e2e-text-${Date.now()}`;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSmokeProject(page);
  projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] as string;
  spaceId = await createSpace(page, 'canvas', `copy-paste-e2e-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });

  // A picture uploaded the way a reader drops one, so it has a stored address.
  const png = await freshPng();
  await page.evaluate(([encoded, space]: [string, string]) => {
    const binary = atob(encoded);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
    const transfer = new DataTransfer();
    transfer.items.add(new File([buffer], 'paste-e2e.png', { type: 'image/png' }));
    const pane = document.querySelector(`${space} .react-flow__pane`);
    if (pane === null) throw new Error('no canvas pane');
    const rect = pane.getBoundingClientRect();
    const at = { clientX: rect.left + 300, clientY: rect.top + 250, bubbles: true, cancelable: true };
    pane.dispatchEvent(new DragEvent('dragover', { ...at, dataTransfer: transfer }));
    pane.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: transfer }));
  }, [png, VISIBLE_SPACE] as [string, string]);
  await expect.poll(storedPictures, { timeout: 120_000 }).toHaveLength(1);
  pictureId = (await storedPictures())[0] as string;

  // A locked text node to its right, wired from the picture.
  const picture = (await graph()).nodes.find((n) => n.id === pictureId);
  await onCanvas(
    `canvas.addNode(pid, sid, { id: extra.id, type: 'text', position: { x: extra.x, y: extra.y },
       data: { createdAt: Date.now(), createdBy: 'paste-e2e', locked: false, attachments: [], name: 'Brief', content: 'hello paste' } });
     canvas.setNodeLocked(pid, sid, extra.id, true);
     canvas.addEdge(pid, sid, { id: extra.from + '->' + extra.id, source: extra.from, target: extra.id, createdAt: Date.now() });`,
    { id: TEXT_ID, from: pictureId, x: (picture?.position.x ?? 0) + 400, y: picture?.position.y ?? 0 },
  );
  await expect(visibleSpace(page).locator(`.react-flow__node[data-id="${TEXT_ID}"]`)).toBeVisible();
});

test.afterEach(async () => {
  if (spaceId !== '') await deleteSpace(page, spaceId);
  spaceId = '';
});

test('a copy carries content and edges, leaves the lock, gets history and comes out selected', async () => {
  const before = await graph();
  await selectBoth();
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('ControlOrMeta+V');

  await expect.poll(async () => (await graph()).nodes.length, { timeout: 20_000 }).toBe(before.nodes.length + 2);
  const after = await graph();
  const added = after.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
  const pictureCopy = added.find((n) => n.type === 'image');
  const textCopy = added.find((n) => n.type === 'text');
  const original = before.nodes.find((n) => n.id === pictureId);
  expect(pictureCopy?.data.name).toBe(`COPY-${original?.data.name ?? ''}`);
  expect(textCopy?.data.name).toBe('COPY-Brief');
  // Same Studio: the copy points at the address the original already holds.
  expect(pictureCopy?.data.content).toBe(original?.data.content);
  expect(await words(textCopy?.id ?? '')).toBe(await words(TEXT_ID));
  expect(textCopy?.data.locked).toBe(false);
  expect(after.edges).toContainEqual({ source: pictureCopy?.id, target: textCopy?.id });

  await expect.poll(() => historyTotal(pictureCopy?.id ?? ''), { timeout: 10_000 }).toBe(1);
  await expect.poll(() => historyTotal(textCopy?.id ?? ''), { timeout: 10_000 }).toBe(1);

  // The copies are the selection: an arrow key moves them and nothing else.
  for (const copy of [pictureCopy, textCopy]) {
    await expect(visibleSpace(page).locator(`.react-flow__node[data-id="${copy?.id ?? ''}"]`)).toHaveClass(/selected/);
  }
  await page.keyboard.press('ArrowRight');
  const moved = await graph();
  for (const copy of [pictureCopy, textCopy]) {
    expect(moved.nodes.find((n) => n.id === copy?.id)?.position.x).toBeGreaterThan(copy?.position.x ?? 0);
  }
  expect(moved.nodes.find((n) => n.id === pictureId)?.position).toEqual(original?.position);
});

test('a duplicate is a copy beside the original', async () => {
  const before = await graph();
  await clickNode(pictureId);
  await page.keyboard.press('ControlOrMeta+D');

  await expect.poll(async () => (await graph()).nodes.length, { timeout: 20_000 }).toBe(before.nodes.length + 1);
  const added = (await graph()).nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
  const original = before.nodes.find((n) => n.id === pictureId);
  expect(added[0]?.data.content).toBe(original?.data.content);
  await expect.poll(() => historyTotal(added[0]?.id ?? ''), { timeout: 10_000 }).toBe(1);
});

test('a copy pasted into the chat box is the card "Add to Agent" makes', async () => {
  await selectBoth();
  await page.keyboard.press('ControlOrMeta+C');
  const box = page.getByTestId('chat-composer-box');
  await box.click();
  await page.keyboard.press('ControlOrMeta+V');
  const chip = page.locator('[data-testid^="chat-chip-"]');
  await expect(chip).toHaveCount(1, { timeout: 20_000 });
  const pasted = { id: await chip.getAttribute('data-testid'), text: (await chip.innerText()).trim() };
  await expect(box).toHaveText('');

  // Take it out, then attach the same pick through the menu.
  await chip.locator('button').click();
  await expect(chip).toHaveCount(0);
  // Back on the canvas before picking again.
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  await page.mouse.click((pane?.x ?? 0) + 40, (pane?.y ?? 0) + 40);
  await selectBoth();
  const at = await visibleSpace(page).locator(`.react-flow__node[data-id="${TEXT_ID}"]`).boundingBox();
  await page.mouse.click((at?.x ?? 0) + 20, (at?.y ?? 0) + 6, { button: 'right' });
  await page.getByTestId('selection-menu-add-to-agent').click();
  await expect(chip).toHaveCount(1, { timeout: 20_000 });
  expect({ id: await chip.getAttribute('data-testid'), text: (await chip.innerText()).trim() }).toEqual(pasted);
});

test('a picture on the system clipboard pastes from the right-click menu', async () => {
  const before = await storedPictures();
  const png = await freshPng();
  await page.evaluate(async ([encoded]: [string]) => {
    const binary = atob(encoded);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([buffer], { type: 'image/png' }) })]);
  }, [png] as [string]);
  const pane = await visibleSpace(page).locator('.react-flow__pane').boundingBox();
  await page.mouse.click((pane?.x ?? 0) + 200, (pane?.y ?? 0) + (pane?.height ?? 600) - 150, { button: 'right' });
  await page.getByTestId('canvas-menu-paste').click();

  await expect.poll(async () => (await storedPictures()).length, { timeout: 120_000 }).toBe(before.length + 1);
});
