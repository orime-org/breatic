// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Copying a Project from its Studio card (inner#1706 acceptance 1, 2 and 8), against the running stack.
 *
 * What it pins: the copy's card shows "Copying" and opens nothing until collab has copied the source's documents; the
 * Studio page's poll then finds it copied and the card links to the copy, which opens on the source's Spaces; a Space
 * added in the copy does not appear in the source. Opened by link while it is still being copied, the Project page
 * shows only the notice and a way back to Studio, opens no collaboration connection and records no visit.
 *
 * Needs a running dev stack (`pnpm dev`) and the smoke accounts:
 *
 *   pnpm --filter @breatic/web test:smoke tests/smoke/project-copy.spec.ts
 */
import { expect, type Page } from 'playwright/test';
import { test } from '../helpers/slot';

import { archiveProjects, openSmokeProject, smokeProjectId } from '../helpers/project';
import { createSpace, deleteSpace } from '../helpers/space';

const COPYING_NOTICE = 'This Project is still being copied. Open it from Studio once it\'s done.';

/**
 * The slug of the studio a project lives in.
 * @param page - Any page on the signed-in session.
 * @param projectId - The project.
 * @returns The studio's slug.
 */
async function studioSlugOf(page: Page, projectId: string): Promise<string> {
  const project = await page.request.get(`/api/v1/projects/${projectId}`);
  expect(project.status()).toBe(200);
  const { studioId } = ((await project.json()) as { data: { studioId: string } }).data;
  const listed = await page.request.get('/api/v1/studios');
  const studios = ((await listed.json()) as { data: { id: string; slug: string }[] }).data;
  const studio = studios.find((s) => s.id === studioId);
  expect(studio, 'the project\'s studio is not listed for this account').toBeDefined();
  return studio!.slug;
}

/**
 * The names on the open Project's Space tabs, in order.
 * @param page - A page inside a project.
 * @returns The names.
 */
async function tabNames(page: Page): Promise<string[]> {
  const tabs = page.locator('[data-testid^="space-tab-name-"]');
  await expect(tabs.first()).toBeVisible({ timeout: 20_000 });
  return tabs.allInnerTexts();
}

/**
 * Open the source Project and wait until its visit is recorded, so it sorts first on its Studio page.
 * @param page - The page.
 * @returns The source's id.
 */
async function openSource(page: Page): Promise<string> {
  const projectId = smokeProjectId('A', 1);
  const opened = page.waitForResponse(
    (r) => r.url().includes(`/projects/${projectId}/opened`) && r.request().method() === 'POST',
  );
  await openSmokeProject(page, 'A', 1);
  expect((await opened).ok()).toBe(true);
  return projectId;
}

test('a copy shows Copying on its card until its content is in, then opens on the source\'s Spaces, and editing it leaves the source alone', async ({ page }) => {
  const sourceId = await openSource(page);
  const sourceTabs = await tabNames(page);
  const slug = await studioSlugOf(page, sourceId);
  const copies: string[] = [];

  // The copy is usually done within a couple of seconds, so the card's copying state is recorded as it appears.
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { copyingCards: Set<string> }).copyingCards = seen;
    new MutationObserver(() => {
      for (const card of document.querySelectorAll('[data-testid^="project-card-"]')) {
        if (card.textContent?.includes('Copying')) seen.add(card.getAttribute('data-testid')!.replace('project-card-', ''));
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });

  try {
    await page.goto(`/studio/${slug}`);
    const sourceCard = page.getByTestId(`project-card-${sourceId}`);
    await expect(sourceCard).toBeVisible({ timeout: 15_000 });
    await sourceCard.hover();
    await sourceCard.getByRole('button', { name: 'More actions' }).click();
    const duplicated = page.waitForResponse(
      (r) => r.url().includes(`/projects/${sourceId}/duplicate`) && r.request().method() === 'POST',
    );
    await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
    const answer = await duplicated;
    expect(answer.ok(), await answer.text()).toBe(true);
    const copy = ((await answer.json()) as { data: { id: string; slug: string; copying: boolean } }).data;
    copies.push(copy.id);
    expect(copy.copying).toBe(true);

    const copyCard = page.getByTestId(`project-card-${copy.id}`);
    await expect(copyCard).toBeVisible({ timeout: 15_000 });
    // The Studio page's poll finds the copy done and the card becomes a link.
    await expect(copyCard.getByRole('link')).toBeVisible({ timeout: 30_000 });
    await expect(copyCard.getByText('Copying')).toHaveCount(0);
    const seen = await page.evaluate(() => [...(window as unknown as { copyingCards: Set<string> }).copyingCards]);
    expect(seen).toContain(copy.id);

    await copyCard.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`${copy.id}$`));
    expect(await tabNames(page)).toEqual(sourceTabs);

    const added = await createSpace(page, 'canvas', `copy-only ${Date.now()}`);
    try {
      expect(await tabNames(page)).toHaveLength(sourceTabs.length + 1);
      await openSmokeProject(page, 'A', 1);
      expect(await tabNames(page)).toEqual(sourceTabs);
    } finally {
      await page.goto(`/project/${copy.slug}-${copy.id}`);
      await deleteSpace(page, added);
    }
  } finally {
    expect(await archiveProjects(page.request, copies)).toEqual([]);
  }
});

test('a copy opened by link while it is being copied shows only the notice, with no collaboration and no visit', async ({ page }) => {
  const sourceId = smokeProjectId('A', 1);
  const made = await page.request.post(`/api/v1/projects/${sourceId}/duplicate`);
  expect(made.ok(), await made.text()).toBe(true);
  const copy = ((await made.json()) as { data: { id: string; slug: string } }).data;
  try {
    // The copy is usually done within a couple of seconds; its detail is held at "being copied" to look at that state.
    await page.route(`**/api/v1/projects/${copy.id}`, async (route) => {
      const real = await route.fetch();
      const body = (await real.json()) as { data: Record<string, unknown> };
      await route.fulfill({ response: real, json: { ...body, data: { ...body.data, copying: true } } });
    });
    const sockets: string[] = [];
    page.on('websocket', (socket) => sockets.push(socket.url()));
    const visits: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes(`/projects/${copy.id}/opened`)) visits.push(r.url());
    });

    await page.goto(`/project/${copy.slug}-${copy.id}`);
    await expect(page.getByText(COPYING_NOTICE)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('top-bar')).toHaveCount(0);
    // Vite's development HMR socket is allowed; the page must not dial collab.
    expect(sockets.filter((url) => new URL(url).pathname.startsWith('/ws'))).toEqual([]);
    expect(visits).toEqual([]);

    await page.getByRole('link', { name: 'Back to Studio' }).click();
    await expect(page).toHaveURL(/\/studio/);
  } finally {
    expect(await archiveProjects(page.request, [copy.id])).toEqual([]);
  }
});
