// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A Space document near, at and past its size cap (inner#1790).
 *
 * Every case reads the cap from the Space's own `doc:size` push and derives
 * its targets from it (`tests/helpers/doc-size.ts`), so the suite runs under
 * the default `max_document_bytes` with no configuration, writing up to about
 * ten megabytes per case. States that need collab restarted with another
 * configuration (past the hard ceiling, a limit of 0, start-up validation)
 * are walked by hand, not here.
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/space-size-cap.spec.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Browser, type BrowserContext, type Locator, type Page } from 'playwright/test';
import {
  canvasSpaceDocName,
  documentSpaceDocName,
  formatBytes,
  threeDSpaceDocName,
  timelineSpaceDocName,
} from '@breatic/shared';

import { test, stateFile } from '../helpers/slot';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { DOCUMENT_EDITOR, createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { CANVAS_SPACE, YJS_MANAGER, liveModuleUrl } from '../helpers/live-module';
import { pressAndSettle, selectInBody } from '../helpers/editor-keys';
import { startNewConversation } from '../helpers/conversation';
import { dropFile } from '../helpers/upload';
import { expectTimelineStart, selectTimelineClip, timelineClipIds, uploadTimelineVideo } from '../helpers/timeline-media';
import {
  KiB,
  SPACE_WRITE,
  availableRoom,
  docSynced,
  fillTo,
  pushPastLimit,
  readLines,
  readSize,
  stateVector,
  type DocSizeState,
} from '../helpers/doc-size';
import type * as CanvasModule from '../../src/data/yjs/canvas-space';
import type * as ManagerModule from '../../src/data/yjs/manager';
import type * as SceneSessionModule from '../../src/data/yjs/scene-session';
import type * as SpaceWriteModule from '../../src/data/yjs/space-write';

test.use({ viewport: { width: 1500, height: 900 } });

/** The English catalog, which the implementation's copy comes from. */
const EN = JSON.parse(readFileSync(resolve(__dirname, '../../../../locales/en.json'), 'utf8')) as {
  spaces: { size: Record<string, string> };
  timeline: { errors: Record<string, string> };
};
const SIZE = EN.spaces.size;

/**
 * An English message with its placeholders filled.
 * @param message - The catalog text.
 * @param values - What each `{name}` becomes.
 * @returns The text as the page shows it.
 */
function copy(message: string, values: Record<string, string> = {}): string {
  return message.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

/**
 * The warning notice for a size.
 * @param s - The size.
 * @returns Its text.
 */
const warningText = (s: DocSizeState): string =>
  copy(SIZE.warning, { used: formatBytes(s.bytes ?? 0), limit: formatBytes(s.limit ?? 0) });

/**
 * The full notice of a canvas or document Space.
 * @param s - The size.
 * @returns Its text.
 */
const fullText = (s: DocSizeState): string =>
  copy(SIZE.fullNotice, { used: formatBytes(s.bytes ?? 0), limit: formatBytes(s.limit ?? 0) });

/**
 * Runs in every page before the app: room for every module's Resource Timing
 * entry (`liveModuleUrl` reads them; a cold document editor overflows the
 * default 250), and a record of every toast that appears, kept even after
 * the toast itself has gone.
 */
function prepareBrowser(): void {
  performance.setResourceTimingBufferSize(5000);
  const seen: string[] = [];
  (window as unknown as { __sizeCapToasts: string[] }).__sizeCapToasts = seen;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (!(added instanceof Element)) continue;
        const toasts = added.matches('[data-sonner-toast]') ? [added] : [...added.querySelectorAll('[data-sonner-toast]')];
        for (const toast of toasts) requestAnimationFrame(() => seen.push(toast.textContent ?? ''));
      }
    }
  }).observe(document, { childList: true, subtree: true });
}

test.beforeEach(async ({ page, context }) => {
  await page.addInitScript(prepareBrowser);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

/**
 * Every toast a page has shown since it loaded.
 * @param p - The page.
 * @returns Their texts, in the order they appeared.
 */
async function toastLog(p: Page): Promise<string[]> {
  return p.evaluate(() => [...((window as unknown as { __sizeCapToasts?: string[] }).__sizeCapToasts ?? [])]);
}

/**
 * Wait for every toast on screen to go, and return the toast log's length.
 * A toast with the text of one still on screen only updates that one, so an
 * action is told on its own only once the earlier toast has gone.
 * @param p - The page.
 * @returns The log length to read the next action's toasts from.
 */
async function toastsCleared(p: Page): Promise<number> {
  await expect(p.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
  return (await toastLog(p)).length;
}

/**
 * Wait until the page has shown a toast saying one thing since a point in its
 * toast log. A toast goes after 3 s, so a check that follows a wait reads the
 * log rather than the screen.
 * @param p - The page.
 * @param since - The log length before the action, from {@link toastsCleared}.
 * @param text - What the toast says.
 */
async function expectToldSince(p: Page, since: number, text: string): Promise<void> {
  await expect.poll(async () => (await toastLog(p)).slice(since).some((toast) => toast.includes(text))).toBe(true);
}

/**
 * The toasts on screen saying one thing.
 * @param p - The page.
 * @param text - What they say.
 * @returns The locator.
 */
function toastSaying(p: Page, text: string): Locator {
  return p.locator('[data-sonner-toast]').filter({ hasText: text });
}

/**
 * Wait for the size notice of the Space on screen to show a phase and the
 * text it should hold for the size the page holds right then.
 * @param p - The page.
 * @param docName - The Space's content document.
 * @param phase - The phase.
 * @param text - The text for a size.
 */
async function expectNotice(
  p: Page,
  docName: string,
  phase: 'warning' | 'full',
  text: (s: DocSizeState) => string,
): Promise<void> {
  const notice = visibleSpace(p).getByTestId('space-size-notice');
  await expect(notice).toHaveAttribute('data-phase', phase, { timeout: 15_000 });
  // The numbers move with every push, so the text is checked against the
  // size the page holds at the same moment.
  await expect
    .poll(async () => (await notice.textContent()) === text(await readSize(p, docName)), { timeout: 15_000 })
    .toBe(true);
}

/**
 * Wait for a document's phase.
 * @param p - The page.
 * @param docName - The document.
 * @param phase - The phase to reach.
 */
async function expectPhase(p: Page, docName: string, phase: DocSizeState['phase']): Promise<void> {
  await expect.poll(async () => (await readSize(p, docName)).phase, { timeout: 15_000 }).toBe(phase);
}

/** A Space this file made, and the names to reach it by. */
interface SpaceRef {
  projectId: string;
  spaceId: string;
  /** Its content document. */
  name: string;
}

/** A second browser signed in as the same account, with the Space open. */
interface Peer {
  context: BrowserContext;
  page: Page;
}

/**
 * Open a Space from the drawer.
 * @param p - A page inside the Project.
 * @param spaceId - The Space.
 */
async function openFromDrawer(p: Page, spaceId: string): Promise<void> {
  await p.getByTestId('space-drawer-trigger').click();
  await p.getByTestId(`space-drawer-row-${spaceId}`).getByRole('button').first().click();
  await expect(p.getByTestId('space-drawer')).toHaveCount(0);
}

/**
 * The same account in a second browser context, with the Space open.
 * @param browser - The browser.
 * @param baseURL - The app's address.
 * @param spaceId - The Space to open.
 * @returns The context and its page.
 */
async function openPeer(browser: Browser, baseURL: string | undefined, spaceId: string): Promise<Peer> {
  const context = await browser.newContext({ baseURL, storageState: stateFile('A'), viewport: { width: 1500, height: 900 } });
  await context.addInitScript(prepareBrowser);
  const page = await context.newPage();
  await page.goto(smokeProjectUrl());
  await openFromDrawer(page, spaceId);
  return { context, page };
}

/**
 * Create a canvas Space in the run's Project and wait for it to draw.
 * @param page - The page.
 * @param label - Part of its name.
 * @returns The Space.
 */
async function openCanvasSpace(page: Page, label: string): Promise<SpaceRef> {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'canvas', `${label}-${Date.now()}`);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
  return { projectId, spaceId, name: canvasSpaceDocName(projectId, spaceId) };
}

/**
 * Run code against the canvas and manager modules the page already loaded.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @param body - A function body given `canvas`, `manager`, `pid`, `sid`, `name` and `extra`.
 * @param extra - One value handed to the body.
 * @returns What the body returns.
 */
async function onCanvas<T>(p: Page, s: SpaceRef, body: string, extra: unknown = null): Promise<T> {
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  const managerAt = await liveModuleUrl(p, YJS_MANAGER);
  return p.evaluate(
    async ([cUrl, mUrl, pid, sid, name, source, arg]: [string, string, string, string, string, string, unknown]) => {
      const canvas: unknown = await import(/* @vite-ignore */ cUrl);
      const manager: unknown = await import(/* @vite-ignore */ mUrl);
      const run = new Function('canvas', 'manager', 'pid', 'sid', 'name', 'extra', source) as (...args: unknown[]) => unknown;
      return run(canvas, manager, pid, sid, name, arg);
    },
    [canvasAt, managerAt, s.projectId, s.spaceId, s.name, body, extra] as [string, string, string, string, string, string, unknown],
  ) as Promise<T>;
}

/** A node to seed: its id, type and place in canvas coordinates. */
interface Seed {
  id: string;
  type: 'text' | 'image';
  x: number;
  y: number;
}

/**
 * Add empty nodes through the canvas's own `addNode`, in one task so they render together.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @param seeds - The nodes.
 */
async function seedNodes(p: Page, s: SpaceRef, seeds: readonly Seed[]): Promise<void> {
  await onCanvas(p, s, `for (const seed of extra) canvas.addNode(pid, sid, {
      id: seed.id, type: seed.type, position: { x: seed.x, y: seed.y },
      data: { name: 'size-cap', createdAt: Date.now(), createdBy: 'size-cap', locked: false, state: 'idle', attachments: [] },
    });`, seeds);
  for (const seed of seeds) await expect(nodeOf(p, seed.id)).toBeVisible({ timeout: 20_000 });
}

/**
 * A node on the Space on screen.
 * @param p - The page.
 * @param id - The node.
 * @returns Its locator.
 */
function nodeOf(p: Page, id: string): Locator {
  return visibleSpace(p).locator(`.react-flow__node[data-id="${id}"]`);
}

/**
 * Every node id the document holds.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @returns The ids, sorted.
 */
async function nodeIds(p: Page, s: SpaceRef): Promise<string[]> {
  return onCanvas<string[]>(p, s, 'return canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id).sort();');
}

/**
 * A text node's words, as the document holds them.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @param id - The node.
 * @returns Its body as plain text.
 */
async function words(p: Page, s: SpaceRef, id: string): Promise<string> {
  return onCanvas<string>(p, s, 'return canvas.readTextBodies(pid, sid, [extra]).get(extra) ?? "";', id);
}

/**
 * Where the document says a node is.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @param id - The node.
 * @returns Its position, or null when it is not there.
 */
async function docPosition(p: Page, s: SpaceRef, id: string): Promise<{ x: number; y: number } | null> {
  return onCanvas(p, s, `const n = canvas.readCanvasGraph(pid, sid).nodes.find((node) => node.id === extra);
    return n ? { x: n.position.x, y: n.position.y } : null;`, id);
}

/**
 * Whether the filler node's data holds a key.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @param node - The filler node.
 * @param key - The key.
 * @returns True when it is there.
 */
async function fillHas(p: Page, s: SpaceRef, node: string, key: string): Promise<boolean> {
  return onCanvas<boolean>(p, s, `if (!manager.hasDoc(name)) return false;
    return canvas.nodeDataMap(manager.getDoc(name), extra.node)?.has(extra.key) ?? false;`, { node, key });
}

/**
 * A point on a node's top edge that the node itself takes, so a press there
 * lands on it rather than on a node drawn over it.
 * @param p - The page.
 * @param id - The node.
 * @returns Screen coordinates.
 * @throws {Error} When every point tried is covered.
 */
async function pointOn(p: Page, id: string): Promise<{ x: number; y: number }> {
  await expect(nodeOf(p, id)).toBeVisible({ timeout: 20_000 });
  const box = await nodeOf(p, id).boundingBox();
  if (box === null) throw new Error(`node ${id} is not on screen`);
  for (const share of [0.5, 0.25, 0.75, 0.1, 0.9]) {
    const at = { x: box.x + box.width * share, y: box.y + 6 };
    const hit = await p.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.react-flow__node')?.getAttribute('data-id') ?? null, at);
    if (hit === id) return at;
  }
  throw new Error(`every point on the top edge of ${id} is covered`);
}

/**
 * Click a node on its top edge.
 * @param p - The page.
 * @param id - The node.
 * @param button - Which button.
 */
async function clickNode(p: Page, id: string, button: 'left' | 'right' = 'left'): Promise<void> {
  const at = await pointOn(p, id);
  await p.mouse.click(at.x, at.y, { button });
}

/**
 * Pick an entry of a node's right-click menu.
 * @param p - The page.
 * @param id - The node.
 * @param entry - The entry's test id.
 */
async function nodeMenu(p: Page, id: string, entry: 'node-menu-duplicate' | 'node-menu-delete'): Promise<void> {
  await clickNode(p, id, 'right');
  await p.getByTestId(entry).click();
  // The menu keeps the keyboard until it has finished closing.
  await expect(p.locator('[role="menu"]')).toHaveCount(0);
}

/**
 * Open a text node's editor, type at the end of its words and leave it.
 * @param p - The page.
 * @param id - The text node.
 * @param text - What to type.
 */
async function typeInText(p: Page, id: string, text: string): Promise<void> {
  const node = nodeOf(p, id);
  await node.dblclick();
  await expect(node.locator('[data-testid="text-node-body"][contenteditable="true"]')).toBeFocused();
  await p.keyboard.press('End');
  await p.keyboard.type(text);
  await p.keyboard.press('Escape');
}

/**
 * Wait for one node to appear and return its id. A duplicate lands over its
 * source, so a step that edits after a duplicate edits the copy on top.
 * @param p - The page.
 * @param s - The Space.
 * @param before - The node ids before the write.
 * @returns The new node's id.
 */
async function addedNode(p: Page, s: SpaceRef, before: readonly string[]): Promise<string> {
  await expect.poll(async () => (await nodeIds(p, s)).length, { timeout: 15_000 }).toBe(before.length + 1);
  const added = (await nodeIds(p, s)).find((id) => !before.includes(id));
  if (added === undefined) throw new Error('no node was added');
  return added;
}

/**
 * Drag a node sideways with a real pointer, holding it by its top edge.
 * @param p - The page.
 * @param id - The node.
 * @param dx - How far, in screen pixels.
 */
async function dragBy(p: Page, id: string, dx: number): Promise<void> {
  const from = await pointOn(p, id);
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  for (let step = 1; step <= 8; step += 1) await p.mouse.move(from.x + (dx * step) / 8, from.y);
  await p.mouse.up();
}

/**
 * Click the canvas where nothing is drawn, so the canvas takes the keyboard.
 * @param p - The page.
 * @throws {Error} When no blank point is found.
 */
async function clickBlank(p: Page): Promise<void> {
  const box = await visibleSpace(p).locator('.react-flow__pane').boundingBox();
  if (box === null) throw new Error('the canvas pane is not on screen');
  for (const fy of [0.1, 0.9, 0.5]) {
    for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const at = { x: box.x + box.width * fx, y: box.y + box.height * fy };
      const blank = await p.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && hit.closest('.react-flow__pane') !== null && hit.closest('.react-flow__node') === null;
      }, at);
      if (blank) {
        await p.mouse.click(at.x, at.y);
        return;
      }
    }
  }
  throw new Error('no blank point on the canvas');
}

/** The three nodes most canvas cases work with. */
interface CanvasNodes {
  /** A text node holding `hello`. */
  t: string;
  /** The filler node: an image node whose data the fill goes into. */
  f: string;
  /** A small text node to delete. */
  n: string;
}

/**
 * Seed the text node T, the filler F and the small node N, and type `hello` into T.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @returns Their ids.
 */
async function seedCanvas(p: Page, s: SpaceRef): Promise<CanvasNodes> {
  const run = crypto.randomUUID().slice(0, 8);
  const ids = { t: `size-t-${run}`, f: `size-f-${run}`, n: `size-n-${run}` };
  await seedNodes(p, s, [
    { id: ids.t, type: 'text', x: 100, y: 100 },
    { id: ids.f, type: 'image', x: 100, y: 520 },
    { id: ids.n, type: 'text', x: 900, y: 520 },
  ]);
  await typeInText(p, ids.t, 'hello');
  await expect.poll(() => words(p, s, ids.t)).toBe('hello');
  return ids;
}

test('S-01 near the limit, the notice stays up and editing goes on as before', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-warning');
  let peer: Peer | undefined;
  try {
    const { t, f } = await seedCanvas(page, s);
    expect((await readSize(page, s.name)).phase).toBe('normal');
    const lines = await readLines(page, s.name);
    expect(lines.limit).toBeGreaterThan(0);
    await expect(visibleSpace(page).getByTestId('space-size-notice')).toHaveCount(0);

    await fillTo(page, s.name, lines.fullLine - 64 * KiB, { node: f });
    await expectPhase(page, s.name, 'warning');
    await expectNotice(page, s.name, 'warning', warningText);

    const before = await nodeIds(page, s);
    const shown = (await toastLog(page)).length;
    await nodeMenu(page, t, 'node-menu-duplicate');
    const copy = await addedNode(page, s, before);
    await typeInText(page, copy, '!');
    await expect.poll(() => words(page, s, copy)).toBe('hello!');
    await expect(nodeOf(page, copy).getByTestId('text-node-body')).toHaveText('hello!');
    expect((await toastLog(page)).slice(shown)).toEqual([]);

    peer = await openPeer(browser, baseURL, s.spaceId);
    await expect(visibleSpace(peer.page).getByTestId('space-size-notice')).toHaveAttribute('data-phase', 'warning', { timeout: 20_000 });
  } finally {
    await peer?.context.close();
    await deleteSpace(page, s.spaceId);
  }
});

test('S-02 at the limit, growth is refused with a toast and nothing forks, while a move still lands', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-full');
  let peer: Peer | undefined;
  try {
    const { t, f } = await seedCanvas(page, s);
    peer = await openPeer(browser, baseURL, s.spaceId);
    await expect(nodeOf(peer.page, t)).toBeVisible({ timeout: 20_000 });
    const lines = await readLines(page, s.name);

    await fillTo(page, s.name, lines.fullLine + 16 * KiB, { node: f });
    await expectPhase(page, s.name, 'full');
    await expectNotice(page, s.name, 'full', fullText);
    const ids = await nodeIds(page, s);

    let shown = await toastsCleared(page);
    await nodeMenu(page, t, 'node-menu-duplicate');
    await page.waitForTimeout(3_000);
    expect(await nodeIds(page, s)).toEqual(ids);
    expect(await nodeIds(peer.page, s)).toEqual(ids);
    await expectToldSince(page, shown, SIZE.addBlocked);

    shown = await toastsCleared(page);
    await typeInText(page, t, 'X');
    await expect(nodeOf(page, t).getByTestId('text-node-body')).toHaveText('hello');
    expect(await words(page, s, t)).toBe('hello');
    await expectToldSince(page, shown, SIZE.addBlocked);

    let pasted = false;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/canvas/paste')) pasted = true;
    });
    await clickNode(page, t);
    await page.keyboard.press('ControlOrMeta+C');
    shown = await toastsCleared(page);
    await page.keyboard.press('ControlOrMeta+V');
    await page.waitForTimeout(3_000);
    expect(pasted).toBe(false);
    expect(await nodeIds(page, s)).toEqual(ids);
    await expectToldSince(page, shown, SIZE.addBlocked);

    const before = await docPosition(page, s, t);
    await dragBy(page, t, 120);
    await expect.poll(async () => (await docPosition(page, s, t))?.x).not.toBe(before?.x);

    await expect.poll(() => nodeIds(peer!.page, s)).toEqual(ids);
    expect(await words(peer.page, s, t)).toBe('hello');
    expect((await toastLog(page)).filter((text) => text.includes(SIZE.resync))).toEqual([]);
    expect((await toastLog(peer.page)).filter((text) => text.includes(SIZE.resync))).toEqual([]);
    await page.reload();
    await expect(nodeOf(page, t)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => nodeIds(page, s), { timeout: 15_000 }).toEqual(ids);
    expect(await words(page, s, t)).toBe('hello');
    expect((await toastLog(page)).filter((text) => text.includes(SIZE.resync))).toEqual([]);
  } finally {
    await peer?.context.close();
    await deleteSpace(page, s.spaceId);
  }
});

test('S-03 deletes go through at the limit, and dropping back below the full line restores growth', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-delete');
  let peer: Peer | undefined;
  try {
    const { t, f, n } = await seedCanvas(page, s);
    peer = await openPeer(browser, baseURL, s.spaceId);
    await expect(nodeOf(peer.page, n)).toBeVisible({ timeout: 20_000 });
    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine + 16 * KiB, { node: f });
    await expectPhase(page, s.name, 'full');

    const shown = (await toastLog(page)).length;
    await nodeMenu(page, n, 'node-menu-delete');
    await expect.poll(async () => (await nodeIds(page, s)).includes(n), { timeout: 10_000 }).toBe(false);
    await expect.poll(async () => (await nodeIds(peer!.page, s)).includes(n), { timeout: 10_000 }).toBe(false);
    expect((await toastLog(page)).slice(shown)).toEqual([]);
    expect((await readSize(page, s.name)).phase).toBe('full');

    await clickNode(page, f);
    await page.keyboard.press('Delete');
    await expect(nodeOf(page, f)).toHaveCount(0, { timeout: 10_000 });
    await expectPhase(page, s.name, 'normal');
    await expect(visibleSpace(page).getByTestId('space-size-notice')).toHaveCount(0);

    const before = await nodeIds(page, s);
    await nodeMenu(page, t, 'node-menu-duplicate');
    const copy = await addedNode(page, s, before);
    await typeInText(page, copy, '!');
    await expect.poll(() => words(page, s, copy)).toBe('hello!');
    expect((await toastLog(page)).slice(shown)).toEqual([]);
    const after = await nodeIds(page, s);
    await expect.poll(() => nodeIds(peer!.page, s), { timeout: 10_000 }).toEqual(after);
    await expect.poll(() => words(peer!.page, s, copy), { timeout: 10_000 }).toBe('hello!');
  } finally {
    await peer?.context.close();
    await deleteSpace(page, s.spaceId);
  }
});

test('S-04 near the hard ceiling, moves are refused too, until a delete makes room', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-ceiling');
  let peer: Peer | undefined;
  try {
    const { t, f } = await seedCanvas(page, s);
    peer = await openPeer(browser, baseURL, s.spaceId);
    await expect(nodeOf(peer.page, t)).toBeVisible({ timeout: 20_000 });
    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine + 16 * KiB, { node: f });
    await expectPhase(page, s.name, 'full');

    const past = await pushPastLimit(page, s.name, lines.ceiling - lines.reserve / 2, { node: f });
    expect(past.bytes).toBeGreaterThan(lines.limit);
    expect(past.bytes).toBeLessThanOrEqual(lines.ceiling);
    expect(past.overwriteRoom).toBe(0);
    expect(past.phase).toBe('full');

    const at = await docPosition(page, s, t);
    const drawn = await nodeOf(page, t).boundingBox();
    await dragBy(page, t, 120);
    // A refused drop springs back to where the document has the node.
    await expect.poll(async () => Math.abs(((await nodeOf(page, t).boundingBox())?.x ?? 0) - (drawn?.x ?? 0)), { timeout: 5_000 }).toBeLessThan(2);
    expect(await docPosition(page, s, t)).toEqual(at);
    expect(await docPosition(peer.page, s, t)).toEqual(at);
    const overwrite = toastSaying(page, SIZE.overwriteBlocked);
    await expect(overwrite.first()).toBeVisible();

    await clickNode(page, t);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(1_000);
    expect(await docPosition(page, s, t)).toEqual(at);
    await expect(overwrite.first()).toBeVisible();

    await clickNode(page, f);
    await page.keyboard.press('Delete');
    await expect(nodeOf(page, f)).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(async () => {
      const size = await readSize(page, s.name);
      return (size.overwriteRoom ?? 0) > 0 && size.phase !== 'full';
    }, { timeout: 15_000 }).toBe(true);

    const shown = (await toastLog(page)).length;
    await dragBy(page, t, 120);
    await expect.poll(async () => (await docPosition(page, s, t))?.x).not.toBe(at?.x);
    expect((await toastLog(page)).slice(shown)).toEqual([]);
  } finally {
    await peer?.context.close();
    await deleteSpace(page, s.spaceId);
  }
});

test('S-05 a document already past its limit when opened shows as usual and starts out full', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-reopen');
  let peer: Peer | undefined;
  try {
    const { t, f, n } = await seedCanvas(page, s);
    peer = await openPeer(browser, baseURL, s.spaceId);
    await expect(nodeOf(peer.page, t)).toBeVisible({ timeout: 20_000 });
    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine + 16 * KiB, { node: f });
    await pushPastLimit(page, s.name, lines.ceiling - lines.reserve / 2, { node: f });
    await peer.context.close();
    peer = undefined;
    await docSynced(page, s.name);

    // The last connection going unloads the document (`unload_immediately`).
    await page.getByTestId(`space-tab-${s.spaceId}`).hover();
    await page.getByTestId(`space-tab-close-${s.spaceId}`).click();
    await expect(page.getByTestId(`space-tab-${s.spaceId}`)).toHaveCount(0);
    await openFromDrawer(page, s.spaceId);

    await expect(nodeOf(page, t)).toBeVisible({ timeout: 30_000 });
    await expect(nodeOf(page, t).getByTestId('text-node-body')).toHaveText('hello');
    await expect.poll(async () => {
      const size = await readSize(page, s.name);
      return size.phase === 'full' && (size.bytes ?? 0) > lines.limit;
    }, { timeout: 15_000 }).toBe(true);
    await expectNotice(page, s.name, 'full', fullText);

    const ids = await nodeIds(page, s);
    await nodeMenu(page, t, 'node-menu-duplicate');
    await page.waitForTimeout(2_000);
    expect(await nodeIds(page, s)).toEqual(ids);
    await expect(toastSaying(page, SIZE.addBlocked).first()).toBeVisible();

    await nodeMenu(page, n, 'node-menu-delete');
    await expect.poll(async () => (await nodeIds(page, s)).includes(n), { timeout: 10_000 }).toBe(false);
  } finally {
    await peer?.context.close();
    await deleteSpace(page, s.spaceId);
  }
});

/**
 * Write a string into the filler node through `writeSpaceDoc`, judged as an add of its length.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @param node - The filler node.
 * @param key - The data key to write.
 * @param char - The character the string repeats.
 * @param length - Its length.
 * @returns What `writeSpaceDoc` answered.
 */
async function gatedWrite(p: Page, s: SpaceRef, node: string, key: string, char: string, length: number): Promise<unknown> {
  const writeAt = await liveModuleUrl(p, SPACE_WRITE);
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  const managerAt = await liveModuleUrl(p, YJS_MANAGER);
  return p.evaluate(async ([wUrl, cUrl, mUrl, name, filler, k, c, size]) => {
    const write = (await import(/* @vite-ignore */ wUrl)) as typeof SpaceWriteModule;
    const canvas = (await import(/* @vite-ignore */ cUrl)) as typeof CanvasModule;
    const manager = (await import(/* @vite-ignore */ mUrl)) as typeof ManagerModule;
    const doc = manager.getDoc(name);
    const data = canvas.nodeDataMap(doc, filler);
    if (data === null) throw new Error(`no node ${filler}`);
    return write.writeSpaceDoc(name, { kind: 'add', estimate: size }, () => {
      doc.transact(() => data.set(k, c.repeat(size)));
    });
  }, [writeAt, canvasAt, managerAt, s.name, node, key, char, length] as const);
}

test('S-06 two tabs writing past the limit at once: the refused one is told once and resyncs', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-race');
  let peer: Peer | undefined;
  try {
    const { f, n } = await seedCanvas(page, s);
    peer = await openPeer(browser, baseURL, s.spaceId);
    const other = peer.page;
    await expect(nodeOf(other, f)).toBeVisible({ timeout: 20_000 });
    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine - 1.5 * lines.margin, { node: f });
    for (const p of [page, other]) {
      await expect.poll(async () => {
        const size = await readSize(p, s.name);
        return (size.phase === 'normal' || size.phase === 'warning') && Math.abs((size.room ?? 0) - 1.5 * lines.margin) <= 16 * KiB;
      }, { timeout: 15_000 }).toBe(true);
    }

    const w = Math.floor(1.4 * lines.margin);
    await peer.context.setOffline(true);
    expect(await gatedWrite(other, s, f, 'peerWrite', 'b', w)).toEqual({ ok: true });
    expect(await gatedWrite(page, s, f, 'pageWrite', 'a', w)).toEqual({ ok: true });
    await docSynced(page, s.name);

    await peer.context.setOffline(false);
    const resync = toastSaying(other, SIZE.resync);
    await expect(resync.first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await readSize(other, s.name)).phase, { timeout: 20_000 }).not.toBe('resyncing');
    await expect(nodeOf(other, f)).toBeVisible({ timeout: 20_000 });

    await other.waitForTimeout(5_000);
    const told = await toastLog(other);
    expect(told.filter((text) => text.includes(SIZE.resync))).toHaveLength(1);
    // A1: a write refused while the document rebuilds says nothing more.
    expect(told.filter((text) => !text.includes(SIZE.resync))).toEqual([]);
    await expect.poll(() => fillHas(other, s, f, 'pageWrite'), { timeout: 15_000 }).toBe(true);
    expect(await fillHas(other, s, f, 'peerWrite')).toBe(false);
    expect(await fillHas(page, s, f, 'peerWrite')).toBe(false);

    const shown = (await readSize(other, s.name)).shownPhase;
    expect(shown).toBe('warning');
    await expect(visibleSpace(other).getByTestId('space-size-notice')).toHaveAttribute('data-phase', shown);

    await page.reload();
    await other.reload();
    for (const p of [page, other]) {
      await expect(nodeOf(p, f)).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => fillHas(p, s, f, 'pageWrite'), { timeout: 15_000 }).toBe(true);
      expect(await fillHas(p, s, f, 'peerWrite')).toBe(false);
    }
    await nodeMenu(other, n, 'node-menu-delete');
    await expect.poll(async () => (await nodeIds(page, s)).includes(n), { timeout: 10_000 }).toBe(false);
  } finally {
    await peer?.context.setOffline(false);
    await peer?.context.close();
    await deleteSpace(page, s.spaceId);
  }
});

/**
 * What the canvas's next undo does to its size, as the page's own
 * `nextHistoryStep` judges it.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @returns The kind the step is judged as.
 */
async function undoKind(p: Page, s: SpaceRef): Promise<string> {
  const historyAt = await liveModuleUrl(p, 'data/yjs/history-step.ts');
  return onCanvas<string>(
    p,
    s,
    'return import(extra).then((history) => history.nextHistoryStep(canvas.getCanvasUndoManager(manager.getDoc(name), name), "undo").kind);',
    historyAt,
  );
}

test('S-07 Mod-z on a full canvas: bringing back a deleted node is refused, taking back a new one is not', async ({ page }) => {
  const s = await openCanvasSpace(page, 'size-undo');
  try {
    const run = crypto.randomUUID().slice(0, 8);
    const f = `size-f-${run}`;
    const x = `size-x-${run}`;
    const y = `size-y-${run}`;
    // Seeded together, so the canvas frames both and X is on screen to click.
    await seedNodes(page, s, [
      { id: f, type: 'image', x: 100, y: 520 },
      { id: x, type: 'text', x: 100, y: 100 },
    ]);
    await nodeMenu(page, x, 'node-menu-delete');
    await expect(nodeOf(page, x)).toHaveCount(0, { timeout: 10_000 });
    await seedNodes(page, s, [{ id: y, type: 'text', x: 500, y: 100 }]);
    // The top step makes Y (undoing it deletes); the one under it deletes X.
    expect(await undoKind(page, s)).toBe('delete');

    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine + 16 * KiB, { node: f });
    await expectPhase(page, s.name, 'full');

    const shown = (await toastLog(page)).length;
    await clickBlank(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(nodeOf(page, y)).toHaveCount(0, { timeout: 10_000 });
    expect((await toastLog(page)).slice(shown)).toEqual([]);
    expect(await undoKind(page, s)).toBe('add');

    const vector = await stateVector(page, s.name);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(toastSaying(page, SIZE.addBlocked).first()).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(await nodeIds(page, s)).not.toContain(x);
    expect(await stateVector(page, s.name)).toBe(vector);

    // The fill goes the way it came, outside the undo stack, so the next
    // Mod-z is still the one that brings X back.
    await onCanvas(page, s, 'const doc = manager.getDoc(name); doc.transact(() => doc.getMap("nodesMap").delete(extra));', f);
    await expect.poll(async () => (await readSize(page, s.name)).phase, { timeout: 15_000 }).not.toBe('full');
    await clickBlank(page);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(nodeOf(page, x)).toBeVisible({ timeout: 10_000 });
  } finally {
    await deleteSpace(page, s.spaceId);
  }
});

/**
 * The paragraphs of the document on screen. Another connection's caret is
 * drawn inside a paragraph with its name label, so it is removed from a copy
 * before the text is read.
 * @param p - The page.
 * @returns Their texts.
 */
async function paragraphs(p: Page): Promise<string[]> {
  return p.locator(`${DOCUMENT_EDITOR} p`).evaluateAll((rows) => rows.map((row) => {
    const copy = row.cloneNode(true) as HTMLElement;
    for (const caret of copy.querySelectorAll('.collaboration-carets__caret')) caret.remove();
    return copy.textContent ?? '';
  }));
}

/**
 * Select inside one paragraph of the body: all of it, or a caret at its end.
 * @param p - The page.
 * @param index - Which paragraph.
 * @param caret - A caret at its end rather than the whole paragraph.
 */
async function selectParagraph(p: Page, index: number, caret: boolean): Promise<void> {
  await selectInBody(p, () => p.evaluate(([selector, i, collapse]) => {
    const paragraph = document.querySelectorAll(`${selector} p`)[i];
    if (!paragraph) throw new Error(`no paragraph ${String(i)}`);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    if (collapse) range.collapse(false);
    const selection = window.getSelection();
    if (!selection) throw new Error('no selection');
    selection.removeAllRanges();
    selection.addRange(range);
  }, [DOCUMENT_EDITOR, index, caret] as const));
}

/**
 * The text of a document's body as its Yjs fragment holds it.
 * @param p - A page with the Space open.
 * @param name - The document.
 * @returns The text, every block run together.
 */
async function yjsBodyText(p: Page, name: string): Promise<string> {
  const managerAt = await liveModuleUrl(p, YJS_MANAGER);
  return p.evaluate(async ([url, doc]) => {
    const manager = (await import(/* @vite-ignore */ url)) as typeof ManagerModule;
    return manager.getDoc(doc).getXmlFragment('content').toDOM(document).textContent ?? '';
  }, [managerAt, name] as const);
}

test('S-08 a full document refuses typing and Mod-z, lets single deletes through, and recovers after a whole passage goes', async ({ page, browser, baseURL }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'document', `size-document-${Date.now()}`);
  const name = documentSpaceDocName(projectId, spaceId);
  let peer: Peer | undefined;
  // One plain paragraph of 64 KiB, ending in a full stop.
  const q = `${'Size cap paragraph '.repeat(4000).slice(0, 64 * KiB - 1)}.`;
  /**
   * Paragraphs with Q named rather than spelt out.
   * @param p - The page.
   * @returns Their texts.
   */
  const shownBody = async (p: Page): Promise<string[]> => (await paragraphs(p)).map((text) => (text === q ? 'Q' : text));
  try {
    const editor = page.locator(DOCUMENT_EDITOR);
    await editor.click();
    await page.keyboard.type('Keep me.');
    await page.keyboard.press('Enter');
    await editor.evaluate((element, text) => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    }, q);
    await expect.poll(() => shownBody(page), { timeout: 15_000 }).toEqual(['Keep me.', 'Q']);

    await selectParagraph(page, 1, true);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Undo target');
    await expect.poll(() => shownBody(page)).toEqual(['Keep me.', 'Q', 'Undo target']);
    // Past the undo manager's capture window, so the delete is a step of its own.
    await page.waitForTimeout(1_000);
    await selectParagraph(page, 2, false);
    await pressAndSettle(page, 'Backspace');
    await pressAndSettle(page, 'Backspace');
    await expect.poll(() => shownBody(page)).toEqual(['Keep me.', 'Q']);
    await page.waitForTimeout(1_000);

    const lines = await readLines(page, name);
    await fillTo(page, name, lines.fullLine + 16 * KiB, 'smoke-fill');
    await expectPhase(page, name, 'full');
    await expectNotice(page, name, 'full', fullText);
    const vector = await stateVector(page, name);

    await selectParagraph(page, 0, true);
    await page.keyboard.type('Z');
    await expect(toastSaying(page, SIZE.addBlocked).first()).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(await shownBody(page)).toEqual(['Keep me.', 'Q']);
    expect(await yjsBodyText(page, name)).not.toContain('Z');

    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(1_000);
    expect(await shownBody(page)).toEqual(['Keep me.', 'Q']);
    expect(await yjsBodyText(page, name)).not.toContain('Undo target');
    await expect(toastSaying(page, SIZE.addBlocked).first()).toBeVisible();
    expect(await stateVector(page, name)).toBe(vector);

    await selectParagraph(page, 0, true);
    await pressAndSettle(page, 'Backspace');
    await expect.poll(() => shownBody(page)).toEqual(['Keep me', 'Q']);

    await selectParagraph(page, 1, false);
    await pressAndSettle(page, 'Backspace');
    await expect.poll(async () => (await shownBody(page)).includes('Q')).toBe(false);
    await expect.poll(async () => (await readSize(page, name)).phase, { timeout: 15_000 }).not.toBe('full');

    await selectParagraph(page, 0, true);
    await page.keyboard.type('Z');
    await expect.poll(async () => (await paragraphs(page))[0]).toBe('Keep meZ');
    peer = await openPeer(browser, baseURL, spaceId);
    await expect(peer.page.locator(DOCUMENT_EDITOR)).toBeVisible({ timeout: 20_000 });
    const mine = await paragraphs(page);
    await expect.poll(() => paragraphs(peer!.page), { timeout: 15_000 }).toEqual(mine);
  } finally {
    await peer?.context.close();
    await deleteSpace(page, spaceId);
  }
});

/**
 * The objects the 3D viewport draws.
 * @param p - The page.
 * @returns Their ids and positions.
 */
async function renderedObjects(p: Page): Promise<Array<{ id: string; position: number[] }>> {
  return JSON.parse(await visibleSpace(p).getByTestId('three-d-viewport').getAttribute('data-objects') ?? '[]') as Array<{ id: string; position: number[] }>;
}

/**
 * The first object's committed X, from the scene session the app loaded.
 * @param p - The page.
 * @param name - The 3D document.
 * @returns The value.
 */
async function committedX(p: Page, name: string): Promise<number> {
  const sceneAt = await liveModuleUrl(p, 'data/yjs/scene-session.ts');
  return p.evaluate(async ([url, doc]) => {
    const scene = (await import(/* @vite-ignore */ url)) as typeof SceneSessionModule;
    const session = scene.peekSceneSession(doc);
    if (!session || session.getSnapshot().status !== 'ready') throw new Error('The displayed scene has no live ready session.');
    return session.getSnapshot().objects[0].position[0];
  }, [sceneAt, name] as const);
}

test('S-09 a full 3D Space refuses every edit, in the 3D wording', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, '3d', `size-3d-${Date.now()}`);
  const name = threeDSpaceDocName(projectId, spaceId);
  try {
    const scene = visibleSpace(page);
    await scene.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
    await expect.poll(async () => (await renderedObjects(page)).length).toBe(1);

    const lines = await readLines(page, name);
    await fillTo(page, name, lines.fullLine + 16 * KiB, 'smoke-fill');
    await expectPhase(page, name, 'full');
    await expectNotice(page, name, 'full', () => SIZE.threeDFull);
    await expect(scene.getByTestId('space-size-notice')).not.toContainText('Delete');
    const x = await committedX(page, name);

    await scene.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add figure', exact: true }).click();
    // The Add menu closed the properties panel, and a refused add focuses
    // nothing to open it again; the figure added first is still selected.
    await scene.getByTestId('scene-properties-trigger').click();
    const input = page.getByTestId('scene-properties-panel').getByRole('group', { name: 'Position (m)', exact: true }).getByLabel('X', { exact: true });
    await input.fill(String(x + 2));
    await input.press('Tab');
    await scene.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.waitForTimeout(1_000);

    expect(await renderedObjects(page)).toHaveLength(1);
    expect(await committedX(page, name)).toBe(x);
    await expect(toastSaying(page, SIZE.threeDFull)).toHaveCount(1);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

test('S-10 a full Timeline refuses a local video inside the material dialog @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `size-timeline-${Date.now()}`);
  const name = timelineSpaceDocName(projectId, spaceId);
  try {
    const outlet = visibleSpace(page);
    await expect(outlet.getByTestId('timeline-space')).toHaveAttribute('data-space-id', spaceId);
    const lines = await readLines(page, name);
    await fillTo(page, name, lines.fullLine + 16 * KiB, 'smoke-fill');
    await expectPhase(page, name, 'full');
    await expectNotice(page, name, 'full', () => SIZE.timelineFull);

    const tickets: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/v1/assets/upload-ticket') tickets.push(request.url());
    });
    await outlet.getByTestId('timeline-add-media').click();
    const dialog = page.getByRole('dialog', { name: 'Add media', exact: true });
    await dialog.getByTestId('timeline-material-local').click();
    await dialog.getByTestId('timeline-file-input').setInputFiles({
      name: `size-cap-${crypto.randomUUID()}.mp4`,
      mimeType: 'video/mp4',
      buffer: readFileSync(resolve(__dirname, '../fixtures/media-history.mp4')),
    });
    await dialog.getByTestId('timeline-confirm-material').click();
    await expect(dialog.getByTestId('timeline-material-error')).toHaveText(SIZE.timelineFull);
    await page.waitForTimeout(2_000);
    expect(tickets).toEqual([]);
    expect(await timelineClipIds(page)).toEqual([]);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

/** A 4 KiB brief: big enough that half its estimate is far above what a fill can miss by. */
const BRIEF = 'Size cap brief. '.repeat(256).trim();

/** A proposal of one written text node, as the proposal tool answers it. */
const PROPOSAL = {
  placed: true,
  nodes: [{ role: 'written', type: 'text', name: 'Size cap brief', prompt: [{ text: BRIEF }] }],
  edges: [],
  modelNote: '',
  rationale: '',
};

/**
 * Answer the next chat message with a turn whose tool answers `output`.
 * @param p - The page.
 * @param toolName - The tool.
 * @param output - What it answers.
 */
async function answerWith(p: Page, toolName: string, output: (sent: unknown) => object): Promise<void> {
  await p.route('**/chat/message', async (route) => {
    const chunks = [
      { type: 'data-heartbeat', transient: true, data: {} },
      { type: 'data-conversation-titled', data: { title: 'size cap' } },
      { type: 'start', messageId: 'm-reply' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'call-1', toolName, input: {} },
      { type: 'tool-output-available', toolCallId: 'call-1', output: output(route.request().postDataJSON()) },
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''),
    });
  });
}

/**
 * Ask in chat and wait for a card.
 * @param p - The page.
 * @param card - The card's test id.
 * @returns The card.
 */
async function askForCard(p: Page, card: 'proposal-card' | 'document-proposal-card'): Promise<Locator> {
  await startNewConversation(p);
  const composer = p.getByTestId('chat-composer-box');
  await composer.fill('Put this in the Space.');
  await composer.press('Enter');
  const found = p.getByTestId(card).last();
  await expect(found).toBeVisible({ timeout: 20_000 });
  return found;
}

test('S-11 a canvas proposal pressed on a full Space is refused with a toast and places nothing', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-proposal-full');
  let peer: Peer | undefined;
  try {
    const f = `size-f-${crypto.randomUUID().slice(0, 8)}`;
    await seedNodes(page, s, [{ id: f, type: 'image', x: 100, y: 520 }]);
    peer = await openPeer(browser, baseURL, s.spaceId);
    await expect(nodeOf(peer.page, f)).toBeVisible({ timeout: 20_000 });
    await answerWith(page, 'propose_canvas_action', () => PROPOSAL);
    const card = await askForCard(page, 'proposal-card');

    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine + 16 * KiB, { node: f });
    await expectPhase(page, s.name, 'full');
    const ids = await nodeIds(page, s);
    await card.getByTestId('proposal-use').click();
    await expect(toastSaying(page, SIZE.proposalFull).first()).toBeVisible();
    await page.waitForTimeout(3_000);
    expect(await nodeIds(page, s)).toEqual(ids);
    expect(await nodeIds(peer.page, s)).toEqual(ids);
    await expect(card).not.toContainText(SIZE.proposalFull);
  } finally {
    await peer?.context.close();
    await deleteSpace(page, s.spaceId);
  }
});

test('S-12 a canvas proposal that does not fit says how much room is left', async ({ page }) => {
  const s = await openCanvasSpace(page, 'size-proposal-room');
  try {
    const f = `size-f-${crypto.randomUUID().slice(0, 8)}`;
    await seedNodes(page, s, [{ id: f, type: 'image', x: 100, y: 520 }]);
    await answerWith(page, 'propose_canvas_action', () => PROPOSAL);
    const card = await askForCard(page, 'proposal-card');
    const writeAt = await liveModuleUrl(page, SPACE_WRITE);
    const e = await page.evaluate(async ([url, node]) => {
      const write = (await import(/* @vite-ignore */ url)) as typeof SpaceWriteModule;
      return write.estimateNodeBytes(node);
    }, [writeAt, PROPOSAL.nodes[0]] as const);

    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine - Math.floor(e / 2), { node: f });
    expect((await readSize(page, s.name)).phase).toBe('warning');
    const ids = await nodeIds(page, s);
    const room = await availableRoom(page, s.name);
    expect(room).not.toBeNull();
    const told = copy(SIZE.proposalNoRoom, { room: formatBytes(room ?? 0) });
    await card.getByTestId('proposal-use').click();
    await expect(toastSaying(page, told).first()).toBeVisible();
    await page.waitForTimeout(2_000);
    expect(await nodeIds(page, s)).toEqual(ids);
    await expect(card).not.toContainText(told);
  } finally {
    await deleteSpace(page, s.spaceId);
  }
});

test('S-13 a document proposal pressed on a full Space is refused with a toast', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'document', `size-doc-proposal-${Date.now()}`);
  const name = documentSpaceDocName(projectId, spaceId);
  try {
    await page.locator(DOCUMENT_EDITOR).click();
    await page.keyboard.type('Scene two opens.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('He pushes the door open and sees her bags packed.');
    const chip = page.getByTestId('chat-composer-space');
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await answerWith(page, 'propose_document_edit', (sent) => {
      const space = (sent as { current_space?: { id: string; blocks?: Array<{ id: string; text: string }> } }).current_space;
      const block = space?.blocks?.[1];
      return {
        placed: true,
        proposalId: crypto.randomUUID(),
        spaceId: space?.id ?? '',
        spaceName: 'Doc',
        blockId: block?.id ?? '',
        title: 'Second paragraph',
        heading: '',
        original: block?.text ?? '',
        blockType: 'paragraph',
        lossy: false,
        kind: 'rewrite',
        body: 'He opens the door. Her bags are packed.',
      };
    });
    const card = await askForCard(page, 'document-proposal-card');

    const lines = await readLines(page, name);
    await fillTo(page, name, lines.fullLine + 16 * KiB, 'smoke-fill');
    await expectPhase(page, name, 'full');
    const body = await paragraphs(page);
    const vector = await stateVector(page, name);
    await card.getByRole('button').last().click();
    await expect(toastSaying(page, SIZE.proposalFull).first()).toBeVisible();
    await page.waitForTimeout(2_000);
    expect(await paragraphs(page)).toEqual(body);
    expect(await stateVector(page, name)).toBe(vector);
    await expect(card).not.toContainText(SIZE.proposalFull);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

/** A 32 KiB plain-text file, the same bytes on every run. */
const TEXT_FILE = Buffer.from('Size cap text file line.\n'.repeat(2000)).subarray(0, 32 * KiB);

test('S-14 a text file whose words do not fit leaves its node with the upload mark saying so', async ({ page }) => {
  const s = await openCanvasSpace(page, 'size-text-file');
  try {
    const f = `size-f-${crypto.randomUUID().slice(0, 8)}`;
    await seedNodes(page, s, [{ id: f, type: 'image', x: 100, y: 520 }]);
    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine - 8 * KiB, { node: f });
    expect((await readSize(page, s.name)).phase).toBe('warning');

    // A text file is read in the browser and takes no upload ticket, so
    // `roomForUploads` has nothing to wait for.
    const before = await nodeIds(page, s);
    const room = (await availableRoom(page, s.name)) ?? 0;
    const shown = (await toastLog(page)).length;
    await dropFile(page, 'size-cap.txt', 'text/plain', TEXT_FILE);
    await expect.poll(async () => (await nodeIds(page, s)).length, { timeout: 15_000 }).toBe(before.length + 1);
    const made = (await nodeIds(page, s)).find((id) => !before.includes(id)) ?? '';
    const mark = nodeOf(page, made).getByTestId('node-upload-error').first();
    await expect(mark).toBeVisible({ timeout: 15_000 });
    // The room at the moment of the write is what was there less the new
    // node's own estimate, so the figure may be a little under `room`.
    const [head, tail] = SIZE.textNoRoom.split('{room}') as [string, string];
    const said = (await mark.textContent()) ?? '';
    expect(said.startsWith(head) && said.endsWith(tail)).toBe(true);
    const figures = new Set<string>();
    for (let bytes = Math.max(0, room - 4 * KiB); bytes <= room; bytes += 1) figures.add(formatBytes(bytes));
    expect([...figures]).toContain(said.slice(head.length, said.length - tail.length));
    expect(await words(page, s, made)).toBe('');
    expect((await toastLog(page)).slice(shown)).toEqual([]);

    await fillTo(page, s.name, lines.fullLine + 16 * KiB, { node: f });
    await expectPhase(page, s.name, 'full');
    const ids = await nodeIds(page, s);
    await dropFile(page, 'size-cap.txt', 'text/plain', TEXT_FILE);
    await expect(toastSaying(page, SIZE.addBlocked).first()).toBeVisible();
    await page.waitForTimeout(2_000);
    expect(await nodeIds(page, s)).toEqual(ids);
  } finally {
    await deleteSpace(page, s.spaceId);
  }
});

test('S-15 with the overwrite reserve used up, a new start frame is refused with only a toast and the input keeps it @needs-storage @needs-ingest', async ({ page }) => {
  await openSmokeProject(page);
  const projectId = smokeProjectId();
  const spaceId = await createSpace(page, 'timeline', `size-timeline-start-${Date.now()}`);
  const name = timelineSpaceDocName(projectId, spaceId);
  try {
    const uploaded = await uploadTimelineVideo(page, projectId);
    const lines = await readLines(page, name);
    await fillTo(page, name, lines.fullLine + 16 * KiB, 'smoke-fill');
    const past = await pushPastLimit(page, name, lines.ceiling - lines.reserve / 2, 'smoke-fill');
    expect(past.overwriteRoom).toBe(0);

    const outlet = visibleSpace(page);
    await selectTimelineClip(page, uploaded.clipId);
    await outlet.getByTestId('timeline-edit-start').click();
    const vector = await stateVector(page, name);
    await outlet.getByTestId('timeline-start-frame').fill('7');
    await outlet.getByTestId('timeline-apply-start').click();
    await expect(toastSaying(page, SIZE.timelineFull).first()).toBeVisible();
    await expect(outlet.getByTestId('timeline-start-frame')).toHaveValue('7');
    await expect(outlet.getByText(EN.timeline.errors.invalid_range)).toHaveCount(0);
    expect(await stateVector(page, name)).toBe(vector);
    await expectTimelineStart(page, uploaded.clipId, 0, uploaded.durationFrames);
  } finally {
    await deleteSpace(page, spaceId);
  }
});

/**
 * Move the pointer onto one template goal's row in steps, which opens its submenu.
 * @param p - The page.
 * @param goal - The goal.
 */
async function pointAtGoal(p: Page, goal: string): Promise<void> {
  const box = await p.getByTestId(`generate-template-goal-${goal}`).boundingBox();
  if (!box) throw new Error(`the ${goal} row is not on screen`);
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
}

/**
 * Pick the storyboard template in the open image panel, the way
 * `generation-templates.spec.ts` does.
 * @param p - The page.
 */
async function pickStoryboard(p: Page): Promise<void> {
  await expect(p.getByTestId('generate-template-storyboard-grid-25')).toHaveCount(0);
  await expect(p.getByTestId('generate-template-goal-character')).toHaveCount(0);
  await p.getByTestId('generate-template-trigger').click();
  await pointAtGoal(p, 'character');
  await expect(p.getByTestId('generate-template-costume-sheet')).toBeVisible();
  await pointAtGoal(p, 'comics-storyboards');
  await p.getByTestId('generate-template-storyboard-grid-25').click();
}

test('S-16 picking a template on a full Space is refused with a toast and places nothing', async ({ page }) => {
  const s = await openCanvasSpace(page, 'size-template');
  try {
    const run = crypto.randomUUID().slice(0, 8);
    const f = `size-f-${run}`;
    const anchor = `size-anchor-${run}`;
    await seedNodes(page, s, [
      { id: f, type: 'image', x: 100, y: 520 },
      { id: anchor, type: 'image', x: 100, y: 100 },
    ]);
    await clickNode(page, anchor, 'right');
    await page.getByTestId('node-menu-generate').click();
    await expect(page.getByTestId('generate-template-trigger')).toBeVisible({ timeout: 15_000 });

    const lines = await readLines(page, s.name);
    await fillTo(page, s.name, lines.fullLine + 16 * KiB, { node: f });
    await expectPhase(page, s.name, 'full');
    const ids = await nodeIds(page, s);
    const mode = await page.getByTestId('generate-mode-trigger').textContent();
    await pickStoryboard(page);
    await expect(toastSaying(page, SIZE.addBlocked).first()).toBeVisible();
    await page.waitForTimeout(2_000);
    expect(await nodeIds(page, s)).toEqual(ids);
    await expect(page.getByTestId('generate-mode-trigger')).toHaveText(mode ?? '');
  } finally {
    await deleteSpace(page, s.spaceId);
  }
});
