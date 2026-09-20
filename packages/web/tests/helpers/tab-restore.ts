// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A project opened by a browser that has not been here, and the readings taken
 * off what a visit leaves behind (#2165).
 *
 * Every case starts from cleared storage and builds the strip it asks about.
 * The cases used to run in order on one page, each reading the strip the one
 * before it left — eight of the ten did, and the two that did not still needed
 * the first to have cleared the record.
 *
 * A spec importing this evaluates it in its own scope, so the hooks below
 * remove that file's Spaces and neither file can reach the other's.
 */
import { expect, test, type Page } from 'playwright/test';

import { CANVAS_SPACE, liveModuleUrl } from './live-module';
import { openSmokeProject } from './project';
import { createSpace, deleteSpace } from './space';

/** Wide enough for a strip of several tabs and a minimap beside the canvas. */
export const VIEWPORT = { width: 1400, height: 900 };

test.use({ viewport: VIEWPORT });

/** The Spaces this case made, removed when it ends. */
const mine: string[] = [];

test.afterEach(async ({ page }) => {
  while (mine.length > 0) await deleteSpace(page, mine.pop() as string);
});

/**
 * The Space ids on the strip, left to right.
 * @param p - The page to read.
 * @returns Those ids in the order they are painted.
 */
export async function stripIds(p: Page): Promise<string[]> {
  return p.evaluate(() =>
    // `role="tab"` is what separates the tab buttons from the strip itself
    // and from each tab's inner name element, which share the prefix.
    [...document.querySelectorAll('[role="tab"][data-testid^="space-tab-"]')]
      .map((el) => (el.getAttribute('data-testid') ?? '').replace('space-tab-', '')),
  );
}

/**
 * Which tab is the active one.
 * @param p - The page to read.
 * @returns The Space id, or null when the strip is empty.
 */
export async function activeId(p: Page): Promise<string | null> {
  return p.evaluate(() => {
    const el = document.querySelector(
      '[role="tab"][data-testid^="space-tab-"][aria-selected="true"]',
    );
    return el?.getAttribute('data-testid')?.replace('space-tab-', '') ?? null;
  });
}

/**
 * The canvas camera as the library holds it.
 * @param p - The page to read.
 * @returns The offset and the zoom.
 */
export async function camera(p: Page): Promise<{ x: number; y: number; zoom: number }> {
  return p.evaluate(() => {
    const el = document.querySelector('.react-flow__viewport') as HTMLElement | null;
    const m = new DOMMatrixReadOnly(el ? getComputedStyle(el).transform : '');
    return { x: Math.round(m.e), y: Math.round(m.f), zoom: Number(m.a.toFixed(3)) };
  });
}

/**
 * The camera the browser is holding for one Space.
 *
 * Found by the Space's own id rather than by position, so it does not assume
 * which account or project sits first in the record.
 * @param p - The page to read.
 * @param spaceId - The Space to look up.
 * @returns The stored camera, or null when there is none.
 */
export async function storedViewport(p: Page, spaceId: string): Promise<unknown> {
  return p.evaluate((id) => {
    const raw = window.localStorage.getItem('breatic.projectTabs');
    if (raw === null) return null;
    type Slot = { tabs?: Array<{ spaceId: string; viewport: unknown }> };
    for (const forUser of Object.values(JSON.parse(raw) as Record<string, unknown>)) {
      for (const slot of Object.values((forUser ?? {}) as Record<string, Slot>)) {
        const tab = (slot?.tabs ?? []).find((t) => t.spaceId === id);
        if (tab !== undefined) return tab.viewport;
      }
    }
    return null;
  }, spaceId);
}

/**
 * What the browser is holding, whole.
 * @param p - The page to read.
 * @returns The record, or null when nothing is stored.
 */
export async function stored(p: Page): Promise<unknown> {
  return p.evaluate(() => {
    const raw = window.localStorage.getItem('breatic.projectTabs');
    return raw === null ? null : JSON.parse(raw);
  });
}

/** A 1x1 PNG, enough for a node the framing has to fit. */
const DOT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Write one image node into the open Space's Yjs document.
 *
 * Through the module the page already loaded, the way the canvas specs do it:
 * the client writes canvas nodes directly, so there is no endpoint to call.
 * @param p - A page with the Space open.
 * @param projectId - The project the Space belongs to.
 * @param spaceId - The Space to write into.
 * @param at - Where to put the node, in canvas coordinates.
 * @throws {Error} When the canvas module is not among the loaded resources.
 */
export async function seedImageNode(
  p: Page,
  projectId: string,
  spaceId: string,
  at: { x: number; y: number },
): Promise<void> {
  const canvasAt = await liveModuleUrl(p, CANVAS_SPACE);
  await p.evaluate(
    async ([pid, sid, x, y, png, at]: [string, string, number, number, string, string]) => {
      const canvas = (await import(/* @vite-ignore */ at)) as {
        addNode: (p: string, s: string, node: unknown) => void;
      };
      canvas.addNode(pid, sid, {
        id: `restore-camera-${x}-${y}`,
        type: 'image',
        position: { x, y },
        data: {
          name: 'restore-camera',
          createdAt: Date.now(),
          createdBy: 'restore-camera',
          locked: false,
          state: 'idle',
          attachments: [],
          content: png,
        },
      });
    },
    [projectId, spaceId, at.x, at.y, DOT_PNG, canvasAt] as [string, string, number, number, string, string],
  );
}

/**
 * Open the account's first project from a browser that has not been here.
 *
 * Clearing the record before the page paints it is what makes each case's
 * strip the one it built: with a record in place the app opens on whatever an
 * earlier visit left.
 * @param p - The page to open it in.
 * @returns The project's address.
 */
export async function openFreshProject(p: Page): Promise<string> {
  await openSmokeProject(p);
  await p.evaluate(() => window.localStorage.removeItem('breatic.projectTabs'));
  await p.reload();
  await expect(p.locator('.react-flow__pane').first()).toBeVisible({ timeout: 20_000 });
  return p.url();
}

/**
 * Add canvas Spaces to the open project, removed when the case ends.
 * @param p - A page with the project open.
 * @param count - How many to make.
 * @returns Their ids, in the order they were made.
 */
export async function addSpaces(p: Page, count: number): Promise<string[]> {
  const made: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = await createSpace(p, 'canvas', `restore-${Date.now()}-${i}`);
    mine.push(id);
    made.push(id);
  }
  await expect.poll(() => stripIds(p), { timeout: 20_000 }).toHaveLength(count + 1);
  return made;
}

/**
 * The bare project id the record is keyed on.
 *
 * The route is `/project/{slug}-{uuid}` and the record drops the slug.
 * @param projectUrl - The address the project is open at.
 * @returns The uuid.
 */
export function projectIdOf(projectUrl: string): string {
  return (projectUrl.split('/project/')[1] ?? '').slice(-36);
}
