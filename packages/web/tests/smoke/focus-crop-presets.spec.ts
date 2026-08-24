// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Focus crop preset row E2E (#1991) — the half no jsdom test can reach.
 *
 * The unit suite drives the row through synthetic events, where nothing does
 * hit-testing and a marquee never really covers the layer beneath it. Three
 * claims only a browser can settle:
 *
 *   - clicking a preset with no marquee draws one that really fills the
 *     material box, measured off live layout rather than inline style;
 *   - the handle shape tracks whether a ratio is locked, read through
 *     getComputedStyle so a class rename cannot pass silently;
 *   - the bar hugs its content in each locale, which is a layout fact:
 *     `max-content` has no meaning in jsdom.
 *
 * Needs a running dev stack (`pnpm dev`) and a smoke account:
 *
 *   SMOKE_EMAIL=... SMOKE_PASSWORD=... pnpm --filter @breatic/web test:smoke
 *
 * Skips itself when the credentials are absent, so an unconfigured checkout
 * still passes the suite. Beyond one Project to put a Space in, it reads
 * nothing from the account: the Space and both image nodes are built by the
 * run itself.
 */
import { test, expect, type Page } from 'playwright/test';

import { createSpace, deleteSpace } from './helpers/space';

const email = process.env.SMOKE_EMAIL;
const password = process.env.SMOKE_PASSWORD;

test.skip(!email || !password, 'SMOKE_EMAIL / SMOKE_PASSWORD not set');

// One sign-in for the whole file, on a page these cases share. Sign-in is rate
// limited to 5 a minute (`config/rate-limits.yaml`), a budget the suite spends
// across every spec — three more logins from here is enough to push a later
// spec past it. Same shape as selection-bubble-bar.spec.ts.
//
// The viewport is set on `browser.newPage` rather than through `test.use`,
// which configures the `page` fixture no case here takes. Desktop-web is the
// only supported platform, and below ~1280px the studio sidebar collapses to
// icons whose buttons lose their accessible names.
test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ viewport: { width: 1680, height: 950 } });
  await page.goto('/login');
  await page.locator('#login-email').fill(email as string);
  await page.locator('#login-password').fill(password as string);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/(studio|project)/, { timeout: 15_000 });
});

test.afterAll(async () => {
  await page?.close();
});

// Each case builds its own Space and drops it again when it is done. Three
// cases leaving three behind, every run, in the same Project, is what a tier's
// Space ceiling is there to stop (`config/membership.yaml`).
const createdSpaceIds: string[] = [];

test.afterEach(async () => {
  while (createdSpaceIds.length > 0) {
    await deleteSpace(page, createdSpaceIds.pop() as string);
  }
});

// Each case creates a Space and seeds two nodes before it can assert anything,
// which outlasts the suite-wide 30s budget on its own. The teardown adds a
// drawer round-trip on top of that.
test.setTimeout(90_000);

/**
 * A 320x240 solid PNG, inline so it decodes with no network.
 *
 * Both axes have to clear the crop's degenerate floor of 8 natural pixels:
 * under it every ratio preset renders disabled, and a click on one waits on
 * actionability until the test times out.
 */
const SOLID_4_3_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAACD0lEQVR42u3TQQkAAAgEwUtnCJMY3w7+hIFJsLCpHuCpSAAGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGAysAhgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBhYBTAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMHC3pCIzOUa0Hy8AAAAASUVORK5CYII=';

/**
 * Writes two image nodes straight into the Space's Yjs document, side by side,
 * each already holding a decodable picture.
 *
 * Every UI route to the same end state has to stay still long enough for
 * Playwright to call an element actionable, and the canvas ones do not: the
 * node menu, the node's context menu and the blank-image panel all live in
 * overlays that track the viewport transform. The document is the layer under
 * all of that, and what this spec measures — the crop marquee against the
 * capture layer — is unaffected by how the material got there.
 * @param page - The Playwright page.
 * @param projectId - The Project the Space belongs to.
 * @param spaceName - Name of the Canvas Space created for this run.
 * @returns The two node ids, left one first.
 */
async function seedTwoImageNodes(
  page: Page,
  projectId: string,
  spaceName: string,
): Promise<string[]> {
  const ids = await page.evaluate(
    async ([pid, name, png]: string[]) => {
      // Vite serves each module under a versioned URL; importing the bare path
      // would evaluate a SECOND copy whose caches are empty.
      const live = (re: RegExp): string =>
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .find((n) => re.test(n)) ?? '';
      const mgr = await import(/* @vite-ignore */ live(/data\/yjs\/manager\.ts/));
      const canvas = await import(
        /* @vite-ignore */ live(/data\/yjs\/canvas-space\.ts/)
      );
      const meta = mgr.getDoc(mgr.docName.projectMeta(pid));
      const entry = [...meta.getMap('spaces').entries()].find(
        ([, v]: [string, { get: (k: string) => unknown }]) =>
          v.get('name') === name,
      );
      const spaceId = entry?.[0] as string;
      const made: string[] = [];
      for (const [i, x] of [80, 520].entries()) {
        const id = `e2e-${Date.now()}-${i}`;
        canvas.addNode(pid, spaceId, {
          id,
          type: 'image',
          position: { x, y: 120 },
          data: {
            name: `e2e-source-${i}`,
            createdAt: Date.now(),
            createdBy: 'focus-crop-e2e',
            locked: false,
            state: 'idle',
            attachments: [],
            content: png,
          },
        });
        made.push(id);
      }
      return made;
    },
    [projectId, spaceName, SOLID_4_3_PNG],
  );

  await page.waitForFunction(
    (wanted: string[]) =>
      wanted.every((id) => {
        const img = document
          .querySelector(`[data-id="${id}"]`)
          ?.querySelector('[data-testid=image-node-img]');
        return img instanceof HTMLImageElement && img.naturalWidth > 0;
      }),
    ids,
    { timeout: 20_000 },
  );
  return ids;
}

/**
 * Builds a Canvas Space holding two image nodes on the shared signed-in page,
 * then starts a focus pick on one of them and enters the crop state.
 *
 * The Space and both nodes are made here because every other starting point is
 * someone else's leftovers: which Space a Project opens on is the first entry
 * of that account's persisted `openTabIds`, and the other smoke specs add
 * Spaces of their own to the same Project. A run that assumed a canvas with
 * pictures in it was reading whatever the previous run happened to leave.
 * @returns Nothing; the page is left in the crop state.
 */
async function openCropOverlay(): Promise<void> {
  // Reuse an existing Project: this spec is about the crop overlay, and
  // minting one per run burns the tier's projects-per-studio allowance. The
  // Space inside it is ours, so nothing about the Project's contents matters.
  await page.goto('/studio');
  const firstProject = page.locator('a[href^="/project/"]').first();
  await expect(firstProject).toBeVisible({ timeout: 15_000 });
  await firstProject.click();
  await page.waitForURL(/\/project\//, { timeout: 15_000 });
  const projectId = (/([0-9a-f-]{36})$/.exec(page.url()) ?? [])[1] as string;

  // A fresh Canvas Space, which opens active — so the run lands on a canvas
  // regardless of what the account's tab order says.
  const spaceName = `focus-crop-e2e-${Date.now()}`;
  createdSpaceIds.push(await createSpace(page, 'canvas', spaceName));
  await expect(page.locator('.react-flow')).toBeVisible({ timeout: 20_000 });

  // Two image nodes: the pick has to START from one node's generate panel, and
  // a node is never a crop source for its own panel.
  await seedTwoImageNodes(page, projectId, spaceName);

  // The pick has to START from some node's generate panel.
  const imageNode = page.locator('.react-flow__node:has([data-testid=image-node-img])');
  await expect(imageNode.first()).toBeVisible({ timeout: 20_000 });

  const hostNodeId =
    (await imageNode.first().getAttribute('data-id')) ?? '';
  await imageNode.first().locator('[data-testid=image-node]').click({ button: 'right' });
  await page.getByRole('menuitem').first().click(); // 生成 / Generate
  await page.getByTestId('generate-tool-focus').click();

  // Both media kinds are crop sources, and the generate panel floats over the
  // canvas covering whichever nodes sit beneath it — so the target is chosen
  // by asking the browser what is actually on top at each candidate's centre.
  // Picking by index lands on a covered node, where the click waits on
  // actionability until the test times out. Audio carries the same testid as
  // video and is not croppable, so candidates are narrowed by videoWidth.
  // Polls rather than reads once: a node's <img>/<video> reports its intrinsic
  // size only after it decodes, and right after the panel opens they all still
  // read zero. Whichever source decodes first and is not covered gets tagged.
  await page.waitForFunction((hostId: string) => {
    const candidates: Element[] = [];
    for (const node of document.querySelectorAll('.react-flow__node')) {
      // The node whose panel started the pick is not a candidate.
      if (node.getAttribute('data-id') === hostId) continue;
      // An EMPTY image node carries `image-node` too, with placeholder text
      // where the picture would be; only a decoded <img> is a crop source.
      const img = node.querySelector('[data-testid=image-node-img]');
      if (img instanceof HTMLImageElement && img.naturalWidth > 0) candidates.push(img);
      // Audio shares this testid and is not croppable — videoWidth narrows it.
      const media = node.querySelector('[data-testid=media-element]');
      if (media instanceof HTMLVideoElement && media.videoWidth > 0) candidates.push(media);
    }
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (top !== null && el.contains(top)) {
        // Tag it so Playwright can address exactly this element.
        el.setAttribute('data-crop-target', 'yes');
        return true;
      }
    }
    return false;
  }, hostNodeId, { timeout: 20_000 });
  await page.locator('[data-crop-target=yes]').click();

  await expect(page.getByTestId('focus-crop-controls')).toBeVisible({ timeout: 10_000 });
}

test('clicking a preset with no marquee draws one, and Original fills the material', async () => {
  await openCropOverlay();

  // Nothing drawn yet.
  await expect(page.getByTestId('focus-crop-rect')).toHaveCount(0);

  await page.getByTestId('focus-ratio-original').click();

  const rect = page.getByTestId('focus-crop-rect');
  await expect(rect).toBeVisible();
  await expect(page.getByTestId('focus-ratio-original')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Original's ratio IS the material's, so both axes fill. Measured off live
  // layout: the marquee's box has to match the capture layer's, not merely
  // carry the right inline style.
  const fills = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="focus-crop-layer"]');
    const marquee = document.querySelector('[data-testid="focus-crop-rect"]');
    if (!layer || !marquee) return null;
    const l = layer.getBoundingClientRect();
    const m = marquee.getBoundingClientRect();
    return {
      dw: Math.abs(l.width - m.width),
      dh: Math.abs(l.height - m.height),
      dx: Math.abs(l.x - m.x),
      dy: Math.abs(l.y - m.y),
    };
  });
  expect(fills).not.toBeNull();
  // One pixel of slack for the border the marquee draws on itself.
  expect(fills!.dw).toBeLessThanOrEqual(2);
  expect(fills!.dh).toBeLessThanOrEqual(2);
  expect(fills!.dx).toBeLessThanOrEqual(2);
  expect(fills!.dy).toBeLessThanOrEqual(2);
});

test('handle shape says whether the ratio is locked', async () => {
  await openCropOverlay();

  await page.getByTestId('focus-ratio-1:1').click();
  await expect(page.getByTestId('focus-crop-rect')).toBeVisible();

  /**
   * The corner radius every handle currently renders with.
   * @returns One entry per handle, deduplicated.
   */
  const handleRadii = async (): Promise<string[]> =>
    page.evaluate(() => {
      const ids = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      const radii = ids.map((id) => {
        const el = document.querySelector(`[data-testid="focus-crop-handle-${id}"]`);
        return el ? getComputedStyle(el).borderRadius : 'missing';
      });
      return [...new Set(radii)];
    });

  // Locked: round, and all eight agree.
  const locked = await handleRadii();
  expect(locked).toHaveLength(1);
  expect(locked[0]).not.toBe('0px');

  // Unlight it: the marquee stays, the handles go square.
  await page.getByTestId('focus-ratio-1:1').click();
  await expect(page.getByTestId('focus-crop-rect')).toBeVisible();
  await expect(page.getByTestId('focus-ratio-1:1')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const free = await handleRadii();
  expect(free).toEqual(['0px']);
});

test('the controls bar hugs its content in every locale', async () => {
  await openCropOverlay();

  /**
   * Leftover width inside the bar, to the right of its last item.
   * @returns The gap in px, plus the row's height so wrapping is visible.
   */
  const measureBar = async (): Promise<{ gap: number; rowHeight: number }> =>
    page.evaluate(() => {
      const bar = document.querySelector('[data-testid="focus-crop-controls"]')!;
      const row = bar.querySelector('[data-testid^="focus-ratio-"]')!.parentElement!;
      const last = row.lastElementChild!;
      const b = bar.getBoundingClientRect();
      const cs = getComputedStyle(bar);
      const padRight = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
      return {
        gap: Math.round(b.right - padRight - last.getBoundingClientRect().right),
        rowHeight: Math.round(row.getBoundingClientRect().height),
      };
    });

  const first = await measureBar();
  expect(first.gap).toBeLessThanOrEqual(1);

  // Every locale, one at a time: the bar is allowed to be a different width in
  // each, and is not allowed to leave a gap or wrap in any of them.
  const singleRow = first.rowHeight;
  for (const label of ['English', '简体中文', '繁體中文', '日本語', '한국어']) {
    await page.locator('header button[aria-haspopup="dialog"]').nth(1).click();
    await page.getByRole('dialog').getByRole('button', { name: label }).click();
    await expect(page.getByTestId('focus-crop-controls')).toBeVisible();
    const m = await measureBar();
    expect(m.gap, `${label} leaves a gap`).toBeLessThanOrEqual(1);
    expect(m.rowHeight, `${label} wraps`).toBe(singleRow);
  }
});
