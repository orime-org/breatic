// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Following another project member (#920), end to end in two browsers.
 *
 * A owns a fresh Project with a canvas and a document Space; B is invited as an
 * editor and follows A from the member list. A switches to a Space B never
 * opened, pans the canvas, scrolls and edits the document; B's tab and view go
 * along. B leaves by moving its own view, by the bar's Stop, and when A goes
 * offline; while B follows A, A cannot follow B. Scroll anchoring and the
 * end-of-body clamp only happen in a real browser, so the cases that must not
 * end following live here.
 *
 *   pnpm --filter @breatic/web test:smoke member-follow
 */
import { expect, type BrowserContext, type Locator, type Page } from 'playwright/test';

import { dataOf } from '../helpers/api';
import { credentialsFor } from '../helpers/credentials';
import { archiveProjects, MADE_BY_SMOKE } from '../helpers/project';
import { cleanMembership, inviteMember } from '../helpers/project-members';
import { stateFile, test } from '../helpers/slot';
import { createSpace, deleteSpace, DOCUMENT_EDITOR, VISIBLE_SPACE } from '../helpers/space';

interface Project {
  id: string;
  slug: string;
}

/**
 * The slot account's personal Studio.
 * @param page - A signed-in page.
 * @returns The Studio id.
 * @throws {Error} When the account has no personal Studio.
 */
async function personalStudioId(page: Page): Promise<string> {
  const studios = await dataOf<Array<{ id: string; type: string }>>(await page.request.get('/api/v1/studios'), 'list studios');
  const studio = studios.find((s) => s.type === 'personal');
  if (!studio) throw new Error('The smoke account has no personal Studio');
  return studio.id;
}

/**
 * Open the member list and press View on the only other member online.
 * @param page - B's page.
 */
async function followTheOther(page: Page): Promise<void> {
  await page.getByTestId('members-trigger').click();
  const view = page.locator('[data-testid^="members-follow-"]');
  await expect(view).toHaveCount(1, { timeout: 30_000 });
  await view.click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('follow-bar')).toBeVisible();
}

/**
 * The tab of one Space, selected or not.
 * @param page - A page in the Project.
 * @param spaceId - The Space.
 * @returns Its tab.
 */
function tab(page: Page, spaceId: string): Locator {
  return page.locator(`[data-space-tab="${spaceId}"]`);
}

/**
 * The centre of the visible canvas (below the follow bar when there is one), in flow coordinates.
 * @param page - A page showing a canvas.
 * @returns The centre.
 */
async function canvasCentre(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate((outlet) => {
    const pane = document.querySelector(`${outlet} .react-flow`) as HTMLElement;
    const viewport = document.querySelector(`${outlet} .react-flow__viewport`) as HTMLElement;
    const m = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    const rect = pane.getBoundingClientRect();
    // The follow bar lies over the top of the follower's canvas; the centre is that of what shows below it.
    const bar = document.querySelector('[data-testid="follow-bar"]')?.getBoundingClientRect();
    const covered = bar ? Math.max(0, Math.min(rect.height, bar.bottom - rect.top)) : 0;
    return { x: (rect.width / 2 - m.e) / m.a, y: (covered + (rect.height - covered) / 2 - m.f) / m.a };
  }, VISIBLE_SPACE);
}

/**
 * The document body's scroller and the block whose own line is at its top.
 * @param page - A page showing a document.
 * @returns The scroll offset and the top block id.
 */
async function documentView(page: Page): Promise<{ scrollTop: number; top: string | null }> {
  return page.evaluate((outlet) => {
    const body = document.querySelector(`${outlet} .doc-body-editor`) as HTMLElement;
    const scroller = body.closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    const edge = scroller.getBoundingClientRect().top;
    let top: string | null = null;
    for (const block of body.querySelectorAll<HTMLElement>('.bn-block-outer[data-id]')) {
      const line = block.querySelector(':scope > .bn-block > .bn-block-content');
      if (line && line.getBoundingClientRect().bottom > edge) { top = block.dataset.id ?? null; break; }
    }
    return { scrollTop: scroller.scrollTop, top };
  }, VISIBLE_SPACE);
}

/**
 * How far below the top of a page's document scroller one block's own line sits.
 * @param page - A page showing a document.
 * @param blockId - The block.
 * @returns The distance in pixels, or null when the block is not on the page.
 */
async function lineOffset(page: Page, blockId: string): Promise<number | null> {
  return page.evaluate(({ outlet, id }) => {
    const body = document.querySelector(`${outlet} .doc-body-editor`) as HTMLElement;
    const scroller = body.closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    const line = body.querySelector(`.bn-block-outer[data-id="${id}"] > .bn-block > .bn-block-content`);
    return line ? line.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
  }, { outlet: VISIBLE_SPACE, id: blockId });
}

/**
 * How far a page's document scroller is from its end.
 * @param page - A page showing a document.
 * @returns The remaining scroll distance in pixels.
 */
async function distanceToEnd(page: Page): Promise<number> {
  return page.evaluate((outlet) => {
    const scroller = document.querySelector(`${outlet} .doc-body-editor`)!.closest('[data-radix-scroll-area-viewport]') as HTMLElement;
    return scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  }, VISIBLE_SPACE);
}

/**
 * Where the follow lands the leader's top block: this far below the top of the body, which is the
 * editor's own landing (16) plus the follow bar (32) laid over the top of the body.
 */
const LANDING = 16 + 32;

/**
 * Scroll the document body of a page by a distance, the way the user does.
 * @param page - A page showing a document.
 * @param dy - Pixels.
 */
async function scrollDocument(page: Page, dy: number): Promise<void> {
  const body = page.locator(`${VISIBLE_SPACE} .doc-body-editor`);
  await body.hover();
  await page.mouse.wheel(0, dy);
}

test('a member follows another across Spaces, canvas camera and document scroll, and stops on their own move, Stop and offline', async ({ page, browser, baseURL }) => {
  test.setTimeout(5 * 60_000);
  const b: BrowserContext = await browser.newContext({ baseURL, storageState: stateFile('B') });
  let project: Project | null = null;
  let memberId: string | undefined;
  const made: string[] = [];
  let bPage: Page | null = null;
  try {
    const studioId = await personalStudioId(page);
    const slug = `${MADE_BY_SMOKE}-follow-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    project = await dataOf<Project>(await page.request.post('/api/v1/projects', {
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      data: { studioId, slug, name: 'Smoke run follow', spaceType: 'canvas' },
    }), 'create Project');
    memberId = (await dataOf<{ id: string }>(await b.request.get('/api/v1/auth/me'), 'B identity')).id;
    const url = `/project/${project.slug}-${project.id}`;
    await page.goto(url);
    const docId = await createSpace(page, 'document', `Follow doc ${crypto.randomUUID().slice(0, 8)}`);
    made.push(docId);
    await page.locator(DOCUMENT_EDITOR).click();
    for (let i = 1; i <= 60; i += 1) {
      await page.keyboard.insertText(`Paragraph ${i} of the followed document.`);
      await page.keyboard.press('Enter');
    }

    bPage = await inviteMember(page, b, project.id, credentialsFor('B').email, 'editor');
    await bPage.goto(url);
    await expect(bPage.getByTestId('members-trigger')).toBeVisible({ timeout: 30_000 });

    // B follows A: the bar and the outline appear and B lands on A's Space.
    await followTheOther(bPage);
    await expect(bPage.getByTestId('follow-outline')).toBeVisible();
    await expect(tab(bPage, docId)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });

    // A opens a canvas B never had open and does not move; B goes along and aligns.
    const canvasId = await createSpace(page, 'canvas', `Follow canvas ${crypto.randomUUID().slice(0, 8)}`);
    made.push(canvasId);
    await expect(tab(bPage, canvasId)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await expect.poll(async () => {
      const [mine, theirs] = await Promise.all([canvasCentre(bPage!), canvasCentre(page)]);
      return Math.hypot(mine.x - theirs.x, mine.y - theirs.y);
    }, { timeout: 15_000 }).toBeLessThan(2);

    // A pans; B's camera follows.
    await page.locator(`${VISIBLE_SPACE} .react-flow__pane`).hover();
    await page.mouse.wheel(600, 400);
    await expect.poll(async () => {
      const [mine, theirs] = await Promise.all([canvasCentre(bPage!), canvasCentre(page)]);
      return Math.hypot(mine.x - theirs.x, mine.y - theirs.y);
    }, { timeout: 15_000 }).toBeLessThan(2);
    await expect(bPage.getByTestId('follow-bar')).toBeVisible();

    // B pans its own canvas: following ends with a notice and the bar goes.
    await bPage.locator(`${VISIBLE_SPACE} .react-flow__pane`).hover();
    await bPage.mouse.wheel(0, 300);
    await expect(bPage.getByTestId('follow-bar')).toHaveCount(0);
    await expect(bPage.getByTestId('follow-outline')).toHaveCount(0);
    await expect(bPage.locator('[data-sonner-toast]').filter({ hasText: /view/i })).toBeVisible();

    // B follows again; A goes to the document and scrolls; B's top block follows.
    await followTheOther(bPage);
    await tab(page, docId).click();
    await expect(tab(bPage, docId)).toHaveAttribute('aria-selected', 'true', { timeout: 15_000 });
    await scrollDocument(page, 900);
    const leaderTop = (await documentView(page)).top!;
    await expect.poll(async () => lineOffset(bPage!, leaderTop), { timeout: 15_000 }).toBeCloseTo(LANDING, 0);
    expect((await documentView(bPage)).scrollTop).toBeGreaterThan(0);

    // A inserts a paragraph above both views (A's top block stays); B keeps following.
    const before = await documentView(page);
    // Through the editor, so A's caret and scroll stay where they are while the first paragraph grows by several lines.
    await page.evaluate((selector) => {
      const host = document.querySelector(selector) as (HTMLElement & { editor?: { commands: { insertContentAt: (at: number, text: string) => boolean } } }) | null;
      if (!host?.editor) throw new Error('no TipTap editor on the document body');
      host.editor.commands.insertContentAt(3, 'Inserted above the followed view. '.repeat(30));
    }, DOCUMENT_EDITOR);
    await expect.poll(async () => (await documentView(page)).top, { timeout: 5_000 }).toBe(before.top);
    await bPage.waitForTimeout(1_000);
    await expect(bPage.getByTestId('follow-bar')).toBeVisible();

    // A scrolls to the end and deletes the last paragraphs, so B's body clamps; B keeps following.
    await scrollDocument(page, 20_000);
    // B lands A's top block LANDING below its top, so it rests a little short of the end; closer than the
    // eight paragraphs A then deletes, so the deletion clamps B's scroll.
    await expect.poll(async () => distanceToEnd(bPage!), { timeout: 15_000 }).toBeLessThan(80);
    await page.locator(`${DOCUMENT_EDITOR} .bn-block-content`).last().click();
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Shift+ArrowUp');
    }
    await page.keyboard.press('Backspace');
    await bPage.waitForTimeout(1_000);
    await expect(bPage.getByTestId('follow-bar')).toBeVisible();

    // B presses the bar's Stop.
    await bPage.getByTestId('follow-bar-stop').click();
    await expect(bPage.getByTestId('follow-bar')).toHaveCount(0);

    // B follows again. Following is one level deep: A cannot follow B while B follows A, and is told why.
    await followTheOther(bPage);
    await page.getByTestId('members-trigger').click();
    const viewB = page.locator('[data-testid^="members-follow-"]');
    await expect(viewB).toHaveAttribute('aria-disabled', 'true', { timeout: 15_000 });
    // Playwright waits forever on an aria-disabled control; a user's click reaches it.
    await viewB.click({ force: true });
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: /following you/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('follow-bar')).toHaveCount(0);
    await expect(bPage.getByTestId('follow-bar')).toBeVisible();

    // A closes the page; B is told A went offline and stops.
    await page.goto('about:blank');
    await expect(bPage.getByTestId('follow-bar')).toHaveCount(0, { timeout: 150_000 });
    await expect(bPage.locator('[data-sonner-toast]').filter({ hasText: /offline/i })).toBeVisible();
    await page.goto(url);
  } finally {
    try {
      await b.close();
    } finally {
      try {
        if (project && memberId) await cleanMembership(page, project.id, memberId);
      } finally {
        if (project) {
          try {
            await page.goto(`/project/${project.slug}-${project.id}`);
            for (const id of made) await deleteSpace(page, id);
          } finally {
            expect(await archiveProjects(page.request, [project.id]), 'Project cleanup').toEqual([]);
          }
        }
      }
    }
  }
});
