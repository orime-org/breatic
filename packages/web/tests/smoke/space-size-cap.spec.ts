// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A canvas Space near, at and back below its size cap (inner#1790, design
 * v2): the notice near the limit, the one paste that crosses it, adds and
 * moves refused before they are sent, deletes going through, and the Space
 * dropping back to `warning` once a delete takes it under the limit. Case ids
 * (S-xx.y) are the ones in section 2 of the inner#1790 v2 lint and smoke test
 * spec.
 *
 * Every target is derived from the Space's own `doc:size` push
 * (`tests/helpers/doc-size.ts`), so the suite runs under the default
 * `max_document_bytes` with no configuration, writing up to about ten
 * megabytes per case. States that need collab restarted with another
 * configuration (past the hard ceiling, a limit of 0) are walked by hand.
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/space-size-cap.spec.ts
 */
import { expect, type Browser, type BrowserContext, type Locator, type Page } from 'playwright/test';
import { canvasSpaceDocName, formatBytes } from '@breatic/shared';

import { test, stateFile } from '../helpers/slot';
import { openSmokeProject, smokeProjectId, smokeProjectUrl } from '../helpers/project';
import { createSpace, deleteSpace, visibleSpace } from '../helpers/space';
import { CANVAS_SPACE, YJS_MANAGER, liveModuleUrl } from '../helpers/live-module';
import { credentialsFor } from '../helpers/credentials';
import { dataOf } from '../helpers/api';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { FILL_STOP_BYTES, KiB, fillToBelowLimit, knownSize, readSize, type DocSizeState } from '../helpers/doc-size';

test.use({ viewport: { width: 1500, height: 900 } });

/** The notice and toast texts, as the demo's `COPY.en` words them (spec section 0). */
const COPY = {
  warningNotice: 'This Space is using {used}. Once it passes {limit}, no more content can be added.',
  fullNotice: 'This Space is full ({used} of {limit}). You can only delete content until it is back under the limit.',
  fullToast: 'This Space is full. Delete some content before editing further.',
  resyncToast: 'Your last change went over this Space\'s size limit and was not saved.',
};

/** Every size-related toast text, for "no size toast at all". */
const SIZE_TOASTS = [
  COPY.fullToast,
  COPY.resyncToast,
  'This Space is full. This deletion would also change other content, so it cannot run right now.',
  'This Space is over its limit. Delete a whole node or a whole passage.',
];

/** A 1x1 PNG, inline so the image nodes decode with no network. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * A notice text for a size.
 * @param template - The `COPY` text.
 * @param s - The size the page holds.
 * @returns The text as the page shows it.
 */
function noticeText(template: string, s: DocSizeState): string {
  const known = knownSize(s);
  return template.replace('{used}', formatBytes(known.bytes)).replace('{limit}', formatBytes(known.limit));
}

/**
 * Runs in every page before the app: a record of every toast that appears,
 * as `type: text`, kept even after the toast itself has gone.
 */
function prepareBrowser(): void {
  const seen: string[] = [];
  (window as unknown as { __sizeCapToasts: string[] }).__sizeCapToasts = seen;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const added of record.addedNodes) {
        if (!(added instanceof Element)) continue;
        const toasts = added.matches('[data-sonner-toast]') ? [added] : [...added.querySelectorAll('[data-sonner-toast]')];
        for (const toast of toasts) {
          requestAnimationFrame(() => seen.push(`${toast.getAttribute('data-type') ?? ''}: ${toast.textContent ?? ''}`));
        }
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
 * @returns Their `type: text`, in the order they appeared.
 */
async function toastLog(p: Page): Promise<string[]> {
  return p.evaluate(() => [...((window as unknown as { __sizeCapToasts?: string[] }).__sizeCapToasts ?? [])]);
}

/**
 * Wait for every toast on screen to go, and return the toast log's length.
 * A toast with the text of one still on screen only refreshes that one
 * (`lib/toast.ts` de-duplicates), so an action is shown to raise its own toast
 * only once the earlier one has gone.
 * @param p - The page.
 * @returns The log length to read the next action's toasts from.
 */
async function toastsCleared(p: Page): Promise<number> {
  await expect(p.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 10_000 });
  return (await toastLog(p)).length;
}

/**
 * The warning toasts on screen saying one thing (spec section 0 "toast").
 * @param p - The page.
 * @param text - What they say.
 * @returns The locator.
 */
function warningToast(p: Page, text: string): Locator {
  return p.locator('[data-sonner-toast][data-type="warning"]').filter({ hasText: text });
}

/**
 * The size-related toasts a page has shown since a point in its log.
 * @param p - The page.
 * @param since - The log length to read from.
 * @returns Their log entries.
 */
async function sizeToastsSince(p: Page, since = 0): Promise<string[]> {
  return (await toastLog(p)).slice(since).filter((entry) => SIZE_TOASTS.some((text) => entry.includes(text)));
}

/**
 * Wait for a document's phase in a page.
 * @param p - The page.
 * @param docName - The document.
 * @param phase - The phase to reach.
 * @param timeout - How long to wait.
 */
async function expectPhase(p: Page, docName: string, phase: DocSizeState['phase'], timeout = 15_000): Promise<void> {
  await expect.poll(async () => (await readSize(p, docName)).phase, { timeout }).toBe(phase);
}

/**
 * Wait for the size notice of the Space on screen to show a phase and the
 * text it should hold for the size that page holds right then.
 * @param p - The page.
 * @param docName - The Space's content document.
 * @param phase - The phase.
 * @param template - The notice text for that phase.
 */
async function expectNotice(p: Page, docName: string, phase: 'warning' | 'full', template: string): Promise<void> {
  const notice = visibleSpace(p).getByTestId('space-size-notice');
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toHaveAttribute('data-phase', phase, { timeout: 15_000 });
  await expect(notice).not.toHaveAttribute('data-over-ceiling');
  // The numbers move with every push, so the text is checked against the
  // size the page holds at the same moment.
  await expect
    .poll(async () => {
      const shown = (await notice.textContent()) ?? '';
      return shown === noticeText(template, await readSize(p, docName)) ? 'same' : shown;
    }, { timeout: 15_000 })
    .toBe('same');
}

/** A Space this file made, and the names to reach it by. */
interface SpaceRef {
  projectId: string;
  spaceId: string;
  /** Its content document. */
  name: string;
}

/** A second browser context with the Space open. */
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
 * A second browser context signed in as one of the slot's accounts, with
 * clipboard access and the toast record.
 * @param browser - The browser.
 * @param baseURL - The app's address.
 * @param account - Which slot account.
 * @returns The context.
 */
async function newContext(browser: Browser, baseURL: string | undefined, account: 'A' | 'B'): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, storageState: stateFile(account), viewport: { width: 1500, height: 900 } });
  await context.addInitScript(() => performance.setResourceTimingBufferSize(10_000));
  await context.addInitScript(prepareBrowser);
  return context;
}

/**
 * The same account in a second browser context, with the Space open.
 * @param browser - The browser.
 * @param baseURL - The app's address.
 * @param spaceId - The Space to open.
 * @returns The context and its page.
 */
async function openPeer(browser: Browser, baseURL: string | undefined, spaceId: string): Promise<Peer> {
  const context = await newContext(browser, baseURL, 'A');
  const page = await context.newPage();
  await page.goto(smokeProjectUrl());
  await openFromDrawer(page, spaceId);
  await expect(visibleSpace(page).locator('.react-flow')).toBeVisible({ timeout: 20_000 });
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
 * Run code against the canvas module the page already loaded.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @param body - A function body given `canvas`, `pid`, `sid` and `extra`.
 * @param extra - One value handed to the body.
 * @returns What the body returns.
 */
async function onCanvas<T>(p: Page, s: SpaceRef, body: string, extra: unknown = null): Promise<T> {
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  return p.evaluate(
    async ([cUrl, pid, sid, source, arg]: [string, string, string, string, unknown]) => {
      const canvas: unknown = await import(/* @vite-ignore */ cUrl);
      const run = new Function('canvas', 'pid', 'sid', 'extra', source) as (...args: unknown[]) => unknown;
      return run(canvas, pid, sid, arg);
    },
    [canvasAt, s.projectId, s.spaceId, body, extra] as [string, string, string, string, unknown],
  ) as Promise<T>;
}

/**
 * Whether the page's manager module holds the Space's document; read once
 * after import to prove the page's own copy of the modules was reached.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @returns True when the document is open there.
 */
async function docOpen(p: Page, s: SpaceRef): Promise<boolean> {
  const at = await liveModuleUrl(p, YJS_MANAGER);
  return p.evaluate(async ([url, name]) => {
    const manager = (await import(/* @vite-ignore */ url)) as { hasDoc(n: string): boolean };
    return manager.hasDoc(name);
  }, [at, s.name] as const);
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
 * Every text node's words, as the document holds them.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @returns Node id to plain text.
 */
async function allWords(p: Page, s: SpaceRef): Promise<Record<string, string>> {
  return onCanvas<Record<string, string>>(p, s, `const ids = canvas.readCanvasGraph(pid, sid).nodes.map((n) => n.id);
    return Object.fromEntries(canvas.readTextBodies(pid, sid, ids));`);
}

/**
 * A text node's words, as the document holds them.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @param id - The node.
 * @returns Its body as plain text.
 */
async function words(p: Page, s: SpaceRef, id: string): Promise<string> {
  return (await allWords(p, s))[id] ?? '';
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

/**
 * Paste plain text onto the canvas with the keyboard (spec 2.2 `pasteText`):
 * a click on blank canvas gives the canvas the keyboard, the text goes on the
 * clipboard, and `ControlOrMeta+V` makes a text node of it without a request.
 * @param p - A page with the Space open.
 * @param text - What to paste.
 */
async function pasteText(p: Page, text: string): Promise<void> {
  await clickBlank(p);
  await p.evaluate((words) => navigator.clipboard.writeText(words), text);
  await p.keyboard.press('ControlOrMeta+V');
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

/** The three nodes the canvas case works with. */
interface CanvasNodes {
  /** A text node holding `hello`. */
  t: string;
  /** The filler node: an image node whose data the fill goes into. */
  f: string;
  /** A small image node to move and delete. */
  n: string;
}

/**
 * Seed the text node T (`hello`), the filler F and the small node N through
 * the canvas's own `addNode`, while the Space is `normal`.
 * @param p - A page with the Space open.
 * @param s - The Space.
 * @returns Their ids.
 */
async function seedCanvas(p: Page, s: SpaceRef): Promise<CanvasNodes> {
  const run = crypto.randomUUID().slice(0, 8);
  const ids = { t: `size-t-${run}`, f: `size-f-${run}`, n: `size-n-${run}` };
  await onCanvas(p, s, `const base = { createdAt: Date.now(), createdBy: 'size-cap', locked: false, state: 'idle', attachments: [] };
    canvas.addNode(pid, sid, { id: extra.t, type: 'text', position: { x: 100, y: 100 }, data: { ...base, name: 'T', content: 'hello' } });
    canvas.addNode(pid, sid, { id: extra.f, type: 'image', position: { x: 100, y: 520 }, data: { ...base, name: 'F', content: extra.png } });
    canvas.addNode(pid, sid, { id: extra.n, type: 'image', position: { x: 900, y: 520 }, data: { ...base, name: 'N', content: extra.png } });`,
  { ...ids, png: PNG });
  for (const id of Object.values(ids)) await expect(nodeOf(p, id)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => words(p, s, ids.t)).toBe('hello');
  return ids;
}

/**
 * Wait for exactly one node to appear in a page's document and return its id.
 * @param p - The page.
 * @param s - The Space.
 * @param before - The node ids before the write.
 * @param timeout - How long to wait.
 * @returns The new node's id.
 * @throws {Error} When no node was added.
 */
async function addedNode(p: Page, s: SpaceRef, before: readonly string[], timeout = 10_000): Promise<string> {
  await expect.poll(async () => (await nodeIds(p, s)).length, { timeout }).toBe(before.length + 1);
  const added = (await nodeIds(p, s)).find((id) => !before.includes(id));
  if (added === undefined) throw new Error('no node was added');
  return added;
}

test('S-01 a canvas Space near, over and back under its limit: notice, one crossing paste, refused adds and moves, deletes that land', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-cap');
  let peer: Peer | undefined;
  try {
    let nodes: CanvasNodes = { t: '', f: '', n: '' };
    let pasted = '';

    await test.step('S-01.1 a fresh Space with T, F and N is normal with a limit and shows no notice', async () => {
      nodes = await seedCanvas(page, s);
      expect(await docOpen(page, s)).toBe(true);
      peer = await openPeer(browser, baseURL, s.spaceId);
      await expect(nodeOf(peer.page, nodes.t)).toBeVisible({ timeout: 20_000 });
      expect(await docOpen(peer.page, s)).toBe(true);
      await expect.poll(async () => {
        const size = await readSize(page, s.name);
        return size.phase === 'normal' && size.limit !== null && size.limit > 0;
      }, { timeout: 15_000, message: 'the Space never reported a normal size with a limit' }).toBe(true);
      await expect(visibleSpace(page).getByTestId('space-size-notice')).toHaveCount(0);
      await expect(visibleSpace(peer.page).getByTestId('space-size-notice')).toHaveCount(0);
    });
    const other = (): Peer => {
      if (peer === undefined) throw new Error('the peer never opened');
      return peer;
    };

    await test.step('S-01.2 the fill passes warning and stops just below the limit', async () => {
      const filled = await fillToBelowLimit(page, s.name, nodes.f);
      expect(filled.sawWarning).toBe(true);
      expect(filled.last.phase).toBe('warning');
      const last = knownSize(filled.last);
      expect(last.limit - last.bytes).toBeLessThan(FILL_STOP_BYTES);
    });

    await test.step('S-01.3 both pages show the warning notice with their pushed numbers, and no toast', async () => {
      await expectNotice(page, s.name, 'warning', COPY.warningNotice);
      await expectNotice(other().page, s.name, 'warning', COPY.warningNotice);
      expect((await toastLog(page)).filter((entry) => entry.startsWith('warning:'))).toEqual([]);
    });

    await test.step('S-01.4 one 64 KiB paste crosses the limit, lands on both pages and turns the Space full', async () => {
      const text = 'p'.repeat(64 * KiB);
      const before = await nodeIds(page, s);
      const shown = await toastsCleared(page);
      await pasteText(page, text);
      pasted = await addedNode(page, s, before);
      expect(await addedNode(other().page, s, before)).toBe(pasted);
      await expect.poll(async () => (await words(page, s, pasted)).slice(0, 32)).toBe(text.slice(0, 32));
      await expect.poll(async () => (await words(other().page, s, pasted)).slice(0, 32), { timeout: 10_000 }).toBe(text.slice(0, 32));
      await expectPhase(page, s.name, 'full');
      const size = knownSize(await readSize(page, s.name));
      expect(size.bytes, `the paste must land in full, not past the ceiling: ${JSON.stringify(size)}`).toBeGreaterThanOrEqual(size.limit);
      expect(size.bytes, `the paste must land in full, not past the ceiling: ${JSON.stringify(size)}`).toBeLessThan(size.ceiling);
      expect(size.overCeiling).toBe(false);
      await expectNotice(page, s.name, 'full', COPY.fullNotice);
      await expectNotice(other().page, s.name, 'full', COPY.fullNotice);
      expect((await toastLog(page)).slice(shown)).toEqual([]);
    });

    await test.step('S-01.5 a further paste is refused with the full toast and adds nothing anywhere', async () => {
      const ids = await nodeIds(page, s);
      await toastsCleared(page);
      await pasteText(page, 'more');
      await expect(warningToast(page, COPY.fullToast).first()).toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(3_000);
      expect(await nodeIds(page, s)).toEqual(ids);
      expect(await nodeIds(other().page, s)).toEqual(ids);
      expect((await toastLog(page)).filter((entry) => entry.includes(COPY.resyncToast))).toEqual([]);
    });

    await test.step('S-01.6 Duplicate is refused before any request is sent', async () => {
      const ids = await nodeIds(page, s);
      await toastsCleared(page);
      const requested = page
        .waitForRequest((request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/canvas/paste'), { timeout: 3_000 })
        .then(() => true, () => false);
      await clickNode(page, nodes.t, 'right');
      await page.getByTestId('node-menu-duplicate').click();
      await expect(page.locator('[role="menu"]')).toHaveCount(0);
      await expect(warningToast(page, COPY.fullToast).first()).toBeVisible({ timeout: 5_000 });
      expect(await requested, 'a POST /canvas/paste was sent for a refused duplicate').toBe(false);
      expect(await nodeIds(page, s)).toEqual(ids);
    });

    await test.step('S-01.7 typing into T is refused on screen and in the document, with the full toast', async () => {
      await toastsCleared(page);
      await typeInText(page, nodes.t, 'X');
      await expect(warningToast(page, COPY.fullToast).first()).toBeVisible({ timeout: 5_000 });
      await expect(nodeOf(page, nodes.t).getByTestId('text-node-body')).toHaveText('hello');
      expect(await words(page, s, nodes.t)).toBe('hello');
      await page.waitForTimeout(1_000);
      expect(await words(other().page, s, nodes.t)).toBe('hello');
      await expect(nodeOf(other().page, nodes.t).getByTestId('text-node-body')).toHaveText('hello');
    });

    await test.step('S-01.8 an arrow-key move of N is refused, in the document and on screen, with the full toast', async () => {
      const at = await docPosition(page, s, nodes.n);
      expect(at).not.toBeNull();
      await clickBlank(page);
      await clickNode(page, nodes.n);
      const drawn = await nodeOf(page, nodes.n).boundingBox();
      await toastsCleared(page);
      await page.keyboard.press('ArrowRight');
      await expect(warningToast(page, COPY.fullToast).first()).toBeVisible({ timeout: 5_000 });
      await page.waitForTimeout(1_000);
      expect(await docPosition(page, s, nodes.n)).toEqual(at);
      expect(await docPosition(other().page, s, nodes.n)).toEqual(at);
      const after = await nodeOf(page, nodes.n).boundingBox();
      expect(Math.abs((after?.x ?? 0) - (drawn?.x ?? 0))).toBeLessThan(1);
      expect(Math.abs((after?.y ?? 0) - (drawn?.y ?? 0))).toBeLessThan(1);
    });

    await test.step('S-01.9 deleting N goes through on both pages with no toast, and the Space stays full', async () => {
      await clickNode(page, nodes.n);
      const shown = await toastsCleared(page);
      await page.keyboard.press('Delete');
      await expect.poll(async () => (await nodeIds(page, s)).includes(nodes.n), { timeout: 10_000 }).toBe(false);
      await expect.poll(async () => (await nodeIds(other().page, s)).includes(nodes.n), { timeout: 10_000 }).toBe(false);
      await expect(nodeOf(page, nodes.n)).toHaveCount(0);
      expect((await toastLog(page)).slice(shown)).toEqual([]);
      expect((await readSize(page, s.name)).phase).toBe('full');
    });

    await test.step('S-01.10 deleting P takes the Space back to warning on both pages', async () => {
      await clickBlank(page);
      await clickNode(page, pasted);
      await page.keyboard.press('Delete');
      await expect.poll(async () => (await nodeIds(page, s)).includes(pasted), { timeout: 10_000 }).toBe(false);
      await expect.poll(async () => (await nodeIds(other().page, s)).includes(pasted), { timeout: 10_000 }).toBe(false);
      await expectPhase(page, s.name, 'warning');
      await expectNotice(page, s.name, 'warning', COPY.warningNotice);
      await expectNotice(other().page, s.name, 'warning', COPY.warningNotice);
    });

    await test.step('S-01.11 back under the limit, typing and pasting work again with no toast', async () => {
      const shown = await toastsCleared(page);
      await typeInText(page, nodes.t, '!');
      await expect.poll(() => words(page, s, nodes.t)).toBe('hello!');
      await expect.poll(() => words(other().page, s, nodes.t), { timeout: 10_000 }).toBe('hello!');
      const before = await nodeIds(page, s);
      await pasteText(page, 'again');
      const added = await addedNode(page, s, before);
      await expect.poll(() => words(page, s, added)).toBe('again');
      await expect.poll(() => nodeIds(other().page, s), { timeout: 10_000 }).toEqual(await nodeIds(page, s));
      expect((await toastLog(page)).slice(shown)).toEqual([]);
      // S-01.13 for this page up to here: the reload below empties its log.
      expect((await toastLog(page)).filter((entry) => entry.includes(COPY.resyncToast))).toEqual([]);
    });

    await test.step('S-01.12 after a reload the page holds exactly what the server holds', async () => {
      await page.reload();
      await openFromDrawer(page, s.spaceId);
      await expect(nodeOf(page, nodes.t)).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => nodeIds(page, s), { timeout: 15_000 }).toEqual(await nodeIds(other().page, s));
      await expect.poll(() => words(page, s, nodes.t), { timeout: 15_000 }).toBe('hello!');
      const texts = Object.values(await allWords(page, s));
      expect(texts.filter((text) => text.includes('X') || text === 'more')).toEqual([]);
      expect(await allWords(page, s)).toEqual(await allWords(other().page, s));
    });

    await test.step('S-01.13 no write was refused by the server: no resync toast on either page', async () => {
      // The reload in S-01.12 emptied this page's log, so the check at the end
      // of S-01.11 and the peer's whole log carry the run.
      expect((await toastLog(page)).filter((entry) => entry.includes(COPY.resyncToast))).toEqual([]);
      expect((await toastLog(other().page)).filter((entry) => entry.includes(COPY.resyncToast))).toEqual([]);
    });
  } finally {
    await peer?.context.close();
    await deleteSpace(page, s.spaceId);
  }
});

test('S-02 a viewer of a Space near its limit sees no size notice and no size toast', async ({ page, browser, baseURL }) => {
  const s = await openCanvasSpace(page, 'size-viewer');
  let viewer: BrowserContext | undefined;
  let viewerId: string | undefined;
  try {
    await test.step('S-02.1 the owner fills to warning; a viewer opening the Space sees neither notice nor toast', async () => {
      const nodes = await seedCanvas(page, s);
      await expect.poll(async () => (await readSize(page, s.name)).limit ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
      await fillToBelowLimit(page, s.name, nodes.f);
      await expectPhase(page, s.name, 'warning');
      await expect(visibleSpace(page).getByTestId('space-size-notice')).toHaveAttribute('data-phase', 'warning', { timeout: 15_000 });

      viewer = await newContext(browser, baseURL, 'B');
      viewerId = (await dataOf<{ id: string }>(await viewer.request.get('/api/v1/auth/me'), 'read the viewer identity')).id;
      const seen = await inviteMember(page, viewer, s.projectId, credentialsFor('B').email, 'viewer');
      await seen.goto(smokeProjectUrl());
      await openFromDrawer(seen, s.spaceId);
      await expect(nodeOf(seen, nodes.f)).toBeVisible({ timeout: 30_000 });
      // Long enough for the push that put the owner's notice up to reach the
      // viewer too.
      await seen.waitForTimeout(5_000);
      await expect(visibleSpace(seen).getByTestId('space-size-notice')).toHaveCount(0);
      expect(await sizeToastsSince(seen)).toEqual([]);
      // The owner still sees it at the same moment, so the empty viewer is not
      // a Space that simply has nothing to say.
      await expect(visibleSpace(page).getByTestId('space-size-notice')).toHaveAttribute('data-phase', 'warning');
    });
  } finally {
    await viewer?.close();
    if (viewerId !== undefined) await cleanMembership(page, s.projectId, viewerId);
    await deleteSpace(page, s.spaceId);
  }
});
